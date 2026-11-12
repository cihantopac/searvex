import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { classifyAddress } from '../net/ssrf.js';
import { maskCruxKey } from './crux.js';

const BASE = () => process.env['SEARVEX_PSI_API_BASE'] ?? 'https://pagespeedonline.googleapis.com/pagespeedonline/v5';

/**
 * PageSpeed Insights API — Lighthouse **lab** data for single URLs (plan F6). Opt-in with `--lab` and a Google
 * Cloud API key with the PageSpeed Insights API enabled (`searvex psi auth`, or SEARVEX_PSI_API_KEY). Google
 * fetches each sampled URL itself, so only publicly reachable pages can be measured; the URL is the only data sent.
 * Lab values come from one simulated load (an emulated mobile device on a throttled network for `mobile`) and vary between
 * runs: they explain *why* a page is slow, they are never Core Web Vitals pass/fail (that is CrUX field data).
 * Docs: https://developers.google.com/speed/docs/insights/rest/v5/pagespeedapi/runpagespeed
 * Score bands: https://developer.chrome.com/docs/lighthouse/performance/performance-scoring
 */
export interface LabMetrics {
  url: string;
  /** URL Lighthouse ended on after redirects. */
  finalUrl: string;
  strategy: 'mobile' | 'desktop';
  /** Lighthouse performance score 0–100 (0–49 poor, 50–89 needs improvement, 90–100 good). */
  score?: number;
  lcpMs?: number;
  fcpMs?: number;
  tbtMs?: number;
  cls?: number;
  speedIndexMs?: number;
  ttfbMs?: number;
  lighthouseVersion?: string;
  fetchTime?: string;
}

export type LabResult = { status: 'ok'; metrics: LabMetrics } | { status: 'error'; url: string; message: string };

/** Lighthouse colour bands for the performance score. */
export const LAB_SCORE_POOR = 50;

function get(url: string, timeoutMs: number): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('https:') ? https : http).get(url, { timeout: timeoutMs }, (r) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('PageSpeed Insights request timed out')));
    req.on('error', reject);
  });
}

interface PsiResponse {
  id?: string;
  lighthouseResult?: {
    finalUrl?: string;
    finalDisplayedUrl?: string;
    lighthouseVersion?: string;
    fetchTime?: string;
    runtimeError?: { code?: string; message?: string };
    categories?: { performance?: { score?: number | null } };
    audits?: Record<string, { numericValue?: number }>;
  };
}

export function parsePsi(json: PsiResponse, url: string, strategy: LabMetrics['strategy']): LabResult {
  const lh = json.lighthouseResult;
  if (!lh) return { status: 'error', url, message: 'PageSpeed Insights returned no Lighthouse result' };
  if (lh.runtimeError?.code && lh.runtimeError.code !== 'NO_ERROR') return { status: 'error', url, message: `Lighthouse could not measure the page: ${lh.runtimeError.code}${lh.runtimeError.message ? ` (${lh.runtimeError.message.slice(0, 160)})` : ''}` };
  const a = lh.audits ?? {};
  const n = (k: string, round = true) => {
    const v = a[k]?.numericValue;
    return typeof v === 'number' && Number.isFinite(v) ? (round ? Math.round(v) : Math.round(v * 1000) / 1000) : undefined;
  };
  const score = lh.categories?.performance?.score;
  return {
    status: 'ok',
    metrics: {
      url,
      finalUrl: lh.finalDisplayedUrl ?? lh.finalUrl ?? json.id ?? url,
      strategy,
      ...(typeof score === 'number' ? { score: Math.round(score * 100) } : {}),
      lcpMs: n('largest-contentful-paint'),
      fcpMs: n('first-contentful-paint'),
      tbtMs: n('total-blocking-time'),
      cls: n('cumulative-layout-shift', false),
      speedIndexMs: n('speed-index'),
      ttfbMs: n('server-response-time'),
      lighthouseVersion: lh.lighthouseVersion,
      fetchTime: lh.fetchTime,
    },
  };
}

/** Actionable text for PageSpeed Insights API errors. */
export function psiErrorMessage(status: number, body: string): string {
  let reason = '';
  try {
    const e = (JSON.parse(body) as { error?: { status?: string; message?: string } }).error;
    reason = `${e?.status ?? ''} ${e?.message ?? ''}`.trim();
  } catch {
    reason = body;
  }
  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(reason)) return 'Google rejected the PageSpeed Insights API key (not valid). Store a new key with "searvex psi auth --force", or fix SEARVEX_PSI_API_KEY.';
  if (status === 400) return `PageSpeed Insights could not measure the URL: ${reason.slice(0, 200)}`;
  if (status === 403) return `The key may not use the PageSpeed Insights API (${reason.slice(0, 160)}). Enable "PageSpeed Insights API" in the key's Google Cloud project and allow it in the key's API restrictions.`;
  if (status === 429) return 'PageSpeed Insights API quota reached. Try again later or lower --lab.';
  return `PageSpeed Insights API HTTP ${status}: ${reason.slice(0, 200)}`;
}

export async function queryPsi(url: string, apiKey: string, strategy: LabMetrics['strategy'] = 'mobile', timeoutMs = 120_000): Promise<LabResult> {
  const q = new URLSearchParams({ url, strategy, category: 'performance', key: apiKey });
  try {
    const res = await get(`${BASE()}/runPagespeed?${q}`, timeoutMs);
    if (res.status !== 200) return { status: 'error', url, message: psiErrorMessage(res.status, maskCruxKey(res.text.slice(0, 400), apiKey)) };
    return parsePsi(JSON.parse(res.text) as PsiResponse, url, strategy);
  } catch (e) {
    return { status: 'error', url, message: maskCruxKey(`PageSpeed Insights request failed: ${(e as Error).message}`, apiKey) };
  }
}

/** Google's servers fetch the page: local and private hosts cannot be measured. */
export function publiclyMeasurable(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return false;
  }
  if (isIP(host)) return classifyAddress(host) === 'public';
  return !(host === 'localhost' || /\.(localhost|local|test|internal|lan|home\.arpa)$/.test(host) || !host.includes('.'));
}

/** Failing lab metrics, phrased with Lighthouse's own numbers (never as Core Web Vitals pass/fail). */
export function labSummary(m: LabMetrics): string {
  const parts: string[] = [];
  if (m.score !== undefined) parts.push(`score ${m.score}`);
  if (m.lcpMs !== undefined) parts.push(`LCP ${(m.lcpMs / 1000).toFixed(1)} s`);
  if (m.tbtMs !== undefined) parts.push(`TBT ${m.tbtMs} ms`);
  if (m.cls !== undefined) parts.push(`CLS ${m.cls}`);
  if (m.fcpMs !== undefined) parts.push(`FCP ${(m.fcpMs / 1000).toFixed(1)} s`);
  return parts.join(', ');
}
