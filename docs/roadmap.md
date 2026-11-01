# Roadmap

Development loop for every module: Research → Design → Implement → Test → Audit → Find gaps → Fix →
Retest → Benchmark → Improve. Results are recorded in [quality.md](quality.md) and [progress.md](progress.md).

## Done

- **v0.1–v0.3 — Foundation:** safe fetcher and crawler, sourced rule base with validator, technical /
  structured-data / GEO / content / inventory analyzers, reports (Markdown, HTML, JSON, SARIF), repository mode
  with framework adapters and monorepos, transactional optimizer, Claude Code plugin, CI on three OSes.
- **v0.4–v0.7 — Depth & data:** official-source revalidation, impact-based prioritisation and URL templates,
  facet / pagination detection, internal-link opportunities, inferred search intent, AST-based JS/TS checks,
  Search Console (OAuth and CSV), Bing Webmaster, render isolation through a policy proxy.
- **v1.0 — Release readiness** ([release-checklist.md](release-checklist.md)): property isolation in every
  search-data path, renderer hard deadline, journal-first optimizer, OS keychain credential store, secure key
  storage for Bing and CrUX, live validation of Search Console and CrUX, real-world rounds on the permitted
  product family, independent sites and local repositories, reproducible package, licence notices.

## Next (after v1.0)

Ordered by value; none is promised for a date.

1. **Bing live data check** once the owner's sites have Bing impressions (moves Bing from experimental to
   supported).
2. **Locale-adaptive root-cause view** in the HTML report: group consequences under their cause, not only in
   "Fix first".
3. **Login-protected routes in repository mode** (auth middleware in Laravel / Next.js) so metadata findings
   on private layouts are suppressed.
4. **Astro, Vue SFC and Blade parsing** with real parsers instead of regexes.
5. **Disk-backed analysis** for sites above 50,000 pages.
6. **Optional integrations:** PageSpeed Insights / Lighthouse lab data, GA4 Data API, Yandex Webmaster —
   each only with live validation before it is advertised.
7. **Ecosystem:** GitHub Action with SARIF upload, MCP server exposing the engine, plugin directory
   submission (needs the final brand icon), community rule packs under the same sourcing rules.
