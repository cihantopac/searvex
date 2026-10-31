import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditWebsite, type AuditReport } from '../../src/analyze/audit.js';
import { DEFAULT_POLICY } from '../../src/net/ssrf.js';
import { loadKnowledge } from '../../src/rules/engine.js';
import { page, startServer, text, type TestServer } from '../helpers/server.js';

/**
 * Regressions from the permitted product-family round (2026-11-01), anonymised: a bilingual site whose pages
 * link to the English home only through redirects — a trailing-slash variant and a language switch.
 */
let server: TestServer;
let report: AuditReport;
let ws: string;

beforeAll(async () => {
  const nav = '<a href="/en/">English</a> <a href="/language/en">EN</a> <a href="/about">About</a>' + ['/privacy', '/legal/tool/privacy', '/help', '/en/help', '/blog/email-auth', '/blog/email-auth-explained'].map((u) => `<a href="${u}">${u}</a>`).join(' ');
  server = await startServer({
    '/': { body: page({ title: 'Home', lang: 'tr', body: nav + text(200) }) },
    '/about': { body: page({ title: 'About', lang: 'tr', body: '<a href="/">Home</a>' + text(200) + '<img src="/a.webp" alt="" class="aspect-[16/9] w-full object-cover"><img src="/b.webp" alt="" class="aspect-video w-full"><img src="/logo.svg" alt="" height="32" class="h-8 w-auto">' }) },
    '/en': { body: page({ title: 'Home EN', lang: 'en', body: '<a href="/">Türkçe</a>' + text(200) }) },
    '/en/': { redirect: '/en', status: 301 },
    '/language/en': { redirect: '/en', status: 302 },
    '/lonely': { body: page({ title: 'Lonely', lang: 'tr', body: text(200) }) },
    // Each product's privacy policy shares the title by design: not cannibalisation.
    '/privacy': { body: page({ title: 'Gizlilik politikası', lang: 'tr', body: '<h1>Gizlilik politikası</h1>' + text(200) }) },
    '/legal/tool/privacy': { body: page({ title: 'Gizlilik politikası', lang: 'tr', body: '<h1>Gizlilik politikası</h1>' + text(210) }) },
    // A Turkish page and an English page with an untranslated H1: different languages do not compete.
    '/help': { body: page({ title: 'Yardım', lang: 'tr', body: '<h1>Yardım merkezi</h1>' + text(220) }) },
    '/en/help': { body: page({ title: 'Help', lang: 'en', body: '<h1>Yardım merkezi</h1>' + text(230) }) },
    // Two posts on the same topic in the same language: a real candidate.
    '/blog/email-auth': { body: page({ title: 'SPF DKIM DMARC kurulumu', lang: 'tr', body: '<h1>SPF DKIM DMARC kurulumu</h1>' + text(240) }) },
    '/blog/email-auth-explained': { body: page({ title: 'SPF DKIM DMARC kurulumu anlatımı', lang: 'tr', body: '<h1>SPF DKIM DMARC kurulumu</h1>' + text(250) }) },
    '/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nAllow: /\n' },
    '/sitemap.xml': (req) => ({
      headers: { 'content-type': 'application/xml' },
      body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/about', '/en', '/lonely'].map((p) => `<url><loc>http://${req.headers.host}${p}</loc></url>`).join('')}</urlset>`,
    }),
  });
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-rw-site-'));
  ({ report } = await auditWebsite(server.url + '/', { workspace: ws, kb: loadKnowledge(), crawl: { policy: { ...DEFAULT_POLICY, allowPrivate: true }, delayMs: 0 } }));
}, 30000);

afterAll(async () => {
  await server.close();
  fs.rmSync(ws, { recursive: true, force: true });
});

describe('pages reached only through internal redirects', () => {
  it('are not orphans; a sitemap page that nothing links to still is', () => {
    const orphans = report.findings.find((f) => f.ruleId === 'crawl.sitemap-orphan')?.evidence.map((e) => new URL(e.url!).pathname) ?? [];
    expect(orphans).toEqual(['/lonely']);
  });

  it('count links through redirects as inlinks of the target page', () => {
    expect(report.inventory.pages.find((p) => new URL(p.url).pathname === '/en')!.inlinks).toBeGreaterThan(0);
  });
});

describe('cannibalisation candidates', () => {
  it('ignore legal documents and pages in different languages, and keep same-language collisions', () => {
    const groups = report.content.cannibalization.map((c) => c.pages.map((u) => new URL(u).pathname).sort());
    expect(groups).toEqual([['/blog/email-auth', '/blog/email-auth-explained']]);
  });
});

describe('image dimensions', () => {
  it('accept aspect-ratio utility classes, and still flag an image with only a height', () => {
    const f = report.findings.find((x) => x.ruleId === 'img.dimensions-missing');
    expect(f?.evidence.map((e) => [new URL(e.url!).pathname, e.observed])).toEqual([['/about', '1 image(s) without width/height attributes']]);
  });
});

describe('truncated crawls', () => {
  it('do not report orphans, and say why', async () => {
    const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-rw-trunc-'));
    try {
      const { report: r } = await auditWebsite(server.url + '/', { workspace: ws2, kb: loadKnowledge(), crawl: { policy: { ...DEFAULT_POLICY, allowPrivate: true }, delayMs: 0, maxPages: 3 } });
      expect(r.crawl.truncated).toBe(true);
      expect(r.findings.map((f) => f.ruleId)).not.toContain('crawl.sitemap-orphan');
      expect(r.limitations[0]).toMatch(/orphan pages are not reported/);
    } finally {
      fs.rmSync(ws2, { recursive: true, force: true });
    }
  });
});
