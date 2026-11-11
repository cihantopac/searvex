import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auditWebsite, type AuditReport } from '../../src/analyze/audit.js';
import { DEFAULT_POLICY } from '../../src/net/ssrf.js';
import { EXIT, main, writeReports } from '../../src/cli.js';
import { writeContext } from '../../src/report/extras.js';
import { findingRef } from '../../src/report/remediation.js';
import { AFFECTED_URL_CAP, affectedSummary, loadKnowledge } from '../../src/rules/engine.js';
import { page, startServer, text, type Route, type TestServer } from '../helpers/server.js';

const N = 60;
let server: TestServer;
let ws: string;
let cfg: string;

beforeAll(async () => {
  const routes: Record<string, Route> = {};
  server = await startServer(routes);
  const urls = Array.from({ length: N }, (_, i) => `${server.url}/post/${i}`);
  routes['/robots.txt'] = { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nAllow: /\n' };
  routes['/sitemap.xml'] = { headers: { 'content-type': 'application/xml' }, body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>` };
  routes['/'] = { body: page({ title: 'Home page of the blog', head: '<meta name="description" content="A blog about many things that matter to readers.">', body: `<h1>Home</h1>${text(200)}` }) };
  // Every post lacks a meta description: 60 occurrences, evidence capped at 50.
  for (let i = 0; i < N; i++) routes[`/post/${i}`] = { body: page({ title: `Post number ${i} of the blog`, body: `<h1>Post ${i}</h1>${text(200)}` }) };
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-json-'));
  cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-json-cfg-'));
});

afterAll(async () => {
  await server.close();
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(cfg, { recursive: true, force: true });
});

const audit = async (o: { compact?: boolean } = {}) =>
  auditWebsite(server.url + '/', { workspace: ws, crawl: { policy: { ...DEFAULT_POLICY, allowPrivate: true }, delayMs: 0, concurrency: 8 }, probes: false, compact: o.compact });

describe('C3: per-finding affected URLs', () => {
  it('lists every affected URL while evidence stays capped at 50', async () => {
    const { report } = await audit();
    const f = report.findings.find((x) => x.ruleId === 'description.missing')!;
    expect(f.count).toBe(N);
    expect(f.evidence).toHaveLength(50);
    expect(f.affected?.count).toBe(N);
    expect(f.affected?.urls).toHaveLength(N);
    expect(f.affected?.urls).toEqual([...f.affected!.urls!].sort());
    expect(f.affected?.truncated).toBeUndefined();
    // Every evidence URL is in the list.
    for (const e of f.evidence) expect(f.affected!.urls).toContain(e.url);
  });

  it('a group finding (duplicate title) lists every page of the group', async () => {
    const routes: Record<string, Route> = {
      '/': { body: page({ title: 'Home page of the dupes site', body: `<h1>Home</h1>${text(200)}<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a>` }) },
      '/a': { body: page({ title: 'Same title on three pages', body: `<h1>A</h1>${text(200)}` }) },
      '/b': { body: page({ title: 'Same title on three pages', body: `<h1>B</h1>${text(210)}` }) },
      '/c': { body: page({ title: 'Same title on three pages', body: `<h1>C</h1>${text(220)}` }) },
    };
    const s = await startServer(routes);
    try {
      const { report } = await auditWebsite(s.url + '/', { workspace: ws, crawl: { policy: { ...DEFAULT_POLICY, allowPrivate: true }, delayMs: 0 }, probes: false });
      const f = report.findings.find((x) => x.ruleId === 'duplicate.title')!;
      expect(f.evidence).toHaveLength(1);
      expect(f.affected).toEqual({ count: 3, urls: [`${s.url}/a`, `${s.url}/b`, `${s.url}/c`] });
    } finally {
      await s.close();
    }
  });

  it('caps the list at 10,000 and counts the rest; never lists robots.txt or llms.txt', () => {
    const urls = Array.from({ length: AFFECTED_URL_CAP + 5 }, (_, i) => `https://e.com/p${i}`);
    const s = affectedSummary([...urls, 'https://e.com/robots.txt', 'https://e.com/llms.txt']);
    expect(s.count).toBe(AFFECTED_URL_CAP + 5);
    expect(s.urls).toHaveLength(AFFECTED_URL_CAP);
    expect(s.truncated).toBe(5);
  });

  it('--compact keeps only the count', async () => {
    const { report, store } = await audit({ compact: true });
    const f = report.findings.find((x) => x.ruleId === 'description.missing')!;
    expect(f.affected).toEqual({ count: N });
    expect(store.readJson<AuditReport>('report.json')!.findings.find((x) => x.ruleId === 'description.missing')!.affected).toEqual({ count: N });
  });

  it('the CLI accepts --compact', async () => {
    process.env['SEARVEX_CONFIG_DIR'] = cfg;
    const out: string[] = [];
    const spies = [vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(process.stdout, 'write').mockImplementation((c) => (out.push(String(c)), true))];
    try {
      expect(await main(['audit', server.url + '/', '--allow-private', '--delay', '0', '--concurrency', '8', '--out', fs.mkdtempSync(path.join(ws, 'c-')), '--json', '--compact'])).toBe(EXIT.ok);
    } finally {
      for (const s of spies) s.mockRestore();
      delete process.env['SEARVEX_CONFIG_DIR'];
    }
    const r = JSON.parse(out.join('')) as AuditReport;
    expect(r.findings.every((f) => f.affected && Object.keys(f.affected).join() === 'count')).toBe(true);
  });
});

describe('C2: report-complete JSON', () => {
  it('report.json carries finding ref + remediation, evidence refs and root-cause groups', async () => {
    const { store } = await audit();
    const r = store.readJson<AuditReport>('report.json')!;
    for (const f of r.findings) {
      expect(f.ref).toBe(f.ruleId);
      expect(['agent', 'manual']).toContain(f.remediation);
      for (const e of f.evidence) expect(e.ref).toBe(findingRef(f.ruleId, { ...e, ref: undefined }));
      expect(r.rootCauseGroups?.[f.ruleId]?.length).toBeGreaterThan(0);
    }
    const groups = r.rootCauseGroups!['description.missing']!;
    expect(groups.map((g) => [g.key, g.kind, g.pages])).toEqual([['/post/*', 'template', N]]);
    // Evidence refs are stable across runs.
    const again = (await audit()).report.findings.find((f) => f.ruleId === 'description.missing')!;
    const refs = (x: AuditReport['findings'][number]) => x.evidence.map((e) => e.ref).sort();
    expect(refs(again)).toEqual(refs(r.findings.find((f) => f.ruleId === 'description.missing')!));
  });

  it('remediation is "auto" for rules with a patch in the linked repository plan', async () => {
    const { report, store } = await audit();
    writeContext(store, { repository: { path: '/repo' }, autoRules: ['description.missing'] });
    writeReports(store, report, loadKnowledge(), ['json']);
    const r = store.readJson<AuditReport>('report.json')!;
    expect(r.findings.find((f) => f.ruleId === 'description.missing')!.remediation).toBe('auto');
    expect(r.findings.find((f) => f.ruleId === 'perf.cwv-unmeasured')!.remediation).toBe('manual');
  });
});
