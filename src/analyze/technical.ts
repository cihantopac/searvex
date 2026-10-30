import { normalizeUrl, sameSite } from '../core/url.js';
import type { FindingSink } from '../rules/engine.js';
import { factsOf, isNoindex, isSelfCanonical, resolveRecord, robotsDirectives, type SiteContext } from './context.js';
import { checkStructuredData } from './structured-data.js';

/** ISO 639-1 codes (complete list) used to validate hreflang. */
const ISO639_1 = new Set(
  'aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu'.split(' '),
);

export function isValidHreflang(code: string): boolean {
  if (code.toLowerCase() === 'x-default') return true;
  const m = /^([a-z]{2})(?:-([a-z]{4}))?(?:-([a-z]{2}))?$/i.exec(code);
  if (!m) return false;
  if (!ISO639_1.has(m[1]!.toLowerCase())) return false;
  // Region must be ISO 3166-1 alpha-2; "UK" and "EU" are common mistakes ("GB", no EU region).
  if (m[3] && ['uk', 'eu'].includes(m[3].toLowerCase())) return false;
  return true;
}

const SESSION_PARAM = /[?&](sid|sessionid|phpsessid|jsessionid|session_id|utm_[a-z]+|gclid|fbclid)=/i;

export function runTechnicalChecks(ctx: SiteContext, sink: FindingSink): void {
  const { crawl } = ctx;

  // ---- robots.txt ----
  if (crawl.robots.state === 'unreachable') sink.emit('robots.unreachable', { url: crawl.robots.url, observed: crawl.robots.error ?? `HTTP ${crawl.robots.status}` });
  if (crawl.robots.sizeBytes > 500 * 1024) sink.emit('robots.too-large', { url: crawl.robots.url, observed: `${Math.round(crawl.robots.sizeBytes / 1024)} KiB` });
  if (crawl.robots.state === 'ok') {
    for (const bot of ['Googlebot', 'Bingbot', 'YandexBot']) {
      if (!crawl.robots.isAllowed(crawl.startUrl, bot)) sink.emit('robots.disallow-all', { url: crawl.robots.url, observed: `${bot} disallowed for ${crawl.startUrl}` });
    }
    if (/^\s*crawl-delay\s*:/im.test(crawl.robots.raw)) sink.emit('robots.crawl-delay-ignored', { url: crawl.robots.url, observed: (/^\s*crawl-delay\s*:.*$/im.exec(crawl.robots.raw) ?? [''])[0].trim() });
  }
  if (!crawl.sitemap.sitemaps.length) sink.emit('robots.no-sitemap', { url: crawl.robots.url, observed: crawl.robots.sitemaps.length ? `Declared sitemap(s) failed: ${crawl.sitemap.issues.map((i) => i.message).join('; ')}` : 'No Sitemap directive; /sitemap.xml not available' });

  // ---- start URL ----
  const start = ctx.byUrl.get(crawl.startUrl);
  if (start && !start.blockedByRobots && (start.error || start.status >= 400)) {
    sink.emit('http.start-url-error', { url: crawl.startUrl, observed: start.error ?? `HTTP ${start.status}` });
  }

  // ---- per page ----
  const titleMap = new Map<string, string[]>();
  const descMap = new Map<string, string[]>();
  for (const p of ctx.pages) {
    const ev = { url: p.url };
    if (p.blockedByRobots) {
      if (p.inSitemap) sink.emit('robots.blocked-sitemap-url', ev);
      continue;
    }
    if (p.error) {
      sink.emit(p.error.includes('redirect') || p.error.includes('Redirect') ? 'redirect.loop' : 'http.fetch-error', { url: p.url, observed: p.error });
      continue;
    }
    if (p.status >= 500 || p.status === 429) sink.emit('http.server-error', { url: p.url, observed: `HTTP ${p.status}` });
    if (p.redirects.length > 1) sink.emit('redirect.chain', { url: p.url, observed: [p.url, ...p.redirects.map((r) => `${r.status} → ${r.location}`)].join(' ') });
    if (p.redirects.length && p.foundOn && p.foundOn !== 'sitemap' && p.redirects.some((r) => [302, 303, 307].includes(r.status))) {
      sink.emit('redirect.temporary-internal', { url: p.url, observed: p.redirects.map((r) => `${r.status} → ${r.location}`).join(', '), expected: 'linked from ' + p.foundOn });
    }
    if (p.inSitemap && (p.redirects.length || p.status !== 200)) sink.emit('index.sitemap-non200', { url: p.url, observed: p.redirects.length ? `redirects to ${p.finalUrl}` : `HTTP ${p.status}` });
    if (p.bytes > 15 * 1024 * 1024 || p.truncated) sink.emit('index.oversized-html', { url: p.url, observed: `${Math.round(p.bytes / 1024 / 1024)} MB${p.truncated ? ' (truncated by crawler limit)' : ''}` });

    const f = factsOf(p);
    // Page-level checks run on the redirect target's own record, never on the redirecting URL.
    if (!f || p.status !== 200 || p.redirects.length) continue;
    if (p.depth > 4 && p.foundOn !== 'sitemap') sink.emit('crawl.deep-pages', { url: p.url, observed: `depth ${p.depth}` });
    if (f.metaRefresh) sink.emit('redirect.meta-refresh', { url: p.url, observed: f.metaRefresh });

    const noindex = isNoindex(p);
    const selfCanon = isSelfCanonical(p);
    if (noindex) {
      sink.emit('index.noindex', { url: p.url, observed: robotsDirectives(p, ['googlebot', 'bingbot']).join(', ') });
      if (p.inSitemap) sink.emit('index.noindex-in-sitemap', ev);
      if (f.canonical && !selfCanon) sink.emit('canonical.noindex-conflict', { url: p.url, observed: `noindex + canonical → ${f.canonical}` });
    }
    if (p.inSitemap && !selfCanon) sink.emit('index.sitemap-non-canonical', { url: p.url, observed: `canonical → ${f.canonical}` });

    // Canonical
    if (f.canonicalOutsideHead) {
      // Next.js (15.2+) streams metadata into <body> for user agents it does not classify as bots and
      // serves it in <head> to known crawlers such as Googlebot, so Google may see a different result.
      const next = (p.data?.generator ?? '') === 'next.js';
      sink.emit(
        'canonical.in-body',
        { url: p.url, observed: `${f.canonicalOutsideHead} canonical link(s) parsed into <body>${next ? ' — Next.js streaming metadata: verify with URL Inspection what Googlebot receives' : ''}` },
        next ? { confidence: 'heuristic' } : {},
      );
    }
    if (f.canonicalCount > 1) sink.emit('canonical.multiple', { url: p.url, observed: `${f.canonicalCount} canonical links` });
    const rawCanonicalHref = f.canonicalRaw;
    if (rawCanonicalHref && !/^https?:\/\//i.test(rawCanonicalHref)) sink.emit('canonical.relative', { url: p.url, observed: rawCanonicalHref });
    if (!f.canonical && !noindex) sink.emit('canonical.missing', ev);
    if (f.canonical && !selfCanon) {
      if (!sameSite(f.canonical, p.finalUrl)) sink.emit('canonical.cross-domain', { url: p.url, observed: f.canonical });
      const target = resolveRecord(ctx, f.canonical);
      if (target && !target.blockedByRobots) {
        if (target.status !== 200 || target.redirects.length) sink.emit('canonical.target-error', { url: p.url, observed: `${f.canonical} → ${target.redirects.length ? 'redirect' : 'HTTP ' + target.status}` });
        else if (isNoindex(target)) sink.emit('canonical.target-noindex', { url: p.url, observed: f.canonical });
      }
    }

    // Metadata (only for indexable pages: duplicates on noindex pages do not matter)
    if (!f.title) sink.emit('title.missing', ev);
    if (f.titleCount > 1) sink.emit('title.multiple', { url: p.url, observed: `${f.titleCount} <title> elements` });
    if (f.title && f.title.length > 70) sink.emit('title.truncation-risk', { url: p.url, observed: `${f.title.length} chars: ${f.title.slice(0, 120)}` });
    if (!noindex && selfCanon) {
      if (f.title) push(titleMap, f.title.toLowerCase(), p.url);
      if (f.metaDescription) push(descMap, f.metaDescription.toLowerCase(), p.url);
      if (!f.metaDescription) sink.emit('description.missing', ev);
      if (!f.headings.some((h) => h.level === 1)) sink.emit('h1.missing', ev);
    }
    if (f.metaDescriptionCount > 1) sink.emit('description.multiple', { url: p.url, observed: `${f.metaDescriptionCount} meta descriptions` });
    if (f.hasMetaKeywords) sink.emit('meta.keywords-present', ev);
    if (!f.viewport) sink.emit('mobile.viewport-missing', ev);
    if (!f.lang) sink.emit('html.lang-missing', ev);
    if (!f.openGraph['og:title'] && !f.openGraph['og:description'] && !f.openGraph['og:image']) sink.emit('social.og-missing', ev);

    // Images
    const noAlt = f.images.filter((i) => i.alt === null && i.src);
    if (noAlt.length) sink.emit('img.alt-missing', { url: p.url, observed: `${noAlt.length} image(s), e.g. ${noAlt[0]!.src.slice(0, 120)}` });
    const noDim = f.images.filter((i) => i.src && (!i.width || !i.height));
    if (noDim.length) sink.emit('img.dimensions-missing', { url: p.url, observed: `${noDim.length} image(s) without width/height attributes` });

    // Links
    const uncrawlable = f.links.filter((l) => l.uncrawlable && l.text);
    if (uncrawlable.length) sink.emit('links.uncrawlable', { url: p.url, observed: `${uncrawlable.length} link(s), e.g. "${uncrawlable[0]!.text}" href="${uncrawlable[0]!.href}"` });
    // Card pattern: an image link with empty alt next to a text link to the same URL is fine.
    const named = new Set(f.links.filter((l) => l.text && l.url).map((l) => l.url));
    const empty = f.links.filter((l) => l.internal && l.url && !l.text && !named.has(l.url));
    if (empty.length) sink.emit('links.empty-anchor', { url: p.url, observed: `${empty.length} link(s), e.g. ${empty[0]!.href}` });
    const sessionLinks = f.links.filter((l) => l.internal && SESSION_PARAM.test(l.href));
    if (sessionLinks.length) sink.emit('url.session-params', { url: p.url, observed: sessionLinks[0]!.href });

    // Soft 404 heuristic
    const errorish = /\b(404|not found|page not found|sayfa bulunamadı|nicht gefunden|introuvable|no encontrada)\b/i;
    // A noindexed error page is already excluded from the index, so the soft-404 label adds nothing.
    if (!noindex && ((f.title && errorish.test(f.title)) || f.headings.some((h) => h.level === 1 && errorish.test(h.text)))) {
      sink.emit('index.soft-404', { url: p.url, observed: f.title ?? '' });
    }
    if (p.data?.likelyClientRendered && !p.rendered) sink.emit('index.client-rendered', { url: p.url, observed: `${p.data.wordCount} words in raw HTML, ${p.data.scriptCount} scripts` });
    if (p.rendered && p.data) compareRender(p.url, p.data, p.rendered, sink);

    // Security
    if (p.finalUrl.startsWith('http://')) sink.emit('https.not-used', ev);
    else {
      const mixed = f.subresources.filter((s) => /^http:\/\//i.test(s));
      if (mixed.length) sink.emit('https.mixed-content', { url: p.url, observed: `${mixed.length} resource(s), e.g. ${mixed[0]}` });
    }

    // Performance (lab, single location)
    const ttfb = p.ttfbMs ?? p.timingMs;
    if (ttfb > 800 && !p.redirects.length) sink.emit('perf.slow-ttfb', { url: p.url, observed: `TTFB ${ttfb} ms (single sample from the crawler's location; full response ${p.timingMs} ms)` });
    if (p.bytes > 10 * 1024 && !p.headers['content-encoding']) sink.emit('perf.no-compression', { url: p.url, observed: `${Math.round(p.bytes / 1024)} KB uncompressed` });

    // URL structure
    const path = new URL(p.finalUrl).pathname;
    if (path.includes('_') && !p.foundOn?.startsWith('sitemap')) sink.emit('url.underscores', { url: p.url });

    // hreflang
    checkHreflang(ctx, p.url, f, sink);

    // Structured data
    checkStructuredData(p.url, f, sink, p === ctx.homepage);
  }

  for (const [title, urls] of titleMap) if (urls.length > 1) sink.emit('duplicate.title', { url: urls[0], observed: `"${title.slice(0, 100)}" on ${urls.length} pages: ${urls.slice(0, 5).join(', ')}` });
  for (const [desc, urls] of descMap) if (urls.length > 1) sink.emit('duplicate.description', { url: urls[0], observed: `"${desc.slice(0, 100)}" on ${urls.length} pages: ${urls.slice(0, 5).join(', ')}` });

  // Broken internal links: every link target we crawled that ended in 4xx.
  for (const [target, sources] of ctx.inlinks) {
    const rec = resolveRecord(ctx, target);
    if (rec && !rec.blockedByRobots && rec.status >= 400 && rec.status < 500) {
      sink.emit('links.broken-internal', { url: target, observed: `HTTP ${rec.status}, linked from ${sources.size} page(s): ${[...sources].slice(0, 3).join(', ')}` });
    }
  }

  // Orphans: sitemap URLs that were crawled fine but have no internal inlinks.
  for (const u of ctx.sitemapUrls) {
    const rec = ctx.byUrl.get(u);
    if (!rec || rec.status !== 200 || u === crawl.startUrl) continue;
    if (!ctx.inlinks.get(u)?.size && !ctx.inlinks.get(rec.finalUrl)?.size) sink.emit('crawl.sitemap-orphan', { url: u });
  }
}

function push(m: Map<string, string[]>, k: string, v: string) {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

function compareRender(url: string, raw: NonNullable<ReturnType<typeof factsOf>>, rendered: NonNullable<ReturnType<typeof factsOf>>, sink: FindingSink) {
  const diffs: string[] = [];
  if ((raw.title ?? '') !== (rendered.title ?? '')) diffs.push(`title "${raw.title ?? ''}" → "${rendered.title ?? ''}"`);
  if ((raw.canonical ?? '') !== (rendered.canonical ?? '')) diffs.push(`canonical ${raw.canonical ?? 'none'} → ${rendered.canonical ?? 'none'}`);
  if (raw.metaRobots.join(',') !== rendered.metaRobots.join(',')) diffs.push(`robots "${raw.metaRobots.join(',')}" → "${rendered.metaRobots.join(',')}"`);
  const rawLinks = new Set(raw.links.filter((l) => l.internal && l.url).map((l) => l.url));
  const jsOnly = rendered.links.filter((l) => l.internal && l.url && !rawLinks.has(l.url));
  if (jsOnly.length >= 5) diffs.push(`${jsOnly.length} internal links only exist after rendering`);
  if (diffs.length) sink.emit('index.render-mismatch', { url, observed: diffs.join('; ') });
}

function checkHreflang(ctx: SiteContext, url: string, f: NonNullable<ReturnType<typeof factsOf>>, sink: FindingSink) {
  if (!f.hreflang.length) return;
  const self = normalizeUrl(url);
  let hasSelf = false;
  let hasDefault = false;
  for (const h of f.hreflang) {
    if (!isValidHreflang(h.lang)) sink.emit('hreflang.invalid-code', { url, observed: h.lang });
    if (h.lang.toLowerCase() === 'x-default') hasDefault = true;
    const target = normalizeUrl(h.href);
    if (target === self) {
      hasSelf = true;
      continue;
    }
    const rec = target ? ctx.byUrl.get(target) : undefined;
    if (!rec || rec.blockedByRobots) continue;
    if (rec.status !== 200 || rec.redirects.length || (rec.data && !isSelfCanonical(rec))) {
      sink.emit('hreflang.target-error', { url, observed: `${h.lang} → ${h.href} (${rec.redirects.length ? 'redirect' : rec.status !== 200 ? 'HTTP ' + rec.status : 'non-canonical'})` });
      continue;
    }
    const back = factsOf(rec)?.hreflang.some((x) => normalizeUrl(x.href) === self);
    if (!back) sink.emit('hreflang.missing-return', { url, observed: `${h.lang} → ${h.href} has no return link` });
  }
  if (!hasSelf) sink.emit('hreflang.missing-self', { url });
  if (!hasDefault) sink.emit('hreflang.no-x-default', { url });
  const relative = f.hreflangRaw.find((h) => !/^https?:\/\//i.test(h));
  if (relative) sink.emit('hreflang.relative', { url, observed: relative });
}
