import * as cheerio from 'cheerio/slim';
import { parse as parseHtml } from 'parse5';
import { adapter as htmlparser2Adapter } from 'parse5-htmlparser2-tree-adapter';
import { normalizeUrl } from '../core/url.js';

export interface LinkInfo {
  href: string;
  /** Absolute, normalised URL (null when not http/https). */
  url: string | null;
  text: string;
  rel: string[];
  internal: boolean;
  /** True for <a> without href, or href="javascript:..." / "#" (not crawlable per Google JS SEO guidance). */
  uncrawlable: boolean;
}

export interface ImageInfo {
  src: string;
  alt: string | null;
  width?: string;
  height?: string;
  loading?: string;
}

export interface JsonLdBlock {
  raw: string;
  data: unknown;
  error?: string;
  types: string[];
}

export interface PageData {
  url: string;
  lang: string | null;
  title: string | null;
  titleCount: number;
  metaDescription: string | null;
  metaDescriptionCount: number;
  metaRobots: string[];
  /** Bot-specific meta robots, e.g. <meta name="googlebot">. Keyed by lower-case name. */
  botRobots: Record<string, string[]>;
  canonical: string | null;
  /** canonical href exactly as written (to detect relative URLs). */
  canonicalRaw: string | null;
  canonicalCount: number;
  /** rel=canonical links that ended up in <body> after HTML5 parsing (ignored by Google). */
  canonicalOutsideHead: number;
  hreflang: Array<{ lang: string; href: string }>;
  /** hreflang hrefs exactly as written (to detect relative URLs). */
  hreflangRaw: string[];
  hasMetaKeywords: boolean;
  viewport: string | null;
  charset: string | null;
  headings: Array<{ level: number; text: string }>;
  links: LinkInfo[];
  images: ImageInfo[];
  jsonLd: JsonLdBlock[];
  microdataTypes: string[];
  /** RDFa `typeof` types (schema.org vocabulary prefixes stripped). */
  rdfaTypes: string[];
  openGraph: Record<string, string>;
  twitter: Record<string, string>;
  metaRefresh: string | null;
  textContent: string;
  wordCount: number;
  /** Main content text: <main>/[role=main]/<article>, else body without header/nav/footer/aside. */
  mainText: string;
  mainWordCount: number;
  /** Words inside links within the main content (link density = mainLinkWordCount / mainWordCount). */
  mainLinkWordCount: number;
  /** Bytes of inline <script> + count of external scripts: a rough JS dependence signal. */
  scriptCount: number;
  hasNoscriptContent: boolean;
  /** Empty-shell SPA signal: almost no text but a root mount node and scripts. */
  likelyClientRendered: boolean;
  formsCount: number;
  iframes: number;
  /** Framework hints from markup (e.g. Next.js), used to explain UA-dependent behaviour. */
  generator: string | null;
  /** Structure signals used by content/GEO heuristics. */
  structure: {
    paragraphs: number;
    avgParagraphWords: number;
    lists: number;
    tables: number;
    questionHeadings: number;
    hasPublishedDate: boolean;
    hasAuthor: boolean;
  };
  /** Subresource URLs (img/script/link/iframe/source) for mixed-content checks. */
  subresources: string[];
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Concatenate text nodes with a separator. cheerio's .text() joins adjacent elements without
 * whitespace ("<a>Menu</a><h1>Page</h1>" → "MenuPage"), which corrupts word statistics.
 */
function visibleText(root: ReturnType<cheerio.CheerioAPI>): string {
  const parts: string[] = [];
  const walk = (nodes: ArrayLike<unknown>) => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i] as { type: string; data?: string; children?: unknown[] };
      if (n.type === 'text') parts.push(n.data ?? '');
      else if (n.children) walk(n.children);
    }
  };
  walk(root.toArray());
  return collapse(parts.join(' '));
}

function collectTypes(node: unknown, out: Set<string>, depth = 0): void {
  if (depth > 20 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) collectTypes(n, out, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  const t = obj['@type'];
  if (typeof t === 'string') out.add(t);
  else if (Array.isArray(t)) for (const x of t) if (typeof x === 'string') out.add(x);
  for (const [k, v] of Object.entries(obj)) if (k !== '@context') collectTypes(v, out, depth + 1);
}

/**
 * Parse an HTML document into the facts every analyzer needs. Parsing never executes scripts
 * (cheerio is a static parser), so hostile pages cannot run code here.
 */
/**
 * Parse with parse5 (WHATWG HTML tree construction, like browsers and Googlebot) into an
 * htmlparser2-compatible DOM, then query it with cheerio. Spec-compliant parsing matters: e.g. an
 * invalid element inside <head> implicitly closes it, moving a later rel=canonical into <body>.
 */
export function loadHtml(html: string): cheerio.CheerioAPI {
  const doc = parseHtml(html, { treeAdapter: htmlparser2Adapter, scriptingEnabled: false });
  return cheerio.load(doc as unknown as Parameters<typeof cheerio.load>[0]);
}

export function extractPage(html: string, pageUrl: string): PageData {
  const $ = loadHtml(html);
  const baseHref = $('base[href]').attr('href');
  const base = (baseHref && normalizeUrl(baseHref, pageUrl)) || pageUrl;
  const origin = new URL(pageUrl).hostname.replace(/^www\./, '');

  const metaContent = (name: string) =>
    $(`meta[name="${name}" i]`)
      .map((_, el) => $(el).attr('content') ?? '')
      .get();

  const metaRobots = metaContent('robots')
    .flatMap((c) => c.split(','))
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);

  const botRobots: Record<string, string[]> = {};
  $('meta[name]').each((_, el) => {
    const name = ($(el).attr('name') ?? '').toLowerCase();
    if (['googlebot', 'googlebot-news', 'bingbot', 'yandex', 'yandexbot'].includes(name)) {
      botRobots[name] = ($(el).attr('content') ?? '')
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean);
    }
  });

  // Google only accepts rel=canonical inside <head>; canonicals the HTML5 parser placed in <body> are ignored.
  const canonicals = $('head link[rel~="canonical" i]');
  const canonicalHref = canonicals.first().attr('href');
  const canonicalOutsideHead = $('body link[rel~="canonical" i]').length;

  const hreflang = $('link[rel~="alternate" i][hreflang]')
    .map((_, el) => ({ lang: ($(el).attr('hreflang') ?? '').trim(), href: normalizeUrl($(el).attr('href') ?? '', base, { stripTracking: false }) ?? '' }))
    .get()
    .filter((h) => h.lang && h.href);

  const headings: PageData['headings'] = [];
  $('h1,h2,h3,h4,h5,h6').each((_, el) => {
    headings.push({ level: Number(el.tagName.slice(1)), text: collapse($(el).text()).slice(0, 300) });
  });

  /** Accessible name per WAI-ARIA naming order (aria-labelledby → aria-label → content incl. img alt → title). */
  const accessibleName = (el: Parameters<typeof $>[0]): string => {
    const $el = $(el);
    const labelledby = ($el.attr('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
    if (labelledby.length) {
      const t = collapse(labelledby.map((id) => $(`[id="${id.replace(/"/g, '')}"]`).text()).join(' '));
      if (t) return t;
    }
    const aria = collapse($el.attr('aria-label') ?? '');
    if (aria) return aria;
    const content = collapse([$el.text(), ...$el.find('img[alt]').map((_, i) => $(i).attr('alt') ?? '').get()].join(' '));
    if (content) return content;
    return collapse($el.attr('title') ?? '');
  };
  const links: LinkInfo[] = [];
  $('a').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    const rel = ($(el).attr('rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const text = accessibleName(el).slice(0, 200);
    const uncrawlable = !href || href.startsWith('javascript:') || href === '#';
    const url = uncrawlable || href.startsWith('#') || /^(mailto|tel|sms|data):/i.test(href) ? null : normalizeUrl(href, base);
    let internal = false;
    if (url) internal = new URL(url).hostname.replace(/^www\./, '') === origin;
    links.push({ href, url, text, rel, internal, uncrawlable });
  });

  const images: ImageInfo[] = $('img')
    .map((_, el) => ({
      src: $(el).attr('src') ?? $(el).attr('data-src') ?? '',
      alt: $(el).attr('alt') ?? null,
      width: $(el).attr('width'),
      height: $(el).attr('height'),
      loading: $(el).attr('loading'),
    }))
    .get();

  const jsonLd: JsonLdBlock[] = [];
  $('script[type="application/ld+json" i]').each((_, el) => {
    const raw = $(el).text().trim();
    const types = new Set<string>();
    try {
      const data = JSON.parse(raw);
      collectTypes(data, types);
      jsonLd.push({ raw: raw.slice(0, 20000), data, types: [...types] });
    } catch (e) {
      jsonLd.push({ raw: raw.slice(0, 2000), data: null, error: (e as Error).message, types: [] });
    }
  });

  // itemtype may hold several space-separated type URLs.
  const microdataTypes = $('[itemtype]')
    .map((_, el) => ($(el).attr('itemtype') ?? '').split(/\s+/).map((t) => t.replace(/\/+$/, '').split(/[/#]/).pop() ?? ''))
    .get()
    .flat()
    .filter(Boolean);
  const rdfaTypes = $('[typeof]')
    .map((_, el) => ($(el).attr('typeof') ?? '').split(/\s+/).map((t) => t.replace(/^(schema|s):/, '').split(/[/#]/).pop() ?? ''))
    .get()
    .flat()
    .filter(Boolean);

  const openGraph: Record<string, string> = {};
  $('meta[property^="og:" i]').each((_, el) => {
    openGraph[($(el).attr('property') ?? '').toLowerCase()] = $(el).attr('content') ?? '';
  });
  const twitter: Record<string, string> = {};
  $('meta[name^="twitter:" i]').each((_, el) => {
    twitter[($(el).attr('name') ?? '').toLowerCase()] = $(el).attr('content') ?? '';
  });

  const scriptCount = $('script').not('[type="application/ld+json" i]').length;
  const hasNoscriptContent = collapse($('noscript').text()).length > 20;
  const formsCount = $('form').length;
  const iframes = $('iframe').length;

  // <title> inside inline SVG labels the graphic, not the document.
  const docTitles = $('title').filter((_, el) => $(el).closest('svg').length === 0);
  const titles = docTitles.first();
  const titleCount = docTitles.length;

  // Visible text: drop non-content elements before measuring.
  const body = $('body').clone();
  // Declarative shadow DOM (<template shadowrootmode>) is rendered content; Google flattens shadow DOM.
  body.find('script,style,noscript,svg,iframe').remove();
  body.find('template').not('[shadowrootmode],[shadowroot]').remove();
  const textContent = visibleText(body);
  // Main content excludes repeated chrome (navigation, header, footer) so duplicate and thin-content
  // checks compare what is unique to the page.
  const mainEl = body.find('main, [role="main"]').first();
  let mainRoot = mainEl.length ? mainEl.clone() : body.find('article').length === 1 ? body.find('article').first().clone() : body.clone();
  mainRoot.find('nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], form').remove();
  if (!mainEl.length && !mainRoot.text().trim()) mainRoot = body.clone();
  const mainText = visibleText(mainRoot);
  const countWords = (t: string) => (t ? t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0);
  const wordCount = textContent ? textContent.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0;
  const hasMountNode = $('#root,#app,#__next,#__nuxt,[data-reactroot],app-root').length > 0;
  const likelyClientRendered = wordCount < 50 && scriptCount > 0 && hasMountNode;

  const descriptions = metaContent('description');

  const paraWords = body
    .find('p')
    .map((_, el) => collapse($(el).text()).split(/\s+/).filter(Boolean).length)
    .get()
    .filter((n: number) => n > 0);
  const questionHeadings = headings.filter((h) => h.level >= 2 && /\?\s*$|^(how|what|why|when|where|which|who|can|does|is|are|should|nasıl|neden|nedir|ne zaman|hangi|kim)\b/i.test(h.text)).length;
  const ldText = jsonLd.map((b) => b.raw).join(' ');
  const structure = {
    paragraphs: paraWords.length,
    avgParagraphWords: paraWords.length ? Math.round(paraWords.reduce((a: number, b: number) => a + b, 0) / paraWords.length) : 0,
    lists: body.find('ul,ol').length,
    tables: body.find('table').length,
    questionHeadings,
    hasPublishedDate: $('time[datetime]').length > 0 || /"datePublished"|"dateModified"/.test(ldText) || $('meta[property="article:published_time"]').length > 0,
    hasAuthor: /"author"/.test(ldText) || $('[rel~="author"],meta[name="author" i],[itemprop="author"]').length > 0,
  };
  const subresources = $('img[src],script[src],link[rel~="stylesheet"][href],iframe[src],source[src],video[src],audio[src]')
    .map((_, el) => $(el).attr('src') ?? $(el).attr('href') ?? '')
    .get()
    .filter(Boolean)
    .slice(0, 500);

  return {
    url: pageUrl,
    lang: $('html').attr('lang')?.trim() || null,
    title: titleCount ? collapse(titles.text()) : null,
    titleCount,
    metaDescription: descriptions.length ? collapse(descriptions[0]!) : null,
    metaDescriptionCount: descriptions.length,
    metaRobots,
    botRobots,
    canonical: canonicalHref !== undefined ? normalizeUrl(canonicalHref, base, { stripTracking: false }) : null,
    canonicalRaw: canonicalHref?.trim() ?? null,
    canonicalCount: canonicals.length,
    canonicalOutsideHead,
    hreflang,
    hreflangRaw: $('link[rel~="alternate" i][hreflang]').map((_, el) => ($(el).attr('href') ?? '').trim()).get(),
    hasMetaKeywords: $('meta[name="keywords" i]').length > 0,
    viewport: $('meta[name="viewport" i]').attr('content') ?? null,
    charset: $('meta[charset]').attr('charset') ?? null,
    headings,
    links,
    images,
    jsonLd,
    microdataTypes,
    rdfaTypes,
    openGraph,
    twitter,
    metaRefresh: $('meta[http-equiv="refresh" i]').attr('content') ?? null,
    textContent: textContent.slice(0, 100000),
    mainText: mainText.slice(0, 100000),
    mainWordCount: countWords(mainText),
    mainLinkWordCount: countWords(collapse(mainRoot.find('a').map((_, a) => $(a).text()).get().join(' '))),
    wordCount,
    scriptCount,
    hasNoscriptContent,
    likelyClientRendered,
    formsCount,
    iframes,
    generator: $('script[src*="/_next/static/"]').length || $('#__next').length
      ? 'next.js'
      : $('[data-inertia]').length || $('[data-page][id="app"]').length
        ? 'inertia'
        : $('meta[name="generator" i]').attr('content')?.slice(0, 60) ?? null,
    structure,
    subresources,
  };
}

/** Parse an X-Robots-Tag header (possibly with bot prefixes, e.g. "googlebot: noindex"). */
export function parseXRobotsTag(header: string | undefined): { all: string[]; byBot: Record<string, string[]> } {
  const all: string[] = [];
  const byBot: Record<string, string[]> = {};
  if (!header) return { all, byBot };
  for (const part of header.split(/,(?=\s*[a-z-]+\s*:)|\n/i)) {
    const m = /^\s*([a-z][a-z0-9_-]*)\s*:\s*(.+)$/i.exec(part);
    // "unavailable_after: date" is a directive, not a bot prefix.
    if (m && m[1]!.toLowerCase() !== 'unavailable_after') {
      byBot[m[1]!.toLowerCase()] = m[2]!.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
    } else {
      all.push(...part.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean));
    }
  }
  return { all, byBot };
}
