import type { AuditReport } from './audit.js';
import type { GscRow } from '../integrations/gsc.js';
import { normalizeUrl } from '../core/url.js';

/**
 * Search performance analysis on verified Search Console rows (dimensions: query, page).
 * Everything is computed from the property's own data — no external CTR curves or volume estimates.
 */
export interface QueryPage {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SearchPerformanceReport {
  source: string;
  period: { days: number };
  totals: { clicks: number; impressions: number; ctr: number; queries: number; pages: number };
  topQueries: Array<{ query: string; clicks: number; impressions: number; ctr: number; position: number; pages: number }>;
  topPages: Array<{ page: string; clicks: number; impressions: number; ctr: number; position: number; queries: number; primaryQuery: string }>;
  /** Queries ranking just off the first page with real impressions. */
  strikingDistance: Array<{ query: string; page: string; position: number; impressions: number; clicks: number }>;
  /** Queries whose CTR is far below the property's own median CTR at the same position. */
  lowCtr: Array<{ query: string; page: string; position: number; impressions: number; ctr: number; siteMedianCtr: number }>;
  /** Queries where several pages of the site share impressions (data-verified cannibalisation). */
  multiPageQueries: Array<{ query: string; impressions: number; pages: Array<{ page: string; impressions: number; clicks: number; position: number }> }>;
  /** Crawled indexable pages with no impressions in the period (only when an audit is joined). */
  noImpressions: string[];
  /** Audit findings on pages that actually receive search traffic, ranked by clicks. */
  findingsOnTrafficPages: Array<{ ruleId: string; title: string; severity: string; pages: number; clicks: number; impressions: number }>;
  notes: string[];
}

export function rowsToQueryPage(rows: GscRow[]): QueryPage[] {
  return rows.filter((r) => r.keys.length >= 2).map((r) => ({ query: r.keys[0]!, page: r.keys[1]!, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }));
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const r4 = (x: number) => Math.round(x * 10000) / 10000;
const r1 = (x: number) => Math.round(x * 10) / 10;

export function analyzeSearchPerformance(data: QueryPage[], opts: { days: number; source: string; audit?: AuditReport; minImpressions?: number }): SearchPerformanceReport {
  const minImp = opts.minImpressions ?? 50;
  const notes: string[] = [];
  const byQuery = new Map<string, QueryPage[]>();
  const byPage = new Map<string, QueryPage[]>();
  for (const d of data) {
    (byQuery.get(d.query) ?? byQuery.set(d.query, []).get(d.query)!).push(d);
    (byPage.get(d.page) ?? byPage.set(d.page, []).get(d.page)!).push(d);
  }
  const sum = (xs: QueryPage[], k: 'clicks' | 'impressions') => xs.reduce((a, x) => a + x[k], 0);
  const wPos = (xs: QueryPage[]) => {
    const imp = sum(xs, 'impressions');
    return imp ? xs.reduce((a, x) => a + x.position * x.impressions, 0) / imp : 0;
  };
  const clicks = sum(data, 'clicks');
  const impressions = sum(data, 'impressions');

  const topQueries = [...byQuery.entries()]
    .map(([query, xs]) => ({ query, clicks: sum(xs, 'clicks'), impressions: sum(xs, 'impressions'), ctr: r4(sum(xs, 'clicks') / Math.max(1, sum(xs, 'impressions'))), position: r1(wPos(xs)), pages: xs.length }))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
  const topPages = [...byPage.entries()]
    .map(([page, xs]) => {
      const primary = [...xs].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)[0]!;
      return { page, clicks: sum(xs, 'clicks'), impressions: sum(xs, 'impressions'), ctr: r4(sum(xs, 'clicks') / Math.max(1, sum(xs, 'impressions'))), position: r1(wPos(xs)), queries: xs.length, primaryQuery: primary.query };
    })
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);

  const strikingDistance = data
    .filter((d) => d.position >= 8 && d.position <= 20 && d.impressions >= minImp)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 100)
    .map((d) => ({ query: d.query, page: d.page, position: r1(d.position), impressions: d.impressions, clicks: d.clicks }));

  // Property's own CTR by rounded position (rows with enough impressions only).
  const ctrByPos = new Map<number, number[]>();
  for (const d of data) if (d.impressions >= minImp && d.position <= 10) (ctrByPos.get(Math.round(d.position)) ?? ctrByPos.set(Math.round(d.position), []).get(Math.round(d.position))!).push(d.ctr);
  const lowCtr = data
    .filter((d) => d.impressions >= minImp && d.position <= 10)
    .map((d) => ({ d, med: median(ctrByPos.get(Math.round(d.position)) ?? []), n: (ctrByPos.get(Math.round(d.position)) ?? []).length }))
    .filter((x) => x.n >= 5 && x.med > 0 && x.d.ctr < x.med * 0.5)
    .sort((a, b) => b.d.impressions - a.d.impressions)
    .slice(0, 100)
    .map((x) => ({ query: x.d.query, page: x.d.page, position: r1(x.d.position), impressions: x.d.impressions, ctr: r4(x.d.ctr), siteMedianCtr: r4(x.med) }));
  if (![...ctrByPos.values()].some((v) => v.length >= 5)) notes.push('Not enough rows per position to compare CTR against the property\'s own median.');

  const multiPageQueries = [...byQuery.entries()]
    .map(([query, xs]) => ({ query, impressions: sum(xs, 'impressions'), xs }))
    .filter((q) => q.impressions >= minImp)
    .map((q) => ({ ...q, sharing: q.xs.filter((x) => x.impressions >= q.impressions * 0.1) }))
    .filter((q) => q.sharing.length >= 2)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 100)
    .map((q) => ({ query: q.query, impressions: q.impressions, pages: q.sharing.sort((a, b) => b.impressions - a.impressions).map((x) => ({ page: x.page, impressions: x.impressions, clicks: x.clicks, position: r1(x.position) })) }));

  let noImpressions: string[] = [];
  const findingsOnTrafficPages: SearchPerformanceReport['findingsOnTrafficPages'] = [];
  if (opts.audit) {
    const seen = new Set([...byPage.keys()].map((u) => normalizeUrl(u) ?? u));
    noImpressions = opts.audit.inventory.pages.filter((p) => p.indexable && !seen.has(normalizeUrl(p.url) ?? p.url)).map((p) => p.url);
    const pageStats = new Map(topPages.map((p) => [normalizeUrl(p.page) ?? p.page, p]));
    for (const f of opts.audit.findings) {
      if (f.severity === 'info') continue;
      const hit = f.evidence.map((e) => (e.url ? pageStats.get(normalizeUrl(e.url) ?? e.url) : undefined)).filter((x): x is NonNullable<typeof x> => !!x);
      if (!hit.length) continue;
      findingsOnTrafficPages.push({ ruleId: f.ruleId, title: f.title, severity: f.severity, pages: hit.length, clicks: hit.reduce((a, p) => a + p.clicks, 0), impressions: hit.reduce((a, p) => a + p.impressions, 0) });
    }
    findingsOnTrafficPages.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
    notes.push('Findings-on-traffic uses the evidence URLs recorded in the audit (up to 50 per rule).');
  }
  notes.push('Search Console anonymises rare queries; query-level totals are lower than property totals.');

  return {
    source: opts.source,
    period: { days: opts.days },
    totals: { clicks, impressions, ctr: r4(clicks / Math.max(1, impressions)), queries: byQuery.size, pages: byPage.size },
    topQueries: topQueries.slice(0, 100),
    topPages: topPages.slice(0, 100),
    strikingDistance,
    lowCtr,
    multiPageQueries,
    noImpressions: noImpressions.slice(0, 500),
    findingsOnTrafficPages: findingsOnTrafficPages.slice(0, 50),
    notes,
  };
}
