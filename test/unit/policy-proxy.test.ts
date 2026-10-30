import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPolicyProxy, type PolicyProxy } from '../../src/net/policy-proxy.js';
import { DEFAULT_POLICY } from '../../src/net/ssrf.js';

/** Raw proxy client: sends `head` and returns the first response line plus everything received. */
function rawProxy(proxy: PolicyProxy, head: string, after?: (s: net.Socket) => void): Promise<string> {
  const { port } = new URL(proxy.server);
  return new Promise((resolve) => {
    const s = net.connect(Number(port), '127.0.0.1', () => s.write(head));
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      if (after && buf.includes('\r\n\r\n')) {
        const cb = after;
        after = undefined;
        cb(s);
      }
    });
    s.on('close', () => resolve(buf));
    s.on('error', () => resolve(buf));
    setTimeout(() => s.destroy(), 1500);
  });
}

describe('policy proxy', () => {
  let allowedHttp: http.Server;
  let echo: net.Server;
  let forbidden: http.Server;
  let forbiddenHits = 0;
  let proxy: PolicyProxy;
  let auth: string;
  const port = (s: http.Server | net.Server) => (s.address() as AddressInfo).port;

  beforeAll(async () => {
    allowedHttp = http.createServer((req, res) => {
      if (req.url === '/big') return res.writeHead(200).end(Buffer.alloc(2_000_000, 97));
      if (req.url === '/redirect') return res.writeHead(302, { location: `http://127.0.0.1:${port(forbidden)}/x` }).end();
      res.writeHead(200, { 'content-type': 'text/plain' }).end(`hello ${req.headers['proxy-authorization'] ? 'LEAKED-AUTH' : 'clean'}`);
    });
    echo = net.createServer((s) => s.pipe(s));
    forbidden = http.createServer((_req, res) => {
      forbiddenHits++;
      res.end('SECRET');
    });
    for (const s of [allowedHttp, echo, forbidden]) await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    proxy = await startPolicyProxy({ ...DEFAULT_POLICY, allowPrivate: true, ports: [port(allowedHttp), port(echo)] }, { maxBytesPerWindow: 1_000_000 });
    auth = `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}\r\n`;
  });

  afterAll(async () => {
    await proxy.close();
    for (const s of [allowedHttp, echo, forbidden]) await new Promise<void>((r) => s.close(() => r()));
  });

  it('requires the per-run credentials', async () => {
    const res = await rawProxy(proxy, `GET http://127.0.0.1:${port(allowedHttp)}/ HTTP/1.1\r\nHost: x\r\n\r\n`);
    expect(res).toMatch(/^HTTP\/1\.1 407/);
    const c = await rawProxy(proxy, `CONNECT 127.0.0.1:${port(echo)} HTTP/1.1\r\n\r\n`);
    expect(c).toMatch(/^HTTP\/1\.1 407/);
  });

  it('forwards allowed plain HTTP without leaking proxy credentials upstream', async () => {
    const res = await rawProxy(proxy, `GET http://127.0.0.1:${port(allowedHttp)}/ HTTP/1.1\r\nHost: x\r\n${auth}Connection: close\r\n\r\n`);
    expect(res).toMatch(/^HTTP\/1\.1 200/);
    expect(res).toContain('hello clean');
  });

  it('passes redirects to the browser instead of following them, and blocks the forbidden hop', async () => {
    const res = await rawProxy(proxy, `GET http://127.0.0.1:${port(allowedHttp)}/redirect HTTP/1.1\r\nHost: x\r\n${auth}Connection: close\r\n\r\n`);
    expect(res).toMatch(/^HTTP\/1\.1 302/);
    const hop = await rawProxy(proxy, `GET http://127.0.0.1:${port(forbidden)}/x HTTP/1.1\r\nHost: x\r\n${auth}Connection: close\r\n\r\n`);
    expect(hop).toMatch(/^HTTP\/1\.1 403/);
    expect(forbiddenHits).toBe(0);
  });

  it('tunnels CONNECT only to allowed targets', async () => {
    const ok = await rawProxy(proxy, `CONNECT 127.0.0.1:${port(echo)} HTTP/1.1\r\n${auth}\r\n`, (s) => s.write('ping'));
    expect(ok).toMatch(/^HTTP\/1\.1 200 Connection Established\r\n\r\nping/);
    const denied = await rawProxy(proxy, `CONNECT 127.0.0.1:${port(forbidden)} HTTP/1.1\r\n${auth}\r\n`);
    expect(denied).toMatch(/^HTTP\/1\.1 403/);
    for (const target of ['169.254.169.254:80', 'metadata.internal:80', 'evil host:80', '[::1]:22']) {
      expect(await rawProxy(proxy, `CONNECT ${target} HTTP/1.1\r\n${auth}\r\n`), target).toMatch(/^HTTP\/1\.1 (403|400)/);
    }
    expect(forbiddenHits).toBe(0);
  });

  it('cuts connections that exceed the byte budget of a render', async () => {
    const before = proxy.stats.budgetExceeded;
    proxy.resetBudget();
    const res = await rawProxy(proxy, `GET http://127.0.0.1:${port(allowedHttp)}/big HTTP/1.1\r\nHost: x\r\n${auth}Connection: close\r\n\r\n`);
    expect(res.length).toBeLessThan(1_500_000);
    expect(proxy.stats.budgetExceeded).toBeGreaterThan(before);
  });
});
