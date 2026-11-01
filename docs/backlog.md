# Backlog

Prioritised list of what must be fixed, built or added. Status: ⬜ open · 🔄 in progress · ✅ done.
Priority: **P0** correctness/reliability · **P1** core value · **P2** product experience · **P3** later.
Each item lists how it will be verified; nothing is marked done without that verification.

## Execution plan (current round)

| Order | Item | Why now | Verification |
|---|---|---|---|
| A | Official-source revalidation (`rules check-sources`) | The rule base is the product's foundation; sources change (FAQ removal, llms.txt statement) | Real run against all source URLs; unit tests with a local server for changed/broken/redirected pages |
| B | Impact-based prioritisation + template grouping | Reports list rules, not what to fix first or where in the templates | Fixture tests; real report on a permitted site |
| C | Search Console: OAuth (installed-app loopback), query/page analysis, keyword→page mapping, data-verified cannibalisation, striking-distance opportunities | First real search-demand data; distinguishes verified demand from inference | Mock API server tests (live API needs the owner's credentials — reported as unverified until then) |
| D | Bing Webmaster API (API key): query and page stats | Second official data source, includes Bing/Copilot visibility context | Mock API server tests; live run needs a key |
| E | Rendering + re-audit round on the permitted product family | Validates rendered-DOM accuracy on real SSR sites | Real `--render` runs, compare raw vs rendered |

## Full backlog

### P0 — Correctness & reliability
| # | Item | Status |
|---|---|---|
| 1 | Source revalidation tool with snapshots (status, final URL, title, "last updated" date, content hash) | ✅ first run found 14 moved sources (Google crawling docs moved to /crawling/); facts re-verified, URLs updated; weekly workflow |
| 2 | Re-read `excerpt`/`url-resolved` sources and upgrade their verification level | ✅ |
| 3 | Real-site `--render` validation round | ✅ found client-side locale switching (canonical → /en/) on 2 sites; new rule lang.locale-adaptive (+ server-side Accept-Language probe); raw-only duplicates kept in render mode |
| 4 | Framework source checks via AST instead of regex (Next.js metadata, Astro props) | ✅ JS/TS/JSX/TSX via @babel/parser (Next.js metadata, JSX img/a/html); Astro, Vue, Blade stay regex-based |
| 5 | Facet / pagination / parameter-explosion detection for large e-commerce | ⬜ |

### P1 — Search data & intelligence
| # | Item | Status |
|---|---|---|
| 6 | GSC OAuth (loopback, read-only scope, refresh-token storage with 0600 permissions) | ✅ verified live 2026-11-01 (OAuth, refresh, sites, report, pagination) |
| 7 | GSC analysis: top queries/pages, CTR vs position outliers, striking distance (pos 8–20), query→page mapping, multi-page queries (data-verified cannibalisation), pages without impressions | ✅ `gsc report` with `--audit` join; traffic-weighted priorities still open |
| 8 | Bing Webmaster API (query/page stats) | ✅ `bing report`, mock-server tested; **live run pending an API key** |
| 9 | GA4 Data API (landing-page sessions / conversions from organic search) | ⬜ |
| 10 | Yandex Webmaster API | ⬜ |
| 11 | Impact-based prioritisation (severity × affected share × page importance × traffic when available) | ✅ score/bucket/effort/reasons; "Fix first" table; traffic input pending GSC |
| 12 | Search-intent classification of pages and queries (rules + agent), separate verified vs inferred | ✅ |
| 13 | Internal-linking opportunities (topic-related pages that do not link to each other; orphans by topic) | ✅ |
| 14 | Deeper competitor research: per-competitor topic clusters, page-type comparison per intent | ⬜ |
| 15 | Bing AI Performance import (CSV) when exported by the user | ⬜ |
| 26 | Property-aware audit joins (GSC/Bing), multi-site regression tests | ✅ v0.7.0 |
| 27 | Search Console CSV/ZIP import (localised headers, decimal commas, filters/period metadata, limits) | ✅ v0.7.0 — verified with real TR and EN exports (2026-11-01) |
| 28 | Onboarding: `connect` with Google / CSV / skip, per-site preference, "Not measured" in summaries | ✅ v0.7.0 |
| 29 | OAuth hardening: revoke on logout, CI guard, Desktop-client check, invalid_grant guidance, credential store interface | ✅ v0.7.0 — live except revoke (mock-tested) |
| 30 | OS keychain credential backend (macOS Keychain, Windows DPAPI, libsecret) | ✅ v1.0 round — opt-in `SEARVEX_CREDENTIAL_STORE=keychain` |
| 33 | `monitor --import/--site-url/--baseline` property checks (tech debt #17) | ✅ v1.0 round |
| 34 | Renderer hard deadline for busy-loop / memory-growth pages | ✅ v1.0 round |
| 35 | Optimizer journal (interrupted apply), no forced auto-undo, CRLF and file modes | ✅ v1.0 round |
| 31 | Playwright isolation round (WebSocket/WebRTC, redirect hops, per-site contexts, process limits) | ✅ v0.7.0 — policy proxy, fresh context per page, sandbox when available |
| 32 | Docs consistency checks (versions, commands, env vars) | ✅ v0.7.0 |

### P2 — Product experience
| # | Item | Status |
|---|---|---|
| 16 | Template-level issue grouping (URL-pattern clusters) in reports | ✅ URL-pattern templates per finding (DOM-structure clustering still open) |
| 17 | HTML dashboard: charts, template view, monitor before/after, ecosystem view | ✅ |
| 18 | Disk-backed analysis for >50k pages | ⬜ |
| 19 | GitHub Action wrapper + SARIF upload example tested | ⬜ |
| 20 | MCP server exposing the engine | ⬜ |
| 21 | Plugin icon (512 px) for directory submission | ⬜ |
| 22 | Lighthouse lab metrics on sampled templates (optional dependency) | ⬜ |

### P3 — Later
| # | Item | Status |
|---|---|---|
| 23 | WordPress block themes, SvelteKit, Remix adapters and fixes | ⬜ |
| 24 | Localised report text | ⬜ |
| 25 | Community rule packs with the same sourcing rules | ⬜ |
