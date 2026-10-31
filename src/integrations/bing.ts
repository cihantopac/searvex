import http from 'node:http';
import https from 'node:https';
import type { QueryPage } from '../analyze/search-performance.js';

/**
 * Read-only Bing Webmaster Tools API (JSON endpoint, API key auth).
 * Methods used: GetQueryStats, GetPageStats, GetPageQueryStats — response items are QueryStats
 * {Query, Clicks, Impressions, AvgImpressionPosition, AvgClickPosition, Date}.
 * Docs: https://learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.iwebmasterapi
 * The API key comes from Bing Webmaster Tools → Settings → API access (`searvex bing auth`, or
 * SEARVEX_BING_API_KEY). It travels in the query string, as the API requires, so URLs are never logged.
 */
export interface BingStat {
  key: string;
  clicks: number;
  impressions: number;
  avgImpressionPosition: number;
  avgClickPosition: number;
  date: string | null;
}

const BASE = () => process.env['SEARVEX_BING_API_BASE'] ?? 'https://ssl.bing.com/webmaster/api.svc/json';

/** Parse WCF JSON dates ("/Date(1316156400000-0700)/") and ISO strings. */
export function parseBingDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /\/Date\((-?\d+)([+-]\d{4})?\)\//.exec(v);
  if (m) return new Date(Number(m[1])).toISOString().slice(0, 10);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

export class BingApiError extends Error {}

/** Actionable text for the API's error envelope ({"ErrorCode": n, "Message": "..."}). */
export function bingErrorMessage(status: number, method: string, body: string): string {
  let code = '';
  try {
    code = String((JSON.parse(body) as { Message?: string }).Message ?? '');
  } catch {
    /* not JSON */
  }
  if (/InvalidApiKey/i.test(code)) return 'Bing rejected the API key (InvalidApiKey). Store a new key with "searvex bing auth --force", or fix SEARVEX_BING_API_KEY.';
  if (/throttl|quota/i.test(code) || status === 429) return `Bing Webmaster API quota or rate limit reached on ${method} (${code || `HTTP ${status}`}). Try again later or lower --max-pages.`;
  return `Bing Webmaster API error ${status} on ${method}: ${body}`;
}

/** Remove every occurrence of the key (raw and URL-encoded) from text shown to the user. */
export function maskKey(text: string, apiKey: string): string {
  if (!apiKey) return text;
  return [apiKey, encodeURIComponent(apiKey)].reduce((t, k) => t.split(k).join('***'), text);
}

function get(method: string, params: Record<string, string>, apiKey: string): Promise<unknown[]> {
  const url = `${BASE()}/${method}?${new URLSearchParams({ ...params, apikey: apiKey })}`;
  const mod = url.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get(url, { headers: { accept: 'application/json' }, timeout: 30000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode ?? 0) !== 200) {
          // Never echo the request URL: it contains the API key.
          reject(new BingApiError(bingErrorMessage(res.statusCode ?? 0, method, maskKey(text.slice(0, 200), apiKey))));
          return;
        }
        try {
          const json = JSON.parse(text) as { d?: unknown[] } | unknown[];
          resolve(Array.isArray(json) ? json : (json.d ?? []));
        } catch {
          reject(new Error(`Bing Webmaster API returned non-JSON for ${method}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Bing Webmaster API request timed out')));
    req.on('error', (e) => reject(new Error(maskKey(e.message, apiKey))));
  });
}

function toStats(items: unknown[]): BingStat[] {
  return items.map((x) => {
    const o = x as Record<string, unknown>;
    return {
      key: String(o['Query'] ?? ''),
      clicks: Number(o['Clicks'] ?? 0) || 0,
      impressions: Number(o['Impressions'] ?? 0) || 0,
      avgImpressionPosition: Number(o['AvgImpressionPosition'] ?? 0) || 0,
      avgClickPosition: Number(o['AvgClickPosition'] ?? 0) || 0,
      date: parseBingDate(o['Date']),
    };
  });
}

export const getQueryStats = async (siteUrl: string, apiKey: string) => toStats(await get('GetQueryStats', { siteUrl }, apiKey));
export const getPageStats = async (siteUrl: string, apiKey: string) => toStats(await get('GetPageStats', { siteUrl }, apiKey));
export const getPageQueryStats = async (siteUrl: string, page: string, apiKey: string) => toStats(await get('GetPageQueryStats', { siteUrl, page }, apiKey));

/** Sum dated rows per key within the period; position is impression-weighted. */
export function aggregate(stats: BingStat[], sinceIso?: string): Map<string, { clicks: number; impressions: number; position: number }> {
  const acc = new Map<string, { clicks: number; impressions: number; posWeighted: number }>();
  for (const s of stats) {
    if (sinceIso && s.date && s.date < sinceIso) continue;
    const a = acc.get(s.key) ?? { clicks: 0, impressions: 0, posWeighted: 0 };
    a.clicks += s.clicks;
    a.impressions += s.impressions;
    a.posWeighted += s.avgImpressionPosition * s.impressions;
    acc.set(s.key, a);
  }
  return new Map([...acc].map(([k, a]) => [k, { clicks: a.clicks, impressions: a.impressions, position: a.impressions ? a.posWeighted / a.impressions : 0 }]));
}

/**
 * Build query × page rows: page stats select the top pages, then GetPageQueryStats is called for each
 * (bounded by maxPages to respect API quotas).
 */
export async function bingQueryPageRows(siteUrl: string, apiKey: string, opts: { days: number; maxPages?: number }): Promise<{ rows: QueryPage[]; pages: number }> {
  const since = new Date(Date.now() - opts.days * 86400000).toISOString().slice(0, 10);
  const pages = [...aggregate(await getPageStats(siteUrl, apiKey), since)].sort((a, b) => b[1].clicks - a[1].clicks || b[1].impressions - a[1].impressions).slice(0, opts.maxPages ?? 25);
  const rows: QueryPage[] = [];
  for (const [page] of pages) {
    for (const [query, s] of aggregate(await getPageQueryStats(siteUrl, page, apiKey), since)) {
      rows.push({ query, page, clicks: s.clicks, impressions: s.impressions, ctr: s.impressions ? s.clicks / s.impressions : 0, position: s.position });
    }
  }
  return { rows, pages: pages.length };
}

export interface BingSite {
  url: string;
  verified: boolean;
}

/** Sites of the account the API key belongs to (GetUserSites); also validates the key. */
export async function getUserSites(apiKey: string): Promise<BingSite[]> {
  return (await get('GetUserSites', {}, apiKey)).map((x) => {
    const o = x as Record<string, unknown>;
    return { url: String(o['Url'] ?? ''), verified: o['IsVerified'] === true };
  });
}

/** Daily site totals (GetRankAndTrafficStats: Date, Clicks, Impressions) since `sinceIso`, oldest first. */
export async function getDailyTraffic(siteUrl: string, apiKey: string, sinceIso: string): Promise<Array<{ date: string; clicks: number; impressions: number }>> {
  return (await get('GetRankAndTrafficStats', { siteUrl }, apiKey))
    .map((x) => {
      const o = x as Record<string, unknown>;
      return { date: parseBingDate(o['Date']) ?? '', clicks: Number(o['Clicks'] ?? 0) || 0, impressions: Number(o['Impressions'] ?? 0) || 0 };
    })
    .filter((d) => d.date && d.date >= sinceIso)
    .sort((a, b) => a.date.localeCompare(b.date));
}
