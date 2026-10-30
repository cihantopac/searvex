import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FindingSink, loadKnowledge, validateKnowledge, type KnowledgeBase } from '../../src/rules/engine.js';
import { IMPLEMENTED_RULES } from '../../src/rules/implemented.js';
import { computeScores } from '../../src/analyze/audit.js';

const kb = loadKnowledge();

function sourceTree(dir: string): string {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .map((e) => (e.isDirectory() ? sourceTree(path.join(dir, e.name)) : e.name.endsWith('.ts') && e.name !== 'implemented.ts' ? fs.readFileSync(path.join(dir, e.name), 'utf8') : ''))
    .join('\n');
}

describe('knowledge base', () => {
  it('validates with zero errors', () => {
    const issues = validateKnowledge(kb, { implemented: IMPLEMENTED_RULES, today: new Date('2026-10-30') });
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
  });

  it('every active rule cites at least one official source with a check date', () => {
    for (const r of kb.rules.values()) {
      if (r.status !== 'active') continue;
      expect(r.sources.length, r.id).toBeGreaterThan(0);
      for (const s of r.sources) expect(s.checked, r.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('IMPLEMENTED_RULES matches the rule ids referenced in source code', () => {
    const src = sourceTree(path.resolve('src'));
    for (const id of IMPLEMENTED_RULES) expect(src.includes(`'${id}'`), `rule ${id} not referenced in src/`).toBe(true);
    for (const id of kb.rules.keys()) if (src.includes(`'${id}'`)) expect(IMPLEMENTED_RULES.has(id), `${id} used in code but missing from IMPLEMENTED_RULES`).toBe(true);
  });

  it('never encodes known SEO myths as issues', () => {
    // Myths: fixed title length limits, meta keywords as optimisation, llms.txt as ranking factor, word-count targets.
    const titleRule = kb.rules.get('title.truncation-risk')!;
    expect(titleRule.severity).toBe('info');
    expect(kb.rules.get('meta.keywords-present')!.severity).toBe('info');
    expect(kb.rules.get('geo.llms-txt')!.severity).toBe('info');
    expect(kb.rules.get('content.low-text')!.confidence).toBe('heuristic');
    for (const r of kb.rules.values()) expect(r.description, r.id).not.toMatch(/keyword density|text-to-html/i);
  });

  it('rejects unofficial sources and declared conflicts', () => {
    const bad: KnowledgeBase = {
      version: 'x',
      files: [],
      rules: new Map([
        ['a.one', { ...kb.rules.get('title.missing')!, id: 'a.one', sources: [{ title: 'blog', url: 'https://some-seo-blog.com/x', checked: '2026-10-30' }], conflictsWith: ['a.two'] }],
        ['a.two', { ...kb.rules.get('title.missing')!, id: 'a.two' }],
      ]),
    };
    const issues = validateKnowledge(bad, { today: new Date('2026-10-30') });
    expect(issues.some((i) => i.message.includes('official-domain allowlist'))).toBe(true);
    expect(issues.some((i) => i.message.includes('conflicts with active rule'))).toBe(true);
  });

  it('flags stale sources as warnings', () => {
    const issues = validateKnowledge(kb, { today: new Date('2028-01-01') });
    expect(issues.some((i) => i.level === 'warning' && i.message.includes('last checked'))).toBe(true);
  });
});

describe('FindingSink and scoring', () => {
  it('groups evidence per rule and refuses unknown rule ids', () => {
    const sink = new FindingSink(kb, 2);
    sink.emit('title.missing', { url: 'a' });
    sink.emit('title.missing', [{ url: 'b' }, { url: 'c' }]);
    const [f] = sink.findings();
    expect(f!.count).toBe(3);
    expect(f!.evidence).toHaveLength(2);
    expect(() => sink.emit('made.up', {})).toThrow(/Unknown rule/);
  });

  it('does not let unmeasurable findings change the score', () => {
    const sink = new FindingSink(kb);
    sink.emit('perf.cwv-unmeasured', {});
    sink.emit('geo.citations-unmeasured', {});
    expect(computeScores(sink.findings(), 10).overall).toBe(100);
  });

  it('weights critical issues heavily regardless of page share', () => {
    const sink = new FindingSink(kb);
    sink.emit('robots.unreachable', {});
    expect(computeScores(sink.findings(), 1000).overall).toBeLessThanOrEqual(75);
  });
});
