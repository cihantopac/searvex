import type { AuditReport } from '../analyze/audit.js';
import { urlPattern } from '../analyze/priority.js';
import type { Evidence } from '../core/types.js';
import { AUTOFIX_RULES, type FixPlan } from '../optimize/fixes.js';

/**
 * How a finding gets fixed, and which findings share one root cause.
 *
 * - `auto`: a deterministic Searvex planner produced a concrete patch for this rule in this repository
 *   (only when a fix plan is known — never inferred from the rule alone).
 * - `agent`: needs source-code understanding, content judgement or framework-specific edits.
 * - `manual`: deployment, server or infrastructure changes, Search Console actions, runtime measurements
 *   or business decisions that cannot be made safely from the code.
 */
export type Remediation = 'auto' | 'agent' | 'manual';

/** Rules whose fix lives outside the code base or needs a decision/measurement a coding agent cannot make. */
const MANUAL = new Set([
  'http.start-url-error', 'robots.unreachable', 'http.server-error', 'http.fetch-error',
  'canonical.http-https', 'canonical.www-duplicate', 'https.not-used', 'redirect.loop', 'redirect.chain',
  'perf.slow-ttfb', 'perf.no-compression', 'perf.cwv-poor', 'perf.cwv-unmeasured', 'geo.citations-unmeasured',
  'geo.search-bot-blocked', 'geo.ai-search-bot-blocked', 'geo.training-bots', 'geo.snippet-restricted',
  'content.cannibalization',
]);

export function remediationOf(ruleId: string, plan?: Pick<FixPlan, 'fixes'> | null): Remediation {
  if (plan?.fixes.some((f) => f.ruleId === ruleId)) return 'auto';
  return MANUAL.has(ruleId) ? 'manual' : 'agent';
}

/** True when `searvex optimize` has a planner for the rule (it may still need a repository or flags). */
export const optimizerAvailable = (ruleId: string): boolean => AUTOFIX_RULES.has(ruleId);

/** FNV-1a, base36: short, stable across runs for the same rule + location. */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0');
}

/** Stable reference of one occurrence: `<ruleId>#<hash of url/file:line>`. */
export function findingRef(ruleId: string, e: Evidence): string {
  return `${ruleId}#${shortHash(`${e.url ?? ''}|${e.file ?? ''}|${e.line ?? ''}`)}`;
}

export interface RootCauseGroup {
  /** `<ruleId>@<key>`; stable for the same rule and template/file. */
  id: string;
  ruleId: string;
  /** URL template (`/blog/*`), source file, `layout` (most page types at once) or `site` for site-wide findings. */
  key: string;
  kind: 'template' | 'file' | 'layout' | 'site';
  /** Affected pages/locations in this group (all of them, not only the evidence sample). */
  pages: number;
  /** Indexes into the finding's `evidence` array. */
  evidence: number[];
  /** Languages of the affected pages (website mode), when known. */
  langs: string[];
}

/**
 * Split each rule's occurrences into root-cause groups. A rule hitting 100 pages built on one template is one
 * group to fix once, not 100 tasks; findings in different templates or files stay separate.
 */
export function rootCauseGroups(r: AuditReport): Record<string, RootCauseGroup[]> {
  const langOf = new Map(r.inventory.pages.map((p) => [p.url, p.lang ?? '']));
  const pageCount = Math.max(1, r.inventory.pages.filter((p) => p.indexable).length || r.crawl.crawled);
  const out: Record<string, RootCauseGroup[]> = {};
  for (const f of r.findings) {
    const by = new Map<string, RootCauseGroup>();
    const add = (key: string, kind: RootCauseGroup['kind'], i: number | null) => {
      let g = by.get(key);
      if (!g) by.set(key, (g = { id: `${f.ruleId}@${key}`, ruleId: f.ruleId, key, kind, pages: 0, evidence: [], langs: [] }));
      if (i !== null) {
        g.evidence.push(i);
        const l = f.evidence[i]!.url ? langOf.get(f.evidence[i]!.url!) : '';
        if (l && !g.langs.includes(l)) g.langs.push(l);
      }
      return g;
    };
    f.evidence.forEach((e, i) => {
      if (e.file) add(e.file, 'file', i);
      else if (e.url && !/\/robots\.txt$/.test(e.url)) add(urlPattern(e.url), 'template', i);
      else add('site', 'site', i);
    });
    if (!f.evidence.length) add('site', 'site', null);
    // Page counts: the crawler's template totals cover every affected page, the evidence only a sample.
    const totals = new Map((f.templates ?? []).map((t) => [t.pattern, t.pages]));
    for (const g of by.values()) g.pages = g.kind === 'template' ? Math.max(totals.get(g.key) ?? 0, g.evidence.length) : Math.max(1, g.evidence.length);
    const listed = [...by.values()].reduce((n, g) => n + (g.kind === 'template' ? g.pages : 0), 0);
    // Templates seen only in the totals (evidence was capped) still count as groups.
    for (const [pattern, pages] of totals) if (!by.has(pattern) && listed < f.count) by.set(pattern, { id: `${f.ruleId}@${pattern}`, ruleId: f.ruleId, key: pattern, kind: 'template', pages, evidence: [], langs: [] });
    let groups = [...by.values()].sort((a, b) => b.pages - a.pages);
    // Most pages of most templates at once: one shared layout/head component, not one task per URL pattern.
    const templ = groups.filter((g) => g.kind === 'template');
    if (templ.length >= 3 && f.count >= Math.max(5, 0.6 * pageCount)) {
      const merged: RootCauseGroup = { id: `${f.ruleId}@layout`, ruleId: f.ruleId, key: `${templ.length} URL templates`, kind: 'layout', pages: f.count, evidence: templ.flatMap((g) => g.evidence), langs: [...new Set(templ.flatMap((g) => g.langs))] };
      groups = [merged, ...groups.filter((g) => g.kind !== 'template')];
    }
    out[f.ruleId] = groups;
  }
  return out;
}
