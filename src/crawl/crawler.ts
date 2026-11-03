import type { FetchResult, RedirectHop } from '../core/types.js';
import { looksLikeAsset, mapOrigin, normalizeUrl, originMap, pathDepth, type OriginMap } from '../core/url.js';
import { extractPage, parseXRobotsTag, type PageData } from '../extract/html.js';
import { DEFAULT_USER_AGENT, HostRateLimiter, safeFetch } from '../net/fetcher.js';
import { DEFAULT_POLICY, type NetPolicy } from '../net/ssrf.js';
import { collectSitemaps, type SitemapResult } from './sitemap.js';
import { fetchRobots, type RobotsInfo } from './robots.js';
import { RunStore } from './store.js';

export interface CrawlOptions {
  maxPages: number;
  maxDepth: number;
  concurrency: number;
  /** Minimum delay between requests to the same host. Raised automatically by robots.txt crawl-delay. */
  delayMs: number;
  timeoutMs: number;
  useSitemaps: boolean;
  include?: RegExp[];
  exclude?: RegExp[];
  policy: NetPolicy;
  userAgent: string;
  /** Robots group used for allow/disallow decisions. */
  robotsAgent: string;
  /** Optional JS renderer (see render.ts). */
  render?: (url: string) => Promise<{ html: string; error?: string }>;
  onProgress?: (p: { crawled: number; queued: number; url: string; status: number }) => void;
  /** Persist progress every N pages. */
  checkpointEvery: number;
  /**
   * Public URL of the site when it is crawled at another origin (local or staging build). URLs the pages
   * declare on that origin are mapped to the crawled origin (see `mapOrigin`).
   */
  siteUrl?: string;
}

export const DEFAULT_CRAWL: CrawlOptions = {
  maxPages: 500,
  maxDepth: 10,
  concurrency: 4,
  delayMs: 250,
  timeoutMs: 15000,
  useSitemaps: true,
  policy: DEFAULT_POLICY,
  userAgent: DEFAULT_USER_AGENT,
  robotsAgent: 'SearvexBot',
  checkpointEvery: 25,
};

export interface PageRecord {
  url: string;
  finalUrl: string;
  status: number;
  depth: number;
  redirects: RedirectHop[];
  contentType: string;
  timingMs: number;
  ttfbMs?: number;
  bytes: number;
  truncated: boolean;
  headers: Record<string, string>;
  xRobots: string[];
  xRobotsByBot: Record<string, string[]>;
  error?: string;
  blockedByRobots: boolean;
  inSitemap: boolean;
  foundOn?: string;
  data?: PageData;
  /** Present when JS rendering ran: facts extracted from the rendered DOM. */
  rendered?: PageData;
  renderError?: string;
}

export interface CrawlResult {
  runId: string;
  startUrl: string;
  origin: string;
  robots: RobotsInfo;
  sitemap: SitemapResult;
  pages: PageRecord[];
  startedAt: string;
  finishedAt: string;
  stats: { crawled: number; queuedRemaining: number; blocked: number; errors: number; durationMs: number; avgResponseMs: number };
  /** True when the crawl stopped because maxPages was reached with URLs still queued. */
  truncated: boolean;
  /**
   * Set when the start URL failed at the network level (DNS, TCP, TLS, or blocked by the network policy)
   * and nothing was crawled: the run says nothing about the site.
   */
  unreachable?: { error: string; blocked: boolean };
  /** Public origin mapped to `origin` (from --site-url); absent when no mapping applied. */
  siteUrl?: string;
}

interface QueueItem {
  url: string;
  depth: number;
  foundOn?: string;
}

interface Checkpoint {
  queue: QueueItem[];
  seen: string[];
}

const KEPT_HEADERS = ['content-type', 'x-robots-tag', 'content-language', 'last-modified', 'cache-control', 'link', 'location', 'retry-after', 'strict-transport-security', 'vary', 'content-encoding'];

function pickHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of KEPT_HEADERS) if (h[k]) out[k] = h[k]!.slice(0, 1000);
  return out;
}

/** Rewrite the public URLs a page declares (canonical, hreflang, links) to the crawled origin. */
export function mapPageData(d: PageData, map: OriginMap | undefined): PageData {
  if (!map) return d;
  const to = new URL(map.to).hostname.replace(/^www\./, '');
  const m = (u: string) => mapOrigin(u, map);
  return {
    ...d,
    canonical: d.canonical && m(d.canonical),
    hreflang: d.hreflang.map((h) => ({ ...h, href: m(h.href) })),
    links: d.links.map((l) => {
      if (!l.url) return l;
      const url = m(l.url);
      return url === l.url ? l : { ...l, url, internal: new URL(url).hostname.replace(/^www\./, '') === to };
    }),
  };
}

function inScope(url: string, rootHost: string, opts: CrawlOptions): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.hostname.replace(/^www\./, '') !== rootHost) return false;
  if (looksLikeAsset(url)) return false;
  // Cloudflare service endpoints (email obfuscation, challenges) are not site content.
  if (u.pathname.startsWith('/cdn-cgi/')) return false;
  if (opts.include?.length && !opts.include.some((r) => r.test(url))) return false;
  if (opts.exclude?.some((r) => r.test(url))) return false;
  return true;
}

export async function crawl(startUrl: string, partial: Partial<CrawlOptions> = {}, store?: RunStore): Promise<CrawlResult> {
  const opts: CrawlOptions = { ...DEFAULT_CRAWL, ...partial };
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const start = normalizeUrl(startUrl);
  if (!start) throw new Error(`Invalid start URL: ${startUrl}`);
  const origin = new URL(start).origin;
  const rootHost = new URL(start).hostname.replace(/^www\./, '');
  const fetchOpts = { policy: opts.policy, timeoutMs: opts.timeoutMs, userAgent: opts.userAgent };
  const map = originMap(opts.siteUrl, start);

  const robots = await fetchRobots(origin, fetchOpts);
  // A network-level robots.txt failure makes every URL disallowed (RFC 9309), so the start URL would never
  // be fetched. Probe it directly: if it fails too, the target itself is unreachable, not the site broken.
  if (robots.state === 'unreachable' && robots.error) {
    const probe = await safeFetch(start, { ...fetchOpts, maxBytes: 64 * 1024 });
    if (probe.error) {
      const unreachable = { error: probe.error, blocked: probe.error.startsWith('Blocked: ') };
      const result: CrawlResult = {
        runId: store?.runId ?? 'ephemeral',
        startUrl: start,
        origin,
        robots,
        sitemap: { sitemaps: [], urls: [], issues: [] },
        pages: [],
        startedAt,
        finishedAt: new Date().toISOString(),
        stats: { crawled: 0, queuedRemaining: 0, blocked: 0, errors: 0, durationMs: Date.now() - t0, avgResponseMs: 0 },
        truncated: false,
        unreachable,
      };
      store?.writeJson('meta.json', { runId: store.runId, kind: 'crawl', startUrl: start, startedAt, unreachable });
      return result;
    }
  }
  const limiter = new HostRateLimiter(opts.delayMs);
  const delay = robots.crawlDelay(opts.robotsAgent);
  if (delay && delay > 0) limiter.setDelay(new URL(origin).host, Math.min(delay, 30) * 1000);

  const sitemapSeeds = robots.sitemaps.length ? robots.sitemaps : [new URL('/sitemap.xml', origin).toString()];
  // Sitemap downloads share the per-host politeness limiter with page fetches.
  const sitemap: SitemapResult = opts.useSitemaps ? await collectSitemaps(sitemapSeeds, { ...fetchOpts, limiter, mapUrl: (u) => mapOrigin(u, map) }) : { sitemaps: [], urls: [], issues: [] };
  const sitemapSet = new Set(sitemap.urls.map((u) => normalizeUrl(u.loc)).filter((x): x is string => !!x));

  // Resume support
  const existing = store?.readLines<PageRecord>('pages.jsonl') ?? [];
  const checkpoint = store?.readJson<Checkpoint>('checkpoint.json');
  const pages: PageRecord[] = [...existing];
  const seen = new Set<string>(checkpoint?.seen ?? []);
  for (const p of existing) seen.add(p.url);
  const queue: QueueItem[] = checkpoint?.queue ?? [];
  const enqueue = (item: QueueItem) => {
    const n = normalizeUrl(item.url);
    if (!n || seen.has(n) || item.depth > opts.maxDepth || !inScope(n, rootHost, opts)) return;
    seen.add(n);
    queue.push({ ...item, url: n });
  };
  if (!checkpoint) {
    enqueue({ url: start, depth: 0 });
    for (const u of sitemapSet) enqueue({ url: u, depth: Math.max(1, pathDepth(u)), foundOn: 'sitemap' });
  }
  store?.writeJson('meta.json', { runId: store.runId, kind: 'crawl', startUrl: start, startedAt, options: { ...opts, policy: undefined, render: !!opts.render, onProgress: undefined } });

  let crawledThisRun = 0;
  const persist = () => store?.writeJson('checkpoint.json', { queue, seen: [...seen] } satisfies Checkpoint);

  const processItem = async (item: QueueItem): Promise<void> => {
    const host = new URL(item.url).host;
    const blocked = !robots.isAllowed(item.url, opts.robotsAgent);
    if (blocked) {
      const rec: PageRecord = {
        url: item.url, finalUrl: item.url, status: 0, depth: item.depth, redirects: [], contentType: '', timingMs: 0, bytes: 0, truncated: false,
        headers: {}, xRobots: [], xRobotsByBot: {}, blockedByRobots: true, inSitemap: sitemapSet.has(item.url), foundOn: item.foundOn,
      };
      pages.push(rec);
      store?.append('pages.jsonl', rec);
      return;
    }
    await limiter.wait(host);
    const res: FetchResult = await safeFetch(item.url, fetchOpts);
    if (res.status === 429 || res.status === 503) {
      const ra = Number(res.headers['retry-after']);
      limiter.setDelay(host, Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) * 1000 : opts.delayMs * 4);
    }
    const xr = parseXRobotsTag(res.headers['x-robots-tag']);
    const rec: PageRecord = {
      url: item.url,
      finalUrl: res.finalUrl,
      status: res.status,
      depth: item.depth,
      redirects: res.redirects,
      contentType: res.contentType,
      timingMs: res.timingMs,
      ttfbMs: res.ttfbMs,
      bytes: res.bodyBytes,
      truncated: res.truncated,
      headers: pickHeaders(res.headers),
      xRobots: xr.all,
      xRobotsByBot: xr.byBot,
      error: res.error,
      blockedByRobots: false,
      inSitemap: sitemapSet.has(item.url),
      foundOn: item.foundOn,
    };
    const isHtml = /html/i.test(res.contentType) || (!res.contentType && /^\s*</.test(res.body));
    if (!res.error && isHtml && res.body) {
      rec.data = mapPageData(extractPage(res.body, res.finalUrl), map);
      if (opts.render) {
        const r = await opts.render(res.finalUrl);
        if (r.error) rec.renderError = r.error;
        else rec.rendered = mapPageData(extractPage(r.html, res.finalUrl), map);
      }
      const linkSource = rec.rendered ?? rec.data;
      const follow = !rec.data.metaRobots.includes('nofollow') && !rec.data.metaRobots.includes('none');
      if (follow && res.finalUrl && new URL(res.finalUrl).hostname.replace(/^www\./, '') === rootHost) {
        for (const l of linkSource.links) {
          if (l.url && l.internal && !l.rel.includes('nofollow')) enqueue({ url: l.url, depth: item.depth + 1, foundOn: item.url });
        }
      }
      // Canonical and hreflang targets are crawled too (even on nofollow pages) so their status,
      // indexability and return links can be verified. They do not count as internal links.
      for (const target of [linkSource.canonical, ...linkSource.hreflang.map((h) => h.href)]) {
        if (target) enqueue({ url: target, depth: item.depth + 1, foundOn: `${item.url} (canonical/hreflang)` });
      }
    }
    // Redirect targets are crawled as their own URLs so chains and final status are visible.
    if (res.redirects.length && res.finalUrl !== item.url) enqueue({ url: res.finalUrl, depth: item.depth, foundOn: item.url });
    // Keep stored text bounded for large crawls.
    for (const d of [rec.data, rec.rendered]) {
      if (!d) continue;
      d.textContent = d.textContent.slice(0, 20000);
      d.mainText = d.mainText.slice(0, 20000);
    }
    pages.push(rec);
    store?.append('pages.jsonl', rec);
    crawledThisRun++;
    opts.onProgress?.({ crawled: pages.length, queued: queue.length, url: item.url, status: res.status });
    if (crawledThisRun % opts.checkpointEvery === 0) persist();
  };

  // Concurrency pool; politeness is enforced per host by the limiter.
  // A worker may only exit when the queue is empty AND no other worker is still processing,
  // because in-flight pages can enqueue new links.
  const workers: Promise<void>[] = [];
  let active = 0;
  const next = async (): Promise<void> => {
    for (;;) {
      if (pages.length + active >= opts.maxPages) return;
      const item = queue.shift();
      if (!item) {
        if (active === 0) return;
        await new Promise((r) => setTimeout(r, 10));
        continue;
      }
      active++;
      try {
        await processItem(item);
      } finally {
        active--;
      }
    }
  };
  for (let i = 0; i < Math.max(1, opts.concurrency); i++) workers.push(next());
  await Promise.all(workers);
  persist();

  const fetched = pages.filter((p) => !p.blockedByRobots && p.status > 0);
  const result: CrawlResult = {
    runId: store?.runId ?? 'ephemeral',
    startUrl: start,
    origin,
    robots,
    sitemap,
    pages,
    startedAt,
    finishedAt: new Date().toISOString(),
    stats: {
      crawled: pages.length,
      queuedRemaining: queue.length,
      blocked: pages.filter((p) => p.blockedByRobots).length,
      errors: pages.filter((p) => p.error).length,
      durationMs: Date.now() - t0,
      avgResponseMs: fetched.length ? Math.round(fetched.reduce((a, p) => a + p.timingMs, 0) / fetched.length) : 0,
    },
    truncated: queue.length > 0,
    ...(map ? { siteUrl: map.from } : {}),
  };
  store?.writeJson('crawl-summary.json', {
    ...result,
    pages: undefined,
    robots: { url: robots.url, status: robots.status, state: robots.state, sizeBytes: robots.sizeBytes, sitemaps: robots.sitemaps, raw: robots.raw.slice(0, 50000) },
  });
  return result;
}
