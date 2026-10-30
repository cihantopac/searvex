import { describe, expect, it } from 'vitest';
import { brandTermsFrom, classifyQueryIntent, intentConflict, pageIntent } from '../../src/analyze/intent.js';

describe('query intent (inferred)', () => {
  const cases: Array<[string, string | null]> = [
    ['how to set up dmarc', 'informational'],
    ['dmarc nedir', 'informational'],
    ['e-posta nasıl taşınır', 'informational'],
    ['best email hosting for startups', 'commercial'],
    ['gmail vs outlook', 'commercial'],
    ['en iyi site kurucu', 'commercial'],
    ['notion alternatifleri', 'commercial'],
    ['email hosting pricing', 'transactional'],
    ['kurumsal e-posta fiyatları', 'transactional'],
    ['best price laptop', 'transactional'], // purchase cue wins over comparison
    ['acme login', 'navigational'],
    ['acme', 'navigational'],
    ['email hosting', null],
  ];
  for (const [q, want] of cases) {
    it(`${q} → ${want}`, () => expect(classifyQueryIntent(q, ['acme'])?.intent ?? null).toBe(want));
  }
  it('reports the cues and never claims verification', () => {
    const g = classifyQueryIntent('how does spf work')!;
    expect(g.basis).toBe('inferred');
    expect(g.signals).toContain('"how"');
  });
  it('does not match cue words inside other words', () => {
    expect(classifyQueryIntent('showcase laptops')).toBeNull(); // "how" in "showcase", "top" in "laptops"
  });
});

describe('page intent and conflicts', () => {
  it('maps page types to intents', () => {
    expect(pageIntent({ type: 'blog-post', basis: 'schema' })?.intent).toBe('informational');
    expect(pageIntent({ type: 'pricing', basis: 'url' })?.intent).toBe('transactional');
    expect(pageIntent({ type: 'other', basis: 'default' })).toBeNull();
  });
  it('flags only clear conflicts', () => {
    expect(intentConflict('informational', 'transactional')).toBe(true);
    expect(intentConflict('transactional', 'informational')).toBe(true);
    expect(intentConflict('commercial', 'informational')).toBe(false);
    expect(intentConflict('informational', 'navigational')).toBe(false);
  });
  it('derives brand terms from a property', () => {
    expect(brandTermsFrom('sc-domain:shop.acme.com')).toEqual(['acme']);
    expect(brandTermsFrom('https://www.acme.co/')).toEqual(['acme']);
    expect(brandTermsFrom('https://acme.com.tr/')).toEqual(['acme']);
  });
});

describe('URL-based page types', () => {
  it('recognises common legal pages (real-world: SaaS policy pages were "other") without catching look-alikes', async () => {
    const { URL_RULES } = await import('../../src/analyze/inventory.js');
    const type = (path: string) => URL_RULES.find(([re]) => re.test(path))?.[1] ?? 'other';
    for (const p of ['/acceptable-use', '/refund', '/refund-policy', '/sla', '/dpa', '/subprocessors', '/gizlilik-politikasi', '/kvkk-aydinlatma-metni', '/agb', '/datenschutz']) expect(type(p), p).toBe('legal');
    for (const p of ['/slack-integration', '/dpa-tools/x', '/refunded-orders-report', '/security']) expect(type(p), p).not.toBe('legal');
  });
});
