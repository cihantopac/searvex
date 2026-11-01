import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
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
      '/e': { body: shell('<title>E</title>', "setInterval(function(){fetch('/poll').catch(function(){})},200);document.getElementById('root').innerHTML='<h1>E</h1><p>polling</p><a href=\"/f\">F</a><a href=\"/g\">G</a>';") },
      '/poll': { body: 'ok', delayMs: 150 },
      // Locale-adaptive page: switches language and canonical to /en/ when the browser language is English.
      '/f': { body: `<!doctype html><html lang="tr"><head><title>Fiyatlar</title><link rel="canonical" href="__B__/f"></head><body><h1>Fiyatlar</h1>${text(80)}<script>if(navigator.language.indexOf('en')===0){document.documentElement.lang='en';document.title='Pricing';document.querySelector('link[rel=canonical]').href='__B__/en/f';}</script></body></html>` },
      // Inertia-like duplicate title in raw HTML that the head manager removes after hydration.
      '/g': { body: `<!doctype html><html lang="en"><head><title>ACME</title><title data-inertia>G page</title></head><body><h1>G</h1>${text(80)}<script>document.querySelector('title:not([data-inertia])').remove()</script></body></html>` },
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

  it('detects client-side locale switching (browser locale en-US) — real-world case', () => {
    const f = finding('lang.locale-adaptive')!;
    const e = f.evidence.find((x) => x.url!.endsWith('/f'))!;
    expect(e.observed).toMatch(/lang tr → en/);
    expect(e.observed).toMatch(/canonical .*\/f → .*\/en\/f/);
  });

  it('still reports duplicate titles that exist only in the raw HTML', () => {
    const f = finding('title.multiple')!;
    expect(f.evidence.find((x) => x.url!.endsWith('/g'))!.observed).toMatch(/raw HTML only/);
  });

  it('renders pages with endless network activity within the time budget', () => {
    const e = report.inventory.pages.find((p) => p.url.endsWith('/e'));
    expect(e?.title).toBe('E');
  });
});


/**
 * Isolation: a page on the allowed origin tries to reach a forbidden server through paths that request
 * interception alone does not see — redirect hops, WebSockets, popups. The forbidden server counts every
 * request and upgrade it receives; the count must stay zero.
 */
describe.runIf(available)('render isolation (forbidden target via redirects, WebSockets, popups)', () => {
  let site: TestServer;
  let forbidden: http.Server;
  let forbiddenHits: string[];
  let titles: Record<string, string>;
  let stats: Awaited<ReturnType<typeof createRenderer>>['stats'];
  let fport: number;

  beforeAll(async () => {
    forbiddenHits = [];
    forbidden = http.createServer((req, res) => {
      forbiddenHits.push(`http ${req.url}`);
      res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }).end('SECRET');
    });
    forbidden.on('upgrade', (req, socket) => {
      forbiddenHits.push(`upgrade ${req.url}`);
      socket.destroy();
    });
    await new Promise<void>((r) => forbidden.listen(0, '127.0.0.1', r));
    fport = (forbidden.address() as AddressInfo).port;
    const target = `http://127.0.0.1:${fport}`;
    const routes: Record<string, Route> = {
      '/redir': { redirect: `${target}/secret`, status: 302 },
      '/fetch-redirect': { body: shell('<title>start</title>', "fetch('/redir').then(function(r){return r.text()}).then(function(t){document.title=t}).catch(function(){document.title='blocked'})") },
      '/iframe-redirect': { body: '<!doctype html><html><head><title>iframe</title></head><body><iframe src="/redir"></iframe></body></html>' },
      '/websocket': { body: shell('<title>ws</title>', `var w=new WebSocket('ws://127.0.0.1:${fport}/socket');w.onopen=function(){document.title='open'};w.onerror=function(){document.title='ws-blocked'};`) },
      '/popup': { body: shell('<title>popup</title>', `window.open('${target}/popup')`) },
      '/navigate': { body: shell('<title>nav</title>', `setTimeout(function(){location.href='${target}/navigated'},10)`) },
      // Positive control: a same-origin redirect must still work through the proxy.
      '/redir-ok': { redirect: '/ok', status: 302 },
      '/ok': { body: 'OK', headers: { 'content-type': 'text/plain' } },
      '/fetch-allowed': { body: shell('<title>start</title>', "fetch('/redir-ok').then(function(r){return r.text()}).then(function(t){document.title=t}).catch(function(){document.title='failed'})") },
    };
    site = await startServer(routes);
    const isolated = { ...DEFAULT_POLICY, allowPrivate: true, ports: [site.port] };
    const renderer = await createRenderer(isolated, 15000);
    titles = {};
    try {
      for (const p of Object.keys(routes).filter((k) => !['/redir', '/redir-ok', '/ok'].includes(k))) {
        const { html } = await renderer.render(site.url + p);
        titles[p] = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
      }
      await new Promise((r) => setTimeout(r, 500));
      stats = renderer.stats;
    } finally {
      await renderer.close();
    }
  }, 120000);

  afterAll(async () => {
    await site.close();
    await new Promise<void>((r) => forbidden.close(() => r()));
  });

  it('never lets the forbidden server receive a request or WebSocket upgrade', () => {
    expect(forbiddenHits).toEqual([]);
  });

  it('page scripts do not read data through a redirect to a forbidden target', () => {
    expect(titles['/fetch-redirect']).not.toBe('SECRET');
  });

  it('still follows allowed redirects, and records the blocked target', () => {
    expect(titles['/fetch-allowed']).toBe('OK');
    expect(stats.proxy.blockedTargets).toContain(`127.0.0.1:${fport}`);
    expect(stats.proxy.requests).toBeGreaterThan(0);
  });
});

/**
 * Resource exhaustion: scripts that never yield (busy loop) or allocate without bound must not stall the
 * audit. Each page has a hard deadline, and the renderer keeps working for the next page.
 */
describe.runIf(available)('render resource limits (busy loop, memory growth)', () => {
  let site: TestServer;
  const results: Record<string, { html: string; error?: string; ms: number }> = {};
  let stats: Awaited<ReturnType<typeof createRenderer>>['stats'];

  beforeAll(async () => {
    site = await startServer({
      '/busy': { body: shell('<title>busy</title>', 'setTimeout(function(){for(;;){}},10)') },
      '/memory': { body: shell('<title>memory</title>', 'var a=[];setTimeout(function(){for(;;){a.push(new Array(1e6).fill(1))}},10)') },
      '/after': { body: shell('<title>after</title>', "document.title='after-ok'") },
    });
    const renderer = await createRenderer(policy, 3000);
    try {
      for (const p of ['/busy', '/memory', '/after']) {
        const t = Date.now();
        const r = await renderer.render(site.url + p);
        results[p] = { ...r, ms: Date.now() - t };
      }
      stats = renderer.stats;
    } finally {
      await renderer.close();
    }
  }, 120000);

  afterAll(() => site.close());

  it('stops a page whose scripts block the main thread at the hard deadline', () => {
    expect(results['/busy']!.error).toMatch(/exceeded/);
    expect(results['/busy']!.ms).toBeLessThan(3000 + 5000 + 5000 + 6000);
    expect(stats.deadlineExceeded).toBeGreaterThanOrEqual(1);
  });

  it('bounds a page that allocates memory without limit', () => {
    expect(results['/memory']!.html).not.toContain('memory-ok');
    expect(results['/memory']!.ms).toBeLessThan(3000 + 5000 + 5000 + 6000);
  });

  it('renders the next page normally afterwards', () => {
    expect(results['/after']!.error).toBeUndefined();
    expect(results['/after']!.html).toContain('after-ok');
  });
});
