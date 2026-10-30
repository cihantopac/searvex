import { describe, expect, it } from 'vitest';
import { checkExternalLinks } from '../../src/analyze/external-links.js';
import { buildContext } from '../../src/analyze/context.js';
import { crawl } from '../../src/crawl/crawler.js';
import { DEFAULT_POLICY } from '../../src/net/ssrf.js';
import { FindingSink, loadKnowledge } from '../../src/rules/engine.js';
import { failingMetrics, parseCruxRecord } from '../../src/integrations/crux.js';
import { diffReports } from '../../src/commands/monitor.js';
import { auditWebsite } from '../../src/analyze/audit.js';
import { page, startServer, text, type Route } from '../helpers/server.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const policy = { ...DEFAULT_POLICY, allowPrivate: true };

describe('external link checking', () => {
  it('reports dead outbound links, honours external robots.txt, ignores bot-protection statuses', async () => {
    const ext = await startServer({
      '/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /private' },
      '/ok': { body: 'ok' },
      '/forbidden': { status: 403, body: 'no bots' },
      '/private/x': { body: 'never fetched' },
    });
    const extBase = `http://localhost:${ext.port}`; // different hostname → external
    const site = await startServer({
      '/': { body: page({ title: 'Home', body: `<a href="${extBase}/ok">ok</a><a href="${extBase}/dead">dead</a><a href="${extBase}/forbidden">f</a><a href="${extBase}/private/x">p</a>${text(100)}` }) },
    });
    try {
      const result = await crawl(site.url + '/', { policy, delayMs: 0, useSitemaps: false });
      const sink = new FindingSink(loadKnowledge());
      const r = await checkExternalLinks(buildContext(result), sink, { policy });
      const f = sink.findings().find((x) => x.ruleId === 'links.broken-external');
      expect(f?.count).toBe(1);
      expect(f?.evidence[0]?.url).toContain('/dead');
      expect(r.skippedByRobots).toBe(1);
      expect(ext.hits.get('/private/x')).toBeUndefined();
    } finally {
      await ext.close();
      await site.close();
    }
  });
});

describe('CrUX parsing', () => {
  it('reads p75 values and flags metrics above Google thresholds', () => {
    const m = parseCruxRecord(
      { record: { metrics: { largest_contentful_paint: { percentiles: { p75: 3100 } }, interaction_to_next_paint: { percentiles: { p75: 150 } }, cumulative_layout_shift: { percentiles: { p75: '0.25' } } } } },
      'PHONE',
    );
    expect(m).toMatchObject({ lcpMs: 3100, inpMs: 150, cls: 0.25 });
    expect(failingMetrics(m)).toEqual(['LCP 3100 ms', 'CLS 0.25']);
  });
});

describe('monitor diff', () => {
  it('detects regressions and resolved issues between runs', async () => {
    const routes: Record<string, Route> = { '/': { body: page({ title: 'Home', head: '<meta name="description" content="d"><link rel="canonical" href="/">', body: `<h1>Home</h1>${text(150)}` }) } };
    const s = await startServer(routes);
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-mon-'));
    try {
      const a = await auditWebsite(s.url + '/', { workspace: ws, crawl: { policy, delayMs: 0 }, probes: false });
      routes['/'] = { body: page({ title: undefined, head: '<meta name="robots" content="noindex">', body: '<h1>Home</h1>' }) };
      const b = await auditWebsite(s.url + '/', { workspace: ws, crawl: { policy, delayMs: 0 }, probes: false });
      const d = diffReports(a.report, b.report, a.report.runId);
      expect(d.newFindings.map((x) => x.ruleId)).toContain('title.missing');
      expect(d.regression).toBe(true);
      const back = diffReports(b.report, a.report, b.report.runId);
      expect(back.resolved.map((x) => x.ruleId)).toContain('title.missing');
    } finally {
      await s.close();
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('real-world regression fixtures (anonymised)', () => {
  it('classifies a SaaS product with offers as software (not e-commerce), extracts offerings and brand relations, and avoids known false positives', async () => {
    const nav = '<header><nav><a href="/">Home</a> <a href="/help">Help</a> <a href="/pricing">Pricing</a> <a href="/login">Log in</a> <a href="/register">Sign up</a> <a href="/cdn-cgi/l/email-protection#abc">[email protected]</a></nav></header>';
    const footer = `<footer>${'Footer links about the company, legal pages, social profiles and newsletter signup. '.repeat(12)}</footer>`;
    const ld = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"ACMECHAT","url":"https://chat.example/","parentOrganization":{"@type":"Organization","name":"ACMEGROUP","url":"https://group.example/"}}</script><script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"ACMECHAT"}</script><script type="application/ld+json">{"@context":"https://schema.org","@type":"SoftwareApplication","name":"ACMECHAT","applicationCategory":"CommunicationApplication","offers":{"@type":"Offer","price":"0","priceCurrency":"USD"}}</script>`;
    const help = (t: string, body: string) => page({ title: `${t} — ACMECHAT`, head: `<meta name="description" content="${t}"><link rel="canonical" href="__BASE__${t === 'Help' ? '/help' : '/help/' + t.toLowerCase()}">${ld}`, body: `${nav}<main><h1>${t}</h1><p>${body}</p></main>${footer}` });
    const routes: Record<string, Route> = {};
    const s = await startServer(routes);
    const B = s.url;
    const fill = (h: string) => h.replace(/__BASE__/g, B);
    Object.assign(routes, {
      '/': { body: fill(page({ title: 'ACMECHAT — team chat', head: `<link rel="canonical" href="${B}/"><link rel="alternate" hreflang="en" href="${B}/"><link rel="alternate" hreflang="x-default" href="${B}/">${ld}`, body: `${nav}<main><h1>Team chat</h1>${text(150)}<a href="/blog?">Blog</a><a href="/blog?tag=x">Tag</a></main>${footer}` })) },
      '/help': { body: fill(help('Help', 'Start here to learn the basics of channels and messages.')) },
      '/help/invites': { body: fill(help('Invites', 'Invite a teammate by sharing a link from the members screen.')) },
      '/help/reactions': { body: fill(help('Reactions', 'React to any message with an emoji to acknowledge it quickly.')) },
      '/pricing': { body: fill(page({ title: 'Pricing — ACMECHAT', head: `<link rel="canonical" href="${B}/pricing">`, body: `${nav}<main><h1>Pricing</h1>${text(120)}</main>` })) },
      '/blog': { body: fill(page({ title: 'Blog', head: `<link rel="canonical" href="${B}/blog"><link rel="alternate" hreflang="en" href="${B}/blog"><link rel="alternate" hreflang="x-default" href="${B}/blog">`, body: `${nav}<main><h1>Blog</h1><p>${'Release notes, product updates and stories from teams that moved their conversations to channels. '.repeat(8)}</p></main>` })) },
      // Filter variant canonicalised to /blog that points hreflang at /blog: Google ignores it, so must Searvex.
      '/blog?tag=x': { body: fill(page({ title: 'Blog', head: `<link rel="canonical" href="${B}/blog"><link rel="alternate" hreflang="en" href="${B}/blog">`, body: `${nav}<main>${text(120)}</main>` })) },
      '/cdn-cgi/l/email-protection': { status: 404, body: 'nope' },
      '/login': { body: page({ title: 'Log in — ACMECHAT', head: '<meta name="robots" content="noindex">', body: '<form></form>' }) },
      '/register': { body: page({ title: 'Sign up — ACMECHAT', head: '<meta name="robots" content="noindex">', body: '<form></form>' }) },
    });
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-saas-'));
    try {
      const { report } = await auditWebsite(B + '/', { workspace: ws, crawl: { policy, delayMs: 0 }, probes: false });
      const ids = report.findings.map((f) => f.ruleId);
      expect(report.inventory.businessModel.label).toBe('SaaS / software product');
      expect(report.inventory.offerings?.[0]).toMatchObject({ name: 'ACMECHAT', kind: 'SoftwareApplication', price: '0', currency: 'USD' });
      expect(report.inventory.relations).toContainEqual(expect.objectContaining({ from: 'ACMECHAT', relation: 'parentOrganization', to: 'ACMEGROUP' }));
      expect(ids, JSON.stringify(report.findings.find((f) => f.ruleId === 'content.near-duplicate')?.evidence)).not.toContain('content.near-duplicate'); // short help pages sharing a long footer
      expect(ids).not.toContain('geo.entity-inconsistent'); // product org naming its parent is fine
      expect(ids, JSON.stringify(report.findings.find((f) => f.ruleId === 'links.broken-internal')?.evidence)).not.toContain('links.broken-internal'); // Cloudflare /cdn-cgi/ endpoint ignored
      expect(ids).not.toContain('hreflang.missing-return'); // non-canonical variant ignored
      expect(s.hits.get('/cdn-cgi/l/email-protection')).toBeUndefined();
      expect(report.inventory.pages.filter((p) => p.url.endsWith('/blog?')).length).toBe(0); // "/blog?" == "/blog"
    } finally {
      await s.close();
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('ignores template blocks inside <main> for near-duplicates but still finds real duplicates', async () => {
    const sidebar = `<ul class="categories">${['Getting started', 'Rooms', 'Joining', 'Audio and video', 'Guest book', 'Chat', 'Accounts', 'Billing'].map((c) => `<li><a href="/help">${c}</a> 2 topics: open a room, share the link, approve guests</li>`).join('')}</ul>`;
    const article = (t: string, body: string) => page({ title: t, head: '', body: `<main>${sidebar}<article><h1>${t}</h1><p>${body}</p></article></main>` });
    // A realistic duplicated article: ~150 distinct words (not a repeated sentence).
    const long = Array.from({ length: 150 }, (_, i) => `step${i} ${['open', 'share', 'copy', 'invite', 'approve', 'join'][i % 6]}`).join(' ');
    const routes: Record<string, Route> = {
      '/': { body: page({ title: 'Help', body: `<main>${sidebar}${['a', 'b', 'c', 'd', 'e', 'f'].map((x) => `<a href="/help/${x}">${x}</a>`).join(' ')}</main>` }) },
      '/help/a': { body: article('Camera not working', 'Check browser permissions for the camera and reload the page; close other apps that use the camera.') },
      '/help/b': { body: article('Screen sharing', 'Use the share button in the toolbar and choose a window or the entire screen to present.') },
      '/help/c': { body: article('Guest approval', 'Guests wait in the lobby until the host approves them from the participants panel.') },
      '/help/d': { body: article('Closed rooms', 'If a room is closed the link shows a notice; ask the host to reopen the room.') },
      '/help/e': { body: article('Share a room', long) },
      '/help/f': { body: article('Sharing rooms', long) },
    };
    const s = await startServer(routes);
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-tmpl-'));
    try {
      const { report } = await auditWebsite(s.url + '/', { workspace: ws, crawl: { policy, delayMs: 0, useSitemaps: false }, probes: false });
      const nd = report.findings.find((f) => f.ruleId === 'content.near-duplicate' || f.ruleId === 'duplicate.content');
      const pairs = (nd?.evidence ?? []).map((e) => `${new URL(e.url!).pathname} ${e.observed}`);
      expect(pairs.length, JSON.stringify({ pairs, ids: report.findings.map((f) => f.ruleId), pages: report.inventory.pages.map((p) => [p.url, p.words, p.indexable]) })).toBe(1);
      expect(pairs[0]).toMatch(/\/help\/e.*\/help\/f/);
      // The hub page is mostly links: not reported as thin content.
      expect(report.findings.find((f) => f.ruleId === 'content.low-text')?.evidence.map((e) => new URL(e.url!).pathname) ?? []).not.toContain('/');
    } finally {
      await s.close();
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('ignores section template headings for cannibalisation but keeps real topic collisions', async () => {
    const help = (h2: string) => page({ title: `${h2} - Help centre`, body: `<main><h1>Help centre</h1><h2>${h2}</h2><p>${h2} explained in detail for every plan and workspace type.</p></main>` });
    const routes: Record<string, Route> = {
      '/': { body: page({ title: 'Home', body: '<a href="/help/a">a</a><a href="/help/b">b</a><a href="/help/c">c</a><a href="/help/d">d</a><a href="/blog/migrate">m</a><a href="/guides/migrate">g</a>' }) },
      '/help/a': { body: help('Inviting teammates') },
      '/help/b': { body: help('Deleting messages') },
      '/help/c': { body: help('Exporting history') },
      '/help/d': { body: help('Pinning channels') },
      '/blog/migrate': { body: page({ title: 'Migrate old mailboxes', body: '<main><h1>Migrate old mailboxes</h1></main>' }) },
      '/guides/migrate': { body: page({ title: 'Migrate mailboxes guide', body: '<main><h1>Old mailboxes migration</h1></main>' }) },
    };
    const s = await startServer(routes);
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-cannibal-'));
    try {
      const { report } = await auditWebsite(s.url + '/', { workspace: ws, crawl: { policy, delayMs: 0, useSitemaps: false }, probes: false });
      const c = report.content.cannibalization;
      expect(c.some((x) => x.pages.some((u) => u.includes('/help/')))).toBe(false);
      expect(c.some((x) => x.pages.some((u) => u.endsWith('/blog/migrate')) && x.pages.some((u) => u.endsWith('/guides/migrate')))).toBe(true);
    } finally {
      await s.close();
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('explains duplicate titles produced by Inertia SSR', async () => {
    const s = await startServer({ '/': { body: '<!doctype html><html lang="en"><head><title>ACME</title><title data-inertia="">Home</title><meta name="viewport" content="width=device-width"></head><body><div id="app" data-page="{}"><h1>Home</h1></div></body></html>' } });
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-inertia-'));
    try {
      const { report } = await auditWebsite(s.url + '/', { workspace: ws, crawl: { policy, delayMs: 0 }, probes: false });
      const f = report.findings.find((x) => x.ruleId === 'title.multiple')!;
      expect(f.evidence[0]!.observed).toContain('<title inertia>');
    } finally {
      await s.close();
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('internal-link opportunities', () => {
  it('suggests links between related pages that do not link to each other, from the stronger page', async () => {
    const espresso = (extra: string) => `<main><p>${('Espresso extraction depends on grind size, dose, water temperature and tamping pressure; ' + extra + ' ').repeat(6)}</p></main>`;
    const routes: Record<string, Route> = {
      '/': { body: page({ title: 'Home', body: '<a href="/grind">Grind</a><a href="/dose">Dose</a><a href="/tamping">Tamping</a><a href="/shipping">Shipping</a>' }) },
      '/grind': { body: page({ title: 'Grind size guide', body: `<a href="/dose">dose</a>${espresso('burr grinders matter for espresso grind consistency')}` }) },
      '/dose': { body: page({ title: 'Espresso dose', body: `<a href="/grind">grind</a>${espresso('a basket dose between eighteen and twenty grams')}` }) },
      '/tamping': { body: page({ title: 'Tamping pressure', body: espresso('tamping evenly prevents channeling during extraction') }) },
      '/shipping': { body: page({ title: 'Shipping', body: `<main><p>${'Orders ship within two business days by courier with tracking and insurance included. '.repeat(6)}</p></main>` }) },
    };
    const s = await startServer(routes);
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-links-'));
    try {
      const { report } = await auditWebsite(s.url + '/', { workspace: ws, crawl: { policy, delayMs: 0, useSitemaps: false }, probes: false });
      const ops = (report.content.linkOpportunities ?? []).map((o) => `${new URL(o.from).pathname}->${new URL(o.to).pathname}`);
      expect(ops).toEqual(expect.arrayContaining(['/grind->/tamping', '/dose->/tamping']));
      expect(ops.some((o) => o.includes('/shipping'))).toBe(false);
      expect(ops).not.toContain('/grind->/dose'); // already linked
      expect(report.findings.find((f) => f.ruleId === 'links.internal-opportunity')?.confidence).toBe('heuristic');
    } finally {
      await s.close();
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('faceted navigation and pagination', () => {
  it('detects filter-parameter explosions and page-2 canonicals to page 1, but not plain pagination', async () => {
    const colors = ['red', 'blue', 'green', 'black', 'white'];
    const sizes = ['s', 'm', 'l', 'xl', 'xxl', 'xs'];
    const filters = colors.flatMap((c) => sizes.map((z) => `<a href="/shoes?color=${c}&size=${z}">${c} ${z}</a>`)).join(' ');
    const routes: Record<string, Route> = {
      '/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /*?*size=xl\n' },
      '/': { body: page({ title: 'Shop', body: `<a href="/shoes">Shoes</a><a href="/blog?page=2">Blog 2</a><a href="/blog?page=3">Blog 3</a>${text(60)}` }) },
      '/shoes': { body: page({ title: 'Shoes', head: '<link rel="canonical" href="/shoes">', body: `${filters}<a href="/shoes?page=2">2</a>${text(60)}` }) },
      '/blog': { body: page({ title: 'Blog', body: text(60) }) },
    };
    const s = await startServer((routes as unknown) as Record<string, Route>);
    const B = s.url;
    Object.assign(routes, {
      '/shoes?page=2': { body: page({ title: 'Shoes 2', head: `<link rel="canonical" href="${B}/shoes">`, body: text(60) }) },
      '/blog?page=2': { body: page({ title: 'Blog 2', head: `<link rel="canonical" href="${B}/blog">`, body: text(60) }) },
      '/blog?page=3': { body: page({ title: 'Blog 3', head: `<link rel="canonical" href="${B}/blog?page=3">`, body: text(60) }) },
    });
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-facet-'));
    try {
      const { report } = await auditWebsite(B + '/', { workspace: ws, crawl: { policy, delayMs: 0, useSitemaps: false, maxPages: 60 }, probes: false });
      const facet = report.findings.find((f) => f.ruleId === 'crawl.facet-explosion')!;
      expect(facet.evidence.map((e) => new URL(e.url!).pathname)).toEqual(['/shoes']);
      expect(facet.evidence[0]!.observed).toMatch(/30 parameter variants/);
      expect(facet.evidence[0]!.observed).toMatch(/color \(30\), size \(30\)/);
      expect(facet.evidence[0]!.observed).toMatch(/[1-9]\d* robots-blocked/);
      const pag = report.findings.find((f) => f.ruleId === 'pagination.canonical-to-first')!;
      expect(pag.evidence.map((e) => new URL(e.url!).pathname + new URL(e.url!).search).sort()).toEqual(['/blog?page=2', '/shoes?page=2']);
    } finally {
      await s.close();
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('server-side locale adaptation', () => {
  it('flags a start URL whose content changes with Accept-Language (Googlebot sends none)', async () => {
    const s = await startServer({
      '/': (req) => {
        const al = String(req.headers['accept-language'] ?? '');
        const de = al.startsWith('de');
        return { body: page({ lang: de ? 'de' : 'en', title: de ? 'Startseite' : 'Home', body: `<h1>${de ? 'Willkommen' : 'Welcome'}</h1>${text(80)}` }) };
      },
    });
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-locale-'));
    try {
      const { report } = await auditWebsite(s.url + '/', { workspace: ws, crawl: { policy, delayMs: 0, useSitemaps: false } });
      const f = report.findings.find((x) => x.ruleId === 'lang.locale-adaptive');
      expect(f?.evidence[0]!.observed).toMatch(/de-DE: lang=de/);
      // A non-adaptive site must not be flagged.
      const s2 = await startServer({ '/': { body: page({ title: 'Home', body: text(80) }) } });
      const { report: r2 } = await auditWebsite(s2.url + '/', { workspace: ws, crawl: { policy, delayMs: 0, useSitemaps: false } });
      expect(r2.findings.map((x) => x.ruleId)).not.toContain('lang.locale-adaptive');
      await s2.close();
    } finally {
      await s.close();
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('start URL errors', () => {
  it('reports a critical finding when the start URL returns 404 (real-world: a removed demo site)', async () => {
    const s = await startServer({});
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-404-'));
    try {
      const { report } = await auditWebsite(s.url + '/', { workspace: ws, crawl: { policy, delayMs: 0 }, probes: false });
      const f = report.findings.find((x) => x.ruleId === 'http.start-url-error');
      expect(f?.severity).toBe('critical');
      expect(report.scores.overall).toBeLessThanOrEqual(75);
    } finally {
      await s.close();
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('crawler resilience', () => {
  it('resumes an interrupted crawl from its checkpoint without refetching', async () => {
    const routes: Record<string, Route> = {};
    for (let i = 0; i < 30; i++) routes[`/p${i}`] = { body: page({ title: `P${i}`, body: `<a href="/p${i + 1}">next</a>${text(60)}` }) };
    routes['/'] = { body: page({ title: 'Home', body: '<a href="/p0">start</a>' }) };
    const s = await startServer(routes);
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-resume-'));
    try {
      const { RunStore } = await import('../../src/crawl/store.js');
      const store = new RunStore(ws, 'run-resume');
      const first = await crawl(s.url + '/', { policy, delayMs: 0, maxPages: 10, maxDepth: 100, useSitemaps: false, checkpointEvery: 1 }, store);
      expect(first.truncated).toBe(true);
      const hitsAfterFirst = s.hits.get('/p0');
      const second = await crawl(s.url + '/', { policy, delayMs: 0, maxPages: 40, maxDepth: 100, useSitemaps: false }, store);
      expect(second.pages.length).toBe(32); // home + p0..p29 + p30 (404)
      expect(second.truncated).toBe(false);
      expect(s.hits.get('/p0')).toBe(hitsAfterFirst); // not refetched
      expect(new Set(second.pages.map((p) => p.url)).size).toBe(second.pages.length);
    } finally {
      await s.close();
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('slows down on 429 with Retry-After and treats robots 5xx as full disallow', async () => {
    const s = await startServer({ '/robots.txt': { status: 503, body: '' }, '/': { body: page({ title: 'x' }) } });
    try {
      const r = await crawl(s.url + '/', { policy, delayMs: 0, useSitemaps: false });
      expect(r.robots.state).toBe('unreachable');
      expect(r.pages.every((p) => p.blockedByRobots)).toBe(true);
      expect(s.hits.get('/')).toBeUndefined();
    } finally {
      await s.close();
    }
  });
});
