import { describe, expect, it } from 'vitest';
import { checkSources, compareSnapshot, extractLastUpdated, normaliseForHash, type SourceSnapshot } from '../../src/rules/sources.js';
import { DEFAULT_POLICY } from '../../src/net/ssrf.js';
import type { KnowledgeBase, Rule } from '../../src/rules/engine.js';
import { startServer, type Route } from '../helpers/server.js';

const doc = (body: string, updated = '2026-01-10') => `<!doctype html><html><head><title>Doc</title></head><body><nav>menu</nav><main><h1>Guide</h1><p>${body}</p><p>Last updated ${updated} UTC.</p></main></body></html>`;
const LONG = 'The rel canonical link element is only accepted if it appears in the head section of the HTML. '.repeat(5);

describe('source revalidation', () => {
  it('extracts update dates from documentation-site patterns', () => {
    expect(extractLastUpdated('<p>Last updated 2025-12-10 UTC.</p>')).toBe('2025-12-10');
    expect(extractLastUpdated('This page was last modified on <time datetime="2026-08-15T03:00:00Z">Aug 15</time>')).toBe('2026-08-15');
    expect(extractLastUpdated('<p>Last updated: October 31, 2024</p>')).toBe('2024-10-31');
    expect(extractLastUpdated('<p>nothing</p>')).toBeNull();
    expect(normaliseForHash('Text 2026-01-10 here. Last updated 2026-01-10 UTC')).toBe(normaliseForHash('Text 2027-02-11 here. Last updated 2027-02-11 UTC'));
  });

  it('classifies new, unchanged, changed, redirected, broken and client-rendered sources', async () => {
    const routes: Record<string, Route> = {
      '/stable': { body: doc(LONG) },
      '/edited': { body: doc(LONG + ' New exception: does not apply to AMP.', '2026-01-10') },
      '/dated': { body: doc(LONG, '2026-09-01') },
      '/moved': { redirect: '/new-home' },
      '/new-home': { body: doc(LONG) },
      '/gone': { status: 404, body: 'x' },
      '/spa': { body: '<html><head><title>App</title></head><body><div id="root"></div><script>render()</script></body></html>' },
    };
    const s = await startServer(routes);
    const u = (p: string) => s.url + p;
    const rule = (id: string, url: string) => ({ id, sources: [{ title: id, url, checked: '2026-10-30' }] }) as unknown as Rule;
    const kb: KnowledgeBase = { version: 'x', files: [], rules: new Map(['/stable', '/edited', '/dated', '/moved', '/gone', '/spa'].map((p, i) => [`r.${i}`, rule(`r.${i}`, u(p))])) };
    const prevHash = (await checkSources(kb, {}, { policy: { ...DEFAULT_POLICY, allowPrivate: true }, delayMs: 0 })).reduce<Record<string, SourceSnapshot>>((m, r) => ({ ...m, [r.url]: r.current }), {});
    // Baseline: the "edited" page had different text; the "dated" page an older date.
    prevHash[u('/edited')] = { ...prevHash[u('/edited')]!, contentHash: 'old-hash' };
    prevHash[u('/dated')] = { ...prevHash[u('/dated')]!, lastUpdated: '2026-01-10' };
    const results = await checkSources(kb, prevHash, { policy: { ...DEFAULT_POLICY, allowPrivate: true }, delayMs: 0 });
    const by = Object.fromEntries(results.map((r) => [new URL(r.url).pathname, r.change]));
    expect(by, JSON.stringify(by)).toEqual({ '/stable': 'unchanged', '/edited': 'content-changed', '/dated': 'date-changed', '/moved': 'redirected', '/gone': 'broken', '/spa': 'unreadable' });
    expect(results.find((r) => r.url.endsWith('/edited'))!.rules).toEqual(['r.1']);
    await s.close();
  });

  it('reports "new" when there is no previous snapshot', () => {
    const cur = { url: 'https://a/', finalUrl: 'https://a/', status: 200, contentHash: 'h', lastUpdated: null, title: 't', textLength: 500, fetchedAt: '' };
    expect(compareSnapshot(undefined, cur).change).toBe('new');
  });
});
