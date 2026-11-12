import path from 'node:path';
import { RunStore } from '../crawl/store.js';
import { defaultCredentialStore } from '../integrations/credentials.js';
import { deleteCredential, getCredential, saveCredential } from '../integrations/google-oauth.js';
import { dateRange } from '../integrations/gsc.js';
import { hostIdFor, yandexHosts, yandexPopularQueries, yandexUserId, type YandexQueryRow } from '../integrations/yandex.js';
import { md } from '../report/markdown.js';
import { log, num, UsageError, type GlobalFlags } from '../cli.js';
import { readSecret } from './gsc.js';

/** Popular Yandex queries of a verified site (plan F5). */
export interface YandexReport {
  source: string;
  site: string;
  period: { days: number; startDate: string; endDate: string };
  /** Queries with impressions in the period (`count` of the API); rows beyond --max-rows are not listed. */
  queriesTotal: number;
  totals: { shows: number; clicks: number };
  queries: Array<YandexQueryRow & { ctr: number }>;
  notes: string[];
}

/** OAuth token: SEARVEX_YANDEX_TOKEN, or the token saved with `yandex auth` in the credential store. */
export function yandexToken(): { token: string; source: string } | null {
  const env = process.env['SEARVEX_YANDEX_TOKEN'];
  if (env) return { token: env, source: 'SEARVEX_YANDEX_TOKEN' };
  const stored = getCredential('yandex');
  return stored?.refreshToken ? { token: stored.refreshToken, source: defaultCredentialStore().describe() } : null;
}

const mask = (text: string, token: string) => (token ? text.split(token).join('***') : text);

export function buildYandexReport(rows: YandexQueryRow[], meta: { site: string; days: number; startDate: string; endDate: string; total: number }): YandexReport {
  const shows = rows.reduce((a, r) => a + r.shows, 0);
  const clicks = rows.reduce((a, r) => a + r.clicks, 0);
  const report: YandexReport = {
    source: `Yandex Webmaster ${meta.site}`,
    site: meta.site,
    period: { days: meta.days, startDate: meta.startDate, endDate: meta.endDate },
    queriesTotal: meta.total,
    totals: { shows, clicks },
    queries: rows.map((r) => ({ ...r, ctr: r.shows ? Math.round((r.clicks / r.shows) * 1000) / 1000 : 0 })),
    notes: ['Popular queries only: the Yandex Webmaster API gives no page × query breakdown here, so findings are not joined to pages.', 'Totals are sums over the listed queries, not site totals.'],
  };
  if (meta.total > rows.length) report.notes.push(`Only the top ${rows.length} of ${meta.total} queries by impressions are listed (--max-rows).`);
  return report;
}

export function renderYandexMarkdown(r: YandexReport): string {
  const L = [`# Yandex search queries — ${md(r.site)}`, '', `_Experimental: not yet verified against a live site. ${md(r.period.startDate)} – ${md(r.period.endDate)} (${r.period.days} days)._`, ''];
  L.push(`Impressions **${r.totals.shows}**, clicks **${r.totals.clicks}** over ${r.queries.length} of ${r.queriesTotal} queries.`, '');
  if (r.queries.length) {
    L.push('| Query | Impressions | Clicks | CTR | Avg. position |', '|---|---|---|---|---|');
    for (const q of r.queries.slice(0, 50)) L.push(`| ${md(q.query)} | ${q.shows} | ${q.clicks} | ${(q.ctr * 100).toFixed(1)}% | ${q.position ?? '—'} |`);
    L.push('');
  }
  L.push('## Notes', '', ...r.notes.map((n) => `- ${md(n)}`), '');
  return L.join('\n');
}

/** `searvex yandex auth|status|sites|report|logout` (experimental). */
export async function commandYandex(flags: GlobalFlags): Promise<number> {
  const v = flags.values;
  const sub = flags.positionals[1];
  const usage = 'yandex subcommands: auth [--force] | status | sites | report <siteUrl> [--days 28] [--max-rows 500] | logout';
  if (sub === 'auth') {
    if (getCredential('yandex') && !v['force']) {
      console.log(`A Yandex OAuth token is already stored in ${defaultCredentialStore().describe()}. Use --force to replace it, or "yandex logout".`);
      return 0;
    }
    const token = await readSecret('Yandex OAuth token with Webmaster access (oauth.yandex.com; input hidden): ');
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) throw new UsageError('That does not look like a Yandex OAuth token. Nothing was stored.');
    let hosts;
    try {
      hosts = await yandexHosts(token, await yandexUserId(token));
    } catch (e) {
      throw new UsageError(`Yandex rejected the token; nothing was stored. ${mask((e as Error).message, token)}`);
    }
    saveCredential('yandex', { clientId: 'yandex-oauth-token', refreshToken: token, scope: 'webmaster:read', createdAt: new Date().toISOString() });
    console.log(`Stored the Yandex token in ${defaultCredentialStore().describe()}. Sites on this account: ${hosts.length} (${hosts.filter((h) => h.verified).length} verified). Yandex is experimental in Searvex.`);
    return 0;
  }
  if (sub === 'logout') {
    const removed = deleteCredential('yandex');
    console.log(`${removed ? 'Removed the stored Yandex token.' : 'No stored Yandex token.'} The token stays valid until you revoke it at oauth.yandex.com.`);
    return 0;
  }
  const t = yandexToken();
  if (sub === 'status' || sub === 'sites') {
    if (!t) {
      const hint = 'No Yandex token: run "searvex yandex auth", or set SEARVEX_YANDEX_TOKEN.';
      if (v['json']) process.stdout.write(JSON.stringify({ token: 'none', valid: false, hint }, null, 2) + '\n');
      else console.log(`token: none\n${hint}`);
      return 1;
    }
    try {
      const hosts = await yandexHosts(t.token, await yandexUserId(t.token));
      if (sub === 'sites') {
        if (v['json']) process.stdout.write(JSON.stringify(hosts, null, 2) + '\n');
        else for (const h of hosts) console.log(`${h.url}\t${h.verified ? 'verified' : 'not verified'}${h.mainMirror && h.mainMirror !== h.url ? `\tmain mirror ${h.mainMirror}` : ''}`);
        return 0;
      }
      const status = { token: t.source, valid: true, sites: hosts.length, experimental: true };
      if (v['json']) process.stdout.write(JSON.stringify(status, null, 2) + '\n');
      else for (const [n, x] of Object.entries(status)) console.log(`${n}: ${String(x)}`);
      return 0;
    } catch (e) {
      const status = { token: t.source, valid: false, error: mask((e as Error).message, t.token) };
      if (v['json']) process.stdout.write(JSON.stringify(status, null, 2) + '\n');
      else for (const [n, x] of Object.entries(status)) console.log(`${n}: ${String(x)}`);
      return 1;
    }
  }
  if (sub !== 'report') throw new UsageError(usage);
  const siteUrl = flags.positionals[2];
  if (!siteUrl || !/^https?:\/\//.test(siteUrl)) throw new UsageError('yandex report requires the site URL as added in Yandex Webmaster, e.g. https://example.com/');
  if (!t) throw new UsageError('No Yandex token: run "searvex yandex auth", or set SEARVEX_YANDEX_TOKEN.');
  const days = num(v['days'], 28, 1, 365);
  const maxRows = num(v['max-rows'], 500, 1, 5000);
  const userId = await yandexUserId(t.token);
  const hosts = await yandexHosts(t.token, userId);
  const wanted = hostIdFor(siteUrl);
  const host = hosts.find((h) => h.id === wanted);
  if (!host) throw new UsageError(`${siteUrl} (${wanted}) is not a site of this Yandex Webmaster account. Sites: ${hosts.map((h) => h.url).slice(0, 10).join(', ') || 'none'}.`);
  if (!host.verified) throw new UsageError(`${host.url} is not verified in Yandex Webmaster; Yandex returns no query data for unverified sites.`);
  const range = dateRange(days);
  log(v, `Reading popular Yandex queries for ${host.url} (${days} days)…`);
  const { rows, total } = await yandexPopularQueries(t.token, userId, host.id, range, maxRows);
  const report = buildYandexReport(rows, { site: host.url, days, ...range, total });
  const workspace = path.resolve(String(v['out'] ?? process.cwd()));
  const store = new RunStore(workspace, RunStore.newRunId('yandex'));
  store.writeJson('meta.json', { kind: 'yandex', target: host.url, days, startedAt: new Date().toISOString() });
  store.writeJson('yandex-report.json', report);
  const out = store.writeText('yandex-report.md', renderYandexMarkdown(report));
  if (v['json']) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else if (!v['quiet']) console.log(`\nYandex ${host.url} · ${report.totals.shows} impressions, ${report.totals.clicks} clicks over ${report.queries.length} queries · experimental\nReport: ${out}`);
  return 0;
}
