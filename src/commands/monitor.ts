import path from 'node:path';
import { auditWebsite, type AuditReport } from '../analyze/audit.js';
import { RunStore } from '../crawl/store.js';
import { loadKnowledge } from '../rules/engine.js';
import { md } from '../report/markdown.js';
import { renderMonitorHtml } from '../report/html.js';
import { querySearchConsole, type GscRow } from '../integrations/gsc.js';
import { gscAccessToken } from '../integrations/google-oauth.js';
import { GscImportError, importGscFiles, parseGscTable } from '../integrations/gsc-csv.js';
import { crawlOptionsFrom, log, UsageError, writeReports, type GlobalFlags } from '../cli.js';

export interface FindingDelta {
  ruleId: string;
  title: string;
  severity: string;
  before: number;
  after: number;
}

export interface MonitorDiff {
  target: string;
  baselineRun: string | null;
  currentRun: string;
  scoreBefore: number | null;
  scoreAfter: number;
  newFindings: FindingDelta[];
  resolved: FindingDelta[];
  worsened: FindingDelta[];
  improved: FindingDelta[];
  pagesBefore: number | null;
  pagesAfter: number;
  regression: boolean;
}

export function diffReports(before: AuditReport | null, after: AuditReport, baselineRun: string | null): MonitorDiff {
  const map = (r: AuditReport | null) => new Map((r?.findings ?? []).map((f) => [f.ruleId, f]));
  const b = map(before);
  const a = map(after);
  const d = (id: string): FindingDelta => {
    const f = a.get(id) ?? b.get(id)!;
    return { ruleId: id, title: f.title, severity: f.severity, before: b.get(id)?.count ?? 0, after: a.get(id)?.count ?? 0 };
  };
  const ids = new Set([...a.keys(), ...b.keys()]);
  const all = [...ids].map(d).filter((x) => x.severity !== 'info');
  const newFindings = before ? all.filter((x) => x.before === 0 && x.after > 0) : [];
  const resolved = all.filter((x) => x.before > 0 && x.after === 0);
  const worsened = all.filter((x) => x.before > 0 && x.after > x.before);
  const improved = all.filter((x) => x.after > 0 && x.after < x.before);
  const serious = (x: FindingDelta) => x.severity === 'critical' || x.severity === 'high';
  return {
    target: after.target,
    baselineRun,
    currentRun: after.runId,
    scoreBefore: before?.scores.overall ?? null,
    scoreAfter: after.scores.overall,
    newFindings,
    resolved,
    worsened,
    improved,
    pagesBefore: before?.crawl.crawled ?? null,
    pagesAfter: after.crawl.crawled,
    regression: !!before && (newFindings.some(serious) || worsened.some(serious)),
  };
}

export function renderDiffMarkdown(d: MonitorDiff, gsc?: { rows: GscRow[]; source: string }): string {
  const L = [`# Searvex monitor — ${md(d.target)}`, ''];
  if (!d.baselineRun) L.push('_No previous run for this target: this run is the new baseline._', '');
  else L.push(`Baseline \`${d.baselineRun}\` → current \`${d.currentRun}\``, '', `Health score: ${d.scoreBefore} → **${d.scoreAfter}** · pages: ${d.pagesBefore} → ${d.pagesAfter}`, '');
  const sec = (title: string, xs: FindingDelta[]) => {
    if (!xs.length) return;
    L.push(`## ${title}`, '', ...xs.map((x) => `- [${x.severity}] ${md(x.title)} (\`${x.ruleId}\`): ${x.before} → ${x.after}`), '');
  };
  sec('New issues', d.newFindings);
  sec('Worsened', d.worsened);
  sec('Improved', d.improved);
  sec('Resolved', d.resolved);
  if (d.regression) L.push('**Regression detected:** new or worsened critical/high issues.', '');
  if (gsc) {
    const clicks = gsc.rows.reduce((a, r) => a + r.clicks, 0);
    const impr = gsc.rows.reduce((a, r) => a + r.impressions, 0);
    L.push(`## Search performance (${md(gsc.source)})`, '', `Rows: ${gsc.rows.length} · clicks: ${clicks} · impressions: ${impr} · CTR: ${impr ? ((clicks / impr) * 100).toFixed(2) : '0'}%`, '');
    L.push('| Key | Clicks | Impressions | CTR | Position |', '|---|---|---|---|---|');
    for (const r of gsc.rows.slice(0, 25)) L.push(`| ${md(r.keys.join(' / '))} | ${r.clicks} | ${r.impressions} | ${(r.ctr * 100).toFixed(2)}% | ${r.position.toFixed(1)} |`);
    L.push('');
  } else {
    L.push('_Search performance: not measured (no Search Console token or import provided). Searvex never estimates clicks or impressions._', '');
  }
  return L.join('\n');
}

export function findBaseline(workspace: string, target: string, exclude: string): { id: string; report: AuditReport } | null {
  const runs = RunStore.list(workspace).filter((id) => id !== exclude).reverse();
  for (const id of runs) {
    const r = new RunStore(workspace, id).readJson<AuditReport>('report.json');
    if (r && r.target === target && r.mode === 'website') return { id, report: r };
  }
  return null;
}

export async function commandMonitor(flags: GlobalFlags): Promise<number> {
  const v = flags.values;
  const target = flags.positionals[1];
  if (!target || !/^https?:\/\//i.test(target)) throw new UsageError('monitor requires a URL');
  const kb = loadKnowledge();
  const workspace = path.resolve(String(v['out'] ?? process.cwd()));
  log(v, `Re-auditing ${target}…`);
  const { report, store } = await auditWebsite(target, { workspace, kb, crawl: crawlOptionsFrom(v) });
  writeReports(store, report, kb, ['json', 'md', 'html']);
  const explicit = v['baseline'] as string | undefined;
  const base = explicit
    ? { id: explicit, report: new RunStore(workspace, explicit).readJson<AuditReport>('report.json') }
    : findBaseline(workspace, report.target, store.runId);
  if (explicit && !base?.report) throw new UsageError(`Baseline run ${explicit} has no report.json`);
  const diff = diffReports(base?.report ?? null, report, base?.id ?? null);

  let gsc: { rows: GscRow[]; source: string } | undefined;
  const token = await gscAccessToken();
  const site = (v['site-url'] as string | undefined) ?? process.env['SEARVEX_GSC_SITE'];
  if (token && site) {
    log(v, `Querying Search Console for ${site} (read-only)…`);
    gsc = { rows: await querySearchConsole({ token, siteUrl: site, days: 28, dimensions: ['query'] }), source: `Search Console API, ${site}, last 28 days` };
  }
  for (const file of (v['import'] as string[] | undefined) ?? []) {
    let exp;
    try {
      exp = importGscFiles([file]);
    } catch (e) {
      if (e instanceof GscImportError) throw new UsageError(e.message);
      throw e;
    }
    const table = exp.tables.queries ?? exp.tables.pages;
    if (table?.length) gsc = { rows: table.map((r) => ({ keys: [r.key], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })), source: `imported ${path.basename(file)}` };
    for (const w of exp.warnings) log(v, `warning: ${w}`);
  }
  store.writeJson('monitor.json', { diff, gsc });
  const out = store.writeText('monitor.md', renderDiffMarkdown(diff, gsc));
  store.writeText('monitor.html', renderMonitorHtml(diff));
  if (v['json']) process.stdout.write(JSON.stringify({ diff, gsc }, null, 2) + '\n');
  else console.log(renderDiffMarkdown(diff, gsc) + `\nSaved: ${out}`);
  return diff.regression && v['fail-on'] ? 1 : 0;
}

/** Map one Search Console "Performance" CSV table (queries, pages, countries, devices) to rows. */
export function rowsFromCsv(text: string, fileName = 'export.csv'): GscRow[] {
  const t = parseGscTable(text, fileName);
  return t && t.kind !== 'filters' ? t.rows.map((r) => ({ keys: [r.key], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })) : [];
}
