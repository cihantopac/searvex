import { fetchRobots, type RobotsInfo } from '../crawl/robots.js';
import { HostRateLimiter, safeFetch, type FetchOptions } from '../net/fetcher.js';
import type { FindingSink } from '../rules/engine.js';
import { factsOf, type SiteContext } from './context.js';

export interface ExternalLinkResult {
  checked: number;
  broken: number;
  skippedByRobots: number;
  skippedOverLimit: number;
}

/**
 * Check outbound links with HEAD (falling back to GET when HEAD is not supported).
 * Polite by design: each external host's robots.txt is honoured, requests are rate-limited per
 * host, and the total number of checks is capped.
 */
export async function checkExternalLinks(ctx: SiteContext, sink: FindingSink, opts: FetchOptions & { limit?: number; robotsAgent?: string } = {}): Promise<ExternalLinkResult> {
  const limit = opts.limit ?? 200;
  const sources = new Map<string, string>();
  for (const p of ctx.htmlPages) for (const l of factsOf(p)!.links) if (l.url && !l.internal && !sources.has(l.url)) sources.set(l.url, p.url);
  const urls = [...sources.keys()];
  const robotsCache = new Map<string, RobotsInfo>();
  const limiter = new HostRateLimiter(1000);
  const result: ExternalLinkResult = { checked: 0, broken: 0, skippedByRobots: 0, skippedOverLimit: Math.max(0, urls.length - limit) };
  const queue = urls.slice(0, limit);
  const worker = async () => {
    for (let u = queue.shift(); u; u = queue.shift()) {
      const origin = new URL(u).origin;
      let robots = robotsCache.get(origin);
      if (!robots) robotsCache.set(origin, (robots = await fetchRobots(origin, opts)));
      if (robots.state === 'ok' && !robots.isAllowed(u, opts.robotsAgent ?? 'Searvex')) {
        result.skippedByRobots++;
        continue;
      }
      await limiter.wait(new URL(u).host);
      let res = await safeFetch(u, { ...opts, method: 'HEAD', maxBytes: 1024 });
      if (res.status === 405 || res.status === 501 || res.status === 403) res = await safeFetch(u, { ...opts, maxBytes: 64 * 1024 });
      result.checked++;
      // 401/403/429 often mean bot protection, not a broken link: do not report them as broken.
      if (res.error || res.status === 404 || res.status === 410 || res.status >= 500) {
        result.broken++;
        sink.emit('links.broken-external', { url: u, observed: `${res.error ?? 'HTTP ' + res.status} (linked from ${sources.get(u)})` });
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return result;
}
