import http from 'node:http';
import https from 'node:https';

/**
 * Yandex Webmaster API v4 (plan F5, experimental until a live run on a verified owner site): read-only user, site
 * list and popular search queries. Authorization is an OAuth token of a Yandex OAuth app with Webmaster access.
 * Docs: https://yandex.ru/dev/webmaster/doc/ru/reference/host-search-queries-popular
 */
const BASE = () => process.env['SEARVEX_YANDEX_API_BASE'] ?? 'https://api.webmaster.yandex.net/v4';

export interface YandexHost {
  id: string;
  url: string;
  verified: boolean;
  mainMirror?: string;
}

export interface YandexQueryRow {
  query: string;
  shows: number;
  clicks: number;
  /** Average position of impressions (1 = top). */
  position?: number;
}

export class YandexApiError extends Error {}

function get(url: string, token: string): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('https:') ? https : http).get(url, { timeout: 30_000, headers: { authorization: `OAuth ${token}`, accept: 'application/json' } }, (r) => {
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
    });
    req.on('timeout', () => req.destroy(new Error('Yandex Webmaster request timed out')));
    req.on('error', reject);
  });
}

/** Actionable text for Yandex Webmaster API errors ({"error_code": "...", "error_message": "..."}). */
export function yandexErrorMessage(status: number, json: Record<string, unknown>): string {
  const code = String(json['error_code'] ?? '');
  const msg = String(json['error_message'] ?? json['raw'] ?? '').slice(0, 200);
  if (status === 401) return 'Yandex rejected the OAuth token (invalid or expired). Store a new one with "searvex yandex auth --force", or fix SEARVEX_YANDEX_TOKEN.';
  if (status === 403) return `The token has no access to this site in Yandex Webmaster (${code || msg}). Check that the site is added and verified for the token's account.`;
  if (status === 404 && /HOST_NOT/i.test(code)) return `The site is not in this Yandex Webmaster account (${code}). List sites with "searvex yandex sites".`;
  if (status === 429) return 'Yandex Webmaster API quota reached. Try again later.';
  return `Yandex Webmaster API HTTP ${status}${code ? ` ${code}` : ''}: ${msg}`;
}

async function call(path: string, token: string): Promise<Record<string, unknown>> {
  const res = await get(`${BASE()}${path}`, token);
  if (res.status !== 200) throw new YandexApiError(yandexErrorMessage(res.status, res.json));
  return res.json;
}

export async function yandexUserId(token: string): Promise<string> {
  const id = (await call('/user', token))['user_id'];
  if (id === undefined) throw new YandexApiError('Yandex Webmaster returned no user_id for this token');
  return String(id);
}

export async function yandexHosts(token: string, userId: string): Promise<YandexHost[]> {
  const hosts = ((await call(`/user/${encodeURIComponent(userId)}/hosts`, token))['hosts'] as Array<{ host_id: string; ascii_host_url: string; verified: boolean; main_mirror?: { ascii_host_url?: string } }> | undefined) ?? [];
  return hosts.map((h) => ({ id: h.host_id, url: h.ascii_host_url, verified: !!h.verified, ...(h.main_mirror?.ascii_host_url ? { mainMirror: h.main_mirror.ascii_host_url } : {}) }));
}

/** Popular queries of a host for a date range, most impressions first (the API returns at most 500 per page). */
export async function yandexPopularQueries(token: string, userId: string, hostId: string, range: { startDate: string; endDate: string }, maxRows = 500): Promise<{ rows: YandexQueryRow[]; total: number }> {
  const rows: YandexQueryRow[] = [];
  let total = 0;
  for (let offset = 0; offset < maxRows; offset += 500) {
    const q = new URLSearchParams({ order_by: 'TOTAL_SHOWS', date_from: range.startDate, date_to: range.endDate, offset: String(offset), limit: String(Math.min(500, maxRows - offset)) });
    for (const i of ['TOTAL_SHOWS', 'TOTAL_CLICKS', 'AVG_SHOW_POSITION']) q.append('query_indicator', i);
    const json = await call(`/user/${encodeURIComponent(userId)}/hosts/${encodeURIComponent(hostId)}/search-queries/popular?${q}`, token);
    const page = (json['queries'] as Array<{ query_text?: string; indicators?: Record<string, number | null> }> | undefined) ?? [];
    total = Number(json['count'] ?? 0) || total;
    for (const x of page) {
      const ind = x.indicators ?? {};
      const pos = ind['AVG_SHOW_POSITION'];
      rows.push({ query: x.query_text ?? '', shows: Number(ind['TOTAL_SHOWS'] ?? 0) || 0, clicks: Number(ind['TOTAL_CLICKS'] ?? 0) || 0, ...(typeof pos === 'number' ? { position: Math.round(pos * 10) / 10 } : {}) });
    }
    if (page.length < 500) break;
  }
  return { rows, total: Math.max(total, rows.length) };
}

/** Yandex host id for a site URL: "https:example.com:443". */
export function hostIdFor(siteUrl: string): string {
  const u = new URL(siteUrl);
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return `${u.protocol.replace(':', '')}:${u.hostname.toLowerCase()}:${port}`;
}
