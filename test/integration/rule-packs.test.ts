import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auditWebsite } from '../../src/analyze/audit.js';
import { evaluatePackCheck } from '../../src/analyze/packs.js';
import { loadKnowledge } from '../../src/rules/engine.js';
import { checkProblems, compilePackPattern, loadRulePack, validatePacks, withPacks } from '../../src/rules/packs.js';
import { renderMarkdown } from '../../src/report/markdown.js';
import { renderSarif } from '../../src/report/sarif.js';
import { DEFAULT_POLICY } from '../../src/net/ssrf.js';
import { EXIT, main } from '../../src/cli.js';
import { page, startServer, text, type TestServer } from '../helpers/server.js';

const PACK = path.resolve('test/fixtures/packs/shop');
const product = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Mug"}</script>';
let site: TestServer;
let tmp: string;

beforeAll(async () => {
  site = await startServer({
    '/': { body: page({ title: 'Home of the shop', head: '<meta property="og:image" content="/a.png">', body: `<h1>Shop</h1>${text(120)}<a href="/products/mug">mug</a><a href="/products/cup">cup</a><a href="/about">about</a>` }) },
    '/products/mug': { body: page({ title: 'A mug from the shop', head: `${product}<meta property="og:image" content="/m.png">`, body: `<h1>Mug</h1>${text(120)}` }) },
    '/products/cup': { body: page({ title: 'A cup from the shop', head: '<meta property="og:image" content="/c.png">', body: `<h1>Cup</h1>${text(120)}` }) },
    '/about': { body: page({ title: 'About the shop', body: `<h1>About</h1>${text(120)}` }) },
  });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-packs-'));
});
afterAll(async () => {
  await site.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const packCopy = (name: string, mutate: (rules: Array<Record<string, unknown>>) => void) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const data = JSON.parse(fs.readFileSync(path.join(PACK, 'rules.json'), 'utf8')) as { rules: Array<Record<string, unknown>> };
  data.rules = data.rules.map((r) => ({ ...r, id: String(r['id']).replace(/^shop\./, `${name}.`) }));
  mutate(data.rules);
  fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify(data));
  return dir;
};

describe('H4: loading and validating packs', () => {
  it('loads a pack from a directory, prefixes nothing itself and merges it with the core rules', () => {
    const pack = loadRulePack(PACK);
    expect(pack).toMatchObject({ name: 'shop', version: '2026.11.12' });
    const kb = withPacks(loadKnowledge(), [pack]);
    expect(kb.rules.get('shop.product-schema-missing')).toMatchObject({ pack: 'shop' });
    expect(kb.packs).toEqual([{ name: 'shop', version: '2026.11.12', rules: 2 }]);
    expect(validatePacks(kb, [pack], { today: new Date('2026-11-12') })).toEqual([]);
  });

  it('never replaces a core rule, and every id carries the pack name', () => {
    const core = packCopy('evil', (rules) => (rules[0]!['id'] = 'title.missing'));
    expect(() => withPacks(loadKnowledge(), [loadRulePack(core)])).toThrow(/must start with "evil\."/);
    const clash = packCopy('title', (rules) => (rules[0]!['id'] = 'title.missing'));
    expect(() => withPacks(loadKnowledge(), [loadRulePack(clash)])).toThrow(/already exists in the core rule base/);
    expect(() => loadRulePack('no-such-pack')).toThrow(/Rule pack not found/);
  });

  it('holds pack rules to the sourcing rules and checks their declarative check', () => {
    const bad = packCopy('bad', (rules) => {
      rules[0]!['sources'] = [{ title: 'Blog', url: 'https://seo-blog.example/tip', checked: '2026-11-12' }];
      rules[1]!['check'] = { field: 'body', test: 'matches', value: '(a+)+$' };
    });
    const pack = loadRulePack(bad);
    const issues = validatePacks(withPacks(loadKnowledge(), [pack]), [pack]).map((i) => `${i.ruleId}: ${i.message}`);
    expect(issues).toEqual(expect.arrayContaining([expect.stringMatching(/bad\.product-schema-missing: source .* not on the official-domain allowlist/), expect.stringMatching(/bad\.missing-og-image: check\.field "body"/), expect.stringMatching(/bad\.missing-og-image: check\.value: .*backtrack/)]));
  });

  it('refuses risky or long patterns; evaluates each test', () => {
    expect(() => compilePackPattern('(a+)+')).toThrow(/backtrack/);
    expect(() => compilePackPattern('(\\w)\\1')).toThrow(/back-reference/);
    expect(() => compilePackPattern('x'.repeat(201))).toThrow(/longer than 200/);
    expect(checkProblems({ field: 'title', test: 'longer-than', value: -1 })).toHaveLength(1);
    expect(evaluatePackCheck({ field: 'title', test: 'longer-than', value: 5 }, 'Long title')).toBe('title is 10 characters (limit 5)');
    expect(evaluatePackCheck({ field: 'jsonld-types', test: 'not-matches', value: '^Product$' }, ['Organization'])).toMatch(/does not match/);
    expect(evaluatePackCheck({ field: 'jsonld-types', test: 'not-matches', value: '^Product$' }, null)).toBe('jsonld-types missing (expected /^Product$/)');
    expect(evaluatePackCheck({ field: 'jsonld-types', test: 'not-matches', value: '^Product$' }, ['Product', 'BreadcrumbList'])).toBeNull();
    expect(evaluatePackCheck({ field: 'title', test: 'shorter-than', value: 5 }, null)).toBeNull();
    expect(evaluatePackCheck({ field: 'og:image', test: 'missing' }, null)).toBe('og:image missing');
  });
});

describe('H4: pack findings in an audit', () => {
  it('runs the checks on indexable pages, scoped by urlPattern, and labels the findings', async () => {
    const kb = withPacks(loadKnowledge(), [loadRulePack(PACK)]);
    const { report } = await auditWebsite(site.url + '/', { workspace: tmp, kb, probes: false, crawl: { policy: { ...DEFAULT_POLICY, allowPrivate: true }, delayMs: 0, concurrency: 1 } });
    // Only /products/* pages are in scope; the mug has Product markup, the cup has none.
    const schema = report.findings.find((f) => f.ruleId === 'shop.product-schema-missing')!;
    expect(schema.evidence.map((e) => [new URL(e.url!).pathname, e.observed])).toEqual([['/products/cup', 'jsonld-types missing (expected /^(Product|ProductGroup)$/)']]);
    const og = report.findings.find((f) => f.ruleId === 'shop.missing-og-image')!;
    expect(og).toMatchObject({ pack: 'shop' });
    expect(og.evidence.map((e) => new URL(e.url!).pathname)).toEqual(['/about']);
    expect(report.tool.packs).toEqual([{ name: 'shop', version: '2026.11.12', rules: 2 }]);
    expect(report.schemaVersion).toBe('1.2');
    expect(renderMarkdown(report)).toMatch(/No og:image _\(shop pack\)_/);
    // A report re-rendered without the pack still produces SARIF.
    expect(JSON.stringify(renderSarif(report, loadKnowledge()))).toMatch(/"pack":"shop"/);
  });

  it('CLI: rules validate with a pack; an unknown pack is a usage error', async () => {
    const spies = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(process.stderr, 'write').mockImplementation(() => true), vi.spyOn(process.stdout, 'write').mockImplementation(() => true)];
    try {
      expect(await main(['rules', 'validate', '--rules-pack', PACK])).toBe(0);
      expect(await main(['rules', 'show', 'shop.missing-og-image', '--rules-pack', PACK])).toBe(0);
      expect(await main(['rules', 'validate', '--rules-pack', packCopy('broken', (r) => (r[1]!['check'] = { field: 'title', test: 'grows' }))])).toBe(1);
      expect(await main(['audit', site.url + '/', '--rules-pack', 'no-such-pack'])).toBe(EXIT.usage);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});
