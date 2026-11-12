import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { auditRepository } from '../../src/repo/audit.js';
import { remixRoute } from '../../src/repo/scan.js';
import { planFixes } from '../../src/optimize/fixes.js';

const dirs: string[] = [];
const repo = (files: Record<string, string>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-adapters-'));
  dirs.push(dir);
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  return dir;
};
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const evidenceFiles = (r: ReturnType<typeof auditRepository>['report'], id: string) => (r.findings.find((f) => f.ruleId === id)?.evidence ?? []).map((e) => e.file);

describe('G6: SvelteKit', () => {
  const dir = repo({
    'package.json': JSON.stringify({ devDependencies: { '@sveltejs/kit': '2.8.0', svelte: '5.0.0' } }),
    'src/app.html': '<!doctype html>\n<html>\n<head>%sveltekit.head%</head>\n<body>%sveltekit.body%</body>\n</html>\n',
    'src/routes/+layout.svelte': '<svelte:head><title>Acme</title></svelte:head>\n<slot />',
    'src/routes/+page.svelte': '<svelte:head><meta name="description" content="Acme home" /></svelte:head>\n<h1>Home</h1>',
    'src/routes/about/+page.svelte': '<h1>About</h1>',
    'src/routes/(marketing)/pricing/+page.svelte': '<svelte:head><meta name="description" content="Prices" /></svelte:head><h1>Pricing</h1>',
    'src/routes/blog/[slug]/+page.svelte': '<script>export let data;</script><svelte:head><Seo title={data.title} /></svelte:head><h1>{data.title}</h1>',
    'src/routes/blog/[slug]/+page.ts': 'export const load = () => ({ title: "x" });',
  });

  it('routes, inherited layout title, description and lang findings', () => {
    const { report, scan } = auditRepository(dir);
    expect(scan.routes.map((r) => r.route).sort()).toEqual(['/', '/about', '/blog/[slug]', '/pricing']);
    expect(scan.routes.find((r) => r.route === '/about')).toMatchObject({ hasTitle: true, hasDescription: false });
    // An SEO component in the head: unknown, not missing.
    expect(scan.routes.find((r) => r.route === '/blog/[slug]')).toMatchObject({ dynamic: true, hasDescription: null });
    expect(evidenceFiles(report, 'title.missing')).toEqual([]);
    expect(evidenceFiles(report, 'description.missing')).toEqual(['src/routes/about/+page.svelte']);
    expect(evidenceFiles(report, 'html.lang-missing')).toEqual(['src/app.html']);
  });

  it('plans lang in app.html and a static sitemap in static/', () => {
    const { report, scan } = auditRepository(dir);
    const plan = planFixes(report, scan, { siteUrl: 'https://acme.example', lang: 'en' });
    const files = plan.files.map((f) => f.path).sort();
    expect(files).toEqual(expect.arrayContaining(['src/app.html', 'static/sitemap.xml', 'static/robots.txt']));
    expect(plan.files.find((f) => f.path === 'src/app.html')!.after).toMatch(/<html lang="en">/);
    expect(plan.files.find((f) => f.path === 'static/sitemap.xml')!.after).toMatch(/https:\/\/acme\.example\/pricing/);
    expect(plan.files.find((f) => f.path === 'static/sitemap.xml')!.after).not.toMatch(/\[slug\]/);
  });
});

describe('G6: Remix', () => {
  it('flat route names', () => {
    expect(remixRoute('_index')).toEqual({ route: '/', dynamic: false });
    expect(remixRoute('blog.$slug')).toEqual({ route: '/blog/:slug', dynamic: true });
    expect(remixRoute('_auth.login')).toEqual({ route: '/login', dynamic: false });
    expect(remixRoute('docs_.archive')).toEqual({ route: '/docs/archive', dynamic: false });
    expect(remixRoute('($lang).about')).toEqual({ route: '/:lang/about', dynamic: true });
  });

  it('routes, meta exports, root inheritance and lang', () => {
    const dir = repo({
      'package.json': JSON.stringify({ dependencies: { '@remix-run/react': '2.15.0', react: '18.3.1' } }),
      'app/root.tsx': `export const meta = () => [{ title: 'Acme' }];\nexport default function App() { return <html><head /><body /></html>; }`,
      'app/routes/_index.tsx': `import type { MetaFunction } from '@remix-run/node';\nexport const meta: MetaFunction = () => [{ title: 'Home' }, { name: 'description', content: 'Acme home' }];\nexport default function Index() { return <h1>Home</h1>; }`,
      'app/routes/about.tsx': `export default function About() { return <h1>About</h1>; }`,
      'app/routes/blog.$slug.tsx': `export function meta({ data }) { return data ? [{ title: data.title }, { name: 'description', content: data.excerpt }] : []; }\nexport default function Post() { return null; }`,
      'app/routes/settings/route.tsx': `export const meta = () => [{ title: 'Settings' }, { name: 'robots', content: 'noindex' }];\nexport default function S() { return null; }`,
      'app/routes/settings/form.tsx': `export function Form() { return null; }`,
      'app/routes/api.health.ts': `export const loader = () => new Response('ok');`,
    });
    const { report, scan } = auditRepository(dir);
    expect(scan.routes.map((r) => r.route).sort()).toEqual(['/', '/about', '/blog/:slug', '/settings']);
    expect(scan.routes.find((r) => r.route === '/about')).toMatchObject({ hasTitle: true, hasDescription: false });
    expect(scan.routes.find((r) => r.route === '/settings')).toMatchObject({ noindex: true });
    expect(evidenceFiles(report, 'description.missing')).toEqual(['app/routes/about.tsx']);
    expect(evidenceFiles(report, 'title.missing')).toEqual([]);
    expect(evidenceFiles(report, 'html.lang-missing')).toEqual(['app/root.tsx']);
  });
});

describe('G6: WordPress block theme', () => {
  it('is detected without functions.php and checks the post title heading level', () => {
    const dir = repo({
      'style.css': '/*\nTheme Name: Acme Blocks\n*/',
      'theme.json': JSON.stringify({ version: 3 }),
      'templates/index.html': '<!-- wp:query --><!-- /wp:query -->',
      'templates/single.html': '<!-- wp:template-part {"slug":"header"} /-->\n<!-- wp:post-title /-->\n<!-- wp:post-content /-->',
      'templates/page.html': '<!-- wp:post-title {"level":1} /-->\n<!-- wp:post-content /-->',
      'parts/header.html': '<!-- wp:site-title /-->',
    });
    const { report, scan } = auditRepository(dir);
    expect(scan.apps[0]!.framework).toBe('wordpress-theme');
    const h1 = report.findings.find((f) => f.ruleId === 'h1.missing')!;
    expect(h1.evidence.map((e) => e.file)).toEqual(['templates/single.html']);
    expect(h1.evidence[0]!.observed).toMatch(/no "level":1/);
    expect(report.findings.find((f) => f.ruleId === 'title.missing')).toBeUndefined();
  });
});
