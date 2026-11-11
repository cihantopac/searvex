import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuditReport } from '../../src/analyze/audit.js';
import { crawl } from '../../src/crawl/crawler.js';
import { RunStore } from '../../src/crawl/store.js';
import { DEFAULT_POLICY } from '../../src/net/ssrf.js';
import { EXIT, main } from '../../src/cli.js';
import { page, startServer, text, type Route, type TestServer } from '../helpers/server.js';

const BIN = path.resolve('bin/searvex');
const hasBundle = fs.existsSync(path.resolve('dist/searvex.mjs'));
const PAGES = 30;

let server: TestServer;
let ws: string;
let cfg: string;
const policy = { ...DEFAULT_POLICY, allowPrivate: true };

/** A slow site: PAGES pages listed in the sitemap, each answering after `delayMs`. */
const slowSite = async (delayMs: number): Promise<TestServer> => {
  const routes: Record<string, Route> = {};
  const s = await startServer(routes);
  const urls = Array.from({ length: PAGES }, (_, i) => `${s.url}/p${i}`);
  routes['/robots.txt'] = { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nAllow: /\n' };
  routes['/sitemap.xml'] = { headers: { 'content-type': 'application/xml' }, body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>` };
  routes['/'] = { delayMs, body: page({ title: 'Home page of the slow site', body: `<h1>Home</h1>${text(150)}` }) };
  for (let i = 0; i < PAGES; i++) routes[`/p${i}`] = { delayMs, body: page({ title: `Slow page number ${i} of the site`, body: `<h1>Page ${i}</h1>${text(150)}` }) };
  return s;
};

/** Spawn the bundled CLI; resolves with its exit code/signal, stderr and the time it took after `kill`. */
const spawnCli = (args: string[], onStderr: (chunk: string, child: ReturnType<typeof spawn>) => void) =>
  new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, SEARVEX_CONFIG_DIR: cfg }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      onStderr(stderr, child);
    });
    child.on('exit', (code) => resolve({ code, stderr }));
  });

const latestReport = (dir: string): AuditReport => {
  const id = RunStore.list(dir).filter((x) => x.startsWith('audit')).at(-1)!;
  return new RunStore(dir, id).readJson<AuditReport>('report.json')!;
};

beforeAll(async () => {
  server = await slowSite(300);
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-int-'));
  cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-int-cfg-'));
});

afterAll(async () => {
  await server.close();
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(cfg, { recursive: true, force: true });
});

// Windows has no catchable SIGTERM: ChildProcess.kill() terminates the process at once.
describe.runIf(hasBundle && process.platform !== 'win32')('B1: graceful interruption (bundled CLI)', () => {
  it('SIGTERM during a crawl writes a partial report and exits 5', async () => {
    const dir = fs.mkdtempSync(path.join(ws, 'term-'));
    let sent = false;
    const { code, stderr } = await spawnCli(['audit', server.url + '/', '--allow-private', '--delay', '0', '--concurrency', '1', '--out', dir, '--format', 'json,md,html'], (err, child) => {
      if (!sent && /pages fetched/.test(err)) {
        sent = true;
        child.kill('SIGTERM');
      }
    });
    expect(code).toBe(EXIT.interrupted);
    expect(stderr).toMatch(/SIGTERM received/);
    expect(stderr).toMatch(/searvex: interrupted by a signal: partial report/);
    expect(stderr).not.toMatch(/\n\s+at /);
    const r = latestReport(dir);
    expect(r.crawl.interrupted).toBe('signal');
    expect(r.crawl.fetched).toBeGreaterThan(0);
    expect(r.crawl.fetched).toBeLessThan(PAGES + 1);
    expect(r.limitations[0]).toMatch(/interrupted by a signal.*--resume/);
    const runDir = path.dirname(new RunStore(dir, r.runId).file('report.json'));
    for (const f of ['report.md', 'report.html', 'checkpoint.json']) expect(fs.existsSync(path.join(runDir, f)), f).toBe(true);
    expect(fs.readFileSync(path.join(runDir, 'report.md'), 'utf8')).toMatch(/Partial report/);
  }, 30000);

  it('a second signal exits at once with 143', async () => {
    const slow = await slowSite(8000);
    try {
      const dir = fs.mkdtempSync(path.join(ws, 'twice-'));
      let sent = 0;
      let firstAt = 0;
      const { code } = await spawnCli(['audit', slow.url + '/', '--allow-private', '--delay', '0', '--out', dir, '--timeout', '30000'], (err, child) => {
        if (sent === 0 && /Crawling/.test(err)) {
          sent = 1;
          // Let the start URL request go out, then interrupt twice.
          setTimeout(() => {
            firstAt = Date.now();
            child.kill('SIGTERM');
          }, 500);
        } else if (sent === 1 && /SIGTERM received/.test(err)) {
          sent = 2;
          child.kill('SIGTERM');
        }
      });
      expect(code).toBe(143);
      expect(Date.now() - firstAt).toBeLessThan(5000);
    } finally {
      await slow.close();
    }
  }, 30000);
});

describe('B1: --max-duration and resume', () => {
  const quiet = async (argv: string[]) => {
    const spies = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(process.stdout, 'write').mockImplementation(() => true)];
    try {
      return await main(argv);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  };

  it('--max-duration stops the crawl and exits 5 with a partial report', async () => {
    process.env['SEARVEX_CONFIG_DIR'] = cfg;
    const dir = fs.mkdtempSync(path.join(ws, 'maxdur-'));
    const t0 = Date.now();
    const code = await quiet(['audit', server.url + '/', '--allow-private', '--delay', '0', '--concurrency', '1', '--max-duration', '1', '--out', dir]);
    expect(code).toBe(EXIT.interrupted);
    expect(Date.now() - t0).toBeLessThan(PAGES * 300);
    const r = latestReport(dir);
    expect(r.crawl.interrupted).toBe('max-duration');
    expect(r.crawl.queuedRemaining).toBeGreaterThan(0);
    expect(r.findings.find((f) => f.ruleId === 'perf.cwv-unmeasured')?.evidence[0]?.observed).toMatch(/interrupted/);
    // An interrupted run is never a monitor baseline, and --fail-on does not hide exit 5.
    expect(await quiet(['audit', server.url + '/', '--allow-private', '--delay', '0', '--max-duration', '1', '--fail-on', 'low', '--out', dir])).toBe(EXIT.interrupted);
    delete process.env['SEARVEX_CONFIG_DIR'];
  }, 30000);

  it('rejects an invalid --max-duration', async () => {
    expect(await quiet(['audit', server.url + '/', '--allow-private', '--max-duration', '0', '--out', ws])).toBe(EXIT.usage);
  });

  it('--resume continues an interrupted crawl without fetching a page twice', async () => {
    const counting = await slowSite(20);
    try {
      const store = new RunStore(ws, RunStore.newRunId('audit'));
      const ac = new AbortController();
      const first = await crawl(counting.url + '/', { policy, delayMs: 0, concurrency: 1, useSitemaps: true, stop: ac.signal, onProgress: (p) => p.fetched === 5 && ac.abort('signal') }, store);
      expect(first.interrupted).toBe('signal');
      expect(first.stats.fetched).toBe(5);
      expect(store.readJson('checkpoint.json')).toBeTruthy();
      const second = await crawl(counting.url + '/', { policy, delayMs: 0, concurrency: 2 }, new RunStore(ws, store.runId));
      expect(second.interrupted).toBeUndefined();
      expect(second.stats.fetched).toBe(PAGES + 1);
      expect(new Set(second.pages.map((p) => p.url)).size).toBe(second.pages.length);
      for (const [k, n] of counting.hits) if (k !== '/robots.txt' && k !== '/sitemap.xml') expect(n, k).toBe(1);
    } finally {
      await counting.close();
    }
  });
});
