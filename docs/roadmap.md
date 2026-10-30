# Development plan

Development loop for every module: Research → Design → Implement → Test → Audit → Find gaps → Fix →
Retest → Benchmark → Improve. Results are recorded in [quality.md](quality.md) and [progress.md](progress.md).

## Phase 1 — Foundation (done, v0.1.0)

Safe fetcher and crawler · sourced rule base with validator · technical/structured-data/GEO/content/
inventory analyzers · reports (MD/HTML/JSON/SARIF) · repository mode with 7 framework families and
monorepos · transactional optimizer · Claude Code plugin · real-site and real-repo validation · CI.

## Phase 2 — Depth & data (next)

Ordered by value / dependency:

1. **Cross-platform verification:** run the CI matrix (Windows/Linux) and fix path/line-ending issues.
2. **Rule re-verification tooling:** `searvex rules check-sources` that fetches sources and flags changes;
   re-verify `excerpt`/`url-resolved` sources.
3. **Rendering in CI:** Playwright job; raw-vs-rendered fixtures (SPA, streaming metadata).
4. **Faceted navigation & pagination detection;** crawl budget heuristics for large e-commerce.
5. **Lighthouse integration (optional dependency)** for lab CWV on sampled templates.
6. **Search data integrations:** Bing Webmaster API (AI Performance when an API exists), Yandex Webmaster,
   GA4 Data API; OAuth device-flow helper (read-only scopes).
7. **More framework adapters & fixes:** SvelteKit, Remix, Nuxt fixes, WordPress block themes, Hugo; Next.js
   `metadataBase`/canonical codemods using the TypeScript AST instead of regexes.
8. **Template clustering:** group pages by DOM structure to report issues per template, not per URL.
9. **Streaming analysis** for >50k-page sites (disk-backed indexes).
10. **HTML report UX:** charts, per-template views, diff view for monitor.

## Phase 3 — Ecosystem

GitHub Action, MCP server exposing the engine, community rule packs (with the same sourcing rules),
localisation of report text, plugin directory submission (needs a 512 px icon).
