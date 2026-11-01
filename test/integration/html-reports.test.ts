import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditWebsite, type AuditReport } from '../../src/analyze/audit.js';
import { diffReports } from '../../src/commands/monitor.js';
import { analyzeEcosystem, type SiteSnapshot } from '../../src/commands/ecosystem.js';
import { renderEcosystemHtml, renderHtml, renderMonitorHtml, templateView } from '../../src/report/html.js';
import { loadKnowledge } from '../../src/rules/engine.js';
import { DEFAULT_POLICY } from '../../src/net/ssrf.js';
import { page, startServer, type Route } from '../helpers/server.js';

const EVIL = '</script><img src=x onerror=alert(1)>';
const kb = loadKnowledge();
let before: AuditReport;
let after: AuditReport;
let ws: string;

beforeAll(async () => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-html-'));
  const body = (t: string) => `<main><p>${(t + ' kitchen tools and equipment for cafes. ').repeat(20)}</p></main>`;
  const routes: Record<string, Route> = {
    '/': { body: page({ title: 'Home ' + EVIL, body: '<a href="/blog/a">a</a><a href="/blog/b">b</a><a href="/blog/c">c</a><a href="/blog/d">d</a><a href="/blog/e">e</a>' + body('home') }) },
    ...Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((x) => [`/blog/${x}`, { body: page({ title: undefined, body: body('post ' + x) }) }])),
  };
  const s = await startServer(routes);
  const opts = { workspace: ws, crawl: { policy: { ...DEFAULT_POLICY, allowPrivate: true }, delayMs: 0, useSitemaps: false }, probes: false };
  before = (await auditWebsite(s.url + '/', opts)).report;
  routes['/blog/a'] = { body: page({ title: 'Post A', body: body('post a') }) };
  after = (await auditWebsite(s.url + '/', opts)).report;
  await s.close();
});
afterAll(() => fs.rmSync(ws, { recursive: true, force: true }));

const ecoSite = (host: string, name: string): SiteSnapshot => ({
  host, url: `https://${host}/`, outbound: {}, siteNames: [name], orgNames: [name], parents: [], children: [], terms: [],
  report: { target: `https://${host}/`, crawl: { crawled: 3 }, scores: { overall: 80 }, inventory: { languages: { en: 3 }, hreflangLanguages: [], businessModel: { label: 'SaaS' }, offerings: [] }, findings: [] } as unknown as AuditReport,
});

describe('HTML reports', () => {
  it('groups issues by URL template', () => {
    const t = templateView(before);
    const blog = t.find((x) => x.pattern === '/blog/*');
    expect(blog?.issues.map((i) => i.ruleId)).toContain('title.missing');
    expect(blog?.pages).toBe(5);
  });

  it('keeps hostile content inert in audit, monitor and ecosystem pages', () => {
    const pages = [
      renderHtml(before, kb),
      renderMonitorHtml(diffReports(before, after, before.runId)),
      renderEcosystemHtml(analyzeEcosystem([ecoSite('a.example', EVIL), ecoSite('b.example', 'B')])),
    ];
    for (const html of pages) {
      expect(html).not.toContain(EVIL);
      expect(html).not.toMatch(/<img src=x/);
      expect(html).toContain("default-src 'none'");
      expect(html).not.toMatch(/innerHTML/);
    }
  });
});

/** Executes the pages in Chromium where Playwright is installed (local dev, CI render job). */
async function chromium(): Promise<{ launch: () => Promise<{ newPage: () => Promise<unknown>; close: () => Promise<void> }> } | null> {
  try {
    const name = 'playwright';
    const pw = (await import(name)) as { chromium: { executablePath: () => string; launch: () => Promise<never> } };
    return fs.existsSync(pw.chromium.executablePath()) ? pw.chromium : null;
  } catch {
    return null;
  }
}
const browserType = await chromium();

describe.runIf(browserType)('HTML reports in a browser', () => {
  it('render without script errors and show charts, templates, before/after and the link matrix', async () => {
    const browser = await browserType!.launch();
    try {
      const check = async (html: string, selectorText: Array<[string, RegExp]>) => {
        const p = (await browser.newPage()) as {
          on: (e: string, f: (x: { message?: string; type?: () => string; text?: () => string }) => void) => void;
          setContent: (h: string) => Promise<void>;
          locator: (s: string) => { allInnerTexts: () => Promise<string[]> };
          close: () => Promise<void>;
        };
        const errors: string[] = [];
        p.on('pageerror', (e) => errors.push(String(e.message)));
        p.on('console', (m) => { if (m.type?.() === 'error') errors.push(m.text?.() ?? ''); });
        await p.setContent(html);
        for (const [sel, re] of selectorText) expect((await p.locator(sel).allInnerTexts()).join('\n')).toMatch(re);
        expect(errors).toEqual([]);
        await p.close();
      };
      await check(renderHtml(before, kb, { diff: diffReports(before, after, before.runId) }), [['#p-overview', /Issues by severity/], ['#p-issues', /\/blog\/\*/], ['#kicker', /SEO action center/i], ['#tabs', /Changes/], ['#controls', /Türkçe|TR/]]);
      await check(renderMonitorHtml(diffReports(before, after, before.runId)), [['#p-changes', /Resolved|Worse/], ['#p-changes', /Improved/]]);
      await check(renderEcosystemHtml(analyzeEcosystem([ecoSite('a.example', EVIL), ecoSite('b.example', 'B')])), [['#p-overview', /from \\ to/], ['#p-overview', /Health score/]]);
    } finally {
      await browser.close();
    }
  });
});
