import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auditWebsite, type AuditReport } from '../../src/analyze/audit.js';
import { EXIT, hostGlobs, main, portsFrom } from '../../src/cli.js';
import { RunStore } from '../../src/crawl/store.js';
import { safeFetch } from '../../src/net/fetcher.js';
import { startPolicyProxy } from '../../src/net/policy-proxy.js';
import { assertUrlAllowed, DEFAULT_POLICY, hostMatches, hostPolicyViolation } from '../../src/net/ssrf.js';
import { page, startServer, text, type Route, type TestServer } from '../helpers/server.js';

let site: TestServer;
let other: TestServer;
let ws: string;
let cfg: string;

const run = async (argv: string[]) => {
  const spies = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(process.stdout, 'write').mockImplementation(() => true)];
  try {
    const code = await main(argv);
    return { code, stderr: (spies[1]!.mock.calls as unknown[][]).map((c) => c.join(' ')).join('\n') };
  } finally {
    for (const s of spies) s.mockRestore();
  }
};

beforeAll(async () => {
  other = await startServer({ '/x': { body: page({ title: 'Other port page', body: text(100) }) } });
  const routes: Record<string, Route> = {};
  site = await startServer(routes);
  // Links to the same host on another port (in crawl scope) and to an external host.
  routes['/'] = { body: page({ title: 'Home page of the site', body: `<h1>Home</h1>${text(200)}<a href="http://localhost:${other.port}/x">same host, other port</a><a href="http://denied.localhost:${other.port}/y">external</a>` }) };
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-net-'));
  cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-net-cfg-'));
  process.env['SEARVEX_CONFIG_DIR'] = cfg;
});

afterAll(async () => {
  await site.close();
  await other.close();
  delete process.env['SEARVEX_CONFIG_DIR'];
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(cfg, { recursive: true, force: true });
});

describe('D1: host and port policy', () => {
  it('host globs', () => {
    expect(hostMatches('cdn.example.com', '*.example.com')).toBe(true);
    expect(hostMatches('a.b.example.com', '*.example.com')).toBe(true);
    expect(hostMatches('example.com', '*.example.com')).toBe(false);
    expect(hostMatches('EXAMPLE.com.', 'example.com')).toBe(true);
    expect(hostMatches('example.com.evil.net', 'example.com')).toBe(false);
    expect(hostMatches('[::1]', '::1')).toBe(true);
    const p = { ...DEFAULT_POLICY, allowHosts: ['*.example.com'], denyHosts: ['admin.example.com'] };
    expect(hostPolicyViolation('www.example.com', p)).toBeNull();
    expect(hostPolicyViolation('admin.example.com', p)).toMatch(/--deny-host/);
    expect(hostPolicyViolation('example.org', p)).toMatch(/--allow-host/);
    expect(() => assertUrlAllowed('https://example.org/', p)).toThrow(/--allow-host/);
    expect(() => assertUrlAllowed('https://www.example.com:8443/', { ...p, ports: [443] })).toThrow(/--ports/);
  });

  it('parses --ports and host globs strictly', () => {
    expect(portsFrom('80, 443,8080')).toEqual([80, 443, 8080]);
    expect(() => portsFrom('80,abc')).toThrow();
    expect(() => portsFrom('70000')).toThrow();
    expect(hostGlobs(['a.com,*.b.com'], '--allow-host')).toEqual(['a.com', '*.b.com']);
    expect(() => hostGlobs(['http://a.com/'], '--allow-host')).toThrow(/host name or glob/);
  });

  it('the connection-time lookup enforces the host lists too', async () => {
    const r = await safeFetch(`http://localhost:${site.port}/`, { policy: { ...DEFAULT_POLICY, allowPrivate: true, denyHosts: ['localhost'] }, timeoutMs: 2000 });
    expect(r.error).toMatch(/^Blocked: Host denied by --deny-host localhost/);
  });

  it('a denied, unlisted or wrong-port target is policy-blocked: exit 2 with a hint', async () => {
    const target = `http://localhost:${site.port}/`;
    for (const flags of [['--deny-host', 'localhost'], ['--allow-host', 'example.com'], ['--ports', '1']]) {
      const { code, stderr } = await run(['audit', target, '--allow-private', '--delay', '0', '--out', fs.mkdtempSync(path.join(ws, 'b-')), ...flags]);
      expect(code, flags.join(' ')).toBe(EXIT.usage);
      expect(stderr, flags.join(' ')).toMatch(/blocked by the network policy.*Adjust --allow-host, --deny-host or --ports/s);
    }
  });

  it('a URL on another port is skipped, not reported broken; external links the policy forbids are not checked', async () => {
    const policy = { ...DEFAULT_POLICY, allowPrivate: true, ports: [site.port], denyHosts: ['denied.localhost'] };
    const { report } = await auditWebsite(`http://localhost:${site.port}/`, { workspace: ws, crawl: { policy, delayMs: 0 }, probes: false, checkExternal: true });
    expect(report.crawl.status).toBe('complete');
    const skipped = report.inventory.unfetched!.find((u) => u.url.includes(`:${other.port}/x`));
    expect(skipped).toMatchObject({ reason: 'policy-blocked', detail: expect.stringMatching(/--ports/) });
    expect(report.findings.find((f) => f.ruleId === 'http.fetch-error')).toBeUndefined();
    expect(report.findings.find((f) => f.ruleId === 'links.broken-external')).toBeUndefined();
    expect(report.externalLinks?.skippedByPolicy).toBe(1);
    expect(other.hits.get('/x')).toBeUndefined();
  });

  it('the render policy proxy enforces --deny-host on CONNECT tunnels', async () => {
    const proxy = await startPolicyProxy({ ...DEFAULT_POLICY, allowPrivate: true, denyHosts: ['localhost'] });
    try {
      const auth = `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}\r\n`;
      const connect = (host: string) =>
        new Promise<string>((resolve) => {
          const s = net.connect(Number(new URL(proxy.server).port), '127.0.0.1', () => s.write(`CONNECT ${host}:${site.port} HTTP/1.1\r\nHost: ${host}:${site.port}\r\n${auth}\r\n`));
          let buf = '';
          s.on('data', (d) => {
            buf += d.toString();
            if (buf.includes('\r\n\r\n')) s.destroy();
          });
          s.on('close', () => resolve(buf));
          s.on('error', () => resolve(buf));
        });
      expect(await connect('localhost')).toMatch(/^HTTP\/1\.1 403/);
      expect(await connect('127.0.0.1')).toMatch(/^HTTP\/1\.1 200/);
      expect(proxy.stats.blockedTargets).toContain(`localhost:${site.port}`);
    } finally {
      await proxy.close();
    }
  });

  it('report.json of a policy-blocked target records the reason', async () => {
    const dir = fs.mkdtempSync(path.join(ws, 'rj-'));
    await run(['audit', `http://localhost:${site.port}/`, '--allow-private', '--deny-host', 'localhost', '--out', dir]);
    const id = RunStore.list(dir).at(-1)!;
    expect(new RunStore(dir, id).readJson<AuditReport>('report.json')!.crawl.error).toMatch(/^Blocked: Host denied by --deny-host localhost/);
  });
});
