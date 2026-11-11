import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import type { LookupFunction } from 'node:net';
import { BlockedUrlError, classifyAddress, hostPolicyViolation, isAddressAllowed, type NetPolicy } from './ssrf.js';

/**
 * Upstream (corporate) proxy, CONNECT only (docs/design/proxy.md, approved 2026-11-11).
 *
 * - Every proxied request, `http:` and `https:`, goes through a `CONNECT host:port` tunnel; TLS runs end to end.
 * - The SSRF policy is checked on the target before `CONNECT`: private, loopback and reserved targets are never
 *   sent through the proxy (with --allow-private they go direct), and host names are pre-resolved locally.
 * - The proxy endpoint may be private (it was configured explicitly) but never link-local / metadata.
 * - Credentials are sent only to the proxy and never appear in reports, events or errors.
 */
export interface UpstreamProxy {
  protocol: 'http:' | 'https:';
  host: string;
  port: number;
  /** Basic credentials `user:password` for Proxy-Authorization; never logged. */
  auth?: string;
  /**
   * `proxy`: CONNECT by host name after a local pre-resolution check (default). `local`: CONNECT to the address
   * Searvex resolved and validated (strict; breaks host-filtering proxies).
   */
  resolve: 'proxy' | 'local';
  /**
   * The user passed `--proxy-resolve proxy` explicitly: a target whose name cannot be resolved locally (a DNS-less
   * sandbox) is sent to the proxy without the local check.
   */
  allowUnresolved: boolean;
  /** NO_PROXY entries: host suffixes, exact hosts or IPs, `host:port`, or `*`. */
  noProxy: string[];
  /** Where the setting came from (`--proxy`, `HTTPS_PROXY`, …), for messages. */
  source: string;
}

/** A proxy setting that cannot be used (exit 2). */
export class ProxyConfigError extends Error {}

/** The proxy could not be used for a request. The message starts with "Proxy …" (see the CLI's exit mapping). */
export class ProxyError extends Error {
  constructor(
    readonly kind: 'unreachable' | 'auth' | 'refused',
    message: string,
  ) {
    super(message);
    this.name = 'ProxyError';
  }
}

/** `host:port` of the proxy, without credentials: safe to show in reports and messages. */
export function proxyEndpoint(p: Pick<UpstreamProxy, 'host' | 'port'>): string {
  return `${net.isIPv6(p.host) ? `[${p.host}]` : p.host}:${p.port}`;
}

const ENV_ORDER = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];

/**
 * The upstream proxy from `--proxy` (a URL, or `none`), else from the environment (HTTPS_PROXY, then
 * HTTP_PROXY; NO_PROXY). Returns null when no proxy is configured.
 */
export function proxyFromConfig(o: { flag?: string; resolve?: string; env?: Record<string, string | undefined>; policy?: Pick<NetPolicy, 'denyHosts' | 'allowHosts'> }): UpstreamProxy | null {
  const env = o.env ?? {};
  if (o.resolve !== undefined && o.resolve !== 'proxy' && o.resolve !== 'local') throw new ProxyConfigError(`--proxy-resolve must be proxy or local (got ${o.resolve})`);
  if (o.flag === 'none') return null;
  const fromEnv = o.flag === undefined ? ENV_ORDER.find((k) => env[k]?.trim()) : undefined;
  const raw = o.flag ?? (fromEnv ? env[fromEnv]!.trim() : undefined);
  if (!raw) {
    if (o.resolve !== undefined) throw new ProxyConfigError('--proxy-resolve needs a proxy (--proxy or HTTPS_PROXY)');
    return null;
  }
  const source = fromEnv ?? '--proxy';
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    throw new ProxyConfigError(`${source} is not a valid proxy URL`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ProxyConfigError(`${source}: only http:// and https:// proxies are supported (got ${u.protocol})`);
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) throw new ProxyConfigError(`${source} must be a proxy origin such as http://proxy.example:3128 (no path)`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    const cls = classifyAddress(host);
    if (cls === 'link-local' || cls === 'reserved' || cls === 'invalid') throw new ProxyConfigError(`${source} points at a ${cls} address (${host}); a proxy there is never used`);
  }
  const violation = hostPolicyViolation(host, { denyHosts: o.policy?.denyHosts } as NetPolicy);
  if (violation) throw new ProxyConfigError(`${source}: ${violation}`);
  const user = decodeURIComponent(u.username);
  const pass = decodeURIComponent(u.password);
  const noProxy = (env['NO_PROXY'] ?? env['no_proxy'] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return {
    protocol: u.protocol,
    host,
    port: u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80,
    ...(user || pass ? { auth: `${user}:${pass}` } : {}),
    resolve: o.resolve === 'local' ? 'local' : 'proxy',
    allowUnresolved: o.resolve === 'proxy',
    noProxy,
    source,
  };
}

/** Whether NO_PROXY sends `host:port` direct (curl semantics: `example.com` also matches its subdomains). */
export function noProxyMatches(host: string, port: number, entries: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  for (const raw of entries) {
    if (raw === '*') return true;
    let entry = raw;
    let entryPort: string | undefined;
    const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(raw);
    if (bracketed) [, entry, entryPort] = bracketed as unknown as [string, string, string | undefined];
    else if (!net.isIPv6(raw)) {
      const m = /^(.+):(\d+)$/.exec(raw);
      if (m) [, entry, entryPort] = m as unknown as [string, string, string];
    }
    if (entryPort && Number(entryPort) !== port) continue;
    const e = entry.replace(/^\*?\./, '').replace(/\.+$/, '');
    if (h === e || h.endsWith(`.${e}`)) return true;
  }
  return false;
}

export type Route = { via: 'direct' } | { via: 'proxy'; proxy: UpstreamProxy; connectHost: string; checked: boolean };

type Lookup = (host: string) => Promise<string[]>;
const systemLookup: Lookup = (host) => dns.promises.lookup(host, { all: true }).then((l) => l.map((a) => a.address));

/**
 * How a request to `host:port` leaves Searvex. Call it after `assertUrlAllowed` (scheme, ports, host lists).
 * Private, loopback and reserved targets never use the proxy: they go direct (where the policy then applies) or
 * are blocked. Host names are resolved locally first; any non-public answer keeps them off the proxy.
 */
export async function routeFor(host: string, port: number, policy: NetPolicy, lookup: Lookup = systemLookup): Promise<Route> {
  const proxy = policy.upstream;
  const h = host.replace(/^\[|\]$/g, '');
  if (!proxy || noProxyMatches(h, port, proxy.noProxy)) return { via: 'direct' };
  if (net.isIP(h)) {
    // Only public addresses go through the proxy; the others go direct, where the policy blocks or allows them.
    return classifyAddress(h) === 'public' ? { via: 'proxy', proxy, connectHost: h, checked: true } : { via: 'direct' };
  }
  let addresses: string[];
  try {
    addresses = await lookup(h);
  } catch (e) {
    if (proxy.resolve === 'proxy' && proxy.allowUnresolved) return { via: 'proxy', proxy, connectHost: h, checked: false };
    throw e;
  }
  const nonPublic = addresses.filter((a) => classifyAddress(a) !== 'public');
  if (nonPublic.length) {
    // A local or internal name: never through the proxy. With --allow-private it goes direct.
    const bad = nonPublic.find((a) => !isAddressAllowed(a, policy));
    if (bad) throw new BlockedUrlError(`Resolved address not allowed (${classifyAddress(bad)}): ${bad}`, h);
    return { via: 'direct' };
  }
  if (!addresses.length) throw new Error(`No address for ${h}`);
  return { via: 'proxy', proxy, connectHost: proxy.resolve === 'local' ? addresses[0]! : h, checked: true };
}

/** DNS lookup for the proxy endpoint itself: private is fine (explicit configuration), link-local never. */
const proxyLookup: LookupFunction = ((hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
  dns.lookup(hostname, { ...options, all: true }, (err, list) => {
    if (err) return callback(err);
    const addresses = list as dns.LookupAddress[];
    const bad = addresses.find((a) => ['link-local', 'reserved', 'invalid'].includes(classifyAddress(a.address)));
    if (bad) return callback(new ProxyError('unreachable', `Proxy address not allowed (${classifyAddress(bad.address)}): ${bad.address}`));
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
}) as LookupFunction;

/**
 * Open a CONNECT tunnel to `connectHost:port` through the proxy. Resolves with the raw tunnel socket; the caller
 * runs TLS over it for https targets.
 */
export function openTunnel(proxy: UpstreamProxy, connectHost: string, port: number, timeoutMs: number): Promise<net.Socket> {
  const endpoint = proxyEndpoint(proxy);
  const authority = `${net.isIPv6(connectHost) ? `[${connectHost}]` : connectHost}:${port}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const opts = { host: proxy.host, port: proxy.port, lookup: proxyLookup };
    const socket: net.Socket =
      proxy.protocol === 'https:' ? tls.connect({ ...opts, servername: net.isIP(proxy.host) ? undefined : proxy.host }) : net.connect(opts);
    const fail = (e: ProxyError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(e);
    };
    const timer = setTimeout(() => fail(new ProxyError('unreachable', `Proxy unreachable (${endpoint}): no answer to CONNECT within ${timeoutMs} ms`)), timeoutMs);
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buf.length > 16 * 1024) fail(new ProxyError('refused', `Proxy refused CONNECT to ${authority}: oversized response (proxy ${endpoint})`));
        return;
      }
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(buf.subarray(0, end).toString('latin1'))?.[1] ?? 0);
      if (status === 407) return fail(new ProxyError('auth', `Proxy authentication failed (${endpoint}, HTTP 407)`));
      if (status < 200 || status > 299) return fail(new ProxyError('refused', `Proxy refused CONNECT to ${authority} (HTTP ${status || 'invalid response'}, proxy ${endpoint})`));
      settled = true;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      const rest = buf.subarray(end + 4);
      if (rest.length) socket.unshift(rest);
      resolve(socket);
    };
    const onError = (e: Error) => fail(e instanceof ProxyError ? e : new ProxyError('unreachable', `Proxy unreachable (${endpoint}): ${(e as NodeJS.ErrnoException).code ?? e.message}`));
    socket.on('error', onError);
    socket.on('data', onData);
    socket.once(proxy.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
      const auth = proxy.auth ? `Proxy-Authorization: Basic ${Buffer.from(proxy.auth).toString('base64')}\r\n` : '';
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}\r\n`);
    });
  });
}

/** TLS over a tunnel to an https target: SNI and certificate checks against the real host name. */
export function tlsOverTunnel(tunnel: net.Socket, hostname: string): tls.TLSSocket {
  const host = hostname.replace(/^\[|\]$/g, '');
  return tls.connect({ socket: tunnel, host, servername: net.isIP(host) ? undefined : host, ALPNProtocols: ['http/1.1'] });
}

/** What a report says about the proxy: endpoint and resolution mode, never credentials. */
export function proxySummary(p: UpstreamProxy): { endpoint: string; resolve: 'proxy' | 'local'; unresolvedAllowed: boolean } {
  return { endpoint: proxyEndpoint(p), resolve: p.resolve, unresolvedAllowed: p.allowUnresolved };
}

/** Lookup override for tests (dependency injection without touching DNS). */
export type { Lookup as ProxyLookup };
