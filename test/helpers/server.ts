import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Route {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** Redirect target (sets Location and defaults status to 301). */
  redirect?: string;
  delayMs?: number;
}

export interface TestServer {
  url: string;
  port: number;
  hits: Map<string, number>;
  userAgents: string[];
  close: () => Promise<void>;
}

/** Programmable HTTP server for integration tests (binds to 127.0.0.1 on a random port). */
export async function startServer(routes: Record<string, Route | ((req: http.IncomingMessage) => Route)>): Promise<TestServer> {
  const hits = new Map<string, number>();
  const userAgents: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const key = url.pathname + url.search;
    hits.set(key, (hits.get(key) ?? 0) + 1);
    userAgents.push(String(req.headers['user-agent'] ?? ''));
    const def = routes[key] ?? routes[url.pathname];
    const r = typeof def === 'function' ? def(req) : def;
    const send = () => {
      if (!r) {
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('<html><head><title>Not found</title></head><body>404</body></html>');
        return;
      }
      const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8', ...r.headers };
      if (r.redirect) headers['location'] = r.redirect;
      res.writeHead(r.status ?? (r.redirect ? 301 : 200), headers);
      res.end(r.body ?? '');
    };
    if (r?.delayMs) setTimeout(send, r.delayMs);
    else send();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    hits,
    userAgents,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export function page(o: { title?: string; head?: string; body?: string; lang?: string | null }): string {
  const lang = o.lang === null ? '' : ` lang="${o.lang ?? 'en'}"`;
  return `<!doctype html><html${lang}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${o.title !== undefined ? `<title>${o.title}</title>` : ''}${o.head ?? ''}</head><body>${o.body ?? ''}</body></html>`;
}

const LOREM =
  'Our team designs durable equipment for professional kitchens. Every product is tested in real restaurants before release, and we publish the results so buyers can compare options with confidence. ';

export function text(words = 160): string {
  return `<p>${LOREM.repeat(Math.ceil(words / 30)).split(' ').slice(0, words).join(' ')}</p>`;
}
