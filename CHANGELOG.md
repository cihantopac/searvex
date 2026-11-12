# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Page-structure templates: each page gets a layout skeleton hash (landmarks, body children and their stable
  classes, main-content blocks, content heading levels). Findings list the structures of their affected pages
  (`findings[].structures`), and one layout behind several URL patterns (flat slugs such as `/alpha`, `/beta`) now
  counts as "fix once" in the priorities, like a URL template does.

### Added
- Upstream proxy support, as designed in `docs/design/proxy.md`: `--proxy <url|none>` and `HTTPS_PROXY` /
  `HTTP_PROXY` / `NO_PROXY`, `CONNECT` only with TLS end to end and Basic authentication. Private, loopback and
  reserved targets never go through the proxy. Host names are resolved and checked locally before `CONNECT`;
  `--proxy-resolve local` connects to the checked address instead. Used by crawling, `--render`, `--check-external`
  and `rules check-sources`.
- Evidence artefacts: `--save-html` keeps each fetched HTML body as served (≤ 2 MB, as `.html.txt`), and
  `--screenshots` (with `--render`) one viewport PNG per rendered page, under `artefacts/` in the run directory
  with owner-only permissions and a 200 MB per-run budget. Evidence items (`evidence[].artefact`) and the HTML
  report link them; `crawl.artefacts` counts them.
- Traffic-weighted priorities: when Search Console or Bing data is joined to an audit (`gsc report --audit`,
  `gsc import --audit`, `bing report --audit`, `monitor --import` with a pages table), a page's importance becomes
  half structure and half its share of verified clicks (impressions when clicks are too few). Reach and scores are
  recomputed over each finding's complete affected URLs, the "why" reasons state the clicks and impressions, and
  `report.json` records the input under `traffic`.
- **By cause** view in the HTML report (EN/TR): observed root causes with their likely consequences (for example a
  client-side language switch → render mismatch, hreflang and duplicate findings), and the templates and source
  files that carry several issue types, so one change can fix them. Findings show a "likely from" chip wherever they
  are listed. `report.json` records the links as `priority.causedBy` and `priority.effects`.
- `crawl.proxy` in `report.json` (endpoint and resolution mode, never credentials), plus a limitation line; report
  schema 1.1.
- Exit codes for the proxy: an unusable proxy setting or failed proxy authentication is `2`, an unreachable proxy
  `3`, and a proxy that refuses `CONNECT` to the start URL `4`.

## [1.3.0] - 2026-11-11

A run says honestly what it did, and its output is a contract. Release notes:
[docs/release-notes-1.3.0.md](docs/release-notes-1.3.0.md).

### Added
- `crawl.status: "robots-blocked"`: when robots.txt blocks every queued URL (it answered 5xx/429, which RFC 9309
  treats as a complete disallow, or it disallows them) no page is fetched, so the run is no longer reported as a
  complete, scored run. It exits `4` like an unreachable target, keeps only the site finding to fix
  (`robots.unreachable` or `robots.disallow-all`, in the launch checklist with `--pre-launch`) and says so in the
  summary. A run with at least one fetched page is unchanged.
- `crawl.fetched`: URLs for which an HTTP request was made. `crawl.crawled` keeps its meaning (URLs processed,
  including robots-blocked ones). The CLI summary, progress lines and the Markdown/HTML KPIs show pages fetched
  and, when not 0, how many robots.txt blocked.
- `inventory.unfetched` / `inventory.unfetchedTotal`: every crawled URL that is not in `inventory.pages`, with its
  status and reason (`robots-blocked`, `error`, `redirect`, `non-200`, `not-html`), capped at 10,000.
- Exit code `4` always prints one `searvex: …` line on stderr, also with `--json` and `--quiet` (`audit`, `geo`,
  `monitor`, `run`).
- With `--json`, every error also writes one JSON object on stderr:
  `{"error":{"code":2|3|4,"kind":"usage|policy|runtime|unreachable|robots-blocked","message":…}}`.
- `SEARVEX_DEBUG=1` prints the stack trace of a runtime error.
- Graceful interruption (exit `5`): the first SIGINT/SIGTERM, or the new `--max-duration <s>`, stops the crawl,
  lets pages in flight finish, and writes every requested report format as a partial report
  (`crawl.interrupted: "signal" | "max-duration"`, a limitation line, extra probes skipped). A second signal exits
  at once (130/143). `audit`, `geo`, `monitor` and `run`; an interrupted run is never a monitor baseline.
- `report.json` carries what the HTML report computed: every finding has `ref` and `remediation`
  (`auto | agent | manual`), every evidence item its stable `ref`, and the report has `rootCauseGroups`.
- `findings[].affected = { count, urls, truncated? }`: every affected URL or file of a finding (complete up to
  10,000), so consumers no longer derive counts from the 50-item evidence sample. `--compact` writes only the
  count.
- `--progress ndjson`: structured progress on stderr, one JSON event per line (`start`, `phase`, `page`,
  `finding-summary`, `signal`, `end` with exit code, report paths and interruption). Works with `--json` on stdout.
- `searvex prompt <runId|latest> [--lang en|tr] [--rules a,b] [--format md|json]` prints the repair prompt the HTML
  action center builds, outside the browser, with the same redaction.
- Package exports: `buildRepairPrompt`, `repairPromptInput`, `annotateReport`, `rootCauseGroups`, `remediationOf`,
  `findingRef`, `diffReports` and `prioritise`.
- `--allow-host <glob>`, `--deny-host <glob>` (repeatable) and `--ports <list>`: limit which hosts and ports Searvex
  contacts. Enforced on every request and redirect hop, in the connection-time DNS lookup, in the `--render`
  policy proxy and before `--check-external`. A denied target is policy-blocked (exit `2`); other denied URLs are
  skipped (`inventory.unfetched` reason `policy-blocked`).
- Versioned output contract: `report.json` has `schemaVersion: "1.0"`; JSON Schemas (draft-07) for the report,
  the progress events and the error object are generated from the TypeScript types, shipped in `schema/` and
  printed by `searvex schema [report|events|error]`. Policy in `docs/schema.md`: additive change = minor schema
  version, breaking change = major, independent of the package version.
- `tool.rules`: the rule-file version of every rule that produced a finding (`tool.rulesVersion` stays the newest
  of all files).
- The crawl checkpoint is written at the start and every 25 pages or 10 seconds, so `--resume` works after an early
  kill; resuming no longer fetches pages stored after the last checkpoint again and still follows their links.
- `--render`: Playwright no longer kills the browser on SIGINT/SIGTERM under pages that are still rendering;
  Searvex closes it on every exit path.

### Changed
- **`scores.overall` is `null`** whenever `scores.notApplicable` is set (unreachable or robots-blocked target,
  repository without a website). It was `100`, which a consumer reading only `overall` took for a perfect site.
  `monitor`'s `scoreAfter` and `ecosystem`'s per-site `score` can be `null` too.
- A failing start URL is reported once, as `http.start-url-error`, instead of also as `http.fetch-error` with the
  same evidence.
- `/llms.txt` never counts as an affected URL, like `/robots.txt`.
- A runtime error (exit `3`) prints one `searvex: <message>` line and a `SEARVEX_DEBUG=1` hint instead of a stack
  trace with absolute install paths. Every usage error, also one raised inside a command, ends with
  `Run "searvex --help" for usage.`. `--fail-on` is validated before crawling.
- `--check-external` no longer reports links the network policy forbids (for example a private address) as
  broken; they are counted in `externalLinks.skippedByPolicy`.
- `docs/cli.md` documents that a target blocked by the network policy (exit `2`) still writes `report.json`.
- Findings that stand for a group (`duplicate.title`, `duplicate.description`, `duplicate.content`,
  `content.cannibalization`) count every page of the group as affected, so `affectedUrls` and their priority reach
  can be higher than in 1.2.0 for the same site.
- Website progress lines say "pages fetched" and skip robots-blocked URLs.
- `SECURITY.md`: security fixes for the latest 1.x minor.
- Rule base `2026.11.11`: six sources re-read after the weekly source check (Anthropic crawler documentation,
  Google Search Central updates, web.dev Core Web Vitals, TTFB and CLS). The cited facts are unchanged; their
  `checked` dates and the source snapshots were updated.

## [1.2.0] - 2026-11-03

Trustworthy in pre-launch and embedded use. Release notes: [docs/release-notes-1.2.0.md](docs/release-notes-1.2.0.md).

### Added
- Exit code `4`: the start URL failed at the network level (DNS, TCP, TLS). `audit`, `geo`, `monitor` and `run`
  write their reports with `crawl.status: "unreachable"`, no site findings and `scores.notApplicable`, instead of
  reporting `robots.unreachable` with a score. An unreachable run is never used as a monitor baseline.
- A target blocked by the network policy (for example a local server without `--allow-private`) is now a usage
  error (exit `2`) with a hint.
- `--help` and `docs/cli.md` list the exit codes; `5` is reserved for interrupted runs (planned, not returned yet).
- `--site-url <url>` in URL mode (`audit`, `geo`, `monitor`, `run`): audit a local or staging build as its public
  site. Canonical, hreflang, sitemap and link URLs on the public origin are mapped to the crawled origin, so a
  public self-canonical no longer shows up as `canonical.cross-domain` / `canonical.noindex-conflict`, and the
  declared sitemap is read from the build. The report records `crawl.siteUrl` and says "Audited … as …".
- Rule `robots.sitemap-unreachable` (low): a sitemap declared in robots.txt cannot be fetched (DNS, connection,
  TLS or non-200). Each failing declared sitemap is reported, also when another one works; with `--site-url` the
  evidence names where it was fetched.
- `--pre-launch` profile for local and staging builds. Noindex pages are evaluated as they will be once live, and
  their noindex is listed in a **Launch checklist**. Findings of rules tagged `environment: server | launch` (HTTPS
  and compression on the test server; noindex, disallow-all, an unreachable public sitemap) get
  `context: "environment" | "launch-checklist"` and are excluded from the score, `--fail-on`, priorities, SARIF
  error levels and monitor regressions. The Markdown and HTML reports have a Launch checklist section and an
  Environment-dependent note (EN/TR). On a local or private target the CLI suggests the flag.

### Changed
- **Exit code for runtime errors is now `3`** (was `2`). `2` stays for usage errors. Scripts that checked
  `== 2` for crashes must check `3`.
- `robots.no-sitemap` now only means no `Sitemap:` directive and no `/sitemap.xml`. A declared but failing sitemap
  was reported as `robots.no-sitemap` before; `monitor` shows that change once as one resolved and one new finding.
- `geo.organization-missing` suggests Organization (company or brand) **or** ProfilePage with a Person mainEntity
  (personal site). A heuristic personal-site signal (a name-like homepage title, no product, pricing or shop
  pages) makes Person the primary suggestion and says so. New source: Google ProfilePage structured data.
- `img.dimensions-missing` no longer reports images sized in CSS: fixed width and height (or `aspect-ratio`) in the
  inline `style`, in a simple class or id rule of the page's own `<style>`, or fixed-size utility classes
  (`size-10`, `w-10 h-10`, `w-[40px] h-[40px]`). External stylesheets are still not fetched.
- Repository mode (Next.js App Router): a route inherits `robots` noindex from its layouts unless the page sets
  its own `robots`, so `canonical.missing` and `description.missing` no longer fire on routes that are noindex
  through a layout. The summary and Markdown report say "0 indexable: all noindex" when that is the reason.
  Pages router: a noindex in `_app` applies to every page.
- `--help` lists every option, including `--timeout <ms>` (default 15000, 1000–120000) and the command options;
  a test keeps it complete.

## [1.1.1] - 2026-11-01

Visual polish; the analysis engine, rules, evidence and CLI are unchanged. Release notes:
[docs/release-notes-1.1.1.md](docs/release-notes-1.1.1.md).

### Changed
- HTML report themes follow the Searvex brand palette (warm paper / ink / teal; coral only in the logo caret),
  with light and dark variants checked for WCAG AA contrast. Severity colours are unchanged in meaning.
- Overview: "Fix these first" moved directly below the key numbers; the limits of a run are a one-line summary
  with expandable details instead of a large notice.
- Turkish: the limits summary is fully translated; clearer wording for shared layouts, automatic fixes and
  informational findings.
- Mobile: two-column KPI grid with a full-width score card and a smaller gauge.
- README shortened and refocused; workflow diagrams and screenshots refreshed from the final report.

## [1.1.0] - 2026-11-01

A product-experience release: the analysis engine and its evidence are unchanged; how results are presented,
selected and fixed is new. Release notes: [docs/release-notes-1.1.0.md](docs/release-notes-1.1.0.md).

### Added
- **Brand identity**: the approved Searvex logo (outlined SVG, theme-aware) in every HTML report header, an SVG
  favicon in the reports, and the logo in the README. Source files in `docs/assets/brand/`.
- **SEO action center** (`report.html`): Overview (health score, issue groups, affected URLs, condition by area,
  top three priorities, limits of the run), Priorities, Issues, GEO, Search performance (only with connected
  data), Changes (only with a previous run) and Evidence. One shell for website, repository, monitor and
  ecosystem reports.
- **English / Türkçe** interface with browser-language detection, and Turkish titles and fixes for all 90
  rules. Evidence, URLs, code, file paths and rule ids are never translated.
- **Light / Dark / System** theme next to the language switch; both are remembered in `localStorage` (safe
  fallback when storage is blocked) and applied before first paint.
- **Root-cause groups**: findings are split by URL template, source file or — when a rule hits most page types —
  one shared layout, with page counts covering every affected URL. Every occurrence keeps a stable reference
  (`ruleId#hash`).
- **Remediation labels**: automatic (only when a dry-run plan produced a concrete patch), agent-assisted or
  manual/operational.
- **Issue selection and repair prompts**: select occurrences, groups or all visible issues, then generate an
  editable prompt (Copy / Download Markdown, English or Turkish) for a coding agent. It contains the run id,
  references, root-cause groups, evidence, fixes, verification steps and `optimize --only …` commands for the
  automatic part. Secrets are redacted; crawled text is fenced as untrusted data. Website-only audits get a
  remediation brief instead.
- `searvex review <runId|latest> <ref|ruleId> <confirmed|rejected|fixed> [--note]`: records agent/human
  verdicts in `reviews.json`, shown next to (never instead of) the scanner evidence.
- `searvex open [runId|latest]` and `--open`: open the HTML report.
- Automatic fixes for three more rules (12 in total): identical duplicate `<title>` and meta description in
  static HTML (conflicting duplicates become a task), relative hreflang URLs in static HTML (with `--site-url`).
- `run` writes `repository-report.html`; a website report produced with a repository knows that repository
  (prompts target it; real patches count as automatic). `gsc report --audit` refreshes the audit's HTML with
  the verified search data.
- `scripts/screenshots.mjs` captures README screenshots from a real report.

### Changed
- Terminal summary: score, issue types and affected pages, three priorities, automatic fixes, limits and the
  `file://` link of the report — instead of twelve finding lines.
- Claude Code skills answer in 80–150 words with the report link and one next action; no phase-by-phase
  narration, long tables or raw JSON in the chat.
- README rewritten as a visual product page with real report screenshots.

### Fixed
- Optimizer, monorepos: `robots.no-sitemap` generated a second sitemap for an app that already had one, and
  used the single `--site-url` for an app served on another host (found on a real monorepo copy, where the
  patch passed verification but would have published login routes under the wrong host). It now plans only
  for the app the finding is about and turns ambiguous multi-app cases into a reviewed task.

## [1.0.0] - 2026-11-01

First stable release. Every capability advertised as supported has been verified end to end; Bing Webmaster
is the one integration shipped as experimental. Evidence: [docs/release-checklist.md](docs/release-checklist.md)
and [docs/quality.md](docs/quality.md).

### Security and data integrity
- `monitor` no longer attaches search data of another website: `--import`, `--site-url`, `SEARVEX_GSC_SITE`
  and `--baseline` are checked against the monitored site; an export without a pages table needs `--property`.
- Search Console exports whose pages span several subdomains are scoped as domain properties (their totals
  include every subdomain); an explicit `--property` that does not contain every exported page is refused.
- `--render`: a hard per-page deadline stops pages whose scripts never yield or allocate without bound; a
  stuck browser is replaced. Local host names with a trailing dot are blocked.
- Optimizer: backups and the manifest are written before the first file (an interrupted apply is recoverable
  with `rollback`, and new applies are refused until then); a failed verification never overwrites files
  edited meanwhile; CRLF line endings and file modes are preserved.
- Credentials: opt-in OS keychain store (`SEARVEX_CREDENTIAL_STORE=keychain`: macOS Keychain, Secret Service,
  Windows DPAPI) using the OS's own tools with secrets on stdin; entries are isolated per config directory.
  Automated scans confirm that no token, key or client secret reaches output or run files.

### Added
- `searvex bing auth|status|sites|logout` and `searvex crux auth|status|logout`: keys are entered without echo,
  checked against the API and kept in the credential store instead of environment variables.
- `gsc auth` opens the browser for consent (`--no-browser` to only print the URL).
- `THIRD_PARTY_NOTICES.md` with the licence texts of all bundled runtime packages.

### Changed
- Search Console API reports show property totals from the daily series (anonymised queries included), equal
  to the CSV export of the same period. Bing reports use the daily site series for totals and explain empty
  data. `bing report` requires a verified site of the account.
- "Fix first" names the likely root cause of dependent findings (e.g. a client-side language switch that
  changes titles, canonicals and hreflang for renderers) and ranks it first.
- 3-letter hreflang codes without an ISO 639-1 equivalent (`ast`, `ceb`) are reported at low severity with an
  explanation instead of as high-severity mistakes; a finding's severity is its most severe occurrence.
- Status commands (`gsc|bing|crux status`) exit 0 only when the integration is usable.

### Fixed
- Repository mode: test/fixture/benchmark/example folders, HTML fragments and server template folders are not
  treated as the site (a repository without a website now scores n/a); static sites in workspace folders and
  locale sub-folders are found; clean URLs; sitemap URLs without a file (unless another app routes them); all
  Laravel route files; Blade/PHP expressions no longer hide attributes; admin views and tests skipped; error
  pages modelled as 404/500; Next.js fill images and aspect-ratio utility classes are sized; personal sites
  are not asked for Organization markup.
- Website mode: pages linked only through internal redirects are not orphans; orphans are not reported on
  crawls stopped at the page limit; cannibalisation candidates must share a language and exclude legal pages;
  Turkish soft-404 wording is detected (Unicode-aware boundaries).

### Verified
- Live: Search Console API (authorization, refresh, properties, pagination, reports), Search Console CSV
  (real Turkish and English exports), CrUX (values identical to the raw API), Bing Webmaster (mechanics; no
  site data yet). Real-world rounds on 13 public sites and 9 repositories; benchmarks to 50,000 pages;
  reproducible package; clean installs on Linux, macOS and Windows.

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
