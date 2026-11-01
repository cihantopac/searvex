import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { auditRepository } from '../../src/repo/audit.js';
import { planFixes } from '../../src/optimize/fixes.js';
import { applyFixes, rollback } from '../../src/optimize/transaction.js';

const temps: string[] = [];
afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

function site(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-v11-'));
  temps.push(dir);
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  return dir;
}

const body = '<main><h1>Roasting</h1><p>' + 'Fresh coffee beans roasted every week in small batches. '.repeat(30) + '</p></main>';
const page = (head: string) => `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n${head}\n</head>\n<body>${body}<svg><title>Logo</title></svg></body>\n</html>\n`;

describe('v1.1 fixers', () => {
  it('removes identical duplicate titles and descriptions, verifies, and rolls back byte-for-byte', () => {
    const dir = site({
      'index.html': page('  <title>Northwind Coffee</title>\n  <title>Northwind Coffee</title>\n  <meta name="description" content="Small-batch coffee roasters.">\n  <meta name="description" content="Small-batch coffee roasters.">\n  <link rel="canonical" href="https://northwind.example/">'),
    });
    const original = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    const audit = auditRepository(dir, { siteUrl: 'https://northwind.example' });
    expect(audit.report.findings.map((f) => f.ruleId)).toEqual(expect.arrayContaining(['title.multiple', 'description.multiple']));
    const plan = planFixes(audit.report, audit.scan, { siteUrl: 'https://northwind.example', only: ['title.multiple', 'description.multiple'] });
    expect(plan.fixes.map((f) => f.ruleId).sort()).toEqual(['description.multiple', 'title.multiple']);
    const m = applyFixes(dir, plan.fixes);
    const after = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    expect(after.match(/<title>Northwind Coffee<\/title>/g)).toHaveLength(1);
    expect(after.match(/name="description"/g)).toHaveLength(1);
    expect(after).toContain('<svg><title>Logo</title></svg>');
    const ids = auditRepository(dir, { siteUrl: 'https://northwind.example' }).report.findings.map((f) => f.ruleId);
    expect(ids).not.toContain('title.multiple');
    expect(ids).not.toContain('description.multiple');
    expect(rollback(dir, m.changeId).conflicts).toEqual([]);
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toBe(original);
  });

  it('turns conflicting duplicates into an agent task instead of guessing which one to keep', () => {
    const dir = site({ 'index.html': page('  <title>Home</title>\n  <title>Northwind Coffee — Home</title>') });
    const audit = auditRepository(dir, { siteUrl: 'https://northwind.example' });
    const plan = planFixes(audit.report, audit.scan, { siteUrl: 'https://northwind.example', only: ['title.multiple'] });
    expect(plan.fixes).toEqual([]);
    expect(plan.tasks.map((t) => t.ruleId)).toEqual(['title.multiple']);
    expect(plan.tasks[0]!.locations[0]!.observed).toContain('vs');
  });

  it('makes relative hreflang URLs absolute against the page URL', () => {
    const dir = site({
      'index.html': page('  <title>Home</title>\n  <link rel="alternate" hreflang="en" href="/">\n  <link rel="alternate" hreflang="de" href="/de/">\n  <link rel="alternate" hreflang="x-default" href="https://northwind.example/">'),
      'de/index.html': page('  <title>Start</title>\n  <link rel="alternate" hreflang="en" href="/">\n  <link rel="alternate" hreflang="de" href="/de/">').replace('lang="en"', 'lang="de"'),
    });
    const audit = auditRepository(dir, { siteUrl: 'https://northwind.example' });
    expect(audit.report.findings.map((f) => f.ruleId)).toContain('hreflang.relative');
    const noSite = planFixes(audit.report, audit.scan, { only: ['hreflang.relative'] });
    expect(noSite.fixes).toEqual([]);
    expect(noSite.skipped[0]?.reason).toMatch(/site URL unknown/);
    const plan = planFixes(audit.report, audit.scan, { siteUrl: 'https://northwind.example', only: ['hreflang.relative'] });
    applyFixes(dir, plan.fixes);
    const de = fs.readFileSync(path.join(dir, 'de/index.html'), 'utf8');
    expect(de).toContain('hreflang="de" href="https://northwind.example/de/"');
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toContain('hreflang="x-default" href="https://northwind.example/"');
    expect(auditRepository(dir, { siteUrl: 'https://northwind.example' }).report.findings.map((f) => f.ruleId)).not.toContain('hreflang.relative');
  });
});

describe('sitemap planner in a monorepo', () => {
  it('never generates a sitemap for an app that has one, and leaves ambiguous hosts in a monorepo to a reviewed task', () => {
    const fx = (f: string) => fs.readFileSync(path.resolve('test/fixtures/repos/laravel', f), 'utf8');
    const dir = site({
      'apps/site/public/index.html': page('  <title>Home</title>\n  <link rel="canonical" href="https://acme.example/">'),
      'apps/site/public/sitemap.xml': '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://acme.example/</loc></url></urlset>\n',
      'apps/site/public/robots.txt': 'User-agent: *\nAllow: /\n\nSitemap: https://acme.example/sitemap.xml\n',
      'services/api/composer.json': fx('composer.json'),
      'services/api/routes/web.php': fx('routes/web.php'),
      'services/api/public/robots.txt': fx('public/robots.txt'),
      'services/api/resources/views/welcome.blade.php': fx('resources/views/welcome.blade.php'),
      'services/api/resources/views/layouts/app.blade.php': fx('resources/views/layouts/app.blade.php'),
    });
    const audit = auditRepository(dir, { siteUrl: 'https://acme.example' });
    expect(audit.scan.apps.map((a) => a.framework).sort()).toEqual(['laravel', 'static-html']);
    const plan = planFixes(audit.report, audit.scan, { siteUrl: 'https://acme.example', only: ['robots.no-sitemap'] });
    // Never a second sitemap for the static app; the Laravel app's host is ambiguous → a task, not a patch.
    expect(plan.files).toEqual([]);
    expect(plan.tasks).toEqual([expect.objectContaining({ ruleId: 'robots.no-sitemap', locations: [{ file: 'services/api/public' }] })]);
    // Pointed at the app itself with its own host, the planner can generate it.
    const api = auditRepository(path.join(dir, 'services/api'), { siteUrl: 'https://api.acme.example' });
    const apiPlan = planFixes(api.report, api.scan, { siteUrl: 'https://api.acme.example', only: ['robots.no-sitemap'] });
    expect(apiPlan.files.map((f) => f.path)).toContain('public/sitemap.xml');
  });
});
