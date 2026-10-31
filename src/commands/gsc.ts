import path from 'node:path';
import type { AuditReport } from '../analyze/audit.js';
import { analyzeSearchPerformance, rowsToQueryPage, type SearchPerformanceReport } from '../analyze/search-performance.js';
import { RunStore } from '../crawl/store.js';
import { authorize, accessToken, deleteCredential, gscAccessToken, GSC_SCOPE, loadClientFile, OAuthClientFileError, getCredential, revokeToken, saveCredential } from '../integrations/google-oauth.js';
import { defaultCredentialStore } from '../integrations/credentials.js';
import { listSites, querySearchConsole } from '../integrations/gsc.js';
import { GscImportError, importGscFiles, type GscExport } from '../integrations/gsc-csv.js';
import { parseProperty, propertyForExport, PropertyError, selectAuditForProperty, urlInProperty, type SearchProperty, type SelectedAudit } from '../integrations/property.js';
import { getSitePreference, setSitePreference, siteKey, type SearchDataChoice } from '../integrations/preferences.js';
import { md } from '../report/markdown.js';
import { log, num, UsageError, type GlobalFlags } from '../cli.js';

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const dash = (x: number | null | undefined) => (x === null || x === undefined ? '—' : String(x));

const PATTERN_LABEL: Record<string, string> = {
  navigational: 'expected (brand/navigational)',
  hierarchy: 'expected (parent/child pages)',
  dominant: 'one page leads',
  'mixed-intent': '**review: mixed intent**',
  'possible-competition': '**review: possible cannibalisation**',
};

export function renderSearchPerformanceMarkdown(r: SearchPerformanceReport): string {
  const L = [`# Search performance — ${md(r.source)}`, ''];
  const period = r.period.startDate ? `${r.period.startDate} → ${r.period.endDate} (${r.period.days} days)` : `Last ${r.period.days} days`;
  L.push(`${period} · clicks **${r.totals.clicks}** · impressions **${r.totals.impressions}** · CTR ${pct(r.totals.ctr)} · ${r.totals.queries} queries · ${r.totals.pages} pages`, '');
  L.push(`_Verified data for ${r.property ? md(r.property) : 'this property'} (totals: ${r.totals.basis}). Searvex adds no estimates._`, '');
  if (r.audit) L.push(`Joined audit \`${r.audit.runId}\` (${md(r.audit.target)}): ${Math.round(r.audit.coverage * 100)}% of its ${r.audit.pages} crawled pages are inside the property.`, '');
  if (r.granularity === 'separate') L.push('> Imported from a Search Console CSV export: queries and pages are separate tables, so query → page analysis is not available. Connect the API for the full analysis.', '');
  const table = (head: string[], rows: string[][]) => {
    L.push(`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((x) => `| ${x.join(' | ')} |`), '');
  };
  if (r.findingsOnTrafficPages.length) {
    L.push('## Audit issues on pages that get search traffic', '');
    table(['Issue', 'Severity', 'Pages', 'Clicks', 'Impressions'], r.findingsOnTrafficPages.slice(0, 15).map((f) => [`${md(f.title)} \`${f.ruleId}\``, f.severity, String(f.pages), String(f.clicks), String(f.impressions)]));
  }
  L.push('## Striking distance (positions 8–20 with real impressions)', '');
  if (r.strikingDistance.length) table(['Query', 'Page', 'Position', 'Impressions', 'Clicks'], r.strikingDistance.slice(0, 20).map((x) => [md(x.query), x.page ? md(x.page) : '—', String(x.position), String(x.impressions), String(x.clicks)]));
  else L.push('_None above the impression threshold._', '');
  L.push("## Low CTR versus this site's own median at the same position", '');
  if (r.lowCtr.length) table(['Query', 'Page', 'Position', 'Impressions', 'CTR', 'Site median'], r.lowCtr.slice(0, 20).map((x) => [md(x.query), x.page ? md(x.page) : '—', String(x.position), String(x.impressions), pct(x.ctr), pct(x.siteMedianCtr)]));
  else L.push('_None found (or not enough data per position)._', '');
  if (r.intentMix.length) {
    L.push('## Search intent mix (intent inferred from query wording)', '');
    table(['Intent', 'Queries', 'Clicks', 'Impressions', 'CTR'], r.intentMix.map((m) => [m.intent, String(m.queries), String(m.clicks), String(m.impressions), pct(m.ctr)]));
  }
  if (r.intentMismatches.length) {
    L.push('## Intent mismatches (query intent vs. type of the ranking page; inferred)', '');
    table(['Query', 'Query intent', 'Page', 'Page type', 'Impressions', 'Position'], r.intentMismatches.slice(0, 20).map((x) => [md(x.query), `${x.queryIntent} (${x.signals.slice(0, 2).map(md).join(', ')})`, md(x.page), x.pageType, String(x.impressions), String(x.position)]));
  }
  if (r.granularity === 'query-page') {
    L.push('## Queries shared by several pages', '');
    L.push('_Several pages receiving impressions for one query is common and not harmful by itself. Only rows marked "review" are cannibalisation candidates; confirm them over time before merging or retargeting pages._', '');
    if (r.multiPageQueries.length) for (const q of r.multiPageQueries.slice(0, 15)) L.push(`- **${md(q.query)}** (${q.impressions} impressions) — ${PATTERN_LABEL[q.pattern]}: ${q.pages.map((p) => `${md(p.page)} — ${p.impressions} imp, pos ${p.position}`).join('; ')}. ${md(q.reason)}`);
    else L.push('_None._');
    L.push('');
  }
  if (r.topPages.length) {
    L.push(r.granularity === 'query-page' ? '## Page → primary query' : '## Top pages', '');
    table(['Page', 'Clicks', 'Impressions', 'Position', 'Primary query', 'Queries'], r.topPages.slice(0, 25).map((p) => [md(p.page), String(p.clicks), String(p.impressions), String(p.position), p.primaryQuery ? md(p.primaryQuery) : '—', dash(p.queries)]));
  }
  if (r.topQueries.length) {
    L.push('## Top queries', '');
    table(['Query', 'Clicks', 'Impressions', 'CTR', 'Position', 'Pages', 'Intent (inferred)'], r.topQueries.slice(0, 25).map((q) => [md(q.query), String(q.clicks), String(q.impressions), pct(q.ctr), String(q.position), dash(q.pages), q.intent ?? '—']));
  }
  if (r.breakdowns.devices.length) {
    L.push('## Devices', '');
    table(['Device', 'Clicks', 'Impressions', 'CTR', 'Position'], r.breakdowns.devices.map((d) => [md(d.key), String(d.clicks), String(d.impressions), pct(d.ctr), String(Math.round(d.position * 10) / 10)]));
  }
  if (r.breakdowns.countries.length) {
    L.push('## Countries', '');
    table(['Country', 'Clicks', 'Impressions', 'CTR', 'Position'], r.breakdowns.countries.slice(0, 10).map((d) => [md(d.key), String(d.clicks), String(d.impressions), pct(d.ctr), String(Math.round(d.position * 10) / 10)]));
  }
  if (r.noImpressions.length) L.push(`## Indexable pages without impressions (${r.noImpressions.length})`, '', ...r.noImpressions.slice(0, 30).map((u) => `- ${md(u)}`), '');
  if (r.notMeasured.length) L.push('## Not measured', '', ...r.notMeasured.map((n) => `- ${md(n)}`), '');
  L.push('## Notes', '', ...r.notes.map((n) => `- ${md(n)}`), '');
  return L.join('\n');
}

function propertyOrUsage(raw: string, opts?: { anyProtocol?: boolean }): SearchProperty {
  try {
    return parseProperty(raw, opts);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

/** `--audit latest|<runId>` resolved against the property; mismatches become usage errors. */
function resolveAudit(flags: GlobalFlags, workspace: string, property: SearchProperty): SelectedAudit | undefined {
  const ref = flags.values['audit'] as string | undefined;
  if (!ref) return undefined;
  try {
    const sel = selectAuditForProperty(workspace, ref, property);
    log(flags.values, `Joining audit ${sel.runId} (${sel.audit.target}): ${sel.match.reason}`);
    return sel;
  } catch (e) {
    if (e instanceof PropertyError) throw new UsageError(e.message);
    throw e;
  }
}

function attachAudit(report: SearchPerformanceReport, sel: SelectedAudit | undefined): void {
  if (sel) report.audit = { runId: sel.runId, target: sel.audit.target, coverage: Math.round(sel.match.coverage * 1000) / 1000, pages: sel.match.pages };
}

function saveReport(flags: GlobalFlags, workspace: string, kind: string, meta: Record<string, unknown>, report: SearchPerformanceReport): void {
  const v = flags.values;
  const store = new RunStore(workspace, RunStore.newRunId(kind));
  store.writeJson('meta.json', { kind, ...meta, audit: report.audit?.runId, startedAt: new Date().toISOString() });
  store.writeJson('search-performance.json', report);
  const out = store.writeText('search-performance.md', renderSearchPerformanceMarkdown(report));
  if (v['json']) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else if (!v['quiet']) console.log(renderSearchPerformanceMarkdown(report) + `\nSaved: ${out}`);
}

/** Newest website audit in the workspace (for property auto-selection). */
function newestWebsiteAudit(workspace: string): AuditReport | null {
  for (const id of RunStore.list(workspace).reverse()) {
    const a = new RunStore(workspace, id).readJson<AuditReport>('report.json');
    if (a?.mode === 'website') return a;
  }
  return null;
}

/**
 * Verify that the property exists in the user's Search Console account with read access, or pick it
 * automatically when exactly one accessible property covers the newest audit.
 */
async function verifyProperty(token: string, raw: string | undefined, workspace: string): Promise<string> {
  const sites = (await listSites(token)).filter((s) => s.permissionLevel !== 'siteUnverifiedUser');
  const names = sites.map((s) => s.siteUrl);
  if (raw) {
    if (names.includes(raw)) return raw;
    const p = propertyOrUsage(raw);
    const similar = names.filter((n) => {
      try {
        const q = parseProperty(n);
        return p.kind === 'domain' ? q.kind === 'domain' && q.domain === p.domain : urlInProperty(`${p.protocol}//${p.host}${p.path}`, q);
      } catch {
        return false;
      }
    });
    throw new UsageError(`Property ${raw} is not in your Search Console account (or you have no read access).${similar.length ? ` Did you mean: ${similar.join(', ')}?` : names.length ? ` Available: ${names.join(', ')}` : ' No properties are available to this Google account.'}`);
  }
  const audit = newestWebsiteAudit(workspace);
  if (!audit) throw new UsageError(`Pass a property. Available: ${names.join(', ') || '(none)'}`);
  const start = audit.crawl?.startUrl ?? audit.target;
  const matches = names.filter((n) => {
    try {
      return urlInProperty(start, parseProperty(n));
    } catch {
      return false;
    }
  });
  if (matches.length === 1) return matches[0]!;
  throw new UsageError(matches.length ? `Several properties cover ${start}: ${matches.join(', ')}. Pass one explicitly.` : `No accessible property covers ${start}. Available: ${names.join(', ') || '(none)'}`);
}

export async function commandGsc(flags: GlobalFlags): Promise<number> {
  const v = flags.values;
  const sub = flags.positionals[1];
  const workspace = path.resolve(String(v['out'] ?? process.cwd()));
  if (sub === 'auth') {
    if (process.env['CI']) throw new UsageError('gsc auth is interactive (browser consent) and is disabled in CI. Use "gsc import <export.zip>" or SEARVEX_GSC_TOKEN there.');
    const existing = getCredential('gsc');
    if (existing && !v['force']) {
      try {
        await accessToken(existing);
        console.log(`Already authorized (scope: ${existing.scope}, since ${existing.createdAt}). Use --force to authorize again, or "gsc logout" to remove it.`);
        return 0;
      } catch {
        log(v, 'Stored authorization is no longer valid; starting a new authorization.');
      }
    }
    const clientFile = v['client'] as string | undefined;
    if (!clientFile) throw new UsageError('gsc auth requires --client <client_secret.json> (a "Desktop app" OAuth client you create in Google Cloud Console). No Google account access? Use "searvex gsc import <export.zip>" instead.');
    let client;
    try {
      client = loadClientFile(clientFile);
    } catch (e) {
      if (e instanceof OAuthClientFileError) throw new UsageError(e.message);
      throw e;
    }
    const cred = await authorize(client, GSC_SCOPE, (url) => {
      console.log('\nOpen this URL in your browser and approve read-only Search Console access:\n');
      console.log(url + '\n');
      console.log('Waiting for Google to redirect back to http://127.0.0.1 … (Ctrl+C to cancel; times out after 5 minutes)');
    });
    saveCredential('gsc', cred);
    console.log(`Authorized (scope: ${cred.scope}). Refresh token stored in ${defaultCredentialStore().describe()}.`);
    return 0;
  }
  if (sub === 'status') {
    const cred = getCredential('gsc');
    const envToken = !!process.env['SEARVEX_GSC_TOKEN'];
    const status: Record<string, unknown> = { credential: cred ? 'stored' : 'none', envToken, store: defaultCredentialStore().describe() };
    if (cred) {
      status['scope'] = cred.scope;
      status['since'] = cred.createdAt;
      try {
        await accessToken(cred);
        status['valid'] = true;
      } catch (e) {
        status['valid'] = false;
        status['error'] = (e as Error).message;
      }
    }
    if (v['json']) process.stdout.write(JSON.stringify(status, null, 2) + '\n');
    else for (const [k, x] of Object.entries(status)) console.log(`${k}: ${String(x)}`);
    return cred || envToken ? 0 : 1;
  }
  if (sub === 'logout') {
    const cred = getCredential('gsc');
    if (!cred) {
      console.log('No stored Search Console credential.');
      return 0;
    }
    let revoked = false;
    try {
      revoked = await revokeToken(cred.refreshToken);
    } catch (e) {
      log(v, `Could not reach Google to revoke the token (${(e as Error).message}); removing it locally.`);
    }
    deleteCredential('gsc');
    console.log(revoked ? 'Revoked the authorization at Google and removed the stored credential.' : 'Removed the stored credential. Google did not confirm revocation; you can remove "Searvex" access in your Google Account → Security → Third-party connections.');
    return 0;
  }
  if (sub === 'import') {
    const files = flags.positionals.slice(2);
    if (!files.length) throw new UsageError('gsc import requires the Search Console export (ZIP or CSV files): Performance → Export → Download CSV');
    let exp: GscExport;
    try {
      exp = importGscFiles(files);
    } catch (e) {
      if (e instanceof GscImportError) throw new UsageError(e.message);
      throw e;
    }
    for (const w of exp.warnings) log(v, `warning: ${w}`);
    const property = resolveImportProperty(v['property'] as string | undefined, exp);
    const sel = property ? resolveAudit(flags, workspace, property) : undefined;
    if (!property && v['audit']) throw new UsageError('Pass --property (e.g. sc-domain:example.com) to join an audit: the export has no pages table to infer the site from.');
    const days = exp.period.days ?? num(v['days'], 0, 0, 10000);
    const report = analyzeSearchPerformance(
      { queries: exp.tables.queries, pages: exp.tables.pages, dates: exp.tables.dates, countries: exp.tables.countries, devices: exp.tables.devices },
      { days, source: `Search Console CSV export ${exp.files.join(', ')}`, audit: sel?.audit, property, period: exp.period.startDate ? { startDate: exp.period.startDate, endDate: exp.period.endDate } : undefined },
    );
    attachAudit(report, sel);
    report.notes.unshift(...exp.warnings);
    if (exp.searchType) report.notes.push(`Search type: ${exp.searchType}.`);
    if (exp.dateLabel) report.notes.push(`Date range in the export: ${exp.dateLabel}.`);
    if (!exp.period.days) report.notMeasured.push('Exact period: the export has no dates table.');
    saveReport(flags, workspace, 'gsc-import', { target: property?.raw ?? null, files: exp.files, period: exp.period }, report);
    if (property) setSitePreference(property.kind === 'domain' ? property.domain : property.host, { choice: 'csv', property: property.raw });
    return 0;
  }
  const token = await gscAccessToken();
  if (!token) throw new UsageError('No Search Console credential: run "searvex gsc auth --client client_secret.json", set SEARVEX_GSC_TOKEN, or import a CSV export with "searvex gsc import <file>"');
  if (sub === 'sites') {
    const sites = await listSites(token);
    if (v['json']) process.stdout.write(JSON.stringify(sites, null, 2) + '\n');
    else for (const s of sites) console.log(`${s.siteUrl}  (${s.permissionLevel})`);
    return 0;
  }
  if (sub === 'report') {
    const siteUrl = await verifyProperty(token, flags.positionals[2], workspace);
    const property = propertyOrUsage(siteUrl);
    const days = num(v['days'], 28, 1, 480);
    const sel = resolveAudit(flags, workspace, property);
    const rows = await querySearchConsole({ token, siteUrl, days, dimensions: ['query', 'page'], maxRows: num(v['max-rows'], 25000, 1, 100000) });
    const report = analyzeSearchPerformance(rowsToQueryPage(rows), { days, source: `Search Console ${siteUrl}`, audit: sel?.audit, property });
    attachAudit(report, sel);
    saveReport(flags, workspace, 'gsc', { target: siteUrl, days }, report);
    setSitePreference(property.kind === 'domain' ? property.domain : property.host, { choice: 'google', property: siteUrl });
    return 0;
  }
  throw new UsageError('gsc subcommands: auth --client <file> [--force] | status | sites | report [property] [--days 28] [--audit latest|<runId>] | import <export.zip|*.csv> [--property P] [--audit latest] | logout');
}

/** Explicit --property, or the single host seen in the pages table (any protocol, whole host). */
function resolveImportProperty(raw: string | undefined, exp: GscExport): SearchProperty | undefined {
  try {
    return propertyForExport(raw, exp.tables.pages?.map((p) => p.key));
  } catch (e) {
    if (e instanceof PropertyError) throw new UsageError(e.message);
    throw e;
  }
}

/** `searvex bing report <siteUrl>`: same analysis on Bing Webmaster data (API key, read-only). */
export async function commandBing(flags: GlobalFlags): Promise<number> {
  const v = flags.values;
  const sub = flags.positionals[1];
  const apiKey = process.env['SEARVEX_BING_API_KEY'];
  if (sub !== 'report') throw new UsageError('bing subcommands: report <siteUrl> [--days 28] [--audit latest|<runId>] [--max-pages 25]');
  if (!apiKey) throw new UsageError('Set SEARVEX_BING_API_KEY (Bing Webmaster Tools → Settings → API access)');
  const siteUrl = flags.positionals[2];
  if (!siteUrl || !/^https?:\/\//.test(siteUrl)) throw new UsageError('bing report requires the verified site URL, e.g. https://example.com/');
  const property = propertyOrUsage(siteUrl, { anyProtocol: true });
  const days = num(v['days'], 28, 1, 480);
  const workspace = path.resolve(String(v['out'] ?? process.cwd()));
  const sel = resolveAudit(flags, workspace, property);
  const { bingQueryPageRows } = await import('../integrations/bing.js');
  const { rows, pages } = await bingQueryPageRows(siteUrl, apiKey, { days, maxPages: num(v['max-pages'], 25, 1, 200) });
  const report = analyzeSearchPerformance(rows, { days, source: `Bing Webmaster Tools ${siteUrl}`, audit: sel?.audit, property });
  attachAudit(report, sel);
  report.totals.basis = `sum of query × page rows for the top ${pages} pages by clicks (not site totals)`;
  report.notes.push(`Query × page rows come from GetPageQueryStats for the top ${pages} pages by clicks; positions are impression-weighted AvgImpressionPosition.`);
  saveReport(flags, workspace, 'bing', { target: siteUrl, days }, report);
  return 0;
}

/**
 * `searvex connect <url> [--choice google|csv|skip]`: the optional search-data step after an audit.
 * Without --choice it only reports the state and the three options (never starts OAuth by itself), so it is
 * safe in non-interactive environments.
 */
export async function commandConnect(flags: GlobalFlags): Promise<number> {
  const v = flags.values;
  const site = flags.positionals[1];
  if (!site) throw new UsageError('connect requires the website URL, e.g. searvex connect https://example.com');
  const choice = v['choice'] as SearchDataChoice | undefined;
  if (choice && !['google', 'csv', 'skip'].includes(choice)) throw new UsageError('--choice must be google, csv or skip');
  if (choice) setSitePreference(site, { choice, property: v['property'] as string | undefined });
  const cred = getCredential('gsc');
  const state = {
    site: siteKey(site),
    preference: getSitePreference(site),
    googleAuthorized: !!cred || !!process.env['SEARVEX_GSC_TOKEN'],
    nonInteractive: !!process.env['CI'] || !process.stdin.isTTY,
    options: [
      { id: 'google', label: 'Google ile bağlan', command: cred ? `searvex gsc report --audit latest` : `searvex gsc auth --client <Desktop OAuth client JSON>`, needs: cred ? 'nothing (already authorized)' : 'your own Google Cloud "Desktop app" OAuth client (one-time, ~15 min)' },
      { id: 'csv', label: 'CSV içe aktar', command: 'searvex gsc import <export.zip> --audit latest', needs: 'Search Console → Performance → Export → Download CSV' },
      { id: 'skip', label: 'Şimdilik geç', command: `searvex connect ${site} --choice skip`, needs: 'nothing; search metrics stay "Not measured"' },
    ],
  };
  if (v['json']) {
    process.stdout.write(JSON.stringify(state, null, 2) + '\n');
    return 0;
  }
  console.log(`Search data for ${state.site}: ${state.preference ? `${state.preference.choice} (since ${state.preference.updatedAt})` : 'not chosen yet'}`);
  console.log(`Google authorization: ${state.googleAuthorized ? 'available' : 'none'}\n`);
  state.options.forEach((o, i) => console.log(`${i + 1}. ${o.label}\n   ${o.command}\n   needs: ${o.needs}`));
  return 0;
}
