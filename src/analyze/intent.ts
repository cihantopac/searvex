import type { InventoryPage, PageType } from './inventory.js';

/**
 * Search intent, always *inferred*: from query wording (multilingual cue words) or from a page's type.
 * Searvex never presents an inferred intent as measured; callers keep it apart from verified data.
 */
export type Intent = 'informational' | 'commercial' | 'transactional' | 'navigational';

export interface IntentGuess {
  intent: Intent;
  /** The cues that produced the label (words matched, page type). */
  signals: string[];
  basis: 'inferred';
}

// Cue words per intent (en, tr, de, fr, es, it, pt, nl). Matched on whole words after lower-casing.
const CUES: Record<Exclude<Intent, 'navigational'>, string[]> = {
  transactional: [
    'buy', 'price', 'prices', 'pricing', 'cost', 'cheap', 'discount', 'coupon', 'deal', 'order', 'download', 'subscribe', 'trial', 'signup', 'sign up', 'quote', 'hire', 'book',
    'satın al', 'satın', 'fiyat', 'fiyatı', 'fiyatları', 'ücret', 'ücreti', 'ücretsiz', 'indir', 'sipariş', 'kampanya', 'indirim', 'kupon', 'abonelik', 'kirala',
    'kaufen', 'preis', 'preise', 'kosten', 'bestellen', 'gutschein', 'acheter', 'prix', 'tarif', 'tarifs', 'commander', 'comprar', 'precio', 'precios', 'descargar',
    'acquistare', 'prezzo', 'prezzi', 'preço', 'kopen', 'prijs', 'bestellen',
  ],
  commercial: [
    'best', 'top', 'vs', 'versus', 'review', 'reviews', 'compare', 'comparison', 'alternative', 'alternatives', 'alternative to', 'recommended', 'pros and cons',
    'en iyi', 'karşılaştırma', 'karşılaştır', 'alternatif', 'alternatifleri', 'yorum', 'yorumları', 'inceleme', 'tavsiye', 'önerilen', 'hangisi',
    'beste', 'vergleich', 'erfahrungen', 'meilleur', 'meilleurs', 'comparatif', 'avis', 'mejor', 'mejores', 'comparativa', 'opiniones',
    'migliore', 'migliori', 'confronto', 'recensioni', 'melhor', 'melhores', 'beste', 'vergelijken', 'ervaringen',
  ],
  informational: [
    'how', 'what', 'why', 'when', 'where', 'who', 'which', 'guide', 'tutorial', 'example', 'examples', 'meaning', 'definition', 'tips', 'learn', 'ideas',
    'nasıl', 'nedir', 'ne', 'neden', 'niçin', 'nerede', 'ne zaman', 'kimdir', 'rehber', 'rehberi', 'örnek', 'örnekleri', 'anlamı', 'ipuçları', 'yapılır', 'öğren',
    'wie', 'warum', 'anleitung', 'comment', 'pourquoi', 'qu\'est-ce', 'guide', 'cómo', 'qué', 'por qué', 'guía', 'cosa', 'perché', 'guida', 'como', 'o que', 'hoe', 'wat', 'waarom',
  ],
};
const NAV_CUES = ['login', 'log in', 'sign in', 'account', 'contact', 'support', 'dashboard', 'giriş', 'giriş yap', 'oturum aç', 'hesabım', 'iletişim', 'destek', 'anmelden', 'connexion', 'iniciar sesión', 'accedi'];

const norm = (s: string) => ` ${s.toLocaleLowerCase('tr').replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim()} `;
const hits = (q: string, words: string[]) => [...new Set(words.filter((w) => q.includes(` ${w} `)))];

/** Infer the dominant intent of a search query; null when no cue matches. `brands` marks navigational queries. */
export function classifyQueryIntent(query: string, brands: string[] = []): IntentGuess | null {
  const q = norm(query);
  const brandHits = brands.map((b) => b.toLocaleLowerCase('tr')).filter((b) => b.length >= 3 && q.includes(` ${b} `));
  const t = hits(q, CUES.transactional);
  const c = hits(q, CUES.commercial);
  const i = hits(q, CUES.informational);
  const n = hits(q, NAV_CUES);
  // Order matters: an explicit purchase cue beats comparison words, which beat question words.
  if (t.length) return { intent: 'transactional', signals: t.map((w) => `"${w}"`), basis: 'inferred' };
  if (c.length) return { intent: 'commercial', signals: c.map((w) => `"${w}"`), basis: 'inferred' };
  if (i.length) return { intent: 'informational', signals: i.map((w) => `"${w}"`), basis: 'inferred' };
  if (brandHits.length || n.length) return { intent: 'navigational', signals: [...brandHits.map((b) => `brand "${b}"`), ...n.map((w) => `"${w}"`)], basis: 'inferred' };
  return null;
}

const PAGE_INTENT: Partial<Record<PageType, Intent>> = {
  'blog-post': 'informational', 'blog-index': 'informational', docs: 'informational', 'tag-archive': 'informational', author: 'informational',
  product: 'transactional', pricing: 'transactional',
  category: 'commercial', service: 'commercial', landing: 'commercial',
  home: 'navigational', about: 'navigational', contact: 'navigational', careers: 'navigational', legal: 'navigational', search: 'navigational',
};

/** The intent a page is built to serve, from its classified type; null for unclassified pages. */
export function pageIntent(p: Pick<InventoryPage, 'type' | 'basis'>): IntentGuess | null {
  const intent = PAGE_INTENT[p.type];
  return intent ? { intent, signals: [`page type ${p.type} (${p.basis})`], basis: 'inferred' } : null;
}

/**
 * Whether a page of one intent is a poor landing page for a query of another. Only clear conflicts count:
 * a "how to" query answered by a pricing/product page, or a purchase query landing on an article.
 */
export function intentConflict(query: Intent, page: Intent): boolean {
  if (query === 'informational') return page === 'transactional';
  if (query === 'transactional') return page === 'informational';
  return false;
}

/** Brand terms from a property or site URL: "sc-domain:shop.example.com" → ["example"]. */
export function brandTermsFrom(site: string): string[] {
  const host = site.replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').split('/')[0]!.replace(/^www\./, '');
  const labels = host.split('.');
  // Skip second-level public suffixes such as co.uk / com.tr.
  const i = labels.length >= 3 && /^(co|com|net|org|gov|ac|edu)$/.test(labels[labels.length - 2]!) ? labels.length - 3 : labels.length - 2;
  const main = labels[Math.max(0, i)]!;
  return main.length >= 3 ? [main] : [];
}
