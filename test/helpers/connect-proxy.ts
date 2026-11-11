import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

export interface ConnectProxy {
  url: string;
  port: number;
  /** `host:port` of every CONNECT request, in order. */
  connects: string[];
  /** Proxy-Authorization headers received with CONNECT. */
  auth: string[];
  /** Absolute-form requests (`GET http://…`): Searvex must never send them. */
  absoluteRequests: number;
  close: () => Promise<void>;
}

/**
 * A local CONNECT-only forward proxy for tests. Every tunnel goes to `route(host, port)` (default: 127.0.0.1 on
 * the same port), so test names such as `site.example` reach the local test servers.
 */
export async function startConnectProxy(o: { requireAuth?: string; refuse?: number; route?: (host: string, port: number) => { host: string; port: number } } = {}): Promise<ConnectProxy> {
  const connects: string[] = [];
  const auth: string[] = [];
  const sockets = new Set<net.Socket>();
  let absoluteRequests = 0;
  const server = http.createServer((_req, res) => {
    absoluteRequests++;
    res.writeHead(405, { connection: 'close' }).end();
  });
  server.on('connection', (s: net.Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    const target = req.url ?? '';
    connects.push(target);
    const header = req.headers['proxy-authorization'];
    if (header) auth.push(String(header));
    if (o.requireAuth && header !== `Basic ${Buffer.from(o.requireAuth).toString('base64')}`) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="t"\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (o.refuse) {
      client.end(`HTTP/1.1 ${o.refuse} Refused\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(target);
    const host = m?.[1] ?? m?.[2] ?? '';
    const port = Number(m?.[3]);
    const dest = o.route ? o.route(host, port) : { host: '127.0.0.1', port };
    const upstream = net.connect(dest.port, dest.host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    connects,
    auth,
    get absoluteRequests() {
      return absoluteRequests;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
