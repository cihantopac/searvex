import path from 'node:path';
import type { AuditReport } from '../analyze/audit.js';
import { analyzeSearchPerformance, rowsToQueryPage, type SearchPerformanceReport } from '../analyze/search-performance.js';
import { RunStore } from '../crawl/store.js';
import { authorize, deleteCredential, gscAccessToken, GSC_SCOPE, loadClientFile, saveCredential } from '../integrations/google-oauth.js';
import { listSites, querySearchConsole } from '../integrations/gsc.js';
import { md } from '../report/markdown.js';
import { num, UsageError, type GlobalFlags } from '../cli.js';

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function renderSearchPerformanceMarkdown(r: SearchPerformanceReport): string {
  const L = [`# Search performance — ${md(r.source)}`, ''];
  L.push(`Last ${r.period.days} days · clicks **${r.totals.clicks}** · impressions **${r.totals.impressions}** · CTR ${pct(r.totals.ctr)} · ${r.totals.queries} queries · ${r.totals.pages} pages`, '');
  L.push('_All figures are verified Search Console data for this property. Searvex adds no estimates._', '');
  const table = (head: string[], rows: string[][]) => {
    L.push(`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`), '');
  };
  if (r.findingsOnTrafficPages.length) {
    L.push('## Audit issues on pages that get search traffic', '');
    table(['Issue', 'Severity', 'Pages', 'Clicks', 'Impressions'], r.findingsOnTrafficPages.slice(0, 15).map((f) => [`${md(f.title)} \`${f.ruleId}\``, f.severity, String(f.pages), String(f.clicks), String(f.impressions)]));
  }
  L.push('## Striking distance (positions 8–20 with real impressions)', '');
  if (r.strikingDistance.length) table(['Query', 'Page', 'Position', 'Impressions', 'Clicks'], r.strikingDistance.slice(0, 20).map((x) => [md(x.query), md(x.page), String(x.position), String(x.impressions), String(x.clicks)]));
  else L.push('_None above the impression threshold._', '');
  L.push('## Low CTR versus this site\'s own median at the same position', '');
  if (r.lowCtr.length) table(['Query', 'Page', 'Position', 'Impressions', 'CTR', 'Site median'], r.lowCtr.slice(0, 20).map((x) => [md(x.query), md(x.page), String(x.position), String(x.impressions), pct(x.ctr), pct(x.siteMedianCtr)]));
  else L.push('_None found (or not enough data per position)._', '');
  L.push('## Queries shared by several pages (data-verified cannibalisation)', '');
  if (r.multiPageQueries.length) for (const q of r.multiPageQueries.slice(0, 15)) L.push(`- **${md(q.query)}** (${q.impressions} impressions): ${q.pages.map((p) => `${md(p.page)} — ${p.impressions} imp, pos ${p.position}`).join('; ')}`);
  else L.push('_None._');
  L.push('', '## Page → primary query', '');
  table(['Page', 'Clicks', 'Impressions', 'Position', 'Primary query', 'Queries'], r.topPages.slice(0, 25).map((p) => [md(p.page), String(p.clicks), String(p.impressions), String(p.position), md(p.primaryQuery), String(p.queries)]));
  L.push('## Top queries', '');
  table(['Query', 'Clicks', 'Impressions', 'CTR', 'Position', 'Pages'], r.topQueries.slice(0, 25).map((q) => [md(q.query), String(q.clicks), String(q.impressions), pct(q.ctr), String(q.position), String(q.pages)]));
  if (r.noImpressions.length) L.push(`## Indexable pages without impressions (${r.noImpressions.length})`, '', ...r.noImpressions.slice(0, 30).map((u) => `- ${md(u)}`), '');
  L.push('## Notes', '', ...r.notes.map((n) => `- ${md(n)}`), '');
  return L.join('\n');
}

export async function commandGsc(flags: GlobalFlags): Promise<number> {
  const v = flags.values;
  const sub = flags.positionals[1];
  if (sub === 'auth') {
    const clientFile = v['client'] as string | undefined;
    if (!clientFile) throw new UsageError('gsc auth requires --client <client_secret.json> (a "Desktop app" OAuth client from Google Cloud Console)');
    const client = loadClientFile(clientFile);
    const cred = await authorize(client, GSC_SCOPE, (url) => {
      console.log('\nOpen this URL in your browser and approve read-only Search Console access:\n');
      console.log(url + '\n');
      console.log('Waiting for Google to redirect back to http://127.0.0.1 …');
    });
    const file = saveCredential('gsc', cred);
    console.log(`Authorized (scope: ${cred.scope}). Refresh token stored in ${file} (permissions 0600).`);
    return 0;
  }
  if (sub === 'logout') {
    console.log(deleteCredential('gsc') ? 'Removed stored Search Console credential.' : 'No stored Search Console credential.');
    return 0;
  }
  const token = await gscAccessToken();
  if (!token) throw new UsageError('No Search Console credential: run "searvex gsc auth --client client_secret.json" or set SEARVEX_GSC_TOKEN');
  if (sub === 'sites') {
    const sites = await listSites(token);
    if (v['json']) process.stdout.write(JSON.stringify(sites, null, 2) + '\n');
    else for (const s of sites) console.log(`${s.siteUrl}  (${s.permissionLevel})`);
    return 0;
  }
  if (sub === 'report') {
    const siteUrl = flags.positionals[2];
    if (!siteUrl) throw new UsageError('gsc report requires a property, e.g. sc-domain:example.com or https://example.com/');
    const days = num(v['days'], 28, 1, 480);
    const workspace = path.resolve(String(v['out'] ?? process.cwd()));
    let audit: AuditReport | undefined;
    const auditRef = v['audit'] as string | undefined;
    if (auditRef) {
      const id = auditRef === 'latest' ? RunStore.list(workspace).filter((r) => new RunStore(workspace, r).readJson<AuditReport>('report.json')?.mode === 'website').at(-1) : auditRef;
      audit = id ? new RunStore(workspace, id).readJson<AuditReport>('report.json') ?? undefined : undefined;
      if (!audit) throw new UsageError(`No website audit report found for --audit ${auditRef}`);
    }
    const rows = await querySearchConsole({ token, siteUrl, days, dimensions: ['query', 'page'], maxRows: num(v['max-rows'], 25000, 1, 100000) });
    const report = analyzeSearchPerformance(rowsToQueryPage(rows), { days, source: `Search Console ${siteUrl}`, audit });
    const store = new RunStore(workspace, RunStore.newRunId('gsc'));
    store.writeJson('meta.json', { kind: 'gsc', target: siteUrl, days, audit: audit?.runId, startedAt: new Date().toISOString() });
    store.writeJson('search-performance.json', report);
    const out = store.writeText('search-performance.md', renderSearchPerformanceMarkdown(report));
    if (v['json']) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else if (!v['quiet']) console.log(renderSearchPerformanceMarkdown(report) + `\nSaved: ${out}`);
    return 0;
  }
  throw new UsageError('gsc subcommands: auth --client <file> | sites | report <property> [--days 28] [--audit latest|<runId>] | logout');
}
