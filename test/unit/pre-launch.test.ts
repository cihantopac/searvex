import { describe, expect, it } from 'vitest';
import { computeScores, countsTowardScore, scoreLabel, type AuditReport } from '../../src/analyze/audit.js';
import { applyPreLaunch, asLaunched } from '../../src/analyze/pre-launch.js';
import { isNoindex } from '../../src/analyze/context.js';
import type { Finding } from '../../src/core/types.js';
import type { CrawlResult, PageRecord } from '../../src/crawl/crawler.js';
import { failOnExit, isPrivateTarget } from '../../src/cli.js';
import { diffReports } from '../../src/commands/monitor.js';
import { loadKnowledge, validateKnowledge } from '../../src/rules/engine.js';

const kb = loadKnowledge();
type F = Finding & { count: number };
const f = (ruleId: string, severity: F['severity'], extra: Partial<F> = {}): F =>
  ({ ruleId, title: ruleId, severity, confidence: 'verified', category: 'security', engines: ['all'], message: '', evidence: [{ url: 'http://x/' }], count: 1, ...extra }) as F;

describe('pre-launch scoring', () => {
  it('context findings, like unmeasurable ones, never change the score', () => {
    const real = f('title.missing', 'medium');
    const base = computeScores([real], 1).overall;
    expect(computeScores([real, f('https.not-used', 'high', { context: 'environment' })], 1).overall).toBe(base);
    expect(computeScores([real, f('index.noindex-in-sitemap', 'medium', { context: 'launch-checklist' })], 1).overall).toBe(base);
    expect(computeScores([real, f('https.not-used', 'high')], 1).overall).toBeLessThan(base);
    expect(countsTowardScore({ confidence: 'verified' })).toBe(true);
    expect(countsTowardScore({ confidence: 'verified', context: 'environment' })).toBe(false);
    expect(countsTowardScore({ confidence: 'unmeasurable' })).toBe(false);
  });

  it('applyPreLaunch tags server and launch rules and drops their priority', () => {
    const fs = [f('https.not-used', 'high', { priority: { score: 80, bucket: 'P1', reach: 1, effort: 'low', reasons: [] } }), f('index.noindex', 'info'), f('robots.sitemap-unreachable', 'low'), f('title.missing', 'medium')];
    applyPreLaunch(fs, kb);
    expect(fs.map((x) => x.context)).toEqual(['environment', 'launch-checklist', 'launch-checklist', undefined]);
    expect(fs[0]!.priority).toBeUndefined();
  });

  it('the knowledge base tags exactly the planned rules, and rejects unknown environments', () => {
    const tagged = [...kb.rules.values()].filter((r) => r.environment).map((r) => `${r.id}:${r.environment}`).sort();
    expect(tagged).toEqual([
      'canonical.http-https:server', 'canonical.target-noindex:launch', 'https.not-used:server', 'index.noindex-in-sitemap:launch', 'index.noindex:launch',
      'perf.no-compression:server', 'robots.disallow-all:launch', 'robots.sitemap-unreachable:launch',
    ]);
    const bad = { ...kb, rules: new Map([['x.y', { ...kb.rules.get('https.not-used')!, id: 'x.y', environment: 'staging' as never }]]) };
    expect(validateKnowledge(bad).some((i) => i.level === 'error' && /invalid environment/.test(i.message))).toBe(true);
  });

  it('score label and --fail-on follow the profile', () => {
    expect(scoreLabel({ overall: 90, byCategory: {}, method: '', profile: 'pre-launch' })).toBe('90/100 (pre-launch profile)');
    const report = { findings: [f('https.not-used', 'high', { context: 'environment' })] } as unknown as AuditReport;
    expect(failOnExit(report, 'high')).toBe(0);
    report.findings[0]!.context = undefined;
    expect(failOnExit(report, 'high')).toBe(1);
  });
});

describe('asLaunched', () => {
  const rec = (url: string, meta: string[], xRobots: string[] = []): PageRecord =>
    ({ url, finalUrl: url, status: 200, depth: 0, redirects: [], contentType: 'text/html', timingMs: 1, bytes: 1, truncated: false, headers: {}, xRobots, xRobotsByBot: {}, blockedByRobots: false, inSitemap: false, data: { metaRobots: meta, botRobots: { googlebot: ['noindex'] } } }) as unknown as PageRecord;

  it('removes noindex (meta, bot meta, X-Robots-Tag) and keeps nofollow from "none"', () => {
    const crawl = { pages: [rec('http://x/a', ['none']), rec('http://x/b', ['index'], ['noindex']), rec('http://x/c', [])] } as unknown as CrawlResult;
    crawl.pages[2]!.data!.botRobots = {};
    const v = asLaunched(crawl);
    expect([...v.noindex.keys()]).toEqual(['http://x/a', 'http://x/b']);
    expect(v.result.pages.map(isNoindex)).toEqual([false, false, false]);
    expect(v.result.pages[0]!.data!.metaRobots).toEqual(['nofollow']);
    expect(crawl.pages.map(isNoindex)).toEqual([true, true, false]); // the crawl itself is unchanged
  });
});

describe('monitor', () => {
  it('a context finding that appears is not a regression', () => {
    const r = (findings: F[]) => ({ target: 't', runId: 'r', scores: { overall: 90 }, crawl: { crawled: 1 }, findings }) as unknown as AuditReport;
    expect(diffReports(r([]), r([f('https.not-used', 'high', { context: 'environment' })]), 'b').regression).toBe(false);
    expect(diffReports(r([]), r([f('https.not-used', 'high')]), 'b').regression).toBe(true);
    // Baseline without the profile, current with it: the context of either side counts.
    expect(diffReports(r([f('https.not-used', 'high', { context: 'environment' })]), r([f('https.not-used', 'high', { count: 3 } as Partial<F>)]), 'b').regression).toBe(false);
  });
});

describe('isPrivateTarget', () => {
  it('recognises local and private hosts without DNS', () => {
    for (const u of ['http://localhost:3000/', 'http://127.0.0.1:4400/', 'http://[::1]:8080/', 'http://192.168.1.10/', 'http://10.0.0.5/', 'http://site.test/', 'http://app.localhost/']) expect(isPrivateTarget(u), u).toBe(true);
    for (const u of ['https://example.com/', 'https://8.8.8.8/', 'not a url']) expect(isPrivateTarget(u), u).toBe(false);
  });
});
