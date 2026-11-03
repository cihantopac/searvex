import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditWebsite, type AuditReport } from '../../src/analyze/audit.js';
import { DEFAULT_POLICY } from '../../src/net/ssrf.js';
import { page, startServer, text, type Route, type TestServer } from '../helpers/server.js';

const URLSET = (locs: string[]) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((l) => `<url><loc>${l}</loc></url>`).join('')}</urlset>`;
const xml = (body: string): Route => ({ headers: { 'content-type': 'application/xml' }, body });
const robots = (lines: string): Route => ({ headers: { 'content-type': 'text/plain' }, body: `User-agent: *\nAllow: /\n${lines}` });
const home: Route = { body: page({ title: 'Home page of the site', body: `<h1>Home</h1>${text(200)}` }) };

let ws: string;
const servers: TestServer[] = [];

const audit = async (routes: Record<string, Route | ((origin: string) => Route)>, siteUrl?: string): Promise<AuditReport> => {
  const table: Record<string, Route> = {};
  const s = await startServer(table);
  servers.push(s);
  for (const [k, r] of Object.entries(routes)) table[k] = typeof r === 'function' ? r(s.url) : r;
  return (await auditWebsite(s.url + '/', { workspace: ws, crawl: { policy: { ...DEFAULT_POLICY, allowPrivate: true }, delayMs: 0, timeoutMs: 3000, siteUrl }, probes: false })).report;
};
const finding = (r: AuditReport, id: string) => r.findings.find((f) => f.ruleId === id);

beforeAll(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-sitemap-'));
});

afterAll(async () => {
  for (const s of servers) await s.close();
  fs.rmSync(ws, { recursive: true, force: true });
});

describe('robots.sitemap-unreachable vs robots.no-sitemap', () => {
  it('a declared sitemap on an unresolvable host is unreachable, not missing', async () => {
    const r = await audit({ '/robots.txt': robots('Sitemap: https://sitemaps.invalid/sitemap.xml\n'), '/': home });
    const f = finding(r, 'robots.sitemap-unreachable');
    expect(f?.severity).toBe('low');
    expect(f?.evidence[0]?.url).toBe('https://sitemaps.invalid/sitemap.xml');
    expect(f?.evidence[0]?.observed).toBeTruthy();
    expect(finding(r, 'robots.no-sitemap')).toBeUndefined();
  });

  it('a declared sitemap returning 404 is unreachable too', async () => {
    const r = await audit({ '/robots.txt': (o) => robots(`Sitemap: ${o}/missing.xml\n`), '/': home });
    expect(finding(r, 'robots.sitemap-unreachable')?.evidence[0]?.observed).toMatch(/HTTP 404/);
    expect(finding(r, 'robots.no-sitemap')).toBeUndefined();
  });

  it('only the failing declared sitemap is reported when another one works', async () => {
    const r = await audit({
      '/robots.txt': (o) => robots(`Sitemap: ${o}/sitemap.xml\nSitemap: ${o}/gone.xml\n`),
      '/sitemap.xml': (o) => xml(URLSET([`${o}/`])),
      '/': home,
    });
    const f = finding(r, 'robots.sitemap-unreachable');
    expect(f?.evidence.map((e) => new URL(e.url!).pathname)).toEqual(['/gone.xml']);
    expect(finding(r, 'robots.no-sitemap')).toBeUndefined();
  });

  it('no directive and no /sitemap.xml is still robots.no-sitemap', async () => {
    const r = await audit({ '/robots.txt': robots(''), '/': home });
    expect(finding(r, 'robots.no-sitemap')).toBeTruthy();
    expect(finding(r, 'robots.sitemap-unreachable')).toBeUndefined();
  });

  it('with --site-url, a declared public sitemap is read from the build, and a failure names where it was fetched', async () => {
    const ok = await audit({ '/robots.txt': robots('Sitemap: https://site.invalid/sitemap.xml\n'), '/sitemap.xml': xml(URLSET(['https://site.invalid/'])), '/': home }, 'https://site.invalid');
    expect(finding(ok, 'robots.sitemap-unreachable')).toBeUndefined();
    expect(ok.crawl.sitemapUrls).toBe(1);

    const missing = await audit({ '/robots.txt': robots('Sitemap: https://site.invalid/sitemap.xml\n'), '/': home }, 'https://site.invalid');
    const e = finding(missing, 'robots.sitemap-unreachable')?.evidence[0];
    expect(e?.url).toBe('https://site.invalid/sitemap.xml');
    expect(e?.observed).toMatch(/HTTP 404 \(fetched at http:\/\/127\.0\.0\.1:\d+\/sitemap\.xml\)/);
  });
});
