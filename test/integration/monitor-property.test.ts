import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../src/cli.js';
import { page, startServer, text, type TestServer } from '../helpers/server.js';
import { writeAudit } from '../helpers/search-data.js';

/**
 * `monitor --import` must never attach Search Console data of another website to the monitored site.
 * Regression for backlog item 17 (the export was accepted without any property check).
 */
let server: TestServer;
let site: string;
let ws: string;
let stderr: string[];

const run = (...args: string[]) => main(['monitor', site, '--allow-private', '--delay', '0', '--no-sitemap', '--out', ws, '-q', ...args]);
const csv = (name: string, body: string) => {
  const f = path.join(ws, name);
  fs.writeFileSync(f, body);
  return f;
};
const pagesCsv = (urls: string[]) => `Top pages,Clicks,Impressions,CTR,Position\n${urls.map((u, i) => `${u},${10 - i},${100 + i},10%,${3 + i}`).join('\n')}\n`;
const queriesCsv = 'Top queries,Clicks,Impressions,CTR,Position\nwidgets,12,340,3.5%,4.2\nblue widgets,3,90,3.3%,7.9\n';
const monitorJson = () => {
  const runs = path.join(ws, '.searvex', 'runs');
  const dir = fs.readdirSync(runs).filter((d) => fs.existsSync(path.join(runs, d, 'monitor.json'))).sort().at(-1)!;
  return JSON.parse(fs.readFileSync(path.join(runs, dir, 'monitor.json'), 'utf8'));
};

beforeAll(async () => {
  server = await startServer({
    '/': { body: page({ title: 'Home', body: `<a href="/a">A</a>${text(120)}` }) },
    '/a': { body: page({ title: 'A', body: text(120) }) },
  });
  site = server.url + '/';
});
afterAll(() => server.close());
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-monitor-'));
  stderr = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void stderr.push(a.join(' ')));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(ws, { recursive: true, force: true });
});

describe('monitor --import property isolation', () => {
  it('accepts an export whose pages belong to the monitored site', async () => {
    const f = csv('pages.csv', pagesCsv([`${server.url}/`, `${server.url}/a`]));
    expect(await run('--import', f)).toBe(0);
    const m = monitorJson();
    expect(m.gsc.rows).toHaveLength(2);
    expect(m.gsc.source).toMatch(/checked against the pages table/);
  });

  it('rejects an export of another website before crawling', async () => {
    const f = csv('other.csv', pagesCsv(['https://other.example/', 'https://other.example/x']));
    expect(await run('--import', f)).toBe(2);
    expect(stderr.join('\n')).toMatch(/do not belong|another website/);
  });

  it('rejects a queries-only export without --property: it cannot be attributed to a site', async () => {
    const f = csv('queries.csv', queriesCsv);
    expect(await run('--import', f)).toBe(2);
    expect(stderr.join('\n')).toMatch(/no pages table/);
  });

  it('accepts a queries-only export with a stated property that covers the site, and labels it as stated', async () => {
    const f = csv('queries.csv', queriesCsv);
    expect(await run('--import', f, '--property', `${server.url}/`)).toBe(0);
    expect(monitorJson().gsc.source).toMatch(/as stated with --property/);
  });

  it('rejects a stated property that does not cover the monitored site', async () => {
    const f = csv('queries.csv', queriesCsv);
    expect(await run('--import', f, '--property', 'sc-domain:other.example')).toBe(2);
    expect(stderr.join('\n')).toMatch(/never combined/);
  });

  it('rejects a pages table from several hosts without --property', async () => {
    const f = csv('mixed.csv', pagesCsv([`${server.url}/`, 'https://other.example/', 'https://third.example/']));
    expect(await run('--import', f)).toBe(2);
    expect(stderr.join('\n')).toMatch(/several hosts/);
  });

  it('rejects an explicit baseline that is an audit of another website', async () => {
    writeAudit(ws, 'run-20200101-000000-aaaaaa', 'https://other.example/', ['https://other.example/']);
    expect(await run('--baseline', 'run-20200101-000000-aaaaaa')).toBe(2);
    expect(stderr.join('\n')).toMatch(/cannot be compared/);
  });

  it('skips (not measured) a SEARVEX_GSC_SITE default that belongs to another site', async () => {
    vi.stubEnv('SEARVEX_GSC_SITE', 'sc-domain:other.example');
    vi.stubEnv('SEARVEX_GSC_TOKEN', 'test-token-never-sent');
    try {
      expect(await run()).toBe(0);
      const m = monitorJson();
      expect(m.gsc).toBeUndefined();
      expect(m.notes.join(' ')).toMatch(/does not cover/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rejects an explicit --site-url that does not cover the monitored site', async () => {
    expect(await run('--site-url', 'sc-domain:other.example')).toBe(2);
    expect(stderr.join('\n')).toMatch(/does not cover/);
  });
});
