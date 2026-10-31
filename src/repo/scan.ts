import path from 'node:path';
import type { CrawlResult, PageRecord } from '../crawl/crawler.js';
import { parseRobots, type RobotsInfo } from '../crawl/robots.js';
import { parseSitemapXml } from '../crawl/sitemap.js';
import { normalizeUrl } from '../core/url.js';
import { extractPage } from '../extract/html.js';
import type { FindingSink } from '../rules/engine.js';
import { detect, type Detection, type Framework } from './detect.js';
import { lineOf, readText, walk, type WalkedFile } from './fs-safe.js';
import { attrString, isJsSource, jsxAnchorsWithoutHref, jsxImagesWithoutAlt, jsxTags, nextMetadata, parseSource, type NextMetadata } from './ast.js';

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

/**
 * Template expressions (Blade `{{ }}` / `{!! !!}`, PHP `<?php ?>` / `<?= ?>`, Vue/Jinja `{{ }}`) blanked out
 * with spaces of the same length: their `=>`, `->` and `?>` would otherwise end a tag early, hiding the
 * attributes after them. Offsets and line numbers stay unchanged.
 */
export function blankTemplateExpressions(text: string): string {
  return text.replace(/\{!!.*?!!\}|\{\{.*?\}\}|<\?(?:php|=)[\s\S]*?\?>/gs, (m) => m.replace(/[^\n]/g, ' '));
}

/** JSX/HTML <img> without alt (case-sensitive `<img`/`<Image` tags), with line numbers. */
export function imgWithoutAlt(source: string): number[] {
  const text = blankTemplateExpressions(source);
  const lines: number[] = [];
  const re = /<(img|Image)\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!/\balt\s*=/.test(m[2]!) && !/\{\s*\.\.\.\w+\s*\}/.test(m[2]!)) lines.push(lineOf(text, m.index));
  }
  return lines;
}

/** <a> elements without href (non-crawlable links) and javascript: hrefs. */
export function anchorsWithoutHref(source: string): number[] {
  const text = blankTemplateExpressions(source);
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

const META_EXPORT = /export\s+(const\s+metadata|(async\s+)?function\s+generateMetadata)/;

/** Metadata of a Next.js page/layout: AST when the file parses, the older regex heuristics otherwise. */
function metadataOf(src: string, file: string): NextMetadata {
  const ast = parseSource(src, file);
  if (ast) return nextMetadata(ast);
  const exported = META_EXPORT.test(src);
  return {
    exported,
    title: exported && hasKey(src, 'title'),
    description: exported && hasKey(src, 'description'),
    canonical: /alternates\s*:\s*\{[^}]*canonical/s.test(src),
    noindex: /robots\s*:\s*\{[^}]*index\s*:\s*false/s.test(src) || /robots\s*:\s*['"][^'"]*noindex/.test(src),
  };
}

/** Tri-state OR: true if any is true, null if none is true but one is unknown, else false. */
const anyOf = (...xs: Array<boolean | null>): boolean | null => (xs.includes(true) ? true : xs.includes(null) ? null : false);

/** Scan Next.js (app router) sources. */
function scanNextApp(appRoot: string, files: WalkedFile[], read: (f: string) => string, sink: FindingSink, scan: AppScan): void {
  const appBase = files.some((f) => f.rel.startsWith(rel(appRoot, 'src/app/'))) ? rel(appRoot, 'src/app/') : rel(appRoot, 'app/');
  const baseRe = new RegExp('^' + appBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pages = files.filter((f) => f.rel.startsWith(appBase) && /\/page\.(tsx|jsx|ts|js|mdx)$|^page\./.test(f.rel.slice(appBase.length - 1)) && !/\/(@[^/]+|\(\.+\)[^/]*)\//.test(f.rel));
  const layouts = new Map<string, NextMetadata>();
  for (const f of files.filter((f) => f.rel.startsWith(appBase) && /(^|\/)layout\.(tsx|jsx|ts|js)$/.test(f.rel))) layouts.set(path.posix.dirname(f.rel), metadataOf(read(f.rel), f.rel));
  const rootLayoutPath = files.find((f) => new RegExp('^' + appBase + 'layout\\.(tsx|jsx|ts|js)$').test(f.rel))?.rel ?? null;
  scan.locations.rootLayout = rootLayoutPath;
  scan.locations.layouts = [...layouts.keys()];
  const titleOwners: Record<string, string[]> = {};
  for (const p of pages) {
    const src = read(p.rel);
    const chain: NextMetadata[] = [];
    let dir = path.posix.dirname(p.rel);
    while (dir.length >= appBase.length - 1) {
      const l = layouts.get(dir);
      if (l) chain.push(l);
      if (dir + '/' === appBase) break;
      dir = path.posix.dirname(dir);
    }
    const meta = metadataOf(src, p.rel);
    const pageTitle = meta.exported ? meta.title : false;
    const pageDesc = meta.exported ? meta.description : false;
    const hasTitle = anyOf(pageTitle, ...chain.map((l) => (l.exported ? l.title : false)));
    const hasDesc = anyOf(pageDesc, ...chain.map((l) => (l.exported ? l.description : false)));
    const canonical = anyOf(meta.canonical, ...chain.map((l) => l.canonical));
    const noindex = meta.noindex === true;
    const route = nextRoute(p.rel, baseRe);
    scan.routes.push({ route, file: p.rel, framework: 'nextjs-app', dynamic: /\[.+\]/.test(route), hasTitle, hasDescription: hasDesc, noindex });
    // `null` = computed at runtime (spread, variable, call): not reported either way.
    if (hasTitle === false) sink.emit('title.missing', { file: p.rel, observed: `route ${route}: no metadata.title in page or ancestor layouts` });
    else if (pageTitle === false && hasTitle === true && !noindex) (titleOwners['inherited'] ??= []).push(`${route} (${p.rel})`);
    if (hasDesc === false && !noindex) sink.emit('description.missing', { file: p.rel, line: meta.line, observed: `route ${route}: no metadata.description` });
    if (canonical === false && !noindex) sink.emit('canonical.missing', { file: p.rel, line: meta.line, observed: `route ${route}: no metadata.alternates.canonical` });
    if (noindex) sink.emit('index.noindex', { file: p.rel, observed: `route ${route}: robots index:false` });
  }
  const inherited = titleOwners['inherited'] ?? [];
  if (inherited.length > 1) sink.emit('duplicate.title', { file: rootLayoutPath ?? undefined, observed: `${inherited.length} routes inherit the same layout title (unless title.template is combined with page titles): ${inherited.slice(0, 5).join(', ')}` });
  if (rootLayoutPath) {
    htmlLangCheck(read(rootLayoutPath), rootLayoutPath, 'html', sink);
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
  const appHead = appFile ? pagesHead(appSrc, appFile.rel) : { title: false, description: false, noindex: false };
  const globalTitle = appHead.title;
  const globalDesc = appHead.description;
  scan.locations.rootLayout = docFile?.rel ?? appFile?.rel ?? null;
  for (const p of pages) {
    const src = read(p.rel);
    const route = '/' + p.rel.slice(base.length).replace(/\.(tsx|jsx|ts|js|mdx)$/, '').replace(/(^|\/)index$/, '');
    const head = pagesHead(src, p.rel);
    const hasTitle = head.title;
    const hasDesc = head.description;
    scan.routes.push({ route, file: p.rel, framework: 'nextjs-pages', dynamic: /\[.+\]/.test(route), hasTitle: hasTitle || globalTitle, hasDescription: hasDesc || globalDesc, noindex: head.noindex });
    if (!hasTitle && !globalTitle) sink.emit('title.missing', { file: p.rel, observed: `route ${route}: no <title> in next/head` });
    if (!hasTitle && globalTitle) sink.emit('duplicate.title', { file: p.rel, observed: `route ${route} only gets the global title from ${appFile?.rel}` });
    if (!hasDesc && !globalDesc) sink.emit('description.missing', { file: p.rel, observed: `route ${route}` });
  }
  if (docFile) htmlLangCheck(read(docFile.rel), docFile.rel, 'Html', sink);
}

/** `<html>` (app router layout) / `<Html>` (pages router _document) without lang. */
function htmlLangCheck(src: string, file: string, tag: 'html' | 'Html', sink: FindingSink): void {
  const ast = parseSource(src, file);
  if (ast) {
    for (const t of jsxTags(ast, new Set([tag]))) if (!t.spread && !t.attrs.has('lang')) sink.emit('html.lang-missing', { file, line: t.line, observed: `<${tag}> without lang` });
    return;
  }
  const m = new RegExp(`<${tag}\\b[^>]*>`).exec(src);
  if (m && !/\blang\s*=/.test(m[0])) sink.emit('html.lang-missing', { file, line: lineOf(src, m.index), observed: m[0] });
}

const SEO_COMPONENTS = new Set(['NextSeo', 'DefaultSeo', 'Seo', 'SEO']);

/** Pages-router head signals from JSX: <title>, <meta name="description">, SEO components, noindex. */
function pagesHead(src: string, file: string): { title: boolean; description: boolean; noindex: boolean } {
  const ast = parseSource(src, file);
  if (!ast) {
    return {
      title: /<title[\s>]/.test(src) || /NextSeo|DefaultSeo|<Seo\b|<SEO\b/.test(src),
      description: /name=["']description["']/.test(src) || /NextSeo|<Seo\b|<SEO\b/.test(src),
      noindex: /noindex/.test(src),
    };
  }
  const tags = jsxTags(ast, new Set(['title', 'meta', ...SEO_COMPONENTS]));
  const seo = tags.filter((t) => SEO_COMPONENTS.has(t.name));
  const metaName = (t: (typeof tags)[number]) => attrString(t.attrs.get('name'))?.toLowerCase();
  return {
    title: tags.some((t) => t.name === 'title') || seo.some((t) => t.spread || t.attrs.has('title') || t.attrs.has('titleTemplate') || t.attrs.has('defaultTitle')),
    description: tags.some((t) => t.name === 'meta' && (t.spread || metaName(t) === 'description')) || seo.some((t) => t.spread || t.attrs.has('description')),
    noindex: tags.some((t) => t.name === 'meta' && metaName(t) === 'robots' && /noindex/i.test(attrString(t.attrs.get('content')) ?? '')) || seo.some((t) => t.attrs.has('noindex') && attrString(t.attrs.get('noindex')) !== 'false'),
  };
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
    if (NON_SITE_DIRS.test(f.rel)) continue;
    if (ADMIN_VIEWS.test(f.rel)) continue;
    const src = read(f.rel);
    const ast = isJsSource(f.rel) ? parseSource(src, f.rel) : null;
    const noAlt = ast ? jsxImagesWithoutAlt(ast) : imgWithoutAlt(src);
    if (noAlt.length) sink.emit('img.alt-missing', noAlt.slice(0, 5).map((line) => ({ file: f.rel, line, observed: 'image without alt attribute' })));
    const noHref = ast ? jsxAnchorsWithoutHref(ast) : anchorsWithoutHref(src);
    if (noHref.length) sink.emit('links.uncrawlable', noHref.slice(0, 5).map((line) => ({ file: f.rel, line, observed: '<a> without crawlable href' })));
  }
}

/** Build a synthetic crawl from static HTML files so the website analyzers can be reused. */
function staticCrawl(htmlFiles: string[], dirBase: string, read: (f: string) => string, scan: AppScan, files: WalkedFile[], siteOrigin: string): CrawlResult {
  const pages: PageRecord[] = [];
  const sitemapFiles = files.filter((f) => f.rel.startsWith(dirBase) && /sitemap[^/]*\.xml$/i.test(f.rel)).map((f) => f.rel);
  const smUrls = sitemapFiles.flatMap((s) => parseSitemapXml(read(s), s).urls);
  const smSet = new Set(smUrls.map((u) => normalizeUrl(u.loc)).filter((u): u is string => !!u));
  for (const f of htmlFiles) {
    let urlPath = '/' + f.slice(dirBase.length).replace(/^\/+/, '');
    urlPath = urlPath.replace(/(^|\/)index\.html?$/i, '$1');
    const html = read(f);
    // Clean URLs: hosts such as Cloudflare Pages, Netlify or Vercel serve about.html at /about. Use that URL
    // when the page's canonical or the sitemap does, so canonical and sitemap checks compare like with like.
    const clean = urlPath.replace(/\.html?$/i, '');
    if (clean !== urlPath) {
      const cleanUrl = normalizeUrl(new URL(clean, siteOrigin).toString());
      const canonical = /<link\b[^>]*rel=["']?canonical["']?[^>]*href=["']([^"']+)["']/i.exec(html)?.[1] ?? /<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["']?canonical["']?/i.exec(html)?.[1];
      if (cleanUrl && (smSet.has(cleanUrl) || (canonical && normalizeUrl(canonical, siteOrigin) === cleanUrl))) urlPath = clean;
    }
    const url = new URL(urlPath, siteOrigin).toString();
    scan.urlToFile.set(url, f);
    pages.push({
      // Hosts serve 404.html & co. with an error status, so page-level SEO checks do not apply to them.
      url, finalUrl: url, status: errorPageStatus(urlPath) ?? 200, depth: urlPath.split('/').filter(Boolean).length, redirects: [], contentType: 'text/html', timingMs: 0,
      bytes: Buffer.byteLength(html), truncated: false, headers: { 'content-encoding': 'n/a (repository)' }, xRobots: [], xRobotsByBot: {},
      blockedByRobots: false, inSitemap: false, data: extractPage(html, url),
    });
  }
  const robotsRel = [`${dirBase}robots.txt`, 'public/robots.txt', 'robots.txt'].find((r) => files.some((f) => f.rel === r));
  const robots: RobotsInfo = robotsRel ? parseRobots(new URL('/robots.txt', siteOrigin).toString(), read(robotsRel), 200) : { ...parseRobots(new URL('/robots.txt', siteOrigin).toString(), '', 404), state: 'missing' };
  const byNorm = new Set<string>();
  for (const p of pages) {
    const n = normalizeUrl(p.url);
    if (n) byNorm.add(n);
    p.inSitemap = !!n && smSet.has(n);
  }
  // Sitemap URLs of this site that no file in the repository serves (a removed page, a typo, a route that
  // exists only as a server rewrite): recorded as missing so the sitemap checks see them.
  for (const loc of smSet) {
    if (byNorm.has(loc) || !loc.startsWith(siteOrigin)) continue;
    const urlPath = new URL(loc).pathname;
    pages.push({
      url: loc, finalUrl: loc, status: 404, depth: urlPath.split('/').filter(Boolean).length, redirects: [], contentType: '', timingMs: 0,
      bytes: 0, truncated: false, headers: {}, xRobots: [], xRobotsByBot: {}, blockedByRobots: false, inSitemap: true, foundOn: 'sitemap',
      error: MISSING_IN_REPO,
    });
  }
  return {
    runId: 'repository', startUrl: new URL('/', siteOrigin).toString(), origin: siteOrigin, robots,
    sitemap: { sitemaps: sitemapFiles, urls: smUrls, issues: [] }, pages, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    stats: { crawled: pages.length, queuedRemaining: 0, blocked: 0, errors: 0, durationMs: 0, avgResponseMs: 0 }, truncated: false,
  };
}

/** `error` of synthetic records for URLs that no file in the repository serves. */
export const MISSING_IN_REPO = 'no file in the repository serves this URL';

/** True when a framework route pattern (`/blog/{slug}`, `/blog/[slug]`, `/docs/[...path]`) matches `urlPath`. */
export function routeMatches(route: string, urlPath: string): boolean {
  const norm = (s: string) => (s.replace(/\/+$/, '') || '/').toLowerCase();
  const re = norm(route)
    .split('/')
    .map((seg) => (/^\[\[?\.\.\.[^\]]+\]\]?$/.test(seg) ? '.+' : /^\{[^}]+\}$|^\[[^\]]+\]$|^:[\w]+$/.test(seg) ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${re}$`).test(norm(urlPath));
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

/**
 * Folders whose files are not part of the website: tests, fixtures, benchmarks, examples, evaluation
 * output. Auditing a repository whose only HTML lives there (a CLI tool,
 * a library) must not report those files as the site. Pointing Searvex at such a folder directly still
 * audits it (paths are relative to the audited root).
 */
export const NON_SITE_DIRS = /(^|\/)(tests?|__tests__|specs?|e2e|cypress|playwright|fixtures?|__fixtures__|testdata|bench|benchmarks?|examples?|samples?|evals?|snapshots?|__snapshots__|stories|storybook-static|coverage)\//i;

/** Server-side template folders: their .html files are partials rendered by a framework, not pages. */
const TEMPLATE_DIRS = /(^|\/)(templates|layouts|_layouts|_includes|includes|partials)\//i;

/** Admin panels of server frameworks: always behind a login, never indexed. */
const ADMIN_VIEWS = /(^|\/)resources\/views\/(vendor\/)?filament\//;

/** A file is an HTML page (not a fragment or snippet) when it has a document element or doctype. */
const isHtmlDocument = (src: string) => /<!doctype\s+html|<html[\s>]/i.test(src);

/** HTTP status a static host serves for a conventional error page (404.html, Next.js _not-found, 500.html). */
export function errorPageStatus(urlPath: string): number | null {
  if (/(^|\/)(404|_not-found)(\.html?|\/)?$/i.test(urlPath)) return 404;
  if (/(^|\/)(500|50x)(\.html?|\/)?$/i.test(urlPath)) return 500;
  return null;
}

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
        // Props spread into a layout (<Layout {...post.data}>) usually carry the title: unknown, not missing.
        const spread = /<[A-Z]\w*\s+[^>]*\{\s*\.\.\.[^}]+\}/.test(src);
        const hasTitle = /<title\b/i.test(src) || /\btitle\s*=\s*[{"']/.test(src) || /^---[\s\S]*?\ntitle\s*:/m.test(src) ? true : spread ? null : false;
        scan.routes.push({ route, file: p.rel, framework: 'astro', dynamic: /\[.+\]/.test(route), hasTitle, hasDescription: /description\s*[=:]/.test(src), noindex: /noindex/.test(src) });
        if (hasTitle === false) sink.emit('title.missing', { file: p.rel, observed: `route ${route}: no title passed to layout and no <title>` });
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
      const layouts = find(appFiles, /resources\/views\/.*\.blade\.php$/).map((f) => f.rel).filter((f) => !ADMIN_VIEWS.test(f) && /<head\b/i.test(read(f)));
      scanLayouts(layouts, read, sink, scan, { titleRe: /<title\b/i, langRe: /\blang\s*=/ });
      // Page routes live in routes/web.php and in any extra route file the app registers (routes/public.php,
      // routes/marketing.php …); api, console and broadcast channel routes are not pages.
      const routeFiles = appFiles.filter((f) => f.rel.startsWith(rel(appRoot, 'routes') + '/') && /\.php$/.test(f.rel) && !/\/(api|console|channels)\.php$/.test(f.rel));
      for (const routes of routeFiles) {
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
      .filter((f) => !/(^|\/)(googl[a-z0-9]+|yandex_[a-z0-9]+|BingSiteAuth)\.html$/i.test(f.rel))
      .filter((f) => !NON_SITE_DIRS.test(f.rel.slice(d.length)) && !TEMPLATE_DIRS.test(f.rel.slice(d.length)) && isHtmlDocument(read(f.rel)));
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
