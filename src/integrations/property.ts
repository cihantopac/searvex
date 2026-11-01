import type { AuditReport } from '../analyze/audit.js';
import { RunStore } from '../crawl/store.js';

/**
 * Search-property scope: which URLs a Search Console / Bing property covers, and which Searvex audit may
 * be joined with its data. Joining performance data with an audit of another website silently produces
 * wrong findings, so every join goes through `selectAuditForProperty`.
 *
 * Search Console semantics (https://support.google.com/webmasters/answer/34592):
 * - Domain property `sc-domain:example.com`: every protocol, every subdomain, every path.
 * - URL-prefix property `https://www.example.com/shop/`: only URLs that start with exactly that prefix
 *   (protocol and host included; `www` and non-`www` are different properties).
 * Bing Webmaster sites are registered per host; Searvex treats them as host + path prefix, any protocol.
 */
export type SearchProperty =
  | { kind: 'domain'; raw: string; domain: string }
  | { kind: 'url-prefix'; raw: string; protocol: string; host: string; path: string; anyProtocol: boolean };

export class PropertyError extends Error {}

export function parseProperty(raw: string, opts: { anyProtocol?: boolean } = {}): SearchProperty {
  const s = raw.trim();
  const dm = /^sc-domain:(.+)$/i.exec(s);
  if (dm) {
    const domain = dm[1]!.trim().toLowerCase().replace(/\.$/, '');
    if (!/^[a-z0-9.-]+\.[a-z0-9-]+$/i.test(domain) || domain.includes('..')) throw new PropertyError(`Invalid domain property: ${raw}`);
    return { kind: 'domain', raw: s, domain };
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new PropertyError(`Invalid property "${raw}": use sc-domain:example.com or a URL prefix such as https://example.com/`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new PropertyError(`Invalid property protocol: ${raw}`);
  return { kind: 'url-prefix', raw: s, protocol: u.protocol, host: u.host.toLowerCase(), path: u.pathname || '/', anyProtocol: !!opts.anyProtocol };
}

/** True when `url` belongs to the property's scope. */
export function urlInProperty(url: string, p: SearchProperty): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (p.kind === 'domain') {
    const h = u.hostname.toLowerCase();
    return h === p.domain || h.endsWith(`.${p.domain}`);
  }
  if (!p.anyProtocol && u.protocol !== p.protocol) return false;
  return u.host.toLowerCase() === p.host && u.pathname.startsWith(p.path);
}

export function describeProperty(p: SearchProperty): string {
  return p.kind === 'domain' ? `domain property ${p.domain} (all subdomains and protocols)` : `URL-prefix property ${p.anyProtocol ? '' : p.protocol + '//'}${p.host}${p.path}`;
}

export interface AuditPropertyMatch {
  /** Share of crawled pages inside the property (0–1). */
  coverage: number;
  pages: number;
  /** Most common host among the crawled pages (the site the audit actually describes). */
  primaryHost: string | null;
  matches: boolean;
  reason: string;
}

/** Minimum share of an audit's pages that must fall inside the property for a join. */
const MIN_COVERAGE = 0.5;

export function matchAuditToProperty(audit: Pick<AuditReport, 'target' | 'crawl' | 'inventory'>, p: SearchProperty): AuditPropertyMatch {
  const urls = (audit.inventory?.pages ?? []).map((x) => x.url);
  const hosts = new Map<string, number>();
  for (const url of urls) {
    try {
      const h = new URL(url).host.toLowerCase();
      hosts.set(h, (hosts.get(h) ?? 0) + 1);
    } catch {
      /* ignore */
    }
  }
  const primaryHost = [...hosts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? safeHost(audit.crawl?.startUrl ?? audit.target);
  if (!urls.length) {
    const start = audit.crawl?.startUrl ?? audit.target;
    const ok = urlInProperty(start, p);
    return { coverage: ok ? 1 : 0, pages: 0, primaryHost, matches: ok, reason: ok ? 'start URL inside the property (no pages crawled)' : `start URL ${start} is outside the ${describeProperty(p)}` };
  }
  const inside = urls.filter((u) => urlInProperty(u, p)).length;
  const coverage = inside / urls.length;
  const matches = coverage >= MIN_COVERAGE;
  return {
    coverage,
    pages: urls.length,
    primaryHost,
    matches,
    reason: matches ? `${inside}/${urls.length} crawled pages inside the property` : `only ${inside}/${urls.length} crawled pages (host ${primaryHost}) are inside the ${describeProperty(p)}`,
  };
}

/** Throws when the audit does not describe a site inside the property. */
export function assertAuditInProperty(audit: Pick<AuditReport, 'target' | 'crawl' | 'inventory'>, p: SearchProperty, source: string): AuditPropertyMatch {
  const match = matchAuditToProperty(audit, p);
  if (!match.matches) throw new PropertyError(`${source} belongs to the ${describeProperty(p)}, but the audit of ${audit.target} does not: ${match.reason}. Search data of another website is never combined with this audit.`);
  return match;
}

/** Hosts in a list of page URLs, most common first. */
export function hostsOf(urls: string[]): Array<{ host: string; pages: number }> {
  const m = new Map<string, number>();
  for (const url of urls) {
    const h = safeHost(url);
    if (h) m.set(h, (m.get(h) ?? 0) + 1);
  }
  return [...m].map(([host, pages]) => ({ host, pages })).sort((a, b) => b.pages - a.pages);
}

/**
 * Property of an imported export (Search Console CSV/ZIP). Exports carry no property name, so the scope comes
 * from an explicit `raw` property (checked against the pages table when there is one) or, without it, from
 * the single host in the pages table. Returns undefined when neither is available: the export can then not be
 * attributed to any website.
 */
export function propertyForExport(raw: string | undefined, pageUrls: string[] | undefined): SearchProperty | undefined {
  const urls = pageUrls ?? [];
  const hosts = hostsOf(urls);
  if (raw) {
    const p = parseProperty(raw);
    if (urls.length) {
      // Search Console exports contain only URLs of their own property, so a single page outside the stated
      // property means the export comes from another (usually broader) property and its totals would be
      // attributed to the wrong scope.
      const outside = urls.filter((u) => !urlInProperty(u, p));
      if (outside.length === urls.length) throw new PropertyError(`The export's pages (${hosts.slice(0, 3).map((h) => h.host).join(', ')}) do not belong to the ${describeProperty(p)}. Check that you exported the right property.`);
      if (outside.length) {
        let hint = '';
        try {
          hint = ` It looks like an export of ${propertyForExport(undefined, urls)?.raw ?? 'another property'}.`;
        } catch {
          /* several sites: no hint */
        }
        throw new PropertyError(`${outside.length} of ${urls.length} pages in the export are outside the ${describeProperty(p)} (e.g. ${outside[0]}), so it was not exported from that property.${hint}`);
      }
    }
    return p;
  }
  if (!hosts.length) return undefined;
  if (hosts.length === 1) return parseProperty(`https://${hosts[0]!.host}/`, { anyProtocol: true });
  // A URL-prefix property covers exactly one host, so pages of several hosts can only come from a domain
  // property: its totals include every subdomain, and the scope must say so.
  const domain = commonDomain(hosts.map((h) => h.host));
  if (!domain) throw new PropertyError(`The export contains pages from several sites (${hosts.slice(0, 5).map((h) => h.host).join(', ')}): pass --property (e.g. sc-domain:example.com).`);
  return parseProperty(`sc-domain:${domain}`);
}

/** Second-level labels under country-code TLDs that are registries, not sites (com.tr, co.uk, org.au …). */
const REGISTRY_SLD = new Set(['ac', 'av', 'bbs', 'bel', 'biz', 'co', 'com', 'dr', 'edu', 'gen', 'gov', 'info', 'k12', 'ltd', 'mil', 'name', 'ne', 'net', 'nom', 'or', 'org', 'plc', 'pol', 'sch', 'tel', 'tv', 'web']);

/**
 * Longest common DNS suffix of `hosts` that is a registrable domain (`shop.example.com` + `example.com` →
 * `example.com`), or null when the hosts only share a public suffix (`a.com.tr` + `b.com.tr`). Without a full
 * public-suffix list this is conservative: ambiguous cases return null and ask for --property.
 */
export function commonDomain(hosts: string[]): string | null {
  const split = hosts.map((h) => h.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '').split('.').reverse());
  const common: string[] = [];
  for (let i = 0; ; i++) {
    const label = split[0]![i];
    if (label === undefined || !split.every((s) => s[i] === label)) break;
    common.push(label);
  }
  if (common.length < 2) return null;
  const [tld, sld] = common;
  if (common.length === 2 && tld!.length === 2 && REGISTRY_SLD.has(sld!)) return null;
  return common.reverse().join('.');
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

export interface SelectedAudit {
  runId: string;
  audit: AuditReport;
  match: AuditPropertyMatch;
}

/**
 * Resolve `--audit latest|<runId>` for a property. `latest` picks the newest website audit of the same
 * website — never simply the newest audit in the workspace. Mismatches and ambiguous choices throw.
 */
export function selectAuditForProperty(workspace: string, ref: string, p: SearchProperty): SelectedAudit {
  if (ref !== 'latest') {
    const audit = new RunStore(workspace, ref).readJson<AuditReport>('report.json');
    if (!audit || audit.mode !== 'website') throw new PropertyError(`No website audit report found for --audit ${ref}`);
    const match = matchAuditToProperty(audit, p);
    if (!match.matches) throw new PropertyError(`Audit ${ref} (${audit.target}) does not belong to this property: ${match.reason}. Run an audit of this site first or pass the matching run id.`);
    return { runId: ref, audit, match };
  }
  const candidates: SelectedAudit[] = [];
  const others: string[] = [];
  for (const id of RunStore.list(workspace)) {
    const audit = new RunStore(workspace, id).readJson<AuditReport>('report.json');
    if (audit?.mode !== 'website') continue;
    const match = matchAuditToProperty(audit, p);
    if (match.matches) candidates.push({ runId: id, audit, match });
    else others.push(`${id} (${audit.target})`);
  }
  if (!candidates.length) {
    const hint = others.length ? ` Audits in this workspace belong to other sites: ${others.slice(-5).join(', ')}.` : '';
    throw new PropertyError(`No website audit in ${workspace} matches the ${describeProperty(p)}.${hint} Run "searvex audit <url>" for this site first.`);
  }
  const byHost = new Map<string, SelectedAudit[]>();
  for (const c of candidates) {
    const k = c.match.primaryHost ?? '?';
    (byHost.get(k) ?? byHost.set(k, []).get(k)!).push(c);
  }
  if (byHost.size === 1) return candidates.at(-1)!;
  // Domain property with audits of several subdomains: the apex/www site is the natural default.
  if (p.kind === 'domain') {
    const apex = [...byHost].filter(([h]) => h === p.domain || h === `www.${p.domain}`);
    if (apex.length === 1) return apex[0]![1].at(-1)!;
  }
  const list = [...byHost].map(([h, xs]) => `${h}: ${xs.at(-1)!.runId}`).join('; ');
  throw new PropertyError(`Ambiguous --audit latest: audits of several hosts match the ${describeProperty(p)} (${list}). Pass the run id explicitly.`);
}
