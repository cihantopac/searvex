import path from 'node:path';
import { analyzeCrawl, type AuditReport } from '../analyze/audit.js';
import { crawl } from '../crawl/crawler.js';
import { RunStore } from '../crawl/store.js';
import { loadKnowledge } from '../rules/engine.js';
import { md } from '../report/markdown.js';
import { crawlOptionsFrom, log, num, UsageError, type GlobalFlags } from '../cli.js';

export interface SiteProfile {
  url: string;
  pages: number;
  businessModel: string;
  byType: Record<string, number>;
  languages: string[];
  topTerms: string[];
  sections: Array<{ path: string; pages: number }>;
  schemaTypes: string[];
  truncated: boolean;
  /** Topic clusters (first path segment groups labelled by their dominant terms), largest first. */
  clusters: Array<{ key: string; pages: number; terms: string[] }>;
  /** Pages per inferred search intent, with their page types (heuristic: intent follows from the page type). */
  intents: Record<string, { pages: number; types: Record<string, number> }>;
}

export interface ResearchReport {
  target: SiteProfile;
  competitors: SiteProfile[];
  gaps: {
    /** Terms that are prominent on ≥ half of competitors but absent from the target's term set. */
    topics: Array<{ term: string; competitors: number }>;
    /** Page types competitors have that the target lacks. */
    pageTypes: Array<{ type: string; competitors: number }>;
    schemaTypes: Array<{ type: string; competitors: number }>;
    /**
     * Each competitor's topic clusters, marked `covered` when most of the cluster's terms also appear on the target.
     * Hypotheses about coverage, not demand.
     */
    clusters: Array<{ competitor: string; clusters: Array<{ key: string; pages: number; terms: string[]; covered: boolean }> }>;
    /**
     * Pages per search intent on the target and each competitor; `gap` when the target has none and at least half of
     * the competitors do, `missingTypes` = page types most competitors use for that intent and the target lacks.
     */
    intents: Array<{ intent: string; target: number; competitors: number[]; gap: boolean; missingTypes: string[] }>;
  };
  limitations: string[];
}

export function profile(r: AuditReport): SiteProfile {
  return {
    url: r.target,
    pages: r.crawl.crawled,
    businessModel: r.inventory.businessModel.label,
    byType: r.inventory.byType,
    languages: Object.keys(r.inventory.languages),
    topTerms: r.content.topTerms.map((t) => t.term),
    sections: r.inventory.sections,
    // Types actually present on crawled pages (JSON-LD, Microdata, RDFa).
    schemaTypes: (r.inventory.structuredData?.types ?? []).map((t) => t.type),
    truncated: r.crawl.truncated,
    clusters: [...r.content.clusters].sort((a, b) => b.pages.length - a.pages.length).slice(0, 15).map((c) => ({ key: c.key, pages: c.pages.length, terms: c.terms.slice(0, 6) })),
    intents: intentsOf(r),
  };
}

function intentsOf(r: AuditReport): SiteProfile['intents'] {
  const out: SiteProfile['intents'] = {};
  for (const p of r.inventory.pages) {
    if (!p.intent || !p.indexable) continue;
    const e = (out[p.intent] ??= { pages: 0, types: {} });
    e.pages++;
    e.types[p.type] = (e.types[p.type] ?? 0) + 1;
  }
  return out;
}

export function computeGaps(target: SiteProfile, competitors: SiteProfile[], targetAllTerms: Set<string>): ResearchReport['gaps'] {
  const half = Math.max(1, Math.ceil(competitors.length / 2));
  const termCount = new Map<string, number>();
  const typeCount = new Map<string, number>();
  const schemaCount = new Map<string, number>();
  const targetSchema = new Set(target.schemaTypes);
  for (const c of competitors) for (const t of new Set(c.schemaTypes)) schemaCount.set(t, (schemaCount.get(t) ?? 0) + 1);
  for (const c of competitors) {
    for (const t of new Set(c.topTerms.slice(0, 40))) termCount.set(t, (termCount.get(t) ?? 0) + 1);
    for (const t of Object.keys(c.byType)) typeCount.set(t, (typeCount.get(t) ?? 0) + 1);
  }
  const clusters = competitors.map((c) => ({
    competitor: c.url,
    clusters: c.clusters.map((k) => {
      const terms = k.terms.slice(0, 5);
      return { ...k, covered: terms.length > 0 && terms.filter((t) => targetAllTerms.has(t)).length >= Math.ceil(terms.length / 2) };
    }),
  }));
  const intentNames = [...new Set([target, ...competitors].flatMap((p) => Object.keys(p.intents ?? {})))].sort();
  const intents = intentNames.map((intent) => {
    const counts = competitors.map((c) => c.intents?.[intent]?.pages ?? 0);
    const typeCount = new Map<string, number>();
    for (const c of competitors) for (const t of Object.keys(c.intents?.[intent]?.types ?? {})) typeCount.set(t, (typeCount.get(t) ?? 0) + 1);
    const own = target.intents?.[intent];
    return {
      intent,
      target: own?.pages ?? 0,
      competitors: counts,
      gap: !own?.pages && counts.filter((n) => n > 0).length >= half,
      missingTypes: [...typeCount.entries()].filter(([t, n]) => n >= half && !own?.types[t] && t !== 'other').map(([t]) => t).sort(),
    };
  });
  return {
    clusters,
    intents,
    topics: [...termCount.entries()].filter(([t, n]) => n >= half && !targetAllTerms.has(t)).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([term, n]) => ({ term, competitors: n })),
    pageTypes: [...typeCount.entries()].filter(([t, n]) => n >= half && !target.byType[t] && t !== 'other').map(([type, n]) => ({ type, competitors: n })),
    schemaTypes: [...schemaCount.entries()].filter(([t, n]) => n >= half && !targetSchema.has(t)).sort((a, b) => b[1] - a[1]).map(([type, n]) => ({ type, competitors: n })),
  };
}

export function renderResearchMarkdown(r: ResearchReport): string {
  const L: string[] = [`# Searvex research — ${md(r.target.url)}`, ''];
  const row = (p: SiteProfile) => `| ${md(p.url)} | ${p.pages}${p.truncated ? '+' : ''} | ${md(p.businessModel)} | ${Object.entries(p.byType).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, n]) => `${t} ${n}`).join(', ')} | ${p.languages.map(md).join(', ')} | ${p.schemaTypes.slice(0, 8).map(md).join(', ') || '—'} |`;
  L.push('## Site profiles', '', '| Site | Pages | Model (heuristic) | Main page types | Languages | Structured data |', '|---|---|---|---|---|---|', row(r.target), ...r.competitors.map(row), '');
  L.push('## Target topics', '', r.target.topTerms.slice(0, 30).map(md).join(', ') || '—', '');
  if (r.competitors.length) {
    L.push('## Content gaps (competitor topics missing on target)', '', '_Hypotheses from competitor coverage, not verified demand: confirm with Search Console data (`searvex gsc report` / `gsc import`) or your own market knowledge before investing._', '');
    L.push(r.gaps.topics.length ? r.gaps.topics.map((t) => `- **${md(t.term)}** — prominent on ${t.competitors}/${r.competitors.length} competitors`).join('\n') : '_No consistent topic gaps found._', '');
    L.push('## Page-type gaps', '');
    L.push(r.gaps.pageTypes.length ? r.gaps.pageTypes.map((t) => `- **${t.type}** pages exist on ${t.competitors}/${r.competitors.length} competitors`).join('\n') : '_No page-type gaps._', '');
    L.push('## Pages per search intent', '', '_Intent follows from the page type (heuristic). A gap means the target has no page for an intent that most competitors serve._', '');
    L.push(`| Intent | ${md(r.target.url)} | ${r.competitors.map((c) => md(c.url)).join(' | ')} | Types most competitors use, missing on target |`, `|---|---|${r.competitors.map(() => '---|').join('')}---|`);
    for (const i of r.gaps.intents) L.push(`| ${i.intent}${i.gap ? ' **(gap)**' : ''} | ${i.target} | ${i.competitors.join(' | ')} | ${i.missingTypes.join(', ') || '—'} |`);
    L.push('');
    L.push('## Topic clusters per competitor', '', '_Clusters are first-path-segment groups labelled by their dominant terms; "covered" means most of those terms also appear on the target. Hypotheses, not demand._', '');
    for (const c of r.gaps.clusters) {
      L.push(`### ${md(c.competitor)}`, '');
      L.push(c.clusters.length ? c.clusters.map((k) => `- ${k.covered ? 'covered' : '**not covered**'} · \`${md(k.key)}\` (${k.pages} pages): ${k.terms.map(md).join(', ') || '—'}`).join('\n') : '_No clusters (too few pages)._', '');
    }
    L.push('## Structured data gaps', '');
    L.push(r.gaps.schemaTypes.length ? r.gaps.schemaTypes.map((t) => `- **${md(t.type)}** markup used by ${t.competitors}/${r.competitors.length} competitors — add only if it describes visible content on your pages`).join('\n') : '_No structured-data gaps._', '');
  }
  L.push('## Limitations', '', ...r.limitations.map((l) => `- ${md(l)}`), '');
  return L.join('\n');
}

export async function commandResearch(flags: GlobalFlags): Promise<number> {
  const v = flags.values;
  const target = flags.positionals[1];
  if (!target || !/^https?:\/\//i.test(target)) throw new UsageError('research requires a URL');
  const competitors = (v['competitor'] as string[] | undefined) ?? [];
  if (competitors.length > 10) throw new UsageError('At most 10 --competitor URLs');
  for (const c of competitors) if (!/^https?:\/\//i.test(c)) throw new UsageError(`Invalid competitor URL: ${c}`);
  const kb = loadKnowledge();
  const workspace = path.resolve(String(v['out'] ?? process.cwd()));
  const store = new RunStore(workspace, RunStore.newRunId('research'));
  const perSite = num(v['max-pages'], 150, 1, 100000);
  // Several sites: a single --site-url origin mapping would apply to all of them.
  const base = { ...crawlOptionsFrom(v), siteUrl: undefined, maxPages: perSite };

  const analyse = async (url: string) => {
    log(v, `Crawling ${url} (max ${perSite} pages)…`);
    const result = await crawl(url, base);
    return analyzeCrawl(result, kb, { ...base, probes: false });
  };
  const targetReport = await analyse(target);
  const compReports: AuditReport[] = [];
  for (const c of competitors) compReports.push(await analyse(c));

  const allTerms = new Set(targetReport.content.pageTerms.flatMap((p) => p.terms).concat(targetReport.content.topTerms.map((t) => t.term)));
  const research: ResearchReport = {
    target: profile(targetReport),
    competitors: compReports.map(profile),
    gaps: computeGaps(profile(targetReport), compReports.map(profile), allTerms),
    limitations: [
      'Competitor discovery, search volumes, rankings and SERP features require external data; Searvex does not fabricate them. Pass competitors explicitly with --competitor (the /searvex:research skill discovers them via web search).',
      'Topic gaps compare on-page term statistics of crawled pages only; they indicate coverage differences, not demand.',
      ...(competitors.length ? [] : ['No competitors given: only the target profile was built.']),
    ],
  };
  store.writeJson('meta.json', { kind: 'research', target, competitors, startedAt: new Date().toISOString() });
  store.writeJson('research.json', research);
  store.writeJson('report.json', targetReport);
  const mdPath = store.writeText('research.md', renderResearchMarkdown(research));
  if (v['json']) process.stdout.write(JSON.stringify(research, null, 2) + '\n');
  else {
    console.log(renderResearchMarkdown(research));
    console.log(`Saved: ${mdPath}`);
  }
  return 0;
}
