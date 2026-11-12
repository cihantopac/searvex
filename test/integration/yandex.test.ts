import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hostIdFor, yandexErrorMessage, yandexHosts, yandexPopularQueries, yandexUserId } from '../../src/integrations/yandex.js';
import { buildYandexReport, yandexToken, type YandexReport } from '../../src/commands/yandex.js';
import { RunStore } from '../../src/crawl/store.js';
import { main } from '../../src/cli.js';

const TOKEN = 'y0_AgAAAAAtestTokenValue0123456789';
let server: http.Server;
let cfg: string;
const seen: URL[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.headers.authorization !== `OAuth ${TOKEN}`) return res.writeHead(401).end(JSON.stringify({ error_code: 'INVALID_OAUTH_TOKEN', error_message: 'Invalid oauth token' }));
    const u = new URL(req.url ?? '/', 'http://x');
    seen.push(u);
    if (u.pathname === '/v4/user') return res.end(JSON.stringify({ user_id: 42 }));
    if (u.pathname === '/v4/user/42/hosts')
      return res.end(JSON.stringify({ hosts: [
        { host_id: 'https:acme.example:443', ascii_host_url: 'https://acme.example/', verified: true, main_mirror: { host_id: 'https:acme.example:443', ascii_host_url: 'https://acme.example/', verified: true } },
        { host_id: 'https:new.example:443', ascii_host_url: 'https://new.example/', verified: false },
      ] }));
    if (u.pathname === '/v4/user/42/hosts/https%3Aacme.example%3A443/search-queries/popular' || u.pathname === '/v4/user/42/hosts/https:acme.example:443/search-queries/popular')
      return res.end(JSON.stringify({ queries: [
        { query_id: 'a', query_text: 'acme pricing', indicators: { TOTAL_SHOWS: 200, TOTAL_CLICKS: 30, AVG_SHOW_POSITION: 2.345 } },
        { query_id: 'b', query_text: 'acme', indicators: { TOTAL_SHOWS: 100, TOTAL_CLICKS: 0 } },
      ], date_from: '2026-10-13', date_to: '2026-11-09', count: 7 }));
    res.writeHead(404).end(JSON.stringify({ error_code: 'HOST_NOT_LOADED', error_message: 'no host' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env['SEARVEX_YANDEX_API_BASE'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v4`;
  cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-yandex-'));
});
afterAll(() => {
  server.close();
  fs.rmSync(cfg, { recursive: true, force: true });
  for (const k of ['SEARVEX_YANDEX_API_BASE', 'SEARVEX_YANDEX_TOKEN', 'SEARVEX_CONFIG_DIR']) delete process.env[k];
});

describe('F5: Yandex Webmaster API', () => {
  it('reads the user, the sites and the popular queries with their indicators', async () => {
    const user = await yandexUserId(TOKEN);
    expect(user).toBe('42');
    expect(await yandexHosts(TOKEN, user)).toEqual([
      { id: 'https:acme.example:443', url: 'https://acme.example/', verified: true, mainMirror: 'https://acme.example/' },
      { id: 'https:new.example:443', url: 'https://new.example/', verified: false },
    ]);
    const { rows, total } = await yandexPopularQueries(TOKEN, user, 'https:acme.example:443', { startDate: '2026-10-13', endDate: '2026-11-09' });
    expect(total).toBe(7);
    expect(rows).toEqual([
      { query: 'acme pricing', shows: 200, clicks: 30, position: 2.3 },
      { query: 'acme', shows: 100, clicks: 0 },
    ]);
    const q = seen.at(-1)!.searchParams;
    expect([q.get('order_by'), q.getAll('query_indicator'), q.get('date_from'), q.get('date_to')]).toEqual(['TOTAL_SHOWS', ['TOTAL_SHOWS', 'TOTAL_CLICKS', 'AVG_SHOW_POSITION'], '2026-10-13', '2026-11-09']);
  });

  it('host ids and error messages', async () => {
    expect(hostIdFor('https://Acme.example/')).toBe('https:acme.example:443');
    expect(hostIdFor('http://acme.example:8080/x')).toBe('http:acme.example:8080');
    await expect(yandexUserId('wrong-token-000000000000000')).rejects.toThrow(/rejected the OAuth token/);
    expect(yandexErrorMessage(404, { error_code: 'HOST_NOT_ADDED' })).toMatch(/yandex sites/);
  });

  it('builds the report with CTR and says it is query-level only', () => {
    const r = buildYandexReport([{ query: 'acme pricing', shows: 200, clicks: 30 }], { site: 'https://acme.example/', days: 28, startDate: 'a', endDate: 'b', total: 3 });
    expect(r.queries[0]!.ctr).toBe(0.15);
    expect(r.notes.join(' ')).toMatch(/no page × query breakdown[\s\S]*top 1 of 3/);
  });

  it('CLI: report needs a verified site of the account; the token comes from the environment first', async () => {
    process.env['SEARVEX_CONFIG_DIR'] = cfg;
    const spies = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(process.stdout, 'write').mockImplementation(() => true), vi.spyOn(process.stderr, 'write').mockImplementation(() => true)];
    try {
      expect(yandexToken()).toBeNull();
      expect(await main(['yandex', 'status'])).toBe(1);
      process.env['SEARVEX_YANDEX_TOKEN'] = TOKEN;
      expect(await main(['yandex', 'report', 'https://new.example/'])).toBe(2);
      expect(await main(['yandex', 'report', 'https://other.example/'])).toBe(2);
      expect(await main(['yandex', 'report', 'https://acme.example/', '--out', cfg, '--quiet'])).toBe(0);
      const run = RunStore.list(cfg).find((id) => id.startsWith('yandex-'))!;
      const store = new RunStore(cfg, run);
      expect(store.readJson<YandexReport>('yandex-report.json')!.totals).toEqual({ shows: 300, clicks: 30 });
      expect(fs.readFileSync(store.file('yandex-report.md'), 'utf8')).toMatch(/\| acme pricing \| 200 \| 30 \| 15\.0% \| 2\.3 \|/);
    } finally {
      for (const s of spies) s.mockRestore();
      delete process.env['SEARVEX_YANDEX_TOKEN'];
    }
  });
});
