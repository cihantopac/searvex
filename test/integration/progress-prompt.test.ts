import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EXIT, main } from '../../src/cli.js';
import * as api from '../../src/index.js';
import { page, startServer, text, type Route, type TestServer } from '../helpers/server.js';

let server: TestServer;
let ws: string;
let cfg: string;

/** Run the CLI capturing stdout and every stderr line (console.error and direct stderr writes). */
const run = async (argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const spies = [
    vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ') + '\n')),
    vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.join(' ') + '\n')),
    vi.spyOn(process.stdout, 'write').mockImplementation((c) => (out.push(String(c)), true)),
    vi.spyOn(process.stderr, 'write').mockImplementation((c) => (err.push(String(c)), true)),
  ];
  try {
    const code = await main(argv);
    return { code, stdout: out.join(''), stderr: err.join('').split('\n').filter(Boolean) };
  } finally {
    for (const s of spies) s.mockRestore();
  }
};

beforeAll(async () => {
  const routes: Record<string, Route> = {
    '/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /private\n' },
    '/': { body: page({ title: 'Home page of the site', body: `<h1>Home</h1>${text(200)}<a href="/a">a</a><a href="/private">p</a><a href="/gone?token=SECRET1234567890">x</a>` }) },
    '/a': { body: page({ title: 'Page A of the site', body: `<h1>A</h1>${text(200)}` }) },
  };
  server = await startServer(routes);
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-pp-'));
  cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-pp-cfg-'));
  process.env['SEARVEX_CONFIG_DIR'] = cfg;
  expect((await run(['audit', server.url + '/', '--allow-private', '--delay', '0', '--out', ws, '--quiet'])).code).toBe(EXIT.ok);
});

afterAll(async () => {
  await server.close();
  delete process.env['SEARVEX_CONFIG_DIR'];
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(cfg, { recursive: true, force: true });
});

describe('C4: --progress ndjson', () => {
  it('writes one JSON event per stderr line, alongside --json on stdout', async () => {
    const dir = fs.mkdtempSync(path.join(ws, 'nd-'));
    const { code, stdout, stderr } = await run(['audit', server.url + '/', '--allow-private', '--delay', '0', '--concurrency', '1', '--out', dir, '--json', '--progress', 'ndjson']);
    expect(code).toBe(EXIT.ok);
    expect(JSON.parse(stdout).target).toBe(server.url + '/');
    const events = stderr.map((l) => JSON.parse(l) as { event: string; [k: string]: unknown });
    expect(events[0]).toMatchObject({ event: 'start', command: 'audit', target: server.url + '/' });
    expect(events.filter((e) => e.event === 'phase').map((e) => e['phase'])).toEqual(['crawl', 'analyze', 'report']);
    const pages = events.filter((e) => e.event === 'page');
    expect(pages.find((e) => String(e['url']).endsWith('/private'))).toMatchObject({ blocked: true, status: 0 });
    expect(pages.find((e) => e['url'] === server.url + '/')).toMatchObject({ blocked: false, status: 200, fetched: 1 });
    const summary = events.find((e) => e.event === 'finding-summary')!;
    expect(summary).toMatchObject({ status: 'complete', score: expect.any(Number) });
    expect(events.at(-1)).toMatchObject({ event: 'end', exitCode: 0, reports: expect.arrayContaining([expect.stringMatching(/report\.json$/)]) });
    for (const e of events) expect(typeof e['time']).toBe('string');
  });

  it('errors are JSON too, and the end event carries the exit code', async () => {
    const { code, stderr } = await run(['audit', '--progress', 'ndjson']);
    expect(code).toBe(EXIT.usage);
    const lines = stderr.map((l) => JSON.parse(l));
    expect(lines.map((l) => l.event ?? 'error')).toEqual(['start', 'error', 'end']);
    expect(lines[1].error).toMatchObject({ code: 2, kind: 'usage' });
    expect(lines[2]).toMatchObject({ exitCode: 2, reports: [] });
  });

  it('rejects other progress modes', async () => {
    expect((await run(['audit', server.url + '/', '--progress', 'xml'])).code).toBe(EXIT.usage);
  });
});

describe('C5: searvex prompt', () => {
  it('prints the repair prompt for every issue, with refs, and redacts secrets', async () => {
    const { code, stdout } = await run(['prompt', 'latest', '--out', ws]);
    expect(code).toBe(EXIT.ok);
    expect(stdout).toMatch(/http\.broken-internal-link|http\.client-error|robots\./);
    expect(stdout).toMatch(/[a-z]+\.[a-z-]+#[0-9a-z]{7}/);
    expect(stdout).not.toMatch(/SECRET1234567890/);
    expect(stdout).toMatch(/token=\[REDACTED\]/);
  });

  it('--rules, --lang tr and --format json', async () => {
    const all = JSON.parse((await run(['prompt', 'latest', '--out', ws, '--format', 'json'])).stdout) as { rules: string[]; prompt: string };
    expect(all.rules.length).toBeGreaterThan(1);
    const one = JSON.parse((await run(['prompt', 'latest', '--out', ws, '--format', 'json', '--rules', all.rules[0]!])).stdout) as { rules: string[]; prompt: string };
    expect(one.rules).toEqual([all.rules[0]]);
    const tr = await run(['prompt', 'latest', '--out', ws, '--lang', 'tr', '--rules', all.rules.join(',')]);
    expect(tr.code).toBe(EXIT.ok);
    expect(tr.stdout).not.toBe(all.prompt);
  });

  it('usage errors: unknown rule, bad language or format', async () => {
    expect((await run(['prompt', 'latest', '--out', ws, '--rules', 'nope.rule'])).code).toBe(EXIT.usage);
    expect((await run(['prompt', 'latest', '--out', ws, '--lang', 'de'])).code).toBe(EXIT.usage);
    expect((await run(['prompt', 'latest', '--out', ws, '--format', 'html'])).code).toBe(EXIT.usage);
    expect((await run(['prompt', 'nope-run', '--out', ws])).code).toBe(EXIT.usage);
  });

  it('the package exports the prompt and remediation helpers', () => {
    for (const name of ['buildRepairPrompt', 'repairPromptInput', 'annotateReport', 'rootCauseGroups', 'remediationOf', 'findingRef', 'diffReports', 'prioritise']) expect(typeof (api as Record<string, unknown>)[name], name).toBe('function');
  });
});
