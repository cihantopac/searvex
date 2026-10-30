import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Duplex, Readable } from 'node:stream';
import { guardedLookup } from './fetcher.js';
import { assertUrlAllowed, BlockedUrlError, type NetPolicy } from './ssrf.js';

/**
 * Local forward proxy that enforces the SSRF policy for the headless browser (`--render`).
 *
 * Request interception inside the browser cannot see every connection: redirect hops after the first
 * request, WebSockets and the first request of a popup bypass `page.route()`, and the browser resolves DNS
 * itself (a rebinding window). Routing all browser traffic through this proxy closes those gaps:
 * - every plain HTTP request, every redirect hop (the browser re-requests the Location through the proxy),
 *   every CONNECT tunnel (HTTPS, WSS, WS) and every upgrade is checked against the policy;
 * - hostnames are resolved by the proxy with the same connection-time `guardedLookup` as the crawler, so
 *   the address that is validated is the address that is connected to;
 * - the proxy listens on 127.0.0.1 only and requires random per-run credentials, so other local processes
 *   cannot use it;
 * - a byte budget and idle timeouts bound what one render can transfer.
 */
export interface PolicyProxyStats {
  requests: number;
  tunnels: number;
  blocked: number;
  blockedTargets: string[];
  bytes: number;
  budgetExceeded: number;
}

export interface PolicyProxy {
  server: string;
  username: string;
  password: string;
  stats: PolicyProxyStats;
  /** Start a new byte budget window (one per rendered page). */
  resetBudget: () => void;
  close: () => Promise<void>;
}

export interface PolicyProxyOptions {
  /** Bytes allowed per budget window across all connections (default 64 MiB). */
  maxBytesPerWindow?: number;
  /** Idle timeout for any socket (default 30 s). */
  idleTimeoutMs?: number;
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authorization', 'proxy-authenticate', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

export async function startPolicyProxy(policy: NetPolicy, opts: PolicyProxyOptions = {}): Promise<PolicyProxy> {
  const maxBytes = opts.maxBytesPerWindow ?? 64 * 1024 * 1024;
  const idle = opts.idleTimeoutMs ?? 30000;
  const username = 'searvex';
  const password = crypto.randomBytes(18).toString('base64url');
  const expectedAuth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const stats: PolicyProxyStats = { requests: 0, tunnels: 0, blocked: 0, blockedTargets: [], bytes: 0, budgetExceeded: 0 };
  const sockets = new Set<Duplex>();
  let windowBytes = 0;

  const track = (s: Duplex) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    if (s instanceof net.Socket) s.setTimeout(idle, () => s.destroy());
  };
  /** Count bytes; when the window budget is exhausted, cut the connection. */
  const meter = (s: Readable, peer: { destroy: () => unknown }) => {
    s.on('data', (chunk: Buffer) => {
      stats.bytes += chunk.length;
      windowBytes += chunk.length;
      if (windowBytes > maxBytes) {
        stats.budgetExceeded++;
        s.destroy();
        peer.destroy();
      }
    });
  };
  const block = (target: string) => {
    stats.blocked++;
    if (stats.blockedTargets.length < 20 && !stats.blockedTargets.includes(target)) stats.blockedTargets.push(target);
  };
  const authorized = (req: http.IncomingMessage) => req.headers['proxy-authorization'] === expectedAuth;
  const rawDeny = (socket: Duplex, status: string, extra = '') => {
    socket.end(`HTTP/1.1 ${status}\r\n${extra}Content-Length: 0\r\nConnection: close\r\n\r\n`);
  };
  /** Validate a target; returns the parsed URL or null (after recording the block). */
  const allowed = (raw: string): URL | null => {
    try {
      return assertUrlAllowed(raw, policy);
    } catch {
      let target = raw;
      try {
        target = new URL(raw).host;
      } catch {
        /* keep raw */
      }
      block(target);
      return null;
    }
  };

  const server = http.createServer((req, res) => {
    stats.requests++;
    if (!authorized(req)) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="searvex"', connection: 'close' }).end();
      return;
    }
    const u = req.url && /^http:\/\//i.test(req.url) ? allowed(req.url) : null;
    if (!u) {
      res.writeHead(403, { connection: 'close' }).end();
      return;
    }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, val] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k.toLowerCase()) && val !== undefined) headers[k] = val;
    const upstream = http.request(
      { host: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || 80, path: `${u.pathname}${u.search}`, method: req.method, headers, lookup: guardedLookup(policy), agent: false, timeout: idle },
      (up) => {
        const out: http.OutgoingHttpHeaders = {};
        for (const [k, val] of Object.entries(up.headers)) if (!HOP_BY_HOP.has(k.toLowerCase()) && val !== undefined) out[k] = val;
        res.writeHead(up.statusCode ?? 502, out);
        meter(up, res.socket ?? up);
        up.pipe(res);
      },
    );
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', (e) => {
      if (e instanceof BlockedUrlError) block(u.host);
      if (!res.headersSent) res.writeHead(e instanceof BlockedUrlError ? 403 : 502, { connection: 'close' });
      res.end();
    });
    req.pipe(upstream);
  });

  const tunnel = (target: URL, client: Duplex, head: Buffer, preamble: string | null) => {
    stats.tunnels++;
    track(client);
    const host = target.hostname.replace(/^\[|\]$/g, '');
    const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
    const upstream = net.connect({ host, port, lookup: guardedLookup(policy) });
    track(upstream);
    upstream.on('connect', () => {
      if (preamble === null) client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      else upstream.write(preamble);
      if (head.length) upstream.write(head);
      meter(upstream, client);
      meter(client, upstream);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', (e) => {
      if (e instanceof BlockedUrlError) block(target.host);
      if (client.writable) rawDeny(client, e instanceof BlockedUrlError ? '403 Forbidden' : '502 Bad Gateway');
      client.destroy();
    });
    client.on('error', () => upstream.destroy());
  };

  // CONNECT host:port — HTTPS, WSS and (in Chromium) WS through the proxy.
  server.on('connect', (req: http.IncomingMessage, client: Duplex, head: Buffer) => {
    stats.requests++;
    if (!authorized(req)) return rawDeny(client, '407 Proxy Authentication Required', 'Proxy-Authenticate: Basic realm="searvex"\r\n');
    const hostPort = req.url ?? '';
    // The tunnel carries TLS or WebSocket frames; validate host and port as an https URL on that port.
    const u = /^[\w.-]+:\d+$|^\[[0-9a-f:.]+\]:\d+$/i.test(hostPort) ? allowed(`https://${hostPort}/`) : (block(hostPort), null);
    if (!u) return rawDeny(client, '403 Forbidden');
    tunnel(u, client, head, null);
  });

  // Absolute-URI upgrade requests (ws:// without CONNECT): validate, then replay the request upstream.
  server.on('upgrade', (req: http.IncomingMessage, client: Duplex, head: Buffer) => {
    stats.requests++;
    if (!authorized(req)) return rawDeny(client, '407 Proxy Authentication Required', 'Proxy-Authenticate: Basic realm="searvex"\r\n');
    const u = req.url && /^(http|ws):\/\//i.test(req.url) ? allowed(req.url.replace(/^ws:/i, 'http:')) : null;
    if (!u) return rawDeny(client, '403 Forbidden');
    const lines = [`${req.method} ${u.pathname}${u.search} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) if (!/^proxy-/i.test(req.rawHeaders[i]!)) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    tunnel(u, client, head, lines.join('\r\n') + '\r\n\r\n');
  });

  server.on('connection', (s: net.Socket) => track(s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    server: `http://127.0.0.1:${port}`,
    username,
    password,
    stats,
    resetBudget: () => {
      windowBytes = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
