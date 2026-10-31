import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aggregate, bingErrorMessage, bingQueryPageRows, getQueryStats, getUserSites, maskKey, parseBingDate } from '../../src/integrations/bing.js';
import { readSecret } from '../../src/commands/gsc.js';
import { deleteCredential, saveCredential } from '../../src/integrations/google-oauth.js';
import { PassThrough } from 'node:stream';
import { vi } from 'vitest';
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
    if (u.pathname.endsWith('/GetUserSites')) return send([{ Url: 'https://s.example/', IsVerified: true }, { Url: 'https://pending.example/', IsVerified: false }, { Url: 'https://www.other.example/', IsVerified: true }]);
    if (u.pathname.endsWith('/GetRankAndTrafficStats')) return send([{ Date: day(3), Clicks: 40, Impressions: 900 }, { Date: day(4), Clicks: 4, Impressions: 100 }, { Date: day(400), Clicks: 999, Impressions: 9999 }]);
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
      // Totals: the daily site series within the period, not the sum of the top pages.
      expect(rep.totals).toMatchObject({ clicks: 44, impressions: 1000 });
      expect(rep.totals.basis).toMatch(/daily site totals/);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('Bing key handling and site selection', () => {
  const capture = () => {
    const out: string[] = [];
    const spies = [vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' '))), vi.spyOn(console, 'error').mockImplementation((...a) => void out.push(a.join(' '))), vi.spyOn(process.stdout, 'write').mockImplementation((c) => (out.push(String(c)), true))];
    return { text: () => out.join('\n'), restore: () => spies.forEach((s) => s.mockRestore()) };
  };

  it('lists the account sites and refuses unknown or unverified sites with suggestions', async () => {
    expect(await getUserSites(KEY)).toEqual([{ url: 'https://s.example/', verified: true }, { url: 'https://pending.example/', verified: false }, { url: 'https://www.other.example/', verified: true }]);
    process.env['SEARVEX_BING_API_KEY'] = KEY;
    const c = capture();
    try {
      expect(await main(['bing', 'report', 'https://pending.example/', '-q'])).toBe(2);
      expect(await main(['bing', 'report', 'https://other.example/', '-q'])).toBe(2);
      expect(await main(['bing', 'report', 'https://nowhere.example/', '-q'])).toBe(2);
    } finally {
      c.restore();
      delete process.env['SEARVEX_BING_API_KEY'];
    }
    expect(c.text()).toMatch(/pending\.example\/ is not verified/);
    expect(c.text()).toMatch(/Did you mean: https:\/\/www\.other\.example\//);
    expect(c.text()).toMatch(/not a site in this Bing Webmaster account/);
  });

  it('uses a key saved in the credential store, reports status, and logout removes it; the key is never printed', async () => {
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-bingcfg-'));
    process.env['SEARVEX_CONFIG_DIR'] = cfg;
    const c = capture();
    try {
      expect(await main(['bing', 'status'])).toBe(2); // no key anywhere
      saveCredential('bing', { clientId: 'bing-webmaster-api-key', refreshToken: KEY, scope: 'bing-webmaster:read', createdAt: '2026-11-01T00:00:00Z' });
      expect(await main(['bing', 'status', '--json'])).toBe(0);
      expect(await main(['bing', 'sites'])).toBe(0);
      expect(await main(['bing', 'logout'])).toBe(0);
      expect(await main(['bing', 'sites'])).toBe(2);
      saveCredential('bing', { clientId: 'bing-webmaster-api-key', refreshToken: 'revoked-key-000000', scope: 'bing-webmaster:read', createdAt: '2026-11-01T00:00:00Z' });
      expect(await main(['bing', 'status'])).toBe(1); // invalid key: explained, not thrown
    } finally {
      c.restore();
      deleteCredential('bing');
      delete process.env['SEARVEX_CONFIG_DIR'];
      fs.rmSync(cfg, { recursive: true, force: true });
    }
    expect(c.text()).toMatch(/"valid": true/);
    expect(c.text()).toMatch(/s\.example\/ +\(verified\)/);
    expect(c.text()).not.toContain(KEY);
    expect(c.text()).not.toContain('revoked-key-000000');
  });

  it('masks every occurrence of the key, raw and URL-encoded', () => {
    expect(maskKey('k=a+b/c&x=a%2Bb%2Fc a+b/c', 'a+b/c')).toBe('k=***&x=*** ***');
  });

  it('reads a key from a pipe, and from a terminal without echoing it', async () => {
    const pipe = new PassThrough();
    pipe.end('  piped-key-0123456789  \n');
    expect(await readSecret('key: ', pipe as never, new PassThrough() as never)).toBe('piped-key-0123456789');

    const tty = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const out = new PassThrough();
    const echoed: string[] = [];
    out.on('data', (d) => echoed.push(String(d)));
    const p = readSecret('key: ', tty as never, out as never);
    tty.write('abcX\u007fd');
    tty.write('\r');
    expect(await p).toBe('abcd');
    expect(echoed.join('')).toBe('key: \n');
    expect(tty.setRawMode).toHaveBeenLastCalledWith(false);
  });
});

describe('Bing API error envelope (live shapes, 2026-11-01)', () => {
  it('turns InvalidApiKey and throttling into actionable messages', () => {
    expect(bingErrorMessage(400, 'GetUserSites', '{"ErrorCode":3,"Message":"ERROR!!! InvalidApiKey"}')).toMatch(/rejected the API key .*bing auth --force/);
    expect(bingErrorMessage(400, 'GetPageQueryStats', '{"ErrorCode":14,"Message":"ERROR!!! ThrottleUser"}')).toMatch(/quota or rate limit .*--max-pages/);
    expect(bingErrorMessage(500, 'GetPageStats', 'oops')).toBe('Bing Webmaster API error 500 on GetPageStats: oops');
  });
});
