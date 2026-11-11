import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuditReport } from '../../src/analyze/audit.js';
import { crawl } from '../../src/crawl/crawler.js';
import { RunStore } from '../../src/crawl/store.js';
import { DEFAULT_POLICY } from '../../src/net/ssrf.js';
import { EXIT, main } from '../../src/cli.js';
import { findBaseline } from '../../src/commands/monitor.js';
import { page, startServer, text, type TestServer } from '../helpers/server.js';

let server: TestServer;
let closedUrl: string;
let ws: string;
let cfg: string;

const quiet = async (argv: string[]) => {
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    return { code: await main(argv), stderr: err.mock.calls.map((c) => c.join(' ')).join('\n') };
  } finally {
    out.mockRestore();
    err.mockRestore();
    write.mockRestore();
  }
};

const latestReport = (dir: string): AuditReport => {
  const id = RunStore.list(dir).at(-1)!;
  return new RunStore(dir, id).readJson<AuditReport>('report.json')!;
};

beforeAll(async () => {
  server = await startServer({ '/': { body: page({ title: 'Home page of the site', body: `<h1>Home</h1>${text(200)}` }) } });
  // A port that was just released: connections are refused.
  const tmp = await startServer({});
  closedUrl = `http://127.0.0.1:${tmp.port}/`;
  await tmp.close();
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-exit-'));
  cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-exit-cfg-'));
  process.env['SEARVEX_CONFIG_DIR'] = cfg;
});

afterAll(async () => {
  await server.close();
  delete process.env['SEARVEX_CONFIG_DIR'];
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(cfg, { recursive: true, force: true });
});

describe('exit codes', () => {
  it('has the documented table', () => {
    expect(EXIT).toEqual({ ok: 0, failOn: 1, usage: 2, runtime: 3, unreachable: 4, interrupted: 5 });
  });

  it('documents the exit codes in --help', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await main(['--help'])).toBe(EXIT.ok);
      const help = log.mock.calls.flat().join('\n');
      expect(help).toMatch(/3 runtime error/);
      expect(help).toMatch(/4 target unreachable/);
      expect(help).toMatch(/5 interrupted \(SIGINT\/SIGTERM or\n?\s*--max-duration\)/);
    } finally {
      log.mockRestore();
    }
  });

  it('usage errors stay 2', async () => {
    expect((await quiet(['audit'])).code).toBe(EXIT.usage);
    expect((await quiet(['nope'])).code).toBe(EXIT.usage);
    expect((await quiet(['audit', '--max-pages', 'x', 'http://127.0.0.1/'])).code).toBe(EXIT.usage);
  });

  it('runtime errors are 3', async () => {
    const file = path.join(ws, 'not-a-directory');
    fs.writeFileSync(file, '');
    const { code, stderr } = await quiet(['audit', server.url + '/', '--allow-private', '--delay', '0', '--out', file, '--quiet']);
    expect(code).toBe(EXIT.runtime);
    expect(stderr).toMatch(/ENOTDIR|EEXIST|not a directory/i);
  });
});

describe('unreachable target', () => {
  it('crawl() marks a refused connection as unreachable and fetches nothing', async () => {
    const r = await crawl(closedUrl, { policy: { ...DEFAULT_POLICY, allowPrivate: true }, delayMs: 0, timeoutMs: 2000 });
    expect(r.unreachable?.blocked).toBe(false);
    expect(r.unreachable?.error).toBeTruthy();
    expect(r.pages).toEqual([]);
  });

  it('crawl() marks a DNS failure as unreachable', async () => {
    const r = await crawl('http://searvex-test.invalid/', { delayMs: 0, timeoutMs: 2000 });
    expect(r.unreachable).toBeTruthy();
    expect(r.pages).toEqual([]);
  });

  it('audit writes reports without site findings and exits 4', async () => {
    const dir = fs.mkdtempSync(path.join(ws, 'unreach-'));
    const { code, stderr } = await quiet(['audit', closedUrl, '--allow-private', '--timeout', '2000', '--out', dir]);
    expect(code).toBe(EXIT.unreachable);
    expect(stderr).not.toMatch(/at .*\.ts/); // not a crash
    const report = latestReport(dir);
    expect(report.crawl.status).toBe('unreachable');
    expect(report.crawl.error).toBeTruthy();
    expect(report.findings).toEqual([]);
    expect(report.scores.notApplicable).toMatch(/unreachable/);
    expect(report.geo.bots).toEqual([]);
    const runDir = path.dirname(new RunStore(dir, report.runId).file('report.json'));
    expect(fs.existsSync(path.join(runDir, 'report.html'))).toBe(true);
    expect(fs.readFileSync(path.join(runDir, 'report.md'), 'utf8')).toMatch(/Target unreachable/);
  });

  it('--fail-on does not turn an unreachable target into 1', async () => {
    const dir = fs.mkdtempSync(path.join(ws, 'unreach-failon-'));
    expect((await quiet(['audit', closedUrl, '--allow-private', '--timeout', '2000', '--fail-on', 'low', '--out', dir])).code).toBe(EXIT.unreachable);
  });

  it('a target blocked by the network policy is a usage error with a hint and renders no report', async () => {
    const dir = fs.mkdtempSync(path.join(ws, 'blocked-'));
    const { code, stderr } = await quiet(['audit', server.url + '/', '--out', dir]);
    expect(code).toBe(EXIT.usage);
    expect(stderr).toMatch(/blocked by the network policy.*--allow-private/);
    const report = latestReport(dir);
    expect(report.crawl.status).toBe('unreachable');
    expect(fs.existsSync(new RunStore(dir, report.runId).file('report.html'))).toBe(false);
  });

  it('geo exits 4', async () => {
    const dir = fs.mkdtempSync(path.join(ws, 'geo-'));
    expect((await quiet(['geo', closedUrl, '--allow-private', '--timeout', '2000', '--out', dir])).code).toBe(EXIT.unreachable);
  });

  it('monitor exits 4 without a diff, and an unreachable run is never a baseline', async () => {
    const dir = fs.mkdtempSync(path.join(ws, 'monitor-'));
    expect((await quiet(['audit', server.url + '/', '--allow-private', '--delay', '0', '--out', dir, '--quiet'])).code).toBe(EXIT.ok);
    const [good] = RunStore.list(dir) as [string];
    const target = latestReport(dir).target;
    // Same target, now down: simulate by monitoring the closed port under the same report target.
    const { code } = await quiet(['monitor', closedUrl, '--allow-private', '--timeout', '2000', '--out', dir]);
    expect(code).toBe(EXIT.unreachable);
    const down = RunStore.list(dir).find((id) => id !== good)!;
    const monitor = new RunStore(dir, down).readJson<{ diff: unknown; notes: string[] }>('monitor.json');
    expect(monitor?.diff).toBeNull();
    expect(monitor?.notes[0]).toMatch(/unreachable/i);
    // Retarget the unreachable report to the good site's URL: findBaseline must still skip it.
    const store = new RunStore(dir, down);
    store.writeJson('report.json', { ...store.readJson<AuditReport>('report.json')!, target });
    expect(findBaseline(dir, target, 'none')?.id).toBe(good);
  });

  it('run exits 4 and skips steps 2–4', async () => {
    const dir = fs.mkdtempSync(path.join(ws, 'run-'));
    expect((await quiet(['run', closedUrl, '--allow-private', '--timeout', '2000', '--out', dir])).code).toBe(EXIT.unreachable);
    const id = RunStore.list(dir).filter((x) => x.startsWith('run')).at(-1)!;
    const summary = new RunStore(dir, id).readJson<{ steps: Array<{ step: number; status: string; note: string }> }>('summary.json')!;
    for (const n of [1, 2, 3, 4]) expect(summary.steps.find((s) => s.step === n)).toMatchObject({ status: 'skipped', note: expect.stringMatching(/unreachable/) });
  });
});
