import { countsTowardScore, type AuditReport } from '../analyze/audit.js';
import type { KnowledgeBase } from '../rules/engine.js';
import type { ReportExtras } from './html.js';
import { RULES_TR } from './i18n.js';
import type { PromptInput } from './prompt.js';
import { findingRef, remediationOf, rootCauseGroups } from './remediation.js';

export interface PromptSelection {
  lang: 'en' | 'tr';
  /** Rule ids to include; default: every issue that counts toward the score (not info, not pre-launch context). */
  rules?: string[];
}

/**
 * The repair-prompt input the HTML action center builds for a selection (`promptInput` in client.ts), built on
 * the server: every root-cause group of each selected finding, rule texts and sources from the knowledge base,
 * and the latest rule-level review.
 */
export function repairPromptInput(r: AuditReport, kb: KnowledgeBase, extras: ReportExtras, sel: PromptSelection): PromptInput {
  const groups = rootCauseGroups(r);
  const findings = sel.rules ? r.findings.filter((f) => sel.rules!.includes(f.ruleId)) : r.findings.filter((f) => f.severity !== 'info' && countsTowardScore(f));
  const reviewOf = (ruleId: string) => [...(extras.reviews ?? [])].reverse().find((x) => x.ruleId === ruleId && !x.ref);
  const repository = extras.repository ?? (r.mode === 'repository' ? { path: r.target } : undefined);
  return {
    lang: sel.lang,
    target: r.target,
    mode: r.mode,
    runId: r.runId,
    generatedAt: r.generatedAt,
    version: r.tool.version,
    ...(repository ? { repository } : {}),
    items: findings.map((f) => {
      const rule = kb.rules.get(f.ruleId);
      const tr = sel.lang === 'tr' ? RULES_TR[f.ruleId] : undefined;
      const rv = reviewOf(f.ruleId);
      return {
        ruleId: f.ruleId,
        title: tr?.title ?? rule?.title ?? f.title,
        severity: f.severity,
        confidence: f.confidence,
        remediation: remediationOf(f.ruleId, extras.plan),
        fix: tr?.fix ?? rule?.fix ?? f.fix,
        verify: rule?.verify,
        sources: rule?.sources.map((s) => ({ title: s.title, url: s.url, checked: s.checked })) ?? [],
        ...(rv ? { review: rv.status + (rv.note ? ': ' + rv.note : '') } : {}),
        groups: (groups[f.ruleId] ?? []).map((g) => ({
          key: g.kind === 'site' ? 'site' : g.key,
          kind: g.kind,
          pages: g.pages,
          evidence: g.evidence.map((i) => ({ ...f.evidence[i]!, ref: findingRef(f.ruleId, f.evidence[i]!) })),
        })),
      };
    }),
  };
}
