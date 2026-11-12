import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditWebsite } from '../../src/analyze/audit.js';
import { crawl, type PageRecord } from '../../src/crawl/crawler.js';
import { RunStore } from '../../src/crawl/store.js';
import { DEFAULT_POLICY } from '../../src/net/ssrf.js';
import { page, startServer, text, type TestServer } from '../helpers/server.js';

const policy = { ...DEFAULT_POLICY, allowPrivate: true };
let site: TestServer;
let ws: string;

beforeAll(async () => {
  site = await startServer({
    '/': { body: page({ title: 'Home page of the site', body: `<main><h1>Home</h1>${text(120)}<a href="/a">a</a><a href="/b">b</a><a href="/tr">tr</a></main>` }) },
    // Same main text on two pages: an exact duplicate, found from the stored texts.
    '/a': { body: page({ title: 'Page A of the site', body: `<main><h1>Same</h1>${text(200)}</main>` }) },
    '/b': { body: page({ title: 'Page B of the site', body: `<main><h1>Same</h1>${text(200)}</main>` }) },
    // Declared Turkish, written in English: language detection reads the stored text too.
    '/tr': { body: page({ title: 'Türkçe sayfa başlığı', lang: 'tr', body: `<main><h1>Sayfa</h1>${text(200)}</main>` }) },
  });
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-texts-'));
});

afterAll(async () => {
  await site.close();
  fs.rmSync(ws, { recursive: true, force: true });
});

describe('G7: page texts on disk', () => {
  it('appendText / readText round-trip byte ranges, also for a store reopened on the same run', () => {
    const a = new RunStore(ws, 'texts-unit');
    const r1 = a.appendText('İstanbul çay ğüş — 日本');
    const r2 = a.appendText('second');
    expect(r1).toEqual({ offset: 0, length: Buffer.byteLength('İstanbul çay ğüş — 日本') });
    expect(a.readText(r1)).toBe('İstanbul çay ğüş — 日本');
    // A resumed run continues after the existing bytes.
    const b = new RunStore(ws, 'texts-unit');
    const r3 = b.appendText('third');
    expect(r3.offset).toBe(r2.offset + r2.length);
    expect([b.readText(r2), b.readText(r3)]).toEqual(['second', 'third']);
  });

  it('a crawl with a run directory keeps only text references in its records; the analysis still reads the texts', async () => {
    const { report } = await auditWebsite(site.url + '/', { workspace: ws, probes: false, crawl: { policy, delayMs: 0, concurrency: 1 } });
    const store = new RunStore(ws, report.runId);
    const records = store.readLines<PageRecord>('pages.jsonl');
    expect(records.length).toBe(4);
    for (const r of records) {
      expect(r.data!.mainText).toBe('');
      expect(r.data!.textContent).toBe('');
      expect(r.data!.mainTextRef).toBeDefined();
    }
    expect(store.readText(records.find((r) => r.url.endsWith('/a'))!.data!.mainTextRef!)).toMatch(/^Same Our team designs durable equipment/);
    const ids = report.findings.map((f) => f.ruleId);
    expect(ids).toContain('duplicate.content');
    expect(ids).toContain('lang.content-mismatch');
  });

  it('without a run directory the text stays in memory', async () => {
    const result = await crawl(site.url + '/', { maxPages: 2, maxDepth: 2, concurrency: 1, delayMs: 0, useSitemaps: false, policy });
    expect(result.readText).toBeUndefined();
    expect(result.pages[0]!.data!.mainText).toMatch(/Our team designs/);
    expect(result.pages[0]!.data!.mainTextRef).toBeUndefined();
  });
});
