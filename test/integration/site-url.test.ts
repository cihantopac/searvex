import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auditWebsite, type AuditReport } from '../../src/analyze/audit.js';
import { DEFAULT_POLICY } from '../../src/net/ssrf.js';
import { renderMarkdown } from '../../src/report/markdown.js';
import { main } from '../../src/cli.js';
import { page, startServer, text, type TestServer } from '../helpers/server.js';

// A local build of a site whose public origin is not live (".invalid" never resolves).
const PUBLIC = 'https://site.invalid';
let server: TestServer;
let ws: string;

// Home page pair (en at /, tr at /tr/) with public canonicals and hreflang.
const head = (self: string) =>
  `<link rel="canonical" href="${PUBLIC}${self}"><link rel="alternate" hreflang="en" href="${PUBLIC}/"><link rel="alternate" hreflang="tr" href="${PUBLIC}/tr/"><link rel="alternate" hreflang="x-default" href="${PUBLIC}/">`;

beforeAll(async () => {
  server = await startServer({
    '/robots.txt': { headers: { 'content-type': 'text/plain' }, body: `User-agent: *\nAllow: /\nSitemap: ${PUBLIC}/sitemap.xml\n` },
    '/sitemap.xml': {
      headers: { 'content-type': 'application/xml' },
      body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${PUBLIC}/</loc></url><url><loc>${PUBLIC}/about</loc></url><url><loc>${PUBLIC}/tr/</loc></url></urlset>`,
    },
    '/': { body: page({ title: 'Home of the example site', head: head('/'), body: `<h1>Home</h1><a href="${PUBLIC}/about">About</a><a href="/private">Private</a>${text(200)}` }) },
    '/tr/': { body: page({ lang: 'tr', title: 'Örnek sitenin ana sayfası', head: head('/tr/'), body: `<h1>Ana sayfa</h1>${text(200)}` }) },
    '/about': { body: page({ title: 'About the example site', head: `<link rel="canonical" href="${PUBLIC}/about">`, body: `<h1>About</h1>${text(200)}` }) },
    // Intentionally noindex, self-canonical on the public origin.
    '/private': { body: page({ title: 'Private page of the site', head: `<meta name="robots" content="noindex"><link rel="canonical" href="${PUBLIC}/private">`, body: `<h1>Private</h1>${text(200)}` }) },
  });
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-siteurl-'));
});

afterAll(async () => {
  await server.close();
  fs.rmSync(ws, { recursive: true, force: true });
});

const audit = async (siteUrl?: string): Promise<AuditReport> =>
  (await auditWebsite(server.url + '/', { workspace: ws, crawl: { policy: { ...DEFAULT_POLICY, allowPrivate: true }, delayMs: 0, timeoutMs: 3000, siteUrl }, probes: false })).report;

const ids = (r: AuditReport) => r.findings.map((f) => f.ruleId);

describe('--site-url in URL mode', () => {
  it('without it, the public canonical looks cross-domain and conflicts with noindex', async () => {
    const r = await audit();
    expect(ids(r)).toContain('canonical.cross-domain');
    expect(ids(r)).toContain('canonical.noindex-conflict');
    expect(r.crawl.siteUrl).toBeUndefined();
    // Absolute links to the public origin are external, so /about is never crawled.
    expect(r.inventory.pages.map((p) => new URL(p.url).pathname)).not.toContain('/about');
  });

  it('with it, public URLs map to the crawled origin: canonicals are self, sitemap and links resolve', async () => {
    const r = await audit(PUBLIC + '/');
    const found = ids(r);
    for (const id of ['canonical.cross-domain', 'canonical.noindex-conflict', 'index.sitemap-non-canonical', 'robots.no-sitemap', 'hreflang.target-error', 'hreflang.missing-return']) expect(found).not.toContain(id);
    expect(r.crawl.siteUrl).toBe(PUBLIC);
    expect(r.crawl.sitemapUrls).toBe(3);
    expect(r.crawl.sitemaps).toEqual([server.url + '/sitemap.xml']);
    const crawled = r.inventory.pages.map((p) => new URL(p.url).pathname);
    expect(crawled).toEqual(expect.arrayContaining(['/', '/about', '/tr/', '/private']));
    // The intentional noindex is still reported as such.
    expect(found).toContain('index.noindex');
    // Mapping-only noise is gone, so the score is not lowered by it.
    expect(r.findings.filter((f) => f.evidence.some((e) => (e.observed ?? '').includes(PUBLIC)))).toEqual([]);
    expect(r.limitations.join(' ')).toMatch(/Audited http:\/\/127\.0\.0\.1:\d+ as https:\/\/site\.invalid/);
    expect(renderMarkdown(r)).toMatch(/Audited `http:\/\/127\.0\.0\.1:\d+` as `https:\/\/site\.invalid`/);
  });

  it('CLI: audit accepts --site-url and prints the mapping; a non-URL value is a usage error', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await main(['audit', server.url + '/', '--allow-private', '--delay', '0', '--site-url', PUBLIC, '--out', ws, '--format', 'json'])).toBe(0);
      expect(log.mock.calls.flat().join('\n')).toMatch(/Audited http:\/\/127\.0\.0\.1:\d+ as https:\/\/site\.invalid \(--site-url\)/);
      expect(await main(['audit', server.url + '/', '--allow-private', '--site-url', 'sc-domain:site.invalid', '--out', ws])).toBe(2);
      expect(err.mock.calls.flat().join('\n')).toMatch(/--site-url must be an absolute http\(s\) URL/);
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });

  it('monitor: a --site-url on another origin maps origins and is not treated as a Search Console property', async () => {
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-siteurl-cfg-'));
    vi.stubEnv('SEARVEX_CONFIG_DIR', cfg);
    vi.stubEnv('SEARVEX_GSC_SITE', '');
    vi.stubEnv('SEARVEX_GSC_TOKEN', '');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await main(['monitor', server.url + '/', '--allow-private', '--delay', '0', '--site-url', PUBLIC, '--out', ws])).toBe(0);
      expect(err.mock.calls.flat().join('\n')).not.toMatch(/does not cover/);
    } finally {
      log.mockRestore();
      err.mockRestore();
      vi.unstubAllEnvs();
      fs.rmSync(cfg, { recursive: true, force: true });
    }
  });
});
