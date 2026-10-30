import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type Route, type TestServer } from '../helpers/server.js';
import { shopSite } from '../fixtures/shop-site.js';

const run = promisify(execFile);
const BIN = path.resolve('bin/searvex');
const hasBundle = fs.existsSync(path.resolve('dist/searvex.mjs'));

async function cli(args: string[], cwd = process.cwd()) {
  try {
    const r = await run(process.execPath, [BIN, ...args], { cwd, timeout: 60000, maxBuffer: 20 * 1024 * 1024 });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

describe.runIf(hasBundle)('bundled CLI (bin/searvex → dist/searvex.mjs)', () => {
  let server: TestServer;
  let ws: string;
  beforeAll(async () => {
    const routes: Record<string, Route> = {};
    server = await startServer(routes);
    Object.assign(routes, shopSite(() => server.url));
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-e2e-'));
  });
  afterAll(async () => {
    await server.close();
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('prints version and help', async () => {
    expect((await cli(['--version'])).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    const help = await cli(['--help']);
    expect(help.stdout).toContain('Usage: searvex');
  });

  it('validates the bundled knowledge base', async () => {
    const r = await cli(['rules', 'validate']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/0 errors/);
  });

  it('refuses private targets unless --allow-private', async () => {
    const r = await cli(['audit', server.url + '/', '--out', ws, '-q', '--max-pages', '3']);
    const report = JSON.parse(fs.readFileSync(path.join(ws, '.searvex', 'runs', fs.readdirSync(path.join(ws, '.searvex', 'runs'))[0]!, 'report.json'), 'utf8'));
    expect(r.code).toBe(0);
    expect(report.crawl.robots.state).toBe('unreachable');
    expect(server.hits.size).toBe(0);
  });

  it('audits a site end-to-end and writes all report formats; --fail-on gates CI', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-e2e2-'));
    const r = await cli(['audit', server.url + '/', '--allow-private', '--delay', '0', '--out', out, '--format', 'md,html,json,sarif', '--fail-on', 'high']);
    expect(r.code).toBe(1); // planted high-severity issues
    const run = fs.readdirSync(path.join(out, '.searvex', 'runs'))[0]!;
    const dir = path.join(out, '.searvex', 'runs', run);
    for (const f of ['report.md', 'report.html', 'report.json', 'report.sarif', 'pages.jsonl', 'checkpoint.json']) expect(fs.existsSync(path.join(dir, f)), f).toBe(true);
    const sarif = JSON.parse(fs.readFileSync(path.join(dir, 'report.sarif'), 'utf8'));
    expect(sarif.version).toBe('2.1.0');
    const html = fs.readFileSync(path.join(dir, 'report.html'), 'utf8');
    expect(html).toContain('Content-Security-Policy');
    expect(html).not.toMatch(/<script>[^<]*alert/);
    fs.rmSync(out, { recursive: true, force: true });
  });

  it('exits with code 2 on usage errors', async () => {
    expect((await cli(['audit'])).code).toBe(2);
    expect((await cli(['nope'])).code).toBe(2);
    expect((await cli(['audit', 'https://example.com', '--max-pages', 'abc'])).code).toBe(2);
  });

  it('audits a repository fixture', async () => {
    const r = await cli(['audit', path.resolve('test/fixtures/repos/nextjs-app'), '--out', ws, '--json']);
    const report = JSON.parse(r.stdout);
    expect(report.mode).toBe('repository');
    expect(report.findings.map((f: { ruleId: string }) => f.ruleId)).toContain('duplicate.title');
  });
});
