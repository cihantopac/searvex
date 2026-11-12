import fs from 'node:fs';
import path from 'node:path';
import { defaultKnowledgeDir, validateKnowledge, type KnowledgeBase, type Rule, type RuleFile, type ValidationIssue } from './engine.js';

/**
 * Community rule packs (plan H4): `knowledge/packs/<name>/*.json` (or any directory) in the core rule-file format.
 * Pack rules carry a declarative `check` instead of code, are held to the same sourcing rules (official-domain
 * allowlist, check dates) and can never replace a core rule: every id starts with `<pack name>.`.
 *
 * A check reads one field of each indexable HTML page and tests it:
 *   field: title | description | h1 | lang | canonical | jsonld-types | og:<property> | twitter:<name> | header:<name>
 *   test:  missing | present | matches | not-matches | longer-than | shorter-than
 *   value: a regular expression (matches, not-matches; case-insensitive) or a length (longer-than, shorter-than);
 *          `not-matches` also fires when the field is missing, the length tests only when it is present
 *   urlPattern: optional regular expression on the URL path; other pages are skipped
 */
export interface PackCheck {
  field: string;
  test: 'missing' | 'present' | 'matches' | 'not-matches' | 'longer-than' | 'shorter-than';
  value?: string | number;
  urlPattern?: string;
}

export interface RulePack {
  name: string;
  version: string;
  dir: string;
  rules: Rule[];
}

export class RulePackError extends Error {}

const FIELDS = /^(title|description|h1|lang|canonical|jsonld-types|og:[a-z0-9:_-]+|twitter:[a-z0-9:_-]+|header:[a-z0-9-]+)$/;
const TESTS: PackCheck['test'][] = ['missing', 'present', 'matches', 'not-matches', 'longer-than', 'shorter-than'];
const MAX_PATTERN = 200;

/**
 * Compile a pack regular expression, refusing the shapes that can backtrack catastrophically (a quantified group
 * that itself contains a quantifier, back-references) and very long patterns: packs come from third parties.
 */
export function compilePackPattern(src: string): RegExp {
  if (src.length > MAX_PATTERN) throw new RulePackError(`pattern longer than ${MAX_PATTERN} characters`);
  if (/\([^)]*[*+}][^)]*\)\s*[*+{?]/.test(src) || /\\[1-9]/.test(src)) throw new RulePackError('pattern has a quantified group with an inner quantifier or a back-reference (may backtrack catastrophically)');
  try {
    return new RegExp(src, 'i');
  } catch (e) {
    throw new RulePackError(`invalid pattern: ${(e as Error).message}`);
  }
}

/** Problems of one pack rule's `check` (empty when valid). */
export function checkProblems(c: PackCheck | undefined): string[] {
  if (!c || typeof c !== 'object') return ['pack rules need a "check" object'];
  const out: string[] = [];
  if (typeof c.field !== 'string' || !FIELDS.test(c.field)) out.push(`check.field "${String(c.field)}" is not one of title, description, h1, lang, canonical, jsonld-types, og:<property>, twitter:<name>, header:<name>`);
  if (!TESTS.includes(c.test)) out.push(`check.test "${String(c.test)}" is not one of ${TESTS.join(', ')}`);
  if (c.test === 'matches' || c.test === 'not-matches') {
    if (typeof c.value !== 'string' || !c.value) out.push(`check.value must be a regular expression for "${c.test}"`);
    else
      try {
        compilePackPattern(c.value);
      } catch (e) {
        out.push(`check.value: ${(e as Error).message}`);
      }
  }
  if ((c.test === 'longer-than' || c.test === 'shorter-than') && (typeof c.value !== 'number' || !Number.isInteger(c.value) || c.value < 0)) out.push(`check.value must be a non-negative integer for "${c.test}"`);
  if (c.urlPattern !== undefined)
    try {
      compilePackPattern(String(c.urlPattern));
    } catch (e) {
      out.push(`check.urlPattern: ${(e as Error).message}`);
    }
  return out;
}

/** Load a pack by name (`knowledge/packs/<name>`) or from a directory path. */
export function loadRulePack(ref: string, knowledgeDir = defaultKnowledgeDir()): RulePack {
  const dir = fs.existsSync(ref) && fs.statSync(ref).isDirectory() ? path.resolve(ref) : path.join(knowledgeDir, 'packs', ref);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new RulePackError(`Rule pack not found: ${ref} (a pack name in knowledge/packs/ or a directory)`);
  const name = path.basename(dir);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new RulePackError(`Rule pack directory name "${name}" must be lower-case letters, digits and dashes (it prefixes every rule id)`);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) throw new RulePackError(`Rule pack ${name} has no .json rule files`);
  const rules: Rule[] = [];
  let version = '0.0.0';
  for (const f of files) {
    let data: RuleFile;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as RuleFile;
    } catch (e) {
      throw new RulePackError(`Rule pack ${name}/${f}: ${(e as Error).message}`);
    }
    if (!Array.isArray(data.rules)) throw new RulePackError(`Rule pack ${name}/${f}: no "rules" array`);
    if (typeof data.version === 'string' && data.version > version) version = data.version;
    for (const r of data.rules) rules.push({ ...r, pack: name });
  }
  return { name, version, dir, rules };
}

/** The knowledge base plus the packs' rules. A pack rule id must start with `<pack>.` and may not exist already. */
export function withPacks(kb: KnowledgeBase, packs: RulePack[]): KnowledgeBase {
  if (!packs.length) return kb;
  const rules = new Map(kb.rules);
  const ruleVersions = new Map(kb.ruleVersions ?? []);
  for (const p of packs) {
    for (const r of p.rules) {
      if (typeof r.id !== 'string' || !r.id.startsWith(`${p.name}.`)) throw new RulePackError(`Rule pack ${p.name}: rule id "${String(r.id)}" must start with "${p.name}."`);
      if (rules.has(r.id)) throw new RulePackError(`Rule pack ${p.name}: rule id ${r.id} already exists${kb.rules.has(r.id) ? ' in the core rule base' : ''}; a pack can never replace a rule`);
      rules.set(r.id, r);
      ruleVersions.set(r.id, p.version);
    }
  }
  return { ...kb, rules, ruleVersions, packs: [...(kb.packs ?? []), ...packs.map((p) => ({ name: p.name, version: p.version, rules: p.rules.length }))] };
}

/** Validation of the pack rules: the core checks (sources, allowlist, dates, fields) plus their `check`. */
export function validatePacks(kb: KnowledgeBase, packs: RulePack[], opts: { today?: Date } = {}): ValidationIssue[] {
  const ids = new Set(packs.flatMap((p) => p.rules.map((r) => r.id)));
  const only: KnowledgeBase = { ...kb, rules: new Map([...kb.rules].filter(([id]) => ids.has(id))) };
  const issues = validateKnowledge(only, opts).filter((i) => ids.has(i.ruleId));
  for (const r of only.rules.values()) for (const m of checkProblems(r.check)) issues.push({ ruleId: r.id, level: 'error', message: m });
  return issues;
}
