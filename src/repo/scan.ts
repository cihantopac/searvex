import path from 'node:path';
import type { CrawlResult, PageRecord } from '../crawl/crawler.js';
import { parseRobots, type RobotsInfo } from '../crawl/robots.js';
import { parseSitemapXml } from '../crawl/sitemap.js';
import { extractPage } from '../extract/html.js';
import type { FindingSink } from '../rules/engine.js';
import { detect, type Detection, type Framework } from './detect.js';
import { lineOf, readText, walk, type WalkedFile } from './fs-safe.js';

export interface RouteInfo {
  route: string;
  file: string;
  framework: Framework;
  dynamic: boolean;
  hasTitle: boolean | null;
  hasDescription: boolean | null;
  noindex: boolean;
}

export interface AppLocations {
  publicDir: string | null;
  robotsFile: string | null;
  sitemapFiles: string[];
  rootLayout: string | null;
  layouts: string[];
  hasSitemapGenerator: string | null;
  hasRobotsGenerator: string | null;
}

/** One application inside the repository (monorepos contain several). */
export interface AppScan {
  appRoot: string;
  framework: Framework;
  routes: RouteInfo[];
  locations: AppLocations;
  /** Synthetic crawl over static HTML files (if any) so web-mode analyzers can run. */
  staticSite?: CrawlResult;
  /** URL → file mapping for evidence rewriting. */
  urlToFile: Map<string, string>;
  /** How the site origin used for static analysis was determined. */
  originSource?: 'site-url' | 'inferred' | 'placeholder';
}

export interface RepoScan {
  root: string;
  detection: Detection;
  apps: AppScan[];
  files: WalkedFile[];
  skipped: { symlinks: number; secrets: number; large: number; truncated: boolean };
  /** All routes across apps. */
  routes: RouteInfo[];
}

export const PLACEHOLDER_ORIGIN = 'https://site.invalid';

const SOURCE_EXT = /\.(tsx|jsx|ts|js|mjs|vue|svelte|astro|mdx?|php|html?|twig|njk|liquid|hbs)$/i;

function rel(appRoot: string, f: string): string {
  return appRoot === '.' ? f : `${appRoot}/${f}`;
}

function find(files: WalkedFile[], re: RegExp): WalkedFile[] {
  return files.filter((f) => re.test(f.rel));
}

/** JSX/HTML <img> without alt (case-sensitive `<img`/`<Image` tags), with line numbers. */
export function imgWithoutAlt(text: string): number[] {
  const lines: number[] = [];
  const re = /<(img|Image)\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!/\balt\s*=/.test(m[2]!) && !/\{\s*\.\.\.\w+\s*\}/.test(m[2]!)) lines.push(lineOf(text, m.index));
  }
  return lines;
}

/** <a> elements without href (non-crawlable links) and javascript: hrefs. */
export function anchorsWithoutHref(text: string): number[] {
  const lines: number[] = [];
  const re = /<a\b([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const attrs = m[1]!;
    if (/\{\s*\.\.\.\w+\s*\}/.test(attrs)) continue;
    if (!/\b(href|:href|v-bind:href|xlink:href)\s*=/.test(attrs) || /href\s*=\s*["'](javascript:|#["'])/.test(attrs)) lines.push(lineOf(text, m.index));
  }
  return lines;
}

function nextRoute(file: string, base: RegExp): string {
  const segs = file.replace(base, '').replace(/\/?page\.(tsx|jsx|ts|js|mdx)$/, '').split('/').filter(Boolean);
  const parts = segs.filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith('@'));
  return '/' + parts.join('/');
}

function hasKey(src: string, key: string): boolean {
  return new RegExp(`\\b${key}\\s*:`).test(src);
}

/** Scan Next.js (app router) sources. */
function scanNextApp(appRoot: string, files: WalkedFile[], read: (f: string) => string, sink: FindingSink, scan: AppScan): void {
  const appBase = files.some((f) => f.rel.startsWith(rel(appRoot, 'src/app/'))) ? rel(appRoot, 'src/app/') : rel(appRoot, 'app/');
  const baseRe = new RegExp('^' + appBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pages = files.filter((f) => f.rel.startsWith(appBase) && /\/page\.(tsx|jsx|ts|js|mdx)$|^page\./.test(f.rel.slice(appBase.length - 1)) && !/\/(@[^/]+|\(\.+\)[^/]*)\//.test(f.rel));
  const layouts = new Map<string, string>();
  for (const f of files.filter((f) => f.rel.startsWith(appBase) && /(^|\/)layout\.(tsx|jsx|ts|js)$/.test(f.rel))) layouts.set(path.posix.dirname(f.rel), read(f.rel));
  const rootLayoutPath = files.find((f) => new RegExp('^' + appBase + 'layout\\.(tsx|jsx|ts|js)$').test(f.rel))?.rel ?? null;
  scan.locations.rootLayout = rootLayoutPath;
  scan.locations.layouts = [...layouts.keys()];
  const titleOwners: Record<string, string[]> = {};
  for (const p of pages) {
    const src = read(p.rel);
    const chain: string[] = [];
    let dir = path.posix.dirname(p.rel);
    while (dir.length >= appBase.length - 1) {
      const l = layouts.get(dir);
      if (l) chain.push(l);
      if (dir + '/' === appBase) break;
      dir = path.posix.dirname(dir);
    }
    const pageMeta = /export\s+(const\s+metadata|(async\s+)?function\s+generateMetadata)/.test(src);
    const pageTitle = pageMeta && hasKey(src, 'title');
    const pageDesc = pageMeta && hasKey(src, 'description');
    const layoutTitle = chain.some((l) => /export\s+(const\s+metadata|(async\s+)?function\s+generateMetadata)/.test(l) && hasKey(l, 'title'));
    const layoutDesc = chain.some((l) => /export\s+(const\s+metadata|(async\s+)?function\s+generateMetadata)/.test(l) && hasKey(l, 'description'));
    const canonical = /alternates\s*:\s*\{[^}]*canonical/s.test(src) || chain.some((l) => /alternates\s*:\s*\{[^}]*canonical/s.test(l));
    const noindex = /robots\s*:\s*\{[^}]*index\s*:\s*false/s.test(src) || /robots\s*:\s*['"][^'"]*noindex/.test(src);
    const route = nextRoute(p.rel, baseRe);
    scan.routes.push({ route, file: p.rel, framework: 'nextjs-app', dynamic: /\[.+\]/.test(route), hasTitle: pageTitle || layoutTitle, hasDescription: pageDesc || layoutDesc, noindex });
    if (!pageTitle && !layoutTitle) sink.emit('title.missing', { file: p.rel, observed: `route ${route}: no metadata.title in page or ancestor layouts` });
    else if (!pageTitle && !noindex) (titleOwners['inherited'] ??= []).push(`${route} (${p.rel})`);
    if (!pageDesc && !layoutDesc && !noindex) sink.emit('description.missing', { file: p.rel, observed: `route ${route}: no metadata.description` });
    if (!canonical && !noindex) sink.emit('canonical.missing', { file: p.rel, observed: `route ${route}: no metadata.alternates.canonical` });
    if (noindex) sink.emit('index.noindex', { file: p.rel, observed: `route ${route}: robots index:false` });
  }
  const inherited = titleOwners['inherited'] ?? [];
  if (inherited.length > 1) sink.emit('duplicate.title', { file: rootLayoutPath ?? undefined, observed: `${inherited.length} routes inherit the same layout title (unless title.template is combined with page titles): ${inherited.slice(0, 5).join(', ')}` });
  if (rootLayoutPath) {
    const l = read(rootLayoutPath);
    const htmlTag = /<html\b[^>]*>/.exec(l);
    if (htmlTag && !/\blang\s*=/.test(htmlTag[0])) sink.emit('html.lang-missing', { file: rootLayoutPath, line: lineOf(l, htmlTag.index), observed: htmlTag[0] });
  }
  const robotsGen = files.find((f) => new RegExp('^' + appBase + 'robots\\.(ts|js|txt)$').test(f.rel));
  const sitemapGen = files.find((f) => new RegExp('^' + appBase + 'sitemap\\.(ts|js|xml)$').test(f.rel));
  if (robotsGen) scan.locations.hasRobotsGenerator = robotsGen.rel;
  if (sitemapGen) scan.locations.hasSitemapGenerator = sitemapGen.rel;
}

function scanNextPages(appRoot: string, files: WalkedFile[], read: (f: string) => string, sink: FindingSink, scan: AppScan): void {
  const base = files.some((f) => f.rel.startsWith(rel(appRoot, 'src/pages/'))) ? rel(appRoot, 'src/pages/') : rel(appRoot, 'pages/');
  const pages = files.filter((f) => f.rel.startsWith(base) && /\.(tsx|jsx|ts|js|mdx)$/.test(f.rel) && !/\/(_app|_document|_error|404|500)\.|\/api\//.test('/' + f.rel.slice(base.length)));
  const appFile = files.find((f) => f.rel.startsWith(base + '_app.'));
  const docFile = files.find((f) => f.rel.startsWith(base + '_document.'));
  const appSrc = appFile ? read(appFile.rel) : '';
  const globalTitle = /<title[\s>]/.test(appSrc);
  const globalDesc = /name=["']description["']/.test(appSrc);
  scan.locations.rootLayout = docFile?.rel ?? appFile?.rel ?? null;
  for (const p of pages) {
    const src = read(p.rel);
    const route = '/' + p.rel.slice(base.length).replace(/\.(tsx|jsx|ts|js|mdx)$/, '').replace(/(^|\/)index$/, '');
    const hasTitle = /<title[\s>]/.test(src) || /NextSeo|DefaultSeo|<Seo\b|<SEO\b/.test(src);
    const hasDesc = /name=["']description["']/.test(src) || /NextSeo|<Seo\b|<SEO\b/.test(src);
    scan.routes.push({ route, file: p.rel, framework: 'nextjs-pages', dynamic: /\[.+\]/.test(route), hasTitle: hasTitle || globalTitle, hasDescription: hasDesc || globalDesc, noindex: /noindex/.test(src) });
    if (!hasTitle && !globalTitle) sink.emit('title.missing', { file: p.rel, observed: `route ${route}: no <title> in next/head` });
    if (!hasTitle && globalTitle) sink.emit('duplicate.title', { file: p.rel, observed: `route ${route} only gets the global title from ${appFile?.rel}` });
    if (!hasDesc && !globalDesc) sink.emit('description.missing', { file: p.rel, observed: `route ${route}` });
  }
  if (docFile) {
    const d = read(docFile.rel);
    const m = /<Html\b[^>]*>/.exec(d);
    if (m && !/\blang\s*=/.test(m[0])) sink.emit('html.lang-missing', { file: docFile.rel, line: lineOf(d, m.index), observed: m[0] });
  }
}

/** Shared checks for template-driven frameworks: layouts must carry <title>, description, viewport, lang. */
function scanLayouts(layoutFiles: string[], read: (f: string) => string, sink: FindingSink, scan: AppScan, idioms: { titleRe: RegExp; langRe: RegExp }): void {
  scan.locations.layouts = layoutFiles;
  for (const f of layoutFiles) {
    const src = read(f);
    if (!/<head\b/i.test(src)) continue;
    scan.locations.rootLayout ??= f;
    if (!idioms.titleRe.test(src)) sink.emit('title.missing', { file: f, observed: 'layout <head> has no title' });
    if (!/name=["']description["']/i.test(src) && !/wp_head\s*\(/.test(src)) sink.emit('description.missing', { file: f, observed: 'layout has no meta description' });
    if (!/name=["']viewport["']/i.test(src)) {
      const head = /<head\b[^>]*>/i.exec(src);
      sink.emit('mobile.viewport-missing', { file: f, line: head ? lineOf(src, head.index) : undefined, observed: 'no <meta name="viewport">' });
    }
    const html = /<html\b[^>]*>/i.exec(src);
    if (html && !idioms.langRe.test(html[0])) sink.emit('html.lang-missing', { file: f, line: lineOf(src, html.index), observed: html[0] });
    if (!/rel=["']canonical["']/i.test(src)) sink.emit('canonical.missing', { file: f, observed: 'layout <head> has no rel=canonical' });
  }
}

function scanSources(files: WalkedFile[], read: (f: string) => string, sink: FindingSink): void {
  for (const f of files) {
    if (!/\.(tsx|jsx|vue|svelte|astro|php|html?)$/.test(f.rel) || /(^|\/)(dist|build|out|public|_site|static)\//.test(f.rel) || /\.(test|spec|stories)\./.test(f.rel)) continue;
    const src = read(f.rel);
    const noAlt = imgWithoutAlt(src);
    if (noAlt.length) sink.emit('img.alt-missing', noAlt.slice(0, 5).map((line) => ({ file: f.rel, line, observed: 'image without alt attribute' })));
    const noHref = anchorsWithoutHref(src);
    if (noHref.length) sink.emit('links.uncrawlable', noHref.slice(0, 5).map((line) => ({ file: f.rel, line, observed: '<a> without crawlable href' })));
  }
}

/** Build a synthetic crawl from static HTML files so the website analyzers can be reused. */
function staticCrawl(htmlFiles: string[], dirBase: string, read: (f: string) => string, scan: AppScan, files: WalkedFile[], siteOrigin: string): CrawlResult {
  const pages: PageRecord[] = [];
  for (const f of htmlFiles) {
    let urlPath = '/' + f.slice(dirBase.length).replace(/^\/+/, '');
    urlPath = urlPath.replace(/(^|\/)index\.html?$/i, '$1');
    const url = new URL(urlPath, siteOrigin).toString();
    const html = read(f);
    scan.urlToFile.set(url, f);
    pages.push({
      url, finalUrl: url, status: 200, depth: urlPath.split('/').filter(Boolean).length, redirects: [], contentType: 'text/html', timingMs: 0,
      bytes: Buffer.byteLength(html), truncated: false, headers: { 'content-encoding': 'n/a (repository)' }, xRobots: [], xRobotsByBot: {},
      blockedByRobots: false, inSitemap: false, data: extractPage(html, url),
    });
  }
  const robotsRel = [`${dirBase}robots.txt`, 'public/robots.txt', 'robots.txt'].find((r) => files.some((f) => f.rel === r));
  const robots: RobotsInfo = robotsRel ? parseRobots(new URL('/robots.txt', siteOrigin).toString(), read(robotsRel), 200) : { ...parseRobots(new URL('/robots.txt', siteOrigin).toString(), '', 404), state: 'missing' };
  const sitemapFiles = files.filter((f) => f.rel.startsWith(dirBase) && /sitemap[^/]*\.xml$/i.test(f.rel)).map((f) => f.rel);
  const smUrls = sitemapFiles.flatMap((s) => parseSitemapXml(read(s), s).urls);
  const smSet = new Set(smUrls.map((u) => u.loc));
  for (const p of pages) p.inSitemap = smSet.has(p.url);
  return {
    runId: 'repository', startUrl: new URL('/', siteOrigin).toString(), origin: siteOrigin, robots,
    sitemap: { sitemaps: sitemapFiles, urls: smUrls, issues: [] }, pages, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    stats: { crawled: pages.length, queuedRemaining: 0, blocked: 0, errors: 0, durationMs: 0, avgResponseMs: 0 }, truncated: false,
  };
}

/** Most common origin among absolute canonical / og:url / hreflang URLs in the HTML files. */
export function inferSiteOrigin(htmls: string[]): string | null {
  const counts = new Map<string, number>();
  for (const h of htmls) {
    for (const m of h.matchAll(/<(?:link|meta)\b[^>]*(?:rel=["']?(?:canonical|alternate)["']?|property=["']og:url["'])[^>]*>/gi)) {
      const url = /(?:href|content)=["'](https?:\/\/[^"']+)/i.exec(m[0])?.[1];
      if (!url) continue;
      try {
        const o = new URL(url).origin;
        counts.set(o, (counts.get(o) ?? 0) + 1);
      } catch {
        /* ignore malformed */
      }
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

const OUTPUT_DIRS = /(^|\/)(dist|build|out|_site|public|node_modules|vendor)\//;

function scanApp(root: string, appRoot: string, framework: Framework, files: WalkedFile[], read: (f: string) => string, sink: FindingSink, opts: { siteUrl?: string }): AppScan {
  const scan: AppScan = {
    appRoot, framework, routes: [], urlToFile: new Map(),
    locations: { publicDir: null, robotsFile: null, sitemapFiles: [], rootLayout: null, layouts: [], hasSitemapGenerator: null, hasRobotsGenerator: null },
  };
  const appFiles = appRoot === '.' ? files : files.filter((f) => f.rel.startsWith(appRoot + '/'));
  const publicDir = ['public', 'static', 'web'].map((d) => rel(appRoot, d)).find((d) => appFiles.some((f) => f.rel.startsWith(d + '/'))) ?? (['laravel', 'nextjs-app', 'nextjs-pages', 'astro', 'nuxt', 'vite-spa', 'cra-spa'].includes(framework) ? rel(appRoot, 'public') : null);
  scan.locations.publicDir = publicDir;
  scan.locations.robotsFile = appFiles.find((f) => f.rel === (publicDir ? `${publicDir}/robots.txt` : 'robots.txt') || f.rel === rel(appRoot, 'robots.txt'))?.rel ?? null;
  scan.locations.sitemapFiles = appFiles.filter((f) => /sitemap[^/]*\.xml$/i.test(f.rel) && !/(^|\/)(dist|build|out)\//.test(f.rel)).map((f) => f.rel);

  const pkgText = appFiles.find((f) => f.rel === rel(appRoot, 'package.json')) ? read(rel(appRoot, 'package.json')) : '';
  const composerText = appFiles.find((f) => f.rel === rel(appRoot, 'composer.json')) ? read(rel(appRoot, 'composer.json')) : '';

  switch (framework) {
    case 'nextjs-app':
      scanNextApp(appRoot, appFiles, read, sink, scan);
      if (/"next-sitemap"/.test(pkgText)) scan.locations.hasSitemapGenerator ??= 'next-sitemap (package.json)';
      break;
    case 'nextjs-pages':
      scanNextPages(appRoot, appFiles, read, sink, scan);
      if (/"next-sitemap"/.test(pkgText)) scan.locations.hasSitemapGenerator ??= 'next-sitemap (package.json)';
      break;
    case 'astro': {
      const layouts = find(appFiles, /\/(layouts|components)\/[^/]*(Layout|Head|BaseHead|SEO)[^/]*\.astro$/i).map((f) => f.rel);
      scanLayouts(layouts.length ? layouts : find(appFiles, /\.astro$/).map((f) => f.rel).filter((f) => /<head/i.test(read(f))), read, sink, scan, { titleRe: /<title\b/i, langRe: /\blang\s*=/ });
      for (const p of find(appFiles, /src\/pages\/.+\.(astro|md|mdx)$/)) {
        const route = '/' + p.rel.replace(/^.*src\/pages\//, '').replace(/\.(astro|mdx?)$/, '').replace(/(^|\/)index$/, '');
        const src = read(p.rel);
        const hasTitle = /<title\b/i.test(src) || /\btitle\s*=\s*[{"']/.test(src) || /^---[\s\S]*?\ntitle\s*:/m.test(src);
        scan.routes.push({ route, file: p.rel, framework: 'astro', dynamic: /\[.+\]/.test(route), hasTitle, hasDescription: /description\s*[=:]/.test(src), noindex: /noindex/.test(src) });
        if (!hasTitle) sink.emit('title.missing', { file: p.rel, observed: `route ${route}: no title passed to layout and no <title>` });
      }
      const cfg = appFiles.find((f) => /astro\.config\.\w+$/.test(f.rel));
      if (cfg && /@astrojs\/sitemap/.test(read(cfg.rel))) scan.locations.hasSitemapGenerator = `${cfg.rel} (@astrojs/sitemap)`;
      break;
    }
    case 'nuxt': {
      const cfg = appFiles.find((f) => /nuxt\.config\.\w+$/.test(f.rel));
      const cfgSrc = cfg ? read(cfg.rel) : '';
      if (cfg && !/htmlAttrs\s*:\s*\{[^}]*lang/s.test(cfgSrc) && !/@nuxtjs\/i18n/.test(cfgSrc)) sink.emit('html.lang-missing', { file: cfg.rel, observed: 'app.head.htmlAttrs.lang not set' });
      if (/@nuxtjs\/sitemap|@nuxtjs\/seo/.test(cfgSrc + pkgText)) scan.locations.hasSitemapGenerator = '@nuxtjs/sitemap';
      for (const p of find(appFiles, /(^|\/)pages\/.+\.vue$/)) {
        const src = read(p.rel);
        const route = '/' + p.rel.replace(/^.*pages\//, '').replace(/\.vue$/, '').replace(/(^|\/)index$/, '');
        const hasTitle = /useHead|useSeoMeta|definePageMeta\s*\(\s*\{[^}]*title/s.test(src) || /title\s*:/.test(cfgSrc);
        scan.routes.push({ route, file: p.rel, framework: 'nuxt', dynamic: /\[.+\]/.test(route), hasTitle, hasDescription: /description/.test(src), noindex: /noindex/.test(src) });
        if (!hasTitle) sink.emit('title.missing', { file: p.rel, observed: `route ${route}: no useHead/useSeoMeta title` });
      }
      break;
    }
    case 'laravel': {
      const layouts = find(appFiles, /resources\/views\/.*\.blade\.php$/).map((f) => f.rel).filter((f) => /<head\b/i.test(read(f)));
      scanLayouts(layouts, read, sink, scan, { titleRe: /<title\b/i, langRe: /\blang\s*=/ });
      const routes = appFiles.find((f) => f.rel === rel(appRoot, 'routes/web.php'));
      if (routes) {
        const src = read(routes.rel);
        for (const m of src.matchAll(/Route::(get|view|match|any)\s*\(\s*['"]([^'"]+)['"]/g)) {
          const r = m[2]!.startsWith('/') ? m[2]! : '/' + m[2]!;
          scan.routes.push({ route: r, file: routes.rel, framework: 'laravel', dynamic: /\{.+\}/.test(r), hasTitle: null, hasDescription: null, noindex: false });
        }
      }
      if (/spatie\/laravel-sitemap/.test(composerText)) scan.locations.hasSitemapGenerator = 'spatie/laravel-sitemap';
      break;
    }
    case 'wordpress-theme': {
      const themeRoot = appFiles.find((f) => /(^|\/)functions\.php$/.test(f.rel))?.rel.replace(/functions\.php$/, '') ?? '';
      const header = appFiles.find((f) => f.rel === `${themeRoot}header.php`);
      const fn = appFiles.find((f) => f.rel === `${themeRoot}functions.php`);
      const fnSrc = fn ? read(fn.rel) : '';
      const titleTag = /add_theme_support\s*\(\s*['"]title-tag['"]/.test(fnSrc);
      if (header) {
        const src = read(header.rel);
        scan.locations.rootLayout = header.rel;
        if (!titleTag && !/<title\b/i.test(src)) sink.emit('title.missing', { file: fn?.rel ?? header.rel, observed: "no add_theme_support('title-tag') and no <title> in header.php" });
        if (!/wp_head\s*\(/.test(src)) sink.emit('title.missing', { file: header.rel, observed: 'header.php does not call wp_head(); title-tag, SEO plugins and canonical output depend on it' });
        if (!/name=["']viewport["']/i.test(src)) sink.emit('mobile.viewport-missing', { file: header.rel, observed: 'no viewport meta in header.php' });
        const html = /<html\b[^>]*>/i.exec(src);
        if (html && !/language_attributes\s*\(|\blang\s*=/.test(html[0])) sink.emit('html.lang-missing', { file: header.rel, line: lineOf(src, html.index), observed: html[0] });
      }
      break;
    }
    case 'vite-spa':
    case 'cra-spa': {
      const index = [rel(appRoot, 'index.html'), rel(appRoot, 'public/index.html')].find((f) => appFiles.some((x) => x.rel === f));
      if (index) sink.emit('index.client-rendered', { file: index, observed: `${framework}: pages are rendered in the browser; crawlers that do not execute JavaScript see an empty shell` }, { confidence: 'verified' });
      break;
    }
    default:
      break;
  }

  // Static HTML (plain sites, or a committed build output) → reuse website analyzers.
  const SPA = framework === 'vite-spa' || framework === 'cra-spa';
  const staticKinds = framework === 'static-html' || framework === 'unknown' || framework === 'jekyll' || framework === 'hugo' || framework === 'eleventy';
  for (const d of ['', 'public/', 'dist/', 'out/', 'build/', '_site/', 'docs/'].map((x) => (appRoot === '.' ? x : `${appRoot}/${x}`))) {
    const isOutput = ['dist/', 'out/', 'build/', '_site/'].some((x) => d.endsWith(x));
    if (SPA || (!staticKinds && !isOutput)) continue;
    const html = appFiles
      .filter((f) => f.rel.startsWith(d) && /\.html?$/i.test(f.rel))
      // At the app root, skip output/vendor folders (they are scanned as their own candidates).
      .filter((f) => d !== (appRoot === '.' ? '' : `${appRoot}/`) || !OUTPUT_DIRS.test(f.rel.slice(d.length)))
      .filter((f) => !/(^|\/)(googl[a-z0-9]+|yandex_[a-z0-9]+|BingSiteAuth)\.html$/i.test(f.rel));
    if (!html.length) continue;
    let origin = PLACEHOLDER_ORIGIN;
    scan.originSource = 'placeholder';
    if (opts.siteUrl) {
      origin = new URL(opts.siteUrl).origin;
      scan.originSource = 'site-url';
    } else {
      const inferred = inferSiteOrigin(html.slice(0, 500).map((f) => read(f.rel)));
      if (inferred) {
        origin = inferred;
        scan.originSource = 'inferred';
      }
    }
    scan.staticSite = staticCrawl(html.map((f) => f.rel), d, read, scan, appFiles, origin);
    for (const f of html) scan.routes.push({ route: '/' + f.rel.slice(d.length).replace(/(^|\/)index\.html?$/i, '$1'), file: f.rel, framework: 'static-html', dynamic: false, hasTitle: null, hasDescription: null, noindex: false });
    break;
  }

  // Source pattern checks (HTML files already analysed by the static crawl are skipped to avoid double counting).
  const staticFiles = new Set(scan.urlToFile.values());
  scanSources(appFiles.filter((f) => !staticFiles.has(f.rel)), read, sink);

  // robots.txt / sitemap presence for framework apps (static sites are covered by the synthetic crawl).
  if (!scan.staticSite) {
    if (!scan.locations.hasSitemapGenerator && !scan.locations.sitemapFiles.length && framework !== 'wordpress-theme' && framework !== 'unknown') {
      sink.emit('robots.no-sitemap', { file: publicDir ?? appRoot, observed: 'no sitemap file or generator found in the repository' });
    }
    if (scan.locations.robotsFile) {
      const robots = parseRobots('https://site.invalid/robots.txt', read(scan.locations.robotsFile), 200);
      for (const bot of ['Googlebot', 'Bingbot']) if (!robots.isAllowed('https://site.invalid/', bot)) sink.emit('robots.disallow-all', { file: scan.locations.robotsFile, observed: `${bot} disallowed for /` });
      if (/^\s*crawl-delay\s*:/im.test(robots.raw)) sink.emit('robots.crawl-delay-ignored', { file: scan.locations.robotsFile });
      // noindex + robots block on the same route can be checked statically.
      for (const r of scan.routes) if (r.noindex && !r.dynamic && !robots.isAllowed('https://site.invalid' + r.route, 'Googlebot')) sink.emit('index.noindex-blocked', { file: r.file, observed: `route ${r.route} is noindex and disallowed in ${scan.locations.robotsFile}` });
    }
  }
  return scan;
}

export function scanRepository(root: string, sink: FindingSink, opts: { siteUrl?: string } = {}): RepoScan {
  const detection = detect(root);
  const { files, skipped } = walk(root, { include: (r) => SOURCE_EXT.test(r) || /(^|\/)(robots\.txt|sitemap[^/]*\.xml|package\.json|composer\.json|astro\.config\.\w+|nuxt\.config\.\w+|next\.config\.\w+)$/.test(r) });
  const cache = new Map<string, string>();
  const read = (f: string) => {
    let t = cache.get(f);
    if (t === undefined) cache.set(f, (t = readText(root, f)));
    return t;
  };
  const candidates = detection.candidates.length ? detection.candidates : [{ framework: 'unknown' as Framework, root: '.', evidence: 'no framework detected' }];
  // De-duplicate (an app can match twice, e.g. WordPress style.css + wp-content).
  const seen = new Set<string>();
  const apps: AppScan[] = [];
  for (const c of candidates) {
    if (seen.has(c.root)) continue;
    seen.add(c.root);
    apps.push(scanApp(root, c.root, c.framework, files, read, sink, opts));
  }
  return { root, detection, apps, files, skipped, routes: apps.flatMap((a) => a.routes) };
}
