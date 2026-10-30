import { XMLParser } from 'fast-xml-parser';
import { safeFetch, type FetchOptions } from '../net/fetcher.js';

export interface SitemapUrl {
  loc: string;
  lastmod?: string;
  alternates?: Array<{ hreflang: string; href: string }>;
  source: string;
}

export interface SitemapIssue {
  sitemap: string;
  message: string;
}

export interface SitemapResult {
  sitemaps: string[];
  urls: SitemapUrl[];
  issues: SitemapIssue[];
}

/** Protocol limits (sitemaps.org; Google documents the same): 50,000 URLs and 50 MB uncompressed per file. */
export const SITEMAP_MAX_URLS = 50000;
export const SITEMAP_MAX_BYTES = 50 * 1024 * 1024;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  // XXE-safe: fast-xml-parser does not resolve external entities; also disable entity processing entirely.
  processEntities: false,
  isArray: (name) => name === 'url' || name === 'sitemap' || name === 'link',
});

function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

function text(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'object' && '#text' in (v as Record<string, unknown>)) return String((v as Record<string, unknown>)['#text']).trim();
  return String(v).trim();
}

export function parseSitemapXml(xml: string, source: string): { urls: SitemapUrl[]; children: string[]; issues: SitemapIssue[] } {
  const issues: SitemapIssue[] = [];
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch (e) {
    return { urls: [], children: [], issues: [{ sitemap: source, message: `Invalid XML: ${(e as Error).message}` }] };
  }
  const urlset = doc['urlset'] as Record<string, unknown> | undefined;
  const index = doc['sitemapindex'] as Record<string, unknown> | undefined;
  if (!urlset && !index) {
    return { urls: [], children: [], issues: [{ sitemap: source, message: 'Not a sitemap: missing <urlset> or <sitemapindex> root element' }] };
  }
  const children = asArray(index?.['sitemap'] as unknown[]).map((s) => text((s as Record<string, unknown>)['loc'])).filter((x): x is string => !!x);
  const urls: SitemapUrl[] = [];
  for (const entry of asArray(urlset?.['url'] as unknown[])) {
    const e = entry as Record<string, unknown>;
    const loc = text(e['loc']);
    if (!loc) {
      issues.push({ sitemap: source, message: '<url> entry without <loc>' });
      continue;
    }
    const alternates = asArray(e['link'] as unknown[])
      .map((l) => l as Record<string, string>)
      .filter((l) => l['@rel'] === 'alternate' && l['@hreflang'] && l['@href'])
      .map((l) => ({ hreflang: l['@hreflang']!, href: l['@href']! }));
    const lastmod = text(e['lastmod']);
    if (lastmod && Number.isNaN(Date.parse(lastmod))) issues.push({ sitemap: source, message: `Invalid <lastmod> "${lastmod}" for ${loc}` });
    urls.push({ loc, lastmod, alternates: alternates.length ? alternates : undefined, source });
  }
  if (urls.length > SITEMAP_MAX_URLS) issues.push({ sitemap: source, message: `Sitemap has ${urls.length} URLs; protocol limit is ${SITEMAP_MAX_URLS}` });
  return { urls, children, issues };
}

export async function collectSitemaps(
  seeds: string[],
  opts: FetchOptions & { maxSitemaps?: number; maxUrls?: number } = {},
): Promise<SitemapResult> {
  const maxSitemaps = opts.maxSitemaps ?? 50;
  const maxUrls = opts.maxUrls ?? 100000;
  const queue = [...new Set(seeds)];
  const seen = new Set<string>();
  const result: SitemapResult = { sitemaps: [], urls: [], issues: [] };
  while (queue.length && seen.size < maxSitemaps && result.urls.length < maxUrls) {
    const sm = queue.shift()!;
    if (seen.has(sm)) continue;
    seen.add(sm);
    const res = await safeFetch(sm, { ...opts, maxBytes: SITEMAP_MAX_BYTES });
    if (res.error || res.status !== 200) {
      result.issues.push({ sitemap: sm, message: res.error ?? `HTTP ${res.status}` });
      continue;
    }
    result.sitemaps.push(sm);
    const body = res.body;
    if (res.truncated) result.issues.push({ sitemap: sm, message: 'Sitemap exceeds 50 MB uncompressed limit (truncated)' });
    const parsed = parseSitemapXml(body, sm);
    result.issues.push(...parsed.issues);
    for (const c of parsed.children) if (!seen.has(c)) queue.push(c);
    result.urls.push(...parsed.urls.slice(0, maxUrls - result.urls.length));
  }
  return result;
}
