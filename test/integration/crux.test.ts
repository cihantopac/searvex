import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cruxErrorMessage, maskCruxKey, queryCrux } from '../../src/integrations/crux.js';
import { saveCredential } from '../../src/integrations/google-oauth.js';
import { cruxKey } from '../../src/commands/crux.js';
import { main } from '../../src/cli.js';

const KEY = 'AIzaTestKey0123456789abcdefghij';
let server: http.Server;
let cfg: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (u.searchParams.get('key') !== KEY) return res.writeHead(400).end(JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }));
      const { origin, formFactor } = JSON.parse(body) as { origin: string; formFactor: string };
      if (origin.includes('quiet')) return res.writeHead(404).end(JSON.stringify({ error: { code: 404, message: 'chrome ux report data not found', status: 'NOT_FOUND' } }));
      res.writeHead(200).end(JSON.stringify({ record: { metrics: { largest_contentful_paint: { percentiles: { p75: formFactor === 'PHONE' ? 3100 : 1800 } }, interaction_to_next_paint: { percentiles: { p75: 150 } }, cumulative_layout_shift: { percentiles: { p75: '0.05' } } }, collectionPeriod: { firstDate: { year: 2026, month: 10, day: 2 }, lastDate: { year: 2026, month: 10, day: 29 } } } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env['SEARVEX_CRUX_API_BASE'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-crux-'));
  process.env['SEARVEX_CONFIG_DIR'] = cfg;
});
afterAll(() => {
  server.close();
  fs.rmSync(cfg, { recursive: true, force: true });
  for (const k of ['SEARVEX_CRUX_API_BASE', 'SEARVEX_CONFIG_DIR', 'SEARVEX_CRUX_API_KEY']) delete process.env[k];
});

describe('CrUX API', () => {
  it('reads p75 per form factor and reports origins without data as not measured', async () => {
    const r = await queryCrux('https://busy.example', KEY);
    expect(r).toMatchObject({ status: 'ok', metrics: [{ formFactor: 'PHONE', lcpMs: 3100, inpMs: 150, cls: 0.05 }, { formFactor: 'DESKTOP', lcpMs: 1800 }] });
    expect(await queryCrux('https://quiet.example', KEY)).toMatchObject({ status: 'no-data' });
  });

  it('explains an invalid key without echoing it', async () => {
    const r = await queryCrux('https://busy.example', 'AIzaWrongKey000000000000000000');
    expect(r).toMatchObject({ status: 'error' });
    expect((r as { message: string }).message).toMatch(/rejected the CrUX API key .*crux auth --force/);
    expect((r as { message: string }).message).not.toContain('AIzaWrongKey');
  });

  it('maps permission and quota errors, and masks the key', () => {
    expect(cruxErrorMessage(403, '{"error":{"status":"PERMISSION_DENIED","message":"API has not been used"}}')).toMatch(/Enable "Chrome UX Report API"/);
    expect(cruxErrorMessage(429, '')).toMatch(/quota/);
    expect(maskCruxKey(`key=${KEY}&k=${encodeURIComponent(KEY)}`, KEY)).toBe('key=***&k=***');
  });

  it('uses the environment key first, then the stored one; status checks it and never prints it', async () => {
    expect(cruxKey()).toBeNull();
    const out: string[] = [];
    const spies = [vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' '))), vi.spyOn(console, 'error').mockImplementation((...a) => void out.push(a.join(' ')))];
    try {
      expect(await main(['crux', 'status'])).toBe(2);
      saveCredential('crux', { clientId: 'crux-api-key', refreshToken: KEY, scope: 'chromeuxreport', createdAt: '2026-11-01T00:00:00Z' });
      expect(cruxKey()?.key).toBe(KEY);
      expect(await main(['crux', 'status'])).toBe(0);
      process.env['SEARVEX_CRUX_API_KEY'] = 'AIzaWrongKey000000000000000000';
      expect(cruxKey()?.source).toBe('SEARVEX_CRUX_API_KEY');
      expect(await main(['crux', 'status'])).toBe(1);
      delete process.env['SEARVEX_CRUX_API_KEY'];
      expect(await main(['crux', 'logout'])).toBe(0);
      expect(cruxKey()).toBeNull();
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    expect(out.join('\n')).toMatch(/valid: true/);
    expect(out.join('\n')).not.toContain(KEY);
    expect(out.join('\n')).not.toContain('AIzaWrongKey');
  });
});
