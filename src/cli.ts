#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { auditWebsite, type AuditReport } from './analyze/audit.js';
import type { Severity } from './core/types.js';
import { RunStore } from './crawl/store.js';
import { SEARVEX_VERSION } from './net/fetcher.js';
import { DEFAULT_POLICY } from './net/ssrf.js';
import { renderHtml } from './report/html.js';
import { renderMarkdown } from './report/markdown.js';
import { renderSarif } from './report/sarif.js';
import { defaultKnowledgeDir, loadKnowledge, validateKnowledge, type KnowledgeBase } from './rules/engine.js';
import { checkSources, readSnapshots, snapshotFile, writeSnapshots } from './rules/sources.js';
import { IMPLEMENTED_RULES } from './rules/implemented.js';
import { commandRepo } from './commands/repo.js';
import { commandOptimize, commandRollback } from './commands/optimize.js';
import { commandMonitor } from './commands/monitor.js';
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
                        Google Search Console (read-only): OAuth with your own Desktop client (--client),
                        property check, query/page analysis with a property-matched --audit join;
                        "gsc import <export.zip>" reads a Performance CSV export without any account access
  bing report <siteUrl> Bing Webmaster Tools query/page analysis (SEARVEX_BING_API_KEY, read-only)
  monitor <url>         Re-audit and diff against the previous run (regressions / improvements)
  rules <list|show|validate|check-sources> [id]
                        Inspect/validate the rule base; check-sources re-fetches official sources and
                        reports changed, redirected or broken pages (--update records a new snapshot)
  report <runId|latest>  Re-render a stored report (--format)
  runs                  List stored runs

Common options
  --max-pages <n>       Page limit (default 500)          --depth <n>        Max click depth (default 10)
  --concurrency <n>     Parallel requests (default 4)     --delay <ms>       Per-host delay (default 250)
  --render              Execute JavaScript with Playwright (optional dependency) and compare DOMs
  --include <regex>     Only crawl matching URLs          --exclude <regex>  Skip matching URLs
  --check-external      Check outbound links (HEAD, robots.txt-aware, max 200)
  --no-sitemap          Do not seed from sitemaps         --resume <runId>   Resume an interrupted crawl
  --format <list>       md,html,json,sarif (default md,html,json)
  --out <dir>           Workspace for .searvex/ (default: current directory)
  --fail-on <severity>  Exit 1 if findings at/above severity exist (critical|high|medium|low)
  --allow-private       Allow localhost/private network targets (local dev servers only)
  --site-url <url>      Public URL of a repository's site (canonical/sitemap fixes)
  --lang <tag>          Document language for fixes when the framework has no locale idiom
  --apply / --yes       optimize: write changes (after confirmation) / skip the prompt
  --only <ruleId>       optimize: restrict fixes to a rule (repeatable)
  --competitor <url>    research: competitor site to compare (repeatable, max 10)
  --json                Print the JSON report to stdout
  -q, --quiet           Less output
  -h, --help            Show help

Environment (all optional, read-only integrations)
  SEARVEX_CRUX_API_KEY  Chrome UX Report API key → real Core Web Vitals field data
  SEARVEX_GSC_TOKEN     OAuth access token (webmasters.readonly); alternative to "searvex gsc auth"
  SEARVEX_BING_API_KEY  Bing Webmaster Tools API key → "searvex bing report"
  SEARVEX_GSC_SITE      Search Console property (e.g. sc-domain:example.com)

Searvex is read-only by default. It never publishes content, submits URLs or changes live sites.
`;

export const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export interface GlobalFlags {
  values: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
}

function parse(argv: string[]): GlobalFlags {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
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
      format: { type: 'string' },
      out: { type: 'string' },
      'fail-on': { type: 'string' },
      'allow-private': { type: 'boolean' },
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
      reuse: { type: 'boolean' },
      update: { type: 'boolean' },
      client: { type: 'string' },
      days: { type: 'string' },
      audit: { type: 'string' },
      'max-rows': { type: 'string' },
      competitor: { type: 'string', multiple: true },
      category: { type: 'string' },
      strict: { type: 'boolean' },
      baseline: { type: 'string' },
      import: { type: 'string', multiple: true },
      force: { type: 'boolean' },
      property: { type: 'string' },
      choice: { type: 'string' },
    },
  });
  return { values, positionals };
}

export function num(v: unknown, def: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new UsageError(`Invalid number: ${String(v)} (expected ${min}–${max})`);
  return n;
}

export class UsageError extends Error {}

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
    policy: { ...DEFAULT_POLICY, allowPrivate: !!v['allow-private'] },
  };
}

export function log(v: GlobalFlags['values'], ...args: unknown[]): void {
  if (!v['quiet'] && !v['json']) console.error(...args);
}

export function writeReports(store: RunStore, report: AuditReport, kb: KnowledgeBase, formats: string[]): string[] {
  const out: string[] = [];
  for (const f of formats) {
    if (f === 'json') out.push((store.writeJson('report.json', report), store.file('report.json')));
    else if (f === 'md') out.push(store.writeText('report.md', renderMarkdown(report)));
    else if (f === 'html') out.push(store.writeText('report.html', renderHtml(report, kb)));
    else if (f === 'sarif') out.push(store.writeText('report.sarif', JSON.stringify(renderSarif(report, kb), null, 2)));
    else throw new UsageError(`Unknown format: ${f}`);
  }
  return out;
}

export function failOnExit(report: AuditReport, failOn: unknown): number {
  if (!failOn) return 0;
  const idx = SEVERITY_ORDER.indexOf(String(failOn) as Severity);
  if (idx < 0 || failOn === 'info') throw new UsageError('--fail-on must be critical|high|medium|low');
  return report.findings.some((f) => SEVERITY_ORDER.indexOf(f.severity) <= idx && f.confidence !== 'unmeasurable') ? 1 : 0;
}

export function printSummary(report: AuditReport, files: string[], v: GlobalFlags['values']): void {
  if (v['json']) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }
  if (v['quiet']) return;
  const counts = SEVERITY_ORDER.map((s) => `${s}: ${report.findings.filter((f) => f.severity === s).length}`).join('  ');
  console.log(`\nSearvex audit — ${report.target}`);
  console.log(`Health score ${report.scores.overall}/100 (Searvex summary, not a search engine metric)`);
  console.log(`Pages: ${report.crawl.crawled}${report.crawl.truncated ? ` (limit reached; ${report.crawl.queuedRemaining} queued)` : ''}   Rules: ${report.tool.rulesVersion}`);
  console.log(`Findings by rule — ${counts}`);
  for (const f of report.findings.filter((x) => x.severity !== 'info').slice(0, 12)) {
    console.log(`  [${f.severity.padEnd(8)}] ${f.title} (${f.count})${f.confidence === 'heuristic' ? ' ~heuristic' : ''}`);
  }
  if (files.length) console.log(`\nReports:\n${files.map((f) => '  ' + f).join('\n')}`);
}

async function commandAudit(flags: GlobalFlags): Promise<number> {
  const { values: v, positionals } = flags;
  const target = positionals[1];
  if (!target) throw new UsageError('audit requires a URL or a repository path');
  if (!/^https?:\/\//i.test(target)) {
    if (fs.existsSync(target)) return commandRepo(flags);
    throw new UsageError(`Not a URL and not an existing path: ${target}`);
  }
  const kb = loadKnowledge();
  const workspace = path.resolve(String(v['out'] ?? process.cwd()));
  const opts = crawlOptionsFrom(v);
  const render = v['render'] ? await (await import('./crawl/render.js')).createRenderer(opts.policy) : undefined;
  try {
    log(v, `Crawling ${target} (max ${opts.maxPages} pages, robots.txt respected)…`);
    let last = 0;
    const { report, store } = await auditWebsite(target, {
      workspace,
      resumeRunId: v['resume'] as string | undefined,
      kb,
      checkExternal: !!v['check-external'],
      cruxApiKey: process.env['SEARVEX_CRUX_API_KEY'],
      crawl: {
        ...opts,
        render: render?.render,
        onProgress: (p) => {
          if (p.crawled - last >= 10 || p.crawled === 1) {
            last = p.crawled;
            log(v, `  ${p.crawled} pages · ${p.queued} queued · ${p.status} ${p.url}`);
          }
        },
      },
    });
    const files = writeReports(store, report, kb, String(v['format'] ?? 'md,html,json').split(','));
    printSummary(report, files, v);
    return failOnExit(report, v['fail-on']);
  } finally {
    await render?.close();
  }
}

async function commandGeo(flags: GlobalFlags): Promise<number> {
  const { values: v } = flags;
  const target = flags.positionals[1];
  if (!target || !/^https?:\/\//i.test(target)) throw new UsageError('geo requires a URL');
  const kb = loadKnowledge();
  const opts = crawlOptionsFrom({ ...v, 'max-pages': v['max-pages'] ?? '50' });
  const { report, store } = await auditWebsite(target, { workspace: path.resolve(String(v['out'] ?? process.cwd())), kb, crawl: opts });
  const files = writeReports(store, report, kb, String(v['format'] ?? 'md,html,json').split(','));
  if (v['json']) {
    process.stdout.write(JSON.stringify({ target: report.target, geo: report.geo, findings: report.findings.filter((f) => f.category === 'geo' || f.ruleId.startsWith('sd.')) }, null, 2) + '\n');
    return 0;
  }
  console.log(`\nGEO / AI search readiness — ${report.target}\n`);
  console.log('Crawler access (homepage):');
  for (const b of report.geo.bots) console.log(`  ${b.allowed ? '✓' : '✗'} ${b.token.padEnd(18)} ${b.operator.padEnd(13)} ${b.purpose}${b.explicit ? '' : ' (inherits *)'}`);
  console.log(`\nllms.txt: ${report.geo.llmsTxt?.present ? 'present' : 'absent'} (informational; Google documents it does not use llms.txt)`);
  console.log(`Content clarity (heuristic): ${report.geo.answerability.average}/100 average`);
  console.log(`AI citations: not measured — ${report.geo.citations.measured ? '' : report.geo.citations.reason}`);
  for (const f of report.findings.filter((x) => x.category === 'geo' && x.severity !== 'info')) console.log(`  [${f.severity}] ${f.title}: ${f.evidence[0]?.observed ?? ''}`);
  console.log(`\nReports:\n${files.map((f) => '  ' + f).join('\n')}`);
  return 0;
}

async function commandRules(flags: GlobalFlags): Promise<number> {
  const kb = loadKnowledge();
  const sub = flags.positionals[1] ?? 'list';
  const v = flags.values;
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
    const issues = validateKnowledge(kb, { implemented: IMPLEMENTED_RULES });
    const errors = issues.filter((i) => i.level === 'error');
    for (const i of issues) console.log(`${i.level.toUpperCase().padEnd(7)} ${i.ruleId}: ${i.message}`);
    console.log(`\n${kb.rules.size} rules, ${errors.length} errors, ${issues.length - errors.length} warnings`);
    return errors.length || (v['strict'] && issues.length) ? 1 : 0;
  }
  if (sub === 'check-sources') {
    const file = snapshotFile(defaultKnowledgeDir());
    const previous = readSnapshots(file);
    const results = await checkSources(kb, previous, { onProgress: (d, t, u) => log(v, `  [${d}/${t}] ${u}`) });
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
    console.error(`searvex: ${(e as Error).message}\nRun "searvex --help" for usage.`);
    return 2;
  }
  if (flags.values['version']) return (console.log(SEARVEX_VERSION), 0);
  const cmd = flags.positionals[0];
  if (!cmd || flags.values['help']) return (console.log(HELP), cmd ? 0 : flags.values['help'] ? 0 : 2);
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
      default:
        throw new UsageError(`Unknown command: ${cmd}`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`searvex: ${e.message}`);
      return 2;
    }
    console.error(`searvex: ${(e as Error).stack ?? e}`);
    return 2;
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

