import { isIP } from 'node:net';

/**
 * SSRF protection. Classifies IP addresses and decides whether Searvex may connect.
 *
 * The check is applied inside the socket `lookup` callback (see fetcher.ts), i.e. on the
 * exact address the socket connects to. That closes the DNS-rebinding window that exists
 * when a hostname is resolved once for validation and again for the connection.
 */

export interface NetPolicy {
  /** Allow loopback and private (RFC 1918, CGNAT, ULA) targets. Off by default; local dev servers opt in. Link-local is never allowed. */
  allowPrivate: boolean;
  /** Allowed URL schemes. */
  schemes: ReadonlyArray<string>;
  /** Allowed ports (empty = any). */
  ports: ReadonlyArray<number>;
}

export const DEFAULT_POLICY: NetPolicy = {
  allowPrivate: false,
  schemes: ['http:', 'https:'],
  ports: [],
};

function ipv4ToInt(ip: string): number {
  const p = ip.split('.').map(Number);
  return (((p[0]! << 24) >>> 0) + (p[1]! << 16) + (p[2]! << 8) + p[3]!) >>> 0;
}

const V4_BLOCKS: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata lives here)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

function inV4Block(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

/** Expand an IPv6 address to 8 groups of 16-bit integers. */
export function expandIPv6(ip: string): number[] | null {
  let addr = ip.toLowerCase();
  const zone = addr.indexOf('%');
  if (zone !== -1) addr = addr.slice(0, zone);
  // Embedded IPv4 (e.g. ::ffff:1.2.3.4)
  const v4 = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = ipv4ToInt(v4[1]!);
    addr = addr.replace(v4[1]!, `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`);
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const out = groups.map((g) => parseInt(g, 16));
  if (out.length !== 8 || out.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;
  return out;
}

export type AddressClass = 'public' | 'private' | 'loopback' | 'link-local' | 'reserved' | 'invalid';

export function classifyAddress(ip: string): AddressClass {
  const fam = isIP(ip.split('%')[0]!);
  if (fam === 4) {
    if (inV4Block(ip, '127.0.0.0', 8)) return 'loopback';
    if (inV4Block(ip, '169.254.0.0', 16)) return 'link-local';
    if (inV4Block(ip, '10.0.0.0', 8) || inV4Block(ip, '172.16.0.0', 12) || inV4Block(ip, '192.168.0.0', 16) || inV4Block(ip, '100.64.0.0', 10))
      return 'private';
    for (const [base, bits] of V4_BLOCKS) if (inV4Block(ip, base, bits)) return 'reserved';
    return 'public';
  }
  if (fam === 6) {
    const g = expandIPv6(ip);
    if (!g) return 'invalid';
    const isZero = g.every((x) => x === 0);
    if (isZero) return 'reserved'; // ::
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'loopback'; // ::1
    // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible / NAT64 (64:ff9b::/96): classify the embedded v4
    const mapped = g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff;
    const nat64 = g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0);
    if (mapped || nat64) {
      const v4 = `${g[6]! >>> 8}.${g[6]! & 0xff}.${g[7]! >>> 8}.${g[7]! & 0xff}`;
      return classifyAddress(v4);
    }
    const first = g[0]!;
    if ((first & 0xffc0) === 0xfe80) return 'link-local'; // fe80::/10
    if ((first & 0xfe00) === 0xfc00) return 'private'; // fc00::/7 ULA
    if ((first & 0xff00) === 0xff00) return 'reserved'; // multicast
    if (first === 0x2001 && g[1] === 0x0db8) return 'reserved'; // documentation
    if (first === 0x2002) return 'reserved'; // 6to4 can embed private v4
    if (first === 0x2001 && g[1] === 0) return 'reserved'; // Teredo
    return 'public';
  }
  return 'invalid';
}

export function isAddressAllowed(ip: string, policy: NetPolicy): boolean {
  const c = classifyAddress(ip);
  if (c === 'public') return true;
  // Link-local (169.254.0.0/16, fe80::/10) hosts cloud metadata services (e.g. 169.254.169.254); auditing a
  // local dev server never needs it, so it stays blocked even with allowPrivate.
  if (c === 'invalid' || c === 'reserved' || c === 'link-local') return false;
  return policy.allowPrivate;
}

export class BlockedUrlError extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
    this.name = 'BlockedUrlError';
  }
}

/** Static URL validation performed before any network activity. */
export function assertUrlAllowed(raw: string, policy: NetPolicy): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BlockedUrlError('Invalid URL', raw);
  }
  if (!policy.schemes.includes(u.protocol)) throw new BlockedUrlError(`Scheme not allowed: ${u.protocol}`, raw);
  if (u.username || u.password) throw new BlockedUrlError('URLs with embedded credentials are not allowed', raw);
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  if (policy.ports.length && !policy.ports.includes(port)) throw new BlockedUrlError(`Port not allowed: ${port}`, raw);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !isAddressAllowed(host, policy)) {
    throw new BlockedUrlError(`Address not allowed (${classifyAddress(host)}): ${host}`, raw);
  }
  // A trailing dot is the same DNS name ("localhost." resolves like "localhost").
  const lower = host.toLowerCase().replace(/\.+$/, '');
  if (!policy.allowPrivate && (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.internal') || lower.endsWith('.local'))) {
    throw new BlockedUrlError(`Local hostname not allowed: ${host}`, raw);
  }
  return u;
}
