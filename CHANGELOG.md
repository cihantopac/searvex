# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.7.0] - 2026-10-30

### Added
- `searvex gsc import <export.zip|*.csv>`: Search Console Performance exports without any account access.
  Reads the ZIP from "Export → Download CSV" or the individual CSVs; tables are recognised by their
  (localised) headers — English and Turkish verified, DE/FR/ES/IT/PT/NL best-effort — with decimal commas,
  `;`/tab delimiters and UTF-16 files. Period and search type come from the dates and filters tables;
  filtered exports, truncated tables (1,000-row UI limit) and unreadable rows are reported. Sections that
  need query × page data are listed under "Not measured" instead of being approximated.
- `searvex connect <url> [--choice google|csv|skip]`: the optional search-data step ("Google ile bağlan",
  "CSV içe aktar", "Şimdilik geç"). It never starts OAuth itself; the choice is stored per site in the user
  config directory so Searvex does not ask again. `run` summaries state that search metrics are not measured
  and how to add them.
- `gsc status`; `gsc report` without a property picks the single accessible property covering the newest
  audit.
- Credential storage behind a `CredentialStore` interface (file backend; atomic writes), so a keychain or a
  hosted token service can be added without touching the integrations.

### Changed
- "Queries shared by several pages" is no longer labelled data-verified cannibalisation. Each shared query
  gets a pattern — navigational/brand, parent/child pages, one dominant page, mixed intent, possible
  competition — and only the last two are marked for review.
- `gsc auth` reuses a valid stored authorization (`--force` to re-authorize), refuses to run in CI, rejects
  "Web application" client files, and `invalid_grant` errors explain the 7-day refresh-token expiry of OAuth
  apps in "Testing" status.
- `monitor --import` uses the new importer (localised headers, ZIP files).
- Bing reports state that totals cover the top pages only.

### Security
- `--render` isolation: page scripts could reach targets outside the network policy through redirect hops
  (only the first request of a chain was checked), WebSockets and the first request of popups, and the
  browser re-resolved DNS (rebinding window). A test with a request counter on a forbidden server reproduced
  four such requests. All browser traffic now goes through a local policy proxy (per-run credentials,
  connection-time DNS validation, redirects/tunnels/upgrades checked, per-page byte budget); WebRTC is
  limited to proxied connections; each page renders in a fresh context; Chromium's sandbox is used when
  available and its status is reported.

### Fixed
- `gsc report` / `bing report --audit latest` joined the newest website audit in the workspace even when it
  belonged to another site. The audit is now chosen by property scope (domain properties: all subdomains
  and protocols; URL-prefix properties: exact protocol, host and path), explicit run ids of other sites are
  rejected, and ambiguous choices (several subdomains of a domain property) require an explicit run id.
  Pages without impressions are only listed inside the property.
- `gsc report` checks that the property exists in the account with read access and suggests the right
  spelling (`sc-domain:` vs URL prefix).
- `gsc logout` now revokes the token at Google instead of only deleting the local copy.

## [0.6.0] - 2026-10-30

### Changed
- Repository mode reads JS/TS/JSX/TSX sources through an AST (`@babel/parser`, new runtime dependency;
  bundle 1.10 → 1.68 MB). Next.js `metadata` / `generateMetadata` keys come from the exported object
  itself, so `title:` in an unrelated object no longer counts. Spreads, variables and helper calls give
  "unknown" instead of "missing", and `notFound()` / `redirect()` branches are ignored. JSX `<img>`, `<a>`
  and `<html>` checks no longer stop at the `>` of an arrow function in an attribute. Findings now carry
  line numbers. Files that fail to parse fall back to the previous regex checks.

## [0.5.0] - 2026-10-30

### Added
- Rule `crawl.facet-explosion`: faceted navigation / filter parameters multiplying crawlable URLs; rule
  `pagination.canonical-to-first`: paginated pages canonicalised to page 1.
- Internal-link opportunities (`links.internal-opportunity`, heuristic): topically related indexable pages
  with no link in either direction, suggested from the better-linked page to the weaker one.
- Search intent (always labelled inferred): multilingual query intent, page intent from the page type, an
  intent mix and intent mismatches (e.g. a how-to query ranking with a pricing page) in Search Console and
  Bing reports; intent per page in the inventory.
- HTML report: severity, category and fix-first charts, a Templates tab (issues grouped by URL pattern),
  page-type and intent charts. `monitor` writes `monitor.html` (before/after) and `ecosystem` writes
  `ecosystem.html` (site table, cross-link matrix, overlap, shared issues).

### Changed
- Knowledge base re-verification: every `excerpt`/`url-resolved` citation was re-read (Bing help pages
  rendered in a browser); 146 of 148 citations are now `fetched`. Citations that did not state the rule's
  claim were replaced.

### Fixed
- The `index.noindex` Yandex citation pointed to a captcha URL captured by an earlier snapshot update. The
  source checker now detects bot challenges, reports them as unreadable, never stores them, and the validator
  rejects challenge URLs.

## [0.4.0] - 2026-10-30

### Added
- `searvex rules check-sources [--update]`: re-fetches every official source (status, redirects, page update
  date, main-text hash) against `knowledge/source-snapshots.json`; weekly GitHub workflow.
- Impact-based prioritisation (score, P1–P3, effort, reasons) with a "Fix first" table, and URL-template
  grouping per finding; HTML report sorts by priority.
- `searvex gsc auth|sites|report|logout`: Search Console via your own OAuth Desktop client (loopback + PKCE,
  read-only scope, 0600 token storage); query × page analysis (striking distance, low CTR vs own median,
  multi-page queries, pages without impressions, audit issues on traffic pages).
- `searvex bing report`: the same analysis on Bing Webmaster Tools API data (API key).
- Rule `lang.locale-adaptive`: server-side Accept-Language probe and client-side locale switching in render mode.

### Changed
- 14 rule sources updated after Google moved its crawling documentation to developers.google.com/crawling/
  (facts re-verified). Renderer uses a fixed en-US locale. Render mode keeps raw-HTML-only duplicates.

## [0.3.0] - 2026-10-30

### Added
- `searvex ecosystem <url…>`: brand-family analysis — entity graph (parent/child declarations on both sides,
  name consistency), cross-link matrix, topic overlap between same-language sites, family-wide issues,
  language coverage. Sites are crawled in parallel; `--reuse` uses stored runs.
- Structured-data inventory (JSON-LD, Microdata, RDFa) per site; competitor schema-type gaps in research.
- Score-based business model classification with evidence, confidence and alternatives; offerings and
  organisation relations extracted from structured data.
- Content-language checks: `lang.content-mismatch` and `lang.mixed-navigation` (dependency-free detector for
  en, tr, de, fr, es, it, pt, nl).
- Playwright rendering test suite and CI job (SPA, hydration, JS-changed robots/canonical, canonical in body,
  metadata exfiltration attempts, popups, endless polling).
- Inertia.js-specific explanations for duplicate titles and meta descriptions.

### Changed
- Near-duplicate detection compares main content after removing template shingles per locale+section;
  shingles hashed (FNV-1a) for speed and memory.
- Cannibalisation uses term-set similarity (Jaccard >= 0.6) with union-find; section template terms removed.
- Renderer: popups closed per page, images/media/fonts skipped, per-page request cap, bounded idle wait.
- `/searvex` skill includes the ecosystem step for related sites.

### Fixed
- Link-local / cloud-metadata addresses are blocked even with `--allow-private`.
- hreflang checks only on canonical, indexable pages; `/path?` normalised to `/path`.
- Cloudflare `/cdn-cgi/` endpoints and email placeholders ignored; failed HEAD responses confirmed with GET.
- Entity consistency compared per role (site vs organisation); headings in site chrome excluded from topics.
- Turkish dotted capital I tokenization; initialisms no longer counted as language evidence.

## [0.2.0] - 2026-10-30

### Added
- `searvex run`: ordered full workflow (audit → GEO → diff → research → repo audit → fix plan) sharing one crawl.
- `/searvex` skill rewritten as a 7-phase workflow with approval checkpoints; single-step skills labelled.

### Fixed
- Windows: monorepo app roots used backslashes, so apps were analysed as empty.
- `report latest` now selects the newest run that contains a report.

## [0.1.0] - 2026-10-30

### Added
- Safe HTTP client (SSRF protection with connection-time DNS validation, manual redirect validation, caps).
- Polite crawler: RFC 9309 robots.txt, sitemaps, per-host rate limiting, Crawl-delay, Retry-After, checkpoints and `--resume`.
- Sourced rule base (84 rules) with validator, engine scope, verification levels and myth guards.
- Analyzers: technical SEO, structured data (Google required properties, retired types), GEO (AI crawler purpose matrix, snippet controls, entity consistency, clarity heuristic), content (TF-IDF, clusters, cannibalisation, near-duplicates), inventory.
- Repository mode for Next.js, Astro, Nuxt, Laravel, WordPress themes, SPAs, static sites and monorepos.
- Optimizer with dry-run diffs, framework idioms, verification, automatic and manual rollback.
- Commands: audit, geo, research, optimize, rollback, monitor, rules, report, runs.
- Optional integrations: CrUX API, Search Console API and CSV import, outbound link checks, Playwright rendering.
- Reports: Markdown, interactive HTML (XSS-safe, CSP), JSON, SARIF.
- Claude Code plugin with 6 skills and 2 agents; single-file bundle.
