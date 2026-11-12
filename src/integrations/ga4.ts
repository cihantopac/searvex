import http from 'node:http';
import https from 'node:https';
import { dateRange } from './gsc.js';

/**
 * Google Analytics 4 (plan F4, experimental until a live run on the owner's property): read-only organic-search
 * landing pages from the Data API, and the properties the credential can read from the Admin API.
 * Docs: https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport
 * Schema: https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema
 */
export const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const DATA = () => process.env['SEARVEX_GA4_DATA_API_BASE'] ?? 'https://analyticsdata.googleapis.com/v1beta';
const ADMIN = () => process.env['SEARVEX_GA4_ADMIN_API_BASE'] ?? 'https://analyticsadmin.googleapis.com/v1beta';

export interface Ga4Property {
  /** Numeric property id ("properties/123" → "123"). */
  id: string;
  name: string;
  account: string;
}

export interface Ga4LandingRow {
  host: string;
  /** Landing page path (GA4 `landingPage`: path without query string). */
  path: string;
  sessions: number;
  engagedSessions: number;
  keyEvents: number;
}

function request(method: 'GET' | 'POST', url: string, token: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = (url.startsWith('https:') ? https : http).request(
      url,
      { method, timeout: 60_000, headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) } },
      (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            json = { raw: text.slice(0, 300) };
          }
          resolve({ status: r.statusCode ?? 0, json });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Google Analytics request timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}

/** Actionable text for Google Analytics API errors. */
export function ga4ErrorMessage(status: number, json: Record<string, unknown>): string {
  const e = json['error'] as { status?: string; message?: string } | undefined;
  const reason = `${e?.status ?? ''} ${e?.message ?? String(json['raw'] ?? '')}`.trim().slice(0, 200);
  if (status === 401) return 'Google rejected the access token. Run "searvex ga4 auth --client <file>" again.';
  if (status === 403 && /has not been used|is disabled|SERVICE_DISABLED/i.test(reason)) return `The Google Analytics Data/Admin API is not enabled in the OAuth client's Google Cloud project (${reason}). Enable "Google Analytics Data API" and "Google Analytics Admin API" there.`;
  if (status === 403) return `No access to this Google Analytics property with the authorized account (${reason}). List readable properties with "searvex ga4 properties".`;
  if (status === 429) return 'Google Analytics API quota reached for this property. Try again later.';
  return `Google Analytics API HTTP ${status}: ${reason}`;
}

/** Properties the credential can read (Admin API accountSummaries, all pages). */
export async function listGa4Properties(token: string): Promise<Ga4Property[]> {
  const out: Ga4Property[] = [];
  let pageToken = '';
  for (let i = 0; i < 20; i++) {
    const res = await request('GET', `${ADMIN()}/accountSummaries?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, token);
    if (res.status !== 200) throw new Error(ga4ErrorMessage(res.status, res.json));
    for (const a of (res.json['accountSummaries'] as Array<{ displayName?: string; propertySummaries?: Array<{ property?: string; displayName?: string }> }> | undefined) ?? [])
      for (const p of a.propertySummaries ?? []) if (p.property) out.push({ id: p.property.replace(/^properties\//, ''), name: p.displayName ?? '', account: a.displayName ?? '' });
    pageToken = String(res.json['nextPageToken'] ?? '');
    if (!pageToken) break;
  }
  return out;
}

/**
 * Organic-search landing pages: sessions whose default channel group is "Organic Search" (all search engines,
 * as GA4 classifies them), by host and landing page path, most sessions first.
 */
export async function ga4LandingPages(token: string, propertyId: string, days: number, maxRows = 1000): Promise<{ rows: Ga4LandingRow[]; rowCount: number; startDate: string; endDate: string }> {
  if (!/^\d+$/.test(propertyId)) throw new Error(`Not a GA4 property id: ${propertyId} (expected digits, e.g. 123456789; see "searvex ga4 properties")`);
  const { startDate, endDate } = dateRange(days);
  const res = await request('POST', `${DATA()}/properties/${propertyId}:runReport`, token, {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'hostName' }, { name: 'landingPage' }],
    metrics: [{ name: 'sessions' }, { name: 'engagedSessions' }, { name: 'keyEvents' }],
    dimensionFilter: { filter: { fieldName: 'sessionDefaultChannelGroup', stringFilter: { value: 'Organic Search' } } },
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: String(maxRows),
  });
  if (res.status !== 200) throw new Error(ga4ErrorMessage(res.status, res.json));
  const rows = ((res.json['rows'] as Array<{ dimensionValues?: Array<{ value?: string }>; metricValues?: Array<{ value?: string }> }> | undefined) ?? []).map((r) => {
    const d = r.dimensionValues ?? [];
    const m = r.metricValues ?? [];
    const num = (i: number) => Number(m[i]?.value ?? 0) || 0;
    return { host: (d[0]?.value ?? '').toLowerCase(), path: d[1]?.value ?? '', sessions: num(0), engagedSessions: num(1), keyEvents: num(2) };
  });
  return { rows, rowCount: Number(res.json['rowCount'] ?? rows.length) || rows.length, startDate, endDate };
}
