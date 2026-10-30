# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
