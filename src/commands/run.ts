import { cruxKey } from './crux.js';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeCrawl, auditWebsite, scoreLabel, type AuditReport } from '../analyze/audit.js';
import { crawl } from '../crawl/crawler.js';
import { RunStore } from '../crawl/store.js';
import { unifiedDiff } from '../optimize/diff.js';
import { planFixes, type FixPlan } from '../optimize/fixes.js';
import { auditRepository } from '../repo/audit.js';
import { loadKnowledge } from '../rules/engine.js';
import { md, renderMarkdown } from '../report/markdown.js';
import { crawlOptionsFrom, failOnExit, log, num, UsageError, writeReports, type GlobalFlags } from '../cli.js';
import { diffReports, findBaseline, renderDiffMarkdown, type MonitorDiff } from './monitor.js';
import { computeGaps, profile, renderResearchMarkdown, type ResearchReport } from './research.js';
import { renderPlan } from './optimize.js';
import { getSitePreference, type SitePreference } from '../integrations/preferences.js';
import { getCredential } from '../integrations/google-oauth.js';
import { renderHtml } from '../report/html.js';
import { writeContext } from '../report/extras.js';
import { summaryText } from '../cli.js';
import { openFile } from './review.js';

/**
 * `searvex run`: the full workflow in a fixed order, sharing one crawl.
 *   1. Website audit (technical, structured data, content, inventory)
 *   2. GEO / AI-search readiness (from the same crawl)
 *   3. Change since the previous run of the same site (monitor diff)
 *   4. Competitor research (only with --competitor)
 *   5. Repository audit (when a path is given)
 *   6. Fix plan for the repository — dry run only; applying stays a separate, approved step
 */
export interface RunSummary {
  website?: { report: AuditReport; runId: string; files: string[] };
  diff?: MonitorDiff;
  research?: ResearchReport;
  repository?: { report: AuditReport; framework: string };
  plan?: FixPlan;
  /** Optional search performance data: never fetched by `run`; reported as not measured with how to add it. */
  searchData?: { measured: false; preference: SitePreference | null; googleAuthorized: boolean };
  steps: Array<{ step: number; name: string; status: 'done' | 'skipped'; note: string }>;
  /** Interactive HTML of the repository audit (written into the run directory). */
  repositoryHtml?: string;
}

const top = (r: AuditReport, n = 5) => r.findings.filter((f) => f.severity !== 'info').slice(0, n);

export function renderRunSummary(s: RunSummary): string {
  const L: string[] = ['# Searvex run summary', ''];
  L.push('| Step | Status | Note |', '|---|---|---|');
  for (const st of s.steps) L.push(`| ${st.step}. ${st.name} | ${st.status === 'done' ? '✅' : '⏭️ skipped'} | ${md(st.note)} |`);
  L.push('');
  if (s.website) {
    const r = s.website.report;
    L.push('## 1. Website audit', '', `${md(r.target)} — health score **${scoreLabel(r.scores)}**, ${r.crawl.crawled} pages${r.crawl.truncated ? ' (page limit reached)' : ''}, site type (heuristic): ${md(r.inventory.businessModel.label)}.`, '');
    for (const f of top(r)) L.push(`- [${f.severity}] ${md(f.title)} — ${f.count} × (\`${f.ruleId}\`)`);
    L.push('', `Interactive report: \`.searvex/runs/${s.website.runId}/report.html\` (details: \`report.md\`)`, '');
    L.push('## 2. GEO / AI search readiness', '');
    const blocked = r.geo.bots.filter((b) => !b.allowed);
    L.push(`- Blocked crawlers: ${blocked.length ? blocked.map((b) => `${b.token} (${b.purpose})`).join(', ') : 'none'}`);
    L.push(`- Content clarity (heuristic): ${r.geo.answerability.average}/100 · AI citations: not measured`);
    for (const f of r.findings.filter((x) => x.category === 'geo' && x.severity !== 'info')) L.push(`- [${f.severity}] ${md(f.title)}`);
    L.push('');
  }
  if (s.website && s.searchData) {
    const sd = s.searchData;
    L.push('## Search performance data', '');
    L.push('- Clicks, impressions, queries and positions: **Not measured** in this run (no Search Console or Bing data). Searvex does not estimate them.');
    if (sd.preference?.choice === 'skip') L.push(`- Skipped by choice on ${sd.preference.updatedAt.slice(0, 10)}. Change it any time: \`searvex connect ${md(s.website.report.target)}\`.`);
    else if (sd.googleAuthorized) L.push('- Google authorization available: `searvex gsc report --audit latest` adds verified Search Console data.');
    else L.push(`- Optional: \`searvex connect ${md(s.website.report.target)}\` — Google ile bağlan · CSV içe aktar · Şimdilik geç.`);
    L.push('');
  }
  if (s.diff) L.push('## 3. Change since previous run', '', renderDiffMarkdown(s.diff).split('\n').slice(2).join('\n'), '');
  if (s.research) L.push('## 4. Competitor research', '', renderResearchMarkdown(s.research).split('\n').slice(2).join('\n'), '');
  if (s.repository) {
    L.push('## 5. Repository audit', '', `Framework: ${s.repository.framework} — health score **${scoreLabel(s.repository.report.scores)}**.`, '');
    for (const f of top(s.repository.report)) L.push(`- [${f.severity}] ${md(f.title)} — ${f.count} × (\`${f.ruleId}\`)`);
    L.push('');
  }
  if (s.plan) {
    L.push('## 6. Fix plan (dry run — nothing was changed)', '', '```', renderPlan(s.plan), '```', '');
  }
  L.push('## Next steps', '');
  if (s.plan?.fixes.length) L.push('- Review `plan.patch`, then apply with `searvex optimize <path> --apply` (verified, reversible).');
  if (s.plan?.tasks.length) L.push('- Draft the judgement tasks (titles, descriptions, alt text…) with your agent and review them.');
  if (s.website && !s.research) L.push('- Add competitors (`--competitor <url>`) for content-gap research.');
  if (s.website) L.push('- Re-run `searvex run` after deploying changes: step 3 will show what improved or regressed.');
  return L.join('\n') + '\n';
}

export async function commandRun(flags: GlobalFlags): Promise<number> {
  const v = flags.values;
  const targets = flags.positionals.slice(1);
  const url = targets.find((t) => /^https?:\/\//i.test(t));
  const repo = targets.find((t) => !/^https?:\/\//i.test(t));
  if (!url && !repo) throw new UsageError('run requires a URL, a repository path, or both (e.g. searvex run https://example.com ./site)');
  if (repo && !(fs.existsSync(repo) && fs.statSync(repo).isDirectory())) throw new UsageError(`Not a directory: ${repo}`);
  const competitors = (v['competitor'] as string[] | undefined) ?? [];
  if (competitors.length > 10) throw new UsageError('At most 10 --competitor URLs');
  if (competitors.length && !url) throw new UsageError('--competitor requires a website URL');

  const kb = loadKnowledge();
  const workspace = path.resolve(String(v['out'] ?? (repo ?? process.cwd())));
  const opts = crawlOptionsFrom(v);
  const summary: RunSummary = { steps: [] };
  const step = (n: number, name: string, status: 'done' | 'skipped', note: string) => {
    summary.steps.push({ step: n, name, status, note });
    log(v, `${status === 'done' ? '✓' : '·'} ${n}. ${name} — ${note}`);
  };

  // 1–3: website
  if (url) {
    log(v, `1. Auditing ${url} (max ${opts.maxPages} pages)…`);
    const { report, store } = await auditWebsite(url, { workspace, kb, crawl: opts, checkExternal: !!v['check-external'], cruxApiKey: cruxKey()?.key });
    const files = writeReports(store, report, kb, ['json', 'md', 'html']);
    summary.website = { report, runId: store.runId, files };
    summary.searchData = { measured: false, preference: getSitePreference(url), googleAuthorized: !!getCredential('gsc') || !!process.env['SEARVEX_GSC_TOKEN'] };
    step(1, 'Website audit', 'done', `${report.crawl.crawled} pages, score ${report.scores.overall}/100`);
    step(2, 'GEO / AI search', 'done', `${report.geo.bots.filter((b) => !b.allowed).length} crawler(s) blocked; citations not measured`);
    const base = findBaseline(workspace, report.target, store.runId);
    if (base) {
      summary.diff = diffReports(base.report, report, base.id);
      step(3, 'Change since previous run', 'done', `${summary.diff.newFindings.length} new, ${summary.diff.resolved.length} resolved${summary.diff.regression ? ' — regression' : ''}`);
    } else step(3, 'Change since previous run', 'skipped', 'first run for this site: saved as baseline');

    if (competitors.length) {
      const perSite = num(v['max-pages'], 100, 1, 100000);
      const compReports: AuditReport[] = [];
      for (const c of competitors) {
        log(v, `4. Crawling competitor ${c} (max ${perSite} pages)…`);
        compReports.push(await analyzeCrawl(await crawl(c, { ...opts, maxPages: perSite }), kb, { ...opts, probes: false }));
      }
      const allTerms = new Set(report.content.pageTerms.flatMap((p) => p.terms).concat(report.content.topTerms.map((t) => t.term)));
      summary.research = {
        target: profile(report),
        competitors: compReports.map(profile),
        gaps: computeGaps(profile(report), compReports.map(profile), allTerms),
        limitations: ['Topic gaps compare on-page term statistics of crawled pages; they show coverage differences, not search demand.'],
      };
      step(4, 'Competitor research', 'done', `${competitors.length} competitor(s), ${summary.research.gaps.topics.length} topic gaps`);
    } else step(4, 'Competitor research', 'skipped', 'no --competitor given');
  } else {
    step(1, 'Website audit', 'skipped', 'no URL given');
    step(2, 'GEO / AI search', 'skipped', 'no URL given');
    step(3, 'Change since previous run', 'skipped', 'no URL given');
    step(4, 'Competitor research', 'skipped', 'no URL given');
  }

  // 5–6: repository
  if (repo) {
    const root = fs.realpathSync(repo);
    const siteUrl = (v['site-url'] as string | undefined) ?? (url ? new URL(url).origin : undefined);
    log(v, `5. Auditing repository ${root}…`);
    const ra = auditRepository(root, { siteUrl, kb });
    summary.repository = { report: ra.report, framework: ra.scan.apps.map((a) => a.framework + (a.appRoot === '.' ? '' : '@' + a.appRoot)).join(', ') };
    step(5, 'Repository audit', 'done', `${summary.repository.framework}, score ${scoreLabel(ra.report.scores)}`);
    summary.plan = planFixes(ra.report, ra.scan, { siteUrl, lang: v['lang'] as string | undefined });
    step(6, 'Fix plan (dry run)', 'done', `${summary.plan.fixes.length} automatic fix(es), ${summary.plan.tasks.length} task(s); nothing applied`);
    // The website action center now knows the repository: repair prompts target it and real patches count as automatic.
    if (summary.website) {
      const ws = new RunStore(workspace, summary.website.runId);
      writeContext(ws, { repository: { path: root, framework: summary.repository.framework, siteUrl, lang: v['lang'] as string | undefined }, autoRules: [...new Set(summary.plan.fixes.map((f) => f.ruleId))] });
      writeReports(ws, summary.website.report, kb, ['html']);
    }
  } else {
    step(5, 'Repository audit', 'skipped', 'no repository path given');
    step(6, 'Fix plan (dry run)', 'skipped', 'no repository path given');
  }

  const store = new RunStore(workspace, RunStore.newRunId('run'));
  store.writeJson('meta.json', { kind: 'run', target: url ?? repo, repo, competitors, startedAt: new Date().toISOString() });
  store.writeJson('summary.json', {
    steps: summary.steps,
    websiteRun: summary.website?.runId,
    searchData: summary.searchData,
    diff: summary.diff,
    research: summary.research,
    repository: summary.repository && { framework: summary.repository.framework, report: summary.repository.report },
    plan: summary.plan && { ...summary.plan, files: summary.plan.files.map((f) => ({ path: f.path, action: f.action })), fixes: summary.plan.fixes.map((f) => ({ ...f, changes: f.changes.map((c) => ({ path: c.path, action: c.action })) })) },
  });
  if (summary.plan) store.writeText('plan.patch', summary.plan.files.map((c) => unifiedDiff(c.path, c.before, c.after)).join('\n') + '\n');
  if (summary.repository) {
    const rr = summary.repository.report;
    rr.runId = store.runId;
    store.writeText('repository-report.md', renderMarkdown(rr));
    store.writeJson('repository-report.json', rr);
    summary.repositoryHtml = store.writeText('repository-report.html', renderHtml(rr, kb, { repository: { path: rr.target, framework: summary.repository.framework, siteUrl: (v['site-url'] as string | undefined) ?? (url ? new URL(url).origin : undefined), lang: v['lang'] as string | undefined }, plan: summary.plan }));
  }
  const out = store.writeText('summary.md', renderRunSummary(summary));
  if (v['json']) process.stdout.write(JSON.stringify(store.readJson('summary.json'), null, 2) + '\n');
  else if (!v['quiet']) {
    const auto = summary.plan ? [...new Set(summary.plan.fixes.map((f) => f.ruleId))] : [];
    if (summary.website) console.log(summaryText(summary.website.report, summary.website.files, auto));
    if (summary.repository) console.log(summaryText(summary.repository.report, [summary.repositoryHtml!], auto));
    if (summary.plan?.fixes.length) console.log(`\nFix plan (dry run, nothing changed): ${summary.plan.fixes.length} automatic fix(es) in ${store.file('plan.patch')}`);
    console.log(`Workflow summary: ${out}`);
  }
  if (v['open']) {
    const html = summary.website?.files.find((f) => f.endsWith('.html')) ?? summary.repositoryHtml;
    if (html) openFile(html);
  }

  const codes = [summary.website && failOnExit(summary.website.report, v['fail-on']), summary.repository && failOnExit(summary.repository.report, v['fail-on'])];
  return codes.some((c) => c === 1) ? 1 : 0;
}
