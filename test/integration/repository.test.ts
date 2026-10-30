import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { auditRepository } from '../../src/repo/audit.js';
import { planFixes } from '../../src/optimize/fixes.js';
import { applyFixes, ConflictError, rollback } from '../../src/optimize/transaction.js';
import { main } from '../../src/cli.js';

const FIX = path.resolve('test/fixtures/repos');
const temps: string[] = [];

function copyFixture(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `searvex-${name}-`));
  fs.cpSync(path.join(FIX, name), dir, { recursive: true });
  temps.push(dir);
  return dir;
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.searvex') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

const ids = (root: string, siteUrl?: string) => auditRepository(root, { siteUrl }).report.findings.map((f) => f.ruleId);

describe('repository detection and audit', () => {
  it.each([
    ['static-site', 'static-html', ['canonical.multiple', 'hreflang.invalid-code', 'mobile.viewport-missing', 'img.alt-missing', 'sd.missing-context', 'canonical.relative', 'html.lang-missing', 'robots.no-sitemap']],
    ['nextjs-app', 'nextjs-app', ['duplicate.title', 'img.alt-missing', 'links.uncrawlable', 'canonical.missing', 'html.lang-missing', 'robots.no-sitemap']],
    ['laravel', 'laravel', ['mobile.viewport-missing', 'img.alt-missing', 'description.missing', 'html.lang-missing', 'robots.no-sitemap', 'canonical.missing']],
    ['wp-theme', 'wordpress-theme', ['mobile.viewport-missing', 'title.missing', 'html.lang-missing']],
    ['vite-spa', 'vite-spa', ['index.client-rendered']],
    ['astro', 'astro', ['mobile.viewport-missing', 'title.missing', 'canonical.missing']],
  ])('%s → %s', (name, framework, expected) => {
    const { report, scan } = auditRepository(path.join(FIX, name));
    expect(scan.detection.framework).toBe(framework);
    expect(report.findings.map((f) => f.ruleId)).toEqual(expect.arrayContaining(expected));
    // Evidence must point at files inside the repository.
    for (const f of report.findings) for (const e of f.evidence) if (e.file) expect(path.isAbsolute(e.file)).toBe(false);
  });

  it('does not report network-only rules in repository mode', () => {
    const all = ['static-site', 'nextjs-app', 'laravel'].flatMap((n) => ids(path.join(FIX, n)));
    for (const r of ['perf.slow-ttfb', 'https.not-used', 'perf.no-compression', 'canonical.http-https']) expect(all).not.toContain(r);
  });

  it('infers the site origin so absolute canonicals are not mistaken for cross-domain', () => {
    const { report, scan } = auditRepository(path.join(FIX, 'static-site'));
    expect(scan.apps[0]!.originSource).toBe('inferred');
    expect(report.findings.map((f) => f.ruleId)).not.toContain('canonical.cross-domain');
  });

  it('scans every app of a monorepo', () => {
    const { scan } = auditRepository(path.join(FIX, 'monorepo'));
    expect(scan.apps.map((a) => `${a.framework}@${a.appRoot}`).sort()).toEqual(['astro@apps/docs', 'nextjs-app@apps/web']);
    expect(scan.routes.length).toBe(2);
  });

  it('treats spread props as an unknown title, not a missing one (real-world Astro blog)', () => {
    const r = auditRepository(path.join(FIX, 'astro')).report;
    const missing = r.findings.find((f) => f.ruleId === 'title.missing')!;
    expect(missing.evidence.map((e) => e.file)).toEqual(['src/pages/notes.astro']);
  });

  it('accepts a correct Next.js app without false positives on titles', () => {
    const r = auditRepository(path.join(FIX, 'monorepo')).report;
    expect(r.findings.filter((f) => f.ruleId === 'title.missing' && f.evidence.some((e) => e.file?.startsWith('apps/web')))).toEqual([]);
  });
});

describe('optimizer — plan, apply, verify, rollback', () => {
  it('fixes a static site and rolls back byte-for-byte', () => {
    const dir = copyFixture('static-site');
    const before = snapshot(dir);
    const audit = auditRepository(dir, { siteUrl: 'https://northwind.example' });
    const plan = planFixes(audit.report, audit.scan, { siteUrl: 'https://northwind.example', lang: 'en' });
    const rules = plan.fixes.map((f) => f.ruleId);
    expect(rules).toEqual(expect.arrayContaining(['html.lang-missing', 'mobile.viewport-missing', 'canonical.relative', 'canonical.multiple', 'sd.missing-context', 'hreflang.invalid-code', 'canonical.missing', 'robots.no-sitemap']));
    // Judgement calls are tasks, not automatic edits.
    expect(plan.tasks.map((t) => t.ruleId)).toEqual(expect.arrayContaining(['img.alt-missing', 'description.missing']));

    const manifest = applyFixes(dir, plan.fixes);
    const after = auditRepository(dir, { siteUrl: 'https://northwind.example' }).report;
    for (const r of ['html.lang-missing', 'mobile.viewport-missing', 'canonical.relative', 'canonical.multiple', 'sd.missing-context', 'hreflang.invalid-code', 'robots.no-sitemap', 'canonical.missing']) {
      expect(after.findings.map((f) => f.ruleId), r).not.toContain(r);
    }
    expect(after.scores.overall).toBeGreaterThan(audit.report.scores.overall);
    const index = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    expect(index).toContain('<html lang="en">');
    expect(index).toContain('<link rel="canonical" href="https://northwind.example/">');
    const sitemap = fs.readFileSync(path.join(dir, 'sitemap.xml'), 'utf8');
    expect(sitemap).toContain('<loc>https://northwind.example/blog/brewing-guide.html</loc>');
    expect(fs.readFileSync(path.join(dir, 'robots.txt'), 'utf8')).toContain('Sitemap: https://northwind.example/sitemap.xml');

    const rb = rollback(dir, manifest.changeId);
    expect(rb.conflicts).toEqual([]);
    expect(snapshot(dir)).toEqual(before);
  });

  it('uses framework idioms: Laravel locale and WordPress core functions', () => {
    const lv = copyFixture('laravel');
    const a = auditRepository(lv, { siteUrl: 'https://acme.example' });
    const p = planFixes(a.report, a.scan, { siteUrl: 'https://acme.example' });
    applyFixes(lv, p.fixes);
    const layout = fs.readFileSync(path.join(lv, 'resources/views/layouts/app.blade.php'), 'utf8');
    expect(layout).toContain(`<html lang="{{ str_replace('_', '-', app()->getLocale()) }}">`);
    expect(layout).toMatch(/<meta charset="utf-8">\n    <meta name="viewport"/);
    const sm = fs.readFileSync(path.join(lv, 'public/sitemap.xml'), 'utf8');
    expect(sm).toContain('https://acme.example/pricing');
    expect(sm).not.toContain('{post}');
    expect(fs.readFileSync(path.join(lv, 'public/robots.txt'), 'utf8')).toMatch(/User-agent: \*\nDisallow:\n\nSitemap: https:\/\/acme\.example\/sitemap\.xml/);

    const wp = copyFixture('wp-theme');
    const w = auditRepository(wp);
    const wpPlan = planFixes(w.report, w.scan, {});
    applyFixes(wp, wpPlan.fixes);
    expect(fs.readFileSync(path.join(wp, 'header.php'), 'utf8')).toContain('<html <?php language_attributes(); ?>>');
    expect(fs.readFileSync(path.join(wp, 'functions.php'), 'utf8')).toContain("add_theme_support( 'title-tag' );");
    expect(ids(wp)).not.toContain('title.missing');
  });

  it('generates a Next.js metadata-route sitemap and robots', () => {
    const dir = copyFixture('nextjs-app');
    const a = auditRepository(dir, { siteUrl: 'https://acme.example' });
    const p = planFixes(a.report, a.scan, { siteUrl: 'https://acme.example', lang: 'en' });
    applyFixes(dir, p.fixes);
    const sm = fs.readFileSync(path.join(dir, 'app/sitemap.ts'), 'utf8');
    expect(sm).toContain("MetadataRoute.Sitemap");
    expect(sm).toContain('"/pricing"');
    expect(sm).not.toContain('[slug]');
    expect(fs.readFileSync(path.join(dir, 'app/robots.ts'), 'utf8')).toContain("sitemap: 'https://acme.example/sitemap.xml'");
    expect(fs.readFileSync(path.join(dir, 'app/layout.tsx'), 'utf8')).toContain('<html lang="en">');
    expect(ids(dir, 'https://acme.example')).not.toContain('robots.no-sitemap');
  });

  it('refuses to apply when files changed after planning, and refuses rollback over later edits', () => {
    const dir = copyFixture('static-site');
    const a = auditRepository(dir, { siteUrl: 'https://northwind.example' });
    const p = planFixes(a.report, a.scan, { siteUrl: 'https://northwind.example', lang: 'en' });
    fs.appendFileSync(path.join(dir, 'index.html'), '\n<!-- edited -->');
    expect(() => applyFixes(dir, p.fixes)).toThrow(ConflictError);

    const a2 = auditRepository(dir, { siteUrl: 'https://northwind.example' });
    const p2 = planFixes(a2.report, a2.scan, { siteUrl: 'https://northwind.example', lang: 'en' });
    const m = applyFixes(dir, p2.fixes);
    fs.appendFileSync(path.join(dir, 'index.html'), '\n<!-- user edit after apply -->');
    const res = rollback(dir, m.changeId);
    expect(res.conflicts).toEqual(['index.html']);
    expect(res.restored).toEqual([]);
    expect(rollback(dir, m.changeId, { force: true }).restored.length).toBeGreaterThan(0);
  });

  it('CLI optimize is a dry run unless --apply, then verifies and supports rollback', async () => {
    const dir = copyFixture('static-site');
    const before = snapshot(dir);
    expect(await main(['optimize', dir, '--site-url', 'https://northwind.example', '--lang', 'en', '-q'])).toBe(0);
    expect(snapshot(dir)).toEqual(before);
    expect(await main(['optimize', dir, '--site-url', 'https://northwind.example', '--lang', 'en', '--apply', '--yes'])).toBe(0);
    expect(snapshot(dir)).not.toEqual(before);
    const changeId = fs.readdirSync(path.join(dir, '.searvex', 'changes'))[0]!;
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.searvex', 'changes', changeId, 'manifest.json'), 'utf8'));
    expect(manifest.status).toBe('verified');
    expect(await main(['rollback', changeId, dir])).toBe(0);
    expect(snapshot(dir)).toEqual(before);
  });

  it('never touches secret files or follows symlinks when applying', () => {
    const dir = copyFixture('static-site');
    expect(() => applyFixes(dir, [{ id: 'x', ruleId: 'title.missing', title: 't', rationale: 'r', changes: [{ path: '.env', action: 'create', before: null, after: 'X=1' }] }])).toThrow(/secret/);
    expect(() => applyFixes(dir, [{ id: 'x', ruleId: 'title.missing', title: 't', rationale: 'r', changes: [{ path: '../outside.txt', action: 'create', before: null, after: 'x' }] }])).toThrow(/escapes/);
  });
});
