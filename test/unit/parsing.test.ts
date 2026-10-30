import { describe, expect, it } from 'vitest';
import { normalizeUrl, looksLikeAsset } from '../../src/core/url.js';
import { botAccessMatrix, parseRobots } from '../../src/crawl/robots.js';
import { parseSitemapXml } from '../../src/crawl/sitemap.js';
import { extractPage, parseXRobotsTag } from '../../src/extract/html.js';
import { isValidHreflang } from '../../src/analyze/technical.js';
import { validateNode } from '../../src/analyze/structured-data.js';
import { parseCsv } from '../../src/integrations/csv.js';
import { rowsFromCsv } from '../../src/commands/monitor.js';
import { unifiedDiff } from '../../src/optimize/diff.js';
import { tokenize } from '../../src/analyze/content.js';

describe('normalizeUrl', () => {
  it('drops fragments, default ports and tracking params, keeps path case', () => {
    expect(normalizeUrl('HTTPS://Example.com:443/A/b?utm_source=x&id=2#top')).toBe('https://example.com/A/b?id=2');
    expect(normalizeUrl('/x', 'http://example.com/a/')).toBe('http://example.com/x');
    expect(normalizeUrl('mailto:a@b.c')).toBeNull();
    expect(normalizeUrl('javascript:void(0)')).toBeNull();
  });
  it('recognises assets', () => {
    expect(looksLikeAsset('https://e.com/a.png?v=1')).toBe(true);
    expect(looksLikeAsset('https://e.com/blog/png-guide')).toBe(false);
  });
});

describe('robots.txt', () => {
  const robots = parseRobots(
    'https://e.com/robots.txt',
    'User-agent: *\nDisallow: /private/\nAllow: /private/ok$\n\nUser-agent: GPTBot\nDisallow: /\n\nUser-agent: Googlebot\nDisallow: /*.pdf$\n\nSitemap: https://e.com/sm.xml\n',
    200,
  );
  it('applies longest-match and wildcards', () => {
    expect(robots.isAllowed('https://e.com/private/x', 'Searvex')).toBe(false);
    expect(robots.isAllowed('https://e.com/private/ok', 'Searvex')).toBe(true);
    expect(robots.isAllowed('https://e.com/doc.pdf', 'Googlebot')).toBe(false);
    expect(robots.isAllowed('https://e.com/private/x', 'Googlebot')).toBe(true); // specific group replaces *
  });
  it('applies a "Searvex" or "SearvexBot" group to the SearvexBot crawler', () => {
    const r1 = parseRobots('https://e.com/robots.txt', 'User-agent: SearvexBot\nDisallow: /', 200);
    expect(r1.isAllowed('https://e.com/', 'SearvexBot')).toBe(false);
  });
  it('builds a bot matrix marking explicit groups', () => {
    const m = botAccessMatrix(robots, 'https://e.com/');
    expect(m.find((b) => b.bot.token === 'GPTBot')).toMatchObject({ homepageAllowed: false, explicit: true });
    expect(m.find((b) => b.bot.token === 'ClaudeBot')).toMatchObject({ homepageAllowed: true, explicit: false });
    expect(robots.sitemaps).toEqual(['https://e.com/sm.xml']);
  });
});

describe('sitemap parsing', () => {
  it('parses urlset with hreflang alternates and flags bad lastmod', () => {
    const r = parseSitemapXml(
      '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml"><url><loc>https://e.com/</loc><lastmod>yesterday</lastmod><xhtml:link rel="alternate" hreflang="de" href="https://e.com/de/"/></url></urlset>',
      'sm',
    );
    expect(r.urls[0]!.alternates).toEqual([{ hreflang: 'de', href: 'https://e.com/de/' }]);
    expect(r.issues.some((i) => i.message.includes('lastmod'))).toBe(true);
  });
  it('parses sitemap indexes and rejects non-sitemaps', () => {
    expect(parseSitemapXml('<sitemapindex><sitemap><loc>https://e.com/a.xml</loc></sitemap></sitemapindex>', 's').children).toEqual(['https://e.com/a.xml']);
    expect(parseSitemapXml('<html></html>', 's').issues[0]!.message).toMatch(/Not a sitemap/);
  });
  it('does not expand XML entities (billion laughs / XXE safe)', () => {
    const evil = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]><urlset><url><loc>https://e.com/&b;</loc></url></urlset>';
    const r = parseSitemapXml(evil, 's');
    expect(r.urls[0]?.loc ?? '').not.toContain('aaaaaaaaaa');
  });
});

describe('HTML extraction', () => {
  const html = `<!doctype html><html lang="de"><head><base href="/sub/"><title> A  Title </title><meta name="description" content="Desc"><meta name="robots" content="noindex, nofollow"><meta name="googlebot" content="nosnippet"><link rel="canonical" href="page"><link rel="alternate" hreflang="en" href="https://e.com/en/"><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"X"},{"@type":["Product","Thing"],"name":"P"}]}</script></head><body><h1>Head</h1><p>One two</p><p>three</p><a href="x">X</a><a href="https://other.com/">O</a><a>No href</a><img src="a.png"><script>var hidden = "do not count";</script></body></html>`;
  const p = extractPage(html, 'https://e.com/dir/index.html');
  it('extracts head signals', () => {
    expect(p.title).toBe('A Title');
    expect(p.lang).toBe('de');
    expect(p.metaRobots).toEqual(['noindex', 'nofollow']);
    expect(p.botRobots['googlebot']).toEqual(['nosnippet']);
    expect(p.canonical).toBe('https://e.com/sub/page');
    expect(p.canonicalRaw).toBe('page');
    expect(p.jsonLd[0]!.types).toEqual(expect.arrayContaining(['Organization', 'Product', 'Thing']));
  });
  it('resolves links against <base> and classifies them', () => {
    expect(p.links.find((l) => l.text === 'X')!.url).toBe('https://e.com/sub/x');
    expect(p.links.find((l) => l.text === 'O')!.internal).toBe(false);
    expect(p.links.find((l) => l.text === 'No href')!.uncrawlable).toBe(true);
  });
  it('separates words across elements and ignores scripts', () => {
    expect(p.textContent).toContain('Head One two three');
    expect(p.textContent).not.toContain('do not count');
  });
  it('follows HTML5 tree construction: a canonical after an invalid head element lands in <body>', () => {
    const q = extractPage('<html><head><title>T</title><img src="x.png"><link rel="canonical" href="https://e.com/a"></head><body></body></html>', 'https://e.com/a');
    expect(q.canonical).toBeNull();
    expect(q.canonicalOutsideHead).toBe(1);
  });
  it('extracts schema types from Microdata (multi-type) and RDFa', () => {
    const q = extractPage('<html><body><div itemscope itemtype="https://schema.org/Product https://schema.org/Thing"></div><div vocab="https://schema.org/" typeof="LocalBusiness"></div><div typeof="schema:Event"></div></body></html>', 'https://e.com/');
    expect(q.microdataTypes).toEqual(['Product', 'Thing']);
    expect(q.rdfaTypes).toEqual(['LocalBusiness', 'Event']);
  });
  it('ignores <title> inside inline SVG (real-world MDN false positive)', () => {
    const q = extractPage('<html><head><title>Doc</title></head><body><svg><title>Icon</title></svg><svg><title>Logo</title></svg></body></html>', 'https://e.com/');
    expect(q.titleCount).toBe(1);
    expect(q.title).toBe('Doc');
  });
  it('computes link names from aria-labelledby, img alt and declarative shadow DOM', () => {
    const q = extractPage(
      '<html><body><span id="l1">Read the post</span><a href="/a" aria-labelledby="l1"></a><a href="/b"><img src="x" alt="Logo"></a><my-card><template shadowrootmode="open"><p>Shadow text here</p></template></my-card></body></html>',
      'https://e.com/',
    );
    expect(q.links.map((l) => l.text)).toEqual(['Read the post', 'Logo']);
    expect(q.textContent).toContain('Shadow text here');
  });
  it('parses X-Robots-Tag with bot prefixes and unavailable_after', () => {
    const x = parseXRobotsTag('googlebot: noindex, nofollow, unavailable_after: 2027-01-01');
    expect(x.byBot['googlebot']).toContain('noindex');
    expect(parseXRobotsTag('noindex, nosnippet').all).toEqual(['noindex', 'nosnippet']);
  });
});

describe('hreflang validation', () => {
  it.each([['en', true], ['en-GB', true], ['zh-Hant-TW', true], ['x-default', true], ['en-UK', false], ['jp', false], ['english', false], ['es-419', false]])('%s → %s', (c, ok) => {
    expect(isValidHreflang(c)).toBe(ok);
  });
});

describe('structured data requirements', () => {
  it('requires name + one of offers/review/aggregateRating for Product', () => {
    expect(validateNode({ '@type': 'Product', name: 'X' })?.missing).toEqual(['review | aggregateRating | offers']);
    expect(validateNode({ '@type': 'Product', name: 'X', offers: { price: 1 } })).toBeNull();
  });
  it('treats LocalBusiness subtypes and remote jobs correctly', () => {
    expect(validateNode({ '@type': 'Restaurant', name: 'R' })?.missing).toEqual(['address']);
    expect(validateNode({ '@type': 'JobPosting', datePosted: 'x', description: 'd', hiringOrganization: {}, title: 't', jobLocationType: 'TELECOMMUTE' })).toBeNull();
  });
  it('has no required properties for Article (per Google docs)', () => {
    expect(validateNode({ '@type': 'Article' })).toBeNull();
  });
});

describe('CSV import', () => {
  it('parses quoted fields and maps Search Console exports', () => {
    const rows = parseCsv('﻿Top queries,Clicks,Impressions,CTR,Position\n"a, b",10,100,10%,3.2\nc,0,5,0%,12\n');
    expect(rows[0]!['Top queries']).toBe('a, b');
    const g = rowsFromCsv(rows);
    expect(g[0]).toMatchObject({ keys: ['a, b'], clicks: 10, impressions: 100, ctr: 0.1, position: 3.2 });
  });
});

describe('unifiedDiff', () => {
  it('produces minimal hunks', () => {
    const d = unifiedDiff('f.html', 'a\nb\nc\nd', 'a\nb\nX\nc\nd');
    expect(d).toContain('+X');
    expect(d).not.toContain('-a');
    expect(d.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'))).toEqual(['+X']);
  });
  it('handles file creation', () => {
    expect(unifiedDiff('n.txt', null, 'hi')).toContain('--- /dev/null');
  });
});

describe('tokenize', () => {
  it('handles Unicode and removes stopwords', () => {
    expect(tokenize('Profesyonel mutfak ekipmanları ve the kitchen 2026')).toEqual(['profesyonel', 'mutfak', 'ekipmanları', 'kitchen']);
  });
});
