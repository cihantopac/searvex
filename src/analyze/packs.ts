import type { FindingSink, KnowledgeBase } from '../rules/engine.js';
import { compilePackPattern, type PackCheck } from '../rules/packs.js';
import type { PageRecord } from '../crawl/crawler.js';
import type { PageData } from '../extract/html.js';
import { factsOf, type SiteContext } from './context.js';

/** Value of a pack check field on one page: a string, a list (JSON-LD types), or null when absent. */
export function packFieldValue(p: PageRecord, f: PageData, field: string): string | string[] | null {
  const s = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
  if (field === 'title') return s(f.title);
  if (field === 'description') return s(f.metaDescription);
  if (field === 'h1') return s(f.headings.find((h) => h.level === 1 && !h.chrome)?.text);
  if (field === 'lang') return s(f.lang);
  if (field === 'canonical') return s(f.canonical);
  if (field === 'jsonld-types') {
    const types = f.jsonLd.flatMap((b) => b.types);
    return types.length ? types : null;
  }
  if (field.startsWith('og:')) return s(f.openGraph[field] ?? f.openGraph[field.slice(3)]);
  if (field.startsWith('twitter:')) return s(f.twitter[field] ?? f.twitter[field.slice(8)]);
  if (field.startsWith('header:')) return s(p.headers[field.slice(7).toLowerCase()]);
  return null;
}

/** Whether a page fails the check, with the observation to report; null when it passes or does not apply. */
export function evaluatePackCheck(c: PackCheck, value: string | string[] | null): string | null {
  const show = (v: string | string[]) => (Array.isArray(v) ? v.join(', ') : v).slice(0, 120);
  const list = value === null ? [] : Array.isArray(value) ? value : [value];
  // Patterns from third parties run on bounded input.
  const any = (re: RegExp) => list.some((v) => re.test(v.slice(0, 2000)));
  switch (c.test) {
    case 'missing':
      return value === null ? `${c.field} missing` : null;
    case 'present':
      return value !== null ? `${c.field}: "${show(value)}"` : null;
    case 'matches':
      return value !== null && any(compilePackPattern(String(c.value))) ? `${c.field}: "${show(value)}" matches /${String(c.value)}/` : null;
    case 'not-matches':
      // Missing counts as not matching: "no Product type" includes pages without any JSON-LD.
      if (any(compilePackPattern(String(c.value)))) return null;
      return value === null ? `${c.field} missing (expected /${String(c.value)}/)` : `${c.field}: "${show(value)}" does not match /${String(c.value)}/`;
    case 'longer-than':
      return typeof value === 'string' && value.length > Number(c.value) ? `${c.field} is ${value.length} characters (limit ${Number(c.value)})` : null;
    case 'shorter-than':
      return typeof value === 'string' && value.length < Number(c.value) ? `${c.field} is ${value.length} characters (minimum ${Number(c.value)})` : null;
  }
  return null;
}

/** Run the declarative checks of every active pack rule on the indexable HTML pages. */
export function runPackChecks(ctx: SiteContext, kb: KnowledgeBase, sink: FindingSink): void {
  for (const rule of kb.rules.values()) {
    if (!rule.pack || !rule.check || rule.status !== 'active') continue;
    const c = rule.check;
    const scope = c.urlPattern ? compilePackPattern(c.urlPattern) : null;
    for (const p of ctx.indexable) {
      const f = factsOf(p);
      if (!f) continue;
      if (scope) {
        let pathname = p.url;
        try {
          pathname = new URL(p.url).pathname;
        } catch {
          // keep the URL
        }
        if (!scope.test(pathname)) continue;
      }
      const observed = evaluatePackCheck(c, packFieldValue(p, f, c.field));
      if (observed) sink.emit(rule.id, { url: p.url, observed });
    }
  }
}
