import https from 'node:https';

/**
 * Read-only Google Search Console integration (searchanalytics.query).
 * Auth: an OAuth 2.0 access token with scope https://www.googleapis.com/auth/webmasters.readonly,
 * provided via SEARVEX_GSC_TOKEN (e.g. from `gcloud auth print-access-token` with that scope).
 * Searvex never stores the token. Limits: 1,200 queries/min per site; rowLimit ≤ 25,000.
 * Docs: https://developers.google.com/webmaster-tools/v1/searchanalytics/query
 */
export interface GscRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscQuery {
  token: string;
  siteUrl: string;
  days: number;
  dimensions: Array<'query' | 'page' | 'country' | 'device' | 'date' | 'searchAppearance'>;
  rowLimit?: number;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function querySearchConsole(q: GscQuery): Promise<GscRow[]> {
  const end = new Date(Date.now() - 2 * 86400000); // GSC data lags ~2 days
  const start = new Date(end.getTime() - q.days * 86400000);
  const body = JSON.stringify({ startDate: isoDate(start), endDate: isoDate(end), dimensions: q.dimensions, rowLimit: Math.min(q.rowLimit ?? 1000, 25000) });
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(q.siteUrl)}/searchAnalytics/query`;
  const res = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers: { authorization: `Bearer ${q.token}`, 'content-type': 'application/json' }, timeout: 30000 }, (r) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('Search Console request timed out')));
    req.on('error', reject);
    req.end(body);
  });
  if (res.status !== 200) {
    let msg = res.text.slice(0, 300);
    try {
      msg = (JSON.parse(res.text) as { error?: { message?: string } }).error?.message ?? msg;
    } catch {
      /* keep raw */
    }
    throw new Error(`Search Console API error ${res.status}: ${msg}`);
  }
  const data = JSON.parse(res.text) as { rows?: GscRow[] };
  return data.rows ?? [];
}

