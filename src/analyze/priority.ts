import type { Finding, Priority, Severity } from '../core/types.js';
import { normalizeUrl } from '../core/url.js';
import type { SiteInventory } from './inventory.js';
import { factsOf, type SiteContext } from './context.js';

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

/** Affected pages grouped by layout skeleton; groups of one page are not templates. */
export function structuresOf(urls: string[], ctx: SiteContext): Array<{ id: string; pages: number; example: string }> {
  const groups = new Map<string, string[]>();
  for (const u of urls) {
    const p = ctx.byUrl?.get(u);
    const sk = p ? factsOf(p)?.skeleton : undefined;
    if (sk) groups.set(sk, [...(groups.get(sk) ?? []), u]);
  }
  return [...groups.entries()]
    .filter(([, us]) => us.length >= 2)
    .map(([id, us]) => ({ id, pages: us.length, example: us[0]! }))
    .sort((a, b) => b.pages - a.pages || a.id.localeCompare(b.id));
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
    // Page-structure templates: one layout behind unrelated URLs (flat slugs) is still one fix.
    const structures = ctx && urls.length >= 5 ? structuresOf(urls, ctx) : [];
    if (structures.length) f.structures = structures.slice(0, 8);
    const structured = structures.reduce((a, s) => a + s.pages, 0);
    const sameStructure = templates.length > 2 && structures.length > 0 && structures.length <= 2 && structured >= urls.length * 0.8;
    // Markup/technical issues on most pages, or in few templates, are usually one shared-layout fix.
    // Content issues are fixed page by page, so template concentration does not lower their effort.
    const content = f.category === 'content';
    const indexableCount = ctx?.indexable.length ?? totalUnits ?? 0;
    const layoutWide = !content && indexableCount >= 5 && pageUrls.length >= indexableCount * 0.5;
    const concentrated = !content && urls.length >= 5 && (templates.length <= 2 || sameStructure);
    const effort: Priority['effort'] = f.autofixable || layoutWide || concentrated ? 'low' : urls.length > 20 ? 'high' : 'medium';
    if (f.autofixable) reasons.push('auto-fixable in repository mode');
    else if (layoutWide) reasons.push('on most pages — likely one shared layout/template fix');
    else if (concentrated && sameStructure) reasons.push(`one page structure behind ${templates.length} URL patterns (${structures.length} layout${structures.length > 1 ? 's' : ''}) — fix once`);
    else if (concentrated) reasons.push(`concentrated in ${templates.length} template${templates.length > 1 ? 's' : ''} — fix once`);
    f.priority = { ...scoreOf(f, reach, effort), reach: Math.round(reach * 1000) / 1000, effort, reasons };
  }
  linkRootCauses(findings);
}

/** Priority score and bucket for a reach (0–1) and effort: see the formula at the top of this file. */
function scoreOf(f: Pick<Finding, 'severity' | 'confidence'>, reach: number, effort: Priority['effort']): Pick<Priority, 'score' | 'bucket'> {
  const confidence = f.confidence === 'verified' ? 1 : f.confidence === 'heuristic' ? 0.6 : 0;
  const effortFactor = effort === 'low' ? 1 : effort === 'medium' ? 1.25 : 1.6;
  const score = Math.round(Math.min(1, (SEVERITY[f.severity] * confidence * (0.35 + 0.65 * reach)) / effortFactor) * 100);
  return { score, bucket: score >= 45 ? 'P1' : score >= 15 ? 'P2' : 'P3' };
}

export interface PageTraffic {
  page: string;
  clicks: number;
  impressions: number;
}

/** What `applyTrafficPriorities` recorded on the report (`report.traffic`). */
export interface TrafficInput {
  /** Where the numbers come from, e.g. "Search Console sc-domain:example.com, 28 days". */
  source: string;
  /** `clicks`, or `impressions` when the joined pages have fewer than 10 clicks in all. */
  metric: 'clicks' | 'impressions';
  /** Crawled indexable pages with search data. */
  pages: number;
  clicks: number;
  impressions: number;
}

/**
 * Traffic-weighted priorities (backlog #7, #11). When a property-matched Search Console or Bing join exists, a
 * page's importance becomes half structural (internal inlinks, homepage, as in `pageImportance`) and half its
 * share of the site's clicks (impressions when clicks are too few). Reach and score of every non-site-wide
 * finding are recomputed over its complete affected URLs; the reasons state the verified numbers. Idempotent:
 * applying newer data replaces the earlier traffic input.
 */
export function applyTrafficPriorities(report: { findings: Array<Finding & { count: number }>; inventory: Pick<SiteInventory, 'pages'>; traffic?: TrafficInput }, rows: PageTraffic[], source: string): TrafficInput | null {
  const key = (u: string) => normalizeUrl(u) ?? u;
  const byUrl = new Map<string, PageTraffic>();
  for (const r of rows) {
    const k = key(r.page);
    const e = byUrl.get(k);
    byUrl.set(k, e ? { page: r.page, clicks: e.clicks + r.clicks, impressions: e.impressions + r.impressions } : r);
  }
  const pages = report.inventory.pages.filter((p) => p.indexable);
  const joined = pages.map((p) => ({ url: p.url, t: byUrl.get(key(p.url)) })).filter((x) => x.t);
  const clicks = joined.reduce((a, x) => a + x.t!.clicks, 0);
  const impressions = joined.reduce((a, x) => a + x.t!.impressions, 0);
  const metric: TrafficInput['metric'] = clicks >= 10 ? 'clicks' : 'impressions';
  const total = metric === 'clicks' ? clicks : impressions;
  if (!pages.length || total <= 0) return null;
  // Structural importance from what the report keeps (no SiteContext): inlinks and the homepage.
  const structural = new Map(pages.map((p) => [p.url, 1 + Math.log2(1 + p.inlinks) + (p.type === 'home' ? 3 : 0)]));
  const sTotal = [...structural.values()].reduce((a, b) => a + b, 0);
  const importance = new Map(pages.map((p) => {
    const t = byUrl.get(key(p.url));
    return [p.url, 0.5 * (structural.get(p.url)! / sTotal) + 0.5 * ((t ? t[metric] : 0) / total)];
  }));
  for (const f of report.findings) {
    const pr = f.priority;
    if (!pr || pr.reasons[0]?.includes('site-wide') || pr.reasons.includes('site-wide')) continue;
    const urls = f.affected?.urls ?? f.evidence.map((e) => e.url).filter((u): u is string => !!u);
    const hit = urls.filter((u) => importance.has(u));
    if (!hit.length) continue;
    const reach = Math.min(1, hit.reduce((a, u) => a + importance.get(u)!, 0));
    const t = hit.map((u) => byUrl.get(key(u))).filter((x): x is PageTraffic => !!x);
    const reasons = pr.reasons.filter((r) => !/(importance|traffic)-weighted reach/.test(r) && !r.includes('verified search data') && !r.startsWith('likely '));
    reasons.unshift(`${Math.round(reach * 100)}% traffic-weighted reach (${f.count} affected)`);
    reasons.splice(1, 0, `${t.reduce((a, x) => a + x.clicks, 0)} clicks · ${t.reduce((a, x) => a + x.impressions, 0)} impressions on affected pages (${source}; verified search data)`);
    f.priority = { ...pr, ...scoreOf(f, reach, pr.effort), reach: Math.round(reach * 1000) / 1000, reasons };
  }
  for (const f of report.findings) if (f.priority) f.priority.reasons = f.priority.reasons.filter((r) => !r.startsWith('likely '));
  linkRootCauses(report.findings);
  const input: TrafficInput = { source, metric, pages: joined.length, clicks, impressions };
  report.traffic = input;
  return input;
}

/**
 * Findings that are usually consequences of one root cause, so the report can say "fix X first". Only
 * applied when the root cause was actually observed, and stated as "likely": the check cannot prove it.
 */
const CONSEQUENCES: Array<{ cause: string; when: RegExp; effects: string[]; why: string }> = [
  {
    cause: 'lang.locale-adaptive',
    when: /client-side switch during rendering/,
    effects: ['index.render-mismatch', 'index.soft-404', 'hreflang.target-error', 'index.sitemap-non-canonical', 'crawl.sitemap-orphan', 'duplicate.content', 'duplicate.title', 'lang.mixed-navigation', 'canonical.target-error'],
    why: 'the page switches language in the browser (en-US), which changes its title, canonical and links for renderers such as Googlebot',
  },
];

function linkRootCauses(findings: Array<Finding & { count: number }>): void {
  // Recomputed from scratch on every call (traffic weighting calls it again).
  for (const f of findings) {
    delete f.priority?.causedBy;
    delete f.priority?.effects;
  }
  for (const c of CONSEQUENCES) {
    const cause = findings.find((f) => f.ruleId === c.cause && f.evidence.some((e) => c.when.test(e.observed ?? '')));
    if (!cause) continue;
    const effects = findings.filter((f) => c.effects.includes(f.ruleId) && f.priority);
    if (!effects.length || !cause.priority) continue;
    for (const f of effects) {
      f.priority!.reasons.push(`likely a consequence of ${c.cause} — ${c.why}; fix that first, then re-run`);
      f.priority!.causedBy = { ruleId: c.cause, why: c.why };
    }
    cause.priority.effects = effects.map((f) => f.ruleId);
    // Rank the cause above its consequences: fixing it usually resolves them.
    const top = Math.max(...effects.map((f) => f.priority!.score));
    if (cause.priority.score <= top) {
      cause.priority.score = Math.min(100, top + 1);
      cause.priority.bucket = cause.priority.score >= 45 ? 'P1' : cause.priority.score >= 15 ? 'P2' : 'P3';
    }
    cause.priority.reasons.push(`likely root cause of ${effects.length} other finding(s): ${effects.map((f) => f.ruleId).join(', ')}`);
  }
}
