import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { accessToken, authorize, GSC_SCOPE, readCredentials, saveCredential } from '../../src/integrations/google-oauth.js';
import { querySearchConsole } from '../../src/integrations/gsc.js';
import { analyzeSearchPerformance, type QueryPage } from '../../src/analyze/search-performance.js';
import { main } from '../../src/cli.js';

/** Fake Google OAuth token endpoint + Search Console API (never contacts Google). */
async function fakeGoogle() {
  const issued: Record<string, string> = {}; // code -> PKCE challenge
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const allRows = Array.from({ length: 5 }, (_, i) => ({ keys: [`query ${i}`, `https://site.example/p${i}`], clicks: 10 - i, impressions: 100, ctr: (10 - i) / 100, position: 3 + i }));
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/token') {
        const form = Object.fromEntries(new URLSearchParams(raw));
        if (form['grant_type'] === 'authorization_code') {
          const challenge = issued[form['code']!];
          const computed = crypto.createHash('sha256').update(form['code_verifier'] ?? '').digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          if (!challenge || computed !== challenge) return res.writeHead(400).end(JSON.stringify({ error: 'invalid_grant' }));
          return res.writeHead(200).end(JSON.stringify({ refresh_token: 'refresh-123', access_token: 'a', scope: GSC_SCOPE }));
        }
        if (form['grant_type'] === 'refresh_token' && form['refresh_token'] === 'refresh-123') return res.writeHead(200).end(JSON.stringify({ access_token: 'access-xyz' }));
        return res.writeHead(400).end(JSON.stringify({ error: 'invalid_request' }));
      }
      if (req.headers.authorization !== 'Bearer access-xyz') return res.writeHead(401).end(JSON.stringify({ error: { message: 'unauthenticated' } }));
      if (url.pathname === '/webmasters/v3/sites') return res.writeHead(200).end(JSON.stringify({ siteEntry: [{ siteUrl: 'sc-domain:site.example', permissionLevel: 'siteOwner' }] }));
      if (url.pathname.endsWith('/searchAnalytics/query')) {
        const body = JSON.parse(raw) as { startRow: number; rowLimit: number };
        requests.push({ path: url.pathname, body });
        return res.writeHead(200).end(JSON.stringify({ rows: allRows.slice(body.startRow, body.startRow + body.rowLimit) }));
      }
      res.writeHead(404).end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, issued, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

let g: Awaited<ReturnType<typeof fakeGoogle>>;
let cfg: string;
beforeAll(async () => {
  g = await fakeGoogle();
  cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-cfg-'));
  process.env['SEARVEX_GOOGLE_TOKEN_URL'] = `${g.base}/token`;
  process.env['SEARVEX_GSC_API_BASE'] = `${g.base}/webmasters/v3`;
  process.env['SEARVEX_CONFIG_DIR'] = cfg;
  delete process.env['SEARVEX_GSC_TOKEN'];
});
afterAll(async () => {
  await g.close();
  fs.rmSync(cfg, { recursive: true, force: true });
  for (const k of ['SEARVEX_GOOGLE_TOKEN_URL', 'SEARVEX_GSC_API_BASE', 'SEARVEX_CONFIG_DIR']) delete process.env[k];
});

/** Plays the browser: reads the consent URL, then hits the loopback redirect like Google would. */
const browser = (mutate?: (u: URL) => void) => async (consentUrl: string) => {
  const u = new URL(consentUrl);
  expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  expect(u.searchParams.get('scope')).toBe(GSC_SCOPE);
  expect(u.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  g.issued['code-1'] = u.searchParams.get('code_challenge')!;
  const back = new URL(u.searchParams.get('redirect_uri')!);
  back.searchParams.set('code', 'code-1');
  back.searchParams.set('state', u.searchParams.get('state')!);
  mutate?.(back);
  setTimeout(() => http.get(back.toString(), (r) => r.resume()).on('error', () => {}), 10);
};

describe('Google OAuth (installed app, loopback + PKCE)', () => {
  it('completes the flow, verifies PKCE and stores the refresh token with 0600 permissions', async () => {
    const cred = await authorize({ clientId: 'cid.apps.googleusercontent.com', clientSecret: 'not-secret-for-desktop' }, GSC_SCOPE, browser());
    expect(cred.refreshToken).toBe('refresh-123');
    const file = saveCredential('gsc', cred);
    expect(readCredentials()['gsc']!.refreshToken).toBe('refresh-123');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(await accessToken(cred)).toBe('access-xyz');
  });

  it('rejects a redirect with a mismatched state (CSRF)', async () => {
    await expect(authorize({ clientId: 'cid' }, GSC_SCOPE, browser((b) => b.searchParams.set('state', 'forged')))).rejects.toThrow(/State mismatch/);
  });
});

describe('Search Console client', () => {
  it('pages through results with startRow/rowLimit', async () => {
    const rows = await querySearchConsole({ token: 'access-xyz', siteUrl: 'sc-domain:site.example', days: 28, dimensions: ['query', 'page'], rowLimit: 2, maxRows: 10 });
    expect(rows).toHaveLength(5);
    expect(g.requests.map((r) => r.body['startRow'])).toEqual([0, 2, 4]);
  });
});

describe('search performance analysis', () => {
  const qp = (query: string, page: string, impressions: number, clicks: number, position: number): QueryPage => ({ query, page, impressions, clicks, ctr: clicks / impressions, position });
  const data: QueryPage[] = [
    ...Array.from({ length: 6 }, (_, i) => qp(`brand ${i}`, `https://s.example/p${i}`, 200, 40, 2)), // site median CTR at pos 2 = 20%
    qp('weak snippet', 'https://s.example/w', 500, 10, 2), // 2% at pos 2 → low CTR
    qp('almost there', 'https://s.example/a', 300, 3, 11.4), // striking distance
    qp('shared topic', 'https://s.example/x', 120, 5, 6),
    qp('shared topic', 'https://s.example/y', 100, 2, 9),
    qp('how to choose a plan', 'https://s.example/pricing', 400, 4, 5), // informational query on a pricing page
  ];
  const audit = {
    inventory: { pages: [{ url: 'https://s.example/w', indexable: true }, { url: 'https://s.example/never', indexable: true }, { url: 'https://s.example/pricing', indexable: true, type: 'pricing', intent: 'transactional' }] },
    findings: [{ ruleId: 'title.multiple', title: 'Multiple title elements', severity: 'medium', evidence: [{ url: 'https://s.example/w' }] }],
  } as never;
  const r = analyzeSearchPerformance(data, { days: 28, source: 'test', audit });

  it('finds striking-distance queries, low CTR vs own median and multi-page queries', () => {
    expect(r.strikingDistance.map((x) => x.query)).toEqual(['almost there', 'shared topic']); // /y ranks 9 with 100 impressions
    expect(r.lowCtr[0]).toMatchObject({ query: 'weak snippet', siteMedianCtr: 0.2 });
    expect(r.multiPageQueries[0]!.query).toBe('shared topic');
    expect(r.multiPageQueries[0]!.pages).toHaveLength(2);
  });

  it('maps pages to their primary query and joins audit findings with traffic', () => {
    expect(r.topPages.find((p) => p.page.endsWith('/w'))!.primaryQuery).toBe('weak snippet');
    expect(r.noImpressions).toEqual(['https://s.example/never']);
    expect(r.findingsOnTrafficPages[0]).toMatchObject({ ruleId: 'title.multiple', impressions: 500 });
  });

  it('labels query intent (inferred) and flags intent mismatches against the ranking page type', () => {
    expect(r.topQueries.find((q) => q.query === 'how to choose a plan')?.intent).toBe('informational');
    expect(r.intentMismatches).toEqual([expect.objectContaining({ query: 'how to choose a plan', queryIntent: 'informational', pageType: 'pricing', pageIntent: 'transactional' })]);
    expect(r.intentMix.find((m) => m.intent === 'unclassified')!.queries).toBeGreaterThan(0);
    expect(r.notes.join(' ')).toMatch(/inferred/);
  });
});

describe('CLI gsc', () => {
  it('lists sites and writes a report using the stored credential', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-gsc-'));
    try {
      expect(await main(['gsc', 'sites'])).toBe(0);
      expect(log.mock.calls.flat().join('\n')).toContain('sc-domain:site.example');
      expect(await main(['gsc', 'report', 'sc-domain:site.example', '--out', ws, '-q'])).toBe(0);
      const run = fs.readdirSync(path.join(ws, '.searvex', 'runs')).find((d) => d.startsWith('gsc'))!;
      const rep = JSON.parse(fs.readFileSync(path.join(ws, '.searvex', 'runs', run, 'search-performance.json'), 'utf8'));
      expect(rep.totals.clicks).toBe(40);
      expect(await main(['gsc', 'logout'])).toBe(0);
      expect(await main(['gsc', 'sites'])).toBe(2); // no credential anymore
    } finally {
      log.mockRestore();
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
