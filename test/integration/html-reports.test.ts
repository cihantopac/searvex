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
      await check(renderHtml(before, kb, { diff: diffReports(before, after, before.runId) }), [['#p-overview', /Fix first/], ['#p-overview', /Areas/], ['#p-issues', /\/blog\/\*/], ['#kicker', /Site audit/i], ['#tabs', /Changes/], ['#tabs', /Details/], ['#p-details', /Root causes[\s\S]*By template or file[\s\S]*Issues by severity/], ['#controls', /Türkçe|TR/]]);
      await check(renderMonitorHtml(diffReports(before, after, before.runId)), [['#p-changes', /Resolved|Worse/], ['#p-changes', /Improved/]]);
      await check(renderEcosystemHtml(analyzeEcosystem([ecoSite('a.example', EVIL), ecoSite('b.example', 'B')])), [['#p-overview', /from \\ to/], ['#p-overview', /Health score/]]);
    } finally {
      await browser.close();
    }
  });
});

type RdPage = {
  on: (e: string, f: (x: { message?: string }) => void) => void;
  goto: (u: string) => Promise<void>;
  click: (s: string) => Promise<void>;
  evaluate: <T>(f: string) => Promise<T>;
  locator: (s: string) => { first: () => { click: () => Promise<void> }; innerText: () => Promise<string>; count: () => Promise<number>; getAttribute: (a: string) => Promise<string | null> };
  close: () => Promise<void>;
};

describe('search readiness in the report', () => {
  it('report.json carries readiness for a site without structured data', () => {
    expect(before.readiness).toMatchObject({ ready: false, structuredData: { status: 'low', percent: 0, of: 6 }, contentPages: { status: 'low', pages: 6 }, aiSearch: { status: 'ok', llmsTxt: 'not-checked' } });
  });
});

describe.runIf(browserType)('search readiness strip in a browser', () => {
  it('shows the strip, a readiness-aware verdict and the details, without the accent colour', async () => {
    // A defect-free version of the fixture: only informational rows remain, so the score reads 100.
    const clean: AuditReport = { ...before, findings: before.findings.filter((f) => f.severity === 'info'), scores: { ...before.scores, overall: 100 } };
    const old: AuditReport = { ...clean };
    delete old.readiness;
    const browser = (await browserType!.launch()) as unknown as { newContext: (o: object) => Promise<{ newPage: () => Promise<RdPage>; close: () => Promise<void> }>; close: () => Promise<void> };
    try {
      const ctx = await browser.newContext({ locale: 'en-US' });
      const p = await ctx.newPage();
      const errors: string[] = [];
      p.on('pageerror', (e) => errors.push(String(e.message)));
      const file = path.join(ws, 'readiness.html');
      fs.writeFileSync(file, renderHtml(clean, kb));
      await p.goto('file://' + file);
      expect(await p.locator('#p-overview .herotext h2').innerText()).toBe('No issues found. Not search-ready yet.');
      expect(await p.locator('#p-overview .ready').innerText()).toMatch(/Search readiness[\s\S]*Structured data[\s\S]*0%[\s\S]*Content pages[\s\S]*6[\s\S]*AI search[\s\S]*Open/);
      expect(await p.locator('#p-overview .ready .rd').count()).toBe(3);
      expect(await p.locator('.rd[data-rd="sd"]').getAttribute('aria-label')).toBe('Structured data: 0%, low');
      // No accent (coral) anywhere in the strip, in text, background or borders.
      const colours = await p.evaluate<string[]>(`Array.prototype.concat.apply([],[].map.call(document.querySelectorAll('.ready, .ready *'),function(e){var c=getComputedStyle(e);return[c.color,c.backgroundColor,c.borderTopColor,c.boxShadow]}))`);
      expect(colours.join(' ')).not.toContain('184, 67, 45');
      // One detail panel at a time.
      await p.click('.rd[data-rd="content"]');
      expect(await p.locator('.rd[data-rd="content"]').getAttribute('aria-expanded')).toBe('true');
      expect(await p.locator('#rd-detail').innerText()).toMatch(/6 of 6 indexable pages are content pages[\s\S]*Low below 10/);
      await p.click('.rd[data-rd="sd"]');
      expect(await p.locator('.rd[data-rd="content"]').getAttribute('aria-expanded')).toBe('false');
      expect(await p.locator('#rd-detail').innerText()).toMatch(/0 of 6 content pages have structured data\. Low below 50%\./);
      // "Show rows" opens the issues tab with informational rows on, filtered to structured data.
      await p.locator('#rd-detail .link').first().click();
      expect(await p.locator('#tab-issues').getAttribute('aria-selected')).toBe('true');
      expect(await p.evaluate<boolean>(`document.querySelector('#p-issues label.check input').checked`)).toBe(true);
      expect(await p.locator('#p-issues [data-rule="sd.none"]').count()).toBeGreaterThan(0);
      expect(await p.locator('#p-issues [data-rule^="geo."]').count()).toBe(0);
      // Closing again hides the detail.
      await p.click('#tab-overview');
      await p.click('.rd[data-rd="ai"]');
      expect(await p.locator('#rd-detail').innerText()).toMatch(/llms\.txt: not checked/);
      await p.click('.rd[data-rd="ai"]');
      expect(await p.evaluate<boolean>(`document.getElementById('rd-detail').hidden`)).toBe(true);
      // Turkish.
      await p.locator('.seg button:text-is("TR")').first().click();
      expect(await p.locator('#p-overview .herotext h2').innerText()).toBe('Sorun bulunmadı. Aramaya henüz hazır değil.');
      expect(await p.locator('#p-overview .ready').innerText()).toMatch(/Arama hazırlığı[\s\S]*%0/);
      // A report written before schema 1.3 has no strip and the old verdict.
      fs.writeFileSync(file, renderHtml(old, kb));
      await p.locator('.seg button:text-is("EN")').first().click();
      await p.goto('file://' + file);
      expect(await p.locator('#p-overview .ready').count()).toBe(0);
      expect(await p.locator('#p-overview .herotext h2').innerText()).toBe('No issues found.');
      expect(errors).toEqual([]);
      await ctx.close();
    } finally {
      await browser.close();
    }
  });
});
