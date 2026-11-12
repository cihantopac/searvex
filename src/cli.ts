#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { auditWebsite, countsTowardScore, indexableSummary, notAnalysed, notAnalysedReason, scoreLabel, type AuditReport } from './analyze/audit.js';
import type { Severity } from './core/types.js';
import { RunStore } from './crawl/store.js';
import { SEARVEX_VERSION } from './net/fetcher.js';
import { Progress, progress, setProgress, type ProgressPhase } from './progress.js';
import type { CrawlOptions } from './crawl/crawler.js';
import { classifyAddress, DEFAULT_POLICY, type NetPolicy } from './net/ssrf.js';
import { ProxyConfigError, proxyFromConfig } from './net/proxy.js';
import { renderHtml } from './report/html.js';
import { loadExtras, planOf } from './report/extras.js';
import { annotateReport, remediationOf } from './report/remediation.js';
import { commandOpen, commandReview, openFile, resolveRun } from './commands/review.js';
import { buildRepairPrompt } from './report/prompt.js';
import { repairPromptInput } from './report/prompt-input.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderMarkdown } from './report/markdown.js';
import { renderSarif } from './report/sarif.js';
import { defaultKnowledgeDir, loadKnowledge, validateKnowledge, type KnowledgeBase } from './rules/engine.js';
import { loadRulePack, RulePackError, validatePacks, withPacks, type RulePack } from './rules/packs.js';
import { checkSources, readSnapshots, snapshotFile, writeSnapshots } from './rules/sources.js';
import { IMPLEMENTED_RULES } from './rules/implemented.js';
import { commandRepo } from './commands/repo.js';
import { commandOptimize, commandRollback } from './commands/optimize.js';
import { commandMonitor } from './commands/monitor.js';
import { commandCrux, cruxKey } from './commands/crux.js';
import { commandPsi, psiKey } from './commands/psi.js';
import { commandGa4 } from './commands/ga4.js';
import { commandYandex } from './commands/yandex.js';
import { LAB_DEFAULT_SAMPLES } from './analyze/lab.js';
import { commandResearch } from './commands/research.js';
import { commandRun } from './commands/run.js';
import { commandEcosystem } from './commands/ecosystem.js';
import { commandBing, commandConnect, commandGsc } from './commands/gsc.js';

const HELP = `Searvex ${SEARVEX_VERSION} — open-source search intelligence & optimization engine

Usage: searvex <command> [target] [options]

Commands
  run <url> [path]      Full workflow in order: audit → GEO → change since last run → competitor research
                        (--competitor) → repository audit → fix plan (dry run). One crawl, one summary.
  audit <url|path>      Full technical SEO + GEO + content audit (website or repository)
  geo <url>             GEO / AI-search readiness (crawler access, snippet controls, entities)
  ecosystem <url> <url>…  Brand-family analysis across related sites: entity graph, cross-links,
                        topic overlap, family-wide issues, language coverage (--reuse stored runs)
  research <url>        Site inventory, business model, topics; compare with --competitor URLs
  optimize <path>       Plan safe code fixes for a repository (dry-run by default; --apply to write)
  rollback <changeId>   Restore files changed by an applied optimization
  connect <url>         Optional search data for a site: shows the three choices (Google / CSV / skip)
                        and records one with --choice google|csv|skip; never starts OAuth by itself
  gsc <auth|status|sites|report|import|logout>
                        Google Search Console (read-only): OAuth with your own Desktop client (--client;
                        opens your browser, --no-browser to only print the URL),
                        property check, query/page analysis with a property-matched --audit join;
                        "gsc import <export.zip>" reads a Performance CSV export without any account access
  bing <auth|status|sites|report|logout>
                        Bing Webmaster Tools (read-only API key): "bing auth" stores the key (hidden input)
                        in the credential store; "bing report <siteUrl>" checks the site is verified, then
                        analyses queries/pages
                        (bing is experimental: not yet verified against the live service)
  crux <auth|status|logout>
                        Chrome UX Report API key for real-user Core Web Vitals (hidden input, stored in the
                        credential store)
  psi <auth|status|logout>
                        PageSpeed Insights API key for Lighthouse lab data with --lab (hidden input, stored in
                        the credential store)
  ga4 <auth|status|properties|report|logout>
                        Google Analytics 4 (read-only OAuth, same Desktop client as gsc): "ga4 report <propertyId>
                        [--audit latest]" lists Organic Search landing pages and the audit's issues on pages with
                        traffic (experimental: not yet verified against a live property)
  yandex <auth|status|sites|report|logout>
                        Yandex Webmaster (OAuth token, read-only): "yandex report <siteUrl>" lists popular queries
                        of a verified site (experimental: not yet verified against a live site)
  monitor <url>         Re-audit and diff against the previous run (regressions / improvements)
  rules <list|show|validate|check-sources> [id]
                        Inspect/validate the rule base; check-sources re-fetches official sources and
                        reports changed, redirected or broken pages (--update records a new snapshot)
  report <runId|latest>  Re-render a stored report (--format)
  open [runId|latest]   Open a stored HTML report in the default browser
  review <runId|latest> <ref|ruleId> <confirmed|rejected|fixed> [--note text]
                        Record an agent/human review of a finding next to the audit (evidence is kept)
  prompt <runId|latest>  Print the repair prompt the HTML report builds, for every issue or --rules a,b
                        (--lang en|tr, --format md|json); secrets are redacted the same way
  schema [report|events|error]
                        Print the JSON Schema of report.json, --progress ndjson events or the --json
                        error object (default: report)
  runs                  List stored runs

Common options
  --max-pages <n>       Page limit (default 500)          --depth <n>        Max click depth (default 10)
  --concurrency <n>     Parallel requests (default 4)     --delay <ms>       Per-host delay (default 250)
  --timeout <ms>        Per-request timeout (default 15000, 1000–120000)
  --render              Execute JavaScript with Playwright (optional dependency) and compare DOMs
  --save-html           Keep each fetched HTML body (as served, ≤ 2 MB) under artefacts/ in the run
  --screenshots         With --render: one viewport screenshot per rendered page (≤ 200 MB per run in all)
  --include <regex>     Only crawl matching URLs          --exclude <regex>  Skip matching URLs
  --check-external      Check outbound links (HEAD, robots.txt-aware, max 200)
  --lab                 Lighthouse lab data (PageSpeed Insights, mobile) for one page per URL template, the
                        homepage and the largest templates first; needs "psi auth" or SEARVEX_PSI_API_KEY and a
                        public URL. Lab values, never Core Web Vitals pass/fail (experimental: not yet verified
                        against the live service)
  --lab-samples <n>     Templates measured with --lab (default 5, max 20)
  --rules-pack <name|dir>
                        Add a community rule pack (knowledge/packs/<name> or a directory; repeatable). Pack
                        rules are sourced like core rules, labelled in reports and never replace a core rule;
                        also for "rules list|show|validate"
  --no-sitemap          Do not seed from sitemaps         --resume <runId>   Resume an interrupted crawl
  --max-duration <s>    Stop crawling after s seconds and write a partial report (exit 5). SIGINT/SIGTERM
                        do the same; a second signal exits at once (130/143)
  --format <list>       md,html,json,sarif (default md,html,json)
  --compact             report.json: only the count of each finding's affected URLs (very large crawls)
  --out <dir>           Workspace for .searvex/ (default: current directory)
  --fail-on <severity>  Exit 1 if findings at/above severity exist (critical|high|medium|low)
  --allow-private       Allow localhost/private network targets (local dev servers only)
  --allow-host <glob>   Only contact matching hosts (repeatable; *.example.com); include the target
  --deny-host <glob>    Never contact matching hosts (repeatable; wins over --allow-host)
  --ports <list>        Only contact these ports (e.g. 80,443,8080)
  --proxy <url|none>    Upstream HTTP(S) proxy, CONNECT only (default: HTTPS_PROXY / HTTP_PROXY, with
                        NO_PROXY); private targets never go through it. none: ignore the environment
  --proxy-resolve <m>   proxy (CONNECT by host name after a local DNS check) or local (CONNECT to the
                        locally resolved address); passing proxy also allows names local DNS cannot resolve
  --pre-launch          Audit a local/staging build as it will be once live: test-server findings
                        (no HTTPS, no compression) and deliberate pre-launch states (noindex, a public
                        sitemap host that is not live yet) are listed separately, not scored
  --site-url <url>      Public URL of the site. URL mode: audit a local/staging build as that site
                        (its canonical, hreflang, sitemap and link URLs map to the crawled origin).
                        Repository mode: base URL for canonical/sitemap fixes. monitor: also accepts
                        a Search Console property (sc-domain:…)
  --lang <tag>          Document language for fixes when the framework has no locale idiom; prompt: en|tr
  --apply / --yes       optimize: write changes (after confirmation) / skip the prompt
  --only <ruleId>       optimize: restrict fixes to a rule (repeatable)
  --competitor <url>    research: competitor site to compare (repeatable, max 10)
  --rules <a,b>         prompt: only these rule ids (comma-separated or repeatable)
  --open                Open the HTML report in the default browser when done
  --json                Print the JSON report to stdout
  --progress ndjson     Progress as JSON events on stderr, one per line (start, phase, page,
                        finding-summary, end); every stderr line is then JSON, errors included
  -q, --quiet           Less output
  -h, --help            Show help                         -v, --version      Print the version

Command options
  --baseline <runId>    monitor: compare with this run instead of the previous run of the same site
  --import <file>       monitor / gsc import: Search Console Performance export (.zip or .csv, repeatable)
  --property <P>        Search Console property of an export or connect choice (sc-domain:example.com,
                        https://example.com/)
  --days <n>            gsc|bing report: period in days (default 28)
  --max-rows <n>        gsc report: row limit of the API query (default 25000)
  --category <c>        rules list: only rules of this category
  --strict              rules validate: treat warnings as errors
  --force               gsc auth: authorise again even when a valid authorization is stored

Environment (all optional, read-only integrations)
  SEARVEX_CRUX_API_KEY  Chrome UX Report API key (instead of "searvex crux auth")
  SEARVEX_PSI_API_KEY   PageSpeed Insights API key for --lab (instead of "searvex psi auth")
  SEARVEX_GA4_TOKEN     OAuth access token (analytics.readonly); alternative to "searvex ga4 auth"
  SEARVEX_YANDEX_TOKEN  Yandex OAuth token with Webmaster access (instead of "searvex yandex auth")
  SEARVEX_GSC_TOKEN     OAuth access token (webmasters.readonly); alternative to "searvex gsc auth"
  SEARVEX_BING_API_KEY  Bing Webmaster Tools API key (instead of "searvex bing auth")
  SEARVEX_GSC_SITE      Search Console property (e.g. sc-domain:example.com)
  SEARVEX_CREDENTIAL_STORE  file (default, 0600 file in the config dir) or keychain (macOS Keychain,
                        Secret Service via secret-tool, Windows DPAPI)
  SEARVEX_DEBUG=1       Print the stack trace of a runtime error (exit 3); by default one line
  HTTPS_PROXY, HTTP_PROXY, NO_PROXY
                        Upstream proxy for crawling when --proxy is not given (see --proxy)

Exit codes
  0 completed · 1 --fail-on threshold reached (also optimize verification failed, rollback conflict, or
  an integration status that is not working) · 2 usage error · 3 runtime error · 4 target unreachable or
  robots.txt blocks every URL (reports written, no page findings) · 5 interrupted (SIGINT/SIGTERM or
  --max-duration): a partial report was written

Searvex is read-only by default. It never publishes content, submits URLs or changes live sites.
`;

export const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export interface GlobalFlags {
  values: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
}

export const HELP_TEXT = HELP;

function parse(argv: string[]): GlobalFlags {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: CLI_OPTIONS,
  });
  return { values, positionals };
}

/** Every option of the CLI; test/unit/help.test.ts checks that each appears in --help. */
export const CLI_OPTIONS = {
  'max-pages': { type: 'string' },
  depth: { type: 'string' },
  concurrency: { type: 'string' },
  delay: { type: 'string' },
  timeout: { type: 'string' },
  render: { type: 'boolean' },
  include: { type: 'string', multiple: true },
  exclude: { type: 'string', multiple: true },
  'no-sitemap': { type: 'boolean' },
  resume: { type: 'string' },
  'max-duration': { type: 'string' },
  compact: { type: 'boolean' },
  'save-html': { type: 'boolean' },
  screenshots: { type: 'boolean' },
  progress: { type: 'string' },
  rules: { type: 'string', multiple: true },
  format: { type: 'string' },
  out: { type: 'string' },
  'fail-on': { type: 'string' },
  'allow-private': { type: 'boolean' },
  'allow-host': { type: 'string', multiple: true },
  'deny-host': { type: 'string', multiple: true },
  ports: { type: 'string' },
  proxy: { type: 'string' },
  'proxy-resolve': { type: 'string' },
  'pre-launch': { type: 'boolean' },
  json: { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  apply: { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  only: { type: 'string', multiple: true },
  'site-url': { type: 'string' },
  lang: { type: 'string' },
  'check-external': { type: 'boolean' },
  lab: { type: 'boolean' },
  'lab-samples': { type: 'string' },
  reuse: { type: 'boolean' },
  update: { type: 'boolean' },
  client: { type: 'string' },
  days: { type: 'string' },
  audit: { type: 'string' },
  'max-rows': { type: 'string' },
  'rules-pack': { type: 'string', multiple: true },
  competitor: { type: 'string', multiple: true },
  category: { type: 'string' },
  strict: { type: 'boolean' },
  baseline: { type: 'string' },
  import: { type: 'string', multiple: true },
  force: { type: 'boolean' },
  property: { type: 'string' },
  choice: { type: 'string' },
  'no-browser': { type: 'boolean' },
  open: { type: 'boolean' },
  note: { type: 'string' },
} as const;

export function num(v: unknown, def: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new UsageError(`Invalid number: ${String(v)} (expected ${min}–${max})`);
  return n;
}

export class UsageError extends Error {}

/** A target blocked by the network policy (exit 2, kind `policy`); the user can allow it. */
export class PolicyError extends UsageError {}

export const HELP_TRAILER = 'Run "searvex --help" for usage.';

/** `kind` of the JSON error object written to stderr with --json (see `errorLine`). */
export type ErrorKind = 'usage' | 'runtime' | 'unreachable' | 'robots-blocked' | 'policy' | 'interrupted';

/** The one-line JSON error object written to stderr with --json: `{"error":{"code","kind","message"}}`. */
export function errorJson(code: number, kind: ErrorKind, message: string): string {
  return JSON.stringify({ error: { code, kind, message } });
}

/**
 * Report an error on stderr: one `searvex: …` line (plus an optional hint line) and, with --json, the JSON
 * error object on the next line.
 */
export function reportError(code: number, kind: ErrorKind, message: string, json: boolean, hint?: string): void {
  // With --progress ndjson every stderr line is JSON: only the error object.
  if (!progress()) console.error(`searvex: ${message}${hint ? `\n${hint}` : ''}`);
  if (json || progress()) console.error(errorJson(code, kind, message));
}

/** Crawl progress: ndjson `page` events, or a plain line every 10 fetched pages. */
export function crawlProgress(v: GlobalFlags['values']): NonNullable<CrawlOptions['onProgress']> {
  let last = 0;
  return (p) => {
    const pr = progress();
    if (pr) return pr.emit({ event: 'page', url: p.url, status: p.status, blocked: p.blocked, fetched: p.fetched, crawled: p.crawled, queued: p.queued });
    if (p.blocked || !(p.fetched - last >= 10 || p.fetched === 1)) return;
    last = p.fetched;
    log(v, `  ${p.fetched} pages fetched · ${p.queued} queued · ${p.status} ${p.url}`);
  };
}

/** ndjson `phase` event (no-op without --progress ndjson). */
export const phaseProgress = (phase: ProgressPhase): void => progress()?.emit({ event: 'phase', phase });

/** Process exit codes (documented in docs/cli.md and --help). */
export const EXIT = {
  ok: 0,
  /** --fail-on threshold reached (also: optimize verification failed, rollback conflict, integration not working). */
  failOn: 1,
  usage: 2,
  runtime: 3,
  /**
   * Target not analysable: the start URL failed at the network level, or robots.txt blocked every URL
   * (`crawl.status` tells them apart). Reports were written but contain no findings about the pages.
   */
  unreachable: 4,
  /** Interrupted run (SIGINT/SIGTERM or --max-duration) with a partial report. */
  interrupted: 5,
} as const;

/**
 * A target blocked by the network policy is a usage problem (the user can allow it), not an unreachable
 * site: fail before writing reports.
 */
export function assertTargetAllowed(report: AuditReport): void {
  const err = report.crawl.status === 'unreachable' ? report.crawl.error : undefined;
  // The proxy failed, not the site: a wrong credential is a usage error, an unreachable proxy a runtime error.
  if (err?.startsWith('Proxy authentication failed')) throw new UsageError(`${err}. Check the credentials in --proxy or HTTPS_PROXY.`);
  if (err?.startsWith('Proxy unreachable')) throw new Error(err);
  if (!err?.startsWith('Blocked: ')) return;
  const why = err.slice(9);
  const hint = /--(deny|allow)-host|--ports/.test(why) ? 'Adjust --allow-host, --deny-host or --ports.' : 'Use --allow-private for a local or private development server.';
  throw new PolicyError(`${report.target} is blocked by the network policy (${why}). ${hint}`);
}

/**
 * Exit code for a finished website audit: target not analysable (unreachable, robots-blocked), then
 * interrupted (partial report), else the --fail-on result.
 */
export function auditExit(report: AuditReport, failOn: unknown): number {
  return notAnalysed(report) ? EXIT.unreachable : report.crawl.interrupted ? EXIT.interrupted : failOnExit(report, failOn);
}

/** The stderr line of an interrupted run (exit 5), also with --json and --quiet. */
export function reportInterrupted(report: AuditReport, json: boolean): void {
  if (!report.crawl.interrupted || notAnalysed(report)) return;
  const why = report.crawl.interrupted === 'signal' ? 'by a signal' : 'at --max-duration';
  reportError(EXIT.interrupted, 'interrupted', `interrupted ${why}: partial report of ${report.crawl.fetched} fetched page(s); continue with --resume ${report.runId}`, json);
}

export interface Interrupter {
  /** Aborted with reason `signal` or `max-duration`; pass it as the crawl's `stop`. */
  signal: AbortSignal;
  dispose: () => void;
}

/**
 * Graceful interruption for crawling commands: the first SIGINT/SIGTERM, or the --max-duration deadline,
 * aborts `signal` (the crawl stops and a partial report is written); a second signal exits at once with
 * 130 (SIGINT) or 143 (SIGTERM).
 */
export function interrupter(v: GlobalFlags['values']): Interrupter {
  const ac = new AbortController();
  const seconds = v['max-duration'] === undefined ? undefined : num(v['max-duration'], 0, 1, 7 * 86_400);
  const timer = seconds
    ? setTimeout(() => {
        log(v, `--max-duration ${seconds}s reached: finishing pages in flight and writing a partial report…`);
        ac.abort('max-duration');
      }, seconds * 1000)
    : undefined;
  timer?.unref();
  const onSignal = (sig: NodeJS.Signals) => {
    if (ac.signal.aborted) process.exit(sig === 'SIGINT' ? 130 : 143);
    if (progress()) progress()!.emit({ event: 'signal', signal: sig });
    else console.error(`searvex: ${sig} received: finishing pages in flight and writing a partial report (send it again to exit at once)`);
    ac.abort('signal');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return {
    signal: ac.signal,
    dispose: () => {
      clearTimeout(timer);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    },
  };
}

/**
 * The one stderr line of a run that analysed nothing (exit 4). It is printed also with --json and --quiet,
 * so a caller that reads only stderr learns why.
 */
export function reportNotAnalysed(report: AuditReport, json: boolean, suffix = ''): void {
  if (notAnalysed(report)) reportError(EXIT.unreachable, report.crawl.status as ErrorKind, `${notAnalysedReason(report)}${suffix}`, json);
}

/** --ports 80,443,8080 → [80, 443, 8080]; empty when not given. */
export function portsFrom(v: unknown): number[] {
  if (v === undefined) return [];
  const ports = String(v).split(',').map((x) => x.trim()).filter(Boolean).map((x) => num(x, 0, 1, 65535));
  if (!ports.length || ports.some((p) => !Number.isInteger(p))) throw new UsageError(`--ports must be a comma-separated list of ports (got ${String(v)})`);
  return ports;
}

/** Host globs of --allow-host / --deny-host (comma-separated or repeated). */
export function hostGlobs(v: unknown, flag: string): string[] {
  const globs = ((v as string[] | undefined) ?? []).flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean);
  for (const g of globs) if (!/^[a-z0-9*.:[\]-]+$/i.test(g)) throw new UsageError(`${flag} takes a host name or glob such as *.example.com (got ${g})`);
  return globs;
}

/**
 * Network policy from the flags: private targets, host and port lists, and the upstream proxy (`--proxy`, else
 * HTTPS_PROXY / HTTP_PROXY with NO_PROXY; `--proxy none` ignores the environment).
 */
export function policyFrom(v: GlobalFlags['values'], env: Record<string, string | undefined> = process.env): NetPolicy {
  const policy: NetPolicy = {
    ...DEFAULT_POLICY,
    allowPrivate: !!v['allow-private'],
    ports: portsFrom(v['ports']),
    allowHosts: hostGlobs(v['allow-host'], '--allow-host'),
    denyHosts: hostGlobs(v['deny-host'], '--deny-host'),
  };
  try {
    const upstream = proxyFromConfig({ flag: v['proxy'] as string | undefined, resolve: v['proxy-resolve'] as string | undefined, env, policy });
    return upstream ? { ...policy, upstream } : policy;
  } catch (e) {
    if (e instanceof ProxyConfigError) throw new UsageError(e.message);
    throw e;
  }
}

/** --save-html / --screenshots (screenshots need a rendered page, so --render). */
export function artefactsFrom(v: GlobalFlags['values']): { html: boolean; screenshots: boolean } | undefined {
  if (v['screenshots'] && !v['render']) throw new UsageError('--screenshots needs --render (screenshots are taken of the rendered page)');
  return v['save-html'] || v['screenshots'] ? { html: !!v['save-html'], screenshots: !!v['screenshots'] } : undefined;
}

export function crawlOptionsFrom(v: GlobalFlags['values']) {
  return {
    maxPages: num(v['max-pages'], 500, 1, 1_000_000),
    maxDepth: num(v['depth'], 10, 0, 100),
    concurrency: num(v['concurrency'], 4, 1, 32),
    delayMs: num(v['delay'], 250, 0, 60_000),
    timeoutMs: num(v['timeout'], 15000, 1000, 120_000),
    useSitemaps: !v['no-sitemap'],
    include: (v['include'] as string[] | undefined)?.map((r) => new RegExp(r)),
    exclude: (v['exclude'] as string[] | undefined)?.map((r) => new RegExp(r)),
    policy: policyFrom(v),
    artefacts: artefactsFrom(v),
    // monitor also accepts a Search Console property (sc-domain:…) here; only URLs map origins.
    siteUrl: typeof v['site-url'] === 'string' && /^https?:\/\//i.test(v['site-url']) ? v['site-url'] : undefined,
  };
}

/** Local or private-network host (by name or address; no DNS lookup). */
export function isPrivateTarget(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || /\.(localhost|local|test|internal|lan|home\.arpa)$/.test(host)) return true;
  const c = classifyAddress(host);
  return c === 'loopback' || c === 'private' || c === 'link-local';
}

/** On a local or private target without --pre-launch, suggest it (it is never enabled silently). */
export function suggestPreLaunch(v: GlobalFlags['values'], target: string): void {
  if (!v['pre-launch'] && isPrivateTarget(target)) log(v, 'Tip: this looks like a local or staging build. Add --pre-launch to list test-server findings (HTTPS, compression) and deliberate pre-launch states (noindex) separately instead of scoring them.');
}

/** audit/geo: --site-url must be an absolute http(s) URL. */
export function assertSiteUrl(v: GlobalFlags['values']): void {
  const s = v['site-url'];
  if (s !== undefined && (typeof s !== 'string' || !/^https?:\/\/[^/]/i.test(s))) throw new UsageError('--site-url must be an absolute http(s) URL (the public URL of the audited site)');
}

export function log(v: GlobalFlags['values'], ...args: unknown[]): void {
  if (!v['quiet'] && !v['json'] && !progress()) console.error(...args);
}

export function writeReports(store: RunStore, report: AuditReport, kb: KnowledgeBase, formats: string[]): string[] {
  const out: string[] = [];
  annotateReport(report, planOf(store) as never);
  const pr = progress();
  if (pr) {
    phaseProgress('report');
    if (report.crawl.interrupted) pr.interrupted = report.crawl.interrupted;
    const counted = report.findings.filter((f) => f.severity !== 'info' && countsTowardScore(f));
    const bySeverity: Record<string, number> = {};
    for (const f of counted) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    pr.emit({ event: 'finding-summary', runId: report.runId, status: report.crawl.status ?? 'complete', findings: counted.length, bySeverity, affectedUrls: report.affectedUrls ?? 0, score: report.scores.overall });
  }
  for (const f of formats) {
    if (f === 'json') out.push((store.writeJson('report.json', report), store.file('report.json')));
    else if (f === 'md') out.push(store.writeText('report.md', renderMarkdown(report)));
    else if (f === 'html') out.push(store.writeText('report.html', renderHtml(report, kb, loadExtras(store, report))));
    else if (f === 'sarif') out.push(store.writeText('report.sarif', JSON.stringify(renderSarif(report, kb), null, 2)));
    else throw new UsageError(`Unknown format: ${f}`);
  }
  pr?.reports.push(...out.filter((f) => !pr.reports.includes(f)));
  return out;
}

/** --fail-on severity index (checked before crawling, so a typo does not cost a whole crawl). */
export function failOnIndex(failOn: unknown): number {
  const idx = SEVERITY_ORDER.indexOf(String(failOn) as Severity);
  if (idx < 0 || failOn === 'info') throw new UsageError('--fail-on must be critical|high|medium|low');
  return idx;
}

export function failOnExit(report: AuditReport, failOn: unknown): number {
  if (!failOn) return EXIT.ok;
  const idx = failOnIndex(failOn);
  return report.findings.some((f) => SEVERITY_ORDER.indexOf(f.severity) <= idx && countsTowardScore(f)) ? EXIT.failOn : EXIT.ok;
}

/**
 * Short, decision-oriented terminal summary: score, issue groups, top three priorities, automatic fixes,
 * important limits and the path of the interactive report. Details live in the HTML report.
 */
export function printSummary(report: AuditReport, files: string[], v: GlobalFlags['values'], autoRules: string[] = []): void {
  if (v['json']) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }
  const html = files.find((f) => f.endsWith('.html'));
  if (v['open'] && html) openFile(html);
  if (v['quiet']) return;
  console.log(summaryText(report, files, autoRules));
}

export function summaryText(report: AuditReport, files: string[], autoRules: string[] = []): string {
  const issues = report.findings.filter((f) => f.severity !== 'info' && countsTowardScore(f));
  const top = issues.slice().sort((a, b) => (b.priority?.score ?? 0) - (a.priority?.score ?? 0)).slice(0, 3);
  const plan = { fixes: autoRules.map((ruleId) => ({ ruleId })) } as never;
  const auto = issues.filter((f) => remediationOf(f.ruleId, plan) === 'auto');
  const unit = report.mode === 'website' ? 'pages' : 'locations';
  const L = [`\nSearvex — ${report.target}`];
  if (report.crawl.status === 'unreachable') {
    L.push(`Target unreachable: ${report.crawl.error ?? 'network error'}. No page was fetched, so there are no findings and no score.`);
    L.push('Check the URL, DNS, the network or the server, then run the audit again.');
    return withReportFiles(L, files);
  }
  if (report.crawl.status === 'robots-blocked') {
    L.push(`robots.txt blocks every URL (${report.crawl.blocked} skipped): ${report.crawl.error ?? 'robots.txt disallows crawling'}. No page was fetched, so there is no score.`);
    const launch = report.findings.filter((f) => f.context === 'launch-checklist');
    if (launch.length) L.push(`Launch checklist: ${launch.map((f) => f.title).join('; ')} — this staging build blocks all crawlers; change it before going live.`);
    for (const f of report.findings.filter((x) => !x.context)) L.push(`Fix first: [${f.severity}] ${f.title}`);
    const fix = /no findings about the pages\. (.*)$/.exec(report.limitations[0] ?? '')?.[1];
    if (fix) L.push(fix);
    return withReportFiles(L, files);
  }
  if (report.crawl.siteUrl) L.push(`Audited ${new URL(report.crawl.startUrl).origin} as ${report.crawl.siteUrl} (--site-url)`);
  L.push(`Health score ${scoreLabel(report.scores)} (Searvex metric, not a search engine score) · ${report.mode === 'website' ? pagesLabel(report) : `${report.crawl.crawled} routes/pages, ${indexableSummary(report)}`} · ${issues.length} issue types, ${report.affectedUrls ?? 0} affected ${unit}`);
  if (top.length) {
    L.push('Top priorities:');
    top.forEach((f, i) => L.push(`  ${i + 1}. [${f.severity}] ${f.title} — ${f.count} ${f.count === 1 ? unit.replace(/s$/, '') : unit}${f.confidence === 'heuristic' ? ' (heuristic)' : ''}${remediationOf(f.ruleId, plan) === 'auto' ? ' · automatic fix' : ''}`));
  } else L.push('No significant issues found.');
  const launch = report.findings.filter((f) => f.context === 'launch-checklist');
  const env = report.findings.filter((f) => f.context === 'environment');
  if (report.privateRoutes?.length) L.push(`Private routes (login required; metadata and indexability not checked): ${report.privateRoutes.length} — ${report.privateRoutes.slice(0, 4).map((r) => r.route).join(', ')}${report.privateRoutes.length > 4 ? ', …' : ''}`);
  if (launch.length) L.push(`Launch checklist (change before going live, not scored): ${launch.map((f) => `${f.title} (${f.count})`).join('; ')}`);
  if (env.length) L.push(`Environment-dependent (check on the production server, not scored): ${env.map((f) => f.title).join('; ')}`);
  if (auto.length) L.push(`Automatic fixes: ${auto.length} (${auto.map((f) => f.ruleId).join(', ')}) — preview with "searvex optimize ${report.mode === 'repository' ? report.target : '<repo>'}"`);
  const limits: string[] = [];
  if (report.crawl.interrupted) limits.push(`run interrupted ${report.crawl.interrupted === 'signal' ? 'by a signal' : 'at --max-duration'}: partial report (${report.crawl.queuedRemaining} queued; --resume ${report.runId})`);
  else if (report.crawl.truncated) limits.push(`crawl stopped at the page limit (${report.crawl.queuedRemaining} queued)`);
  if (report.scores.notApplicable) limits.push('nothing to audit');
  if (report.mode === 'website') {
    limits.push('search data not measured');
    if (report.findings.some((f) => f.ruleId === 'perf.cwv-unmeasured')) limits.push('Core Web Vitals not measured');
    if (!report.rendered) limits.push('JavaScript not rendered');
  }
  if (limits.length) L.push(`Limits: ${limits.join(' · ')}`);
  return withReportFiles(L, files);
}

/** "12 pages fetched" or "12 pages fetched, 3 blocked by robots.txt" (website mode). */
export function pagesLabel(report: AuditReport): string {
  const fetched = report.crawl.fetched ?? report.crawl.crawled - report.crawl.blocked;
  return `${fetched} pages fetched${report.crawl.blocked ? `, ${report.crawl.blocked} blocked by robots.txt` : ''}`;
}

function withReportFiles(L: string[], files: string[]): string {
  const html = files.find((f) => f.endsWith('.html'));
  if (html) {
    const ws = path.resolve(html, '..', '..', '..', '..');
    L.push(`\nOpen the report: ${pathToFileURL(html).href}`, `  (or run: searvex open ${path.basename(path.dirname(html))}${ws === process.cwd() ? '' : ` --out "${ws}"`})`);
  }
  const others = files.filter((f) => f !== html);
  if (others.length) L.push(`Other files: ${others.map((f) => path.basename(f)).join(', ')} in ${path.dirname(others[0]!)}`);
  return L.join('\n');
}

/** The rule base plus the community packs named with --rules-pack (a bad pack is a usage error). */
export function knowledgeFrom(v: Record<string, unknown>): { kb: KnowledgeBase; packs: RulePack[] } {
  const kb = loadKnowledge();
  const refs = ((v['rules-pack'] as string[] | undefined) ?? []).flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean);
  try {
    const packs = refs.map((r) => loadRulePack(r));
    return { kb: withPacks(kb, packs), packs };
  } catch (e) {
    if (e instanceof RulePackError) throw new UsageError(e.message);
    throw e;
  }
}

/** --lab / --lab-samples: PageSpeed Insights lab runs; a missing key is a usage error, not a silent skip. */
function labOptions(v: Record<string, unknown>): { apiKey: string; samples: number } | undefined {
  if (!v['lab']) {
    if (v['lab-samples'] !== undefined) throw new UsageError('--lab-samples needs --lab');
    return undefined;
  }
  const key = psiKey();
  if (!key) throw new UsageError('--lab needs a PageSpeed Insights API key: run "searvex psi auth", or set SEARVEX_PSI_API_KEY.');
  return { apiKey: key.key, samples: v['lab-samples'] === undefined ? LAB_DEFAULT_SAMPLES : num(v['lab-samples'], LAB_DEFAULT_SAMPLES, 1, 20) };
}

async function commandAudit(flags: GlobalFlags): Promise<number> {
  const { values: v, positionals } = flags;
  const target = positionals[1];
  if (!target) throw new UsageError('audit requires a URL or a repository path');
  if (!/^https?:\/\//i.test(target)) {
    if (fs.existsSync(target)) return commandRepo(flags);
    throw new UsageError(`Not a URL and not an existing path: ${target}`);
  }
  assertSiteUrl(v);
  if (v['fail-on'] !== undefined) failOnIndex(v['fail-on']);
  const lab = labOptions(v);
  const { kb } = knowledgeFrom(v);
  const workspace = path.resolve(String(v['out'] ?? process.cwd()));
  const opts = crawlOptionsFrom(v);
  const stop = interrupter(v);
  let render: Awaited<ReturnType<(typeof import('./crawl/render.js'))['createRenderer']>> | undefined;
  try {
    if (v['render']) render = await (await import('./crawl/render.js')).createRenderer(opts.policy);
    log(v, `Crawling ${target} (max ${opts.maxPages} pages, robots.txt respected)…`);
    suggestPreLaunch(v, target);
    const { report, store } = await auditWebsite(target, {
      onPhase: phaseProgress,
      workspace,
      resumeRunId: v['resume'] as string | undefined,
      kb,
      checkExternal: !!v['check-external'],
      cruxApiKey: cruxKey()?.key,
      ...(lab ? { lab } : {}),
      preLaunch: !!v['pre-launch'],
      compact: !!v['compact'],
      crawl: {
        ...opts,
        render: render?.render,
        stop: stop.signal,
        onProgress: crawlProgress(v),
      },
    });
    if (render) {
      const st = render.stats;
      report.limitations.push(
        `JavaScript rendering: Chromium ${st.sandbox ? 'with' : 'WITHOUT'} its OS sandbox${st.sandbox ? '' : ' (not available on this system)'}, all traffic through Searvex's policy proxy; ${st.blockedRequests + st.proxy.blocked} browser request(s) blocked by the network policy${st.proxy.blockedTargets.length ? ` (${st.proxy.blockedTargets.slice(0, 5).join(', ')})` : ''}${st.proxy.budgetExceeded ? `; ${st.proxy.budgetExceeded} connection(s) cut at the per-page transfer limit` : ''}${st.deadlineExceeded ? `; ${st.deadlineExceeded} page(s) stopped at the hard time limit (scripts kept the browser busy)` : ''}.`,
      );
    }
    assertTargetAllowed(report);
    const files = writeReports(store, report, kb, String(v['format'] ?? 'md,html,json').split(','));
    printSummary(report, files, v);
    reportNotAnalysed(report, !!v['json']);
    reportInterrupted(report, !!v['json']);
    return auditExit(report, v['fail-on']);
  } finally {
    stop.dispose();
    await render?.close();
  }
}

async function commandGeo(flags: GlobalFlags): Promise<number> {
  const { values: v } = flags;
  const target = flags.positionals[1];
  if (!target || !/^https?:\/\//i.test(target)) throw new UsageError('geo requires a URL');
  assertSiteUrl(v);
  const { kb } = knowledgeFrom(v);
  const opts = crawlOptionsFrom({ ...v, 'max-pages': v['max-pages'] ?? '50' });
  suggestPreLaunch(v, target);
  const stop = interrupter(v);
  const { report, store } = await auditWebsite(target, { workspace: path.resolve(String(v['out'] ?? process.cwd())), kb, crawl: { ...opts, stop: stop.signal, onProgress: crawlProgress(v) }, onPhase: phaseProgress, preLaunch: !!v['pre-launch'], compact: !!v['compact'] }).finally(stop.dispose);
  assertTargetAllowed(report);
  reportInterrupted(report, !!v['json']);
  const files = writeReports(store, report, kb, String(v['format'] ?? 'md,html,json').split(','));
  const unreachable = notAnalysed(report);
  reportNotAnalysed(report, !!v['json'], ' — no GEO checks were run.');
  if (v['json']) {
    process.stdout.write(JSON.stringify({ target: report.target, ...(unreachable ? { crawl: { status: report.crawl.status, error: report.crawl.error } } : {}), geo: report.geo, findings: report.findings.filter((f) => f.category === 'geo' || f.ruleId.startsWith('sd.')) }, null, 2) + '\n');
    return unreachable ? EXIT.unreachable : report.crawl.interrupted ? EXIT.interrupted : EXIT.ok;
  }
  if (unreachable) {
    console.error(`Reports:\n${files.map((f) => '  ' + f).join('\n')}`);
    return EXIT.unreachable;
  }
  console.log(`\nGEO / AI search readiness — ${report.target}\n`);
  console.log('Crawler access (homepage):');
  for (const b of report.geo.bots) console.log(`  ${b.allowed ? '✓' : '✗'} ${b.token.padEnd(18)} ${b.operator.padEnd(13)} ${b.purpose}${b.explicit ? '' : ' (inherits *)'}`);
  console.log(`\nllms.txt: ${report.geo.llmsTxt?.present ? 'present' : 'absent'} (informational; Google documents it does not use llms.txt)`);
  console.log(`Content clarity (heuristic): ${report.geo.answerability.average}/100 average`);
  console.log(`AI citations: not measured — ${report.geo.citations.measured ? '' : report.geo.citations.reason}`);
  for (const f of report.findings.filter((x) => x.category === 'geo' && x.severity !== 'info')) console.log(`  [${f.severity}] ${f.title}: ${f.evidence[0]?.observed ?? ''}`);
  console.log(`\nReports:\n${files.map((f) => '  ' + f).join('\n')}`);
  return report.crawl.interrupted ? EXIT.interrupted : EXIT.ok;
}

async function commandRules(flags: GlobalFlags): Promise<number> {
  const v = flags.values;
  const { kb, packs } = knowledgeFrom(v);
  const sub = flags.positionals[1] ?? 'list';
  if (sub === 'list') {
    const rules = [...kb.rules.values()].filter((r) => !v['category'] || r.category === v['category']);
    if (v['json']) return (process.stdout.write(JSON.stringify(rules, null, 2) + '\n'), 0);
    console.log(`Searvex rule base ${kb.version} — ${rules.length} rules\n`);
    for (const r of rules) console.log(`${r.id.padEnd(32)} ${r.severity.padEnd(8)} ${r.confidence.padEnd(12)} ${r.engines.join(',').padEnd(18)} ${r.title}`);
    return 0;
  }
  if (sub === 'show') {
    const id = flags.positionals[2];
    const r = id ? kb.rules.get(id) : undefined;
    if (!r) throw new UsageError(`Unknown rule: ${id ?? '(none)'}`);
    if (v['json']) return (process.stdout.write(JSON.stringify(r, null, 2) + '\n'), 0);
    console.log(`${r.id} — ${r.title}\n`);
    console.log(`Category: ${r.category}   Severity: ${r.severity}   Evidence: ${r.confidence}   Engines: ${r.engines.join(', ')}   Status: ${r.status}\n`);
    console.log(r.description + '\n');
    if (r.appliesWhen) console.log(`Applies when: ${r.appliesWhen}\n`);
    console.log(`Fix: ${r.fix}\nVerify: ${r.verify}`);
    console.log(`Automatic fix: ${r.autofix ? 'available via "searvex optimize" in repository mode (where the correct value is unambiguous)' : 'no — needs human/agent judgement'}`);
    if (r.exceptions) console.log(`Exceptions: ${r.exceptions}`);
    console.log('\nSources:');
    for (const s of r.sources) console.log(`  - ${s.title}\n    ${s.url} (checked ${s.checked}${s.level ? ', ' + s.level : ''})`);
    return 0;
  }
  if (sub === 'validate') {
    // Core rules against their implementations; pack rules against their declarative checks.
    const core = packs.length ? { ...kb, rules: new Map([...kb.rules].filter(([, r]) => !r.pack)) } : kb;
    const issues = [...validateKnowledge(core, { implemented: IMPLEMENTED_RULES }), ...validatePacks(kb, packs)];
    const errors = issues.filter((i) => i.level === 'error');
    for (const i of issues) console.log(`${i.level.toUpperCase().padEnd(7)} ${i.ruleId}: ${i.message}`);
    console.log(`\n${kb.rules.size} rules, ${errors.length} errors, ${issues.length - errors.length} warnings`);
    return errors.length || (v['strict'] && issues.length) ? 1 : 0;
  }
  if (sub === 'check-sources') {
    const file = snapshotFile(defaultKnowledgeDir());
    const previous = readSnapshots(file);
    const results = await checkSources(kb, previous, { policy: policyFrom(v), onProgress: (d, t, u) => log(v, `  [${d}/${t}] ${u}`) });
    if (v['update']) {
      const next = { ...previous };
      // Never overwrite a snapshot with an error page or a bot challenge.
      for (const r of results) if (r.change !== 'broken' && !r.current.challenged) next[r.url] = r.current;
      writeSnapshots(file, next);
    }
    const attention = results.filter((r) => ['broken', 'redirected', 'content-changed', 'date-changed'].includes(r.change));
    if (v['json']) process.stdout.write(JSON.stringify(results.map((r) => ({ url: r.url, change: r.change, detail: r.detail, rules: r.rules })), null, 2) + '\n');
    else {
      const order = ['broken', 'redirected', 'date-changed', 'content-changed', 'unreadable', 'new', 'unchanged'];
      for (const kind of order) {
        const list = results.filter((r) => r.change === kind);
        if (!list.length) continue;
        console.log(`\n${kind.toUpperCase()} (${list.length})`);
        for (const r of list) console.log(`  ${r.url}\n    ${r.detail} — rules: ${r.rules.join(', ')}`);
      }
      console.log(`\n${results.length} sources: ${attention.length} need review${v['update'] ? '; snapshots updated' : ' (run with --update to record this snapshot)'}.`);
      if (attention.length) console.log('Re-read the listed sources, update rule text/severity if guidance changed, then bump each source\'s "checked" date.');
    }
    return attention.length ? 1 : 0;
  }
  throw new UsageError(`Unknown rules subcommand: ${sub}`);
}

async function commandReport(flags: GlobalFlags): Promise<number> {
  const v = flags.values;
  const workspace = path.resolve(String(v['out'] ?? process.cwd()));
  let id = flags.positionals[1] ?? 'latest';
  // "latest" = newest run that has a report (run/optimize summaries do not).
  if (id === 'latest') id = RunStore.list(workspace).filter((r) => fs.existsSync(path.join(workspace, '.searvex', 'runs', r, 'report.json'))).at(-1) ?? '';
  if (!id) throw new UsageError('No stored runs found');
  const store = new RunStore(workspace, id);
  const report = store.readJson<AuditReport>('report.json');
  if (!report) throw new UsageError(`Run ${id} has no report.json`);
  const kb = loadKnowledge();
  const files = writeReports(store, report, kb, String(v['format'] ?? 'md,html').split(','));
  console.log(files.join('\n'));
  return 0;
}

/** searvex prompt: the HTML action center's repair prompt, outside the browser. */
function commandPrompt(flags: GlobalFlags): number {
  const v = flags.values;
  const workspace = path.resolve(String(v['out'] ?? process.cwd()));
  const store = new RunStore(workspace, resolveRun(workspace, flags.positionals[1]));
  const report = store.readJson<AuditReport>('report.json')!;
  const lang = String(v['lang'] ?? 'en');
  if (lang !== 'en' && lang !== 'tr') throw new UsageError('--lang must be en or tr for prompt');
  const format = String(v['format'] ?? 'md');
  if (format !== 'md' && format !== 'json') throw new UsageError('--format must be md or json for prompt');
  const rules = (v['rules'] as string[] | undefined)?.flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean);
  const unknown = rules?.filter((id) => !report.findings.some((f) => f.ruleId === id)) ?? [];
  if (unknown.length) throw new UsageError(`Not a finding of run ${report.runId}: ${unknown.join(', ')}`);
  const input = repairPromptInput(report, loadKnowledge(), loadExtras(store, report), { lang, rules });
  if (!input.items.length) throw new UsageError(`Run ${report.runId} has no issues to repair (pass --rules to choose findings)`);
  const prompt = buildRepairPrompt(input);
  if (format === 'json') process.stdout.write(JSON.stringify({ runId: report.runId, rules: input.items.map((i) => i.ruleId), prompt }, null, 2) + '\n');
  else process.stdout.write(prompt.endsWith('\n') ? prompt : prompt + '\n');
  return EXIT.ok;
}

/** searvex schema: print a published JSON Schema (shipped in the package's schema/ directory). */
function commandSchema(flags: GlobalFlags): number {
  const name = flags.positionals[1] ?? 'report';
  if (!['report', 'events', 'error'].includes(name)) throw new UsageError(`Unknown schema: ${name} (report, events or error)`);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = [path.resolve(here, '..', 'schema', `${name}.schema.json`), path.resolve(here, '..', '..', 'schema', `${name}.schema.json`)].find((f) => fs.existsSync(f));
  if (!file) throw new Error(`schema/${name}.schema.json is missing from this installation`);
  process.stdout.write(fs.readFileSync(file, 'utf8'));
  return EXIT.ok;
}

function commandRuns(flags: GlobalFlags): number {
  const workspace = path.resolve(String(flags.values['out'] ?? process.cwd()));
  for (const id of RunStore.list(workspace)) {
    const meta = new RunStore(workspace, id).readJson<{ startUrl?: string; target?: string; kind?: string }>('meta.json');
    console.log(`${id}  ${meta?.kind ?? ''}  ${meta?.startUrl ?? meta?.target ?? ''}`);
  }
  return 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let flags: GlobalFlags;
  try {
    flags = parse(argv);
  } catch (e) {
    reportError(EXIT.usage, 'usage', (e as Error).message, argv.includes('--json'), HELP_TRAILER);
    return EXIT.usage;
  }
  if (flags.values['version']) return (console.log(SEARVEX_VERSION), 0);
  const cmd = flags.positionals[0];
  if (!cmd || flags.values['help']) return (console.log(HELP), cmd || flags.values['help'] ? EXIT.ok : EXIT.usage);
  const mode = flags.values['progress'];
  if (mode !== undefined && mode !== 'ndjson') {
    reportError(EXIT.usage, 'usage', `--progress must be ndjson (got ${String(mode)})`, !!flags.values['json'], HELP_TRAILER);
    return EXIT.usage;
  }
  if (mode !== 'ndjson') return runCommand(cmd, flags);
  const pr = new Progress();
  setProgress(pr);
  pr.emit({ event: 'start', version: SEARVEX_VERSION, command: cmd, ...(flags.positionals[1] ? { target: flags.positionals[1] } : {}) });
  let exitCode: number = EXIT.runtime;
  try {
    exitCode = await runCommand(cmd, flags);
    return exitCode;
  } finally {
    pr.emit({ event: 'end', exitCode, reports: pr.reports, ...(pr.interrupted ? { interrupted: pr.interrupted } : {}) });
    setProgress(null);
  }
}

async function runCommand(cmd: string, flags: GlobalFlags): Promise<number> {
  try {
    switch (cmd) {
      case 'run':
        return await commandRun(flags);
      case 'ecosystem':
        return await commandEcosystem(flags);
      case 'gsc':
        return await commandGsc(flags);
      case 'bing':
        return await commandBing(flags);
      case 'crux':
        return await commandCrux(flags);
      case 'psi':
        return await commandPsi(flags);
      case 'ga4':
        return await commandGa4(flags);
      case 'yandex':
        return await commandYandex(flags);
      case 'connect':
        return await commandConnect(flags);
      case 'audit':
        return await commandAudit(flags);
      case 'geo':
        return await commandGeo(flags);
      case 'research':
        return await commandResearch(flags);
      case 'optimize':
        return await commandOptimize(flags);
      case 'rollback':
        return await commandRollback(flags);
      case 'monitor':
        return await commandMonitor(flags);
      case 'rules':
        return await commandRules(flags);
      case 'report':
        return await commandReport(flags);
      case 'runs':
        return commandRuns(flags);
      case 'open':
        return commandOpen(flags);
      case 'review':
        return commandReview(flags);
      case 'prompt':
        return commandPrompt(flags);
      case 'schema':
        return commandSchema(flags);
      default:
        throw new UsageError(`Unknown command: ${cmd}`);
    }
  } catch (e) {
    const json = !!flags.values['json'];
    if (e instanceof UsageError) {
      reportError(EXIT.usage, e instanceof PolicyError ? 'policy' : 'usage', e.message, json, HELP_TRAILER);
      return EXIT.usage;
    }
    // One line by default: a stack trace shows absolute install paths and helps only when debugging.
    const message = e instanceof Error ? e.message || e.name : String(e);
    const debug = !!process.env['SEARVEX_DEBUG'] && process.env['SEARVEX_DEBUG'] !== '0';
    reportError(EXIT.runtime, 'runtime', message, json, debug ? String((e as Error).stack ?? e) : 'Run with SEARVEX_DEBUG=1 for details.');
    return EXIT.runtime;
  }
}

// Run when executed directly (not when imported by tests).
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked && (invoked.endsWith('cli.js') || invoked.endsWith('searvex.mjs') || invoked.endsWith(`${path.sep}searvex`))) {
  // Set exitCode instead of calling process.exit(): exit() can truncate large piped stdout (e.g. --json)
  // before it has been flushed.
  main().then((code) => {
    process.exitCode = code;
  });
}

