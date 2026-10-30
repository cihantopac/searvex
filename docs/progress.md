# Progress log (resume point)

Use this file to resume work after an interrupted session. Newest entries first.

## Current state — 2026-10-30

- Version 0.2.0 (adds `searvex run` / 7-phase `/searvex` workflow); 160 tests passing; lines coverage 87%.
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
| 2 | `--render` (Playwright) untested in CI | JS-site comparison unverified | add CI job + fixtures |
| 3 | Bing help pages verified only via excerpts; some sources `url-resolved` | rule-text accuracy | manual re-read; source checker |
| 4 | Framework source checks use regexes (Next.js metadata, Blade, Astro) | edge-case false positives/negatives | move to AST (TypeScript compiler API) for JS/TS |
| 5 | In-memory analysis | >50k pages heavy | streaming / disk indexes |
| 6 | No facet/pagination detection | e-commerce crawl-budget advice missing | phase 2 |
| 7 | Research has no demand data | gaps ≠ opportunities | optional data providers, user CSV import |
| 8 | `npm install` needs `--legacy-peer-deps` (npm 10.9 arborist `edgesOut` crash with vitest 5 peers) | contributor friction | track npm fix; `.npmrc` sets legacy-peer-deps |
| 9 | Plugin icon missing (directory warning) | listing only | add 512 px PNG before directory submission |
| 10 | GSC token must be obtained externally | setup friction | device-flow helper |
| 11 | Entity/answerability signals are heuristics | could be over-read | keep `info`, documented |
| 12 | Trademark clearance not done | legal risk | professional search before registering marks/domains |
