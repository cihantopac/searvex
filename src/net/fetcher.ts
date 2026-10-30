import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import zlib from 'node:zlib';
import type { LookupFunction } from 'node:net';
import type { FetchResult, RedirectHop } from '../core/types.js';
import { assertUrlAllowed, BlockedUrlError, classifyAddress, DEFAULT_POLICY, isAddressAllowed, type NetPolicy } from './ssrf.js';

export const SEARVEX_VERSION = '0.6.0';
/** Honest crawler identification. robots.txt rules for "SearvexBot" (or "Searvex") apply. */
export const DEFAULT_USER_AGENT = `Mozilla/5.0 (compatible; SearvexBot/${SEARVEX_VERSION}; +https://github.com/cihantopac/searvex)`;

export interface FetchOptions {
  policy?: NetPolicy;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** When false, the first response is returned without following redirects (redirect chain auditing). */
  followRedirects?: boolean;
  userAgent?: string;
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
}

const DEFAULTS = {
  timeoutMs: 15000,
  maxBytes: 5 * 1024 * 1024,
  maxRedirects: 10,
};

/**
 * DNS lookup that rejects disallowed addresses at connection time.
 * Every resolved address is checked, so a hostname that resolves to a mix of public and
 * private addresses is rejected outright.
 */
export function guardedLookup(policy: NetPolicy): LookupFunction {
  return ((hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = addresses as dns.LookupAddress[];
      const bad = list.find((a) => !isAddressAllowed(a.address, policy));
      if (bad) {
        return callback(new BlockedUrlError(`Resolved address not allowed (${classifyAddress(bad.address)}): ${bad.address}`, hostname));
      }
      if (options.all) return callback(null, list);
      const first = list[0];
      if (!first) return callback(new Error(`No address for ${hostname}`));
      callback(null, first.address, first.family);
    });
  }) as LookupFunction;
}

function decode(buf: Buffer, encoding: string | undefined): Buffer {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return zlib.gunzipSync(buf);
    case 'deflate':
      try {
        return zlib.inflateSync(buf);
      } catch {
        return zlib.inflateRawSync(buf);
      }
    case 'br':
      return zlib.brotliDecompressSync(buf);
    default:
      return buf;
  }
}

function charsetOf(contentType: string): BufferEncoding {
  const m = /charset=([^;]+)/i.exec(contentType);
  const cs = (m?.[1] ?? 'utf-8').trim().toLowerCase().replace(/["']/g, '');
  if (cs === 'iso-8859-1' || cs === 'latin1' || cs === 'windows-1252') return 'latin1';
  return 'utf8';
}

interface RawResponse {
  ttfbMs: number;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
}

function requestOnce(url: URL, opts: Required<Omit<FetchOptions, 'headers'>> & { headers: Record<string, string> }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      {
        method: opts.method,
        lookup: guardedLookup(opts.policy),
        headers: {
          'user-agent': opts.userAgent,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
          'accept-encoding': 'gzip, deflate, br',
          ...opts.headers,
        },
        timeout: opts.timeoutMs,
        // Never reuse sockets across hosts; each request goes through the guarded lookup.
        agent: false,
      },
      (res) => {
        const ttfbMs = Date.now() - t0;
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on('data', (c: Buffer) => {
          if (truncated) return;
          size += c.length;
          if (size > opts.maxBytes) {
            truncated = true;
            chunks.push(c.subarray(0, c.length - (size - opts.maxBytes)));
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        const finish = () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
          }
          let body: Buffer = Buffer.concat(chunks);
          if (!truncated) {
            try {
              body = decode(body, headers['content-encoding']);
              // Static .gz files (e.g. sitemap.xml.gz) are served as application/gzip without Content-Encoding.
              if (body[0] === 0x1f && body[1] === 0x8b) body = zlib.gunzipSync(body);
            } catch {
              // Keep raw bytes; analysis will flag undecodable content via empty parse.
            }
          }
          resolve({ ttfbMs, status: res.statusCode ?? 0, headers, body, truncated });
        };
        res.on('end', finish);
        res.on('close', () => {
          if (truncated) finish();
        });
        res.on('error', (e) => (truncated ? finish() : reject(e)));
      },
    );
    req.on('timeout', () => req.destroy(new Error(`Timeout after ${opts.timeoutMs}ms`)));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Safe HTTP fetch used by every Searvex network call.
 * - scheme/port/credential/IP validation before connecting
 * - connection-time DNS validation (anti-rebinding)
 * - manual redirect handling: each hop is re-validated and recorded
 * - response size cap, timeout, transparent decompression
 */
export async function safeFetch(rawUrl: string, options: FetchOptions = {}): Promise<FetchResult> {
  const opts = {
    policy: options.policy ?? DEFAULT_POLICY,
    timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
    maxBytes: options.maxBytes ?? DEFAULTS.maxBytes,
    maxRedirects: options.maxRedirects ?? DEFAULTS.maxRedirects,
    followRedirects: options.followRedirects ?? true,
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    method: options.method ?? 'GET',
    headers: options.headers ?? {},
  };
  const started = Date.now();
  const redirects: RedirectHop[] = [];
  let current = rawUrl;
  const base: FetchResult = {
    requestedUrl: rawUrl,
    finalUrl: rawUrl,
    status: 0,
    headers: {},
    redirects,
    body: '',
    bodyBytes: 0,
    truncated: false,
    timingMs: 0,
    contentType: '',
  };
  try {
    for (let hop = 0; ; hop++) {
      const url = assertUrlAllowed(current, opts.policy);
      const res = await requestOnce(url, opts);
      const location = res.headers['location'];
      if (res.status >= 300 && res.status < 400 && location && opts.followRedirects) {
        const next = new URL(location, url).toString();
        redirects.push({ url: url.toString(), status: res.status, location: next });
        if (hop >= opts.maxRedirects) {
          return { ...base, finalUrl: url.toString(), status: res.status, headers: res.headers, error: `Too many redirects (>${opts.maxRedirects})`, timingMs: Date.now() - started };
        }
        if (redirects.slice(0, -1).some((r) => r.url === next)) {
          return { ...base, finalUrl: next, status: res.status, headers: res.headers, error: 'Redirect loop', timingMs: Date.now() - started };
        }
        current = next;
        continue;
      }
      const contentType = res.headers['content-type'] ?? '';
      return {
        ...base,
        finalUrl: url.toString(),
        status: res.status,
        headers: res.headers,
        body: res.body.toString(charsetOf(contentType)),
        bodyBytes: res.body.length,
        truncated: res.truncated,
        timingMs: Date.now() - started,
        ttfbMs: res.ttfbMs,
        contentType,
      };
    }
  } catch (e) {
    const err = e as Error;
    return { ...base, finalUrl: current, error: `${err.name === 'BlockedUrlError' ? 'Blocked: ' : ''}${err.message}`, timingMs: Date.now() - started };
  }
}

/** Per-host politeness: serialises requests per origin with a minimum delay. */
export class HostRateLimiter {
  private next = new Map<string, number>();
  constructor(private delayMs: number) {}

  setDelay(host: string, delayMs: number): void {
    // Only ever slow down (e.g. a server sent 429 / Retry-After), never speed up beyond the configured floor.
    this.custom.set(host, Math.max(delayMs, this.delayMs));
  }
  private custom = new Map<string, number>();

  async wait(host: string): Promise<void> {
    const now = Date.now();
    const delay = this.custom.get(host) ?? this.delayMs;
    const at = Math.max(now, this.next.get(host) ?? 0);
    this.next.set(host, at + delay);
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
}
