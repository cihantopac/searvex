import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuditReport } from '../../src/analyze/audit.js';
import { EXIT, main, policyFrom } from '../../src/cli.js';
import { RunStore } from '../../src/crawl/store.js';
import { safeFetch } from '../../src/net/fetcher.js';
import { startPolicyProxy } from '../../src/net/policy-proxy.js';
import { noProxyMatches, ProxyConfigError, proxyFromConfig, routeFor, type UpstreamProxy } from '../../src/net/proxy.js';
import { DEFAULT_POLICY, type NetPolicy } from '../../src/net/ssrf.js';
import { startConnectProxy, type ConnectProxy } from '../helpers/connect-proxy.js';
import { page, startServer, text, type TestServer } from '../helpers/server.js';

let site: TestServer;
let proxy: ConnectProxy;
let ws: string;
let cfg: string;

/** `site.example` is a reserved name: local DNS cannot resolve it, the test proxy routes it to the local server. */
const upstream = (o: Partial<UpstreamProxy> = {}): UpstreamProxy => ({ protocol: 'http:', host: '127.0.0.1', port: proxy.port, resolve: 'proxy', allowUnresolved: true, noProxy: [], source: '--proxy', ...o });
const via = (o: Partial<UpstreamProxy> = {}, p: Partial<NetPolicy> = {}): NetPolicy => ({ ...DEFAULT_POLICY, ...p, upstream: upstream(o) });

const run = async (argv: string[], env: Record<string, string> = {}) => {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const spies = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(process.stdout, 'write').mockImplementation(() => true), vi.spyOn(process.stderr, 'write').mockImplementation(() => true)];
  try {
    const code = await main(argv);
    return { code, stderr: err.mock.calls.map((c) => c.join(' ')).join('\n') };
  } finally {
    err.mockRestore();
    for (const s of spies) s.mockRestore();
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

beforeAll(async () => {
  site = await startServer({
    '/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nAllow: /\n' },
    '/': { body: page({ title: 'Home page behind the proxy', body: `<h1>Home</h1>${text(200)}<a href="/a">a</a>` }) },
    '/a': { body: page({ title: 'Page A behind the proxy', body: `<h1>A</h1>${text(200)}` }) },
  });
  proxy = await startConnectProxy();
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-proxy-'));
  cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-proxy-cfg-'));
  process.env['SEARVEX_CONFIG_DIR'] = cfg;
});

afterAll(async () => {
  await site.close();
  await proxy.close();
  delete process.env['SEARVEX_CONFIG_DIR'];
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(cfg, { recursive: true, force: true });
});

describe('E1: proxy configuration', () => {
  it('--proxy wins over the environment; HTTPS_PROXY before HTTP_PROXY; none ignores both', () => {
    const env = { HTTPS_PROXY: 'http://secure.proxy:3128', HTTP_PROXY: 'http://plain.proxy:8080', NO_PROXY: 'intranet.example, .corp:8443' };
    expect(proxyFromConfig({ env })).toMatchObject({ host: 'secure.proxy', port: 3128, source: 'HTTPS_PROXY', noProxy: ['intranet.example', '.corp:8443'], resolve: 'proxy', allowUnresolved: false });
    expect(proxyFromConfig({ env: { http_proxy: 'plain.proxy:8080' } })).toMatchObject({ host: 'plain.proxy', port: 8080, protocol: 'http:', source: 'http_proxy' });
    expect(proxyFromConfig({ flag: 'https://user:p%40ss@flag.proxy', env })).toMatchObject({ host: 'flag.proxy', port: 443, protocol: 'https:', auth: 'user:p@ss', source: '--proxy' });
    expect(proxyFromConfig({ flag: 'none', env })).toBeNull();
    expect(proxyFromConfig({ env: {} })).toBeNull();
    expect(proxyFromConfig({ flag: 'http://p:1', resolve: 'local' })).toMatchObject({ resolve: 'local', allowUnresolved: false });
    expect(proxyFromConfig({ flag: 'http://p:1', resolve: 'proxy' })).toMatchObject({ resolve: 'proxy', allowUnresolved: true });
  });

  it('rejects unusable proxies, naming where they came from', () => {
    expect(() => proxyFromConfig({ env: { HTTPS_PROXY: 'http://169.254.169.254:80' } })).toThrow(/HTTPS_PROXY points at a link-local address/);
    expect(() => proxyFromConfig({ flag: 'socks5://p:1080' })).toThrow(/only http:\/\/ and https:\/\//);
    expect(() => proxyFromConfig({ flag: 'http://p:3128/path' })).toThrow(/no path/);
    expect(() => proxyFromConfig({ flag: 'http://bad.proxy:3128', policy: { denyHosts: ['*.proxy'] } })).toThrow(/--deny-host/);
    expect(() => proxyFromConfig({ flag: 'http://p:1', resolve: 'dns' })).toThrow(ProxyConfigError);
    expect(() => proxyFromConfig({ resolve: 'local', env: {} })).toThrow(/needs a proxy/);
    expect(() => policyFrom({ proxy: 'ftp://x' }, {})).toThrow(/only http/);
  });

  it('NO_PROXY: suffixes, exact hosts, ports, IPs and *', () => {
    const list = ['example.com', '.corp', 'api.test:8443', '10.0.0.5', '[::1]:80'];
    expect(noProxyMatches('example.com', 443, list)).toBe(true);
    expect(noProxyMatches('www.example.com', 443, list)).toBe(true);
    expect(noProxyMatches('notexample.com', 443, list)).toBe(false);
    expect(noProxyMatches('intra.corp', 80, list)).toBe(true);
    expect(noProxyMatches('api.test', 8443, list)).toBe(true);
    expect(noProxyMatches('api.test', 443, list)).toBe(false);
    expect(noProxyMatches('10.0.0.5', 80, list)).toBe(true);
    expect(noProxyMatches('[::1]', 80, list)).toBe(true);
    expect(noProxyMatches('anything', 1, ['*'])).toBe(true);
  });
});

describe('E1: routing before CONNECT', () => {
  const lookup = (answers: Record<string, string[]>) => async (h: string) => {
    if (!answers[h]) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${h}`), { code: 'ENOTFOUND' });
    return answers[h]!;
  };
  const dnsAnswers = lookup({ 'public.example': ['93.184.216.34'], 'internal.example': ['10.1.2.3'], 'mixed.example': ['93.184.216.34', '127.0.0.1'] });

  it('public names go through the proxy by name, or by address with --proxy-resolve local', async () => {
    expect(await routeFor('public.example', 443, via({ allowUnresolved: false }), dnsAnswers)).toMatchObject({ via: 'proxy', connectHost: 'public.example', checked: true });
    expect(await routeFor('public.example', 443, via({ resolve: 'local', allowUnresolved: false }), dnsAnswers)).toMatchObject({ via: 'proxy', connectHost: '93.184.216.34' });
    expect(await routeFor('93.184.216.34', 80, via(), dnsAnswers)).toMatchObject({ via: 'proxy', connectHost: '93.184.216.34' });
  });

  it('private targets never go through the proxy: blocked, or direct with --allow-private', async () => {
    await expect(routeFor('internal.example', 443, via(), dnsAnswers)).rejects.toThrow(/Resolved address not allowed \(private\)/);
    await expect(routeFor('mixed.example', 443, via(), dnsAnswers)).rejects.toThrow(/loopback/);
    expect(await routeFor('internal.example', 443, via({}, { allowPrivate: true }), dnsAnswers)).toEqual({ via: 'direct' });
    expect(await routeFor('10.1.2.3', 443, via(), dnsAnswers)).toEqual({ via: 'direct' });
    expect(await routeFor('127.0.0.1', 80, via(), dnsAnswers)).toEqual({ via: 'direct' });
  });

  it('names local DNS cannot resolve fail, unless --proxy-resolve proxy was passed', async () => {
    await expect(routeFor('nowhere.example', 443, via({ allowUnresolved: false }), dnsAnswers)).rejects.toThrow(/ENOTFOUND/);
    expect(await routeFor('nowhere.example', 443, via({ allowUnresolved: true }), dnsAnswers)).toMatchObject({ via: 'proxy', connectHost: 'nowhere.example', checked: false });
    await expect(routeFor('nowhere.example', 443, via({ resolve: 'local', allowUnresolved: false }), dnsAnswers)).rejects.toThrow(/ENOTFOUND/);
  });

  it('NO_PROXY and no proxy at all mean direct', async () => {
    expect(await routeFor('public.example', 443, via({ noProxy: ['.example'] }), dnsAnswers)).toEqual({ via: 'direct' });
    expect(await routeFor('public.example', 443, DEFAULT_POLICY, dnsAnswers)).toEqual({ via: 'direct' });
  });
});

describe('E1: requests through the proxy', () => {
  it('http targets use CONNECT, never absolute-form requests', async () => {
    const before = proxy.connects.length;
    const r = await safeFetch(`http://site.example:${site.port}/a`, { policy: via(), timeoutMs: 5000 });
    expect(r.status).toBe(200);
    expect(r.body).toMatch(/Page A behind the proxy/);
    expect(proxy.connects.slice(before)).toEqual([`site.example:${site.port}`]);
    expect(proxy.absoluteRequests).toBe(0);
  });

  it('https targets use CONNECT too and run TLS end to end', async () => {
    const raw = net.createServer((s) => s.destroy());
    await new Promise<void>((r) => raw.listen(0, '127.0.0.1', r));
    const port = (raw.address() as net.AddressInfo).port;
    try {
      const before = proxy.connects.length;
      const r = await safeFetch(`https://site.example:${port}/`, { policy: via(), timeoutMs: 5000 });
      expect(r.error).toBeTruthy(); // the fixture is not a TLS server: the handshake inside the tunnel fails
      expect(r.error).not.toMatch(/^Proxy/);
      expect(proxy.connects.slice(before)).toEqual([`site.example:${port}`]);
      expect(proxy.absoluteRequests).toBe(0);
    } finally {
      raw.close();
    }
  });

  it('private and local targets stay off the proxy', async () => {
    const before = proxy.connects.length;
    expect((await safeFetch(`http://127.0.0.1:${site.port}/`, { policy: via({}, { allowPrivate: true }), timeoutMs: 3000 })).status).toBe(200);
    expect((await safeFetch(`http://localhost:${site.port}/`, { policy: via(), timeoutMs: 3000 })).error).toMatch(/^Blocked: Local hostname/);
    expect((await safeFetch(`http://127.0.0.1:${site.port}/`, { policy: via(), timeoutMs: 3000 })).error).toMatch(/^Blocked: Address not allowed/);
    expect(proxy.connects.length).toBe(before);
  });

  it('Basic authentication; 407, refusal and an unreachable proxy are reported as proxy errors', async () => {
    const guarded = await startConnectProxy({ requireAuth: 'user:s3cret' });
    const refusing = await startConnectProxy({ refuse: 403 });
    const closed = await startConnectProxy();
    await closed.close();
    try {
      const ok = await safeFetch(`http://site.example:${site.port}/`, { policy: via({ port: guarded.port, auth: 'user:s3cret' }), timeoutMs: 5000 });
      expect(ok.status).toBe(200);
      expect(guarded.auth).toEqual([`Basic ${Buffer.from('user:s3cret').toString('base64')}`]);
      expect((await safeFetch(`http://site.example:${site.port}/`, { policy: via({ port: guarded.port }), timeoutMs: 5000 })).error).toMatch(/^Proxy authentication failed \(127\.0\.0\.1:\d+, HTTP 407\)/);
      expect((await safeFetch(`http://site.example:${site.port}/`, { policy: via({ port: refusing.port }), timeoutMs: 5000 })).error).toMatch(/^Proxy refused CONNECT to site\.example:\d+ \(HTTP 403, proxy 127\.0\.0\.1:\d+\)/);
      expect((await safeFetch(`http://site.example:${site.port}/`, { policy: via({ port: closed.port }), timeoutMs: 5000 })).error).toMatch(/^Proxy unreachable \(127\.0\.0\.1:\d+\): ECONNREFUSED/);
    } finally {
      await guarded.close();
      await refusing.close();
    }
  });

  it('the --render policy proxy tunnels its upstream connections through the proxy', async () => {
    const pp = await startPolicyProxy(via());
    try {
      const before = proxy.connects.length;
      const auth = `Proxy-Authorization: Basic ${Buffer.from(`${pp.username}:${pp.password}`).toString('base64')}\r\n`;
      const reply = await new Promise<string>((resolve) => {
        const s = net.connect(Number(new URL(pp.server).port), '127.0.0.1', () => s.write(`GET http://site.example:${site.port}/a HTTP/1.1\r\nHost: site.example:${site.port}\r\n${auth}Connection: close\r\n\r\n`));
        let buf = '';
        s.on('data', (d) => (buf += d.toString()));
        s.on('close', () => resolve(buf));
        s.on('error', () => resolve(buf));
      });
      expect(reply).toMatch(/^HTTP\/1\.1 200/);
      expect(reply).toMatch(/Page A behind the proxy/);
      expect(proxy.connects.slice(before)).toEqual([`site.example:${site.port}`]);
    } finally {
      await pp.close();
    }
  });
});

describe('E1: CLI', () => {
  const latest = (dir: string) => new RunStore(dir, RunStore.list(dir).at(-1)!);

  it('audits through --proxy, records the endpoint and never writes credentials', async () => {
    const guarded = await startConnectProxy({ requireAuth: 'user:s3cret' });
    try {
      const dir = fs.mkdtempSync(path.join(ws, 'cli-'));
      const { code } = await run(['audit', `http://site.example:${site.port}/`, '--proxy', `http://user:s3cret@127.0.0.1:${guarded.port}`, '--proxy-resolve', 'proxy', '--delay', '0', '--out', dir, '--progress', 'ndjson']);
      expect(code).toBe(EXIT.ok);
      const store = latest(dir);
      const report = store.readJson<AuditReport>('report.json')!;
      expect(report.crawl).toMatchObject({ status: 'complete', fetched: 2, proxy: { endpoint: `127.0.0.1:${guarded.port}`, resolve: 'proxy', unresolvedAllowed: true } });
      expect(report.limitations.join(' ')).toMatch(/upstream proxy 127\.0\.0\.1:\d+ \(CONNECT only\).*unchecked/);
      const runDir = path.dirname(store.file('report.json'));
      for (const f of fs.readdirSync(runDir)) expect(fs.readFileSync(path.join(runDir, f), 'utf8'), f).not.toMatch(/s3cret|dXNlcjpzM2NyZXQ/);
    } finally {
      await guarded.close();
    }
  });

  it('HTTPS_PROXY from the environment, and --proxy none to ignore it', async () => {
    const before = proxy.connects.length;
    const dir = fs.mkdtempSync(path.join(ws, 'env-'));
    expect((await run(['audit', `http://site.example:${site.port}/`, '--proxy-resolve', 'proxy', '--delay', '0', '--out', dir, '--quiet'], { HTTP_PROXY: proxy.url })).code).toBe(EXIT.ok);
    expect(proxy.connects.length).toBeGreaterThan(before);
    const after = proxy.connects.length;
    const none = await run(['audit', `http://site.example:${site.port}/`, '--proxy', 'none', '--delay', '0', '--timeout', '2000', '--out', fs.mkdtempSync(path.join(ws, 'none-')), '--quiet'], { HTTP_PROXY: proxy.url });
    expect(none.code).toBe(EXIT.unreachable); // direct: site.example does not resolve
    expect(proxy.connects.length).toBe(after);
  });

  it('exit codes: wrong credentials 2, unreachable proxy 3, refused CONNECT 4', async () => {
    const guarded = await startConnectProxy({ requireAuth: 'user:s3cret' });
    const refusing = await startConnectProxy({ refuse: 403 });
    const closed = await startConnectProxy();
    await closed.close();
    try {
      const target = `http://site.example:${site.port}/`;
      const common = ['--proxy-resolve', 'proxy', '--delay', '0', '--timeout', '3000', '--quiet'];
      const auth = await run(['audit', target, '--proxy', `http://user:wrong@127.0.0.1:${guarded.port}`, ...common, '--out', fs.mkdtempSync(path.join(ws, 'a-'))]);
      expect(auth.code).toBe(EXIT.usage);
      expect(auth.stderr).toMatch(/Proxy authentication failed/);
      expect(auth.stderr).not.toMatch(/wrong/);
      const down = await run(['audit', target, '--proxy', `http://127.0.0.1:${closed.port}`, ...common, '--out', fs.mkdtempSync(path.join(ws, 'd-'))]);
      expect(down.code).toBe(EXIT.runtime);
      expect(down.stderr).toMatch(/Proxy unreachable/);
      const refused = await run(['audit', target, '--proxy', `http://127.0.0.1:${refusing.port}`, ...common, '--out', fs.mkdtempSync(path.join(ws, 'r-'))]);
      expect(refused.code).toBe(EXIT.unreachable);
      expect(refused.stderr).toMatch(/target unreachable: Proxy refused CONNECT/);
    } finally {
      await guarded.close();
      await refusing.close();
    }
  });

  it('rejects a link-local proxy from the environment as a usage error', async () => {
    const { code, stderr } = await run(['audit', `http://site.example:${site.port}/`, '--out', ws, '--quiet'], { HTTPS_PROXY: 'http://169.254.169.254' });
    expect(code).toBe(EXIT.usage);
    expect(stderr).toMatch(/HTTPS_PROXY points at a link-local address/);
  });
});
