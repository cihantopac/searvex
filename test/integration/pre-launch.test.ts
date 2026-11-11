import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auditWebsite, type AuditReport } from '../../src/analyze/audit.js';
import { DEFAULT_POLICY } from '../../src/net/ssrf.js';
import { loadKnowledge } from '../../src/rules/engine.js';
import { renderHtml } from '../../src/report/html.js';
import { renderMarkdown } from '../../src/report/markdown.js';
import { main } from '../../src/cli.js';
import { page, startServer, text, type Route, type TestServer } from '../helpers/server.js';

/**
 * R1: a static export served locally (plain HTTP, no compression), intentionally noindex before launch,
 * declaring its public origin in canonicals and the sitemap. "before" has two real metadata issues; "after"
 * fixes them. The pre-launch score must never drop between the two.
 */
const PUBLIC = 'https://launch.invalid';
const kb = loadKnowledge();
const big = text(2200); // > 10 KB so perf.no-compression applies

function site(fixed: boolean): Record<string, Route> {
  const p = (path: string, title: string, desc: string | null) => ({
    body: page({
      title,
      head: `<meta name="robots" content="noindex"><link rel="canonical" href="${PUBLIC}${path}">${desc ? `<meta name="description" content="${desc}">` : ''}`,
      body: `<h1>${title}</h1><a href="${PUBLIC}/">Home</a><a href="${PUBLIC}/work">Work</a><a href="${PUBLIC}/contact">Contact</a><p>${big}</p>`,
    }),
  });
  return {
    '/robots.txt': { headers: { 'content-type': 'text/plain' }, body: `User-agent: *\nAllow: /\nSitemap: ${PUBLIC}/sitemap.xml\n` },
    '/sitemap.xml': {
      headers: { 'content-type': 'application/xml' },
      body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/work', '/contact'].map((u) => `<url><loc>${PUBLIC}${u}</loc></url>`).join('')}</urlset>`,
    },
    '/': p('/', 'Jane Doe — designer and developer', 'Portfolio of Jane Doe.'),
    '/work': p('/work', fixed ? 'Selected work by Jane Doe' : 'Jane Doe — designer and developer', fixed ? 'Selected projects.' : null),
    '/contact': p('/contact', 'Contact Jane Doe', fixed ? 'How to reach Jane Doe.' : null),
  };
}

let before: TestServer;
let after: TestServer;
let ws: string;
const policy = { ...DEFAULT_POLICY, allowPrivate: true };
const audit = async (s: TestServer, preLaunch: boolean): Promise<AuditReport> =>
  (await auditWebsite(s.url + '/', { workspace: ws, crawl: { policy, delayMs: 0, timeoutMs: 3000, siteUrl: PUBLIC }, probes: false, preLaunch })).report;
const byId = (r: AuditReport, id: string) => r.findings.find((f) => f.ruleId === id);

beforeAll(async () => {
  before = await startServer(site(false));
  after = await startServer(site(true));
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-prelaunch-'));
});

afterAll(async () => {
  await before.close();
  await after.close();
  fs.rmSync(ws, { recursive: true, force: true });
});

describe('pre-launch profile (R1)', () => {
  it('separates environment and launch-checklist findings from the score', async () => {
    const r = await audit(before, true);
    expect(r.scores.profile).toBe('pre-launch');
    expect(byId(r, 'https.not-used')?.context).toBe('environment');
    expect(byId(r, 'perf.no-compression')?.context).toBe('environment');
    expect(byId(r, 'index.noindex')).toMatchObject({ context: 'launch-checklist', count: 3 });
    expect(byId(r, 'index.noindex-in-sitemap')).toMatchObject({ context: 'launch-checklist', count: 3 });
    // No mapping noise (A1/A2).
    for (const id of ['canonical.cross-domain', 'canonical.noindex-conflict', 'robots.no-sitemap', 'robots.sitemap-unreachable']) expect(byId(r, id), id).toBeUndefined();
    // Noindex pages are evaluated as they will be once live, so real issues are still found.
    expect(byId(r, 'description.missing')?.count).toBe(2);
    expect(byId(r, 'duplicate.title') ?? byId(r, 'title.duplicate')).toBeTruthy();
    expect(r.findings.filter((f) => f.context).every((f) => !f.priority)).toBe(true);
    expect(r.limitations.join(' ')).toMatch(/3 noindex page\(s\) were evaluated as indexable/);
  });

  it('fixing real issues raises the pre-launch score and never lowers it', async () => {
    const b = await audit(before, true);
    const a = await audit(after, true);
    expect(a.scores.overall).toBeGreaterThan(b.scores.overall!);
    expect(byId(a, 'description.missing')).toBeUndefined();
  });

  it('without the profile, the test server and the noindex state are scored', async () => {
    const plain = await audit(after, false);
    const pre = await audit(after, true);
    expect(byId(plain, 'https.not-used')?.context).toBeUndefined();
    expect(plain.scores.profile).toBeUndefined();
    expect(plain.scores.overall).toBeLessThan(pre.scores.overall!);
  });

  it('reports show the launch checklist and the environment-dependent findings', async () => {
    const r = await audit(before, true);
    const out = renderMarkdown(r);
    expect(out).toMatch(/## Launch checklist/);
    expect(out).toMatch(/- \[ \] \*\*.*`index\.noindex`/);
    expect(out).toMatch(/### Environment-dependent[\s\S]*`https\.not-used`/);
    expect(out).toMatch(/\(pre-launch profile\)/);
    // Context findings are not listed again as issues.
    expect(out.split('## Issues by severity')[1]).not.toMatch(/`https\.not-used`/);
    const html = renderHtml(r, kb);
    expect(html).toContain('"context":"environment"');
    expect(html).toContain('Lansman kontrol listesi');
  });

  it('CLI: suggests --pre-launch on a private target, applies it with the flag, and --fail-on ignores context findings', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const args = ['audit', after.url + '/', '--allow-private', '--delay', '0', '--site-url', PUBLIC, '--out', ws, '--format', 'json', '--fail-on', 'high'];
    try {
      expect(await main(args)).toBe(1); // https.not-used (high) counts without the profile
      expect(err.mock.calls.flat().join('\n')).toMatch(/Add --pre-launch/);
      err.mockClear();
      expect(await main([...args, '--pre-launch'])).toBe(0);
      expect(err.mock.calls.flat().join('\n')).not.toMatch(/Add --pre-launch/);
      expect(log.mock.calls.flat().join('\n')).toMatch(/Launch checklist \(change before going live, not scored\)/);
    } finally {
      err.mockRestore();
      log.mockRestore();
    }
  });
});
