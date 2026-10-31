# Progress log (resume point)

Use this file to resume work after an interrupted session. Newest entries first.

## Current state — 2026-10-30

- Version 0.7.0 (branch `feat/v0.7-data-integrity`, PR pending owner merge): property-aware search-data
  joins, Search Console CSV/ZIP import, `connect` onboarding (Google ile bağlan / CSV içe aktar / Şimdilik
  geç), OAuth hardening (revoke, CI guard, client-type check), shared-query classification, docs consistency
  test; render isolation via a policy proxy; 282 tests; 90 rules.
- Product decisions (2026-10-30, owner accepted the recommended defaults): plugin + CLI first, no hosted
  services; file credential store behind an interface (keychain later); integration order GSC live → CSV →
  Bing live → CrUX/PSI → GA4 → Yandex; Bing via API key; no paid SERP/AI providers; branch + PR per
  milestone, owner merges; no npm publish or release without approval.
- Continuous real-world validation target: a permitted 7-site SaaS product family (owner-authorised). Raw
  captures stay outside the repository (scratch space); fixtures are anonymised.
- Plugin updates require a version bump in `.claude-plugin/plugin.json` (installed copies are pinned to that version).
- Build: `npm run build` (tsc → `dist/`, esbuild → `dist/searvex.mjs`). The bundle is committed for the plugin.
- Validate: `npm test`, `node bin/searvex rules validate`, `claude plugin validate .`.
- Real-world validation done on 6 sites and 4 open-source repositories ([quality.md](quality.md)).
- GitHub: https://github.com/cihantopac/searvex (**public** since 2026-10-30). No npm publish or GitHub release yet (needs owner approval).
- CI green on Linux, macOS and Windows × Node 20/22/24, plus bundle-in-sync, plugin validation and clean
  install from the packed tarball. The first Windows run caught a real bug (monorepo app roots built with
  `path.join` → backslashes → apps analysed as empty), fixed in 6a2505b.

### How to resume

1. `npm ci --legacy-peer-deps` (npm 10.9 arborist bug with vitest peer deps; see below).
2. `npm run build && npm test`.
3. Pick the next item from [roadmap.md](roadmap.md) Phase 2 or the open issues below.
4. After changes to `src/`, run `npm run bundle` so the plugin bundle stays in sync (CI checks this).

## Session log

### 2026-11-01 — product-family round 7 (render)
- `--render` on the 7 sites: client-side switch to English for en-US browsers on 6 sites (Turkish blog posts
  render "not found" on one), confirmed in a real browser. Fixed: Turkish soft-404 wording (Unicode
  boundaries), root-cause linking in "Fix first", no orphans on truncated crawls.

### 2026-11-01 — product-family round 7 (raw)
- 7 permitted sites re-audited; 4 Searvex defects fixed (orphans through redirects, cross-language and legal
  cannibalisation, aspect-ratio utility classes), regression fixtures in `website-realworld.test.ts`; re-run
  compared before/after. Real site defects listed in quality.md for the owner. `--render` round still open.

### 2026-11-01 — live Bing Webmaster API
- `bing auth/status/sites/logout` added (hidden key input, credential store); reports require a verified
  site; totals from the daily site series; empty data explained; actionable InvalidApiKey/quota errors.
- Live on 8 verified sites: everything works, but Bing has 0 impressions for all of them so far, so the
  parsing of real query/page rows is not verified live. Bing stays **experimental**; re-run
  `bing report` on one of the sites in a few weeks and compare with Bing Webmaster Tools' UI.

### 2026-11-01 — live Search Console API
- Owner authorised with their own Desktop client; credential in the macOS Keychain. Verified live (quality.md):
  refresh, property list, report, pagination, CSV parity, audit join, error messages, 0 secrets in output.
- Fixed: API totals now include anonymised queries (daily series); keychain entries isolated per config dir
  (a test run had deleted the real credential — owner re-authorised); `gsc auth` opens the browser.
- Not run live: `gsc logout` revocation (owner kept the grant). Search Console API is now **supported**;
  Bing and CrUX remain experimental.

### 2026-11-01 — first real Search Console export (Turkish UI)
- Real domain-property export ("Son 3 ay", 7 CSVs) imported end to end; totals cross-checked against the
  devices and countries tables (identical), row counts against Python's csv module (identical).
- Real format differs from the earlier guesses ("Pozisyon", "En alakalı sayfalar", dot decimals, dates in
  `Grafik.csv`); all were already recognised. Fixtures now follow the real structure.
- Fixed (data integrity): pages of several subdomains were attributed to the most common host; such an export
  can only come from a domain property and is now scoped as `sc-domain:`. An explicit `--property` that does
  not contain every page of the export is refused (a URL-prefix property never exports other hosts).
- English-UI export of the same property (`Chart.csv`, `Top queries`, `Filter,Value`): imported without
  warnings; property, period, totals, top queries/pages, striking distance and intent mix identical to the
  Turkish export. CSV import is now **supported**; GSC API, Bing and CrUX stay experimental.
- The raw exports stay in `.searvex/fixtures-private/` (git-ignored).

### 2026-11-01 — local repository round
- Audited 5 local repositories read-only (quality.md round 6); fixed 11 repository-mode defects (non-site
  folders, workspace static sites, clean URLs, missing sitemap URLs vs routes of other apps, all Laravel route
  files, Blade expressions in tag regexes, admin views, error pages, Next.js fill images, personal-site
  Organization exception, n/a score when there is nothing to audit). The product-family repositories are on
  the owner's Windows PC; audit them there or copy them here.
- Live integrations: still waiting for the owner's accounts (owner guide).

### 2026-10-31 — v1.0.0 readiness round (branch `release/v1.0-readiness`)
- Release checklist with evidence per criterion: [release-checklist.md](release-checklist.md).
- Fixed (P0): `monitor --import` accepted exports of any website (and queries-only exports with no way to
  attribute them); `--site-url`/`SEARVEX_GSC_SITE` and `--baseline` were not checked against the monitored
  site. Shared `propertyForExport` / `assertAuditInProperty` now serve `gsc import` and `monitor`.
- Fixed (P0): a page whose scripts never yield hung `--render` indefinitely (reproduced: > 40 s, never
  returned). Hard per-page deadline, bounded context/browser close, browser restart.
- Fixed (P0): optimizer wrote its manifest only after all files (a crash left untracked edits); failed
  verification force-overwrote files edited during verification; CRLF files got LF insertions; file modes
  were reset. Journal-first apply, `applying` state, recovery via `rollback`.
- Verified without change: SSRF numeric/IPv6/NAT64 encodings, connection-time DNS validation against
  rebinding names (`*.nip.io` → 0 requests reached the local server).

### 2026-10-30 — v0.7.0 data integrity round
- Assessment found: `--audit latest` ignored the property (could join another site's audit); CSV import only
  in `monitor`, English headers only, silent zero rows for localised exports; `gsc logout` did not revoke;
  shared queries labelled "data-verified cannibalisation"; docs stuck at v0.3.0 facts.
- Fixed all of the above with regression tests (multi-site workspace, TR/EN exports, ZIP limits, revoke,
  CI guard, shared-query patterns) and an automated docs consistency test.
- Real-site round 5 (see quality.md) found and fixed legal pages classified as `other`.
- Playwright isolation: a counter test proved redirect-hop, WebSocket and popup escapes; fixed with a
  local policy proxy (all browser traffic, connection-time DNS), WebRTC limited to proxied traffic, fresh
  context per page, sandbox when available. Real render round on three permitted sites: no false blocks,
  sandbox active on macOS, ~1.7 s per page; locale-adaptive and Inertia findings reproduced.
- Not done yet (next): live GSC/Bing/CrUX validation once the owner's credentials exist, OS keychain
  backend, GA4/Yandex, PSI/Lighthouse.

### 2026-10-30 — round 2 of the backlog (v0.5.0)
- F: `crawl.facet-explosion`, `pagination.canonical-to-first`.
- G: internal-link opportunities (topic vectors, no link either way, stronger → weaker page). The real-site
  round caught cross-language pairs and help-centre template words inflating similarity; both fixed.
- H: inferred search intent for queries (multilingual cues) and pages (page type), intent mismatches in
  Search Console/Bing reports.
- J: every `excerpt`/`url-resolved` citation re-read; 146/148 now `fetched`. Found and fixed a citation that an
  earlier snapshot update had replaced with a Yandex captcha URL; bot challenges are now detected.
- K: HTML charts, Templates tab, `monitor.html`, `ecosystem.html` (executed in Chromium in tests).
- `ecosystem` now runs the per-site probes (Accept-Language etc.); without them the locale-adaptive finding
  was missing from family audits.
- I (approved, v0.6.0): AST-based checks for JS/TS sources with @babel/parser 7.29.9 (Babel 8 needs Node
  ≥22.18; Searvex supports Node 20). Bundle 1.10 MB → 1.68 MB. On Vercel Commerce the first version missed
  3 pages because `return notFound()` was read as an unknown return; such throwing branches are now ignored.

### 2026-10-30 — backlog round (after v0.3.0)
- A: `rules check-sources` + weekly workflow; first run caught 14 moved sources (Google crawling docs moved to
  developers.google.com/crawling/); facts re-verified, URLs updated.
- B: impact-based prioritisation (Fix first table) and URL-template grouping.
- C: Search Console OAuth (loopback + PKCE) and `gsc report` (mock-tested; live run needs owner credentials).
- D: `bing report` via Bing Webmaster API (mock-tested; live run needs an API key).
- E: real `--render` round → `lang.locale-adaptive`, raw-only duplicates in render mode.

### 2026-10-30 — continuous improvement round (v0.3.0)
- Audited the permitted product family 4 times + 3 ecosystem runs; fixed 12 verified defects (see
  quality.md, round 2); added ecosystem command, language checks, structured-data inventory, scored business
  model, renderer hardening (link-local always blocked, popups, resource caps, bounded waits).
- Next candidates: Search Console OAuth helper and query/page analysis, Bing Webmaster API, keyword-to-page
  mapping with GSC data, template clustering in reports, source re-verification tool, HTML dashboard.

### 2026-10-30 — initial build
- Research: name availability, competitor landscape, Claude Code plugin format, official search-engine
  sources (docs/research/).
- Built core engine, rule base (84 rules), analyzers, reports, repository mode, optimizer, plugin, docs, CI.
- Real-world validation fixed 12 defects (redirect records analysed as pages, glued text extraction,
  hreflang targets not crawled, SVG titles, accessible names/shadow DOM, card links, start-URL errors,
  TTFB, Next.js streaming metadata context, soft-404 on noindex, sitemap rate limiting, Astro spread props,
  `.searvex` dirtying git status, monorepo apps skipped, origin inference, double counting).

## Technical debt & open issues

| # | Item | Impact | Plan |
|---|---|---|---|
| 2 | Render tests rely on local fixtures; no real-site render validation round yet | rendered-DOM accuracy on complex sites | run `--render` rounds on permitted sites |
| 3 | Two citations still `url-resolved` (`canonical.target-error`, `sd.invalid-json`); Bing help pages are client-rendered, so the source checker cannot hash them | rule-text accuracy | find pages that state the claims; browser re-read on each review |
| 4 | Astro, Vue SFC, Blade and PHP checks still use regexes (JS/TS use an AST since v0.6.0) | edge-case false positives/negatives | parse Astro frontmatter and Vue `<script>` with the same parser |
| 5 | In-memory analysis | >50k pages heavy | streaming / disk indexes |
| 7 | Research has no demand data | gaps ≠ opportunities | optional data providers, user CSV import |
| 8 | `npm install` needs `--legacy-peer-deps` (npm 10.9 arborist `edgesOut` crash with vitest 5 peers) | contributor friction | track npm fix; `.npmrc` sets legacy-peer-deps |
| 9 | Plugin icon missing (directory warning) | listing only | add 512 px PNG before directory submission |
| 10 | Each user needs their own Google Cloud Desktop OAuth client | setup friction | CSV import as the no-account path; hosted OAuth only with a future SaaS (owner decision) |
| 16 | Render mode residual risk: browser zero-days; no OS sandbox in some containers; CPU-heavy scripts only bounded by the page timeout | renderer compromise on hostile sites | consider a separate low-privilege process/container option; documented in security.md |
| 18 | Search Console exports in UI languages other than Turkish and English not checked against a real download | those imports may need synonyms | real exports when users report them |
| 11 | Entity/answerability signals are heuristics | could be over-read | keep `info`, documented |
| 13 | Language detector covers 8 languages, ~30-word minimum | other locales not judged | extend word lists / n-gram model |
| 14 | Cannibalisation uses title/H1 terms only | misses body-level intent overlap | combine with GSC query data |
| 15 | Ecosystem topic overlap is term-based | not demand-based | add GSC query overlap when tokens available |
| 12 | Trademark clearance not done | legal risk | professional search before registering marks/domains |
