import path from 'node:path';
import { computeScores, type AuditReport } from '../analyze/audit.js';
import { buildContext } from '../analyze/context.js';
import { runContentChecks, type ContentReport } from '../analyze/content.js';
import { runGeoChecks, type GeoReport } from '../analyze/geo.js';
import { buildInventory, type SiteInventory } from '../analyze/inventory.js';
import { runTechnicalChecks } from '../analyze/technical.js';
import { SEARVEX_VERSION } from '../net/fetcher.js';
import { FindingSink, loadKnowledge, type KnowledgeBase } from '../rules/engine.js';
import { PLACEHOLDER_ORIGIN, scanRepository, type RepoScan } from './scan.js';

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
  };

  if (scan.staticSite) {
    // Run the website analyzers against the synthetic crawl, then drop network-only rules.
    const inner = new FindingSink(kb);
    const ctx = buildContext(scan.staticSite);
    runTechnicalChecks(ctx, inner);
    geo = runGeoChecks(ctx, inner);
    content = runContentChecks(ctx, inner);
    inventory = buildInventory(ctx);
    for (const f of inner.findings()) {
      if (NETWORK_ONLY.has(f.ruleId)) continue;
      // canonical.missing without a known site URL cannot be fixed reliably; still report it.
      sink.emit(
        f.ruleId,
        f.evidence.map((e) => ({ ...e, file: e.url ? scan.urlToFile.get(e.url) ?? e.file : e.file, url: e.url?.startsWith(PLACEHOLDER_ORIGIN) ? e.url.slice(PLACEHOLDER_ORIGIN.length) : e.url })),
        { message: f.message, severity: f.severity, confidence: f.confidence },
      );
    }
  }
  const findings = sink.findings().filter((f) => !NETWORK_ONLY.has(f.ruleId));
  const limitations = [
    'Repository mode analyses source files statically. Values computed at runtime (CMS data, generateMetadata fetching, i18n) cannot be fully resolved; such cases are reported conservatively.',
    'HTTP behaviour (status codes, redirects, headers, compression, speed) requires website mode against a running deployment.',
  ];
  if (!scan.staticSite && scan.detection.framework !== 'static-html') limitations.push(`Framework "${scan.detection.framework}" was analysed via source patterns; run "searvex audit <deployed-url>" for rendered-output verification.`);
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
      startUrl: opts.siteUrl ?? '', robots: { url: scan.locations.robotsFile ?? '', state: scan.locations.robotsFile ? 'ok' : 'missing', status: 0, sitemaps: [] },
      sitemaps: scan.locations.sitemapFiles, sitemapUrls: scan.staticSite?.sitemap.urls.length ?? 0, sitemapIssues: [],
    },
    inventory,
    findings,
    geo,
    content,
    scores: computeScores(findings, Math.max(1, scan.routes.length)),
    measurement: {
      verified: findings.filter((f) => f.confidence === 'verified').length,
      heuristic: findings.filter((f) => f.confidence === 'heuristic').length,
      unmeasurable: findings.filter((f) => f.confidence === 'unmeasurable').length,
    },
    limitations,
  };
  return { report, scan };
}
