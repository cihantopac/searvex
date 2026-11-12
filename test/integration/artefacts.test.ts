import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auditWebsite, type AuditReport } from '../../src/analyze/audit.js';
import { EXIT, main } from '../../src/cli.js';
import { ARTEFACT_PAGE_CAP, artefactName } from '../../src/crawl/crawler.js';
import { RunStore } from '../../src/crawl/store.js';
import { DEFAULT_POLICY } from '../../src/net/ssrf.js';
import { page, startServer, text, type TestServer } from '../helpers/server.js';

const policy = { ...DEFAULT_POLICY, allowPrivate: true };
let site: TestServer;
let ws: string;
let cfg: string;
const BIG = `<!doctype html><html lang="en"><head><title>A very large page of the site</title></head><body><h1>Big</h1>${'x'.repeat(3 * 1024 * 1024)}</body></html>`;

beforeAll(async () => {
  site = await startServer({
    '/': { body: page({ title: 'Home page of the site', body: `<h1>Home</h1>${text(200)}<a href="/a">a</a><a href="/big">big</a><script>window.secret = 1</script>` }) },
    // No meta description: a finding whose evidence links the artefact.
    '/a': { body: page({ title: 'Page A of the site', body: `<h1>A</h1>${text(200)}` }) },
    '/big': { body: BIG },
  });
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-art-'));
  cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-art-cfg-'));
});

afterAll(async () => {
  await site.close();
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(cfg, { recursive: true, force: true });
});

const audit = (artefacts?: { html?: boolean; maxBytes?: number }) => auditWebsite(site.url + '/', { workspace: ws, probes: false, crawl: { policy, delayMs: 0, concurrency: 1, artefacts } });
const runDir = (r: AuditReport) => path.join(ws, '.searvex', 'runs', r.runId);

describe('E2: --save-html', () => {
  it('stores each HTML body as served, as .html.txt, and links it from the evidence', async () => {
    const { report } = await audit({ html: true });
    expect(report.crawl.artefacts).toMatchObject({ html: 3, screenshots: 0, skipped: 0 });
    const name = `${artefactName(site.url + '/a')}.html.txt`;
    const file = path.join(runDir(report), 'artefacts', 'html', name);
    expect(fs.readFileSync(file, 'utf8')).toBe(page({ title: 'Page A of the site', body: `<h1>A</h1>${text(200)}` }));
    const ev = report.findings.find((f) => f.ruleId === 'description.missing')!.evidence.find((e) => e.url === site.url + '/a')!;
    expect(ev.artefact).toEqual({ html: `artefacts/html/${name}` });
    expect(report.limitations.join(' ')).toMatch(/Evidence artefacts: 3 HTML bodies.*personal data/);
  });

  it.runIf(process.platform !== 'win32')('keeps artefacts owner-only (0700 directory, 0600 files)', async () => {
    const { report } = await audit({ html: true });
    const dir = path.join(runDir(report), 'artefacts');
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, 'html')).mode & 0o777).toBe(0o700);
    for (const f of fs.readdirSync(path.join(dir, 'html'))) expect(fs.statSync(path.join(dir, 'html', f)).mode & 0o777).toBe(0o600);
  });

  it('cuts a body at 2 MB and skips artefacts over the run budget', async () => {
    const { report } = await audit({ html: true });
    const big = fs.statSync(path.join(runDir(report), 'artefacts', 'html', `${artefactName(site.url + '/big')}.html.txt`));
    expect(big.size).toBe(ARTEFACT_PAGE_CAP);
    const small = (await audit({ html: true, maxBytes: 10_000 })).report;
    expect(small.crawl.artefacts!.skipped).toBeGreaterThan(0);
    expect(small.crawl.artefacts!.bytes).toBeLessThanOrEqual(10_000);
    expect(small.limitations.join(' ')).toMatch(/skipped at the 200 MB per-run limit/);
  });

  it('writes nothing without the flag', async () => {
    const { report } = await audit();
    expect(report.crawl.artefacts).toBeUndefined();
    expect(fs.existsSync(path.join(runDir(report), 'artefacts'))).toBe(false);
    expect(report.findings.flatMap((f) => f.evidence).some((e) => e.artefact)).toBe(false);
  });

  it('artefact names are stable and file-system safe', () => {
    expect(artefactName('https://e.com/Blog/Ünïcode post?x=1')).toMatch(/^[0-9a-f]{12}-blog-n-code-post$/);
    expect(artefactName('https://e.com/')).toMatch(/^[0-9a-f]{12}-index$/);
    expect(artefactName('https://e.com/a')).toBe(artefactName('https://e.com/a'));
    expect(() => new RunStore(ws, 'x').writeArtefact('html', '../escape', 'x')).toThrow(/Invalid artefact name/);
  });
});

describe('E2: CLI', () => {
  const run = async (argv: string[]) => {
    process.env['SEARVEX_CONFIG_DIR'] = cfg;
    const spies = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(process.stdout, 'write').mockImplementation(() => true)];
    try {
      return await main(argv);
    } finally {
      for (const s of spies) s.mockRestore();
      delete process.env['SEARVEX_CONFIG_DIR'];
    }
  };

  it('--save-html works from the CLI, and the HTML report links the files', async () => {
    const dir = fs.mkdtempSync(path.join(ws, 'cli-'));
    expect(await run(['audit', site.url + '/', '--allow-private', '--delay', '0', '--save-html', '--out', dir, '--quiet'])).toBe(EXIT.ok);
    const store = new RunStore(dir, RunStore.list(dir).at(-1)!);
    expect(store.readJson<AuditReport>('report.json')!.crawl.artefacts!.html).toBe(3);
    expect(fs.readFileSync(store.file('report.html'), 'utf8')).toMatch(/artefacts\/html\/[0-9a-f]{12}-a\.html\.txt/);
  });

  it('--screenshots needs --render', async () => {
    expect(await run(['audit', site.url + '/', '--allow-private', '--screenshots', '--out', ws])).toBe(EXIT.usage);
  });
});
