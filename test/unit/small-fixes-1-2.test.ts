import { describe, expect, it } from 'vitest';
import { personalSiteSignal } from '../../src/analyze/structured-data.js';
import { cssSizedSelectors, extractPage } from '../../src/extract/html.js';
import { indexableSummary, type AuditReport } from '../../src/analyze/audit.js';

describe('A4 personalSiteSignal (heuristic)', () => {
  it('a name-like homepage title without commercial pages is personal', () => {
    for (const t of ['Jane Doe — designer and developer', 'Cihan Topaç | Notes', 'Ada Lovelace', 'Mary-Jane Watson · Photography']) expect(personalSiteSignal(t, ['https://x/', 'https://x/about']).personal, t).toBe(true);
  });

  it('company titles, non-names and commercial pages are not', () => {
    expect(personalSiteSignal('Acme Labs — rockets', ['https://x/']).personal).toBe(false);
    expect(personalSiteSignal('Northwind Studio', ['https://x/']).personal).toBe(false);
    expect(personalSiteSignal('Best coffee beans online', ['https://x/']).personal).toBe(false);
    expect(personalSiteSignal('ACME', ['https://x/']).personal).toBe(false);
    expect(personalSiteSignal(null, ['https://x/']).personal).toBe(false);
    const shop = personalSiteSignal('Jane Doe', ['https://x/', 'https://x/pricing']);
    expect(shop).toMatchObject({ personal: false, reason: expect.stringMatching(/commercial page/) });
  });
});

describe('A5 CSS-sized images', () => {
  const imgs = (html: string) => extractPage(`<html><head>${html.includes('<style') ? '' : ''}</head><body>${html}</body></html>`, 'https://x/').images.map((i) => [i.src, !!i.sizedByLayout]);

  it('inline style with fixed width and height (or aspect-ratio) counts as sized', () => {
    expect(
      imgs('<img src="a" style="width: 40px; height: 40px"><img src="b" style="width:2.5rem;height:2.5rem !important"><img src="c" style="width:100%;aspect-ratio:16/9"><img src="d" style="width:40px"><img src="e" style="width:50%;height:auto">'),
    ).toEqual([['a', true], ['b', true], ['c', true], ['d', false], ['e', false]]);
  });

  it('a simple class or id rule in an inline <style> counts; unsupported selectors are still reported', () => {
    const html =
      '<style>/* avatars */ .avatar{width:40px;height:40px} img#logo{width:120px} img#logo{height:32px} .card img{width:10px;height:10px} .wide{width:100%;height:200px}</style>' +
      '<img src="a" class="rounded avatar"><img src="b" id="logo"><img src="c" class="card-img"><div class="card"><img src="d"></div><img src="e" class="wide">';
    expect(imgs(html)).toEqual([['a', true], ['b', true], ['c', false], ['d', false], ['e', false]]);
  });

  it('fixed-size utility classes count; fluid ones do not', () => {
    expect(imgs('<img src="a" class="size-10"><img src="b" class="w-10 h-10 rounded"><img src="c" class="w-[40px] h-[40px]"><img src="d" class="w-full h-auto"><img src="e" class="w-10">')).toEqual([
      ['a', true], ['b', true], ['c', true], ['d', false], ['e', false],
    ]);
  });

  it('parses selector lists and @media blocks', () => {
    const s = cssSizedSelectors('@media (min-width: 1px) { .m, img.n { width: 1px; height: 1px } } .x{aspect-ratio:auto}');
    expect([...s.classes].sort()).toEqual(['m', 'n']);
    expect(s.ids.size).toBe(0);
  });
});

describe('A6 indexableSummary', () => {
  const r = (indexable: boolean[], noindex: number) =>
    ({ inventory: { pages: indexable.map((i) => ({ indexable: i })) }, findings: noindex ? [{ ruleId: 'index.noindex', count: noindex }] : [] }) as unknown as AuditReport;
  it('says when nothing is indexable because every page is noindex', () => {
    expect(indexableSummary(r([false], 1))).toBe('0 indexable: all noindex');
    expect(indexableSummary(r([true, false], 1))).toBe('1 indexable');
    expect(indexableSummary(r([false, false], 1))).toBe('0 indexable');
  });
});
