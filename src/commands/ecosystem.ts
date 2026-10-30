import fs from 'node:fs';
import path from 'node:path';
import { analyzeCrawl, type AuditReport } from '../analyze/audit.js';
import { crawl, type PageRecord } from '../crawl/crawler.js';
import { RunStore } from '../crawl/store.js';
import { loadKnowledge } from '../rules/engine.js';
import { md } from '../report/markdown.js';
import { renderEcosystemHtml } from '../report/html.js';
import { crawlOptionsFrom, log, num, UsageError, type GlobalFlags } from '../cli.js';

/**
 * Brand-family / product-ecosystem analysis across several related sites.
 * Everything here is derived from crawled pages: structured data, links and on-page terms.
 * Observations are labelled `verified` (directly observed) or `heuristic` (inference).
 */
export interface SiteSnapshot {
  host: string;
  url: string;
  report: AuditReport;
  /** Outbound link counts to other hosts (from crawled HTML pages). */
  outbound: Record<string, number>;
  siteNames: string[];
  orgNames: string[];
  parents: Array<{ name: string; url?: string }>;
  children: Array<{ name: string; url?: string; relation: string }>;
  terms: string[];
}

export interface EcosystemObservation {
  kind: 'entity' | 'linking' | 'overlap' | 'shared-issue' | 'coverage';
  confidence: 'verified' | 'heuristic';
  message: string;
  sites: string[];
  recommendation?: string;
}

export interface EcosystemReport {
  sites: Array<{
    host: string; siteName: string; organization: string; parent: string; children: string[]; model: string;
    languages: string[]; pages: number; score: number; offerings: string[];
  }>;
  links: Record<string, Record<string, number>>;
  overlap: Array<{ a: string; b: string; similarity: number; shared: string[] }>;
  sharedIssues: Array<{ ruleId: string; title: string; severity: string; sites: number; pages: number }>;
  observations: EcosystemObservation[];
  limitations: string[];
}

const hostOf = (u: string) => new URL(u).hostname.replace(/^www\./, '');
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export function snapshot(report: AuditReport, pages: PageRecord[]): SiteSnapshot {
  const host = hostOf(report.target);
  const outbound: Record<string, number> = {};
  for (const p of pages) {
    if (p.status !== 200 || p.redirects.length || !p.data) continue;
    for (const l of (p.rendered ?? p.data).links) {
      if (!l.url || l.internal) continue;
      const h = hostOf(l.url);
      if (h !== host) outbound[h] = (outbound[h] ?? 0) + 1;
    }
  }
  const siteNames = new Set<string>();
  const orgNames = new Set<string>();
  for (const p of pages) {
    const f = p.rendered ?? p.data;
    if (!f || p.status !== 200 || p.redirects.length) continue;
    if (f.openGraph['og:site_name']) siteNames.add(f.openGraph['og:site_name'].trim());
    for (const b of f.jsonLd) {
      const data = b.data as Record<string, unknown> | unknown[] | null;
      const roots = Array.isArray(data) ? data : data && Array.isArray((data as Record<string, unknown>)['@graph']) ? ((data as Record<string, unknown>)['@graph'] as unknown[]) : [data];
      for (const n of roots) {
        if (!n || typeof n !== 'object') continue;
        const node = n as Record<string, unknown>;
        const t = ([] as unknown[]).concat(node['@type'] ?? []);
        if (typeof node['name'] !== 'string') continue;
        if (t.includes('WebSite')) siteNames.add(node['name'].trim());
        else if (t.some((x) => typeof x === 'string' && /Organization|Corporation/.test(x))) orgNames.add(node['name'].trim());
      }
    }
  }
  const rel = report.inventory.relations ?? [];
  return {
    host,
    url: report.target,
    report,
    outbound,
    siteNames: [...siteNames],
    orgNames: [...orgNames],
    parents: rel.filter((r) => r.relation === 'parentOrganization' || r.relation === 'memberOf').map((r) => ({ name: r.to, url: r.toUrl })),
    children: rel.filter((r) => ['subOrganization', 'brand', 'owns', 'department'].includes(r.relation) && norm(r.to) !== norm(r.from)).map((r) => ({ name: r.to, url: r.toUrl, relation: r.relation })),
    terms: report.content.topTerms.map((t) => t.term).slice(0, 40),
  };
}

export function analyzeEcosystem(snaps: SiteSnapshot[]): EcosystemReport {
  const hosts = snaps.map((s) => s.host);
  const obs: EcosystemObservation[] = [];
  const nameToHost = new Map<string, string>();
  for (const s of snaps) for (const n of [...s.siteNames, ...s.orgNames]) if (!nameToHost.has(norm(n))) nameToHost.set(norm(n), s.host);

  // Entity graph: parents referenced by children, and whether parents reference them back.
  for (const s of snaps) {
    for (const p of s.parents) {
      const parentHost = p.url ? hostOf(p.url) : nameToHost.get(norm(p.name));
      const parent = snaps.find((x) => x.host === parentHost);
      if (!parent) continue;
      if (!parent.orgNames.some((n) => norm(n) === norm(p.name))) {
        obs.push({ kind: 'entity', confidence: 'verified', sites: [s.host, parent.host], message: `${s.host} names its parent "${p.name}", but ${parent.host} declares its organisation as ${parent.orgNames.map((n) => `"${n}"`).join(', ') || '(none)'}.`, recommendation: 'Use the same organisation name and URL on both sites.' });
      }
      const declared = parent.children.some((c) => (c.url && hostOf(c.url) === s.host) || s.siteNames.concat(s.orgNames).some((n) => norm(n) === norm(c.name)));
      if (!declared) {
        obs.push({ kind: 'entity', confidence: 'verified', sites: [parent.host, s.host], message: `${s.host} declares parentOrganization "${p.name}", but ${parent.host} does not reference ${s.siteNames[0] ?? s.host} in its structured data (subOrganization / brand / owns).`, recommendation: `On ${parent.host}, describe the relationship from the parent side too (schema.org subOrganization or brand on the Organization node), using names and URLs that match the product sites. This makes the family explicit to search engines and AI systems; it is not a rich-result feature.` });
      }
    }
    if (!s.orgNames.length) obs.push({ kind: 'entity', confidence: 'verified', sites: [s.host], message: `${s.host} has no top-level Organization markup on the crawled pages.`, recommendation: 'Add Organization structured data (name, url, logo, parentOrganization where applicable).' });
    else {
      const own = s.orgNames.filter((n) => s.siteNames.some((sn) => norm(sn) === norm(n)));
      // Publishing under the parent company's Organization is a legitimate pattern: accept the declared
      // parent name and the organisation name the parent site itself uses.
      const parentNames = new Set(s.parents.flatMap((p) => {
        const ph = p.url ? hostOf(p.url) : nameToHost.get(norm(p.name));
        return [norm(p.name), ...(snaps.find((x) => x.host === ph)?.orgNames ?? []).map(norm)];
      }));
      const other = s.orgNames.filter((n) => !own.includes(n) && !parentNames.has(norm(n)));
      if (!own.length && other.length) obs.push({ kind: 'entity', confidence: 'verified', sites: [s.host], message: `${s.host} (site name ${s.siteNames.map((n) => `"${n}"`).join(', ') || 'unknown'}) describes its Organization as ${other.map((n) => `"${n}"`).join(', ')} — another family member's name.`, recommendation: 'Use the product\'s own Organization (or Brand) node and reference the company via parentOrganization.' });
    }
  }

  // Cross-linking matrix and gaps.
  const links: Record<string, Record<string, number>> = {};
  for (const s of snaps) {
    links[s.host] = {};
    for (const h of hosts) if (h !== s.host) links[s.host]![h] = s.outbound[h] ?? 0;
  }
  const parentHosts = new Set(snaps.flatMap((s) => s.parents.map((p) => (p.url ? hostOf(p.url) : nameToHost.get(norm(p.name)))).filter((x): x is string => !!x)));
  for (const ph of parentHosts) {
    const parent = snaps.find((s) => s.host === ph);
    if (!parent) continue;
    const missing = snaps.filter((s) => s.host !== ph && !(links[ph]?.[s.host] ?? 0));
    if (missing.length) obs.push({ kind: 'linking', confidence: 'verified', sites: [ph, ...missing.map((m) => m.host)], message: `${ph} has no crawled links to ${missing.map((m) => m.host).join(', ')}.`, recommendation: 'Link the parent site to every product with descriptive anchor text so the family is discoverable.' });
    const noBack = snaps.filter((s) => s.host !== ph && !(links[s.host]?.[ph] ?? 0));
    if (noBack.length) obs.push({ kind: 'linking', confidence: 'verified', sites: noBack.map((m) => m.host), message: `${noBack.map((m) => m.host).join(', ')} do not link back to ${ph} on the crawled pages.`, recommendation: 'Add a visible link to the parent company (e.g. footer "part of …").' });
  }

  // Topic overlap between sites in the same primary language (potential cross-domain competition).
  const overlap: EcosystemReport['overlap'] = [];
  const primaryLang = (s: SiteSnapshot) => Object.entries(s.report.inventory.languages).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  const brandTerms = new Set(snaps.flatMap((s) => [...s.siteNames, ...s.orgNames, s.host.split('.')[0]!].map((n) => n.toLowerCase())));
  for (let i = 0; i < snaps.length; i++)
    for (let j = i + 1; j < snaps.length; j++) {
      const a = snaps[i]!, b = snaps[j]!;
      if (primaryLang(a) !== primaryLang(b)) continue;
      const ta = new Set(a.terms.filter((t) => !brandTerms.has(t)));
      const tb = new Set(b.terms.filter((t) => !brandTerms.has(t)));
      const shared = [...ta].filter((t) => tb.has(t));
      const sim = shared.length / Math.max(1, ta.size + tb.size - shared.length);
      overlap.push({ a: a.host, b: b.host, similarity: Math.round(sim * 100) / 100, shared: shared.slice(0, 12) });
    }
  overlap.sort((x, y) => y.similarity - x.similarity);
  for (const o of overlap.filter((x) => x.similarity >= 0.35)) {
    obs.push({ kind: 'overlap', confidence: 'heuristic', sites: [o.a, o.b], message: `${o.a} and ${o.b} share ${Math.round(o.similarity * 100)}% of their prominent terms (${o.shared.slice(0, 6).join(', ')}).`, recommendation: 'Check in Search Console whether both sites rank for the same queries; give each product a distinct primary topic and cross-link instead of duplicating explanations.' });
  }

  // Issues shared by most of the family usually come from a shared template or codebase.
  const byRule = new Map<string, { title: string; severity: string; sites: number; pages: number }>();
  for (const s of snaps) for (const f of s.report.findings) {
    if (f.severity === 'info' || f.confidence === 'unmeasurable') continue;
    const e = byRule.get(f.ruleId) ?? { title: f.title, severity: f.severity, sites: 0, pages: 0 };
    e.sites++;
    e.pages += f.count;
    byRule.set(f.ruleId, e);
  }
  const sharedIssues = [...byRule.entries()].filter(([, e]) => e.sites >= Math.max(2, Math.ceil(snaps.length / 2))).map(([ruleId, e]) => ({ ruleId, ...e })).sort((a, b) => b.sites - a.sites || b.pages - a.pages);
  for (const i of sharedIssues.filter((x) => x.severity === 'critical' || x.severity === 'high' || x.severity === 'medium')) {
    obs.push({ kind: 'shared-issue', confidence: 'heuristic', sites: snaps.filter((s) => s.report.findings.some((f) => f.ruleId === i.ruleId)).map((s) => s.host), message: `"${i.title}" (${i.ruleId}) appears on ${i.sites} of ${snaps.length} sites (${i.pages} pages) — likely a shared template or component.`, recommendation: 'Fix it once in the shared layout/package and re-audit all sites.' });
  }

  // Language coverage.
  const langs = snaps.map((s) => ({ host: s.host, langs: s.report.inventory.hreflangLanguages.filter((l) => l !== 'x-default') }));
  const all = new Set(langs.flatMap((l) => l.langs));
  for (const l of langs) {
    const missing = [...all].filter((x) => !l.langs.includes(x));
    if (all.size > 1 && missing.length && l.langs.length) obs.push({ kind: 'coverage', confidence: 'verified', sites: [l.host], message: `${l.host} has no ${missing.join(', ')} alternate while other family sites do.`, recommendation: 'Decide per product whether the market needs that language; if yes, add localized pages with reciprocal hreflang.' });
    if (all.size > 1 && !l.langs.length) obs.push({ kind: 'coverage', confidence: 'verified', sites: [l.host], message: `${l.host} declares no hreflang alternates while other family sites are multilingual (${[...all].join(', ')}).`, recommendation: 'If localized versions exist or are planned, connect them with hreflang.' });
  }

  return {
    sites: snaps.map((s) => ({
      host: s.host,
      siteName: s.siteNames.join(' / ') || '—',
      organization: s.orgNames.join(' / ') || '—',
      parent: s.parents.map((p) => p.name).join(', ') || '—',
      children: s.children.map((c) => c.name),
      model: `${s.report.inventory.businessModel.label}${s.report.inventory.businessModel.confidence ? ` (${s.report.inventory.businessModel.confidence})` : ''}`,
      languages: Object.keys(s.report.inventory.languages),
      pages: s.report.crawl.crawled,
      score: s.report.scores.overall,
      offerings: (s.report.inventory.offerings ?? []).map((o) => `${o.kind}: ${o.name}`),
    })),
    links,
    overlap,
    sharedIssues,
    observations: obs,
    limitations: [
      'Based on the crawled pages of each site (page limits apply); links and markup on uncrawled pages are not seen.',
      'Topic overlap compares on-page term statistics; it does not show search demand or actual ranking competition — confirm with Search Console.',
    ],
  };
}

export function renderEcosystemMarkdown(r: EcosystemReport): string {
  const L: string[] = ['# Searvex ecosystem analysis', ''];
  L.push('## Sites', '', '| Site | Site name | Organization | Parent | Declares children | Model (heuristic) | Languages | Pages | Score |', '|---|---|---|---|---|---|---|---|---|');
  for (const s of r.sites) L.push(`| ${md(s.host)} | ${md(s.siteName)} | ${md(s.organization)} | ${md(s.parent)} | ${s.children.map(md).join(', ') || '—'} | ${md(s.model)} | ${s.languages.map(md).join(', ')} | ${s.pages} | ${s.score} |`);
  L.push('', '## Cross-links (links from row site to column site, crawled pages)', '');
  const hosts = r.sites.map((s) => s.host);
  L.push(`| from \\ to | ${hosts.map(md).join(' | ')} |`, `|---|${hosts.map(() => '---').join('|')}|`);
  for (const h of hosts) L.push(`| ${md(h)} | ${hosts.map((t) => (t === h ? '·' : String(r.links[h]?.[t] ?? 0))).join(' | ')} |`);
  L.push('', '## Observations', '');
  if (!r.observations.length) L.push('_No ecosystem issues found._');
  for (const kind of ['entity', 'linking', 'shared-issue', 'overlap', 'coverage'] as const) {
    const list = r.observations.filter((o) => o.kind === kind);
    if (!list.length) continue;
    L.push(`### ${{ entity: 'Entity & brand graph', linking: 'Cross-linking', 'shared-issue': 'Issues shared across the family', overlap: 'Topic overlap', coverage: 'Language coverage' }[kind]}`, '');
    for (const o of list) L.push(`- ${o.confidence === 'heuristic' ? '~ ' : ''}${md(o.message)}${o.recommendation ? `\n  - **Recommendation:** ${md(o.recommendation)}` : ''}`);
    L.push('');
  }
  if (r.overlap.length) {
    L.push('## Topic similarity (same primary language)', '', '| Sites | Similarity | Shared prominent terms |', '|---|---|---|');
    for (const o of r.overlap.slice(0, 15)) L.push(`| ${md(o.a)} ↔ ${md(o.b)} | ${Math.round(o.similarity * 100)}% | ${o.shared.slice(0, 8).map(md).join(', ')} |`);
    L.push('');
  }
  L.push('## Limitations', '', ...r.limitations.map((l) => `- ${md(l)}`), '', '`~` marks heuristic observations.', '');
  return L.join('\n');
}

function reuseLatest(workspace: string, url: string): { report: AuditReport; pages: PageRecord[] } | null {
  const target = new URL(url).toString();
  for (const id of RunStore.list(workspace).reverse()) {
    const store = new RunStore(workspace, id);
    const report = store.readJson<AuditReport>('report.json');
    if (report?.mode === 'website' && hostOf(report.target) === hostOf(target)) {
      const pages = store.readLines<PageRecord>('pages.jsonl');
      if (pages.length) return { report, pages };
    }
  }
  return null;
}

export async function commandEcosystem(flags: GlobalFlags): Promise<number> {
  const v = flags.values;
  const urls = flags.positionals.slice(1);
  if (urls.length < 2) throw new UsageError('ecosystem requires at least two site URLs');
  if (urls.length > 20) throw new UsageError('At most 20 sites');
  for (const u of urls) if (!/^https?:\/\//i.test(u)) throw new UsageError(`Invalid URL: ${u}`);
  const kb = loadKnowledge();
  const workspace = path.resolve(String(v['out'] ?? process.cwd()));
  const opts = { ...crawlOptionsFrom(v), maxPages: num(v['max-pages'], 60, 1, 100000) };
  // Sites are different hosts, so they can be crawled in parallel without weakening per-host politeness.
  const snaps: SiteSnapshot[] = new Array(urls.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < urls.length; i = next++) {
      const u = urls[i]!;
      const reused = v['reuse'] ? reuseLatest(workspace, u) : null;
      if (reused) {
        log(v, `Reusing stored run for ${u}`);
        snaps[i] = snapshot(reused.report, reused.pages);
        continue;
      }
      log(v, `Crawling ${u} (max ${opts.maxPages} pages)…`);
      const store = new RunStore(workspace, RunStore.newRunId('audit'));
      const result = await crawl(u, opts, store);
      const report = await analyzeCrawl(result, kb, { ...opts, probes: false });
      report.runId = store.runId;
      store.writeJson('report.json', report);
      snaps[i] = snapshot(report, result.pages);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, urls.length) }, worker));
  const eco = analyzeEcosystem(snaps);
  const store = new RunStore(workspace, RunStore.newRunId('ecosystem'));
  store.writeJson('meta.json', { kind: 'ecosystem', sites: urls, startedAt: new Date().toISOString() });
  store.writeJson('ecosystem.json', eco);
  const out = store.writeText('ecosystem.md', renderEcosystemMarkdown(eco));
  store.writeText('ecosystem.html', renderEcosystemHtml(eco));
  if (v['json']) process.stdout.write(JSON.stringify(eco, null, 2) + '\n');
  else if (!v['quiet']) console.log(renderEcosystemMarkdown(eco) + `\nSaved: ${out}`);
  if (!fs.existsSync(out)) return 2;
  return 0;
}
