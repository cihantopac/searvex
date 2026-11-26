import { factsOf, type SiteContext } from './context.js';
import type { GeoReport } from './geo.js';
import { pageSchemaTypes, type SiteInventory } from './inventory.js';

/**
 * Search readiness: what search and answer engines can use, separate from the defect-based health score.
 * A score of 100 means "no defects found", not "ready for search"; these three signals cover the gap. They never
 * change the score, the findings or --fail-on, and a signal Searvex could not measure is `not-measured`, never 0.
 */

/** Structured data is low below this share of content pages. */
export const STRUCTURED_DATA_MIN_PERCENT = 50;
/** Content pages (indexable, not legal) are low below this count. */
export const CONTENT_PAGES_MIN = 10;

/** The crawlers the existing access rules check: geo.search-bot-blocked and geo.ai-search-bot-blocked. */
const SEARCH_BOTS = ['Googlebot', 'Bingbot'];
const AI_SEARCH_BOTS = ['OAI-SearchBot', 'Claude-SearchBot', 'PerplexityBot'];

export type SignalStatus = 'ok' | 'low' | 'not-measured';

export interface Readiness {
  /** True: every measured signal is ok. False: a measured signal is low. Null: nothing could be measured. */
  ready: boolean | null;
  /** Share of content pages with at least one typed structured-data node (JSON-LD, microdata or RDFa). */
  structuredData: { status: SignalStatus; partial?: true; pages?: number; of?: number; percent?: number };
  /** Indexable pages whose inferred type is not `legal` (heuristic page types). */
  contentPages: { status: SignalStatus; partial?: true; pages?: number; indexable?: number; legal?: number; byType?: Record<string, number> };
  /** Search and AI search crawler access to the homepage; llms.txt and training crawlers are informational only. */
  aiSearch: { status: SignalStatus; blocked?: string[]; llmsTxt?: 'present' | 'absent' | 'not-checked'; trainingBlocked?: number };
  thresholds: { structuredDataPercent: number; contentPages: number };
}

const thresholds = () => ({ structuredDataPercent: STRUCTURED_DATA_MIN_PERCENT, contentPages: CONTENT_PAGES_MIN });

export function notMeasuredReadiness(): Readiness {
  return { ready: null, structuredData: { status: 'not-measured' }, contentPages: { status: 'not-measured' }, aiSearch: { status: 'not-measured' }, thresholds: thresholds() };
}

/** Per-URL check counted exactly like `inventory.structuredData.pagesWithStructuredData`. */
export function structuredDataProbe(ctx: SiteContext): (url: string) => boolean {
  return (url) => {
    const p = ctx.byUrl.get(url);
    const f = p && factsOf(p);
    return !!f && pageSchemaTypes(f).size > 0;
  };
}

export function buildReadiness(input: {
  inventory: SiteInventory;
  geo: GeoReport;
  /** Omitted when page data is not available (then structured data and content pages are not measured). */
  hasStructuredData?: (url: string) => boolean;
  partial?: boolean;
  /** False when robots.txt was never actually read (repository mode without a robots file). */
  robotsMeasured?: boolean;
}): Readiness {
  const { inventory, geo, hasStructuredData } = input;
  const partial = input.partial ? ({ partial: true } as const) : {};
  const out = notMeasuredReadiness();

  if (hasStructuredData) {
    const indexable = inventory.pages.filter((p) => p.indexable);
    const content = indexable.filter((p) => p.type !== 'legal');
    const byType: Record<string, number> = {};
    for (const p of content) byType[p.type] = (byType[p.type] ?? 0) + 1;
    const top = Object.fromEntries(Object.entries(byType).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5));
    out.contentPages = {
      status: content.length < CONTENT_PAGES_MIN ? 'low' : 'ok', ...partial,
      pages: content.length, indexable: indexable.length, legal: indexable.length - content.length, byType: top,
    };
    if (content.length) {
      const withSd = content.filter((p) => hasStructuredData(p.url)).length;
      const percent = Math.floor((withSd / content.length) * 100);
      out.structuredData = { status: percent < STRUCTURED_DATA_MIN_PERCENT ? 'low' : 'ok', ...partial, pages: withSd, of: content.length, percent };
    }
  }

  if (geo.bots.length && input.robotsMeasured !== false) {
    const blocked = geo.bots
      .filter((b) => !b.allowed && (SEARCH_BOTS.includes(b.token) || (b.purpose === 'ai-search' && AI_SEARCH_BOTS.includes(b.token))))
      .map((b) => b.token);
    out.aiSearch = {
      status: blocked.length ? 'low' : 'ok',
      blocked,
      llmsTxt: geo.llmsTxt ? (geo.llmsTxt.present ? 'present' : 'absent') : 'not-checked',
      trainingBlocked: geo.bots.filter((b) => b.purpose === 'ai-training' && !b.allowed).length,
    };
  }

  const measured = [out.structuredData, out.contentPages, out.aiSearch].filter((s) => s.status !== 'not-measured');
  out.ready = measured.length ? measured.every((s) => s.status === 'ok') : null;
  return out;
}
