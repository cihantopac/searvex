import http from 'node:http';
import https from 'node:https';

const BASE = () => process.env['SEARVEX_CRUX_API_BASE'] ?? 'https://chromeuxreport.googleapis.com/v1';

/**
 * Chrome UX Report (CrUX) API — real-user Core Web Vitals field data (p75, 28-day window).
 * Opt-in: a free Google Cloud API key with the CrUX API enabled (`searvex crux auth`, or SEARVEX_CRUX_API_KEY).
 * Only the origin (or page URL) is sent to Google. Docs: https://developer.chrome.com/docs/crux/api
 * Thresholds ("good"): LCP ≤ 2500 ms, INP ≤ 200 ms, CLS ≤ 0.1 — https://web.dev/articles/vitals
 */
export interface CruxMetrics {
  formFactor: 'PHONE' | 'DESKTOP' | 'ALL';
  lcpMs?: number;
  inpMs?: number;
  cls?: number;
  collectionPeriod?: { first: string; last: string };
}

export type CruxResult = { status: 'ok'; origin: string; metrics: CruxMetrics[] } | { status: 'no-data' | 'error'; origin: string; message: string };

export const CWV_THRESHOLDS = { lcpMs: 2500, inpMs: 200, cls: 0.1 };

function post(url: string, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('https:') ? https : http).request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 20000 }, (r) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('CrUX request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

interface CruxResponse {
  record?: {
    metrics?: Record<string, { percentiles?: { p75?: number | string } }>;
    collectionPeriod?: { firstDate: { year: number; month: number; day: number }; lastDate: { year: number; month: number; day: number } };
  };
}

export function parseCruxRecord(json: CruxResponse, formFactor: CruxMetrics['formFactor']): CruxMetrics {
  const m = json.record?.metrics ?? {};
  const p75 = (k: string) => {
    const v = m[k]?.percentiles?.p75;
    return v === undefined ? undefined : Number(v);
  };
  const d = (x?: { year: number; month: number; day: number }) => (x ? `${x.year}-${String(x.month).padStart(2, '0')}-${String(x.day).padStart(2, '0')}` : '');
  const cp = json.record?.collectionPeriod;
  return { formFactor, lcpMs: p75('largest_contentful_paint'), inpMs: p75('interaction_to_next_paint'), cls: p75('cumulative_layout_shift'), collectionPeriod: cp ? { first: d(cp.firstDate), last: d(cp.lastDate) } : undefined };
}

/** Remove the key (raw and URL-encoded) from text shown to the user. */
export function maskCruxKey(text: string, apiKey: string): string {
  return apiKey ? [apiKey, encodeURIComponent(apiKey)].reduce((t, k) => t.split(k).join('***'), text) : text;
}

/** Actionable text for Google API errors ({"error": {"status": "...", "message": "..."}}). */
export function cruxErrorMessage(status: number, body: string): string {
  let reason = '';
  try {
    const e = (JSON.parse(body) as { error?: { status?: string; message?: string } }).error;
    reason = `${e?.status ?? ''} ${e?.message ?? ''}`.trim();
  } catch {
    reason = body;
  }
  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(reason)) return 'Google rejected the CrUX API key (not valid). Store a new key with "searvex crux auth --force", or fix SEARVEX_CRUX_API_KEY.';
  if (status === 403) return `The key may not use the Chrome UX Report API (${reason.slice(0, 160)}). Enable "Chrome UX Report API" in the key's Google Cloud project and allow it in the key's API restrictions.`;
  if (status === 429) return 'CrUX API quota reached (150 queries per minute per project). Try again in a minute.';
  return `CrUX API HTTP ${status}: ${reason.slice(0, 200)}`;
}

export async function queryCrux(origin: string, apiKey: string): Promise<CruxResult> {
  const metrics: CruxMetrics[] = [];
  for (const formFactor of ['PHONE', 'DESKTOP'] as const) {
    const res = await post(`${BASE()}/records:queryRecord?key=${encodeURIComponent(apiKey)}`, JSON.stringify({ origin, formFactor, metrics: ['largest_contentful_paint', 'interaction_to_next_paint', 'cumulative_layout_shift'] }));
    if (res.status === 404) continue; // origin/form factor not in the dataset (insufficient traffic)
    if (res.status !== 200) return { status: 'error', origin, message: cruxErrorMessage(res.status, maskCruxKey(res.text.slice(0, 300), apiKey)) };
    metrics.push(parseCruxRecord(JSON.parse(res.text) as CruxResponse, formFactor));
  }
  if (!metrics.length) return { status: 'no-data', origin, message: 'Origin not in the CrUX dataset (insufficient real-user traffic)' };
  return { status: 'ok', origin, metrics };
}

export function failingMetrics(m: CruxMetrics): string[] {
  const out: string[] = [];
  if (m.lcpMs !== undefined && m.lcpMs > CWV_THRESHOLDS.lcpMs) out.push(`LCP ${m.lcpMs} ms`);
  if (m.inpMs !== undefined && m.inpMs > CWV_THRESHOLDS.inpMs) out.push(`INP ${m.inpMs} ms`);
  if (m.cls !== undefined && m.cls > CWV_THRESHOLDS.cls) out.push(`CLS ${m.cls}`);
  return out;
}
