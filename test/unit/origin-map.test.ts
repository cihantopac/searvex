import { describe, expect, it } from 'vitest';
import { mapOrigin, originMap } from '../../src/core/url.js';
import { mapPageData } from '../../src/crawl/crawler.js';
import { extractPage } from '../../src/extract/html.js';

describe('originMap', () => {
  it('maps the public origin to the crawled origin', () => {
    expect(originMap('https://example.com', 'http://127.0.0.1:4400/')).toEqual({ from: 'https://example.com', to: 'http://127.0.0.1:4400' });
    // Path and trailing slash of --site-url do not matter; default ports are dropped.
    expect(originMap('https://Example.com:443/blog/', 'http://localhost:3000/x')).toEqual({ from: 'https://example.com', to: 'http://localhost:3000' });
  });

  it('is undefined without a mapping to do', () => {
    expect(originMap(undefined, 'http://127.0.0.1/')).toBeUndefined();
    expect(originMap('https://example.com/', 'https://example.com/page')).toBeUndefined();
    expect(originMap('sc-domain:example.com', 'http://127.0.0.1/')).toBeUndefined();
    expect(originMap('not a url', 'http://127.0.0.1/')).toBeUndefined();
  });
});

describe('mapOrigin', () => {
  const map = originMap('https://example.com', 'http://127.0.0.1:4400')!;

  it('keeps path, query and fragment', () => {
    expect(mapOrigin('https://example.com/', map)).toBe('http://127.0.0.1:4400/');
    expect(mapOrigin('https://example.com/tr/blog/?page=2#top', map)).toBe('http://127.0.0.1:4400/tr/blog/?page=2#top');
    expect(mapOrigin('https://example.com:443/a', map)).toBe('http://127.0.0.1:4400/a');
  });

  it('leaves other origins alone, including scheme and www variants (those are real differences)', () => {
    for (const u of ['http://example.com/', 'https://www.example.com/', 'https://example.com:8443/', 'https://other.org/', 'mailto:a@example.com', '']) expect(mapOrigin(u, map)).toBe(u);
    expect(mapOrigin('https://example.com/', undefined)).toBe('https://example.com/');
  });
});

describe('mapPageData', () => {
  it('maps canonical, hreflang and links, and marks mapped links internal', () => {
    const html =
      '<html><head><link rel="canonical" href="https://example.com/a"><link rel="alternate" hreflang="tr" href="https://example.com/tr/a"></head>' +
      '<body><a href="https://example.com/b">b</a><a href="https://other.org/">o</a><a href="/c">c</a></body></html>';
    const d = mapPageData(extractPage(html, 'http://127.0.0.1:4400/a'), originMap('https://example.com', 'http://127.0.0.1:4400'));
    expect(d.canonical).toBe('http://127.0.0.1:4400/a');
    expect(d.canonicalRaw).toBe('https://example.com/a');
    expect(d.hreflang).toEqual([{ lang: 'tr', href: 'http://127.0.0.1:4400/tr/a' }]);
    expect(d.links.map((l) => [l.url, l.internal])).toEqual([
      ['http://127.0.0.1:4400/b', true],
      ['https://other.org/', false],
      ['http://127.0.0.1:4400/c', true],
    ]);
  });
});
