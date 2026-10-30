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
