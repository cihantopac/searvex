import crypto from 'node:crypto';
import type { FetchResult, RedirectHop } from '../core/types.js';
import { looksLikeAsset, mapOrigin, normalizeUrl, originMap, pathDepth, type OriginMap } from '../core/url.js';
import { extractPage, parseXRobotsTag, type PageData } from '../extract/html.js';
import { DEFAULT_USER_AGENT, HostRateLimiter, safeFetch } from '../net/fetcher.js';
import { DEFAULT_POLICY, type NetPolicy } from '../net/ssrf.js';
import { proxySummary } from '../net/proxy.js';
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
  render?: (url: string, o?: { screenshot?: boolean }) => Promise<{ html: string; error?: string; screenshot?: Buffer }>;
  /**
   * Evidence artefacts written to the run directory (needs a store): `html` = each fetched HTML body as served
   * (--save-html), `screenshots` = one viewport PNG per rendered page (--screenshots, with `render`). Bounded by
   * `ARTEFACT_PAGE_CAP` per page and `ARTEFACT_RUN_CAP` per run.
   */
  artefacts?: { html?: boolean; screenshots?: boolean; /** Run budget in bytes (default `ARTEFACT_RUN_CAP`). */ maxBytes?: number };
  /**
   * Called after each URL. `crawled`: URLs processed (fetched + robots-blocked); `fetched`: URLs for which an
   * HTTP request was made; `blocked`: this URL was disallowed by robots.txt and not requested.
   */
  onProgress?: (p: { crawled: number; fetched: number; queued: number; url: string; status: number; blocked: boolean }) => void;
  /** Persist progress every N pages… */
  checkpointEvery: number;
  /** …or every N milliseconds, whichever comes first, so `--resume` works after an early kill. */
  checkpointMs: number;
  /**
   * Graceful stop (SIGINT/SIGTERM, --max-duration): when aborted, no new URL is started, pages in flight
   * finish (bounded by the request timeout) and the result is marked `interrupted` with `signal.reason`.
   */
  stop?: AbortSignal;
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
  checkpointMs: 10_000,
};

/** Bytes of one saved HTML body (longer bodies are cut). */
export const ARTEFACT_PAGE_CAP = 2 * 1024 * 1024;
/** Bytes of all artefacts of one run; later ones are skipped and counted. */
export const ARTEFACT_RUN_CAP = 200 * 1024 * 1024;

/** `<hash>-<path slug>`: stable for a URL, safe as a file name. */
export function artefactName(url: string): string {
  let pathname = new URL(url).pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    /* keep the encoded form */
  }
  const slug = (pathname.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'index').slice(0, 40);
  return `${crypto.createHash('sha1').update(url).digest('hex').slice(0, 12)}-${slug}`;
}

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
  /** Evidence artefacts of this page, relative to the run directory (`--save-html`, `--screenshots`). */
  artefacts?: { html?: string; screenshot?: string };
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
  /**
   * `crawled`: URLs processed, including those blocked by robots.txt (never requested). `fetched`: URLs for
   * which an HTTP request was made. `blocked`: URLs not requested because robots.txt disallows them.
   */
  stats: { crawled: number; fetched: number; queuedRemaining: number; blocked: number; errors: number; durationMs: number; avgResponseMs: number };
  /** True when the crawl stopped because maxPages was reached with URLs still queued. */
  truncated: boolean;
  /**
   * Set when the start URL failed at the network level (DNS, TCP, TLS, or blocked by the network policy)
   * and nothing was crawled: the run says nothing about the site.
   */
  unreachable?: { error: string; blocked: boolean };
  /** Public origin mapped to `origin` (from --site-url); absent when no mapping applied. */
  siteUrl?: string;
  /** Set when the crawl was stopped early by `CrawlOptions.stop`: the pages cover only part of the site. */
  interrupted?: Interruption;
  /** Evidence artefacts written by this run (`CrawlOptions.artefacts`). */
  artefacts?: { html: number; screenshots: number; bytes: number; skipped: number };
  /** Upstream proxy used for this crawl (endpoint and mode, never credentials). */
  proxy?: ReturnType<typeof proxySummary>;
}

/** Why a crawl was stopped early: a signal (SIGINT/SIGTERM) or the --max-duration deadline. */
export type Interruption = 'signal' | 'max-duration';

function interruptionOf(signal: AbortSignal | undefined): Interruption | undefined {
  if (!signal?.aborted) return undefined;
  return signal.reason === 'max-duration' ? 'max-duration' : 'signal';
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
        stats: { crawled: 0, fetched: 0, queuedRemaining: 0, blocked: 0, errors: 0, durationMs: Date.now() - t0, avgResponseMs: 0 },
        truncated: false,
        unreachable,
        ...(opts.policy.upstream ? { proxy: proxySummary(opts.policy.upstream) } : {}),
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
  // Pages appended after the last checkpoint are done: never fetch them twice.
  const done = new Set(existing.map((p) => p.url));
  const queue: QueueItem[] = (checkpoint?.queue ?? []).filter((i) => !done.has(i.url));
  const enqueue = (item: QueueItem) => {
    const n = normalizeUrl(item.url);
    if (!n || seen.has(n) || item.depth > opts.maxDepth || !inScope(n, rootHost, opts)) return;
    seen.add(n);
    queue.push({ ...item, url: n });
  };
  /** Queue the URLs a fetched page leads to: internal links, canonical/hreflang targets, its redirect target. */
  const enqueueLinksOf = (rec: PageRecord, item: QueueItem) => {
    const linkSource = rec.rendered ?? rec.data;
    if (linkSource && rec.data) {
      const follow = !rec.data.metaRobots.includes('nofollow') && !rec.data.metaRobots.includes('none');
      if (follow && rec.finalUrl && new URL(rec.finalUrl).hostname.replace(/^www\./, '') === rootHost) {
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
    if (rec.redirects.length && rec.finalUrl && rec.finalUrl !== item.url) enqueue({ url: rec.finalUrl, depth: item.depth, foundOn: item.url });
  };
  if (!checkpoint) {
    enqueue({ url: start, depth: 0 });
    for (const u of sitemapSet) enqueue({ url: u, depth: Math.max(1, pathDepth(u)), foundOn: 'sitemap' });
  }
  store?.writeJson('meta.json', { runId: store.runId, kind: 'crawl', startUrl: start, startedAt, options: { ...opts, policy: undefined, render: !!opts.render, onProgress: undefined, stop: undefined } });

  const artefacts = { html: 0, screenshots: 0, bytes: 0, skipped: 0 };
  /** Save one artefact within the run budget; returns its relative path, or undefined when skipped. */
  const saveArtefact = (kind: 'html' | 'screenshots', name: string, data: Buffer): string | undefined => {
    if (!store) return undefined;
    if (artefacts.bytes + data.length > (opts.artefacts?.maxBytes ?? ARTEFACT_RUN_CAP)) {
      artefacts.skipped++;
      return undefined;
    }
    artefacts.bytes += data.length;
    artefacts[kind === 'html' ? 'html' : 'screenshots']++;
    return store.writeArtefact(kind, name, data);
  };
  let crawledThisRun = 0;
  let fetchedCount = existing.filter((p) => !p.blockedByRobots).length;
  let lastPersist = Date.now();
  const persist = () => {
    lastPersist = Date.now();
    store?.writeJson('checkpoint.json', { queue, seen: [...seen] } satisfies Checkpoint);
  };
  // Links of pages stored after the last checkpoint were never queued: queue them again (seen dedupes).
  if (checkpoint) for (const p of existing) enqueueLinksOf(p, { url: p.url, depth: p.depth });
  // A first checkpoint right away: a run killed within seconds can still be resumed.
  persist();

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
      opts.onProgress?.({ crawled: pages.length, fetched: fetchedCount, queued: queue.length, url: item.url, status: 0, blocked: true });
      return;
    }
    await limiter.wait(host, opts.stop);
    if (opts.stop?.aborted) {
      // Stopped while waiting for the host's slot: not fetched, so it stays queued for --resume.
      queue.unshift(item);
      return;
    }
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
      const name = artefactName(item.url);
      // Saved as .html.txt: opening it shows the source instead of running the page's scripts locally.
      if (opts.artefacts?.html) {
        const html = saveArtefact('html', `${name}.html.txt`, Buffer.from(res.body, 'utf8').subarray(0, ARTEFACT_PAGE_CAP));
        if (html) rec.artefacts = { html };
      }
      if (opts.render) {
        const r = await opts.render(res.finalUrl, { screenshot: !!opts.artefacts?.screenshots });
        if (r.error) rec.renderError = r.error;
        else rec.rendered = mapPageData(extractPage(r.html, res.finalUrl), map);
        const shot = r.screenshot && saveArtefact('screenshots', `${name}.png`, r.screenshot);
        if (shot) rec.artefacts = { ...rec.artefacts, screenshot: shot };
      }
    }
    enqueueLinksOf(rec, item);
    // Keep stored text bounded for large crawls. The whole-page text only feeds wordCount (computed at
    // extraction); analysis reads the main content, so the page record does not keep it.
    for (const d of [rec.data, rec.rendered]) {
      if (!d) continue;
      d.textContent = '';
      d.mainText = d.mainText.slice(0, 20000);
    }
    pages.push(rec);
    store?.append('pages.jsonl', rec);
    crawledThisRun++;
    fetchedCount++;
    opts.onProgress?.({ crawled: pages.length, fetched: fetchedCount, queued: queue.length, url: item.url, status: res.status, blocked: false });
    if (crawledThisRun % opts.checkpointEvery === 0 || Date.now() - lastPersist >= opts.checkpointMs) persist();
  };

  // Concurrency pool; politeness is enforced per host by the limiter.
  // A worker may only exit when the queue is empty AND no other worker is still processing,
  // because in-flight pages can enqueue new links.
  const workers: Promise<void>[] = [];
  let active = 0;
  const next = async (): Promise<void> => {
    for (;;) {
      if (pages.length + active >= opts.maxPages || opts.stop?.aborted) return;
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

  const requested = pages.filter((p) => !p.blockedByRobots);
  const fetched = requested.filter((p) => p.status > 0);
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
      fetched: requested.length,
      queuedRemaining: queue.length,
      blocked: pages.filter((p) => p.blockedByRobots).length,
      errors: pages.filter((p) => p.error).length,
      durationMs: Date.now() - t0,
      avgResponseMs: fetched.length ? Math.round(fetched.reduce((a, p) => a + p.timingMs, 0) / fetched.length) : 0,
    },
    truncated: queue.length > 0,
    ...(map ? { siteUrl: map.from } : {}),
    ...(interruptionOf(opts.stop) ? { interrupted: interruptionOf(opts.stop) } : {}),
    ...(opts.policy.upstream ? { proxy: proxySummary(opts.policy.upstream) } : {}),
    ...(opts.artefacts?.html || opts.artefacts?.screenshots ? { artefacts } : {}),
  };
  store?.writeJson('crawl-summary.json', {
    ...result,
    pages: undefined,
    robots: { url: robots.url, status: robots.status, state: robots.state, sizeBytes: robots.sizeBytes, sitemaps: robots.sitemaps, raw: robots.raw.slice(0, 50000) },
  });
  return result;
}
