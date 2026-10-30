# Requirements & status

Status legend: ✅ implemented and tested · 🟡 partial · ⬜ not started. "Tested" means automated
tests plus, where noted, real-world validation ([quality.md](quality.md)).

## Modes

| Requirement | Status | Notes |
|---|---|---|
| Website mode: crawl any public URL, inventory pages, audit | ✅ | robots.txt, sitemaps, queue, checkpoint/resume |
| Repository mode: understand project, find issues with file:line | ✅ | Next.js (app/pages), Astro, Nuxt, Laravel, WordPress (classic themes), Vite/CRA SPA, static HTML, monorepos |
| Verified vs estimated data separated | ✅ | `confidence` on every finding; limitations section |

## Search knowledge engine

| Requirement | Status | Notes |
|---|---|---|
| Official source URL + check date per rule | ✅ | 84 rules; validator enforces allowlisted official domains |
| Engine scope (Google/Bing/Yandex/AI) | ✅ | |
| Description, applicability, fix, verification, exceptions | ✅ | |
| Versioned, updatable, conflict detection | ✅ | `conflictsWith`, staleness warnings (>365 days) |
| No myths as rules | ✅ | tests guard key myths |
| Automatic source re-verification (fetch & diff) | ⬜ | manual process today ([knowledge-base.md](knowledge-base.md)) |

## Analysis engines

| Module | Status | Notes |
|---|---|---|
| Site intelligence: sitemap, robots, links, inventory, page types, languages | ✅ | business model is a labelled heuristic |
| HTML vs JS-rendered comparison | 🟡 | `--render` via optional Playwright; not exercised in CI |
| Technical SEO (crawl/index/canonical/redirects/hreflang/status/soft 404/duplicates/orphans/metadata/OG/images) | ✅ | |
| Structured data & rich-result eligibility | ✅ | required properties transcribed from Google docs; retired types flagged |
| Core Web Vitals | 🟡 | real field data via CrUX API key; no lab (Lighthouse) integration |
| Mobile, accessibility | 🟡 | viewport, lang, alt, link names; no full a11y audit |
| Pagination, faceted navigation, crawl budget | 🟡 | session/tracking params, depth; no facet detection yet |
| Market & competitor intelligence | 🟡 | competitor crawl & gap analysis; discovery via agent web search; no SERP/volume data |
| Keyword & content intelligence | 🟡 | TF-IDF terms, clusters, cannibalisation, near-duplicates; briefs by agent |
| GEO/AEO | ✅ | crawler purpose matrix, snippet controls, entity consistency, clarity heuristic, honest citation status |
| Optimization engine | ✅ | deterministic fixes for 9 rule types, tasks for judgement calls, dry-run/verify/rollback |
| Analytics & monitoring | 🟡 | run diffs, regressions, GSC API (token) + CSV import; Bing/Yandex/GA4 APIs ⬜ |

## Platform

| Requirement | Status |
|---|---|
| Windows/macOS/Linux | 🟡 CI matrix configured; locally verified on macOS only |
| No paid API or server required | ✅ |
| Large sites: queue, cache, checkpoint, resume | ✅ (in-memory analysis tested to 20k pages) |
| JSON, Markdown, interactive HTML reports (+SARIF) | ✅ |
| Extensible framework adapters | ✅ (per-app scanners in `src/repo/scan.ts`) |
| Claude Code plugin + standalone CLI | ✅ |

## Security & compliance

| Requirement | Status |
|---|---|
| SSRF, DNS rebinding, redirects to private networks | ✅ (render mode: residual rebinding window, documented) |
| Symlinks, path traversal, secret files | ✅ |
| Prompt injection from crawled content | ✅ guidance in skills; content never treated as instructions; HTML report CSP |
| Malicious HTML / XXE / entity expansion | ✅ static parsing, entity processing disabled |
| robots.txt, rate limits, Crawl-delay, Retry-After | ✅ |
| Read-only default, approval for changes | ✅ |
