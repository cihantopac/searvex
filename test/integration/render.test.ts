import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditWebsite, type AuditReport } from '../../src/analyze/audit.js';
import { createRenderer } from '../../src/crawl/render.js';
import { DEFAULT_POLICY } from '../../src/net/ssrf.js';
import { startServer, text, type Route, type TestServer } from '../helpers/server.js';

/** Runs only where Playwright and Chromium are installed (CI "render" job, local dev). */
async function playwrightAvailable(): Promise<boolean> {
  try {
    const name = 'playwright';
    const pw = (await import(name)) as { chromium: { executablePath: () => string } };
    return fs.existsSync(pw.chromium.executablePath());
  } catch {
    return false;
  }
}
const available = await playwrightAvailable();
const policy = { ...DEFAULT_POLICY, allowPrivate: true };

const shell = (head: string, script: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">${head}</head><body><div id="root"></div><script>${script}</script></body></html>`;

describe.runIf(available)('JavaScript rendering (Playwright)', () => {
  let server: TestServer;
  let report: AuditReport;
  let ws: string;
  const routes: Record<string, Route> = {};

  beforeAll(async () => {
    server = await startServer(routes);
    Object.assign(routes, {
      // SPA: empty shell, content, title and links created by JS.
      '/': {
        body: shell(
          '<title>Loading…</title>',
          `document.title='Acme App — Home';document.getElementById('root').innerHTML='<h1>Home</h1><p>${'Rendered words about the product. '.repeat(40)}</p>'+['/a','/b','/c','/d','/e'].map(function(h){return '<a href="'+h+'">Page '+h+'</a>'}).join(' ');`,
        ),
      },
      // SSR + hydration: same title, canonical and links before and after JS.
      '/a': {
        body: `<!doctype html><html lang="en"><head><title>A</title><link rel="canonical" href="${'__B__'}/a"></head><body><div id="root"><h1>A</h1>${text(120)}<a href="/">Home</a></div><script>document.getElementById('root').setAttribute('data-hydrated','1')</script></body></html>`,
      },
      // JS flips robots to noindex and changes the canonical: raw and rendered disagree.
      '/b': {
        body: `<!doctype html><html lang="en"><head><title>B</title><meta name="robots" content="index,follow"><link rel="canonical" href="__B__/b"></head><body><h1>B</h1>${text(120)}<script>document.querySelector('meta[name=robots]').content='noindex';document.querySelector('link[rel=canonical]').href='__B__/other';</script></body></html>`,
      },
      // Streaming-style metadata in <body> (stays there after rendering).
      '/c': { body: `<!doctype html><html lang="en"><head><title>C</title></head><body><h1>C</h1>${text(120)}<link rel="canonical" href="__B__/c"></body></html>` },
      // Tries to reach cloud metadata and opens a popup; the renderer must block both.
      '/d': {
        body: shell(
          '<title>D</title>',
          "fetch('http://169.254.169.254/latest/meta-data/').then(function(){document.title='LEAK'}).catch(function(){document.title='blocked'});window.open('/e');document.getElementById('root').innerHTML='<h1>D</h1>';",
        ),
      },
      // Never-ending network activity must not hang the renderer.
      '/e': { body: shell('<title>E</title>', "setInterval(function(){fetch('/poll').catch(function(){})},200);document.getElementById('root').innerHTML='<h1>E</h1><p>polling</p>';") },
      '/poll': { body: 'ok', delayMs: 150 },
    });
    for (const k of Object.keys(routes)) {
      const r = routes[k]!;
      if (r.body) r.body = r.body.replace(/__B__/g, server.url);
    }
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-render-'));
    const renderer = await createRenderer(policy, 20000);
    try {
      ({ report } = await auditWebsite(server.url + '/', { workspace: ws, probes: false, crawl: { policy, delayMs: 0, render: renderer.render, useSitemaps: false } }));
    } finally {
      await renderer.close();
    }
  }, 120000);

  afterAll(async () => {
    await server.close();
    fs.rmSync(ws, { recursive: true, force: true });
  });

  const finding = (id: string) => report.findings.find((f) => f.ruleId === id);

  it('discovers links that only exist after rendering (SPA)', () => {
    const urls = report.inventory.pages.map((p) => new URL(p.url).pathname).sort();
    expect(urls).toEqual(expect.arrayContaining(['/', '/a', '/b', '/c', '/d', '/e']));
  });

  it('reports raw-vs-rendered differences for the SPA shell and the JS robots/canonical change', () => {
    const f = finding('index.render-mismatch')!;
    const byUrl = Object.fromEntries(f.evidence.map((e) => [new URL(e.url!).pathname, e.observed]));
    expect(byUrl['/']).toMatch(/title "Loading…" → "Acme App — Home"/);
    expect(byUrl['/']).toMatch(/internal links only exist after rendering/);
    expect(byUrl['/b']).toMatch(/robots "index,follow" → "noindex"/);
    expect(byUrl['/b']).toMatch(/canonical .*\/b → .*\/other/);
  });

  it('does not flag a hydrated SSR page', () => {
    const f = finding('index.render-mismatch')!;
    expect(f.evidence.map((e) => new URL(e.url!).pathname)).not.toContain('/a');
  });

  it('does not report "client-rendered" heuristics when real rendering was done', () => {
    expect(finding('index.client-rendered')).toBeUndefined();
  });

  it('detects canonical placed in <body>', () => {
    expect(finding('canonical.in-body')?.evidence.map((e) => new URL(e.url!).pathname)).toContain('/c');
  });

  it('blocks cloud-metadata requests from page scripts and closes popups', () => {
    const d = report.inventory.pages.find((p) => p.url.endsWith('/d'));
    expect(d?.title).toBe('blocked');
  });

  it('renders pages with endless network activity within the time budget', () => {
    const e = report.inventory.pages.find((p) => p.url.endsWith('/e'));
    expect(e?.title).toBe('E');
  });
});

