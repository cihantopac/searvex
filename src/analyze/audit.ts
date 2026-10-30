import type { Category, Finding, Severity } from '../core/types.js';
import { crawl, type CrawlOptions, type CrawlResult } from '../crawl/crawler.js';
import { RunStore } from '../crawl/store.js';
import { DEFAULT_USER_AGENT, safeFetch, SEARVEX_VERSION } from '../net/fetcher.js';
import { DEFAULT_POLICY } from '../net/ssrf.js';
import { FindingSink, loadKnowledge, type KnowledgeBase } from '../rules/engine.js';
import { buildContext } from './context.js';
import { runContentChecks, type ContentReport } from './content.js';
import { runGeoChecks, type GeoReport, type LlmsTxtStatus } from './geo.js';
import { buildInventory, type SiteInventory } from './inventory.js';
import { runTechnicalChecks } from './technical.js';
import { prioritise } from './priority.js';
import { checkExternalLinks, type ExternalLinkResult } from './external-links.js';
import { failingMetrics, queryCrux, type CruxResult } from '../integrations/crux.js';

export interface AuditReport {
  tool: { name: 'searvex'; version: string; rulesVersion: string };
  mode: 'website' | 'repository';
  target: string;
  runId: string;
  generatedAt: string;
  crawl: CrawlResult['stats'] & { truncated: boolean; startUrl: string; robots: { url: string; state: string; status: number; sitemaps: string[] }; sitemaps: string[]; sitemapUrls: number; sitemapIssues: Array<{ sitemap: string; message: string }> };
  inventory: SiteInventory;
  findings: Array<Finding & { count: number }>;
  geo: GeoReport;
  content: ContentReport;
  scores: Scores;
  measurement: { verified: number; heuristic: number; unmeasurable: number };
  /** Real-user field data when a CrUX API key is configured. */
  fieldData?: CruxResult;
  externalLinks?: ExternalLinkResult;
  limitations: string[];
}

export interface Scores {
  /** 0–100. Searvex health score: a summary of Searvex findings, NOT a search engine metric. */
  overall: number;
  byCategory: Partial<Record<Category, number>>;
  method: string;
}

const WEIGHT: Record<Severity, number> = { critical: 25, high: 10, medium: 4, low: 1.5, info: 0 };

/**
 * Score = 100 − Σ(weight × affected-share), where affected-share = affected pages / indexable pages
 * (capped at 1). Site-level findings count as share 1. Heuristic findings count half.
 * Unmeasurable findings never change the score.
 */
export function computeScores(findings: Array<Finding & { count: number }>, pageCount: number): Scores {
  const penalty = (fs: Array<Finding & { count: number }>) =>
    fs.reduce((sum, f) => {
      if (f.confidence === 'unmeasurable') return sum;
      const share = pageCount > 0 ? Math.min(1, f.count / pageCount) : 1;
      return sum + WEIGHT[f.severity] * Math.max(share, f.severity === 'critical' ? 1 : share) * (f.confidence === 'heuristic' ? 0.5 : 1);
    }, 0);
  const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(100 - n)));
  const byCategory: Partial<Record<Category, number>> = {};
  const cats = new Set(findings.map((f) => f.category));
  for (const c of cats) byCategory[c] = clamp(penalty(findings.filter((f) => f.category === c)) * 2);
  return {
    overall: clamp(penalty(findings)),
    byCategory,
    method: 'Searvex health score = 100 − Σ(severity weight × share of affected pages); heuristic findings weigh 50%; unmeasurable findings are excluded. It summarises Searvex findings and is not a search engine metric.',
  };
}

async function probeLlmsTxt(origin: string, opts: Pick<CrawlOptions, 'policy' | 'timeoutMs' | 'userAgent'>): Promise<LlmsTxtStatus> {
  const url = new URL('/llms.txt', origin).toString();
  const res = await safeFetch(url, { ...opts, maxBytes: 512 * 1024 });
  const present = res.status === 200 && !/html/i.test(res.contentType) && res.body.trim().length > 0;
  return { url, present, status: res.status, bytes: res.bodyBytes };
}

/** Check http→https and www/non-www consolidation of the homepage. */
async function probeHostVariants(startUrl: string, opts: Pick<CrawlOptions, 'policy' | 'timeoutMs' | 'userAgent'>, sink: FindingSink): Promise<void> {
  const u = new URL(startUrl);
  if (u.protocol === 'https:') {
    const http = new URL(startUrl);
    http.protocol = 'http:';
    const res = await safeFetch(http.toString(), { ...opts, followRedirects: false, maxBytes: 64 * 1024 });
    if (!res.error && res.status === 200) sink.emit('canonical.http-https', { url: http.toString(), observed: 'HTTP 200 without redirect to HTTPS' });
  }
  // Only probe the www variant for registrable-looking hosts (skip IPs and localhost).
  if (/^[\d.]+$/.test(u.hostname) || u.hostname === 'localhost' || u.hostname.split('.').length < 2) return;
  const alt = new URL(startUrl);
  alt.hostname = u.hostname.startsWith('www.') ? u.hostname.slice(4) : `www.${u.hostname}`;
  const res = await safeFetch(alt.toString(), { ...opts, followRedirects: false, maxBytes: 64 * 1024 });
  if (!res.error && res.status === 200) sink.emit('canonical.www-duplicate', { url: alt.toString(), observed: `${alt.host} and ${u.host} both return 200` });
}

export interface AuditOptions {
  crawl?: Partial<CrawlOptions>;
  workspace?: string;
  resumeRunId?: string;
  kb?: KnowledgeBase;
  probes?: boolean;
  checkExternal?: boolean;
  cruxApiKey?: string;
}

export async function auditWebsite(url: string, options: AuditOptions = {}): Promise<{ report: AuditReport; store: RunStore }> {
  const kb = options.kb ?? loadKnowledge();
  const store = new RunStore(options.workspace ?? process.cwd(), options.resumeRunId ?? RunStore.newRunId('audit'));
  const result = await crawl(url, options.crawl, store);
  const report = await analyzeCrawl(result, kb, { ...options.crawl, probes: options.probes ?? true, checkExternal: options.checkExternal, cruxApiKey: options.cruxApiKey });
  store.writeJson('report.json', report);
  return { report, store };
}

export async function analyzeCrawl(result: CrawlResult, kb: KnowledgeBase, opts: Partial<CrawlOptions> & { probes?: boolean; checkExternal?: boolean; cruxApiKey?: string } = {}): Promise<AuditReport> {
  const sink = new FindingSink(kb);
  const ctx = buildContext(result);
  const netOpts = { policy: opts.policy ?? DEFAULT_POLICY, timeoutMs: opts.timeoutMs ?? 15000, userAgent: opts.userAgent ?? DEFAULT_USER_AGENT };
  let llms: LlmsTxtStatus | undefined;
  if (opts.probes !== false) {
    await probeHostVariants(result.startUrl, netOpts, sink);
    llms = await probeLlmsTxt(result.origin, netOpts);
  }
  runTechnicalChecks(ctx, sink);
  const geo = runGeoChecks(ctx, sink, llms);
  const content = runContentChecks(ctx, sink);
  let externalLinks: ExternalLinkResult | undefined;
  if (opts.checkExternal) externalLinks = await checkExternalLinks(ctx, sink, { ...netOpts, robotsAgent: opts.robotsAgent });
  let fieldData: CruxResult | undefined;
  if (opts.cruxApiKey) {
    fieldData = await queryCrux(result.origin, opts.cruxApiKey);
    if (fieldData.status === 'ok') {
      for (const m of fieldData.metrics) {
        const failing = failingMetrics(m);
        if (failing.length) sink.emit('perf.cwv-poor', { url: result.origin, observed: `${m.formFactor}: ${failing.join(', ')} (CrUX p75, ${m.collectionPeriod?.first ?? ''}–${m.collectionPeriod?.last ?? ''})` });
      }
    } else sink.emit('perf.cwv-unmeasured', { observed: fieldData.message });
  } else sink.emit('perf.cwv-unmeasured', { observed: 'No CrUX API key configured (SEARVEX_CRUX_API_KEY)' });
  const inventory = buildInventory(ctx);
  const findings = sink.findings();
  prioritise(findings, (id) => sink.affected(id), ctx);
  const limitations = [
    'Website mode sees only publicly reachable pages; it has no access to real traffic, rankings, Search Console or analytics data unless an integration is configured.',
    'Response times are single-location lab samples, not Core Web Vitals field data.',
  ];
  if (result.truncated) limitations.unshift(`Crawl stopped at the page limit with ${result.stats.queuedRemaining} URLs still queued; site-level findings (orphans, duplicates, hreflang return links) are based on the crawled subset.`);
  if (!opts.checkExternal) limitations.push('Outbound links were not checked (use --check-external).');
  if (!result.pages.some((p) => p.rendered)) limitations.push('JavaScript was not executed (run with --render to compare rendered DOM); client-rendered content is only detected heuristically.');
  return {
    tool: { name: 'searvex', version: SEARVEX_VERSION, rulesVersion: kb.version },
    mode: 'website',
    target: result.startUrl,
    runId: result.runId,
    generatedAt: new Date().toISOString(),
    crawl: {
      ...result.stats,
      truncated: result.truncated,
      startUrl: result.startUrl,
      robots: { url: result.robots.url, state: result.robots.state, status: result.robots.status, sitemaps: result.robots.sitemaps },
      sitemaps: result.sitemap.sitemaps,
      sitemapUrls: result.sitemap.urls.length,
      sitemapIssues: result.sitemap.issues.slice(0, 100),
    },
    inventory,
    findings,
    geo,
    content,
    scores: computeScores(findings, Math.max(1, ctx.indexable.length)),
    measurement: {
      verified: findings.filter((f) => f.confidence === 'verified').length,
      heuristic: findings.filter((f) => f.confidence === 'heuristic').length,
      unmeasurable: findings.filter((f) => f.confidence === 'unmeasurable').length,
    },
    fieldData,
    externalLinks,
    limitations,
  };
}
