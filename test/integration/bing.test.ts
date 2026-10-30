import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aggregate, bingQueryPageRows, getQueryStats, parseBingDate } from '../../src/integrations/bing.js';
import { main } from '../../src/cli.js';

const KEY = 'secret-api-key-123';
const day = (d: number) => `/Date(${Date.now() - d * 86400000}-0700)/`;
let server: http.Server;
const seen: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    seen.push(u.pathname);
    if (u.searchParams.get('apikey') !== KEY) return res.writeHead(401).end(`invalid key ${u.searchParams.get('apikey')}`);
    const send = (d: unknown[]) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ d }));
    if (u.pathname.endsWith('/GetQueryStats')) return send([{ Query: 'team chat', Clicks: 5, Impressions: 50, AvgImpressionPosition: 4, AvgClickPosition: 3, Date: day(3) }]);
    if (u.pathname.endsWith('/GetPageStats')) return send([
      { Query: 'https://s.example/a', Clicks: 30, Impressions: 300, AvgImpressionPosition: 5, AvgClickPosition: 4, Date: day(5) },
      { Query: 'https://s.example/b', Clicks: 2, Impressions: 80, AvgImpressionPosition: 12, AvgClickPosition: 11, Date: day(5) },
      { Query: 'https://s.example/old', Clicks: 99, Impressions: 999, AvgImpressionPosition: 1, AvgClickPosition: 1, Date: day(200) },
    ]);
    if (u.pathname.endsWith('/GetPageQueryStats')) {
      const page = u.searchParams.get('page');
      return send(page?.endsWith('/a')
        ? [{ Query: 'chat app', Clicks: 20, Impressions: 200, AvgImpressionPosition: 4, Date: day(5) }, { Query: 'chat app', Clicks: 10, Impressions: 100, AvgImpressionPosition: 7, Date: day(12) }]
        : [{ Query: 'chat app', Clicks: 2, Impressions: 80, AvgImpressionPosition: 12, Date: day(5) }]);
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env['SEARVEX_BING_API_BASE'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webmaster/api.svc/json`;
});
afterAll(() => {
  server.close();
  delete process.env['SEARVEX_BING_API_BASE'];
  delete process.env['SEARVEX_BING_API_KEY'];
});

describe('Bing Webmaster API', () => {
  it('parses WCF dates and the {"d": [...]} envelope', async () => {
    expect(parseBingDate('/Date(1316156400000-0700)/')).toBe('2011-09-16');
    const q = await getQueryStats('https://s.example/', KEY);
    expect(q[0]).toMatchObject({ key: 'team chat', clicks: 5, impressions: 50, avgImpressionPosition: 4 });
  });

  it('aggregates dated rows with impression-weighted position and a period filter', () => {
    const m = aggregate([
      { key: 'x', clicks: 1, impressions: 100, avgImpressionPosition: 2, avgClickPosition: 2, date: '2026-10-01' },
      { key: 'x', clicks: 1, impressions: 300, avgImpressionPosition: 6, avgClickPosition: 6, date: '2026-10-20' },
      { key: 'x', clicks: 9, impressions: 9, avgImpressionPosition: 1, avgClickPosition: 1, date: '2025-01-01' },
    ], '2026-01-01');
    expect(m.get('x')).toEqual({ clicks: 2, impressions: 400, position: 5 });
  });

  it('builds query x page rows from the top pages within the period', async () => {
    const { rows, pages } = await bingQueryPageRows('https://s.example/', KEY, { days: 28 });
    expect(pages).toBe(2); // the 200-day-old page is outside the period
    const a = rows.find((r) => r.page.endsWith('/a'))!;
    expect(a).toMatchObject({ query: 'chat app', clicks: 30, impressions: 300, position: 5 });
  });

  it('never leaks the API key in errors', async () => {
    await expect(getQueryStats('https://s.example/', 'wrong-key')).rejects.toThrow(/401/);
    await getQueryStats('https://s.example/', 'wrong-key').catch((e: Error) => expect(e.message).not.toContain('wrong-key'));
  });

  it('CLI bing report writes the shared search-performance report', async () => {
    process.env['SEARVEX_BING_API_KEY'] = KEY;
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-bing-'));
    try {
      expect(await main(['bing', 'report', 'https://s.example/', '--out', ws, '-q'])).toBe(0);
      const run = fs.readdirSync(path.join(ws, '.searvex', 'runs')).find((d) => d.startsWith('bing'))!;
      const rep = JSON.parse(fs.readFileSync(path.join(ws, '.searvex', 'runs', run, 'search-performance.json'), 'utf8'));
      expect(rep.source).toContain('Bing Webmaster Tools');
      expect(rep.multiPageQueries[0].query).toBe('chat app');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
