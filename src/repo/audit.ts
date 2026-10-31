import path from 'node:path';
import { computeScores, type AuditReport } from '../analyze/audit.js';

const NOTHING_TO_AUDIT = 'No website found: the repository has no web framework, HTML pages or server templates that Searvex can audit (tests, fixtures, examples and benchmarks are ignored). Point Searvex at the folder of the site, or at its deployed URL.';
import { buildContext } from '../analyze/context.js';
import { runContentChecks, type ContentReport } from '../analyze/content.js';
import { runGeoChecks, type GeoReport } from '../analyze/geo.js';
import { buildInventory, type SiteInventory } from '../analyze/inventory.js';
import { runTechnicalChecks } from '../analyze/technical.js';
import { SEARVEX_VERSION } from '../net/fetcher.js';
import { FindingSink, loadKnowledge, type KnowledgeBase } from '../rules/engine.js';
import { MISSING_IN_REPO, PLACEHOLDER_ORIGIN, routeMatches, scanRepository, type RepoScan } from './scan.js';
import { prioritise } from '../analyze/priority.js';

/** Rules that are meaningless for files on disk (they need a live server). */
const NETWORK_ONLY = new Set(['perf.slow-ttfb', 'perf.no-compression', 'https.not-used', 'canonical.http-https', 'canonical.www-duplicate', 'http.server-error', 'http.fetch-error', 'robots.unreachable', 'geo.citations-unmeasured', 'perf.cwv-unmeasured']);

export interface RepoAuditResult {
  report: AuditReport;
  scan: RepoScan;
}

const emptyContent: ContentReport = { topTerms: [], pageTerms: [], clusters: [], cannibalization: [], nearDuplicates: [], exactDuplicates: [] };

export function auditRepository(root: string, opts: { siteUrl?: string; kb?: KnowledgeBase } = {}): RepoAuditResult {
  const kb = opts.kb ?? loadKnowledge();
  const sink = new FindingSink(kb);
  const scan = scanRepository(path.resolve(root), sink, opts);

  let geo: GeoReport = { bots: [], entityNames: {}, answerability: { average: 0, pages: [] }, snippetRestricted: [], citations: { measured: false, reason: 'Repository mode does not observe AI systems.' }, notes: [] };
  let content = emptyContent;
  let inventory: SiteInventory = {
    pages: scan.routes.map((r) => ({ url: r.route, type: 'other', basis: 'default', lang: null, title: null, status: 0, indexable: !r.noindex, depth: r.route.split('/').filter(Boolean).length, inlinks: 0, words: 0 })),
    byType: {}, languages: {}, hreflangLanguages: [], statusCodes: {}, businessModel: { label: 'unknown (repository mode)', evidence: [] }, sections: [],
    structuredData: { types: [], pagesWithStructuredData: 0, invalidJsonLdPages: 0 },
  };

  let first = true;
  for (const app of scan.apps) {
    if (!app.staticSite) continue;
    // A URL missing from the static files may be a route of another app in the same repository (a monorepo
    // whose reverse proxy sends /blog to the CMS app): then it is served, not missing.
    const otherRoutes = scan.apps.filter((a) => a !== app).flatMap((a) => a.routes.map((r) => r.route));
    app.staticSite.pages = app.staticSite.pages.filter((p) => p.error !== MISSING_IN_REPO || !otherRoutes.some((r) => routeMatches(r, new URL(p.url).pathname)));
    // Run the website analyzers against the synthetic crawl, then drop network-only rules.
    const inner = new FindingSink(kb);
    const ctx = buildContext(app.staticSite);
    runTechnicalChecks(ctx, inner);
    const appGeo = runGeoChecks(ctx, inner);
    const appContent = runContentChecks(ctx, inner);
    if (first) {
      geo = appGeo;
      content = appContent;
      inventory = buildInventory(ctx);
      first = false;
    }
    const origin = app.staticSite.origin;
    for (const f of inner.findings()) {
      if (NETWORK_ONLY.has(f.ruleId)) continue;
      // Without a real site URL, cross-domain comparisons against the placeholder origin are meaningless.
      if (app.originSource === 'placeholder' && f.ruleId === 'canonical.cross-domain') continue;
      sink.emit(
        f.ruleId,
        f.evidence.map((e) => ({ ...e, file: e.url ? app.urlToFile.get(e.url) ?? e.file : e.file, url: e.url?.startsWith(origin) ? e.url.slice(origin.length) || '/' : e.url })),
        { message: f.message, severity: f.severity, confidence: f.confidence },
      );
    }
  }
  const findings = sink.findings().filter((f) => !NETWORK_ONLY.has(f.ruleId));
  prioritise(findings, (id) => sink.affected(id), undefined, Math.max(1, scan.routes.length));
  const limitations = [
    'Repository mode analyses source files statically. Values computed at runtime (CMS data, generateMetadata fetching, i18n) cannot be fully resolved; such cases are reported conservatively.',
    'HTTP behaviour (status codes, redirects, headers, compression, speed) requires website mode against a running deployment.',
  ];
  for (const app of scan.apps) {
    if (!app.staticSite && app.framework !== 'static-html') limitations.push(`App "${app.appRoot}" (${app.framework}) was analysed via source patterns; run "searvex audit <deployed-url>" for rendered-output verification.`);
    if (app.originSource === 'inferred') limitations.push(`App "${app.appRoot}": site origin ${app.staticSite!.origin} was inferred from canonical/og:url/hreflang URLs; pass --site-url to override.`);
    if (app.originSource === 'placeholder') limitations.push(`App "${app.appRoot}": site URL unknown; canonical cross-domain checks were skipped. Pass --site-url for complete results.`);
  }
  // No framework, no routes, no HTML pages: a library or CLI repository. Say so instead of scoring 100.
  const nothingToAudit = !scan.routes.length && scan.apps.every((a) => a.framework === 'unknown' && !a.staticSite) && !findings.some((f) => f.severity !== 'info');
  if (nothingToAudit) limitations.unshift(NOTHING_TO_AUDIT);
  if (scan.skipped.secrets) limitations.push(`${scan.skipped.secrets} secret-bearing file(s) (.env, keys, credentials) were skipped and never read.`);
  if (scan.skipped.symlinks) limitations.push(`${scan.skipped.symlinks} symlink(s) were not followed.`);
  if (scan.skipped.truncated) limitations.push('File limit reached; repository scan is partial.');

  const report: AuditReport = {
    tool: { name: 'searvex', version: SEARVEX_VERSION, rulesVersion: kb.version },
    mode: 'repository',
    target: path.resolve(root),
    runId: 'repository',
    generatedAt: new Date().toISOString(),
    crawl: {
      crawled: scan.routes.length, queuedRemaining: 0, blocked: 0, errors: 0, durationMs: 0, avgResponseMs: 0, truncated: scan.skipped.truncated,
      startUrl: opts.siteUrl ?? '', robots: { url: scan.apps[0]?.locations.robotsFile ?? '', state: scan.apps[0]?.locations.robotsFile ? 'ok' : 'missing', status: 0, sitemaps: [] },
      sitemaps: scan.apps.flatMap((a) => a.locations.sitemapFiles), sitemapUrls: scan.apps.reduce((n, a) => n + (a.staticSite?.sitemap.urls.length ?? 0), 0), sitemapIssues: [],
    },
    inventory,
    findings,
    geo,
    content,
    scores: nothingToAudit ? { ...computeScores(findings, 1), notApplicable: NOTHING_TO_AUDIT } : computeScores(findings, Math.max(1, scan.routes.length)),
    measurement: {
      verified: findings.filter((f) => f.confidence === 'verified').length,
      heuristic: findings.filter((f) => f.confidence === 'heuristic').length,
      unmeasurable: findings.filter((f) => f.confidence === 'unmeasurable').length,
    },
    limitations,
  };
  return { report, scan };
}
