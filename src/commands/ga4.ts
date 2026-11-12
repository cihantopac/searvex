import type { AuditReport } from '../analyze/audit.js';
import { normalizeUrl } from '../core/url.js';
import { RunStore } from '../crawl/store.js';
import { defaultCredentialStore } from '../integrations/credentials.js';
import { GA4_SCOPE, ga4LandingPages, listGa4Properties, type Ga4LandingRow } from '../integrations/ga4.js';
import { accessToken, authorize, deleteCredential, getCredential, loadClientFile, OAuthClientFileError, revokeToken, saveCredential } from '../integrations/google-oauth.js';
import { md } from '../report/markdown.js';
import { log, num, UsageError, type GlobalFlags } from '../cli.js';
import { openBrowser } from './gsc.js';
import path from 'node:path';

/** GA4 organic landing pages joined to a website audit (plan F4). */
export interface Ga4Report {
  source: string;
  propertyId: string;
  period: { days: number; startDate: string; endDate: string };
  /** `rowCount` of the API: landing pages with organic sessions (rows beyond `--max-rows` are not listed). */
  landingPages: number;
  totals: { sessions: number; engagedSessions: number; keyEvents: number };
  pages: Array<{ url: string; sessions: number; engagedSessions: number; keyEvents: number }>;
  audit?: {
    runId: string;
    target: string;
    host: string;
    /** Landing pages on the audit's host that are in the crawl, with the audit's open issues on them. */
    issuesOnTrafficPages: Array<{ url: string; sessions: number; keyEvents: number; issues: string[] }>;
    /** Crawled indexable pages without organic sessions in GA4 for the period. */
    indexableWithoutSessions: number;
    indexablePages: number;
  };
  notes: string[];
}

/** Access token for the stored "ga4" credential. */
async function ga4Token(): Promise<string> {
  if (process.env['SEARVEX_GA4_TOKEN']) return process.env['SEARVEX_GA4_TOKEN'];
  const cred = getCredential('ga4');
  if (!cred) throw new UsageError('No Google Analytics authorization: run "searvex ga4 auth --client <client_secret.json>" (or set SEARVEX_GA4_TOKEN).');
  return accessToken(cred);
}

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return '';
  }
};
/** Same site for GA4 hostName: exact host or its www / non-www twin. */
const sameHost = (a: string, b: string) => a.replace(/^www\./, '') === b.replace(/^www\./, '');

function newestWebsiteAudit(workspace: string, ref: string): { runId: string; audit: AuditReport } {
  const ids = ref === 'latest' ? [...RunStore.list(workspace)].reverse() : [ref];
  for (const id of ids) {
    const audit = new RunStore(workspace, id).readJson<AuditReport>('report.json');
    if (audit?.mode === 'website') return { runId: id, audit };
  }
  throw new UsageError(ref === 'latest' ? `No website audit in ${workspace}. Run "searvex audit <url>" first.` : `No website audit report found for --audit ${ref}`);
}

export function buildGa4Report(rows: Ga4LandingRow[], meta: { propertyId: string; days: number; startDate: string; endDate: string; rowCount: number }, sel?: { runId: string; audit: AuditReport }): Ga4Report {
  const sum = (k: 'sessions' | 'engagedSessions' | 'keyEvents', rs: Ga4LandingRow[]) => rs.reduce((a, r) => a + r[k], 0);
  const report: Ga4Report = {
    source: `Google Analytics 4 property ${meta.propertyId} (Organic Search sessions)`,
    propertyId: meta.propertyId,
    period: { days: meta.days, startDate: meta.startDate, endDate: meta.endDate },
    landingPages: meta.rowCount,
    totals: { sessions: sum('sessions', rows), engagedSessions: sum('engagedSessions', rows), keyEvents: sum('keyEvents', rows) },
    pages: rows.map((r) => ({ url: `https://${r.host}${r.path.startsWith('/') ? r.path : `/${r.path}`}`, sessions: r.sessions, engagedSessions: r.engagedSessions, keyEvents: r.keyEvents })),
    notes: [
      'Sessions are GA4 sessions whose default channel group is "Organic Search" (all search engines). They count visits that GA4 recorded, so consent banners, blockers and tagging gaps lower them; they are not Search Console clicks.',
      'Landing pages are paths without query strings (GA4 landingPage); URLs are shown with https://.',
    ],
  };
  if (meta.rowCount > rows.length) report.notes.push(`Only the top ${rows.length} of ${meta.rowCount} landing pages by sessions are listed (--max-rows).`);
  if (sel) {
    const host = hostOf(sel.audit.target);
    const onHost = rows.filter((r) => sameHost(r.host, host));
    // Compare paths: the crawl may use http/https or www differently from GA4's hostName.
    const pathKey = (u: string) => {
      try {
        const x = new URL(normalizeUrl(u) ?? u);
        return x.pathname.replace(/\/+$/, '') || '/';
      } catch {
        return u;
      }
    };
    const traffic = new Map<string, Ga4LandingRow>();
    for (const r of onHost) {
      const k = r.path.replace(/\/+$/, '') || '/';
      const e = traffic.get(k);
      traffic.set(k, e ? { ...e, sessions: e.sessions + r.sessions, engagedSessions: e.engagedSessions + r.engagedSessions, keyEvents: e.keyEvents + r.keyEvents } : r);
    }
    const issues = new Map<string, Set<string>>();
    for (const f of sel.audit.findings) {
      if (f.severity === 'info') continue;
      for (const u of f.affected?.urls ?? f.evidence.map((e) => e.url).filter((x): x is string => !!x)) (issues.get(pathKey(u)) ?? issues.set(pathKey(u), new Set()).get(pathKey(u))!).add(f.ruleId);
    }
    const indexable = sel.audit.inventory.pages.filter((p) => p.indexable);
    const crawled = new Map(indexable.map((p) => [pathKey(p.url), p.url]));
    report.audit = {
      runId: sel.runId,
      target: sel.audit.target,
      host,
      issuesOnTrafficPages: [...traffic.entries()]
        .filter(([k]) => crawled.has(k) && issues.has(k))
        .map(([k, r]) => ({ url: crawled.get(k)!, sessions: r.sessions, keyEvents: r.keyEvents, issues: [...issues.get(k)!].sort() }))
        .sort((a, b) => b.sessions - a.sessions),
      indexableWithoutSessions: indexable.filter((p) => !traffic.has(pathKey(p.url))).length,
      indexablePages: indexable.length,
    };
    if (!onHost.length) report.notes.push(`No organic landing page in this property is on ${host}: check that the property measures this site.`);
    if (meta.rowCount > rows.length) report.notes.push('Pages beyond --max-rows count as "without sessions" in the audit join.');
  }
  return report;
}

export function renderGa4Markdown(r: Ga4Report): string {
  const L = [`# GA4 organic landing pages — property ${md(r.propertyId)}`, '', `_Experimental: not yet verified against a live property. ${md(r.period.startDate)} – ${md(r.period.endDate)} (${r.period.days} days)._`, ''];
  L.push(`Organic Search sessions: **${r.totals.sessions}** (engaged ${r.totals.engagedSessions}, key events ${r.totals.keyEvents}) on ${r.landingPages} landing page(s).`, '');
  if (r.pages.length) {
    L.push('| Landing page | Sessions | Engaged | Key events |', '|---|---|---|---|');
    for (const p of r.pages.slice(0, 50)) L.push(`| ${md(p.url)} | ${p.sessions} | ${p.engagedSessions} | ${p.keyEvents} |`);
    L.push('');
  }
  if (r.audit) {
    L.push(`## Joined audit ${md(r.audit.runId)} (${md(r.audit.target)})`, '');
    L.push(`Indexable crawled pages without organic sessions in this period: ${r.audit.indexableWithoutSessions} of ${r.audit.indexablePages}.`, '');
    if (r.audit.issuesOnTrafficPages.length) {
      L.push('Pages with organic traffic and open audit issues (fix these first):', '', '| Page | Sessions | Key events | Issues |', '|---|---|---|---|');
      for (const p of r.audit.issuesOnTrafficPages.slice(0, 30)) L.push(`| ${md(p.url)} | ${p.sessions} | ${p.keyEvents} | ${p.issues.map((i) => `\`${i}\``).join(', ')} |`);
      L.push('');
    }
  }
  L.push('## Notes', '', ...r.notes.map((n) => `- ${md(n)}`), '');
  return L.join('\n');
}

/** `searvex ga4 auth|status|properties|report|logout` (experimental). */
export async function commandGa4(flags: GlobalFlags): Promise<number> {
  const v = flags.values;
  const sub = flags.positionals[1];
  const usage = 'ga4 subcommands: auth --client <file> [--force] | status | properties | report <propertyId> [--days 28] [--audit latest|<runId>] [--max-rows 1000] | logout';
  if (sub === 'auth') {
    if (process.env['CI']) throw new UsageError('ga4 auth is interactive (browser consent) and is disabled in CI. Use SEARVEX_GA4_TOKEN there.');
    const existing = getCredential('ga4');
    if (existing && !v['force']) {
      console.log(`Already authorized for Google Analytics (since ${existing.createdAt}). Use --force to authorize again, or "ga4 logout".`);
      return 0;
    }
    const clientFile = v['client'] as string | undefined;
    if (!clientFile) throw new UsageError('ga4 auth requires --client <client_secret.json> (the same kind of "Desktop app" OAuth client as gsc auth; enable the Google Analytics Data and Admin APIs in its project).');
    let client;
    try {
      client = loadClientFile(clientFile);
    } catch (e) {
      if (e instanceof OAuthClientFileError) throw new UsageError(e.message);
      throw e;
    }
    const cred = await authorize(client, GA4_SCOPE, (url) => {
      const opened = !v['no-browser'] && process.stdout.isTTY && openBrowser(url);
      console.log(opened ? '\nOpened your browser. If it did not open, visit this URL and approve read-only Google Analytics access:\n' : '\nOpen this URL in your browser and approve read-only Google Analytics access:\n');
      console.log(url + '\n');
      console.log('Waiting for Google to redirect back to http://127.0.0.1 … (Ctrl+C to cancel; times out after 5 minutes)');
    });
    saveCredential('ga4', cred);
    console.log(`Authorized (scope: ${cred.scope}). Refresh token stored in ${defaultCredentialStore().describe()}. Google Analytics is experimental in Searvex.`);
    return 0;
  }
  if (sub === 'logout') {
    const cred = getCredential('ga4');
    const revoked = cred ? await revokeToken(cred.refreshToken).catch(() => false) : false;
    const removed = deleteCredential('ga4');
    console.log(removed ? `Removed the Google Analytics authorization${revoked ? ' and revoked it at Google' : ' (revocation at Google failed; remove access at myaccount.google.com/permissions)'}.` : 'No stored Google Analytics authorization.');
    return 0;
  }
  if (sub === 'status' || sub === 'properties') {
    const cred = getCredential('ga4');
    if (!cred && !process.env['SEARVEX_GA4_TOKEN']) {
      const hint = 'No Google Analytics authorization: run "searvex ga4 auth --client <client_secret.json>".';
      if (v['json']) process.stdout.write(JSON.stringify({ credential: 'none', valid: false, hint }, null, 2) + '\n');
      else console.log(`credential: none\n${hint}`);
      return 1;
    }
    let props;
    try {
      props = await listGa4Properties(await ga4Token());
    } catch (e) {
      const status = { credential: cred ? 'stored' : 'SEARVEX_GA4_TOKEN', valid: false, error: (e as Error).message };
      if (v['json']) process.stdout.write(JSON.stringify(status, null, 2) + '\n');
      else for (const [n, x] of Object.entries(status)) console.log(`${n}: ${String(x)}`);
      return 1;
    }
    if (sub === 'properties') {
      if (v['json']) process.stdout.write(JSON.stringify(props, null, 2) + '\n');
      else for (const p of props) console.log(`${p.id}\t${p.name}\t(${p.account})`);
      return 0;
    }
    const status = { credential: cred ? 'stored' : 'SEARVEX_GA4_TOKEN', valid: true, properties: props.length, experimental: true };
    if (v['json']) process.stdout.write(JSON.stringify(status, null, 2) + '\n');
    else for (const [n, x] of Object.entries(status)) console.log(`${n}: ${String(x)}`);
    return 0;
  }
  if (sub !== 'report') throw new UsageError(usage);
  const propertyId = flags.positionals[2];
  if (!propertyId) throw new UsageError('ga4 report requires a property id (digits; list them with "searvex ga4 properties")');
  const days = num(v['days'], 28, 1, 400);
  const maxRows = num(v['max-rows'], 1000, 1, 100_000);
  const workspace = path.resolve(String(v['out'] ?? process.cwd()));
  const sel = v['audit'] ? newestWebsiteAudit(workspace, String(v['audit'])) : undefined;
  const token = await ga4Token();
  log(v, `Reading Organic Search landing pages of GA4 property ${propertyId} (${days} days)…`);
  const res = await ga4LandingPages(token, propertyId, days, maxRows);
  const report = buildGa4Report(res.rows, { propertyId, days, startDate: res.startDate, endDate: res.endDate, rowCount: res.rowCount }, sel);
  const store = new RunStore(workspace, RunStore.newRunId('ga4'));
  store.writeJson('meta.json', { kind: 'ga4', propertyId, days, audit: sel?.runId, startedAt: new Date().toISOString() });
  store.writeJson('ga4-report.json', report);
  const out = store.writeText('ga4-report.md', renderGa4Markdown(report));
  if (v['json']) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else if (!v['quiet']) {
    console.log(`\nGA4 property ${propertyId} · ${report.totals.sessions} organic sessions on ${report.landingPages} landing page(s) · experimental`);
    if (report.audit) console.log(`Joined ${report.audit.runId}: ${report.audit.issuesOnTrafficPages.length} page(s) with traffic and open issues; ${report.audit.indexableWithoutSessions} of ${report.audit.indexablePages} indexable pages without organic sessions.`);
    console.log(`Report: ${out}`);
  }
  return 0;
}
