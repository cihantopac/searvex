/**
 * Lightweight, dependency-free language identification for page-level checks.
 *
 * Long texts: frequency of very common function words per language (robust above ~30 words).
 * Short strings (headings, UI labels): letters that are distinctive for one language (e.g. Turkish
 * ğ, ş, ı, İ) plus function words. Results are heuristics and are reported as such.
 */
const FUNCTION_WORDS: Record<string, string[]> = {
  en: ['the', 'and', 'of', 'to', 'is', 'in', 'for', 'with', 'you', 'your', 'this', 'that', 'on', 'are', 'it', 'be', 'as', 'can', 'from', 'or', 'an', 'how', 'what', 'we', 'our'],
  tr: ['ve', 'bir', 'bu', 'için', 'ile', 'da', 'de', 'çok', 'daha', 'olarak', 'gibi', 'ama', 'ne', 'veya', 'sonra', 'her', 'kadar', 'değil', 'var', 'nasıl', 'olan', 'en', 'tek', 'yok', 'mı', 'mi'],
  de: ['der', 'die', 'und', 'das', 'ist', 'nicht', 'mit', 'für', 'auf', 'ein', 'eine', 'den', 'von', 'zu', 'sie', 'es', 'sich', 'auch', 'wie', 'oder'],
  fr: ['le', 'la', 'les', 'et', 'des', 'un', 'une', 'du', 'pour', 'dans', 'est', 'que', 'qui', 'pas', 'sur', 'au', 'avec', 'vous', 'ce', 'votre'],
  es: ['el', 'la', 'los', 'las', 'y', 'de', 'que', 'en', 'un', 'una', 'por', 'con', 'para', 'es', 'del', 'se', 'su', 'como', 'más', 'tu'],
  it: ['il', 'la', 'che', 'di', 'e', 'un', 'una', 'per', 'non', 'con', 'del', 'sono', 'gli', 'le', 'della', 'come', 'più', 'questo'],
  pt: ['o', 'a', 'os', 'as', 'e', 'de', 'que', 'um', 'uma', 'para', 'com', 'não', 'do', 'da', 'em', 'você', 'seu', 'mais', 'como'],
  nl: ['de', 'het', 'een', 'en', 'van', 'is', 'dat', 'niet', 'op', 'te', 'met', 'voor', 'zijn', 'je', 'u', 'ook', 'wordt'],
};

/** Letters that (within these languages) occur in only one of them. */
const DISTINCT_LETTERS: Array<[string, RegExp]> = [
  ['tr', /[ğĞşŞıİ]/],
  ['de', /ß/],
  ['es', /[ñÑ¿¡]/],
  ['pt', /[ãõÃÕ]/],
  ['fr', /[œŒ]/],
];

const SETS = Object.fromEntries(Object.entries(FUNCTION_WORDS).map(([k, v]) => [k, new Set(v)]));

export interface LanguageGuess {
  lang: string;
  /** Share of words that are function words of the winning language. */
  score: number;
  margin: number;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\u0307/g, '')
    .split(/[^\p{L}\p{M}]+/u)
    .filter(Boolean);
}

/** Detect the language of a longer text. Returns null when the text is too short or ambiguous. */
export function detectLanguage(text: string, minWords = 30): LanguageGuess | null {
  const w = words(text);
  if (w.length < minWords) return null;
  const counts: Record<string, number> = {};
  for (const x of w) for (const [lang, set] of Object.entries(SETS)) if (set.has(x)) counts[lang] = (counts[lang] ?? 0) + 1;
  for (const [lang, re] of DISTINCT_LETTERS) {
    const hits = w.filter((x) => re.test(x)).length;
    if (hits) counts[lang] = (counts[lang] ?? 0) + hits * 0.5;
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (!best || best[1] < 5) return null;
  const margin = best[1] / Math.max(1, second?.[1] ?? 0);
  if (margin < 1.6) return null;
  return { lang: best[0], score: best[1] / w.length, margin };
}

/**
 * Detect a short string's language only when there is distinctive evidence (a language-specific letter,
 * or two function words of one language). Returns null otherwise.
 */
export function detectShortLanguage(text: string): string | null {
  // Single letters (initialisms like "B.O.S.S.", list markers) are not evidence of a language.
  const w = words(text).filter((x) => x.length > 1);
  for (const [lang, re] of DISTINCT_LETTERS) if (re.test(text)) return lang;
  const counts: Record<string, number> = {};
  for (const x of w) for (const [lang, set] of Object.entries(SETS)) if (set.has(x)) counts[lang] = (counts[lang] ?? 0) + 1;
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (ranked[0] && ranked[0][1] >= 2 && (!ranked[1] || ranked[0][1] > ranked[1][1])) return ranked[0][0];
  return null;
}

export function primaryTag(lang: string | null | undefined): string | null {
  return lang ? lang.toLowerCase().split(/[-_]/)[0]! : null;
}
