import type { Finding, Priority, Severity } from '../core/types.js';
import type { SiteContext } from './context.js';

/**
 * Impact-based prioritisation.
 *
 * score = severity weight × confidence factor × (0.35 + 0.65 × reach) ÷ effort factor, scaled to 0–100.
 * reach = importance-weighted share of indexable pages affected; page importance grows with internal
 * inlinks (log), sitemap inclusion and homepage status. Site-wide findings (robots.txt, host setup) have
 * reach 1. Effort is low for auto-fixable rules or issues concentrated in few templates.
 * Search performance data (clicks/impressions) can be added as an importance input when available.
 */
const SEVERITY: Record<Severity, number> = { critical: 1, high: 0.7, medium: 0.4, low: 0.15, info: 0 };

/** URL-pattern template: locale + first segment kept, deeper segments generalised by depth. */
export function urlPattern(urlOrPath: string): string {
  let path: string;
  try {
    path = new URL(urlOrPath).pathname;
  } catch {
    path = urlOrPath.startsWith('/') ? urlOrPath : '/' + urlOrPath;
  }
  const segs = path.split('/').filter(Boolean);
  if (!segs.length) return '/';
  const out: string[] = [];
  if (/^[a-z]{2}(-[a-z]{2})?$/i.test(segs[0]!)) out.push(segs.shift()!);
  if (segs.length) out.push(segs.shift()!);
  for (let i = 0; i < segs.length; i++) out.push('*');
  return '/' + out.join('/');
}

export function templatesOf(urls: string[]): Array<{ pattern: string; pages: number }> {
  const m = new Map<string, number>();
  for (const u of urls) m.set(urlPattern(u), (m.get(urlPattern(u)) ?? 0) + 1);
  return [...m.entries()].map(([pattern, pages]) => ({ pattern, pages })).sort((a, b) => b.pages - a.pages);
}

export function pageImportance(ctx: SiteContext): Map<string, number> {
  const imp = new Map<string, number>();
  for (const p of ctx.indexable) {
    let w = 1 + Math.log2(1 + (ctx.inlinks.get(p.url)?.size ?? 0));
    if (ctx.sitemapUrls.has(p.url)) w += 0.5;
    if (p === ctx.homepage) w += 3;
    imp.set(p.url, w);
  }
  return imp;
}

export function prioritise(findings: Array<Finding & { count: number }>, affected: (ruleId: string) => string[], ctx?: SiteContext, totalUnits?: number): void {
  const imp = ctx ? pageImportance(ctx) : new Map<string, number>();
  const totalImp = [...imp.values()].reduce((a, b) => a + b, 0);
  for (const f of findings) {
    const urls = affected(f.ruleId);
    const pageUrls = urls.filter((u) => imp.has(u));
    let reach: number;
    const reasons: string[] = [];
    if (!urls.length || urls.some((u) => /\/robots\.txt$/.test(u))) {
      reach = 1;
      reasons.push('site-wide');
    } else if (ctx && totalImp > 0 && pageUrls.length) {
      reach = Math.min(1, pageUrls.reduce((a, u) => a + imp.get(u)!, 0) / totalImp);
      if (pageUrls.includes(ctx.homepage?.url ?? '')) reasons.push('includes the homepage');
    } else {
      reach = Math.min(1, urls.length / Math.max(1, totalUnits ?? ctx?.indexable.length ?? urls.length));
    }
    reasons.unshift(`${Math.round(reach * 100)}% importance-weighted reach (${f.count} affected)`);
    const templates = templatesOf(urls).slice(0, 8);
    if (urls.length >= 5) f.templates = templates;
    // Markup/technical issues on most pages, or in few templates, are usually one shared-layout fix.
    // Content issues are fixed page by page, so template concentration does not lower their effort.
    const content = f.category === 'content';
    const indexableCount = ctx?.indexable.length ?? totalUnits ?? 0;
    const layoutWide = !content && indexableCount >= 5 && pageUrls.length >= indexableCount * 0.5;
    const concentrated = !content && urls.length >= 5 && templates.length <= 2;
    const effort: Priority['effort'] = f.autofixable || layoutWide || concentrated ? 'low' : urls.length > 20 ? 'high' : 'medium';
    if (f.autofixable) reasons.push('auto-fixable in repository mode');
    else if (layoutWide) reasons.push('on most pages — likely one shared layout/template fix');
    else if (concentrated) reasons.push(`concentrated in ${templates.length} template${templates.length > 1 ? 's' : ''} — fix once`);
    const confidence = f.confidence === 'verified' ? 1 : f.confidence === 'heuristic' ? 0.6 : 0;
    const effortFactor = effort === 'low' ? 1 : effort === 'medium' ? 1.25 : 1.6;
    const score = Math.round(Math.min(1, (SEVERITY[f.severity] * confidence * (0.35 + 0.65 * reach)) / effortFactor) * 100);
    const bucket: Priority['bucket'] = score >= 45 ? 'P1' : score >= 15 ? 'P2' : 'P3';
    f.priority = { score, bucket, reach: Math.round(reach * 1000) / 1000, effort, reasons };
  }
}
