/**
 * URL normalisation used for crawl de-duplication. It is intentionally conservative:
 * it never changes path case or removes trailing slashes, because servers may treat those
 * as different resources. Duplicate-content analysis is a separate concern.
 */
const TRACKING_PARAMS = /^(utm_[a-z]+|gclid|fbclid|msclkid|mc_cid|mc_eid|_ga|yclid)$/i;

export function normalizeUrl(raw: string, base?: string, opts: { stripTracking?: boolean } = {}): string | null {
  let u: URL;
  try {
    u = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) u.port = '';
  if (opts.stripTracking !== false) {
    for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
  }
  if (u.pathname === '') u.pathname = '/';
  // "/blog?" and "/blog" are the same resource for every practical purpose.
  if (u.search === '?' || u.search === '') u.search = '';
  return u.toString();
}

export function sameSite(a: string, b: string): boolean {
  try {
    const ha = new URL(a).hostname.replace(/^www\./, '');
    const hb = new URL(b).hostname.replace(/^www\./, '');
    return ha === hb;
  } catch {
    return false;
  }
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export function pathDepth(url: string): number {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).length;
  } catch {
    return 0;
  }
}

/** Heuristic: URLs that are almost certainly not HTML documents. */
export function looksLikeAsset(url: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|svg|ico|css|js|mjs|map|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|zip|gz|tar|rar|7z|exe|dmg|apk|json|xml|txt|csv)(\?|$)/i.test(url);
}

/**
 * `--site-url` origin mapping: a local or staging build declares its public URLs (canonical, hreflang,
 * sitemap locations, absolute links), but is crawled at another origin. Mapping rewrites the public origin
 * to the crawled one, so those URLs are checked against the crawled pages instead of an unrelated site.
 */
export interface OriginMap {
  /** Public origin, from --site-url. */
  from: string;
  /** Crawled origin. */
  to: string;
}

/** Origin map from --site-url to the crawled URL; undefined when either is invalid or the origins are equal. */
export function originMap(siteUrl: string | undefined, crawledUrl: string): OriginMap | undefined {
  if (!siteUrl) return undefined;
  try {
    const from = new URL(siteUrl);
    const to = new URL(crawledUrl).origin;
    if ((from.protocol !== 'http:' && from.protocol !== 'https:') || from.origin === to) return undefined;
    return { from: from.origin, to };
  } catch {
    return undefined;
  }
}

/** Rewrite a URL on the public origin to the crawled origin; other URLs are returned unchanged. */
export function mapOrigin(url: string, map: OriginMap | undefined): string {
  if (!map || !url) return url;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (u.origin !== map.from) return url;
  return map.to + u.pathname + u.search + u.hash;
}
