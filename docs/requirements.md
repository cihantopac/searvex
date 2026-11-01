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
| Official source URL + check date per rule | ✅ | 90 rules; validator enforces allowlisted official domains |
| Engine scope (Google/Bing/Yandex/AI) | ✅ | |
| Description, applicability, fix, verification, exceptions | ✅ | |
| Versioned, updatable, conflict detection | ✅ | `conflictsWith`, staleness warnings (>365 days) |
| No myths as rules | ✅ | tests guard key myths |
| Automatic source re-verification (fetch & diff) | ✅ | `searvex rules check-sources` with snapshots (status, final URL, "last updated", content hash, bot-challenge detection) + weekly workflow; 64 sources re-checked 2026-11-01 |

## Analysis engines

| Module | Status | Notes |
|---|---|---|
| Site intelligence: sitemap, robots, links, inventory, page types, languages, structured-data inventory, offerings, organisation relations | ✅ | business model is a scored heuristic with evidence and alternatives |
| HTML vs JS-rendered comparison | ✅ | `--render` via optional Playwright; SPA/SSR/hydration/streaming-metadata tests + CI job |
| Technical SEO (crawl/index/canonical/redirects/hreflang/status/soft 404/duplicates/orphans/metadata/OG/images) | ✅ | |
| Structured data & rich-result eligibility | ✅ | required properties transcribed from Google docs; retired types flagged |
| Core Web Vitals | 🟡 | real field data via CrUX API key; no lab (Lighthouse) integration |
| Mobile, accessibility | 🟡 | viewport, lang, alt, link names; no full a11y audit |
| Pagination, faceted navigation, crawl budget | 🟡 | session/tracking params, depth, parameter-explosion (facet) detection, paginated canonical-to-first; no log-file crawl-budget analysis |
| Market & competitor intelligence | 🟡 | competitor crawl, topic/page-type/schema gaps; brand-family ecosystem analysis; discovery via agent web search; no SERP/volume data |
| Keyword & content intelligence | 🟡 | TF-IDF terms, clusters, cannibalisation, near-duplicates; briefs by agent |
| GEO/AEO | ✅ | crawler purpose matrix, snippet controls, entity consistency, clarity heuristic, honest citation status |
| Optimization engine | ✅ | deterministic fixes for 9 rule types, tasks for judgement calls, dry-run/verify/rollback |
| Analytics & monitoring | 🟡 | run diffs, regressions, Search Console API + CSV import (property-checked), CrUX field data (supported); Bing Webmaster API (experimental); Yandex, GA4 not implemented |

## Platform

| Requirement | Status |
|---|---|
| Windows/macOS/Linux | ✅ CI green on all three × Node 20/22/24 |
| No paid API or server required | ✅ |
| Large sites: queue, cache, checkpoint, resume | ✅ (in-memory analysis measured to 50k pages, 1.1 GB) |
| JSON, Markdown, interactive HTML reports (+SARIF) | ✅ |
| Extensible framework adapters | ✅ (per-app scanners in `src/repo/scan.ts`) |
| Claude Code plugin + standalone CLI | ✅ |

## Security & compliance

| Requirement | Status |
|---|---|
| SSRF, DNS rebinding, redirects to private networks | ✅ (render mode goes through the policy proxy with connection-time DNS checks) |
| Symlinks, path traversal, secret files | ✅ |
| Prompt injection from crawled content | ✅ guidance in skills; content never treated as instructions; HTML report CSP |
| Malicious HTML / XXE / entity expansion | ✅ static parsing, entity processing disabled |
| robots.txt, rate limits, Crawl-delay, Retry-After | ✅ |
| Read-only default, approval for changes | ✅ |
