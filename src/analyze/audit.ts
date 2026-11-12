import type { Category, Finding, Severity } from '../core/types.js';
import { crawl, DEFAULT_CRAWL, type CrawlOptions, type CrawlResult, type Interruption } from '../crawl/crawler.js';
import { RunStore } from '../crawl/store.js';
import { DEFAULT_USER_AGENT, safeFetch, SEARVEX_VERSION } from '../net/fetcher.js';
import { DEFAULT_POLICY } from '../net/ssrf.js';
import { extractPage } from '../extract/html.js';
import { FindingSink, loadKnowledge, SITE_FILE, type KnowledgeBase } from '../rules/engine.js';
import { buildContext } from './context.js';
import { applyPreLaunch, asLaunched, emitLaunchNoindex } from './pre-launch.js';
import { runContentChecks, type ContentReport } from './content.js';
import { runGeoChecks, type GeoReport, type LlmsTxtStatus } from './geo.js';
import { buildInventory, type SiteInventory } from './inventory.js';
import { runRobotsAccessChecks, runTechnicalChecks } from './technical.js';
import { prioritise, type TrafficInput } from './priority.js';
import { checkExternalLinks, type ExternalLinkResult } from './external-links.js';
import { failingMetrics, queryCrux, type CruxResult } from '../integrations/crux.js';
import { runLab, type LabData } from './lab.js';
import { runPackChecks } from './packs.js';
import { annotateReport, type RootCauseGroup } from '../report/remediation.js';
import { SCHEMA_VERSION } from '../contract.js';

export interface AuditReport {
  /** Version of the report schema (`searvex schema report`); independent of the package version. Since 1.3.0. */
  schemaVersion: typeof SCHEMA_VERSION;
  tool: {
    name: 'searvex';
    version: string;
    /** Newest version of all rule files (`knowledge/rules/*.json`). */
    rulesVersion: string;
    /** Version of the rule file of each rule that produced a finding. Since 1.3.0. */
    rules?: Record<string, string>;
    /** Community rule packs loaded with `--rules-pack` (name, version, rule count). Since schema 1.2. */
    packs?: Array<{ name: string; version: string; rules: number }>;
  };
  mode: 'website' | 'repository';
  target: string;
  runId: string;
  generatedAt: string;
  crawl: CrawlResult['stats'] & {
    /**
     * Website mode. `unreachable`: the start URL failed at the network level. `robots-blocked`: robots.txt
     * (unreachable with 5xx/429, or disallowing every URL) blocked every queued URL, so no page was fetched.
     * In both cases nothing was analysed: `scores.overall` is null and the CLI exits 4.
     */
    status?: CrawlStatus;
    /** Network error for an unreachable target. */
    error?: string;
    /** Public origin the crawled origin stands for (--site-url); URLs on it were mapped to the crawled origin. */
    siteUrl?: string;
    /**
     * The run was stopped early by SIGINT/SIGTERM (`signal`) or at --max-duration: the report covers only the
     * pages fetched before (partial report, exit 5). Resume with --resume <runId>.
     */
    interrupted?: Interruption;
    /**
     * Upstream proxy the crawl went through (`--proxy`, HTTPS_PROXY): `host:port` and resolution mode, never
     * credentials. `unresolvedAllowed`: names local DNS could not resolve were sent to the proxy unchecked.
     * Since schema 1.1.
     */
    proxy?: { endpoint: string; resolve: 'proxy' | 'local'; unresolvedAllowed: boolean };
    /**
     * Evidence artefacts written by this run (`--save-html`, `--screenshots`) under `artefacts/` in the run
     * directory; `skipped` were over the 200 MB run limit. Since schema 1.1.
     */
    artefacts?: { html: number; screenshots: number; bytes: number; skipped: number };
    truncated: boolean; startUrl: string; robots: { url: string; state: string; status: number; sitemaps: string[] }; sitemaps: string[]; sitemapUrls: number; sitemapIssues: Array<{ sitemap: string; message: string }> };
  inventory: SiteInventory;
  findings: Array<Finding & { count: number }>;
  geo: GeoReport;
  content: ContentReport;
  scores: Scores;
  measurement: { verified: number; heuristic: number; unmeasurable: number };
  /** Real-user field data when a CrUX API key is configured. */
  fieldData?: CruxResult;
  /**
   * Lighthouse lab data from PageSpeed Insights for sampled URL templates (`--lab`). Lab values from one simulated
   * load: never Core Web Vitals pass/fail (that is `fieldData`). Since schema 1.1.
   */
  labData?: LabData;
  externalLinks?: ExternalLinkResult;
  limitations: string[];
  /** Distinct URLs (website) or locations (repository) with at least one non-informational finding. */
  affectedUrls?: number;
  /** Whether JavaScript was executed for at least one page (`--render`). */
  rendered?: boolean;
  /**
   * Search data that weighted the priorities (`gsc|bing report --audit`, `monitor --import` with a pages table):
   * page importance is then half structure, half share of clicks (or impressions). Since schema 1.1.
   */
  traffic?: TrafficInput;
  /**
   * Repository mode: routes that need a login (auth middleware, a login-redirecting layout). Their metadata and
   * indexability findings are not reported. Since schema 1.1.
   */
  privateRoutes?: Array<{ route: string; file: string; reason: string }>;
  /**
   * Root-cause groups per rule id: occurrences of one rule split by URL template, source file, shared layout or
   * site (see `rootCauseGroups`). Since 1.3.0.
   */
  rootCauseGroups?: Record<string, RootCauseGroup[]>;
}

export type CrawlStatus = 'complete' | 'unreachable' | 'robots-blocked';

/**
 * A website run that analysed no page: the target was unreachable, or robots.txt blocked every URL. The
 * report has no score and no findings about the pages; the CLI exits 4.
 */
export function notAnalysed(r: Pick<AuditReport, 'crawl'>): boolean {
  return r.crawl.status === 'unreachable' || r.crawl.status === 'robots-blocked';
}

/** One line saying why nothing was analysed, e.g. "target unreachable: getaddrinfo ENOTFOUND x". */
export function notAnalysedReason(r: Pick<AuditReport, 'crawl'>): string {
  if (r.crawl.status === 'robots-blocked') return `robots.txt blocks every URL: ${r.crawl.error ?? 'robots.txt disallows crawling'}`;
  return `target unreachable: ${r.crawl.error ?? 'network error'}`;
}

/**
 * Whether a finding counts toward the score, --fail-on, affected counts and regressions: unmeasurable
 * findings and pre-launch context findings (environment, launch checklist) never do.
 */
export function countsTowardScore(f: Pick<Finding, 'confidence' | 'context'>): boolean {
  return f.confidence !== 'unmeasurable' && !f.context;
}

/** Distinct affected URLs/files across all non-informational findings. */
export function countAffected(findings: Array<Finding & { count: number }>, affected: (ruleId: string) => string[]): number {
  const all = new Set<string>();
  for (const f of findings) if (f.severity !== 'info' && countsTowardScore(f)) for (const u of affected(f.ruleId)) if (!SITE_FILE.test(u)) all.add(u);
  return all.size;
}

/**
 * Indexable pages as the rules decide indexability (inventory), e.g. "2 indexable" or "0 indexable: all
 * noindex".
 */
export function indexableSummary(r: Pick<AuditReport, 'inventory' | 'findings'>): string {
  const total = r.inventory.pages.length;
  const indexable = r.inventory.pages.filter((p) => p.indexable).length;
  const noindex = r.findings.find((f) => f.ruleId === 'index.noindex')?.count ?? 0;
  return `${indexable} indexable${indexable === 0 && total > 0 && noindex >= total ? ': all noindex' : ''}`;
}

export interface Scores {
  /**
   * 0–100. Searvex health score: a summary of Searvex findings, NOT a search engine metric. `null` when
   * `notApplicable` is set (nothing was audited).
   */
  overall: number | null;
  byCategory: Partial<Record<Category, number>>;
  method: string;
  /** Why nothing could be audited (unreachable or robots-blocked target, repository without a website); `overall` is then null. */
  notApplicable?: string;
  /** `pre-launch`: environment and launch-checklist findings were excluded (--pre-launch). */
  profile?: 'pre-launch';
}

/** "87/100", or "n/a" when nothing could be audited. */
export function scoreLabel(s: Scores): string {
  return s.notApplicable ? 'n/a (nothing to audit)' : `${s.overall}/100${s.profile === 'pre-launch' ? ' (pre-launch profile)' : ''}`;
}

const WEIGHT: Record<Severity, number> = { critical: 25, high: 10, medium: 4, low: 1.5, info: 0 };

/**
 * Score = 100 − Σ(weight × affected-share), where affected-share = affected pages / indexable pages
 * (capped at 1). Site-level findings count as share 1. Heuristic findings count half.
 * Unmeasurable findings, and environment/launch-checklist findings of the pre-launch profile, never change
 * the score.
 */
export function computeScores(findings: Array<Finding & { count: number }>, pageCount: number): Scores & { overall: number } {
  const penalty = (fs: Array<Finding & { count: number }>) =>
    fs.reduce((sum, f) => {
      if (!countsTowardScore(f)) return sum;
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

/** `tool` of a report: versions, and the rule-file version of every rule that produced a finding. */
export function toolInfo(kb: KnowledgeBase, findings: Array<Pick<Finding, 'ruleId'>>): AuditReport['tool'] {
  const rules: Record<string, string> = {};
  for (const f of findings) {
    const v = kb.ruleVersions?.get(f.ruleId);
    if (v) rules[f.ruleId] = v;
  }
  return { name: 'searvex', version: SEARVEX_VERSION, rulesVersion: kb.version, rules, ...(kb.packs?.length ? { packs: kb.packs } : {}) };
}

/** Point each evidence item at the artefacts of its page (`--save-html`, `--screenshots`). */
function linkArtefacts(findings: Finding[], ctx: ReturnType<typeof buildContext>): void {
  for (const f of findings) {
    f.evidence = f.evidence.map((e) => {
      const page = e.url ? ctx.byUrl.get(e.url) : undefined;
      return page?.artefacts ? { ...e, artefact: page.artefacts } : e;
    });
  }
}

/** Scores of a run that audited nothing: no overall score, no categories. */
export function notApplicableScores(reason: string): Scores {
  return { ...computeScores([], 1), overall: null, notApplicable: reason };
}

async function probeLlmsTxt(origin: string, opts: Pick<CrawlOptions, 'policy' | 'timeoutMs' | 'userAgent'>): Promise<LlmsTxtStatus> {
  const url = new URL('/llms.txt', origin).toString();
  const res = await safeFetch(url, { ...opts, maxBytes: 512 * 1024 });
  const present = res.status === 200 && !/html/i.test(res.contentType) && res.body.trim().length > 0;
  return { url, present, status: res.status, bytes: res.bodyBytes };
}

/**
 * Server-side locale adaptation: fetch the start URL without Accept-Language (like Googlebot), with
 * en-US and with de-DE, and compare lang, title, canonical and redirects.
 */
export async function probeLocaleAdaptive(startUrl: string, opts: Pick<CrawlOptions, 'policy' | 'timeoutMs' | 'userAgent'>, sink: FindingSink): Promise<void> {
  const variants: Array<[string, Record<string, string>]> = [['none', {}], ['en-US', { 'accept-language': 'en-US,en;q=0.9' }], ['de-DE', { 'accept-language': 'de-DE,de;q=0.9' }]];
  const seen: Array<{ label: string; sig: string; detail: string }> = [];
  for (const [label, headers] of variants) {
    const res = await safeFetch(startUrl, { ...opts, headers, maxBytes: 2 * 1024 * 1024 });
    if (res.error || res.status !== 200) return; // only compare successful responses
    const f = extractPage(res.body, res.finalUrl);
    seen.push({ label, sig: [res.finalUrl, f.lang ?? '', f.canonical ?? '', f.title ?? ''].join('|'), detail: `${label}: ${res.finalUrl !== startUrl ? `→ ${res.finalUrl}, ` : ''}lang=${f.lang ?? 'none'}, title="${(f.title ?? '').slice(0, 50)}"` });
  }
  if (new Set(seen.map((s) => s.sig)).size > 1) sink.emit('lang.locale-adaptive', { url: startUrl, observed: `server responds differently by Accept-Language — ${seen.map((s) => s.detail).join('; ')}` });
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

/** robots.txt blocked every queued URL, so no page was requested (RFC 9309 disallow, or `Disallow: /`). */
export function robotsBlockedAll(result: CrawlResult): boolean {
  return !result.unreachable && result.pages.length > 0 && result.pages.every((p) => p.blockedByRobots);
}

/** Why robots.txt blocked the whole crawl (see `robotsBlockedAll`). */
function robotsBlockReason(result: CrawlResult, robotsAgent: string): string {
  const r = result.robots;
  return r.state === 'unreachable'
    ? `robots.txt could not be read (${r.error ?? `HTTP ${r.status}`}); RFC 9309 requires treating that as a complete disallow`
    : `robots.txt disallows every queued URL for ${robotsAgent}`;
}

function crawlSummary(result: CrawlResult, robotsAgent = DEFAULT_CRAWL.robotsAgent): AuditReport['crawl'] {
  const blocked = robotsBlockedAll(result);
  return {
    ...result.stats,
    // Reports of runs before 1.3.0 have no `fetched`.
    fetched: result.stats.fetched ?? result.pages.filter((p) => !p.blockedByRobots).length,
    status: result.unreachable ? 'unreachable' : blocked ? 'robots-blocked' : 'complete',
    ...(result.unreachable ? { error: result.unreachable.error } : blocked ? { error: robotsBlockReason(result, robotsAgent) } : {}),
    ...(result.siteUrl ? { siteUrl: result.siteUrl } : {}),
    ...(result.interrupted ? { interrupted: result.interrupted } : {}),
    ...(result.proxy ? { proxy: result.proxy } : {}),
    ...(result.artefacts ? { artefacts: result.artefacts } : {}),
    truncated: result.truncated,
    startUrl: result.startUrl,
    robots: { url: result.robots.url, state: result.robots.state, status: result.robots.status, sitemaps: result.robots.sitemaps },
    sitemaps: result.sitemap.sitemaps,
    sitemapUrls: result.sitemap.urls.length,
    sitemapIssues: result.sitemap.issues.slice(0, 100),
  };
}

export interface AuditOptions {
  crawl?: Partial<CrawlOptions>;
  workspace?: string;
  resumeRunId?: string;
  kb?: KnowledgeBase;
  probes?: boolean;
  checkExternal?: boolean;
  cruxApiKey?: string;
  /** --lab: PageSpeed Insights lab runs on this many sampled templates with this key. */
  lab?: { apiKey: string; samples: number };
  /** Pre-launch profile (--pre-launch): see `applyPreLaunch`. */
  preLaunch?: boolean;
  /** --compact: write only the count of each finding's affected URLs (see `compactAffected`). */
  compact?: boolean;
  /** Called when the run enters a phase (structured progress). */
  onPhase?: (phase: 'crawl' | 'analyze') => void;
}

/** --compact: keep only `affected.count` per finding, for very large crawls. Mutates and returns `r`. */
export function compactAffected(r: AuditReport): AuditReport {
  for (const f of r.findings) if (f.affected) f.affected = { count: f.affected.count };
  return r;
}

export async function auditWebsite(url: string, options: AuditOptions = {}): Promise<{ report: AuditReport; store: RunStore }> {
  const kb = options.kb ?? loadKnowledge();
  const store = new RunStore(options.workspace ?? process.cwd(), options.resumeRunId ?? RunStore.newRunId('audit'));
  options.onPhase?.('crawl');
  const result = await crawl(url, options.crawl, store);
  options.onPhase?.('analyze');
  const report = annotateReport(await analyzeCrawl(result, kb, { ...options.crawl, probes: options.probes ?? true, checkExternal: options.checkExternal, cruxApiKey: options.cruxApiKey, lab: options.lab, preLaunch: options.preLaunch }));
  if (options.compact) compactAffected(report);
  store.writeJson('report.json', report);
  return { report, store };
}

export async function analyzeCrawl(result: CrawlResult, kb: KnowledgeBase, opts: Partial<CrawlOptions> & { probes?: boolean; checkExternal?: boolean; cruxApiKey?: string; lab?: { apiKey: string; samples: number }; preLaunch?: boolean } = {}): Promise<AuditReport> {
  const sink = new FindingSink(kb);
  const launch = opts.preLaunch ? asLaunched(result) : undefined;
  if (launch) result = launch.result;
  const ctx = buildContext(result);
  const netOpts = { policy: opts.policy ?? DEFAULT_POLICY, timeoutMs: opts.timeoutMs ?? 15000, userAgent: opts.userAgent ?? DEFAULT_USER_AGENT };
  const unreachable = result.unreachable;
  const robotsAgent = opts.robotsAgent ?? DEFAULT_CRAWL.robotsAgent;
  let llms: LlmsTxtStatus | undefined;
  if (unreachable || robotsBlockedAll(result)) {
    // Nothing was fetched, so no page check can say anything about the site. Run them on a throwaway sink
    // only to build the (empty) report sections.
    const none = new FindingSink(kb);
    const geo = runGeoChecks(ctx, none);
    const content = runContentChecks(ctx, none);
    // A robots-blocked run keeps the one site finding the user has to fix (robots.txt unreachable, or the
    // site disallowed for search crawlers). It stays empty when only Searvex's own user agent is disallowed.
    const sink = new FindingSink(kb);
    if (!unreachable) runRobotsAccessChecks(ctx, sink);
    const findings = sink.findings();
    prioritise(findings, (id) => sink.affected(id), ctx);
    if (opts.preLaunch) applyPreLaunch(findings, kb);
    const why = unreachable ? `target unreachable (${unreachable.error})` : robotsBlockReason(result, robotsAgent);
    const limitation = unreachable
      ? `The start URL could not be reached (${unreachable.error}); no page was fetched, so this report contains no findings about the site. Check the URL, DNS, the network or the server, then run the audit again.`
      : `No page was fetched: ${why}, so all ${result.pages.length} queued URL(s) were skipped and this report contains no findings about the pages. ${
          result.robots.state === 'unreachable'
            ? 'Make /robots.txt return 200 (with rules) or 404 (no rules), then run the audit again.'
            : `To audit the site, allow the ${robotsAgent} user agent in robots.txt (on a staging build, for the test only), then run the audit again.`
        }`;
    return {
      schemaVersion: SCHEMA_VERSION,
    tool: toolInfo(kb, findings),
      mode: 'website',
      target: result.startUrl,
      runId: result.runId,
      generatedAt: new Date().toISOString(),
      crawl: crawlSummary(result, robotsAgent),
      inventory: buildInventory(ctx),
      findings,
      // robots.txt was never read for an unreachable target, so no crawler access can be stated.
      geo: unreachable ? { ...geo, bots: [] } : geo,
      content,
      scores: { ...notApplicableScores(why), ...(opts.preLaunch ? { profile: 'pre-launch' as const } : {}) },
      measurement: {
        verified: findings.filter((f) => f.confidence === 'verified').length,
        heuristic: findings.filter((f) => f.confidence === 'heuristic').length,
        unmeasurable: findings.filter((f) => f.confidence === 'unmeasurable').length,
      },
      limitations: [limitation],
      affectedUrls: 0,
      rendered: false,
    };
  }
  // An interrupted run must finish quickly: no extra network probes, outbound checks or CrUX query.
  const interrupted = result.interrupted;
  if (opts.probes !== false && !interrupted) {
    await probeHostVariants(result.startUrl, netOpts, sink);
    await probeLocaleAdaptive(result.startUrl, netOpts, sink);
    llms = await probeLlmsTxt(result.origin, netOpts);
  }
  runTechnicalChecks(ctx, sink);
  if (launch) emitLaunchNoindex(ctx, launch.noindex, sink);
  const geo = runGeoChecks(ctx, sink, llms);
  const content = runContentChecks(ctx, sink);
  // Community rule packs (--rules-pack): declarative page checks.
  if (kb.packs?.length) runPackChecks(ctx, kb, sink);
  let externalLinks: ExternalLinkResult | undefined;
  if (opts.checkExternal && !interrupted) externalLinks = await checkExternalLinks(ctx, sink, { ...netOpts, robotsAgent: opts.robotsAgent });
  let fieldData: CruxResult | undefined;
  if (interrupted) sink.emit('perf.cwv-unmeasured', { observed: 'Not queried: the run was interrupted' });
  else if (opts.cruxApiKey) {
    fieldData = await queryCrux(result.origin, opts.cruxApiKey);
    if (fieldData.status === 'ok') {
      for (const m of fieldData.metrics) {
        const failing = failingMetrics(m);
        if (failing.length) sink.emit('perf.cwv-poor', { url: result.origin, observed: `${m.formFactor}: ${failing.join(', ')} (CrUX p75, ${m.collectionPeriod?.first ?? ''}–${m.collectionPeriod?.last ?? ''})` });
      }
    } else sink.emit('perf.cwv-unmeasured', { observed: fieldData.message });
  } else sink.emit('perf.cwv-unmeasured', { observed: 'No CrUX API key configured (searvex crux auth, or SEARVEX_CRUX_API_KEY)' });
  let labData: LabData | undefined;
  if (opts.lab) {
    labData = interrupted ? { source: 'pagespeed-insights', strategy: 'mobile', samples: [], errors: [], skipped: 'the run was interrupted' } : await runLab(ctx, opts.lab, sink);
  }
  const inventory = buildInventory(ctx);
  const findings = sink.findings();
  if (result.artefacts) linkArtefacts(findings, ctx);
  prioritise(findings, (id) => sink.affected(id), ctx);
  if (opts.preLaunch) applyPreLaunch(findings, kb);
  const limitations = [
    'Website mode sees only publicly reachable pages; it has no access to real traffic, rankings, Search Console or analytics data unless an integration is configured.',
    'Response times are single-location lab samples, not Core Web Vitals field data.',
  ];
  if (interrupted)
    limitations.unshift(
      `The run was interrupted ${interrupted === 'signal' ? 'by a signal (SIGINT/SIGTERM)' : 'at the --max-duration deadline'} after ${result.stats.fetched} fetched page(s), with ${result.stats.queuedRemaining} URL(s) still queued: this is a partial report. Site-level findings (duplicates, hreflang return links) use the crawled subset, orphan pages are not reported, and the host, locale and llms.txt probes${opts.checkExternal ? ', the outbound link check' : ''} and the CrUX query were skipped. Continue the crawl with --resume ${result.runId}.`,
    );
  else if (result.truncated) limitations.unshift(`Crawl stopped at the page limit with ${result.stats.queuedRemaining} URLs still queued; site-level findings (duplicates, hreflang return links) are based on the crawled subset, and orphan pages are not reported (pages that were not crawled may link to them). Raise --max-pages for a complete picture.`);
  if (launch) limitations.push(`Pre-launch profile (--pre-launch): the site is audited as it will be once live. ${launch.noindex.size ? `${launch.noindex.size} noindex page(s) were evaluated as indexable; their noindex is in the launch checklist. ` : ''}Findings that depend on the test server (environment) or on a deliberate pre-launch state (launch checklist) are listed separately and excluded from the score and --fail-on.`);
  if (result.artefacts)
    limitations.push(
      `Evidence artefacts: ${result.artefacts.html} HTML bod${result.artefacts.html === 1 ? 'y' : 'ies'} and ${result.artefacts.screenshots} screenshot(s) under artefacts/ in the run directory (owner-only permissions). Bodies are stored as served (up to 2 MB each, as .html.txt so they open as source) and can contain personal data or tokens from the pages.${result.artefacts.skipped ? ` ${result.artefacts.skipped} artefact(s) were skipped at the 200 MB per-run limit.` : ''}`,
    );
  if (result.proxy)
    limitations.push(
      `Crawled through the upstream proxy ${result.proxy.endpoint} (CONNECT only). Response times include the proxy hop. ${
        result.proxy.resolve === 'local'
          ? 'Targets were resolved and checked locally and the proxy was given their addresses.'
          : `Targets were checked against local DNS before CONNECT, but the proxy resolved the names itself; if its DNS view differs (split-horizon DNS), Searvex cannot see the address it connected to.${result.proxy.unresolvedAllowed ? ' Names local DNS could not resolve were sent to the proxy unchecked (--proxy-resolve proxy).' : ''}`
      }`,
    );
  if (result.siteUrl) limitations.push(`Audited ${result.origin} as ${result.siteUrl} (--site-url): canonical, hreflang, sitemap and link URLs on ${result.siteUrl} were checked against the crawled pages at ${result.origin}; the public site itself was not fetched.`);
  if (!opts.checkExternal) limitations.push('Outbound links were not checked (use --check-external).');
  if (labData) {
    if (labData.skipped) limitations.push(`Lab data (--lab) not measured: ${labData.skipped}.`);
    else limitations.push(`Lab data (--lab): one Lighthouse run (PageSpeed Insights, mobile) on ${labData.samples.length} of ${labData.samples.length + labData.errors.length} sampled template page(s). Lab values vary between runs and are not Core Web Vitals field data.${labData.errors.length ? ` Not measured: ${labData.errors.map((e) => `${e.url} (${e.message})`).join('; ').slice(0, 400)}.` : ''}`);
  }
  if (!result.pages.some((p) => p.rendered)) limitations.push('JavaScript was not executed (run with --render to compare rendered DOM); client-rendered content is only detected heuristically.');
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: toolInfo(kb, findings),
    mode: 'website',
    target: result.startUrl,
    runId: result.runId,
    generatedAt: new Date().toISOString(),
    crawl: crawlSummary(result, robotsAgent),
    inventory,
    findings,
    geo,
    content,
    scores: { ...computeScores(findings, Math.max(1, ctx.indexable.length)), ...(opts.preLaunch ? { profile: 'pre-launch' as const } : {}) },
    measurement: {
      verified: findings.filter((f) => f.confidence === 'verified').length,
      heuristic: findings.filter((f) => f.confidence === 'heuristic').length,
      unmeasurable: findings.filter((f) => f.confidence === 'unmeasurable').length,
    },
    fieldData,
    ...(labData ? { labData } : {}),
    externalLinks,
    limitations,
    affectedUrls: countAffected(findings, (id) => sink.affected(id)),
    rendered: result.pages.some((p) => p.rendered),
  };
}
