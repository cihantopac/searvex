import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { auditRepository } from '../../src/repo/audit.js';
import { blankTemplateExpressions, errorPageStatus, imgWithoutAlt, routeMatches } from '../../src/repo/scan.js';

/**
 * Regressions from the local-repository round (2026-11-01): a CLI tool with HTML fixtures, a monorepo with a
 * static locale site plus a Laravel app behind one reverse proxy, and a Next.js static export. Fixtures are
 * anonymised reconstructions of the patterns found, not copies of the projects.
 */
const temps: string[] = [];
function repo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-rw-'));
  temps.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}
afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 40}`).join(' ');
const doc = (o: { lang?: string; title: string; canonical?: string; head?: string; body?: string }) =>
  `<!doctype html><html lang="${o.lang ?? 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${o.title}</title><meta name="description" content="${o.title} description for the page">${o.canonical ? `<link rel="canonical" href="${o.canonical}">` : ''}<meta property="og:title" content="${o.title}">${o.head ?? ''}</head><body><main><h1>${o.title}</h1><p>${words(220)}</p>${o.body ?? ''}</main></body></html>`;
const ids = (r: ReturnType<typeof auditRepository>['report']) => r.findings.map((f) => f.ruleId);

describe('repository without a website (CLI tool with HTML test data)', () => {
  it('ignores tests, fixtures, benchmarks, examples, eval output and snippets, and does not score 100', () => {
    const dir = repo({
      'package.json': '{"name":"cli-tool","bin":{"tool":"bin/tool"}}',
      'src/index.ts': 'export const x = 1;\n',
      'fixtures/sites/shop/index.html': '<html><head></head><body><img src="a.png"></body></html>',
      'tests/fixtures/page.html': '<html><body><a>no href</a></body></html>',
      'bench/scenarios/blog/project/index.html': '<html><head><title>x</title></head><body></body></html>',
      'examples/demo/index.html': '<html><body></body></html>',
      'plugin/evals/results/run-1/report.html': '<html><head><title>eval</title></head><body></body></html>',
      'exports/web/head-snippet.html': '<link rel="icon" href="/favicon.svg">\n<meta name="theme-color" content="#000">\n',
      'project/templates/profile.html': '{% extends "base.html" %}{% block content %}<p>{{ user.name }}</p>{% endblock %}',
    });
    const { report } = auditRepository(dir);
    expect(report.inventory.pages).toEqual([]);
    expect(report.findings.filter((f) => f.severity !== 'info')).toEqual([]);
    expect(report.scores.notApplicable).toMatch(/No website found/);
    expect(report.limitations[0]).toMatch(/No website found/);
  });
});

describe('monorepo: static locale site + Laravel app behind one proxy', () => {
  const files = (laravelRoute: boolean): Record<string, string> => ({
    'apps/site/public/en/index.html': doc({ title: 'Home', canonical: 'https://app.example/en/', body: '<a href="/en/about">About</a> <a href="/en/heroes">Heroes</a>' }),
    'apps/site/public/en/about.html': doc({ title: 'About us', canonical: 'https://app.example/en/about', body: '<a href="/en/">Home</a> <a href="/en/heroes">Heroes</a>' }),
    'apps/site/public/en/404.html': doc({ title: 'Not found', canonical: 'https://app.example/en/', head: '<meta name="robots" content="noindex">' }),
    'apps/site/public/sitemap.xml': '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://app.example/en/</loc></url><url><loc>https://app.example/en/about</loc></url><url><loc>https://app.example/en/heroes</loc></url></urlset>',
    'apps/site/public/robots.txt': 'User-agent: *\nAllow: /\n\nSitemap: https://app.example/sitemap.xml\n',
    'services/api/composer.json': '{"require":{"laravel/framework":"^12.0"}}',
    'services/api/routes/web.php': "<?php\nRoute::get('/', fn () => view('welcome'));\nrequire __DIR__.'/public.php';\n",
    'services/api/routes/public.php': laravelRoute ? "<?php\nRoute::get('/en/heroes', [HeroesController::class, 'show']);\n" : '<?php\n',
    'services/api/routes/api.php': "<?php\nRoute::get('/v1/items', fn () => []);\n",
    'services/api/resources/views/channel.blade.php': `<div>\n<img src="{{ route('picture', ['kind' => 'current']) }}?v={{ $c->version }}" width="96" height="96" alt="">\n<img src="/emoji/{{ $c?->emoji }}.webp" width="64" height="64" alt="">\n</div>\n`,
    'services/api/resources/views/filament/pages/showcase.blade.php': '<div><img src="/x.png"><a wire:click="go">Go</a></div>\n',
    'services/api/tests/Feature/PortalTest.php': "<?php\n$this->get('/')->assertSee('<a class=\"x\">', false);\n",
  });

  it('finds the static site in a workspace folder, uses its clean URLs and treats 404.html as an error page', () => {
    const { report, scan } = auditRepository(repo(files(true)));
    expect(scan.apps.map((a) => `${a.appRoot}:${a.framework}`)).toEqual(expect.arrayContaining(['apps/site:static-html', 'services/api:laravel']));
    const urls = report.inventory.pages.map((p) => p.url);
    expect(urls).toEqual(expect.arrayContaining(['https://app.example/en/', 'https://app.example/en/about']));
    expect(urls.some((u) => /404/.test(u))).toBe(false);
    const r = ids(report);
    // The canonical of about.html is its clean URL: it is self-canonical, not a conflict.
    for (const id of ['canonical.noindex-conflict', 'index.sitemap-non-canonical', 'canonical.target-error']) expect(r).not.toContain(id);
  });

  it('does not call a URL broken when another app in the repository routes it', () => {
    const r = ids(auditRepository(repo(files(true))).report);
    expect(r).not.toContain('links.broken-internal');
    expect(r).not.toContain('index.sitemap-non200');
  });

  it('reports a sitemap-listed, linked URL that nothing in the repository serves, as heuristic', () => {
    const { report } = auditRepository(repo(files(false)));
    const f = report.findings.find((x) => x.ruleId === 'links.broken-internal');
    expect(f?.confidence).toBe('heuristic');
    expect(f?.evidence[0]?.observed).toMatch(/no file in the repository serves this URL, linked from 2 page/);
  });

  it('reads alt="" next to Blade expressions, and skips admin-panel views and tests', () => {
    const r = ids(auditRepository(repo(files(true))).report);
    expect(r).not.toContain('img.alt-missing');
    expect(r).not.toContain('links.uncrawlable');
  });
});

describe('Next.js static export', () => {
  it('skips error pages, accepts fill images and Person-only personal sites', () => {
    const fill = '<img alt="Screenshot" decoding="async" data-nimg="fill" style="position:absolute;height:100%;width:100%;left:0;top:0" sizes="100vw" src="/shot.webp"/>';
    const person = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Person","name":"Jane Doe","url":"https://jane.example/"}</script>';
    const dir = repo({
      'package.json': '{"dependencies":{"next":"16.2.4","react":"19.2.4"}}',
      'app/layout.tsx': "export const metadata = { title: 'Jane', description: 'Jane Doe', alternates: { canonical: '/' } };\nexport default function L({ children }) { return <html lang=\"en\"><body>{children}</body></html>; }\n",
      'app/page.tsx': 'export default function P() { return <main>Hi</main>; }\n',
      'app/robots.ts': "export default function r() { return { rules: { userAgent: '*', allow: '/' }, sitemap: 'https://jane.example/sitemap.xml' }; }\n",
      'app/sitemap.ts': "export default function s() { return [{ url: 'https://jane.example/' }]; }\n",
      'out/index.html': doc({ title: 'Jane Doe', canonical: 'https://jane.example/', head: person, body: fill }),
      'out/404.html': doc({ title: '404', canonical: 'https://jane.example/', head: '<meta name="robots" content="noindex">' }),
      'out/_not-found/index.html': doc({ title: '404', canonical: 'https://jane.example/', head: '<meta name="robots" content="noindex">' }),
      'out/404/index.html': doc({ title: '404', canonical: 'https://jane.example/', head: '<meta name="robots" content="noindex">' }),
    });
    const r = ids(auditRepository(dir).report);
    for (const id of ['canonical.noindex-conflict', 'url.underscores', 'img.dimensions-missing', 'geo.organization-missing', 'index.noindex']) expect(r, id).not.toContain(id);
  });
});

describe('helpers', () => {
  it('matches framework route patterns', () => {
    expect(routeMatches('/en/heroes', '/en/heroes/')).toBe(true);
    expect(routeMatches('/blog/{slug}', '/blog/hello')).toBe(true);
    expect(routeMatches('/blog/[slug]', '/blog/hello/more')).toBe(false);
    expect(routeMatches('/docs/[...path]', '/docs/a/b')).toBe(true);
    expect(routeMatches('/a.b', '/axb')).toBe(false);
  });

  it('knows conventional error pages', () => {
    expect(errorPageStatus('/404.html')).toBe(404);
    expect(errorPageStatus('/en/404.html')).toBe(404);
    expect(errorPageStatus('/_not-found/')).toBe(404);
    expect(errorPageStatus('/500.html')).toBe(500);
    expect(errorPageStatus('/blog/404-errors-explained')).toBeNull();
  });

  it('blanks template expressions without moving line numbers', () => {
    const src = `<p>\n<img src="{{ route('a', ['k' => 1]) }}" alt="">\n<img src="<?= $x->y ?>">\n`;
    expect(blankTemplateExpressions(src).split('\n').length).toBe(src.split('\n').length);
    expect(imgWithoutAlt(src)).toEqual([3]);
  });
});
