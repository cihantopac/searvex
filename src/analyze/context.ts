import type { CrawlResult, PageRecord } from '../crawl/crawler.js';
import { normalizeUrl } from '../core/url.js';
import type { PageData } from '../extract/html.js';

/**
 * Pre-computed indexes over a crawl, shared by all analyzers so each check is O(pages).
 */
export interface SiteContext {
  crawl: CrawlResult;
  pages: PageRecord[];
  byUrl: Map<string, PageRecord>;
  /** Internal inlinks per target URL (normalised), exactly as linked. */
  inlinks: Map<string, Set<string>>;
  /**
   * Inlinks per page that a visitor or crawler reaches, including links through internal redirects
   * (`/en/` → `/en`, a language switch `/language/en` → `/en`). Use for reachability (orphans, inlink counts);
   * use `inlinks` for checks about the linked URL itself (broken links).
   */
  reachIn: Map<string, Set<string>>;
  /** HTML pages with a direct 200 response (not reached via redirect) and parsed data. */
  htmlPages: PageRecord[];
  /** HTML 200 pages that are indexable (no noindex) and self-canonical (or no canonical). */
  indexable: PageRecord[];
  sitemapUrls: Set<string>;
  homepage?: PageRecord;
}

/** Facts used by checks: rendered DOM when available, otherwise raw HTML. */
export function factsOf(p: PageRecord): PageData | undefined {
  return p.rendered ?? p.data;
}

export function robotsDirectives(p: PageRecord, bots: string[] = ['googlebot']): string[] {
  const d = [...(p.data?.metaRobots ?? []), ...p.xRobots];
  for (const b of bots) d.push(...(p.data?.botRobots[b] ?? []), ...(p.xRobotsByBot[b] ?? []));
  return d;
}

export function isNoindex(p: PageRecord): boolean {
  const d = robotsDirectives(p, ['googlebot', 'bingbot']);
  return d.includes('noindex') || d.includes('none');
}

export function isSelfCanonical(p: PageRecord): boolean {
  const c = factsOf(p)?.canonical;
  if (!c) return true;
  return normalizeUrl(c) === normalizeUrl(p.finalUrl);
}

export function buildContext(crawl: CrawlResult): SiteContext {
  const byUrl = new Map<string, PageRecord>();
  for (const p of crawl.pages) {
    byUrl.set(p.url, p);
    if (!byUrl.has(p.finalUrl)) byUrl.set(p.finalUrl, p);
  }
  const inlinks = new Map<string, Set<string>>();
  for (const p of crawl.pages) {
    const f = factsOf(p);
    // Redirected records carry the target's content; the target is analysed as its own record.
    if (!f || p.status !== 200 || p.redirects.length) continue;
    for (const l of f.links) {
      if (!l.url || !l.internal || l.url === p.finalUrl) continue;
      let set = inlinks.get(l.url);
      if (!set) inlinks.set(l.url, (set = new Set()));
      set.add(p.url);
    }
  }
  const htmlPages = crawl.pages.filter((p) => p.status === 200 && p.data && !p.redirects.length);
  const indexable = htmlPages.filter((p) => !isNoindex(p) && isSelfCanonical(p));
  const sitemapUrls = new Set(crawl.sitemap.urls.map((u) => normalizeUrl(u.loc)).filter((x): x is string => !!x));
  // The site homepage (origin root), or the start URL when it is a root / locale root such as /en/.
  const startPath = new URL(crawl.startUrl).pathname;
  const homepage = byUrl.get(new URL('/', crawl.origin).toString()) ?? (/^\/([a-z]{2}(-[a-z]{2})?\/?)?$/i.test(startPath) ? byUrl.get(crawl.startUrl) : undefined);
  const reachIn = new Map<string, Set<string>>();
  for (const [target, sources] of inlinks) {
    const rec = byUrl.get(target);
    const final = rec?.redirects.length ? (normalizeUrl(rec.finalUrl) ?? target) : target;
    const set = reachIn.get(final) ?? reachIn.set(final, new Set()).get(final)!;
    for (const s of sources) if (s !== final) set.add(s);
  }
  return { crawl, pages: crawl.pages, byUrl, inlinks, reachIn, htmlPages, indexable, sitemapUrls, homepage };
}

/** Look up the crawled record for a URL (normalised). */
export function resolveRecord(ctx: SiteContext, url: string): PageRecord | undefined {
  const n = normalizeUrl(url);
  return n ? ctx.byUrl.get(n) : undefined;
}
