import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importGscFiles, parseGscTable, parseLocaleNumber } from '../../src/integrations/gsc-csv.js';
import { readZip } from '../../src/integrations/zip.js';
import { decodeText, detectDelimiter } from '../../src/integrations/csv.js';
import { analyzeSearchPerformance } from '../../src/analyze/search-performance.js';
import { parseProperty } from '../../src/integrations/property.js';
import { makeZip } from '../helpers/search-data.js';

// Shapes of a Search Console "Download CSV" export in the English UI.
const EN = {
  'Queries.csv': 'Top queries,Clicks,Impressions,CTR,Position\nsearvex seo,40,200,20%,1.5\nseo audit tool,12,900,1.33%,11.2\n"crm, free",1,50,2%,30\n',
  'Pages.csv': 'Top pages,Clicks,Impressions,CTR,Position\nhttps://www.site.example/,40,300,13.33%,2.1\nhttps://www.site.example/audit,13,850,1.53%,10.9\n',
  'Dates.csv': 'Date,Clicks,Impressions,CTR,Position\n2026-09-01,30,600,5%,8\n2026-09-02,25,600,4.17%,8.4\n',
  'Devices.csv': 'Device,Clicks,Impressions,CTR,Position\nDesktop,40,700,5.71%,7\nMobile,15,500,3%,9.5\n',
  'Filters.csv': 'Filter,Value\nSearch type,Web\nDate,Last 28 days\n',
};

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-csv-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const write = (name: string, data: string | Buffer) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, data);
  return f;
};

describe('Search Console CSV/ZIP import', () => {
  it('reads the English ZIP export: tables by header, period from dates, filters as metadata', () => {
    const zip = write('en.zip', makeZip(Object.entries(EN).map(([name, text]) => ({ name, text }))));
    const exp = importGscFiles([zip]);
    expect(exp.tables.queries).toHaveLength(3);
    expect(exp.tables.queries![2]).toMatchObject({ key: 'crm, free', clicks: 1, impressions: 50 });
    expect(exp.tables.pages![1]).toMatchObject({ key: 'https://www.site.example/audit', clicks: 13, position: 10.9 });
    expect(exp.tables.queries![1]!.ctr).toBeCloseTo(12 / 900);
    expect(exp.period).toEqual({ startDate: '2026-09-01', endDate: '2026-09-02', days: 2 });
    expect(exp.searchType).toBe('Web');
    expect(exp.dateLabel).toBe('Last 28 days');
    expect(exp.warnings).toEqual([]);
  });

  it('reads Turkish headers, decimal commas, "%3,5" percentages and dot thousands separators', () => {
    const tr = 'En çok yapılan sorgular;Tıklamalar;Gösterimler;TO;Konum\nseo nasıl yapılır;1.234;56.789;%2,17;7,4\nsearvex;3;10;%30;1\n';
    const t = parseGscTable(tr, 'Sorgular.csv')!;
    expect(t.kind).toBe('queries');
    expect(t.rows[0]).toMatchObject({ key: 'seo nasıl yapılır', clicks: 1234, impressions: 56789, position: 7.4 });
    const pages = parseGscTable('Popüler sayfalar,Tıklamalar,Gösterimler,TO,Konum\nhttps://site.example/,"1,5",10,"%1,2","3,5"\n', 'Sayfalar.csv');
    expect(pages?.kind).toBe('pages');
    expect(parseGscTable('Tarih,Tıklamalar,Gösterimler,TO,Konum\n01.09.2026,1,10,%10,2\n', 'Tarihler.csv')!.rows[0]!.key).toBe('2026-09-01');
  });

  it('decodes UTF-16LE files saved by spreadsheet programs and detects tab/semicolon delimiters', () => {
    const text = 'Top queries\tClicks\tImpressions\tCTR\tPosition\nä query\t1\t10\t10%\t2\n';
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    expect(decodeText(buf)).toBe(text);
    expect(detectDelimiter('a;b;"c;d",e\n')).toBe(';');
    const f = write('utf16.csv', buf);
    expect(importGscFiles([f]).tables.queries![0]!.key).toBe('ä query');
  });

  it('parses locale numbers strictly', () => {
    expect(parseLocaleNumber('1,234', false)).toBe(1234);
    expect(parseLocaleNumber('1.234', true)).toBe(1234);
    expect(parseLocaleNumber('7,25', true)).toBe(7.25);
    expect(parseLocaleNumber('12 345', false)).toBe(12345);
    expect(parseLocaleNumber('n/a', false)).toBeNull();
    expect(parseLocaleNumber('', false)).toBeNull();
  });

  it('warns about filtered exports, truncated tables and unrecognised headers', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => `q${i},1,10,10%,5`).join('\n');
    const big = write('Queries-big.csv', `Top queries,Clicks,Impressions,CTR,Position\n${rows}\n`);
    const filt = write('Filters.csv', 'Filter,Value\nQuery,+brand\n');
    const exp = importGscFiles([big, filt]);
    expect(exp.warnings.join(' ')).toMatch(/at most 1000 rows/);
    expect(exp.warnings.join(' ')).toMatch(/filtered \(Query: \+brand\)/);
    const odd = parseGscTable('Sorgu terimi,A,B,C,D\nx,1,10,10%,3\n', 'x.csv')!;
    expect(odd.rows[0]).toMatchObject({ clicks: 1, impressions: 10 });
    expect(odd.warnings[0]).toMatch(/assumed the Search Console order/);
  });

  it('fails with actionable errors on files that are not performance exports', () => {
    expect(() => importGscFiles([write('other.csv', 'name,email\nAda,a@x\n')])).toThrow(/Performance → Export → Download CSV/);
    expect(() => importGscFiles([write('bad.csv', 'Top queries,Clicks,Impressions,CTR,Position\na,x,y,z,w\nb,x,y,z,w\nc,x,y,z,w\nd,1,2,3,4\n')])).toThrow(/unreadable numbers/);
    expect(() => importGscFiles([path.join(dir, 'missing.zip')])).toThrow(/Cannot read/);
  });
});

describe('ZIP reader limits', () => {
  it('reads stored and deflated entries', () => {
    const z = makeZip([{ name: 'a.csv', text: 'x', deflate: false }, { name: 'b.csv', text: 'y'.repeat(1000) }]);
    expect(readZip(z).map((e) => [e.name, e.data.length])).toEqual([['a.csv', 1], ['b.csv', 1000]]);
  });

  it('rejects zip bombs, encrypted entries, too many entries and corrupt archives', () => {
    expect(() => readZip(makeZip([{ name: 'bomb.csv', text: Buffer.alloc(2_000_000) }]), { maxEntryBytes: 1_000_000 })).toThrow(/too large/);
    expect(() => readZip(makeZip([{ name: 's.csv', text: 'x', flags: 1 }]))).toThrow(/Encrypted/);
    expect(() => readZip(makeZip(Array.from({ length: 5 }, (_, i) => ({ name: `${i}.csv`, text: 'x' }))), { maxEntries: 4 })).toThrow(/entries/);
    expect(() => readZip(Buffer.from('PK\u0003\u0004 not really a zip'))).toThrow(/Not a ZIP/);
  });
});

describe('analysis of a CSV import (separate tables)', () => {
  const exp = { queries: [{ key: 'seo audit tool', clicks: 12, impressions: 900, ctr: 12 / 900, position: 11.2 }], pages: [{ key: 'https://www.site.example/audit', clicks: 13, impressions: 850, ctr: 13 / 850, position: 10.9 }], dates: [{ key: '2026-09-01', clicks: 55, impressions: 1200, ctr: 0, position: 8 }] };
  const audit = { inventory: { pages: [{ url: 'https://www.site.example/audit', indexable: true }, { url: 'https://www.site.example/new', indexable: true }, { url: 'https://other.example/x', indexable: true }] }, findings: [{ ruleId: 'meta.description-missing', title: 'Missing description', severity: 'medium', evidence: [{ url: 'https://www.site.example/audit' }] }] } as never;
  const r = analyzeSearchPerformance(exp, { days: 1, source: 'csv', audit, property: parseProperty('https://www.site.example/', { anyProtocol: true }) });

  it('computes query and page sections, uses daily totals and marks query × page sections as not measured', () => {
    expect(r.granularity).toBe('separate');
    expect(r.totals).toMatchObject({ clicks: 55, impressions: 1200, basis: 'daily property totals' });
    expect(r.strikingDistance[0]).toMatchObject({ query: 'seo audit tool', page: null });
    expect(r.topPages[0]).toMatchObject({ primaryQuery: null, queries: null });
    expect(r.multiPageQueries).toEqual([]);
    expect(r.notMeasured.join(' ')).toMatch(/no query × page combination/);
  });

  it('lists pages without impressions with legal and contact pages last', () => {
    const a = { inventory: { pages: [{ url: 'https://www.site.example/privacy', indexable: true, type: 'legal' }, { url: 'https://www.site.example/guide', indexable: true, type: 'blog-post' }] }, findings: [] } as never;
    expect(analyzeSearchPerformance({ pages: exp.pages }, { days: 1, source: 'csv', audit: a }).noImpressions).toEqual(['https://www.site.example/guide', 'https://www.site.example/privacy']);
  });

  it('joins the audit by page, ignoring audit pages outside the property', () => {
    expect(r.findingsOnTrafficPages[0]).toMatchObject({ ruleId: 'meta.description-missing', clicks: 13 });
    expect(r.noImpressions).toEqual(['https://www.site.example/new']);
  });
});
