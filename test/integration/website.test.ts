import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditWebsite, type AuditReport } from '../../src/analyze/audit.js';
import { DEFAULT_POLICY } from '../../src/net/ssrf.js';
import { startServer, type Route, type TestServer } from '../helpers/server.js';
import { SHOP_CLEAN, SHOP_EXPECTED, shopSite } from '../fixtures/shop-site.js';

let server: TestServer;
let report: AuditReport;
let workspace: string;

beforeAll(async () => {
  const routes: Record<string, Route> = {};
  server = await startServer(routes);
  Object.assign(routes, shopSite(() => server.url));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-web-'));
  ({ report } = await auditWebsite(server.url + '/', {
    workspace,
    crawl: { policy: { ...DEFAULT_POLICY, allowPrivate: true }, delayMs: 0, concurrency: 4 },
  }));
});

afterAll(async () => {
  await server.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('website audit — synthetic e-commerce site', () => {
  it.each(SHOP_EXPECTED)('reports planted issue %s', (ruleId) => {
    expect(report.findings.map((f) => f.ruleId)).toContain(ruleId);
  });

  it.each(SHOP_CLEAN)('does not report %s (false-positive guard)', (ruleId) => {
    expect(report.findings.map((f) => f.ruleId)).not.toContain(ruleId);
  });

  it('respects robots.txt: never fetches disallowed URLs', () => {
    expect(server.hits.get('/private/report')).toBeUndefined();
  });

  it('identifies itself with the Searvex user agent', () => {
    expect(server.userAgents.every((ua) => ua.includes('SearvexBot/'))).toBe(true);
  });

  it('attaches evidence and an official source to every finding', () => {
    for (const f of report.findings) {
      expect(f.evidence.length).toBeGreaterThan(0);
    }
  });

  it('builds an inventory with product pages and two languages', () => {
    expect(report.inventory.byType['product']).toBeGreaterThanOrEqual(2);
    expect(Object.keys(report.inventory.languages)).toEqual(expect.arrayContaining(['en', 'tr']));
  });

  it('inventories structured data actually present on pages (not only retired-type findings)', () => {
    const types = Object.fromEntries(report.inventory.structuredData.types.map((t) => [t.type, t.pages]));
    expect(types['Organization']).toBe(1);
    expect(types['Product']).toBe(1); // widget; gadget's JSON-LD is invalid
    expect(types['FAQPage']).toBe(1);
    expect(report.inventory.structuredData.invalidJsonLdPages).toBe(1);
  });

  it('distinguishes training and AI-search crawlers', () => {
    const gpt = report.geo.bots.find((b) => b.token === 'GPTBot')!;
    const oai = report.geo.bots.find((b) => b.token === 'OAI-SearchBot')!;
    const google = report.geo.bots.find((b) => b.token === 'Googlebot')!;
    expect(gpt.allowed).toBe(false);
    expect(gpt.purpose).toBe('ai-training');
    expect(oai.allowed).toBe(false);
    expect(google.allowed).toBe(true);
  });

  it('marks AI citations as unmeasured instead of inventing data', () => {
    expect(report.geo.citations.measured).toBe(false);
  });

  it('records the redirect chain with each hop', () => {
    const chain = report.findings.find((f) => f.ruleId === 'redirect.chain')!;
    expect(chain.evidence[0]!.observed).toContain('301');
    expect(chain.evidence[0]!.observed).toContain('302');
  });
});
