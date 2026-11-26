import { describe, expect, it } from 'vitest';
import type { GeoReport } from '../../src/analyze/geo.js';
import type { InventoryPage, SiteInventory } from '../../src/analyze/inventory.js';
import { buildReadiness, notMeasuredReadiness } from '../../src/analyze/readiness.js';

const pg = (url: string, type: InventoryPage['type'] = 'other', indexable = true): InventoryPage => ({ url, type, basis: 'url', lang: 'en', title: url, status: 200, indexable, depth: 1, inlinks: 1, words: 300 });
const inv = (pages: InventoryPage[]): SiteInventory => ({
  pages, byType: {}, languages: {}, hreflangLanguages: [], statusCodes: {}, businessModel: { label: 'x', evidence: [] }, sections: [],
  structuredData: { types: [], pagesWithStructuredData: 0, invalidJsonLdPages: 0 },
});
const bot = (token: string, purpose: string, allowed = true) => ({ token, operator: 'x', purpose, allowed, explicit: false, docs: null });
const geo = (bots = [bot('Googlebot', 'search'), bot('OAI-SearchBot', 'ai-search'), bot('GPTBot', 'ai-training')], llms?: boolean): GeoReport => ({
  bots, entityNames: {}, answerability: { average: 0, pages: [] }, snippetRestricted: [], citations: { measured: false, reason: '' }, notes: [],
  ...(llms === undefined ? {} : { llmsTxt: { url: 'https://x/llms.txt', present: llms, status: llms ? 200 : 404, bytes: llms ? 10 : 0 } }),
});
const pages = (n: number, prefix = '/p') => Array.from({ length: n }, (_, i) => pg(`${prefix}${i}`));
const withSd = (urls: string[]) => (u: string) => urls.includes(u);

describe('buildReadiness', () => {
  it('a defect-free site with almost only legal pages and no structured data is not ready', () => {
    const r = buildReadiness({ inventory: inv([...pages(3), ...Array.from({ length: 17 }, (_, i) => pg(`/legal/${i}`, 'legal'))]), geo: geo(undefined, false), hasStructuredData: () => false });
    expect(r.structuredData).toEqual({ status: 'low', pages: 0, of: 3, percent: 0 });
    expect(r.contentPages).toMatchObject({ status: 'low', pages: 3, indexable: 20, legal: 17 });
    expect(r.aiSearch).toEqual({ status: 'ok', blocked: [], llmsTxt: 'absent', trainingBlocked: 0 });
    expect(r.ready).toBe(false);
  });

  it('applies the thresholds at the boundary (50 % structured data, 10 content pages)', () => {
    const ten = pages(10);
    expect(buildReadiness({ inventory: inv(ten), geo: geo(), hasStructuredData: withSd(ten.slice(0, 5).map((p) => p.url)) }).structuredData).toMatchObject({ status: 'ok', percent: 50 });
    expect(buildReadiness({ inventory: inv(ten), geo: geo(), hasStructuredData: withSd(ten.slice(0, 4).map((p) => p.url)) }).structuredData).toMatchObject({ status: 'low', percent: 40 });
    const hundred = pages(100);
    expect(buildReadiness({ inventory: inv(hundred), geo: geo(), hasStructuredData: withSd(hundred.slice(0, 49).map((p) => p.url)) }).structuredData.status).toBe('low');
    expect(buildReadiness({ inventory: inv(pages(9)), geo: geo(), hasStructuredData: () => true }).contentPages.status).toBe('low');
    const ok = buildReadiness({ inventory: inv(ten), geo: geo(), hasStructuredData: () => true });
    expect(ok.contentPages.status).toBe('ok');
    expect(ok.ready).toBe(true);
  });

  it('excludes legal and noindex pages and counts only content pages for structured data', () => {
    const r = buildReadiness({ inventory: inv([...pages(10), pg('/privacy', 'legal'), pg('/hidden', 'other', false)]), geo: geo(), hasStructuredData: (u) => u === '/privacy' || u === '/hidden' });
    expect(r.contentPages).toMatchObject({ pages: 10, indexable: 11, legal: 1 });
    expect(r.structuredData).toMatchObject({ pages: 0, of: 10, status: 'low' });
  });

  it('lists the top five content page types', () => {
    const list = [pg('/a', 'blog-post'), pg('/b', 'blog-post'), pg('/c', 'docs'), pg('/d', 'pricing'), pg('/e', 'about'), pg('/f', 'contact'), pg('/g', 'careers')];
    const r = buildReadiness({ inventory: inv(list), geo: geo(), hasStructuredData: () => false });
    expect(Object.keys(r.contentPages.byType!)).toHaveLength(5);
    expect(r.contentPages.byType!['blog-post']).toBe(2);
  });

  it('an AI search or search crawler blocked for the homepage is low; training crawlers and llms.txt never are', () => {
    const blocked = buildReadiness({ inventory: inv(pages(10)), geo: geo([bot('Googlebot', 'search'), bot('OAI-SearchBot', 'ai-search', false), bot('PerplexityBot', 'ai-search', false)]), hasStructuredData: () => true });
    expect(blocked.aiSearch).toMatchObject({ status: 'low', blocked: ['OAI-SearchBot', 'PerplexityBot'] });
    expect(blocked.ready).toBe(false);
    expect(buildReadiness({ inventory: inv(pages(10)), geo: geo([bot('Bingbot', 'search', false)]), hasStructuredData: () => true }).aiSearch.status).toBe('low');
    const training = buildReadiness({ inventory: inv(pages(10)), geo: geo([bot('Googlebot', 'search'), bot('GPTBot', 'ai-training', false), bot('ClaudeBot', 'ai-training', false)], false), hasStructuredData: () => true });
    expect(training.aiSearch).toEqual({ status: 'ok', blocked: [], llmsTxt: 'absent', trainingBlocked: 2 });
    expect(training.ready).toBe(true);
  });

  it('reports what was not measured instead of zero', () => {
    const noBots = buildReadiness({ inventory: inv(pages(10)), geo: geo([]), hasStructuredData: () => true });
    expect(noBots.aiSearch).toEqual({ status: 'not-measured' });
    expect(noBots.ready).toBe(true);
    const unreadRobots = buildReadiness({ inventory: inv(pages(10)), geo: geo(), hasStructuredData: () => true, robotsMeasured: false });
    expect(unreadRobots.aiSearch.status).toBe('not-measured');
    const noContent = buildReadiness({ inventory: inv([pg('/terms', 'legal')]), geo: geo(), hasStructuredData: () => true });
    expect(noContent.structuredData).toEqual({ status: 'not-measured' });
    expect(noContent.contentPages).toMatchObject({ status: 'low', pages: 0 });
    const noPages = buildReadiness({ inventory: inv(pages(3)), geo: geo([]) });
    expect(noPages.structuredData.status).toBe('not-measured');
    expect(noPages.contentPages.status).toBe('not-measured');
    expect(noPages.ready).toBeNull();
    expect(notMeasuredReadiness().ready).toBeNull();
  });

  it('a partially measured site is not ready when a measured signal is low', () => {
    const r = buildReadiness({ inventory: inv([pg('/terms', 'legal')]), geo: geo([]), hasStructuredData: () => false });
    expect(r.ready).toBe(false);
  });

  it('marks values from a partial crawl', () => {
    const r = buildReadiness({ inventory: inv(pages(10)), geo: geo(), hasStructuredData: () => true, partial: true });
    expect(r.structuredData.partial).toBe(true);
    expect(r.contentPages.partial).toBe(true);
    expect(r.thresholds).toEqual({ structuredDataPercent: 50, contentPages: 10 });
  });
});

describe('readiness in repository mode', () => {
  it('measures pages from a static-site build but not crawler access without a robots.txt in the repository', async () => {
    const path = await import('node:path');
    const { auditRepository } = await import('../../src/repo/audit.js');
    const r = auditRepository(path.resolve('test/fixtures/repos/static-site')).report.readiness!;
    expect(r.contentPages.status).not.toBe('not-measured');
    expect(r.aiSearch.status).toBe('not-measured');
    const next = auditRepository(path.resolve('test/fixtures/repos/nextjs-app')).report.readiness!;
    expect(next.structuredData.status).toBe('not-measured');
    expect(next.contentPages.status).toBe('not-measured');
    expect(next.ready).toBeNull();
  });
});

describe('readiness in the Markdown report', () => {
  it('prints one summary row, and none when nothing was measured', async () => {
    const path = await import('node:path');
    const { auditRepository } = await import('../../src/repo/audit.js');
    const { renderMarkdown } = await import('../../src/report/markdown.js');
    const r = auditRepository(path.resolve('test/fixtures/repos/static-site')).report;
    expect(renderMarkdown(r)).toMatch(/\| Search readiness \(separate from the score\) \| structured data .+ · content pages \d+ \((low|ok)\) · AI search not measured \|/);
    expect(renderMarkdown({ ...r, readiness: notMeasuredReadiness() })).not.toContain('Search readiness');
  });
});
