import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ga4ErrorMessage, ga4LandingPages, listGa4Properties } from '../../src/integrations/ga4.js';
import { buildGa4Report, type Ga4Report } from '../../src/commands/ga4.js';
import { RunStore } from '../../src/crawl/store.js';
import { main } from '../../src/cli.js';

const TOKEN = 'ya29.test-token';
let server: http.Server;
let cfg: string;
let ws: string;
let lastBody: Record<string, unknown> = {};

const row = (host: string, page: string, s: number, e: number, k: number) => ({ dimensionValues: [{ value: host }, { value: page }], metricValues: [{ value: String(s) }, { value: String(e) }, { value: String(k) }] });

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end(JSON.stringify({ error: { code: 401, status: 'UNAUTHENTICATED', message: 'Request had invalid authentication credentials.' } }));
    const u = new URL(req.url ?? '/', 'http://x');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (u.pathname === '/admin/accountSummaries') {
        if (!u.searchParams.get('pageToken'))
          return res.end(JSON.stringify({ accountSummaries: [{ displayName: 'Acme', propertySummaries: [{ property: 'properties/111', displayName: 'Acme web' }] }], nextPageToken: 'p2' }));
        return res.end(JSON.stringify({ accountSummaries: [{ displayName: 'Other', propertySummaries: [{ property: 'properties/222', displayName: 'Blog' }] }] }));
      }
      if (u.pathname === '/data/properties/999:runReport') return res.writeHead(403).end(JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'User does not have sufficient permissions for this property.' } }));
      if (u.pathname === '/data/properties/111:runReport') {
        lastBody = JSON.parse(body) as Record<string, unknown>;
        return res.end(JSON.stringify({ rows: [row('www.acme.example', '/', 120, 90, 4), row('acme.example', '/pricing', 40, 30, 6), row('www.acme.example', '/blog/a', 20, 10, 0), row('shop.other.example', '/', 99, 50, 1)], rowCount: 7 }));
      }
      res.writeHead(404).end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env['SEARVEX_GA4_DATA_API_BASE'] = `${base}/data`;
  process.env['SEARVEX_GA4_ADMIN_API_BASE'] = `${base}/admin`;
  cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-ga4-'));
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-ga4-ws-'));
  // An audit of acme.example: three indexable pages, issues on two of them (one only informational).
  new RunStore(ws, 'audit-1').writeJson('report.json', {
    mode: 'website',
    target: 'https://acme.example/',
    runId: 'audit-1',
    crawl: { startUrl: 'https://acme.example/' },
    inventory: { pages: ['https://acme.example/', 'https://acme.example/pricing', 'https://acme.example/about'].map((url) => ({ url, indexable: true })) },
    findings: [
      { ruleId: 'description.missing', severity: 'medium', evidence: [{ url: 'https://acme.example/pricing' }], affected: { count: 2, urls: ['https://acme.example/pricing', 'https://acme.example/about'] } },
      { ruleId: 'img.alt-missing', severity: 'low', evidence: [{ url: 'https://acme.example/' }] },
      { ruleId: 'geo.llms-txt-missing', severity: 'info', evidence: [{ url: 'https://acme.example/' }] },
    ],
  });
});
afterAll(() => {
  server.close();
  fs.rmSync(cfg, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
  for (const k of ['SEARVEX_GA4_DATA_API_BASE', 'SEARVEX_GA4_ADMIN_API_BASE', 'SEARVEX_GA4_TOKEN', 'SEARVEX_CONFIG_DIR']) delete process.env[k];
});

describe('F4: GA4 Data and Admin API', () => {
  it('lists readable properties across pages', async () => {
    expect(await listGa4Properties(TOKEN)).toEqual([
      { id: '111', name: 'Acme web', account: 'Acme' },
      { id: '222', name: 'Blog', account: 'Other' },
    ]);
  });

  it('asks for Organic Search landing pages by host and path, most sessions first', async () => {
    const r = await ga4LandingPages(TOKEN, '111', 28, 4);
    expect(lastBody).toMatchObject({
      dimensions: [{ name: 'hostName' }, { name: 'landingPage' }],
      metrics: [{ name: 'sessions' }, { name: 'engagedSessions' }, { name: 'keyEvents' }],
      dimensionFilter: { filter: { fieldName: 'sessionDefaultChannelGroup', stringFilter: { value: 'Organic Search' } } },
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: '4',
    });
    expect(r.rowCount).toBe(7);
    expect(r.rows[1]).toEqual({ host: 'acme.example', path: '/pricing', sessions: 40, engagedSessions: 30, keyEvents: 6 });
  });

  it('explains permission, disabled-API and token errors; rejects a non-numeric property', async () => {
    await expect(ga4LandingPages(TOKEN, '999', 28)).rejects.toThrow(/No access to this Google Analytics property/);
    await expect(ga4LandingPages('bad', '111', 28)).rejects.toThrow(/ga4 auth/);
    await expect(ga4LandingPages(TOKEN, 'G-ABC123', 28)).rejects.toThrow(/Not a GA4 property id/);
    expect(ga4ErrorMessage(403, { error: { status: 'PERMISSION_DENIED', message: 'Google Analytics Data API has not been used in project 1 before or it is disabled.' } })).toMatch(/Enable "Google Analytics Data API"/);
  });
});

describe('F4: report and audit join', () => {
  it('joins only the audit host (www twin included) and lists issues on pages with traffic', async () => {
    const { rows, rowCount, startDate, endDate } = await ga4LandingPages(TOKEN, '111', 28, 4);
    const audit = new RunStore(ws, 'audit-1').readJson<never>('report.json')!;
    const r = buildGa4Report(rows, { propertyId: '111', days: 28, startDate, endDate, rowCount }, { runId: 'audit-1', audit });
    expect(r.totals).toEqual({ sessions: 279, engagedSessions: 180, keyEvents: 11 });
    expect(r.audit).toEqual({
      runId: 'audit-1',
      target: 'https://acme.example/',
      host: 'acme.example',
      issuesOnTrafficPages: [
        { url: 'https://acme.example/', sessions: 120, keyEvents: 4, issues: ['img.alt-missing'] },
        { url: 'https://acme.example/pricing', sessions: 40, keyEvents: 6, issues: ['description.missing'] },
      ],
      indexableWithoutSessions: 1,
      indexablePages: 3,
    });
    expect(r.notes.join(' ')).toMatch(/top 4 of 7 landing pages/);
  });

  it('ga4 report writes JSON and Markdown; status without authorization exits 1', async () => {
    process.env['SEARVEX_CONFIG_DIR'] = cfg;
    const spies = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(process.stdout, 'write').mockImplementation(() => true)];
    try {
      expect(await main(['ga4', 'status'])).toBe(1);
      process.env['SEARVEX_GA4_TOKEN'] = TOKEN;
      expect(await main(['ga4', 'report', '111', '--audit', 'latest', '--out', ws, '--quiet'])).toBe(0);
      const run = RunStore.list(ws).find((id) => id.startsWith('ga4-'))!;
      const store = new RunStore(ws, run);
      expect(store.readJson<Ga4Report>('ga4-report.json')!.audit!.issuesOnTrafficPages).toHaveLength(2);
      expect(fs.readFileSync(store.file('ga4-report.md'), 'utf8')).toMatch(/Experimental: not yet verified[\s\S]*\| https:\/\/acme\.example\/pricing \| 40 \| 6 \| `description\.missing` \|/);
    } finally {
      for (const s of spies) s.mockRestore();
      delete process.env['SEARVEX_GA4_TOKEN'];
    }
  });
});
