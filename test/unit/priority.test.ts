import { describe, expect, it } from 'vitest';
import { prioritise, templatesOf, urlPattern } from '../../src/analyze/priority.js';
import type { SiteContext } from '../../src/analyze/context.js';
import type { Finding } from '../../src/core/types.js';

const f = (ruleId: string, severity: Finding['severity'], count: number, o: Partial<Finding> = {}) =>
  ({ ruleId, title: ruleId, severity, confidence: 'verified', category: 'metadata', engines: ['google'], message: '', evidence: [], count, ...o }) as Finding & { count: number };

describe('URL templates', () => {
  it('generalises deeper segments and keeps locale + section', () => {
    expect(urlPattern('https://e.com/')).toBe('/');
    expect(urlPattern('https://e.com/help/setup/old-mail')).toBe('/help/*/*');
    expect(urlPattern('https://e.com/en/blog/post-1')).toBe('/en/blog/*');
    expect(urlPattern('app/blog/[slug]/page.tsx')).toBe('/app/*/*/*');
    expect(templatesOf(['https://e.com/blog/a', 'https://e.com/blog/b', 'https://e.com/help/x'])).toEqual([{ pattern: '/blog/*', pages: 2 }, { pattern: '/help/*', pages: 1 }]);
  });
});

describe('prioritisation', () => {
  const urls = ['https://e.com/', ...Array.from({ length: 9 }, (_, i) => `https://e.com/blog/p${i}`)];
  const ctx = {
    indexable: urls.map((url) => ({ url })),
    inlinks: new Map(urls.map((u) => [u, new Set(u.endsWith('/') ? urls : ['https://e.com/'])])),
    sitemapUrls: new Set<string>(),
    homepage: { url: 'https://e.com/' },
  } as unknown as SiteContext;

  it('ranks issues on important pages higher and explains why', () => {
    const home = f('a.home', 'medium', 1);
    const leaf = f('a.leaf', 'medium', 1);
    const affected: Record<string, string[]> = { 'a.home': ['https://e.com/'], 'a.leaf': ['https://e.com/blog/p3'] };
    prioritise([home, leaf], (id) => affected[id]!, ctx);
    expect(home.priority!.score).toBeGreaterThan(leaf.priority!.score);
    expect(home.priority!.reasons.join(' ')).toContain('homepage');
  });

  it('treats site-wide findings as full reach and ignores unmeasurable ones', () => {
    const robots = f('robots.unreachable', 'critical', 1);
    const cwv = f('perf.cwv-unmeasured', 'info', 1, { confidence: 'unmeasurable' });
    prioritise([robots, cwv], (id) => (id === 'robots.unreachable' ? ['https://e.com/robots.txt'] : []), ctx);
    expect(robots.priority).toMatchObject({ bucket: 'P1', reach: 1 });
    expect(cwv.priority!.score).toBe(0);
  });

  it('treats markup issues on most pages as one layout fix, but not content issues', () => {
    const markup = f('title.multiple', 'medium', 10);
    const thin = f('content.low-text', 'low', 10, { category: 'content' });
    prioritise([markup, thin], () => urls, ctx);
    expect(markup.priority!.effort).toBe('low');
    expect(markup.priority!.reasons.join(' ')).toContain('shared layout');
    expect(thin.priority!.effort).not.toBe('low');
  });

  it('marks template-concentrated and auto-fixable issues as low effort', () => {
    const tpl = f('title.multiple', 'medium', 9);
    const auto = f('html.lang-missing', 'low', 1, { autofixable: true });
    prioritise([tpl, auto], (id) => (id === 'title.multiple' ? urls.slice(1) : ['https://e.com/']), ctx);
    expect(tpl.priority!.effort).toBe('low');
    expect(tpl.templates).toEqual([{ pattern: '/blog/*', pages: 9 }]);
    expect(auto.priority!.effort).toBe('low');
  });
});
