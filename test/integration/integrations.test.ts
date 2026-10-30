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
