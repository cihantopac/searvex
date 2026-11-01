import path from 'node:path';
import type { AuditReport } from '../analyze/audit.js';
import { readText } from '../repo/fs-safe.js';
import type { AppScan, RepoScan } from '../repo/scan.js';

/**
 * Deterministic, framework-aware fix planners.
 *
 * A planner only proposes a change when the correct value is unambiguous (e.g. adding a viewport
 * meta tag, using the framework's own locale idiom, making a canonical absolute with a known site
 * URL). Anything requiring judgement — titles, descriptions, alt text, content — becomes an
 * AgentTask with file/line evidence for a human or an AI agent to draft and get approved.
 */
/**
 * Rules the planner can fix automatically (in at least one framework/context). Must match the
 * `autofix` flags in the knowledge base — enforced by test/unit/rules.test.ts.
 */
export const AUTOFIX_RULES = new Set([
  'html.lang-missing', 'mobile.viewport-missing', 'canonical.relative', 'canonical.missing', 'canonical.multiple',
  'sd.missing-context', 'hreflang.invalid-code', 'title.missing', 'robots.no-sitemap',
  'title.multiple', 'description.multiple', 'hreflang.relative',
]);

export interface FileChange {
  path: string;
  action: 'modify' | 'create';
  before: string | null;
  after: string;
}

export interface Fix {
  id: string;
  ruleId: string;
  title: string;
  rationale: string;
  changes: FileChange[];
}

export interface AgentTask {
  ruleId: string;
  title: string;
  instruction: string;
  locations: Array<{ file?: string; line?: number; url?: string; observed?: string }>;
}

export interface FixPlan {
  fixes: Fix[];
  /** Final state per file after all fixes (for the combined patch and the transaction). */
  files: FileChange[];
  tasks: AgentTask[];
  skipped: Array<{ ruleId: string; reason: string }>;
}

export interface PlanOptions {
  siteUrl?: string;
  lang?: string;
  only?: string[];
}

const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">';

function indentOf(src: string, index: number): string {
  const lineStart = src.lastIndexOf('\n', index - 1) + 1;
  return /^[\t ]*/.exec(src.slice(lineStart))![0];
}

/** Insert a line right after the opening <head> tag (or after <meta charset>), matching indentation. */
export function insertInHead(src: string, line: string): string | null {
  const charset = /<meta\s+charset=[^>]*>/i.exec(src);
  const head = /<head\b[^>]*>/i.exec(src);
  const anchor = charset ?? head;
  if (!anchor) return null;
  const at = anchor.index + anchor[0].length;
  const childIndent = charset ? indentOf(src, charset.index) : indentOf(src, head!.index) + '  ';
  return src.slice(0, at) + '\n' + childIndent + line + src.slice(at);
}

const HREFLANG_FIXES: Record<string, string> = { 'en-uk': 'en-GB', uk: 'uk', jp: 'ja', 'ja-jp': 'ja-JP', cn: 'zh', 'zh-cn': 'zh-CN', gr: 'el', cz: 'cs', dk: 'da', se: 'sv', kr: 'ko', 'pt-br': 'pt-BR' };

export function planFixes(report: AuditReport, scan: RepoScan, opts: PlanOptions = {}): FixPlan {
  const root = scan.root;
  const plan: FixPlan = { fixes: [], files: [], tasks: [], skipped: [] };
  const wanted = (ruleId: string) => !opts.only?.length || opts.only.includes(ruleId);
  const pending = new Map<string, FileChange>();
  const read = (f: string) => pending.get(f)?.after ?? readText(root, f);
  const original = (f: string) => {
    try {
      return readText(root, f);
    } catch {
      return null;
    }
  };
  const stage = (ruleId: string, title: string, rationale: string, file: string, after0: string, action: 'modify' | 'create' = 'modify') => {
    const prev = pending.get(file);
    // `before` of the merged change is the original file; each fix records its own step diff.
    const original0 = prev ? prev.before : action === 'create' ? null : original(file);
    // Inserted lines follow the file's own line endings (Windows checkouts often use CRLF).
    const after = original0 !== null && usesCrlf(original0) ? after0.replace(/\r?\n/g, '\r\n') : after0;
    const stepBefore = prev ? prev.after : original0;
    if (stepBefore === after) return;
    pending.set(file, { path: file, action: original0 === null ? 'create' : 'modify', before: original0, after });
    plan.fixes.push({ id: `fix-${plan.fixes.length + 1}`, ruleId, title, rationale, changes: [{ path: file, action: stepBefore === null ? 'create' : 'modify', before: stepBefore, after }] });
  };
  const byRule = new Map(report.findings.map((f) => [f.ruleId, f]));
  // Framework of the app that owns a file (monorepos mix frameworks).
  const appOf = (file?: string): AppScan | undefined => [...scan.apps].sort((a, b) => b.appRoot.length - a.appRoot.length).find((a) => a.appRoot === '.' || (file ?? '').startsWith(a.appRoot + '/'));
  const fwOf = (file?: string) => appOf(file)?.framework ?? 'unknown';

  // ---- html lang ----
  const lang = byRule.get('html.lang-missing');
  if (lang && wanted('html.lang-missing')) {
    for (const e of lang.evidence) {
      if (!e.file || !/\.(php|html?|tsx|jsx|astro|vue)$/.test(e.file)) continue;
      const src = read(e.file);
      const fw = fwOf(e.file);
      let idiom: string | null = null;
      if (fw === 'laravel' && e.file.endsWith('.blade.php')) idiom = `lang="{{ str_replace('_', '-', app()->getLocale()) }}"`;
      else if (fw === 'wordpress-theme' && e.file.endsWith('.php')) idiom = '<?php language_attributes(); ?>';
      else if (opts.lang) idiom = `lang="${opts.lang}"`;
      if (!idiom) {
        plan.skipped.push({ ruleId: 'html.lang-missing', reason: `${e.file}: language unknown — pass --lang <code>` });
        continue;
      }
      const tag = fw === 'nextjs-pages' ? /<Html\b(?![^>]*\blang=)/ : /<html\b(?![^>]*\b(lang=|language_attributes))/i;
      const m = tag.exec(src);
      if (!m) continue;
      const after = src.slice(0, m.index + m[0].length) + ' ' + idiom + src.slice(m.index + m[0].length);
      stage('html.lang-missing', 'Declare the document language', fw === 'laravel' ? 'Uses the Laravel app locale (Laravel starter-kit idiom).' : fw === 'wordpress-theme' ? 'Uses language_attributes(), the WordPress core idiom.' : `Sets lang="${opts.lang}" as provided.`, e.file, after);
    }
  }

  // ---- viewport ----
  const vp = byRule.get('mobile.viewport-missing');
  if (vp && wanted('mobile.viewport-missing')) {
    for (const e of vp.evidence) {
      if (!e.file || !/\.(php|html?|astro|hbs|njk|liquid|twig)$/.test(e.file)) continue;
      const after = insertInHead(read(e.file), VIEWPORT);
      if (after) stage('mobile.viewport-missing', 'Add responsive viewport meta tag', 'Standard responsive viewport; required for mobile-friendly rendering.', e.file, after);
      else plan.skipped.push({ ruleId: 'mobile.viewport-missing', reason: `${e.file}: no <head> found` });
    }
  }

  // ---- canonical (static HTML only: framework canonicals are code-level decisions) ----
  for (const ruleId of ['canonical.relative', 'canonical.missing', 'canonical.multiple'] as const) {
    const f = byRule.get(ruleId);
    if (!f || !wanted(ruleId)) continue;
    for (const e of f.evidence) {
      if (!e.file || !/\.html?$/.test(e.file)) {
        if (ruleId === 'canonical.missing' && e.file) plan.tasks.push({ ruleId, title: 'Add canonical URL', instruction: frameworkCanonicalHint(fwOf(e.file)), locations: [{ file: e.file, observed: e.observed }] });
        continue;
      }
      const src = read(e.file);
      if (ruleId === 'canonical.multiple') {
        const all = [...src.matchAll(/^[ \t]*<link\b[^>]*rel=["']?canonical["']?[^>]*>[ \t]*\r?\n?/gim)];
        const hrefs = new Set(all.map((m) => /href=["']([^"']+)/i.exec(m[0])?.[1]));
        if (hrefs.size !== 1) {
          plan.tasks.push({ ruleId, title: 'Resolve conflicting canonicals', instruction: 'Multiple canonical links point to different URLs; keep the one for the preferred URL and remove the others (check templates/plugins injecting a second one).', locations: [{ file: e.file, observed: [...hrefs].join(' vs ') }] });
          continue;
        }
        let after = src;
        for (const m of all.slice(1).reverse()) after = after.slice(0, m.index!) + after.slice(m.index! + m[0].length);
        stage(ruleId, 'Remove duplicate identical canonical links', 'Duplicates had the same href; keeping exactly one.', e.file, after);
        continue;
      }
      if (!opts.siteUrl) {
        plan.skipped.push({ ruleId, reason: `${e.file}: site URL unknown — pass --site-url https://example.com` });
        continue;
      }
      const url = urlForFile(e.file, scan, opts.siteUrl);
      if (!url) continue;
      if (ruleId === 'canonical.relative') {
        const after = src.replace(/(<link\b[^>]*rel=["']?canonical["']?[^>]*href=["'])([^"']+)(["'])/i, (_, a: string, href: string, c: string) => a + new URL(href, url).toString() + c);
        stage(ruleId, 'Make canonical URL absolute', `Resolved against ${url}.`, e.file, after);
      } else {
        const after = insertInHead(src, `<link rel="canonical" href="${url}">`);
        if (after) stage(ruleId, 'Add self-referencing canonical', `Canonical for ${url} derived from file path and --site-url.`, e.file, after);
      }
    }
  }

  // ---- JSON-LD @context ----
  const ctx = byRule.get('sd.missing-context');
  if (ctx && wanted('sd.missing-context')) {
    for (const e of ctx.evidence) {
      if (!e.file || !/\.html?$/.test(e.file)) continue;
      const src = read(e.file);
      const after = src.replace(/(<script[^>]*application\/ld\+json[^>]*>\s*\{)(?![\s\S]*?"@context")/i, '$1"@context":"https://schema.org",');
      if (after !== src) stage('sd.missing-context', 'Add schema.org @context to JSON-LD', 'JSON-LD needs @context to resolve types.', e.file, after);
    }
  }

  // ---- duplicate <title> / meta description in static HTML: remove extras only when they are identical ----
  const DUP = {
    'title.multiple': { re: /^[ \t]*<title\b[^>]*>[\s\S]*?<\/title>[ \t]*\r?\n?/gim, value: (m: string) => m.replace(/<\/?title\b[^>]*>/gi, ''), what: '<title>' },
    'description.multiple': { re: /^[ \t]*<meta\b(?=[^>]*\bname=["']?description["'\s>])[^>]*>[ \t]*\r?\n?/gim, value: (m: string) => /content=(["'])([\s\S]*?)\1/i.exec(m)?.[2] ?? '', what: 'meta description' },
  } as const;
  for (const ruleId of ['title.multiple', 'description.multiple'] as const) {
    const f = byRule.get(ruleId);
    if (!f || !wanted(ruleId)) continue;
    const { re, value, what } = DUP[ruleId];
    for (const e of f.evidence) {
      if (!e.file) continue;
      const conflict = (observed?: string) => plan.tasks.push({ ruleId, title: `Keep exactly one ${what}`, instruction: `Keep one ${what} per page. Usually a layout and a page-level head component (Inertia <Head>, next/head, react-helmet, an SEO plugin) both emit one: remove the layout copy or let the head manager replace it (Inertia: add the \`inertia\` attribute to the template tag).`, locations: [{ file: e.file, line: e.line, url: e.url, observed: observed ?? e.observed }] });
      if (!/\.html?$/.test(e.file)) {
        conflict();
        continue;
      }
      const src = read(e.file);
      // Only elements inside <head>: an inline SVG <title> in the body is not a document title.
      const headEnd = src.search(/<\/head\s*>/i);
      const all = [...src.matchAll(re)].filter((m) => headEnd < 0 || m.index! < headEnd);
      const norm = (x: string) => x.replace(/\s+/g, ' ').trim();
      const values = new Set(all.map((m) => norm(value(m[0]))));
      if (all.length < 2 || values.size !== 1) {
        conflict(all.length >= 2 ? [...values].map((x) => `"${x.slice(0, 80)}"`).join(' vs ') : undefined);
        continue;
      }
      let after = src;
      for (const m of all.slice(1).reverse()) after = after.slice(0, m.index!) + after.slice(m.index! + m[0].length);
      stage(ruleId, `Remove duplicate identical ${what}`, `All ${all.length} copies were identical; keeping the first one.`, e.file, after);
    }
  }

  // ---- relative hreflang URLs in static HTML (resolved against the page's own URL) ----
  const hrel = byRule.get('hreflang.relative');
  if (hrel && wanted('hreflang.relative')) {
    for (const e of hrel.evidence) {
      if (!e.file || !/\.html?$/.test(e.file)) continue;
      if (!opts.siteUrl) {
        plan.skipped.push({ ruleId: 'hreflang.relative', reason: `${e.file}: site URL unknown — pass --site-url https://example.com` });
        continue;
      }
      const pageUrl = urlForFile(e.file, scan, opts.siteUrl);
      if (!pageUrl) continue;
      const src = read(e.file);
      const after = src.replace(/<link\b[^>]*\bhreflang=[^>]*>/gi, (tag) =>
        tag.replace(/(\bhref=)(["'])([^"']*)\2/i, (m, a: string, q: string, href: string) => (/^[a-z][a-z0-9+.-]*:/i.test(href) || !href ? m : a + q + new URL(href, pageUrl).toString() + q)),
      );
      if (after !== src) stage('hreflang.relative', 'Make hreflang URLs absolute', `Resolved against ${pageUrl}.`, e.file, after);
    }
  }

  // ---- hreflang codes ----
  const hl = byRule.get('hreflang.invalid-code');
  if (hl && wanted('hreflang.invalid-code')) {
    for (const e of hl.evidence) {
      if (!e.file || !e.observed) continue;
      const fixd = HREFLANG_FIXES[e.observed.toLowerCase()];
      if (!fixd) {
        plan.skipped.push({ ruleId: 'hreflang.invalid-code', reason: `${e.file}: no safe mapping for "${e.observed}"` });
        continue;
      }
      const src = read(e.file);
      const after = src.replace(new RegExp(`hreflang=(["'])${e.observed.replace(/[-]/g, '\\-')}\\1`, 'gi'), `hreflang="${fixd}"`);
      stage('hreflang.invalid-code', `Correct hreflang "${e.observed}" → "${fixd}"`, 'ISO 639-1 language / ISO 3166-1 region codes.', e.file, after);
    }
  }

  // ---- WordPress title-tag ----
  const wpTitle = byRule.get('title.missing')?.evidence.find((e) => e.file?.endsWith('functions.php') && fwOf(e.file) === 'wordpress-theme');
  if (wpTitle?.file && wanted('title.missing')) {
    const src = read(wpTitle.file);
    const snippet = "\n\n// Let WordPress manage the document title (added by Searvex).\nadd_action( 'after_setup_theme', function () {\n\tadd_theme_support( 'title-tag' );\n} );\n";
    stage('title.missing', "Enable add_theme_support('title-tag')", 'WordPress core generates <title> via wp_head() when title-tag support is declared.', wpTitle.file, src.replace(/\s*(\?>\s*)?$/, '') + snippet);
  }

  // ---- robots.txt Sitemap directive / sitemap generation ----
  const noSitemap = byRule.get('robots.no-sitemap');
  if (noSitemap && wanted('robots.no-sitemap')) {
    // Only the apps the finding is about, and never one that already ships a sitemap (monorepos mix apps).
    const owners = new Set(noSitemap.evidence.map((e) => (e.file ? appOf(e.file) : scan.apps.length === 1 ? scan.apps[0] : undefined)));
    for (const app of scan.apps) {
      if (!owners.has(app) || app.locations.sitemapFiles.length || app.locations.hasSitemapGenerator) continue;
      // One --site-url cannot tell which host serves which app (an API on a subdomain, a proxy splitting paths):
      // a generated sitemap could list the wrong host or collide with another app's sitemap. Judgement task instead.
      if (scan.apps.length > 1) {
        plan.tasks.push({ ruleId: 'robots.no-sitemap', title: `Add a sitemap for ${app.appRoot}`, instruction: `This repository has ${scan.apps.length} apps (${scan.apps.map((a) => a.appRoot).join(', ')}). Check which host and paths "${app.appRoot}" serves publicly (proxy/deploy config) and whether those URLs belong in another app's sitemap. If it serves indexable public pages on its own host, run "searvex optimize ${app.appRoot} --site-url <that host>" or add a sitemap generator; routes behind login do not belong in a sitemap.`, locations: [{ file: app.locations.publicDir ?? app.appRoot }] });
        continue;
      }
      planSitemap(app, opts, plan, stage, read, report);
    }
  }

  // ---- tasks needing judgement ----
  const TASKS: Record<string, string> = {
    'title.missing': 'Write a unique, descriptive title that reflects the page\'s actual content (no keyword stuffing).',
    'description.missing': 'Write a concise, accurate summary of the page. Use only facts present on the page.',
    'duplicate.title': 'Give each page its own title (in frameworks: set per-route metadata; a layout title.template plus page titles avoids duplicates).',
    'img.alt-missing': 'Describe what each informative image shows; use alt="" for decorative images.',
    'links.uncrawlable': 'Use <a href="/path"> for navigation (framework Link components render real hrefs).',
    'h1.missing': 'Add a visible main heading that matches the page purpose.',
    'geo.organization-missing': 'Add Organization JSON-LD (name, url, logo, sameAs) on the homepage using only verifiable facts.',
    'index.client-rendered': 'Render primary content on the server (SSR/SSG/prerender) so crawlers that do not execute JavaScript can read it.',
    'sd.missing-required': 'Add the required properties listed in the evidence, using values visible on the page.',
    'content.low-text': 'Review whether the page serves its purpose; expand with useful, original content, consolidate, or noindex placeholders.',
  };
  for (const [ruleId, instruction] of Object.entries(TASKS)) {
    const f = byRule.get(ruleId);
    if (!f || !wanted(ruleId)) continue;
    const locs = f.evidence.filter((e) => !(ruleId === 'title.missing' && e.file?.endsWith('functions.php') && fwOf(e.file) === 'wordpress-theme'));
    if (locs.length) plan.tasks.push({ ruleId, title: f.title, instruction, locations: locs.map((e) => ({ file: e.file, line: e.line, url: e.url, observed: e.observed })) });
  }
  plan.files = [...pending.values()];
  return plan;
}

function frameworkCanonicalHint(fw: string): string {
  switch (fw) {
    case 'nextjs-app':
      return 'Set metadataBase in the root layout and `alternates: { canonical: "/path" }` in each route\'s metadata/generateMetadata.';
    case 'nextjs-pages':
      return 'Add <link rel="canonical" href={absoluteUrl}> inside next/head for each page.';
    case 'astro':
      return 'In the base layout: <link rel="canonical" href={new URL(Astro.url.pathname, Astro.site)} /> (requires `site` in astro.config).';
    case 'nuxt':
      return 'Use useHead({ link: [{ rel: "canonical", href: absoluteUrl }] }) or the @nuxtjs/seo module.';
    case 'laravel':
      return 'In the layout <head>: <link rel="canonical" href="{{ url()->current() }}"> (adjust if query strings must be kept).';
    case 'wordpress-theme':
      return 'WordPress core outputs rel=canonical for singular content via wp_head(); ensure header.php calls wp_head().';
    default:
      return 'Add <link rel="canonical" href="https://absolute-url"> to the page head.';
  }
}

export function urlForFile(file: string, scan: RepoScan, siteUrl: string): string | null {
  for (const [url, f] of scan.apps.flatMap((a) => [...a.urlToFile])) {
    if (f === file) {
      const u = new URL(url);
      return new URL(u.pathname + u.search, siteUrl).toString();
    }
  }
  return null;
}

function planSitemap(
  scan: AppScan,
  opts: PlanOptions,
  plan: FixPlan,
  stage: (ruleId: string, title: string, rationale: string, file: string, after: string, action?: 'modify' | 'create') => void,
  read: (f: string) => string,
  report: AuditReport,
): void {
  const fw = scan.framework;
  if (!opts.siteUrl) {
    plan.skipped.push({ ruleId: 'robots.no-sitemap', reason: 'site URL unknown — pass --site-url to generate sitemap/robots files' });
    return;
  }
  const origin = new URL(opts.siteUrl).origin;
  const staticRoutes = [...new Set(scan.routes.filter((r) => !r.dynamic && !r.noindex).map((r) => r.route.replace(/\/+$/, '') || '/'))].sort();
  let sitemapPath: string | null = null;
  if (scan.staticSite) {
    // Static HTML: only indexable, self-canonical pages.
    const excluded = new Set(report.findings.filter((f) => ['index.noindex', 'index.sitemap-non-canonical', 'index.soft-404'].includes(f.ruleId)).flatMap((f) => f.evidence.map((e) => e.file)));
    const urls = [...scan.urlToFile.entries()].filter(([, file]) => !excluded.has(file)).map(([u]) => new URL(new URL(u).pathname, origin).toString()).sort();
    const dir = path.posix.dirname([...scan.urlToFile.values()].sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length)[0]!);
    sitemapPath = (dir === '.' ? '' : dir + '/') + 'sitemap.xml';
    stage('robots.no-sitemap', 'Generate sitemap.xml', `Lists ${urls.length} indexable static pages (noindex/non-canonical pages excluded).`, sitemapPath, sitemapXml(urls), 'create');
  } else if (fw === 'nextjs-app') {
    const appBase = scan.locations.rootLayout ? path.posix.dirname(scan.locations.rootLayout) : 'app';
    const file = `${appBase}/sitemap.ts`;
    const body = `import type { MetadataRoute } from 'next';\n\n// Generated by Searvex from static routes. Add dynamic routes (e.g. from your CMS) below.\nconst BASE_URL = '${origin}';\n\nexport default function sitemap(): MetadataRoute.Sitemap {\n  const routes = ${JSON.stringify(staticRoutes)};\n  return routes.map((route) => ({ url: \`\${BASE_URL}\${route === '/' ? '' : route}\` }));\n}\n`;
    stage('robots.no-sitemap', 'Add app/sitemap.ts (Next.js metadata route)', `Uses the Next.js MetadataRoute.Sitemap convention with ${staticRoutes.length} static routes; dynamic routes need data sources.`, file, body, 'create');
    if (!scan.locations.hasRobotsGenerator && !scan.locations.robotsFile) {
      stage('robots.no-sitemap', 'Add app/robots.ts referencing the sitemap', 'Next.js MetadataRoute.Robots convention; allows all crawlers.', `${appBase}/robots.ts`, `import type { MetadataRoute } from 'next';\n\nexport default function robots(): MetadataRoute.Robots {\n  return {\n    rules: { userAgent: '*', allow: '/' },\n    sitemap: '${origin}/sitemap.xml',\n  };\n}\n`, 'create');
    }
    return;
  } else if (scan.locations.publicDir && ['laravel', 'nextjs-pages', 'vite-spa', 'cra-spa', 'nuxt', 'astro'].includes(fw) && staticRoutes.length) {
    if (fw === 'astro' || fw === 'nuxt') {
      plan.tasks.push({ ruleId: 'robots.no-sitemap', title: 'Add a sitemap integration', instruction: fw === 'astro' ? 'Install @astrojs/sitemap and add it to integrations in astro.config (requires `site`).' : 'Install @nuxtjs/sitemap (or @nuxtjs/seo) and configure site.url.', locations: [{ file: scan.locations.publicDir }] });
      return;
    }
    sitemapPath = `${scan.locations.publicDir}/sitemap.xml`;
    stage('robots.no-sitemap', 'Generate static sitemap.xml', `Static routes from ${fw === 'laravel' ? 'routes/web.php' : 'the router'} (${staticRoutes.length}); regenerate when routes change or adopt a generator package.`, sitemapPath, sitemapXml(staticRoutes.map((r) => new URL(r, origin).toString())), 'create');
  }
  if (!sitemapPath) return;
  const robotsPath = scan.locations.robotsFile ?? (scan.locations.publicDir ? `${scan.locations.publicDir}/robots.txt` : path.posix.join(path.posix.dirname(sitemapPath), 'robots.txt'));
  const sitemapUrl = new URL('/' + path.posix.basename(sitemapPath), origin).toString();
  let robots: string | null = null;
  try {
    robots = read(robotsPath);
  } catch {
    robots = null;
  }
  if (robots === null) stage('robots.no-sitemap', 'Create robots.txt with Sitemap directive', 'Allows all crawlers and declares the sitemap location.', robotsPath, `User-agent: *\nAllow: /\n\nSitemap: ${sitemapUrl}\n`, 'create');
  else if (!/^\s*sitemap\s*:/im.test(robots)) stage('robots.no-sitemap', 'Add Sitemap directive to robots.txt', 'Declares the sitemap location; existing rules are unchanged.', robotsPath, robots.replace(/\s*$/, '') + `\n\nSitemap: ${sitemapUrl}\n`);
}

/** True when most line breaks in `text` are CRLF. */
export function usesCrlf(text: string): boolean {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  return crlf > 0 && crlf >= (text.match(/\n/g) ?? []).length - crlf;
}

export function sitemapXml(urls: string[]): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${esc(u)}</loc></url>`).join('\n')}\n</urlset>\n`;
}
