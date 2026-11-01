import fs from 'node:fs';
import path from 'node:path';
import type { AuditReport } from '../analyze/audit.js';
import type { SearchPerformanceReport } from '../analyze/search-performance.js';
import { RunStore } from '../crawl/store.js';
import { diffReports } from '../commands/monitor.js';
import type { FindingReview, ReportExtras } from './html.js';

/**
 * Report context stored next to an audit (`context.json`): which repository it belongs to and which rules had a
 * concrete automatic patch in the dry-run plan. Lets `searvex report` re-render the same action center later.
 */
export interface RunContext {
  repository?: { path: string; framework?: string; siteUrl?: string; lang?: string };
  autoRules?: string[];
}

export function writeContext(store: RunStore, ctx: RunContext): void {
  store.writeJson('context.json', ctx);
}

/** Everything the HTML action center shows besides the audit itself, read from the workspace. */
export function loadExtras(store: RunStore, report: AuditReport): ReportExtras {
  const ctx = store.readJson<RunContext>('context.json') ?? {};
  const reviews = store.readJson<FindingReview[]>('reviews.json') ?? [];
  return {
    repository: ctx.repository,
    plan: ctx.autoRules ? { fixes: ctx.autoRules.map((ruleId) => ({ ruleId })) as never } : null,
    reviews,
    diff: baselineDiff(store, report),
    search: latestSearchData(store.root, report),
  };
}

/** Diff against the newest earlier audit of the same target and mode (never a later one). */
function baselineDiff(store: RunStore, report: AuditReport) {
  const earlier = RunStore.list(store.root).filter((id) => id < store.runId).reverse();
  for (const id of earlier) {
    const r = new RunStore(store.root, id).readJson<AuditReport>('report.json');
    if (r && r.target === report.target && r.mode === report.mode) return diffReports(r, report, id);
  }
  return null;
}

/** Newest Search Console / Bing analysis joined to this audit, or else to an audit of the same host. */
function latestSearchData(root: string, report: AuditReport): SearchPerformanceReport | null {
  if (report.mode !== 'website') return null;
  const host = (u: string) => {
    try {
      return new URL(u).host.toLowerCase().replace(/^www\./, '');
    } catch {
      return '';
    }
  };
  let sameHost: SearchPerformanceReport | null = null;
  for (const id of RunStore.list(root).reverse()) {
    const f = path.join(root, '.searvex', 'runs', id, 'search-performance.json');
    if (!fs.existsSync(f)) continue;
    const s = new RunStore(root, id).readJson<SearchPerformanceReport>('search-performance.json');
    if (!s?.audit) continue;
    if (s.audit.runId === report.runId) return s;
    if (!sameHost && host(s.audit.target) === host(report.target)) sameHost = s;
  }
  return sameHost;
}
