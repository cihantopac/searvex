import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auditWebsite, type AuditReport } from '../../src/analyze/audit.js';
import { DEFAULT_POLICY } from '../../src/net/ssrf.js';
import { loadKnowledge } from '../../src/rules/engine.js';
import { renderHtml, safeJson } from '../../src/report/html.js';
import { md, renderMarkdown } from '../../src/report/markdown.js';
import { renderSarif } from '../../src/report/sarif.js';
import { computeGaps, renderResearchMarkdown } from '../../src/commands/research.js';
import { main } from '../../src/cli.js';
import { page, startServer, text, type Route, type TestServer } from '../helpers/server.js';

const kb = loadKnowledge();
const policy = { ...DEFAULT_POLICY, allowPrivate: true };
let server: TestServer;
let comp: TestServer;
let report: AuditReport;
let ws: string;
const EVIL = '</script><img src=x onerror=alert(1)>';

beforeAll(async () => {
  const routes: Record<string, Route> = {};
  server = await startServer(routes);
  Object.assign(routes, {
    '/': { body: page({ title: `Evil ${EVIL}`, body: `<h1>Shop ${EVIL}</h1><a href="/pricing">Pricing</a><a href="/blog/a">A</a>${text(200)}` }) },
    '/pricing': { body: page({ title: 'Pricing', head: '<meta name="description" content="Plans">', body: `<h1>Pricing plans</h1>${text(200)}` }) },
    '/blog/a': { body: page({ title: 'Espresso guide', body: `<h1>Espresso extraction guide</h1><p>espresso grinder tamping extraction crema</p>${text(150)}` }) },
  });
  comp = await startServer({
    '/': { body: page({ title: 'Competitor', body: `<a href="/docs/start">Docs</a><a href="/compare">Compare</a><h1>Competitor</h1><p>subscription roastery subscription</p>${text(150)}` }) },
    '/docs/start': { body: page({ title: 'Docs', body: `<h1>Getting started</h1><p>subscription roastery delivery</p>${text(150)}` }) },
    '/compare': { body: page({ title: 'Compare', body: `<h1>Compare</h1><p>subscription delivery roastery</p>${text(150)}` }) },
  });
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-rep-'));
  ({ report } = await auditWebsite(server.url + '/', { workspace: ws, crawl: { policy, delayMs: 0 }, probes: false }));
});

afterAll(async () => {
  await server.close();
  await comp.close();
  fs.rmSync(ws, { recursive: true, force: true });
});

describe('report renderers', () => {
  it('HTML report embeds hostile page content inertly', () => {
    const html = renderHtml(report, kb);
    expect(html).not.toContain(EVIL);
    expect(html).not.toMatch(/<img src=x/);
    expect(html).toContain('\\u003c/script\\u003e');
    expect(safeJson({ a: '</script>&\u2028' })).toBe('{"a":"\\u003c/script\\u003e\\u0026\\u2028"}');
    // Only http(s) links are rendered as hrefs.
    expect(html).toContain("/^https?:\\/\\//i.test(u)?u:'#'");
  });

  it('Markdown report escapes crawled text and lists limitations', () => {
    const out = renderMarkdown(report);
    expect(out).not.toContain('<img src=x');
    expect(md('a|b<c>`d`\nnext')).toBe('a\\|b\\<c\\>\\`d\\` next');
    expect(out).toContain('## Limitations');
    expect(out).toContain('not a search engine metric');
  });

  it('SARIF report is valid 2.1.0 with rule metadata and help URIs', () => {
    const sarif = renderSarif(report, kb) as { version: string; runs: Array<{ tool: { driver: { rules: Array<{ helpUri: string }> } }; results: unknown[] }> };
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0]!.results.length).toBeGreaterThan(0);
    for (const r of sarif.runs[0]!.tool.driver.rules) expect(r.helpUri).toMatch(/^https:\/\//);
  });
});

describe('research', () => {
  it('computes topic and page-type gaps only from consistent competitor signals', () => {
    const t = { url: 't', pages: 3, businessModel: 'x', byType: { home: 1, pricing: 1 }, languages: [], topTerms: ['espresso'], sections: [], schemaTypes: [] as string[], truncated: false };
    const c1 = { ...t, url: 'c1', byType: { home: 1, docs: 2 }, topTerms: ['subscription', 'roastery', 'espresso'] };
    const c2 = { ...t, url: 'c2', byType: { home: 1, docs: 1, blog: 1 }, topTerms: ['subscription', 'delivery'] };
    c1.schemaTypes = ['Organization', 'FAQPage', 'Product'];
    c2.schemaTypes = ['Organization', 'Product'];
    t.schemaTypes = ['Organization'];
    const gaps = computeGaps(t, [c1, c2], new Set(['espresso']));
    expect(gaps.schemaTypes).toEqual([{ type: 'Product', competitors: 2 }, { type: 'FAQPage', competitors: 1 }]);
    expect(gaps.topics.map((g) => g.term)).toEqual(expect.arrayContaining(['subscription', 'roastery', 'delivery']));
    expect(gaps.topics.find((g) => g.term === 'subscription')!.competitors).toBe(2);
    expect(gaps.pageTypes.map((g) => g.type)).toContain('docs');
    expect(renderResearchMarkdown({ target: t, competitors: [c1, c2], gaps, limitations: ['x'] })).toContain('Content gaps');
  });

  it('CLI research crawls target and competitors and writes research.md', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await main(['research', server.url + '/', '--competitor', comp.url + '/', '--allow-private', '--delay', '0', '--out', ws, '-q']);
      expect(code).toBe(0);
      const run = fs.readdirSync(path.join(ws, '.searvex', 'runs')).find((d) => d.startsWith('research'))!;
      const research = JSON.parse(fs.readFileSync(path.join(ws, '.searvex', 'runs', run, 'research.json'), 'utf8'));
      expect(research.competitors).toHaveLength(1);
      expect(research.gaps.pageTypes.map((g: { type: string }) => g.type)).toContain('docs');
      expect(research.limitations.join(' ')).toMatch(/does not fabricate/);
    } finally {
      log.mockRestore();
    }
  });
});

describe('searvex run (ordered workflow)', () => {
  it('runs all six steps in order with one crawl and never changes the repository', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-run-'));
    fs.cpSync(path.resolve('test/fixtures/repos/static-site'), repo, { recursive: true });
    const before = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
    try {
      const args = ['run', server.url + '/', repo, '--competitor', comp.url + '/', '--allow-private', '--delay', '0', '--out', ws, '-q'];
      expect(await main(args)).toBe(0);
      expect(await main(args)).toBe(0);
      const runs = fs.readdirSync(path.join(ws, '.searvex', 'runs')).filter((d) => d.startsWith('run-')).sort();
      const summary = JSON.parse(fs.readFileSync(path.join(ws, '.searvex', 'runs', runs.at(-1)!, 'summary.json'), 'utf8'));
      expect(summary.steps.map((s: { step: number; status: string }) => `${s.step}:${s.status}`)).toEqual(['1:done', '2:done', '3:done', '4:done', '5:done', '6:done']);
      expect(summary.plan.fixes.length).toBeGreaterThan(0);
      expect(fs.readFileSync(path.join(repo, 'index.html'), 'utf8')).toBe(before);
      const md = fs.readFileSync(path.join(ws, '.searvex', 'runs', runs.at(-1)!, 'summary.md'), 'utf8');
      expect(md.indexOf('## 1. Website audit')).toBeLessThan(md.indexOf('## 6. Fix plan'));
      expect(await main(['run', '--out', ws, '-q'])).toBe(2);
    } finally {
      log.mockRestore();
      err.mockRestore();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('CLI in-process', () => {
  it('audit, geo, report re-render, runs, rules show/list', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await main(['audit', server.url + '/', '--allow-private', '--delay', '0', '--out', ws, '--format', 'json,md'])).toBe(0);
      expect(await main(['geo', server.url + '/', '--allow-private', '--delay', '0', '--out', ws])).toBe(0);
      expect(await main(['report', 'latest', '--out', ws, '--format', 'html'])).toBe(0);
      expect(await main(['runs', '--out', ws])).toBe(0);
      expect(await main(['rules', 'show', 'canonical.in-body'])).toBe(0);
      expect(await main(['rules', 'list', '--category', 'geo'])).toBe(0);
      expect(await main(['rules', 'show', 'nope'])).toBe(2);
      expect(await main(['audit', path.resolve('test/fixtures/repos/laravel'), '--out', ws, '-q'])).toBe(0);
      expect(await main(['audit', path.resolve('test/fixtures/repos/laravel'), '--out', ws, '-q', '--fail-on', 'high'])).toBe(1);
      expect(await main(['audit', path.resolve('test/fixtures/repos/laravel'), '--fail-on', 'info', '--out', ws, '-q'])).toBe(2);
      const printed = log.mock.calls.flat().join('\n');
      expect(printed).toContain('Crawler access');
      expect(printed).toContain('Sources:');
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });
});
