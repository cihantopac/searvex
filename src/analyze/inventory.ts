import { factsOf, isNoindex, type SiteContext } from './context.js';
import { typedNodes } from './structured-data.js';

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
}

export interface SiteInventory {
  pages: InventoryPage[];
  byType: Record<string, number>;
  languages: Record<string, number>;
  hreflangLanguages: string[];
  statusCodes: Record<string, number>;
  /** Likely business model inferred from page types and schema. Heuristic. */
  businessModel: { label: string; evidence: string[] };
  sections: Array<{ path: string; pages: number }>;
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
      inlinks: ctx.inlinks.get(p.url)?.size ?? 0, words: f.wordCount,
    });
  }
  const byType: Record<string, number> = {};
  const languages: Record<string, number> = {};
  for (const p of pages) {
    byType[p.type] = (byType[p.type] ?? 0) + 1;
    const l = (p.lang ?? 'unspecified').toLowerCase();
    languages[l] = (languages[l] ?? 0) + 1;
  }
  const hreflangLanguages = [...new Set(ctx.htmlPages.flatMap((p) => factsOf(p)!.hreflang.map((h) => h.lang)))].sort();
  const sectionsMap = new Map<string, number>();
  for (const p of pages) {
    const seg = '/' + (new URL(p.url).pathname.split('/').filter(Boolean)[0] ?? '');
    sectionsMap.set(seg, (sectionsMap.get(seg) ?? 0) + 1);
  }
  const evidence: string[] = [];
  let label = 'content / corporate site';
  const n = (t: PageType) => byType[t] ?? 0;
  if (n('product') >= 3 || ctx.htmlPages.some((p) => factsOf(p)!.jsonLd.some((b) => /"Offer"|"AggregateOffer"/.test(b.raw)))) {
    label = 'e-commerce';
    evidence.push(`${n('product')} product pages`, `${n('category')} category pages`);
  } else if (n('pricing') > 0 && (n('docs') > 0 || n('service') > 0)) {
    label = 'SaaS / software product';
    evidence.push('pricing page present', `${n('docs')} docs pages`, `${n('service')} feature/solution pages`);
  } else if (n('blog-post') > pages.length * 0.5) {
    label = 'publisher / blog';
    evidence.push(`${n('blog-post')} of ${pages.length} pages are articles`);
  } else if (n('service') > 0) {
    label = 'service business';
    evidence.push(`${n('service')} service pages`);
  }
  if (hreflangLanguages.length > 1) evidence.push(`multilingual: ${hreflangLanguages.join(', ')}`);
  return {
    pages,
    byType,
    languages,
    hreflangLanguages,
    statusCodes,
    businessModel: { label, evidence },
    sections: [...sectionsMap.entries()].map(([path, c]) => ({ path, pages: c })).sort((a, b) => b.pages - a.pages).slice(0, 30),
  };
}
