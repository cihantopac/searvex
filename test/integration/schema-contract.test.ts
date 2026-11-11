import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AjvModule from 'ajv';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateSchemas, schemaFile, serialise, SCHEMAS } from '../../scripts/schema.mjs';
import { analyzeCrawl, auditWebsite, compactAffected, type AuditReport } from '../../src/analyze/audit.js';
import { EXIT, main } from '../../src/cli.js';
import { SCHEMA_VERSION } from '../../src/contract.js';
import { crawl } from '../../src/crawl/crawler.js';
import { DEFAULT_POLICY } from '../../src/net/ssrf.js';
import { auditRepository } from '../../src/repo/audit.js';
import { annotateReport } from '../../src/report/remediation.js';
import { loadKnowledge } from '../../src/rules/engine.js';
import { shopSite } from '../fixtures/shop-site.js';
import { startServer, type Route, type TestServer } from '../helpers/server.js';

type Validate = ((data: unknown) => boolean) & { errors?: unknown };
const Ajv = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as new (o: object) => { addKeyword(k: string): void; compile(s: object): Validate };

/** Validators against the strict variant: object types reject fields the TypeScript types do not declare. */
const strict = generateSchemas({ strict: true }).schemas;
const validator = (name: string): Validate => {
  const ajv = new Ajv({ allErrors: true });
  ajv.addKeyword('x-searvex-schema-version');
  return ajv.compile(strict[name]!);
};
const expectValid = (name: string, data: unknown, label: string) => {
  const v = validator(name);
  const ok = v(data);
  expect(ok ? null : JSON.stringify(v.errors, null, 1).slice(0, 2000), label).toBeNull();
};

const policy = { ...DEFAULT_POLICY, allowPrivate: true };
let shop: TestServer;
let ws: string;
let cfg: string;

beforeAll(async () => {
  const routes: Record<string, Route> = {};
  shop = await startServer(routes);
  Object.assign(routes, shopSite(() => shop.url));
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-schema-'));
  cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-schema-cfg-'));
});

afterAll(async () => {
  await shop.close();
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(cfg, { recursive: true, force: true });
});

describe('C1: published schemas', () => {
  it('the committed schema files match the TypeScript types (run "npm run schema" after a type change)', () => {
    const { schemas, version } = generateSchemas();
    expect(version).toBe(SCHEMA_VERSION);
    for (const s of SCHEMAS) expect(fs.readFileSync(schemaFile(s.name), 'utf8'), `schema/${s.name}.schema.json`).toBe(serialise(schemas[s.name]));
  });

  it('the published schemas are valid draft-07 and not strict', () => {
    for (const s of SCHEMAS) {
      const schema = JSON.parse(fs.readFileSync(schemaFile(s.name), 'utf8')) as Record<string, unknown>;
      expect(schema['x-searvex-schema-version']).toBe(SCHEMA_VERSION);
      expect(JSON.stringify(schema)).not.toMatch(/"additionalProperties":false/);
      const ajv = new Ajv({});
      ajv.addKeyword('x-searvex-schema-version');
      expect(() => ajv.compile(schema)).not.toThrow();
    }
  });
});

describe('C1: every report shape validates against the strict schema', () => {
  it('a full website audit, its compact form and the stored report.json', async () => {
    const { report, store } = await auditWebsite(shop.url + '/', { workspace: ws, crawl: { policy, delayMs: 0, concurrency: 4 }, probes: true, checkExternal: true });
    expect(report.schemaVersion).toBe(SCHEMA_VERSION);
    expect(Object.keys(report.tool.rules ?? {}).sort()).toEqual([...new Set(report.findings.map((f) => f.ruleId))].sort());
    expectValid('report', report, 'website');
    expectValid('report', store.readJson('report.json'), 'stored report.json');
    expectValid('report', compactAffected(structuredClone(report)), 'compact');
  });

  it('the strict validator rejects undeclared fields, wrong types and missing fields', async () => {
    const { report } = await auditWebsite(shop.url + '/', { workspace: ws, crawl: { policy, delayMs: 0 }, probes: false });
    const v = validator('report');
    expect(v({ ...report, surprise: 1 })).toBe(false);
    expect(v({ ...report, crawl: { ...report.crawl, fetched: '3' } })).toBe(false);
    expect(v({ ...report, findings: [{ ...report.findings[0], remediation: 'magic' }] })).toBe(false);
    const { schemaVersion: _, ...missing } = report;
    expect(v(missing)).toBe(false);
    expect(v(report)).toBe(true);
  });

  it('pre-launch, interrupted, robots-blocked and unreachable runs', async () => {
    const kb = loadKnowledge();
    const pre = await auditWebsite(shop.url + '/', { workspace: ws, crawl: { policy, delayMs: 0 }, probes: false, preLaunch: true });
    expectValid('report', pre.report, 'pre-launch');

    const ac = new AbortController();
    const partial = await crawl(shop.url + '/', { policy, delayMs: 0, concurrency: 1, stop: ac.signal, onProgress: (p) => p.fetched === 2 && ac.abort('max-duration') });
    expectValid('report', annotateReport(await analyzeCrawl(partial, kb, { policy, probes: false })), 'interrupted');

    const blocked = await startServer({ '/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /\n' } });
    try {
      const r = await auditWebsite(blocked.url + '/', { workspace: ws, crawl: { policy, delayMs: 0 }, probes: false });
      expect(r.report.crawl.status).toBe('robots-blocked');
      expectValid('report', r.report, 'robots-blocked');
    } finally {
      await blocked.close();
    }

    const tmp = await startServer({});
    const closed = `http://127.0.0.1:${tmp.port}/`;
    await tmp.close();
    const down = await auditWebsite(closed, { workspace: ws, crawl: { policy, delayMs: 0, timeoutMs: 2000 } });
    expectValid('report', down.report, 'unreachable');
  });

  it('repository reports of every fixture framework', () => {
    const fixtures = path.resolve('test/fixtures/repos');
    for (const name of fs.readdirSync(fixtures)) {
      const { report } = auditRepository(path.join(fixtures, name));
      expectValid('report', annotateReport(report), `repository ${name}`);
    }
  });
});

describe('C1: events, errors and the schema command', () => {
  const run = async (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const spies = [
      vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ') + '\n')),
      vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.join(' ') + '\n')),
      vi.spyOn(process.stdout, 'write').mockImplementation((c) => (out.push(String(c)), true)),
      vi.spyOn(process.stderr, 'write').mockImplementation((c) => (err.push(String(c)), true)),
    ];
    try {
      return { code: await main(argv), stdout: out.join(''), stderr: err.join('').split('\n').filter(Boolean) };
    } finally {
      for (const s of spies) s.mockRestore();
    }
  };

  it('--progress ndjson events and JSON errors validate', async () => {
    process.env['SEARVEX_CONFIG_DIR'] = cfg;
    try {
      const ok = await run(['audit', shop.url + '/', '--allow-private', '--delay', '0', '--out', ws, '--progress', 'ndjson', '--json']);
      expect(ok.code).toBe(EXIT.ok);
      expectValid('report', JSON.parse(ok.stdout), 'CLI --json');
      const events = ok.stderr.map((l) => JSON.parse(l));
      expect(events.length).toBeGreaterThan(5);
      for (const e of events) expectValid('events', e, `event ${e.event}`);

      const bad = await run(['audit', shop.url + '/', '--out', ws, '--progress', 'ndjson']);
      expect(bad.code).toBe(EXIT.usage);
      const lines = bad.stderr.map((l) => JSON.parse(l));
      const error = lines.find((l) => 'error' in l);
      expectValid('error', error, 'policy error');
      for (const e of lines.filter((l) => 'event' in l)) expectValid('events', e, `event ${e.event}`);
    } finally {
      delete process.env['SEARVEX_CONFIG_DIR'];
    }
  });

  it('searvex schema prints each published schema', async () => {
    for (const s of SCHEMAS) {
      const r = await run(['schema', s.name]);
      expect(r.code).toBe(EXIT.ok);
      expect(r.stdout).toBe(fs.readFileSync(schemaFile(s.name), 'utf8'));
    }
    expect((await run(['schema'])).stdout).toBe(fs.readFileSync(schemaFile('report'), 'utf8'));
    expect((await run(['schema', 'nope'])).code).toBe(EXIT.usage);
  });
});

it('AuditReport is the exported report type', () => {
  const r: Pick<AuditReport, 'schemaVersion'> = { schemaVersion: SCHEMA_VERSION };
  expect(r.schemaVersion).toBe('1.0');
});
