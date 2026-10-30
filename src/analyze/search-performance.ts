import type { AuditReport } from './audit.js';
import type { GscRow } from '../integrations/gsc.js';
import type { DimRow } from '../integrations/gsc-csv.js';
import { urlInProperty, type SearchProperty } from '../integrations/property.js';
import { normalizeUrl } from '../core/url.js';
import { brandTermsFrom, classifyQueryIntent, intentConflict, type Intent } from './intent.js';

/**
 * Search performance analysis on verified Search Console / Bing data.
 * Everything is computed from the property's own data — no external CTR curves or volume estimates.
 *
 * Input granularity:
 * - `query-page` (API): rows per query × page; every section is available.
 * - `separate` (UI CSV export): query totals and page totals as unrelated tables; sections that need the
 *   query × page combination are reported as not measured instead of being approximated.
 */
export interface QueryPage {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SearchPerformanceInput {
  queryPage?: QueryPage[];
  /** Query-level totals (CSV "Queries" table). Ignored when `queryPage` is given. */
  queries?: DimRow[];
  /** Page-level totals (CSV "Pages" table). Ignored when `queryPage` is given. */
  pages?: DimRow[];
  /** Property-level daily totals (CSV "Dates" table); preferred for totals when present. */
  dates?: DimRow[];
  countries?: DimRow[];
  devices?: DimRow[];
}

/** How several pages share one query. Only `mixed-intent` and `possible-competition` need review. */
export type SharedQueryPattern = 'navigational' | 'hierarchy' | 'dominant' | 'mixed-intent' | 'possible-competition';

export interface SearchPerformanceReport {
  source: string;
  property?: string;
  period: { days: number; startDate?: string; endDate?: string };
  granularity: 'query-page' | 'separate';
  totals: { clicks: number; impressions: number; ctr: number; queries: number; pages: number; basis: string };
  /** The joined audit and how well it covers the property. */
  audit?: { runId: string; target: string; coverage: number; pages: number };
  topQueries: Array<{ query: string; clicks: number; impressions: number; ctr: number; position: number; pages: number | null; intent?: Intent }>;
  /** Clicks and impressions per inferred query intent (the numbers are verified; the intent labels are not). */
  intentMix: Array<{ intent: Intent | 'unclassified'; queries: number; clicks: number; impressions: number; ctr: number }>;
  /** Queries whose inferred intent conflicts with the type of the page that ranks (needs a joined audit). */
  intentMismatches: Array<{ query: string; queryIntent: Intent; signals: string[]; page: string; pageType: string; pageIntent: Intent; impressions: number; clicks: number; position: number }>;
  topPages: Array<{ page: string; clicks: number; impressions: number; ctr: number; position: number; queries: number | null; primaryQuery: string | null }>;
  /** Queries ranking just off the first page with real impressions (`page` is null for query-only data). */
  strikingDistance: Array<{ query: string; page: string | null; position: number; impressions: number; clicks: number }>;
  /** Queries whose CTR is far below the property's own median CTR at the same position. */
  lowCtr: Array<{ query: string; page: string | null; position: number; impressions: number; ctr: number; siteMedianCtr: number }>;
  /**
   * Queries for which several pages of the site receive impressions. This is common and usually harmless
   * (brand queries, sitelinks, parent/child pages); each entry carries a pattern and only `needsReview`
   * entries are candidates for consolidation — and even those need a check over time.
   */
  multiPageQueries: Array<{ query: string; impressions: number; pattern: SharedQueryPattern; needsReview: boolean; reason: string; pages: Array<{ page: string; impressions: number; clicks: number; position: number }> }>;
  /** Crawled indexable pages inside the property with no impressions in the period (only when an audit is joined). */
  noImpressions: string[];
  /** Audit findings on pages that actually receive search traffic, ranked by clicks. */
  findingsOnTrafficPages: Array<{ ruleId: string; title: string; severity: string; pages: number; clicks: number; impressions: number }>;
  breakdowns: { countries: DimRow[]; devices: DimRow[] };
  /** Sections that could not be computed from this input, with the reason. Never estimated. */
  notMeasured: string[];
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

interface Row {
  query: string;
  page: string | null;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

const LOW_SEARCH_VALUE = new Set(['legal', 'contact', 'careers', 'tag-archive', 'author', 'search']);

function pathOf(url: string): string | null {
  try {
    return new URL(url).pathname.replace(/\/+$/, '') || '/';
  } catch {
    return null;
  }
}

/** One page is the parent of another (`/docs` and `/docs/setup`) or the homepage. */
function hierarchical(pages: string[]): boolean {
  const paths = pages.map(pathOf).filter((p): p is string => !!p);
  for (const a of paths) for (const b of paths) if (a !== b && (a === '/' || b.startsWith(`${a}/`))) return true;
  return false;
}

export function analyzeSearchPerformance(
  input: QueryPage[] | SearchPerformanceInput,
  opts: { days: number; source: string; audit?: AuditReport; property?: SearchProperty; minImpressions?: number; brands?: string[]; period?: { startDate?: string; endDate?: string } },
): SearchPerformanceReport {
  const inp: SearchPerformanceInput = Array.isArray(input) ? { queryPage: input } : input;
  const minImp = opts.minImpressions ?? 50;
  const notes: string[] = [];
  const notMeasured: string[] = [];
  const joined = !!inp.queryPage;
  const qp = inp.queryPage ?? [];

  const sumOf = (xs: Array<{ clicks: number; impressions: number }>, k: 'clicks' | 'impressions') => xs.reduce((a, x) => a + x[k], 0);
  const wPos = (xs: Array<{ position: number; impressions: number }>) => {
    const imp = xs.reduce((a, x) => a + x.impressions, 0);
    return imp ? xs.reduce((a, x) => a + x.position * x.impressions, 0) / imp : 0;
  };
  const group = <T,>(xs: T[], key: (x: T) => string) => {
    const m = new Map<string, T[]>();
    for (const x of xs) (m.get(key(x)) ?? m.set(key(x), []).get(key(x))!).push(x);
    return m;
  };

  // Query- and page-level aggregates, from joined rows or from the separate tables.
  let queryAgg: Array<{ query: string; clicks: number; impressions: number; position: number; pages: number | null }>;
  let pageAgg: Array<{ page: string; clicks: number; impressions: number; position: number; queries: number | null; primaryQuery: string | null }>;
  let rows: Row[];
  if (joined) {
    queryAgg = [...group(qp, (d) => d.query)].map(([query, xs]) => ({ query, clicks: sumOf(xs, 'clicks'), impressions: sumOf(xs, 'impressions'), position: wPos(xs), pages: xs.length }));
    pageAgg = [...group(qp, (d) => d.page)].map(([page, xs]) => {
      const primary = [...xs].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)[0]!;
      return { page, clicks: sumOf(xs, 'clicks'), impressions: sumOf(xs, 'impressions'), position: wPos(xs), queries: xs.length, primaryQuery: primary.query };
    });
    rows = qp;
  } else {
    queryAgg = (inp.queries ?? []).map((q) => ({ query: q.key, clicks: q.clicks, impressions: q.impressions, position: q.position, pages: null }));
    pageAgg = (inp.pages ?? []).map((p) => ({ page: p.key, clicks: p.clicks, impressions: p.impressions, position: p.position, queries: null, primaryQuery: null }));
    rows = queryAgg.map((q) => ({ query: q.query, page: null, clicks: q.clicks, impressions: q.impressions, ctr: q.impressions ? q.clicks / q.impressions : 0, position: q.position }));
    notMeasured.push('Query → page mapping, queries shared by several pages and intent mismatches: the Search Console CSV export has no query × page combination (connect the API for these).');
    if (!inp.queries?.length) notMeasured.push('Query analysis (top queries, striking distance, low CTR, intent mix): no queries table in the import.');
    if (!inp.pages?.length) notMeasured.push('Page analysis (top pages, findings on traffic pages, pages without impressions): no pages table in the import.');
  }

  // Totals: daily property totals are the most complete (query tables omit anonymised queries).
  let totalClicks: number;
  let totalImpr: number;
  let basis: string;
  if (inp.dates?.length) {
    totalClicks = sumOf(inp.dates, 'clicks');
    totalImpr = sumOf(inp.dates, 'impressions');
    basis = 'daily property totals';
  } else if (joined) {
    totalClicks = sumOf(qp, 'clicks');
    totalImpr = sumOf(qp, 'impressions');
    basis = 'sum of query × page rows (anonymised queries excluded)';
  } else if (pageAgg.length) {
    totalClicks = sumOf(pageAgg, 'clicks');
    totalImpr = sumOf(pageAgg, 'impressions');
    basis = 'sum of the pages table';
  } else {
    totalClicks = sumOf(queryAgg, 'clicks');
    totalImpr = sumOf(queryAgg, 'impressions');
    basis = 'sum of the queries table (anonymised queries excluded)';
  }

  const topQueries: SearchPerformanceReport['topQueries'] = queryAgg
    .map((q) => ({ query: q.query, clicks: q.clicks, impressions: q.impressions, ctr: r4(q.clicks / Math.max(1, q.impressions)), position: r1(q.position), pages: q.pages }))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
  const topPages = pageAgg
    .map((p) => ({ page: p.page, clicks: p.clicks, impressions: p.impressions, ctr: r4(p.clicks / Math.max(1, p.impressions)), position: r1(p.position), queries: p.queries, primaryQuery: p.primaryQuery }))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);

  const hasPositions = rows.some((d) => d.position > 0);
  const strikingDistance = rows
    .filter((d) => d.position >= 8 && d.position <= 20 && d.impressions >= minImp)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 100)
    .map((d) => ({ query: d.query, page: d.page, position: r1(d.position), impressions: d.impressions, clicks: d.clicks }));

  // Property's own CTR by rounded position (rows with enough impressions only).
  const ctrByPos = new Map<number, number[]>();
  for (const d of rows) if (d.impressions >= minImp && d.position > 0 && d.position <= 10) (ctrByPos.get(Math.round(d.position)) ?? ctrByPos.set(Math.round(d.position), []).get(Math.round(d.position))!).push(d.ctr);
  const lowCtr = rows
    .filter((d) => d.impressions >= minImp && d.position > 0 && d.position <= 10)
    .map((d) => ({ d, med: median(ctrByPos.get(Math.round(d.position)) ?? []), n: (ctrByPos.get(Math.round(d.position)) ?? []).length }))
    .filter((x) => x.n >= 5 && x.med > 0 && x.d.ctr < x.med * 0.5)
    .sort((a, b) => b.d.impressions - a.d.impressions)
    .slice(0, 100)
    .map((x) => ({ query: x.d.query, page: x.d.page, position: r1(x.d.position), impressions: x.d.impressions, ctr: r4(x.d.ctr), siteMedianCtr: r4(x.med) }));
  if (rows.length && !hasPositions) notMeasured.push('Striking distance and low CTR: the data has no positions.');
  else if (rows.length && ![...ctrByPos.values()].some((v) => v.length >= 5)) notes.push('Not enough rows per position to compare CTR against the property\'s own median.');

  const propertyLabel = opts.property?.raw ?? opts.source.split(' ').at(-1) ?? '';
  const brands = opts.brands ?? brandTermsFrom(propertyLabel);
  const qIntent = new Map(queryAgg.map((q) => [q.query, classifyQueryIntent(q.query, brands)]));
  for (const q of topQueries) q.intent = qIntent.get(q.query)?.intent;
  const mix = new Map<Intent | 'unclassified', { queries: number; clicks: number; impressions: number }>();
  for (const q of topQueries) {
    const k = q.intent ?? 'unclassified';
    const m = mix.get(k) ?? { queries: 0, clicks: 0, impressions: 0 };
    m.queries++;
    m.clicks += q.clicks;
    m.impressions += q.impressions;
    mix.set(k, m);
  }
  const intentMix = [...mix].map(([intent, m]) => ({ intent, ...m, ctr: r4(m.clicks / Math.max(1, m.impressions)) })).sort((a, b) => b.impressions - a.impressions);

  const invByUrl = new Map((opts.audit?.inventory.pages ?? []).map((p) => [normalizeUrl(p.url) ?? p.url, p]));
  const multiPageQueries: SearchPerformanceReport['multiPageQueries'] = [];
  if (joined) {
    for (const [query, xs] of group(qp, (d) => d.query)) {
      const impressions = sumOf(xs, 'impressions');
      if (impressions < minImp) continue;
      const sharing = xs.filter((x) => x.impressions >= impressions * 0.1).sort((a, b) => b.impressions - a.impressions);
      if (sharing.length < 2) continue;
      const pages = sharing.map((x) => ({ page: x.page, impressions: x.impressions, clicks: x.clicks, position: r1(x.position) }));
      const lead = sharing[0]!;
      const intents = new Set(sharing.map((x) => invByUrl.get(normalizeUrl(x.page) ?? x.page)?.intent).filter(Boolean));
      let pattern: SharedQueryPattern;
      let reason: string;
      if (qIntent.get(query)?.intent === 'navigational') {
        pattern = 'navigational';
        reason = 'Brand or navigational query: several pages of the same site (often sitelinks) are expected.';
      } else if (hierarchical(sharing.map((x) => x.page))) {
        pattern = 'hierarchy';
        reason = 'The pages are parent and child (or the homepage); showing both is usually expected.';
      } else if (lead.position <= 3 && lead.impressions >= impressions * 0.6) {
        pattern = 'dominant';
        reason = `One page clearly leads (position ${r1(lead.position)}, ${Math.round((lead.impressions / impressions) * 100)}% of impressions); the others are secondary listings.`;
      } else if (intents.size >= 2) {
        pattern = 'mixed-intent';
        reason = `Pages built for different intents (${[...intents].join(', ')}) share the query; decide which one should serve it.`;
      } else {
        pattern = 'possible-competition';
        reason = 'Comparable pages split impressions without a clear leader. Possible cannibalisation: confirm over time (alternating rankings) before merging or retargeting.';
      }
      multiPageQueries.push({ query, impressions, pattern, needsReview: pattern === 'mixed-intent' || pattern === 'possible-competition', reason, pages });
    }
    multiPageQueries.sort((a, b) => Number(b.needsReview) - Number(a.needsReview) || b.impressions - a.impressions);
    notes.push('Several pages receiving impressions for one query is common; only entries marked for review are cannibalisation candidates, and one aggregated period cannot prove harm.');
  }

  let noImpressions: string[] = [];
  const intentMismatches: SearchPerformanceReport['intentMismatches'] = [];
  const findingsOnTrafficPages: SearchPerformanceReport['findingsOnTrafficPages'] = [];
  if (opts.audit && pageAgg.length) {
    const inScope = (url: string) => !opts.property || urlInProperty(url, opts.property);
    const seen = new Set(pageAgg.map((p) => normalizeUrl(p.page) ?? p.page));
    const truncatedPages = !joined && pageAgg.length >= 1000;
    if (truncatedPages) notMeasured.push('Pages without impressions: the pages table is truncated at the export limit, so missing pages may still have impressions.');
    else
      noImpressions = opts.audit.inventory.pages
        .filter((p) => p.indexable && inScope(p.url) && !seen.has(normalizeUrl(p.url) ?? p.url))
        // Pages meant to rank first; legal, contact and archive pages rarely need search impressions.
        .sort((a, b) => Number(LOW_SEARCH_VALUE.has(a.type)) - Number(LOW_SEARCH_VALUE.has(b.type)))
        .map((p) => p.url);
    const pageStats = new Map(topPages.map((p) => [normalizeUrl(p.page) ?? p.page, p]));
    for (const f of opts.audit.findings) {
      if (f.severity === 'info') continue;
      const hit = f.evidence.map((e) => (e.url ? pageStats.get(normalizeUrl(e.url) ?? e.url) : undefined)).filter((x): x is NonNullable<typeof x> => !!x);
      if (!hit.length) continue;
      findingsOnTrafficPages.push({ ruleId: f.ruleId, title: f.title, severity: f.severity, pages: hit.length, clicks: hit.reduce((a, p) => a + p.clicks, 0), impressions: hit.reduce((a, p) => a + p.impressions, 0) });
    }
    findingsOnTrafficPages.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
    notes.push('Findings-on-traffic uses the evidence URLs recorded in the audit (up to 50 per rule).');
  } else if (!opts.audit) notMeasured.push('Findings on traffic pages and pages without impressions: no audit joined (use --audit latest).');

  if (opts.audit && joined) {
    for (const d of qp) {
      const qi = qIntent.get(d.query);
      const page = invByUrl.get(normalizeUrl(d.page) ?? d.page);
      if (!qi || !page?.intent || d.impressions < minImp || !intentConflict(qi.intent, page.intent)) continue;
      intentMismatches.push({ query: d.query, queryIntent: qi.intent, signals: qi.signals, page: d.page, pageType: page.type, pageIntent: page.intent, impressions: d.impressions, clicks: d.clicks, position: r1(d.position) });
    }
    intentMismatches.sort((a, b) => b.impressions - a.impressions);
  }
  if (opts.audit && opts.property?.kind === 'domain') notes.push('Domain property: the data covers every subdomain, the audit only the crawled site; pages on other subdomains are not joined.');
  notes.push('Query and page intents are inferred from wording and page type (heuristic); clicks, impressions and positions are verified data.');
  notes.push('Search Console anonymises rare queries; query-level totals are lower than property totals.');

  return {
    source: opts.source,
    property: opts.property?.raw,
    period: { days: opts.days, ...(opts.period ?? {}) },
    granularity: joined ? 'query-page' : 'separate',
    totals: { clicks: totalClicks, impressions: totalImpr, ctr: r4(totalClicks / Math.max(1, totalImpr)), queries: queryAgg.length, pages: pageAgg.length, basis },
    topQueries: topQueries.slice(0, 100),
    topPages: topPages.slice(0, 100),
    strikingDistance,
    lowCtr,
    multiPageQueries: multiPageQueries.slice(0, 100),
    intentMix,
    intentMismatches: intentMismatches.slice(0, 100),
    noImpressions: noImpressions.slice(0, 500),
    findingsOnTrafficPages: findingsOnTrafficPages.slice(0, 50),
    breakdowns: { countries: (inp.countries ?? []).slice(0, 25), devices: inp.devices ?? [] },
    notMeasured,
    notes,
  };
}
