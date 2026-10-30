import type { AuditReport } from '../analyze/audit.js';
import type { Severity } from '../core/types.js';

const ICON: Record<Severity, string> = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵', info: '⚪' };

/** Escape text for Markdown tables/inline use (crawled content is untrusted). */
export function md(s: unknown): string {
  return String(s ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[|\\`*_[\]<>]/g, (c) => `\\${c}`)
    .slice(0, 300);
}

export function renderMarkdown(r: AuditReport, opts: { maxEvidence?: number } = {}): string {
  const max = opts.maxEvidence ?? 5;
  const L: string[] = [];
  L.push(`# Searvex audit — ${md(r.target)}`, '');
  L.push(`Generated ${r.generatedAt} · Searvex ${r.tool.version} · rules ${r.tool.rulesVersion} · run \`${r.runId}\``, '');
  L.push('## Summary', '');
  L.push(`| Metric | Value |`, `|---|---|`);
  L.push(`| Searvex health score¹ | **${r.scores.overall}/100** |`);
  L.push(`| Pages crawled | ${r.crawl.crawled}${r.crawl.truncated ? ` (limit reached, ${r.crawl.queuedRemaining} queued)` : ''} |`);
  L.push(`| Indexable HTML pages | ${r.inventory.pages.filter((p) => p.indexable).length} |`);
  L.push(`| Likely site type (heuristic) | ${md(r.inventory.businessModel.label)} |`);
  L.push(`| Findings | ${r.findings.filter((f) => f.severity !== 'info').length} issues + ${r.findings.filter((f) => f.severity === 'info').length} informational |`);
  L.push(`| Evidence quality | ${r.measurement.verified} verified · ${r.measurement.heuristic} heuristic · ${r.measurement.unmeasurable} unmeasurable |`);
  L.push('', `¹ ${r.scores.method}`, '');

  const ranked = r.findings.filter((f) => f.priority && f.priority.score > 0).sort((a, b) => b.priority!.score - a.priority!.score);
  if (ranked.length) {
    L.push('## Fix first', '', 'Ranked by impact: severity × confidence × importance-weighted reach ÷ effort (see each rule for sources).', '');
    L.push('| # | Priority | Issue | Reach | Effort | Why |', '|---|---|---|---|---|---|');
    ranked.slice(0, 10).forEach((f, i) => L.push(`| ${i + 1} | ${f.priority!.bucket} (${f.priority!.score}) | ${md(f.title)} \`${f.ruleId}\` | ${Math.round(f.priority!.reach * 100)}% | ${f.priority!.effort} | ${f.priority!.reasons.slice(1).map(md).join('; ') || '—'} |`));
    L.push('');
  }

  const issues = r.findings.filter((f) => f.severity !== 'info');
  L.push('## Issues by severity', '');
  if (!issues.length) L.push('_No issues found by the active rules._', '');
  for (const f of issues) {
    L.push(`### ${ICON[f.severity]} ${md(f.title)} — ${f.severity}${f.confidence !== 'verified' ? ` (${f.confidence})` : ''}`, '');
    L.push(`\`${f.ruleId}\` · ${f.category} · engines: ${f.engines.join(', ')} · affected: ${f.count}${f.autofixable ? ' · 🔧 auto-fixable with `searvex optimize` (repository mode)' : ' · needs judgement'}`, '');
    L.push(md(f.message).replace(/\\([*_])/g, '$1'), '');
    if (f.fix) L.push(`**Fix:** ${md(f.fix)}`, '');
    if (f.templates?.length) L.push(`Templates: ${f.templates.map((t) => `\`${md(t.pattern)}\` (${t.pages})`).join(', ')}`, '');
    for (const e of f.evidence.slice(0, max)) L.push(`- ${e.url ? md(e.url) : e.file ? `${md(e.file)}${e.line ? ':' + e.line : ''}` : ''}${e.observed ? ` — ${md(e.observed)}` : ''}`);
    if (f.count > max) L.push(`- … and ${f.count - max} more`);
    L.push('');
  }

  L.push('## GEO / AI search readiness', '');
  if (r.geo.bots.length) {
    L.push('| Crawler | Operator | Purpose | Homepage |', '|---|---|---|---|');
    for (const b of r.geo.bots) L.push(`| ${b.token} | ${b.operator} | ${b.purpose} | ${b.allowed ? 'allowed' : '**blocked**'}${b.explicit ? '' : ' (via *)'} |`);
    L.push('');
  }
  L.push(`- llms.txt: ${r.geo.llmsTxt ? (r.geo.llmsTxt.present ? 'present' : 'absent') : 'not checked'} — informational only; Google documents it does not use it.`);
  L.push(`- Content clarity (heuristic, not a citation predictor): average ${r.geo.answerability.average}/100 across indexable pages.`);
  L.push(`- AI citations: ${r.geo.citations.measured ? 'measured' : `**not measured** — ${md(r.geo.citations.reason)}`}`);
  if (Object.keys(r.geo.entityNames).length) L.push(`- Declared brand/entity names: ${Object.entries(r.geo.entityNames).map(([n, c]) => `${md(n)} (${c})`).join(', ')}`);
  L.push('');

  L.push('## Site inventory', '');
  const bm = r.inventory.businessModel;
  L.push(`Business model (heuristic${bm.confidence ? `, ${bm.confidence} confidence` : ''}): **${md(bm.label)}**${bm.evidence.length ? ' — ' + bm.evidence.map(md).join('; ') : ''}${bm.alternatives?.length ? ` · alternatives: ${bm.alternatives.map((a) => `${md(a.label)} (${a.score})`).join(', ')}` : ''}`, '');
  if (r.inventory.offerings?.length) L.push(`Offerings declared in structured data: ${r.inventory.offerings.slice(0, 10).map((o) => `${md(o.name)} (${o.kind}${o.price !== undefined ? `, ${md(o.price)} ${md(o.currency ?? '')}`.trimEnd() : ''})`).join(', ')}`, '');
  if (r.inventory.relations?.length) L.push(`Organisation relations: ${r.inventory.relations.map((x) => `${md(x.from)} → ${x.relation} → ${md(x.to)}`).join('; ')}`, '');
  L.push('| Page type | Count |', '|---|---|');
  for (const [t, c] of Object.entries(r.inventory.byType).sort((a, b) => b[1] - a[1])) L.push(`| ${t} | ${c} |`);
  if (r.inventory.intents) L.push('', `Intent the pages are built for (inferred from page type): ${Object.entries(r.inventory.intents).sort((a, b) => b[1] - a[1]).map(([i, c]) => `${i} (${c})`).join(', ')}`);
  L.push('', `Languages (html lang): ${Object.entries(r.inventory.languages).map(([l, c]) => `${md(l)} (${c})`).join(', ') || '—'}`);
  if (r.inventory.hreflangLanguages.length) L.push(`hreflang languages: ${r.inventory.hreflangLanguages.map(md).join(', ')}`);
  L.push(`HTTP status: ${Object.entries(r.inventory.statusCodes).map(([s, c]) => `${s}: ${c}`).join(', ')}`, '');
  const sd = r.inventory.structuredData;
  if (sd) {
    L.push(`Structured data: ${sd.pagesWithStructuredData} of ${r.inventory.pages.length} pages${sd.invalidJsonLdPages ? ` (${sd.invalidJsonLdPages} with invalid JSON-LD)` : ''}`, '');
    if (sd.types.length) {
      L.push('| Schema type | Pages | Syntax |', '|---|---|---|');
      for (const t of sd.types.slice(0, 25)) L.push(`| ${md(t.type)} | ${t.pages} | ${t.formats.join(', ')} |`);
      L.push('');
    }
  }

  L.push('## Content intelligence', '');
  if (r.content.topTerms.length) L.push(`Site-wide terms: ${r.content.topTerms.slice(0, 20).map((t) => md(t.term)).join(', ')}`, '');
  if (r.content.clusters.length) {
    L.push('| Section | Pages | Dominant terms |', '|---|---|---|');
    for (const c of r.content.clusters.slice(0, 15)) L.push(`| /${md(c.key)} | ${c.pages.length} | ${c.terms.map(md).join(', ')} |`);
    L.push('');
  }
  if (r.content.linkOpportunities?.length) {
    L.push('Internal-link opportunities (related pages without links between them; heuristic):', '', '| Add a link from | To | Similarity | Shared topics |', '|---|---|---|---|');
    for (const o of r.content.linkOpportunities.slice(0, 15)) L.push(`| ${md(o.from)} | ${md(o.to)} (${o.toInlinks} inlinks) | ${Math.round(o.similarity * 100)}% | ${o.sharedTerms.slice(0, 5).map(md).join(', ')} |`);
    L.push('');
  }
  L.push(`Cannibalisation candidates: ${r.content.cannibalization.length} · near-duplicate pairs: ${r.content.nearDuplicates.length} · exact duplicate groups: ${r.content.exactDuplicates.length}`, '');

  const info = r.findings.filter((f) => f.severity === 'info');
  if (info.length) {
    L.push('## Informational', '');
    for (const f of info) L.push(`- **${md(f.title)}** (\`${f.ruleId}\`, ${f.count}) — ${md(f.evidence[0]?.observed ?? f.message)}`);
    L.push('');
  }
  L.push('## Limitations', '');
  for (const l of [...r.limitations, ...r.geo.notes]) L.push(`- ${md(l)}`);
  L.push('', '_Every finding links to an official source in `searvex rules show <ruleId>`. Searvex never guarantees rankings, indexing or AI citations._', '');
  return L.join('\n');
}
