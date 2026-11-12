import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { labSummary, parsePsi, psiErrorMessage, publiclyMeasurable, queryPsi } from '../../src/integrations/psi.js';
import { labSamples, runLab } from '../../src/analyze/lab.js';
import type { SiteContext } from '../../src/analyze/context.js';
import { psiKey } from '../../src/commands/psi.js';
import { auditWebsite } from '../../src/analyze/audit.js';
import { DEFAULT_POLICY } from '../../src/net/ssrf.js';
import { EXIT, main } from '../../src/cli.js';
import { page, startServer, text, type TestServer } from '../helpers/server.js';

const KEY = 'AIzaTestKey0123456789abcdefghij';
let psi: http.Server;
let site: TestServer;
let cfg: string;
const calls: string[] = [];

/** Lighthouse result as PageSpeed Insights returns it (only the fields Searvex reads). */
const lhr = (score: number, lcp: number) => ({
  id: 'x',
  lighthouseResult: {
    finalDisplayedUrl: 'https://shop.example.com/final',
    lighthouseVersion: '12.8.0',
    fetchTime: '2026-11-12T10:00:00.000Z',
    categories: { performance: { score } },
    audits: {
      'largest-contentful-paint': { numericValue: lcp },
      'first-contentful-paint': { numericValue: 1234.4 },
      'total-blocking-time': { numericValue: 812.6 },
      'cumulative-layout-shift': { numericValue: 0.123456 },
      'speed-index': { numericValue: 4000 },
      'server-response-time': { numericValue: 310 },
    },
  },
});

beforeAll(async () => {
  psi = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.searchParams.get('key') !== KEY) return res.writeHead(400).end(JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }));
    const url = u.searchParams.get('url')!;
    calls.push(`${u.searchParams.get('strategy')} ${u.searchParams.get('category')} ${url}`);
    if (url.includes('/broken')) return res.writeHead(200).end(JSON.stringify({ lighthouseResult: { runtimeError: { code: 'FAILED_DOCUMENT_REQUEST', message: 'net::ERR_TIMED_OUT' } } }));
    res.writeHead(200).end(JSON.stringify(url.includes('/blog') ? lhr(0.34, 5200) : lhr(0.93, 1500)));
  });
  await new Promise<void>((r) => psi.listen(0, '127.0.0.1', r));
  process.env['SEARVEX_PSI_API_BASE'] = `http://127.0.0.1:${(psi.address() as AddressInfo).port}/v5`;
  cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-psi-'));
  site = await startServer({ '/': { body: page({ title: 'Home page of the site', body: `<h1>Home</h1>${text(120)}` }) } });
});
afterAll(async () => {
  psi.close();
  await site.close();
  fs.rmSync(cfg, { recursive: true, force: true });
  for (const k of ['SEARVEX_PSI_API_BASE', 'SEARVEX_PSI_API_KEY', 'SEARVEX_CONFIG_DIR']) delete process.env[k];
});

describe('F6: PageSpeed Insights client', () => {
  it('reads the Lighthouse score and lab metrics, mobile and performance only', async () => {
    const r = await queryPsi('https://shop.example.com/', KEY);
    expect(r).toEqual({
      status: 'ok',
      metrics: { url: 'https://shop.example.com/', finalUrl: 'https://shop.example.com/final', strategy: 'mobile', score: 93, lcpMs: 1500, fcpMs: 1234, tbtMs: 813, cls: 0.123, speedIndexMs: 4000, ttfbMs: 310, lighthouseVersion: '12.8.0', fetchTime: '2026-11-12T10:00:00.000Z' },
    });
    expect(calls.at(-1)).toBe('mobile performance https://shop.example.com/');
    expect(labSummary((r as { metrics: Parameters<typeof labSummary>[0] }).metrics)).toBe('score 93, LCP 1.5 s, TBT 813 ms, CLS 0.123, FCP 1.2 s');
  });

  it('a Lighthouse runtime error and an invalid key are errors, without echoing the key', async () => {
    expect(await queryPsi('https://shop.example.com/broken', KEY)).toMatchObject({ status: 'error', message: expect.stringMatching(/^Lighthouse could not measure the page: FAILED_DOCUMENT_REQUEST/) });
    const bad = await queryPsi('https://shop.example.com/', 'AIzaWrongKey000000000000000000');
    expect(bad).toMatchObject({ status: 'error', message: expect.stringMatching(/rejected the PageSpeed Insights API key .*psi auth --force/) });
    expect(JSON.stringify(bad)).not.toContain('AIzaWrongKey');
    expect(psiErrorMessage(403, '{"error":{"status":"PERMISSION_DENIED","message":"API has not been used"}}')).toMatch(/Enable "PageSpeed Insights API"/);
    expect(parsePsi({}, 'https://a.example/', 'mobile')).toMatchObject({ status: 'error' });
  });

  it('only public hosts can be measured (Google fetches the page)', () => {
    expect(publiclyMeasurable('https://shop.example.com/')).toBe(true);
    expect(publiclyMeasurable('https://93.184.215.14/')).toBe(true);
    for (const u of ['http://localhost:3000/', 'http://127.0.0.1:8080/', 'http://10.0.0.5/', 'http://app.test/', 'http://intranet/', 'http://[::1]/']) expect(publiclyMeasurable(u)).toBe(false);
  });
});

describe('F6: lab data in the audit', () => {
  const urls = ['/', '/blog/a', '/blog/b', '/blog/c', '/shop/x', '/shop/y', '/about'].map((p) => 'https://shop.example.com' + p);
  const ctx = {
    crawl: { origin: 'https://shop.example.com' },
    indexable: urls.map((url) => ({ url })),
    homepage: { url: urls[0] },
    reachIn: new Map([[urls[2]!, new Set(['a', 'b'])]]),
  } as unknown as SiteContext;

  it('samples the homepage first, then the largest templates, with their best-linked page', () => {
    expect(labSamples(ctx, 3)).toEqual([
      { template: '/', pages: 1, url: urls[0] },
      { template: '/blog/*', pages: 3, url: urls[2] },
      { template: '/shop/*', pages: 2, url: urls[4] },
    ]);
  });

  it('measures the samples in order and reports a poor template as a lab finding', async () => {
    const emit = vi.fn();
    const lab = await runLab(ctx, { apiKey: KEY, samples: 2 }, { emit } as never);
    expect(lab.samples.map((s) => [s.template, s.score])).toEqual([['/', 93], ['/blog/*', 34]]);
    expect(lab.errors).toEqual([]);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('perf.lab-poor', { url: urls[2], observed: 'Lighthouse lab (mobile): score 34, LCP 5.2 s, TBT 813 ms, CLS 0.123, FCP 1.2 s; template /blog/* (3 pages in this crawl)' });
  });

  it('a local site is not sent to PageSpeed Insights: the report says why', async () => {
    const before = calls.length;
    const ws = fs.mkdtempSync(path.join(cfg, 'ws-'));
    const { report } = await auditWebsite(site.url + '/', { workspace: ws, probes: false, lab: { apiKey: KEY, samples: 3 }, crawl: { policy: { ...DEFAULT_POLICY, allowPrivate: true }, delayMs: 0 } });
    expect(calls.length).toBe(before);
    expect(report.labData).toMatchObject({ samples: [], skipped: expect.stringMatching(/not publicly reachable/) });
    expect(report.limitations.some((l) => /^Lab data \(--lab\) not measured/.test(l))).toBe(true);
    expect(report.findings.some((f) => f.ruleId === 'perf.cwv-poor' || f.ruleId === 'perf.lab-poor')).toBe(false);
  });

  it('--lab without a key is a usage error; the environment key comes first', async () => {
    process.env['SEARVEX_CONFIG_DIR'] = cfg;
    const spies = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(process.stderr, 'write').mockImplementation(() => true)];
    try {
      expect(psiKey()).toBeNull();
      expect(await main(['audit', 'https://shop.example.com/', '--lab'])).toBe(EXIT.usage);
      expect(await main(['audit', 'https://shop.example.com/', '--lab-samples', '3'])).toBe(EXIT.usage);
      process.env['SEARVEX_PSI_API_KEY'] = KEY;
      expect(psiKey()).toEqual({ key: KEY, source: 'SEARVEX_PSI_API_KEY' });
    } finally {
      for (const s of spies) s.mockRestore();
      delete process.env['SEARVEX_PSI_API_KEY'];
    }
  });
});
