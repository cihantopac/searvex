/**
 * Rule ids with a code implementation. Kept explicit so `searvex rules validate` can flag
 * knowledge-base rules without code and code that references unknown rules.
 * test/unit/rules.test.ts verifies this list against the source tree.
 */
export const IMPLEMENTED_RULES = new Set<string>([
  // crawlability / links / redirects
  'http.start-url-error', 'robots.unreachable', 'robots.too-large', 'robots.disallow-all', 'robots.crawl-delay-ignored', 'robots.no-sitemap',
  'robots.blocked-sitemap-url', 'http.server-error', 'http.fetch-error', 'links.broken-internal', 'links.broken-external',
  'links.uncrawlable', 'links.empty-anchor', 'links.internal-opportunity', 'redirect.chain', 'redirect.loop', 'redirect.temporary-internal',
  'redirect.meta-refresh', 'crawl.deep-pages', 'crawl.sitemap-orphan', 'crawl.facet-explosion', 'pagination.canonical-to-first',
  // indexability
  'index.noindex-in-sitemap', 'index.noindex', 'index.noindex-blocked', 'index.sitemap-non200', 'index.sitemap-non-canonical',
  'index.soft-404', 'index.client-rendered', 'index.render-mismatch', 'index.oversized-html',
  // canonicalization / duplicates
  'canonical.missing', 'canonical.multiple', 'canonical.in-body', 'canonical.relative', 'canonical.target-error', 'canonical.target-noindex',
  'canonical.cross-domain', 'canonical.noindex-conflict', 'canonical.http-https', 'canonical.www-duplicate',
  'duplicate.title', 'duplicate.description', 'duplicate.content',
  // international
  'hreflang.invalid-code', 'hreflang.missing-return', 'hreflang.missing-self', 'hreflang.target-error', 'hreflang.relative',
  'hreflang.no-x-default', 'html.lang-missing', 'lang.content-mismatch', 'lang.mixed-navigation', 'lang.locale-adaptive',
  // metadata / media
  'title.missing', 'title.multiple', 'title.truncation-risk', 'description.missing', 'description.multiple', 'h1.missing',
  'meta.keywords-present', 'mobile.viewport-missing', 'social.og-missing', 'img.alt-missing', 'img.dimensions-missing',
  // structured data
  'sd.invalid-json', 'sd.missing-context', 'sd.missing-required', 'sd.retired-type', 'sd.none', 'geo.organization-missing',
  // performance / security
  'perf.slow-ttfb', 'perf.no-compression', 'perf.cwv-unmeasured', 'perf.cwv-poor', 'https.not-used', 'https.mixed-content',
  // geo
  'geo.search-bot-blocked', 'geo.ai-search-bot-blocked', 'geo.training-bots', 'geo.snippet-restricted', 'geo.llms-txt',
  'geo.entity-inconsistent', 'geo.answerability', 'geo.citations-unmeasured',
  // content / architecture
  'content.low-text', 'content.near-duplicate', 'content.cannibalization', 'url.underscores', 'url.session-params',
]);
