import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Category, Confidence, Engine, Evidence, Finding, Severity, SourceRef } from '../core/types.js';

/**
 * Rule knowledge base.
 *
 * Rules are data (knowledge/rules/*.json), implementations are code (src/analyze/*).
 * A finding can only be emitted for a rule that exists in the knowledge base, so every
 * finding is traceable to an official source with a check date.
 */
export interface Rule {
  id: string;
  title: string;
  category: Category;
  severity: Severity;
  confidence: Confidence;
  engines: Engine[];
  /** What the rule checks and why, in neutral technical language. */
  description: string;
  /** When the rule applies (and when it does not). */
  appliesWhen?: string;
  fix: string;
  /** How to verify the fix. */
  verify: string;
  exceptions?: string;
  sources: SourceRef[];
  status: 'active' | 'deprecated' | 'draft';
  /** Rule ids whose recommendation contradicts this one for an overlapping engine. */
  conflictsWith?: string[];
  autofix?: boolean;
}

export interface RuleFile {
  version: string;
  updated: string;
  rules: Rule[];
}

export interface KnowledgeBase {
  version: string;
  rules: Map<string, Rule>;
  files: string[];
}

/** Domains accepted as official sources. Anything else fails validation. */
export const OFFICIAL_DOMAINS = [
  'developers.google.com',
  'support.google.com',
  'search.google.com',
  'blog.google',
  'web.dev',
  'www.bing.com',
  'blogs.bing.com',
  'learn.microsoft.com',
  'yandex.com',
  'yandex.ru',
  'www.indexnow.org',
  'indexnow.org',
  'schema.org',
  'www.w3.org',
  'w3c.github.io',
  'www.rfc-editor.org',
  'datatracker.ietf.org',
  'www.sitemaps.org',
  'platform.openai.com',
  'developers.openai.com',
  'openai.com',
  'support.anthropic.com',
  'support.claude.com',
  'docs.perplexity.ai',
  'support.apple.com',
  'commoncrawl.org',
  'developers.facebook.com',
  'developer.amazon.com',
  'ogp.me',
  'llmstxt.org',
  'developer.mozilla.org',
  'html.spec.whatwg.org',
  'code.claude.com',
];

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
const CONFIDENCES: Confidence[] = ['verified', 'heuristic', 'unmeasurable'];
const ENGINES: Engine[] = ['google', 'bing', 'yandex', 'all', 'ai'];
const CATEGORIES: Category[] = [
  'crawlability', 'indexability', 'canonicalization', 'international', 'metadata', 'content', 'links',
  'structured-data', 'performance', 'mobile', 'accessibility', 'security', 'geo', 'architecture',
];

export function defaultKnowledgeDir(): string {
  // Works from src/ (tests), dist/ (npm) and the single-file bundle (plugin).
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.resolve(here, '../../knowledge'), path.resolve(here, '../knowledge'), path.resolve(here, 'knowledge')]) {
    if (fs.existsSync(path.join(candidate, 'rules'))) return candidate;
  }
  throw new Error('Searvex knowledge directory not found');
}

export function loadKnowledge(dir = defaultKnowledgeDir()): KnowledgeBase {
  const rulesDir = path.join(dir, 'rules');
  const files = fs.readdirSync(rulesDir).filter((f) => f.endsWith('.json')).sort();
  const rules = new Map<string, Rule>();
  let version = '0.0.0';
  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(path.join(rulesDir, f), 'utf8')) as RuleFile;
    if (data.version > version) version = data.version;
    for (const r of data.rules) {
      if (rules.has(r.id)) throw new Error(`Duplicate rule id ${r.id} in ${f}`);
      rules.set(r.id, r);
    }
  }
  return { version, rules, files };
}

export interface ValidationIssue {
  ruleId: string;
  level: 'error' | 'warning';
  message: string;
}

/** Validate structure, sources, freshness and declared conflicts of the knowledge base. */
export function validateKnowledge(kb: KnowledgeBase, opts: { implemented?: Set<string>; maxAgeDays?: number; today?: Date } = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const today = opts.today ?? new Date();
  const maxAge = opts.maxAgeDays ?? 365;
  for (const r of kb.rules.values()) {
    const err = (message: string) => issues.push({ ruleId: r.id, level: 'error', message });
    const warn = (message: string) => issues.push({ ruleId: r.id, level: 'warning', message });
    if (!/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(r.id)) err('id must be dotted lower-case, e.g. "canonical.multiple"');
    if (!r.title) err('missing title');
    if (!SEVERITIES.includes(r.severity)) err(`invalid severity ${r.severity}`);
    if (!CONFIDENCES.includes(r.confidence)) err(`invalid confidence ${r.confidence}`);
    if (!CATEGORIES.includes(r.category)) err(`invalid category ${r.category}`);
    if (!r.engines?.length || r.engines.some((e) => !ENGINES.includes(e))) err('engines must be a non-empty subset of google|bing|yandex|all|ai');
    if (!r.description || !r.fix || !r.verify) err('description, fix and verify are required');
    if (r.status === 'active' && !r.sources?.length) err('active rules need at least one source');
    for (const s of r.sources ?? []) {
      let host = '';
      try {
        host = new URL(s.url).hostname;
      } catch {
        err(`invalid source URL ${s.url}`);
        continue;
      }
      if (!OFFICIAL_DOMAINS.includes(host)) err(`source ${s.url} is not on the official-domain allowlist`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s.checked)) err(`source ${s.url} has invalid checked date`);
      else {
        const age = (today.getTime() - Date.parse(s.checked)) / 86400000;
        if (age > maxAge) warn(`source ${s.url} last checked ${Math.round(age)} days ago`);
        if (age < -1) err(`source ${s.url} checked date is in the future`);
      }
    }
    for (const c of r.conflictsWith ?? []) {
      const other = kb.rules.get(c);
      if (!other) err(`conflictsWith references unknown rule ${c}`);
      else {
        const overlap = r.engines.some((e) => e === 'all' || other.engines.includes(e) || other.engines.includes('all'));
        if (overlap && r.status === 'active' && other.status === 'active') {
          err(`active rule conflicts with active rule ${c} for overlapping engines`);
        }
      }
    }
    if (opts.implemented && r.status === 'active' && !opts.implemented.has(r.id)) warn('active rule has no implementation');
  }
  if (opts.implemented) {
    for (const id of opts.implemented) if (!kb.rules.has(id)) issues.push({ ruleId: id, level: 'error', message: 'implementation references a rule that is not in the knowledge base' });
  }
  return issues;
}

/** Collector that turns rule ids + evidence into Findings, grouping evidence per rule. */
export class FindingSink {
  private byRule = new Map<string, Finding>();
  readonly used = new Set<string>();

  constructor(
    private kb: KnowledgeBase,
    private maxEvidence = 50,
  ) {}

  emit(ruleId: string, evidence: Evidence | Evidence[], overrides: Partial<Pick<Finding, 'message' | 'severity' | 'confidence'>> = {}): void {
    const rule = this.kb.rules.get(ruleId);
    if (!rule) throw new Error(`Unknown rule id: ${ruleId}`);
    if (rule.status !== 'active') return;
    this.used.add(ruleId);
    const list = Array.isArray(evidence) ? evidence : [evidence];
    const existing = this.byRule.get(ruleId);
    if (existing) {
      (existing as Finding & { count: number }).count += list.length;
      for (const e of list) if (existing.evidence.length < this.maxEvidence) existing.evidence.push(e);
      return;
    }
    const f: Finding & { count: number } = {
      ruleId,
      title: rule.title,
      severity: overrides.severity ?? rule.severity,
      confidence: overrides.confidence ?? rule.confidence,
      category: rule.category,
      engines: rule.engines,
      message: overrides.message ?? rule.description,
      evidence: list.slice(0, this.maxEvidence),
      fix: rule.fix,
      autofixable: rule.autofix,
      count: list.length,
    };
    this.byRule.set(ruleId, f);
  }

  findings(): Array<Finding & { count: number }> {
    const order = (s: Severity) => SEVERITIES.indexOf(s);
    return [...this.byRule.values()].sort((a, b) => order(a.severity) - order(b.severity) || a.ruleId.localeCompare(b.ruleId)) as Array<Finding & { count: number }>;
  }
}
