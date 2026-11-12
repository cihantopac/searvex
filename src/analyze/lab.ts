import type { FindingSink } from '../rules/engine.js';
import { LAB_SCORE_POOR, labSummary, publiclyMeasurable, queryPsi, type LabMetrics } from '../integrations/psi.js';
import type { SiteContext } from './context.js';
import { urlPattern } from './priority.js';

/**
 * Lab data (plan F6): one Lighthouse run through PageSpeed Insights per sampled URL template, the most common
 * templates first and the homepage always included. Labelled "lab" and kept apart from CrUX field data: it never
 * decides Core Web Vitals pass/fail.
 */
export interface LabData {
  source: 'pagespeed-insights';
  strategy: 'mobile';
  /** One measured page per template, with the template's size in this crawl. */
  samples: Array<LabMetrics & { template: string; pages: number }>;
  errors: Array<{ url: string; template: string; message: string }>;
  /** Set when nothing was measured (no public URL, interrupted run). */
  skipped?: string;
}

export const LAB_DEFAULT_SAMPLES = 5;

/** Templates by page count (homepage first) with the best-linked page of each as its sample. */
export function labSamples(ctx: SiteContext, n: number): Array<{ template: string; pages: number; url: string }> {
  const groups = new Map<string, string[]>();
  for (const p of ctx.indexable) {
    const t = urlPattern(p.url);
    (groups.get(t) ?? groups.set(t, []).get(t)!).push(p.url);
  }
  const inl = (u: string) => ctx.reachIn.get(u)?.size ?? 0;
  const home = ctx.homepage?.url;
  return [...groups.entries()]
    .map(([template, urls]) => ({
      template,
      pages: urls.length,
      url: home && urls.includes(home) ? home : [...urls].sort((a, b) => inl(b) - inl(a) || (a < b ? -1 : a > b ? 1 : 0))[0]!,
    }))
    .sort((a, b) => Number(b.url === home) - Number(a.url === home) || b.pages - a.pages || (a.template < b.template ? -1 : 1))
    .slice(0, Math.max(0, n));
}

export async function runLab(ctx: SiteContext, opts: { apiKey: string; samples: number }, sink: FindingSink): Promise<LabData> {
  const out: LabData = { source: 'pagespeed-insights', strategy: 'mobile', samples: [], errors: [] };
  if (!publiclyMeasurable(ctx.crawl.origin)) {
    out.skipped = `${ctx.crawl.origin} is not publicly reachable; PageSpeed Insights fetches pages from Google's servers`;
    return out;
  }
  // Sequential: each run takes 10–30 s on Google's side and the API has per-minute quotas.
  for (const s of labSamples(ctx, opts.samples)) {
    const r = await queryPsi(s.url, opts.apiKey);
    if (r.status === 'error') {
      out.errors.push({ url: s.url, template: s.template, message: r.message });
      continue;
    }
    out.samples.push({ ...r.metrics, template: s.template, pages: s.pages });
    if (r.metrics.score !== undefined && r.metrics.score < LAB_SCORE_POOR)
      sink.emit('perf.lab-poor', { url: s.url, observed: `Lighthouse lab (mobile): ${labSummary(r.metrics)}; template ${s.template} (${s.pages} page${s.pages === 1 ? '' : 's'} in this crawl)` });
  }
  return out;
}
