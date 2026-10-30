# Progress log (resume point)

Use this file to resume work after an interrupted session. Newest entries first.

## Current state — 2026-10-30

- Version 0.3.0: ecosystem analysis, structured-data inventory, content-language checks, template-aware
  duplicates, Playwright rendering tests + CI job; 187 tests; lines coverage 88%; 86 rules.
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
| 3 | Bing help pages verified only via excerpts; some sources `url-resolved` | rule-text accuracy | manual re-read; source checker |
| 4 | Framework source checks use regexes (Next.js metadata, Blade, Astro) | edge-case false positives/negatives | move to AST (TypeScript compiler API) for JS/TS |
| 5 | In-memory analysis | >50k pages heavy | streaming / disk indexes |
| 6 | No facet/pagination detection | e-commerce crawl-budget advice missing | phase 2 |
| 7 | Research has no demand data | gaps ≠ opportunities | optional data providers, user CSV import |
| 8 | `npm install` needs `--legacy-peer-deps` (npm 10.9 arborist `edgesOut` crash with vitest 5 peers) | contributor friction | track npm fix; `.npmrc` sets legacy-peer-deps |
| 9 | Plugin icon missing (directory warning) | listing only | add 512 px PNG before directory submission |
| 10 | GSC token must be obtained externally | setup friction | device-flow helper |
| 11 | Entity/answerability signals are heuristics | could be over-read | keep `info`, documented |
| 13 | Language detector covers 8 languages, ~30-word minimum | other locales not judged | extend word lists / n-gram model |
| 14 | Cannibalisation uses title/H1 terms only | misses body-level intent overlap | combine with GSC query data |
| 15 | Ecosystem topic overlap is term-based | not demand-based | add GSC query overlap when tokens available |
| 12 | Trademark clearance not done | legal risk | professional search before registering marks/domains |
