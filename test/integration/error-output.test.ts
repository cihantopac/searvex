import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EXIT, HELP_TRAILER, main } from '../../src/cli.js';
import { page, startServer, text, type TestServer } from '../helpers/server.js';

let server: TestServer;
let ws: string;
let cfg: string;

const run = async (argv: string[]) => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    const code = await main(argv);
    return { code, lines: err.mock.calls.map((c) => c.join(' ')).join('\n').split('\n') };
  } finally {
    err.mockRestore();
    log.mockRestore();
    write.mockRestore();
  }
};

beforeAll(async () => {
  server = await startServer({ '/': { body: page({ title: 'Home page of the site', body: `<h1>Home</h1>${text(200)}` }) } });
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-err-'));
  cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-err-cfg-'));
  process.env['SEARVEX_CONFIG_DIR'] = cfg;
});

afterAll(async () => {
  await server.close();
  delete process.env['SEARVEX_CONFIG_DIR'];
  delete process.env['SEARVEX_DEBUG'];
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(cfg, { recursive: true, force: true });
});

describe('B2: error output', () => {
  const notADir = () => {
    const file = path.join(ws, 'not-a-directory');
    fs.writeFileSync(file, '');
    return file;
  };

  it('a runtime error is one line without a stack trace, plus the SEARVEX_DEBUG hint', async () => {
    delete process.env['SEARVEX_DEBUG'];
    const { code, lines } = await run(['audit', server.url + '/', '--allow-private', '--delay', '0', '--out', notADir(), '--quiet']);
    expect(code).toBe(EXIT.runtime);
    expect(lines).toEqual([expect.stringMatching(/^searvex: .*(ENOTDIR|EEXIST|not a directory)/i), 'Run with SEARVEX_DEBUG=1 for details.']);
    expect(lines.join('\n')).not.toMatch(/\n\s+at /);
  });

  it('SEARVEX_DEBUG=1 prints the stack trace', async () => {
    process.env['SEARVEX_DEBUG'] = '1';
    try {
      const { code, lines } = await run(['audit', server.url + '/', '--allow-private', '--delay', '0', '--out', notADir(), '--quiet']);
      expect(code).toBe(EXIT.runtime);
      expect(lines.join('\n')).toMatch(/\n\s+at /);
    } finally {
      delete process.env['SEARVEX_DEBUG'];
    }
  });

  it('every usage error ends with the --help trailer, also when raised inside a command', async () => {
    for (const argv of [['nope'], ['audit'], ['audit', '--max-pages', 'x', 'http://127.0.0.1/'], ['audit', 'http://127.0.0.1/', '--fail-on', 'bogus', '--allow-private', '--max-pages', '1', '--out', ws, '--quiet']]) {
      const { code, lines } = await run(argv);
      expect(code, argv.join(' ')).toBe(EXIT.usage);
      expect(lines[0], argv.join(' ')).toMatch(/^searvex: /);
      expect(lines.at(-1), argv.join(' ')).toBe(HELP_TRAILER);
    }
  });

  it('--json adds one JSON error object on stderr', async () => {
    const usage = await run(['nope', '--json']);
    expect(JSON.parse(usage.lines.at(-1)!)).toEqual({ error: { code: 2, kind: 'usage', message: 'Unknown command: nope' } });

    const parse = await run(['audit', '--max-pages', 'x', '--json']);
    expect(JSON.parse(parse.lines.at(-1)!).error).toMatchObject({ code: 2, kind: 'usage' });

    const policy = await run(['audit', server.url + '/', '--out', fs.mkdtempSync(path.join(ws, 'p-')), '--json']);
    expect(policy.code).toBe(EXIT.usage);
    expect(JSON.parse(policy.lines.at(-1)!).error).toMatchObject({ code: 2, kind: 'policy', message: expect.stringMatching(/blocked by the network policy/) });

    const runtime = await run(['audit', server.url + '/', '--allow-private', '--delay', '0', '--out', notADir(), '--json']);
    expect(JSON.parse(runtime.lines.at(-1)!).error).toMatchObject({ code: 3, kind: 'runtime' });

    const tmp = await startServer({});
    const closed = `http://127.0.0.1:${tmp.port}/`;
    await tmp.close();
    const down = await run(['audit', closed, '--allow-private', '--timeout', '2000', '--out', fs.mkdtempSync(path.join(ws, 'u-')), '--json']);
    expect(down.code).toBe(EXIT.unreachable);
    expect(down.lines[0]).toMatch(/^searvex: target unreachable: /);
    expect(JSON.parse(down.lines.at(-1)!).error).toMatchObject({ code: 4, kind: 'unreachable' });
  });

  it('without --json no JSON object is written', async () => {
    const { lines } = await run(['nope']);
    expect(lines.some((l) => l.startsWith('{'))).toBe(false);
  });
});
