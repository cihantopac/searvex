import { factsOf, isNoindex, type SiteContext } from './context.js';
import { typedNodes } from './structured-data.js';
import { pageIntent, type Intent } from './intent.js';

export type PageType =
  | 'home' | 'product' | 'category' | 'blog-post' | 'blog-index' | 'docs' | 'pricing' | 'about' | 'contact'
  | 'legal' | 'careers' | 'landing' | 'tag-archive' | 'author' | 'search' | 'service' | 'other';

export interface InventoryPage {
  url: string;
  type: PageType;
  /** How the type was decided: "schema" is strongest, "url" is a pattern guess. */
  basis: 'schema' | 'url' | 'default';
  lang: string | null;
  title: string | null;
  status: number;
  indexable: boolean;
  depth: number;
  inlinks: number;
  words: number;
  /** Intent the page type is built for (inferred, never measured). */
  intent?: Intent;
}

export interface SiteInventory {
  pages: InventoryPage[];
  byType: Record<string, number>;
  /** Pages per inferred intent (from page type). */
  intents?: Record<string, number>;
  languages: Record<string, number>;
  hreflangLanguages: string[];
  statusCodes: Record<string, number>;
  /** Likely business model inferred from page types and schema. Heuristic. */
  /** Heuristic classification with the signals that produced it and runner-up labels. */
  businessModel: { label: string; evidence: string[]; confidence?: 'high' | 'medium' | 'low'; alternatives?: Array<{ label: string; score: number }> };
  /** Products / services / apps declared in structured data (names, kinds, prices as declared). */
  offerings?: Array<{ name: string; kind: string; url?: string; price?: string; currency?: string; pages: number }>;
  /** Organisation relationships declared in structured data (brand family / ecosystem). */
  relations?: Array<{ from: string; relation: string; to: string; toUrl?: string }>;
  sections: Array<{ path: string; pages: number }>;
  /** Structured data actually present on crawled pages, by type. */
  structuredData: {
    types: Array<{ type: string; pages: number; formats: Array<'json-ld' | 'microdata' | 'rdfa'>; example: string }>;
    pagesWithStructuredData: number;
    invalidJsonLdPages: number;
  };
}

/** All schema.org types on a page with the syntax they were found in. */
export function pageSchemaTypes(f: NonNullable<ReturnType<typeof factsOf>>): Map<string, Set<'json-ld' | 'microdata' | 'rdfa'>> {
  const out = new Map<string, Set<'json-ld' | 'microdata' | 'rdfa'>>();
  const add = (t: string, fmt: 'json-ld' | 'microdata' | 'rdfa') => {
    const set = out.get(t) ?? new Set();
    set.add(fmt);
    out.set(t, set);
  };
  for (const b of f.jsonLd) for (const n of typedNodes(b.data)) for (const t of ([] as unknown[]).concat(n['@type'] ?? [])) if (typeof t === 'string') add(t.replace(/^(https?:\/\/schema\.org\/|schema:)/, ''), 'json-ld');
  for (const t of f.microdataTypes) add(t, 'microdata');
  for (const t of f.rdfaTypes ?? []) add(t, 'rdfa');
  return out;
}

const URL_RULES: Array<[RegExp, PageType]> = [
  [/\/(products?|p|shop\/[^/]+|item|urun|urunler)\/[^/]+/i, 'product'],
  [/\/(category|categories|collections?|c|kategori|shop)(\/|$)/i, 'category'],
  [/\/(blog|news|articles?|posts?|haber|yazilar|insights)\/[^/]+/i, 'blog-post'],
  [/\/(blog|news|articles|haber)\/?$/i, 'blog-index'],
  [/\/(docs?|documentation|guides?|reference|api|help|kb|knowledge-base|support)(\/|$)/i, 'docs'],
  [/\/(pricing|plans|fiyat|fiyatlandirma)(\/|$)/i, 'pricing'],
  [/\/(about|about-us|company|team|hakkimizda|hakkinda)(\/|$)/i, 'about'],
  [/\/(contact|contact-us|iletisim)(\/|$)/i, 'contact'],
  [/\/(privacy|terms|legal|cookie|gdpr|kvkk|impressum|imprint)/i, 'legal'],
  [/\/(careers|jobs|kariyer)(\/|$)/i, 'careers'],
  [/\/(tag|tags|etiket|topics?)\//i, 'tag-archive'],
  [/\/(author|authors|yazar)\//i, 'author'],
  [/\/(search|ara)(\/|$|\?)/i, 'search'],
  [/\/(services?|solutions?|hizmetler|cozumler|features?|use-cases?)(\/|$)/i, 'service'],
  [/\/(lp|landing|campaign|promo)\//i, 'landing'],
];

function schemaType(types: Set<string>): PageType | null {
  if (types.has('Product') || types.has('ProductGroup')) return 'product';
  if (types.has('BlogPosting') || types.has('NewsArticle') || types.has('Article')) return 'blog-post';
  if (types.has('TechArticle')) return 'docs';
  if (types.has('CollectionPage') || types.has('ItemList')) return 'category';
  if (types.has('AboutPage')) return 'about';
  if (types.has('ContactPage')) return 'contact';
  if (types.has('JobPosting')) return 'careers';
  if (types.has('Service')) return 'service';
  return null;
}

export function buildInventory(ctx: SiteContext): SiteInventory {
  const pages: InventoryPage[] = [];
  const statusCodes: Record<string, number> = {};
  for (const p of ctx.pages) {
    const key = p.blockedByRobots ? 'robots-blocked' : p.error ? 'error' : String(p.status);
    statusCodes[key] = (statusCodes[key] ?? 0) + 1;
    const f = factsOf(p);
    if (!f || p.status !== 200 || p.redirects.length) continue;
    const types = new Set<string>();
    for (const b of f.jsonLd) for (const n of typedNodes(b.data)) for (const t of ([] as unknown[]).concat(n['@type'] ?? [])) if (typeof t === 'string') types.add(t);
    const path = new URL(p.finalUrl).pathname;
    let type: PageType = 'other';
    let basis: InventoryPage['basis'] = 'default';
    if (p === ctx.homepage || path === '/' || /^\/[a-z]{2}(-[a-z]{2})?\/?$/i.test(path)) {
      type = 'home';
      basis = 'url';
    } else {
      const s = schemaType(types);
      if (s) {
        type = s;
        basis = 'schema';
      } else {
        const r = URL_RULES.find(([re]) => re.test(path));
        if (r) {
          type = r[1];
          basis = 'url';
        }
      }
    }
    pages.push({
      url: p.url, type, basis, lang: f.lang, title: f.title, status: p.status, indexable: !isNoindex(p), depth: p.depth,
      inlinks: ctx.inlinks.get(p.url)?.size ?? 0, words: f.wordCount, intent: pageIntent({ type, basis })?.intent,
    });
  }
  const byType: Record<string, number> = {};
  const intents: Record<string, number> = {};
  const languages: Record<string, number> = {};
  for (const p of pages) {
    byType[p.type] = (byType[p.type] ?? 0) + 1;
    intents[p.intent ?? 'unclassified'] = (intents[p.intent ?? 'unclassified'] ?? 0) + 1;
    const l = (p.lang ?? 'unspecified').toLowerCase();
    languages[l] = (languages[l] ?? 0) + 1;
  }
  const hreflangLanguages = [...new Set(ctx.htmlPages.flatMap((p) => factsOf(p)!.hreflang.map((h) => h.lang)))].sort();
  const sectionsMap = new Map<string, number>();
  for (const p of pages) {
    const seg = '/' + (new URL(p.url).pathname.split('/').filter(Boolean)[0] ?? '');
    sectionsMap.set(seg, (sectionsMap.get(seg) ?? 0) + 1);
  }
  const sdTypes = new Map<string, { pages: number; formats: Set<'json-ld' | 'microdata' | 'rdfa'>; example: string }>();
  let pagesWithSd = 0;
  let invalidJsonLdPages = 0;
  for (const p of ctx.htmlPages) {
    const f = factsOf(p)!;
    if (f.jsonLd.some((b) => b.error)) invalidJsonLdPages++;
    const types = pageSchemaTypes(f);
    if (types.size) pagesWithSd++;
    for (const [t, fmts] of types) {
      const e = sdTypes.get(t) ?? { pages: 0, formats: new Set(), example: p.url };
      e.pages++;
      for (const x of fmts) e.formats.add(x);
      sdTypes.set(t, e);
    }
  }
  const { businessModel, offerings, relations } = classifyBusiness(ctx, byType, sdTypes);
  const evidence = businessModel.evidence;
  const label = businessModel.label;
  if (hreflangLanguages.length > 1) evidence.push(`multilingual: ${hreflangLanguages.join(', ')}`);
  return {
    pages,
    byType,
    intents,
    languages,
    hreflangLanguages,
    statusCodes,
    businessModel: { ...businessModel, label, evidence },
    offerings,
    relations,
    structuredData: {
      types: [...sdTypes.entries()].map(([type, e]) => ({ type, pages: e.pages, formats: [...e.formats], example: e.example })).sort((a, b) => b.pages - a.pages || a.type.localeCompare(b.type)),
      pagesWithStructuredData: pagesWithSd,
      invalidJsonLdPages,
    },
    sections: [...sectionsMap.entries()].map(([path, c]) => ({ path, pages: c })).sort((a, b) => b.pages - a.pages).slice(0, 30),
  };
}

type SdTypeMap = Map<string, { pages: number }>;

/**
 * Score-based business model classification. Each label accumulates weighted signals; the result
 * lists the evidence and the runner-up labels so a reader can judge it. Purely a heuristic.
 */
export function classifyBusiness(ctx: SiteContext, byType: Record<string, number>, sd: SdTypeMap) {
  const score: Record<string, number> = {};
  const why: Record<string, string[]> = {};
  const add = (label: string, pts: number, reason: string) => {
    score[label] = (score[label] ?? 0) + pts;
    (why[label] ??= []).push(reason);
  };
  const has = (t: string) => (sd.get(t)?.pages ?? 0) > 0;
  const n = (t: string) => byType[t] ?? 0;
  const linkPaths = new Set<string>();
  for (const p of ctx.htmlPages) for (const l of factsOf(p)!.links) if (l.url) linkPaths.add(new URL(l.url).pathname.toLowerCase() + ' ' + l.text.toLowerCase());
  const linked = (re: RegExp) => [...linkPaths].some((x) => re.test(x));

  if (has('SoftwareApplication') || has('WebApplication') || has('MobileApplication')) add('SaaS / software product', 5, 'SoftwareApplication/WebApplication structured data');
  if (linked(/\/(login|signin|sign-in|register|signup|sign-up|giris|kayit|app)(\/|\s|$)/)) add('SaaS / software product', 2, 'login/sign-up links');
  if (n('pricing')) add('SaaS / software product', 2, 'pricing page');
  // Docs/help pages support a software classification but are not evidence on their own (publishers
  // and agencies have help sections too).
  if (n('docs') >= 3 && score['SaaS / software product']) add('SaaS / software product', 1, `${n('docs')} docs/help pages`);

  if (has('Product') || has('ProductGroup')) add('e-commerce', 4, 'Product structured data');
  if (n('product') >= 3) add('e-commerce', 3, `${n('product')} product pages`);
  if (n('category') >= 2) add('e-commerce', 1, `${n('category')} category pages`);
  if (linked(/\/(cart|basket|checkout|sepet|odeme)(\/|\s|$)/)) add('e-commerce', 3, 'cart/checkout links');

  const articles = n('blog-post');
  const pages = Math.max(1, Object.values(byType).reduce((a, b) => a + b, 0));
  if (articles / pages > 0.5) add('publisher / blog', 4, `${articles} of ${pages} pages are articles`);
  const articleSd = Math.max(sd.get('Article')?.pages ?? 0, sd.get('BlogPosting')?.pages ?? 0, sd.get('NewsArticle')?.pages ?? 0);
  if (articles / pages > 0.2 || articleSd / pages > 0.2) add('publisher / blog', 2, `${Math.max(articles, articleSd)} article pages (${Math.round((Math.max(articles, articleSd) / pages) * 100)}%)`);
  if (has('NewsArticle') || has('BlogPosting')) add('publisher / blog', 1, 'Article structured data');

  if (n('service') >= 2 || has('Service') || has('ProfessionalService')) add('service business', 3, 'service pages / Service structured data');
  if (has('LocalBusiness') || [...sd.keys()].some((t) => /Restaurant|Store|Dentist|Clinic|Hotel|Agency/.test(t))) add('local business', 4, 'LocalBusiness structured data');
  if (n('legal') + n('about') + n('careers') + n('contact') >= pages * 0.5) add('content / corporate site', 2, 'mostly company pages (about, careers, legal, contact)');
  add('content / corporate site', 1, 'default');

  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  const confidence: 'high' | 'medium' | 'low' = !second || best![1] - second[1] >= 4 ? 'high' : best![1] - second[1] >= 2 ? 'medium' : 'low';

  // Offerings and relations from structured data (top-level and nested nodes).
  const offers = new Map<string, { name: string; kind: string; url?: string; price?: string; currency?: string; pages: number }>();
  const relations = new Map<string, { from: string; relation: string; to: string; toUrl?: string }>();
  for (const p of ctx.htmlPages) {
    const seen = new Set<string>();
    for (const b of factsOf(p)!.jsonLd) {
      for (const node of typedNodes(b.data)) {
        const types = ([] as unknown[]).concat(node['@type'] ?? []).filter((x): x is string => typeof x === 'string');
        const name = typeof node['name'] === 'string' ? node['name'].trim() : '';
        const kind = types.find((t) => /^(Product|ProductGroup|SoftwareApplication|WebApplication|MobileApplication|Service|Course|Event)$/.test(t));
        if (kind && name) {
          const key = `${kind}:${name.toLowerCase()}`;
          const offer = ([] as unknown[]).concat(node['offers'] ?? [])[0] as Record<string, unknown> | undefined;
          const e = offers.get(key) ?? { name, kind, url: typeof node['url'] === 'string' ? node['url'] : undefined, price: offer?.['price'] !== undefined ? String(offer['price']) : undefined, currency: typeof offer?.['priceCurrency'] === 'string' ? offer['priceCurrency'] : undefined, pages: 0 };
          if (!seen.has(key)) e.pages++;
          seen.add(key);
          offers.set(key, e);
        }
        if (name && types.some((t) => /Organization|Corporation/.test(t))) {
          for (const rel of ['parentOrganization', 'subOrganization', 'brand', 'owns', 'memberOf', 'department']) {
            for (const target of ([] as unknown[]).concat(node[rel] ?? [])) {
              const t = target as Record<string, unknown>;
              const tn = typeof t === 'string' ? t : typeof t?.['name'] === 'string' ? (t['name'] as string) : '';
              if (tn) relations.set(`${name}|${rel}|${tn}`, { from: name, relation: rel, to: tn, toUrl: typeof t?.['url'] === 'string' ? (t['url'] as string) : undefined });
            }
          }
        }
      }
    }
  }
  return {
    businessModel: { label: best![0], evidence: why[best![0]]!.filter((r) => r !== 'default'), confidence, alternatives: ranked.slice(1, 3).map(([label, s]) => ({ label, score: s })) },
    offerings: [...offers.values()].sort((a, b) => b.pages - a.pages).slice(0, 50),
    relations: [...relations.values()],
  };
}
