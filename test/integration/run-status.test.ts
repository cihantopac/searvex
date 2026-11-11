import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auditWebsite, countAffected, type AuditReport } from '../../src/analyze/audit.js';
import { RunStore } from '../../src/crawl/store.js';
import { DEFAULT_POLICY } from '../../src/net/ssrf.js';
import { EXIT, main, summaryText } from '../../src/cli.js';
import { renderMarkdown } from '../../src/report/markdown.js';
import { page, startServer, text, type Route, type TestServer } from '../helpers/server.js';

const plain = (body: string, status = 200): Route => ({ status, headers: { 'content-type': 'text/plain' }, body });
const html = (title: string): Route => ({ body: page({ title, body: `<h1>${title}</h1>${text(200)}` }) });
const URLSET = (locs: string[]) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((l) => `<url><loc>${l}</loc></url>`).join('')}</urlset>`;

let ws: string;
let cfg: string;
const servers: TestServer[] = [];

/** A site whose sitemap lists `/`, `/a` and `/b`, with the given robots.txt route. */
const site = async (robots: Route, extra: Record<string, Route | ((origin: string) => Route)> = {}): Promise<TestServer> => {
  const table: Record<string, Route> = {};
  const s = await startServer(table);
  servers.push(s);
  const routes: Record<string, Route | ((origin: string) => Route)> = {
    '/robots.txt': robots,
    '/sitemap.xml': (o) => ({ headers: { 'content-type': 'application/xml' }, body: URLSET([`${o}/`, `${o}/a`, `${o}/b`]) }),
    '/': html('Home page of the site'),
    '/a': html('Page A of the site'),
    '/b': html('Page B of the site'),
    ...extra,
  };
  for (const [k, r] of Object.entries(routes)) table[k] = typeof r === 'function' ? r(s.url) : r;
  return s;
};

const audit = async (s: TestServer, o: { preLaunch?: boolean; timeoutMs?: number; probes?: boolean } = {}): Promise<AuditReport> =>
  (await auditWebsite(s.url + '/', { workspace: ws, crawl: { policy: { ...DEFAULT_POLICY, allowPrivate: true }, delayMs: 0, timeoutMs: o.timeoutMs ?? 3000 }, probes: o.probes ?? false, preLaunch: o.preLaunch })).report;

const cli = async (argv: string[]) => {
  const out: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')));
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((c) => (out.push(String(c)), true));
  try {
    const code = await main(argv);
    return { code, stdout: out.join('\n'), stderr: err.mock.calls.map((c) => c.join(' ')) };
  } finally {
    log.mockRestore();
    err.mockRestore();
    write.mockRestore();
  }
};

beforeAll(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-status-'));
  cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-status-cfg-'));
  process.env['SEARVEX_CONFIG_DIR'] = cfg;
});

afterAll(async () => {
  for (const s of servers) await s.close();
  delete process.env['SEARVEX_CONFIG_DIR'];
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(cfg, { recursive: true, force: true });
});

describe('A1: robots.txt blocking every URL is not a scored run', () => {
  for (const status of [503, 429]) {
    it(`robots.txt ${status}: robots-blocked, one robots.unreachable finding, no score`, async () => {
      const s = await site(plain('', status));
      const r = await audit(s);
      expect(r.crawl.status).toBe('robots-blocked');
      expect(r.crawl.error).toMatch(new RegExp(`HTTP ${status}.*RFC 9309`));
      expect(r.crawl.fetched).toBe(0);
      expect(r.crawl.blocked).toBe(3);
      expect(r.findings.map((f) => f.ruleId)).toEqual(['robots.unreachable']);
      expect(r.scores.overall).toBeNull();
      expect(r.scores.notApplicable).toMatch(/robots\.txt could not be read/);
      expect(r.limitations[0]).toMatch(/Make \/robots\.txt return 200/);
      expect(s.hits.get('/')).toBeUndefined();
    });
  }

  it('Disallow: / for every agent: robots-blocked with the robots.disallow-all finding', async () => {
    const s = await site(plain('User-agent: *\nDisallow: /\n'));
    const r = await audit(s);
    expect(r.crawl.status).toBe('robots-blocked');
    expect(r.crawl.error).toMatch(/disallows every queued URL for SearvexBot/);
    expect([...new Set(r.findings.map((f) => f.ruleId))]).toEqual(['robots.disallow-all']);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.evidence.map((e) => e.observed)).toEqual([expect.stringMatching(/^Googlebot/), expect.stringMatching(/^Bingbot/), expect.stringMatching(/^YandexBot/)]);
    expect(r.scores.overall).toBeNull();
    expect(r.affectedUrls).toBe(0);
    expect(r.limitations[0]).toMatch(/allow the SearvexBot user agent/);
    expect(renderMarkdown(r)).toMatch(/robots\.txt blocks every URL/);
    const summary = summaryText(r, []);
    expect(summary).toMatch(/robots\.txt blocks every URL \(3 skipped\)/);
    expect(summary).toMatch(/Fix first: \[critical\]/);
    expect(summary).not.toMatch(/Health score/);
  });

  it('Disallow: / for SearvexBot only: robots-blocked without a site finding', async () => {
    const s = await site(plain('User-agent: SearvexBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n'));
    const r = await audit(s);
    expect(r.crawl.status).toBe('robots-blocked');
    expect(r.findings).toEqual([]);
    expect(r.geo.bots.find((b) => b.token === 'Googlebot')?.allowed).toBe(true);
  });

  it('Disallow: / with one allowed page stays a scored run', async () => {
    const s = await site(plain('User-agent: *\nDisallow: /\nAllow: /a\n'));
    const r = await audit(s);
    expect(r.crawl.status).toBe('complete');
    expect(r.crawl.fetched).toBe(1);
    expect(r.crawl.blocked).toBe(2);
    expect(r.crawl.crawled).toBe(3);
    expect(typeof r.scores.overall).toBe('number');
    expect(r.scores.notApplicable).toBeUndefined();
    expect(summaryText(r, [])).toMatch(/1 pages fetched, 2 blocked by robots\.txt/);
    expect(renderMarkdown(r)).toMatch(/\| Pages fetched \| 1 \|[\s\S]*\| Blocked by robots\.txt \| 2 \|/);
  });

  it('--pre-launch: a staging build that blocks all crawlers is robots-blocked with a launch-checklist finding', async () => {
    const s = await site(plain('User-agent: *\nDisallow: /\n'));
    const r = await audit(s, { preLaunch: true });
    expect(r.crawl.status).toBe('robots-blocked');
    expect(r.findings.map((f) => [f.ruleId, f.context])).toEqual([['robots.disallow-all', 'launch-checklist']]);
    expect(r.scores.overall).toBeNull();
    expect(r.scores.profile).toBe('pre-launch');
    expect(summaryText(r, [])).toMatch(/Launch checklist: .*staging build blocks all crawlers/);
  });

  it('the CLI exits 4 with one stderr line, also with --json and --quiet', async () => {
    const s = await site(plain('User-agent: *\nDisallow: /\n'));
    for (const flags of [[], ['--json'], ['--quiet']]) {
      const dir = fs.mkdtempSync(path.join(ws, 'cli-'));
      const { code, stderr, stdout } = await cli(['audit', s.url + '/', '--allow-private', '--delay', '0', '--fail-on', 'low', '--out', dir, ...flags]);
      expect(code, flags.join(' ')).toBe(EXIT.unreachable);
      expect(stderr.filter((l) => l.startsWith('searvex: '))).toEqual([expect.stringMatching(/^searvex: robots\.txt blocks every URL: /)]);
      if (flags[0] === '--json') expect(JSON.parse(stdout).crawl.status).toBe('robots-blocked');
    }
  });

  it('monitor and run treat a robots-blocked run like an unreachable one', async () => {
    const s = await site(plain('User-agent: *\nDisallow: /\n'));
    const dir = fs.mkdtempSync(path.join(ws, 'mon-'));
    const mon = await cli(['monitor', s.url + '/', '--allow-private', '--delay', '0', '--out', dir, '--json']);
    expect(mon.code).toBe(EXIT.unreachable);
    expect(JSON.parse(mon.stdout).diff).toBeNull();
    expect(mon.stderr.join('\n')).toMatch(/robots\.txt blocks every URL/);
    const run = await cli(['run', s.url + '/', '--allow-private', '--delay', '0', '--out', dir]);
    expect(run.code).toBe(EXIT.unreachable);
    const id = RunStore.list(dir).filter((x) => x.startsWith('run')).at(-1)!;
    const summary = new RunStore(dir, id).readJson<{ steps: Array<{ step: number; status: string; note: string }> }>('summary.json')!;
    expect(summary.steps.find((x) => x.step === 2)).toMatchObject({ status: 'skipped', note: expect.stringMatching(/robots\.txt blocks every URL/) });
  });
});

describe('A2: counters', () => {
  it('fetched counts requests; crawled stays "URLs processed"', async () => {
    const s = await site(plain('User-agent: *\nDisallow: /b\n'));
    const r = await audit(s);
    expect(r.crawl).toMatchObject({ status: 'complete', crawled: 3, fetched: 2, blocked: 1 });
  });
});

describe('A3: no score next to "not applicable"', () => {
  it('an unreachable target has overall null', async () => {
    const tmp = await startServer({});
    const closed = `http://127.0.0.1:${tmp.port}/`;
    await tmp.close();
    const r = (await auditWebsite(closed, { workspace: ws, crawl: { policy: { ...DEFAULT_POLICY, allowPrivate: true }, delayMs: 0, timeoutMs: 2000 } })).report;
    expect(r.crawl.status).toBe('unreachable');
    expect(r.scores.overall).toBeNull();
    expect(r.scores.byCategory).toEqual({});
  });
});

describe('A4: policy-blocked target', () => {
  it('exits 2 with one stderr line under --json and still writes report.json', async () => {
    const s = await site(plain('User-agent: *\nAllow: /\n'));
    const dir = fs.mkdtempSync(path.join(ws, 'policy-'));
    const { code, stderr, stdout } = await cli(['audit', s.url + '/', '--out', dir, '--json']);
    expect(code).toBe(EXIT.usage);
    expect(stderr).toEqual([expect.stringMatching(/^searvex: .*blocked by the network policy/)]);
    expect(stdout).toBe('');
    const id = RunStore.list(dir).at(-1)!;
    expect(new RunStore(dir, id).readJson<AuditReport>('report.json')?.crawl.status).toBe('unreachable');
  });
});

describe('A5: one cause, one finding', () => {
  it('a start URL that times out is reported once, as http.start-url-error', async () => {
    const s = await site(plain('User-agent: *\nAllow: /\n'), { '/': { delayMs: 1500, body: page({ title: 'slow' }) } });
    const r = await audit(s, { timeoutMs: 500 });
    expect(r.findings.find((f) => f.ruleId === 'http.start-url-error')).toBeTruthy();
    const fetchErrors = r.findings.find((f) => f.ruleId === 'http.fetch-error');
    expect(fetchErrors?.evidence.some((e) => e.url === s.url + '/')).not.toBe(true);
  });

  it('/llms.txt and /robots.txt never count as affected URLs', () => {
    const f = (ruleId: string) => ({ ruleId, severity: 'medium', confidence: 'verified', count: 1 }) as never;
    const urls: Record<string, string[]> = { 'x.a': ['https://e.com/llms.txt'], 'x.b': ['https://e.com/robots.txt'], 'x.c': ['https://e.com/p'] };
    expect(countAffected([f('x.a'), f('x.b'), f('x.c')], (id) => urls[id]!)).toBe(1);
  });

  it('inventory.unfetched lists every crawled URL that is not an HTML 200 page', async () => {
    const s = await site(plain('User-agent: *\nDisallow: /b\n'), {
      '/sitemap.xml': (o) => ({ headers: { 'content-type': 'application/xml' }, body: URLSET([`${o}/`, `${o}/a`, `${o}/b`, `${o}/gone`, `${o}/moved`, `${o}/feed`]) }),
      '/gone': { status: 404, body: 'gone' },
      '/moved': (o) => ({ redirect: `${o}/a` }),
      '/feed': { headers: { 'content-type': 'application/json' }, body: '{}' },
    });
    const r = await audit(s);
    const byPath = Object.fromEntries((r.inventory.unfetched ?? []).map((u) => [new URL(u.url).pathname, u]));
    expect(byPath['/b']).toMatchObject({ status: 0, reason: 'robots-blocked' });
    expect(byPath['/gone']).toMatchObject({ status: 404, reason: 'non-200' });
    expect(byPath['/moved']).toMatchObject({ status: 301, reason: 'redirect', detail: `${s.url}/a` });
    expect(byPath['/feed']).toMatchObject({ status: 200, reason: 'not-html' });
    expect(byPath['/']).toBeUndefined();
    expect(r.inventory.unfetchedTotal).toBe(r.inventory.unfetched!.length);
    expect(r.inventory.pages.length + r.inventory.unfetchedTotal!).toBe(r.crawl.crawled);
  });
});
