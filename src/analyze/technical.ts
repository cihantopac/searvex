import { normalizeUrl, sameSite } from '../core/url.js';
import type { FindingSink } from '../rules/engine.js';
import { factsOf, isNoindex, isSelfCanonical, resolveRecord, robotsDirectives, type SiteContext } from './context.js';
import { checkStructuredData } from './structured-data.js';
import { detectLanguage, detectShortLanguage, primaryTag } from './language.js';

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

/** Common ISO 639-2/3 codes that do have an ISO 639-1 equivalent (so the value can be corrected). */
const ISO639_2_TO_1: Record<string, string> = {
  eng: 'en', tur: 'tr', deu: 'de', ger: 'de', fra: 'fr', fre: 'fr', spa: 'es', ita: 'it', por: 'pt', nld: 'nl', dut: 'nl', rus: 'ru',
  jpn: 'ja', zho: 'zh', chi: 'zh', kor: 'ko', ara: 'ar', pol: 'pl', swe: 'sv', dan: 'da', fin: 'fi', nor: 'no', ell: 'el', gre: 'el', heb: 'he',
};

/**
 * Explain an hreflang value Google does not support. A 3-letter language code is valid BCP 47 but outside
 * ISO 639-1: when the language has a 2-letter code it is a real mistake; when it has none (Asturian "ast",
 * Cebuano "ceb"), Google simply ignores that one alternate and the site has nothing to correct.
 */
export function hreflangProblem(code: string): { observed: string; severity?: 'low' } {
  const three = /^([a-z]{3})(?:-[a-z0-9]{2,8})*$/i.exec(code)?.[1]?.toLowerCase();
  if (three && ISO639_2_TO_1[three]) return { observed: `${code} — use the ISO 639-1 code "${ISO639_2_TO_1[three]}"` };
  if (three) return { observed: `${code} — valid BCP 47, but Google supports only ISO 639-1 codes and ignores this alternate; this language has no 2-letter code, so there is nothing to correct (other search engines may use it)`, severity: 'low' };
  return { observed: code };
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
    if (p.inSitemap && (p.redirects.length || p.status !== 200)) sink.emit('index.sitemap-non200', { url: p.url, observed: p.redirects.length ? `redirects to ${p.finalUrl}` : p.error ? `${p.error} (HTTP ${p.status || 'error'})` : `HTTP ${p.status}` });
    if (p.bytes > 15 * 1024 * 1024 || p.truncated) sink.emit('index.oversized-html', { url: p.url, observed: `${Math.round(p.bytes / 1024 / 1024)} MB${p.truncated ? ' (truncated by crawler limit)' : ''}` });

    const f = factsOf(p);
    // Page-level checks run on the redirect target's own record, never on the redirecting URL.
    if (!f || p.status !== 200 || p.redirects.length) continue;
    if (p.depth > 4 && p.foundOn !== 'sitemap') sink.emit('crawl.deep-pages', { url: p.url, observed: `depth ${p.depth}` });
    if (f.metaRefresh) sink.emit('redirect.meta-refresh', { url: p.url, observed: f.metaRefresh });

    const noindex = isNoindex(p);
    const selfCanon = isSelfCanonical(p);
    if (noindex) {
      sink.emit('index.noindex', { url: p.url, observed: [...new Set(robotsDirectives(p, ['googlebot', 'bingbot']))].join(', ') });
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
    // With --render, `f` is the rendered DOM; duplicates that only exist in the raw HTML still reach
    // crawlers that do not execute JavaScript, so they are reported with that context.
    const rawOnly = p.rendered && p.data ? ' — raw HTML only (corrected after JavaScript rendering; seen by non-rendering crawlers)' : '';
    if (rawOnly && p.data!.titleCount > 1 && f.titleCount <= 1) sink.emit('title.multiple', { url: p.url, observed: `${p.data!.titleCount} <title> elements${rawOnly}` });
    if (rawOnly && p.data!.metaDescriptionCount > 1 && f.metaDescriptionCount <= 1) sink.emit('description.multiple', { url: p.url, observed: `${p.data!.metaDescriptionCount} meta descriptions${rawOnly}` });
    if (rawOnly && p.data!.canonicalCount > 1 && f.canonicalCount <= 1) sink.emit('canonical.multiple', { url: p.url, observed: `${p.data!.canonicalCount} canonical links${rawOnly}` });
    if (f.titleCount > 1) {
      // Inertia SSR renders its own <title data-inertia> next to the Blade/root template title; browsers and
      // crawlers read the first one, so every page can end up with the generic template title.
      const inertia = p.data?.generator === 'inertia';
      sink.emit('title.multiple', {
        url: p.url,
        observed: `${f.titleCount} <title> elements (first: "${(f.title ?? '').slice(0, 60)}")${inertia ? ' — Inertia.js: mark the root template title with the `inertia` attribute (<title inertia>) so the page title replaces it' : ''}`,
      });
    }
    if (f.title && f.title.length > 70) sink.emit('title.truncation-risk', { url: p.url, observed: `${f.title.length} chars: ${f.title.slice(0, 120)}` });
    if (!noindex && selfCanon) {
      if (f.title) push(titleMap, f.title.toLowerCase(), p.url);
      if (f.metaDescription) push(descMap, f.metaDescription.toLowerCase(), p.url);
      if (!f.metaDescription) sink.emit('description.missing', ev);
      if (!f.headings.some((h) => h.level === 1)) sink.emit('h1.missing', ev);
    }
    if (f.metaDescriptionCount > 1) sink.emit('description.multiple', { url: p.url, observed: `${f.metaDescriptionCount} meta descriptions${p.data?.generator === 'inertia' ? ' — Inertia.js: keep the description only in the page <Head> (or mark the template tag with data-inertia/inertia)' : ''}` });
    if (f.hasMetaKeywords) sink.emit('meta.keywords-present', ev);
    if (!f.viewport) sink.emit('mobile.viewport-missing', ev);
    if (!f.lang) sink.emit('html.lang-missing', ev);
    if (!f.openGraph['og:title'] && !f.openGraph['og:description'] && !f.openGraph['og:image']) sink.emit('social.og-missing', ev);

    // Images
    const noAlt = f.images.filter((i) => i.alt === null && i.src);
    if (noAlt.length) sink.emit('img.alt-missing', { url: p.url, observed: `${noAlt.length} image(s), e.g. ${noAlt[0]!.src.slice(0, 120)}` });
    const noDim = f.images.filter((i) => i.src && (!i.width || !i.height) && !i.sizedByLayout);
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

    // Soft 404 heuristic (wording in ERROR_TEXT)
    // A noindexed error page is already excluded from the index, so the soft-404 label adds nothing.
    if (!noindex && (isErrorText(f.title) || f.headings.some((h) => h.level === 1 && isErrorText(h.text)))) {
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

    // Content language vs declared language (only for languages the detector knows).
    const declared = primaryTag(f.lang);
    if (declared && ['en', 'tr', 'de', 'fr', 'es', 'it', 'pt', 'nl'].includes(declared) && !noindex) {
      const detected = detectLanguage(f.mainText);
      if (detected && detected.lang !== declared) sink.emit('lang.content-mismatch', { url: p.url, observed: `lang="${f.lang}" but main content reads as "${detected.lang}"` });
      const foreign = f.headings.filter((h) => !h.chrome && h.level <= 2).map((h) => ({ h, lang: detectShortLanguage(h.text) })).filter((x) => x.lang && x.lang !== declared && x.lang !== detected?.lang);
      if (foreign.length && (!detected || detected.lang === declared)) {
        sink.emit('lang.mixed-navigation', { url: p.url, observed: `lang="${f.lang}"; ${foreign.slice(0, 3).map((x) => `H${x.h.level} "${x.h.text.slice(0, 50)}" looks ${x.lang}`).join('; ')}` });
      }
    }

    // hreflang
    // Google ignores hreflang on non-canonical URLs (e.g. ?filter variants canonicalised to the clean URL).
    if (selfCanon && !noindex) checkHreflang(ctx, p.url, f, sink);

    // Structured data
    checkStructuredData(p.url, f, sink, p === ctx.homepage);
  }

  for (const [title, urls] of titleMap) if (urls.length > 1) sink.emit('duplicate.title', { url: urls[0], observed: `"${title.slice(0, 100)}" on ${urls.length} pages: ${urls.slice(0, 5).join(', ')}` });
  for (const [desc, urls] of descMap) if (urls.length > 1) sink.emit('duplicate.description', { url: urls[0], observed: `"${desc.slice(0, 100)}" on ${urls.length} pages: ${urls.slice(0, 5).join(', ')}` });

  // Broken internal links: every link target we crawled that ended in 4xx.
  for (const [target, sources] of ctx.inlinks) {
    const rec = resolveRecord(ctx, target);
    if (new URL(target).pathname.startsWith('/cdn-cgi/')) continue;
    if (rec && !rec.blockedByRobots && rec.status >= 400 && rec.status < 500) {
      // Repository mode: "missing" means no file was found, which a server rewrite could still serve.
      sink.emit('links.broken-internal', { url: target, observed: `${rec.error ? rec.error : `HTTP ${rec.status}`}, linked from ${sources.size} page(s): ${[...sources].slice(0, 3).join(', ')}` }, rec.error ? { confidence: 'heuristic' } : {});
    }
  }

  checkFacetsAndPagination(ctx, sink);

  // Orphans: sitemap URLs that were crawled fine but have no internal inlinks. A crawl stopped at the page
  // limit has not seen every page that might link to them, so it cannot call a page an orphan.
  for (const u of crawl.truncated ? [] : ctx.sitemapUrls) {
    const rec = ctx.byUrl.get(u);
    if (!rec || rec.status !== 200 || u === crawl.startUrl) continue;
    if (!ctx.reachIn.get(u)?.size && !ctx.reachIn.get(rec.finalUrl)?.size) sink.emit('crawl.sitemap-orphan', { url: u });
  }
}

/**
 * Error-page wording in titles and H1s. Boundaries are Unicode-aware: JavaScript's \\b treats letters such as
 * "ı" as non-word characters, so "sayfa bulunamadı" never matched with \\b.
 */
const ERROR_TEXT = /(?<![\p{L}\p{N}])(404|not found|page not found|sayfa bulunamadı|bulunamadı|(böyle bir )?sayfa yok|nicht gefunden|introuvable|no encontrada|non trovata|niet gevonden|não encontrada)(?![\p{L}\p{N}])/iu;

export function isErrorText(text: string | null | undefined): boolean {
  return !!text && ERROR_TEXT.test(text);
}

function push(m: Map<string, string[]>, k: string, v: string) {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

function compareRender(url: string, raw: NonNullable<ReturnType<typeof factsOf>>, rendered: NonNullable<ReturnType<typeof factsOf>>, sink: FindingSink) {
  const diffs: string[] = [];
  const rawLang = primaryTag(raw.lang);
  const renderedLang = primaryTag(rendered.lang);
  if (rawLang && renderedLang && rawLang !== renderedLang) {
    sink.emit('lang.locale-adaptive', { url, observed: `client-side switch during rendering (browser locale en-US): lang ${raw.lang} → ${rendered.lang}${raw.canonical !== rendered.canonical ? `, canonical ${raw.canonical ?? 'none'} → ${rendered.canonical ?? 'none'}` : ''}${raw.title !== rendered.title ? `, title "${raw.title ?? ''}" → "${rendered.title ?? ''}"` : ''}` });
  }
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
    if (!isValidHreflang(h.lang)) {
      const problem = hreflangProblem(h.lang);
      sink.emit('hreflang.invalid-code', { url, observed: problem.observed }, problem.severity ? { severity: problem.severity } : {});
    }
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

const PAGE_PARAM = /^(page|p|pg|paged|sayfa|seite|pagina)$/i;

/** Page number from ?page=N or /page/N style URLs; null when not paginated. */
export function pageNumber(url: string): number | null {
  const u = new URL(url);
  for (const [k, v] of u.searchParams) if (PAGE_PARAM.test(k) && /^\d+$/.test(v)) return Number(v);
  const m = /\/(?:page|sayfa|seite)\/(\d+)\/?$/i.exec(u.pathname);
  return m ? Number(m[1]) : null;
}

function checkFacetsAndPagination(ctx: SiteContext, sink: FindingSink): void {
  // Parameter variants per path among all internal link targets (crawled or merely discovered).
  const variants = new Map<string, Set<string>>();
  for (const target of new Set([...ctx.inlinks.keys(), ...ctx.pages.map((p) => p.url)])) {
    const u = new URL(target);
    if (!u.search) continue;
    const params = [...u.searchParams.keys()].filter((k) => !PAGE_PARAM.test(k));
    if (!params.length) continue;
    const key = u.origin + u.pathname;
    (variants.get(key) ?? variants.set(key, new Set()).get(key)!).add(u.search);
  }
  for (const [path, set] of variants) {
    if (set.size < 10) continue;
    const paramCount = new Map<string, number>();
    for (const q of set) for (const k of new URLSearchParams(q).keys()) if (!PAGE_PARAM.test(k)) paramCount.set(k, (paramCount.get(k) ?? 0) + 1);
    const crawled = ctx.pages.filter((p) => p.url.startsWith(path + '?'));
    const blocked = crawled.filter((p) => p.blockedByRobots).length;
    const canonicalised = crawled.filter((p) => { const f = factsOf(p); return f?.canonical && normalizeUrl(f.canonical) !== normalizeUrl(p.finalUrl); }).length;
    const params = [...paramCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k} (${n})`).join(', ');
    sink.emit('crawl.facet-explosion', {
      url: path,
      observed: `${set.size} parameter variants linked internally; parameters: ${params}; of ${crawled.length} crawled variants, ${blocked} robots-blocked, ${canonicalised} canonicalised elsewhere`,
    });
  }
  // Paginated pages that canonicalise to page 1.
  for (const p of ctx.htmlPages) {
    const n = pageNumber(p.finalUrl);
    if (!n || n < 2) continue;
    const canon = factsOf(p)?.canonical;
    if (!canon) continue;
    const cn = pageNumber(canon);
    const sameSeries = new URL(canon).pathname.replace(/\/(?:page|sayfa|seite)\/\d+\/?$/i, '/').replace(/\/$/, '') === new URL(p.finalUrl).pathname.replace(/\/(?:page|sayfa|seite)\/\d+\/?$/i, '/').replace(/\/$/, '');
    if (sameSeries && (cn === null || cn === 1)) sink.emit('pagination.canonical-to-first', { url: p.url, observed: `page ${n} → canonical ${canon}` });
  }
}
