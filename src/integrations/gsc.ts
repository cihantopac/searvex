import http from 'node:http';
import https from 'node:https';

/**
 * Read-only Google Search Console client (Search Analytics + sites.list).
 * Auth: OAuth access token with https://www.googleapis.com/auth/webmasters.readonly — from
 * `searvex gsc auth` (stored refresh token) or SEARVEX_GSC_TOKEN. Searvex never writes to Search Console.
 * Limits (official): rowLimit ≤ 25,000 per request (paged with startRow); 1,200 QPM per site/user.
 * Docs: https://developers.google.com/webmaster-tools/v1/searchanalytics/query
 */
export interface GscRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export type GscDimension = 'query' | 'page' | 'country' | 'device' | 'date' | 'searchAppearance';

export interface GscQuery {
  token: string;
  siteUrl: string;
  days: number;
  dimensions: GscDimension[];
  rowLimit?: number;
  /** Maximum rows across pages (default 25,000). */
  maxRows?: number;
  searchType?: 'web' | 'image' | 'video' | 'news' | 'discover' | 'googleNews';
}

const API_BASE = () => process.env['SEARVEX_GSC_API_BASE'] ?? 'https://www.googleapis.com/webmasters/v3';

function request(method: 'GET' | 'POST', url: string, token: string, body?: string): Promise<{ status: number; text: string }> {
  const mod = url.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, timeout: 30000 }, (r) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('Search Console request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

function apiError(status: number, text: string): Error {
  let msg = text.slice(0, 300);
  try {
    msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg;
  } catch {
    /* keep raw */
  }
  return new Error(`Search Console API error ${status}: ${msg}`);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function dateRange(days: number, now = new Date()): { startDate: string; endDate: string } {
  const end = new Date(now.getTime() - 2 * 86400000); // final data lags ~2 days
  const start = new Date(end.getTime() - (days - 1) * 86400000);
  return { startDate: isoDate(start), endDate: isoDate(end) };
}

export async function listSites(token: string): Promise<Array<{ siteUrl: string; permissionLevel: string }>> {
  const res = await request('GET', `${API_BASE()}/sites`, token);
  if (res.status !== 200) throw apiError(res.status, res.text);
  return (JSON.parse(res.text) as { siteEntry?: Array<{ siteUrl: string; permissionLevel: string }> }).siteEntry ?? [];
}

export async function querySearchConsole(q: GscQuery): Promise<GscRow[]> {
  const { startDate, endDate } = dateRange(q.days);
  const pageSize = Math.min(q.rowLimit ?? 25000, 25000);
  const maxRows = q.maxRows ?? 25000;
  const url = `${API_BASE()}/sites/${encodeURIComponent(q.siteUrl)}/searchAnalytics/query`;
  const rows: GscRow[] = [];
  for (let startRow = 0; rows.length < maxRows; startRow += pageSize) {
    const body = JSON.stringify({ startDate, endDate, dimensions: q.dimensions, rowLimit: Math.min(pageSize, maxRows - rows.length), startRow, type: q.searchType ?? 'web' });
    const res = await request('POST', url, q.token, body);
    if (res.status !== 200) throw apiError(res.status, res.text);
    const page = (JSON.parse(res.text) as { rows?: GscRow[] }).rows ?? [];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}
