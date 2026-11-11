import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auditWebsite, type AuditReport } from '../../src/analyze/audit.js';
import { applyTrafficPriorities } from '../../src/analyze/priority.js';
import { main } from '../../src/cli.js';
import { RunStore } from '../../src/crawl/store.js';
import { DEFAULT_POLICY } from '../../src/net/ssrf.js';
import { renderMarkdown } from '../../src/report/markdown.js';
import { page, startServer, text, type TestServer } from '../helpers/server.js';
import { makeZip } from '../helpers/search-data.js';

let site: TestServer;
let ws: string;
const desc = '<meta name="description" content="A useful and accurate summary of this page for readers.">';

beforeAll(async () => {
  site = await startServer({
    '/': { body: page({ title: 'Home page of the shop', head: desc, body: `<h1>Home</h1>${text(200)}<a href="/a">a</a><a href="/b">b</a>` }) },
    // The same issue (no meta description) on two pages that are equal in structure.
    '/a': { body: page({ title: 'Product A of the shop', body: `<h1>A</h1>${text(200)}` }) },
    '/b': { body: page({ title: 'Product B of the shop', body: `<h1>B</h1>${text(210)}` }) },
  });
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-traffic-'));
});

afterAll(async () => {
  await site.close();
  fs.rmSync(ws, { recursive: true, force: true });
});

const audit = async () => (await auditWebsite(site.url + '/', { workspace: ws, probes: false, crawl: { policy: { ...DEFAULT_POLICY, allowPrivate: true }, delayMs: 0 } })).report;
const byRule = (r: AuditReport, id: string) => r.findings.find((f) => f.ruleId === id)!;

describe('F1: traffic-weighted priorities', () => {
  it('weighs reach by verified clicks, states the numbers, and is idempotent', async () => {
    const r = await audit();
    const before = structuredClone(byRule(r, 'description.missing').priority!);
    expect(before.reasons[0]).toMatch(/importance-weighted reach/);
    const rows = [
      { page: `${site.url}/`, clicks: 10, impressions: 500 },
      { page: `${site.url}/a`, clicks: 900, impressions: 9000 },
      { page: `${site.url}/b`, clicks: 0, impressions: 40 },
      { page: `${site.url}/not-crawled`, clicks: 5000, impressions: 50000 },
    ];
    const input = applyTrafficPriorities(r, rows, 'Search Console sc-domain:shop.example, 28 days');
    expect(input).toEqual({ source: 'Search Console sc-domain:shop.example, 28 days', metric: 'clicks', pages: 3, clicks: 910, impressions: 9540 });
    expect(r.traffic).toEqual(input);
    const after = byRule(r, 'description.missing').priority!;
    // /a and /b carry ~99% of the crawled clicks, so the traffic half of the reach is almost full.
    expect(after.reach).toBeGreaterThan(before.reach);
    expect(after.score).toBeGreaterThanOrEqual(before.score);
    expect(after.reasons[0]).toMatch(/traffic-weighted reach \(2 affected\)/);
    expect(after.reasons[1]).toBe('900 clicks · 9040 impressions on affected pages (Search Console sc-domain:shop.example, 28 days; verified search data)');
    expect(after.reasons.filter((x) => /verified search data/.test(x))).toHaveLength(1);
    const again = structuredClone(r);
    applyTrafficPriorities(again, rows, 'Search Console sc-domain:shop.example, 28 days');
    expect(byRule(again, 'description.missing').priority).toEqual(after);
    expect(renderMarkdown(r)).toMatch(/\| Priorities weighted by \| 910 clicks · 9540 impressions on 3 pages/);
  });

  it('uses impressions when clicks are too few, and leaves site-wide findings alone', async () => {
    const r = await audit();
    const siteWide = r.findings.filter((f) => f.priority?.reasons.includes('site-wide')).map((f) => structuredClone(f.priority));
    const input = applyTrafficPriorities(r, [{ page: `${site.url}/a`, clicks: 2, impressions: 800 }], 'Bing Webmaster Tools');
    expect(input?.metric).toBe('impressions');
    expect(r.findings.filter((f) => f.priority?.reasons.includes('site-wide')).map((f) => f.priority)).toEqual(siteWide);
  });

  it('changes nothing when no crawled page has search data', async () => {
    const r = await audit();
    const before = structuredClone(r.findings);
    expect(applyTrafficPriorities(r, [{ page: 'https://elsewhere.example/', clicks: 100, impressions: 1000 }], 'x')).toBeNull();
    expect(r.findings).toEqual(before);
    expect(r.traffic).toBeUndefined();
  });

  it('gsc import --audit writes the weighted priorities into the joined audit', async () => {
    const dir = fs.mkdtempSync(path.join(ws, 'cli-'));
    const { store } = await auditWebsite(site.url + '/', { workspace: dir, probes: false, crawl: { policy: { ...DEFAULT_POLICY, allowPrivate: true }, delayMs: 0 } });
    const zip = path.join(dir, 'export.zip');
    fs.writeFileSync(zip, makeZip([{ name: 'Pages.csv', text: `Top pages,Clicks,Impressions,CTR,Position\n${site.url}/a,120,3000,4%,3.1\n${site.url}/,30,900,3.3%,1.2\n` }]));
    const spies = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(process.stdout, 'write').mockImplementation(() => true)];
    try {
      expect(await main(['gsc', 'import', zip, '--audit', store.runId, '--out', dir, '-q'])).toBe(0);
    } finally {
      for (const s of spies) s.mockRestore();
    }
    const joined = new RunStore(dir, store.runId).readJson<AuditReport>('report.json')!;
    expect(joined.traffic).toMatchObject({ metric: 'clicks', pages: 2, clicks: 150 });
    expect(byRule(joined, 'description.missing').priority!.reasons[1]).toMatch(/^120 clicks · 3000 impressions on affected pages \(.*verified search data\)$/);
  });
});
