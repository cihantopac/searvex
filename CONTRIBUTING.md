# Contributing to Searvex

Thanks for helping! Searvex values **accuracy over volume**: a smaller set of correct, sourced checks
beats many speculative ones.

## Setup

```bash
git clone https://github.com/cihantopac/searvex.git
cd searvex
npm ci
npm run build
npm test
```

Node.js ≥ 20.10. (`.npmrc` enables `legacy-peer-deps` because of an npm 10.9 resolver bug with vitest peers.)

## Ground rules

1. **Every rule needs an official source** (see the allowlist in `src/rules/engine.ts`) with a check date,
   the engines it applies to, a fix and a verification step. Blogs, forums and "SEO studies" are not sources.
2. **No myths.** Keyword density, fixed title lengths, meta keywords, llms.txt as a ranking factor, text-to-HTML
   ratios and similar are not rules. When in doubt, open a rule proposal issue first.
3. **Label uncertainty.** Use `confidence: "heuristic"` for inferences; never present estimates as measurements.
4. **Tests with fixtures.** New checks need a fixture that triggers them and a false-positive guard.
5. **Safety.** Network code goes through `safeFetch`; file access through `repo/fs-safe.ts`; writes through
   the optimizer transaction. No telemetry, no new network destinations without opt-in.
6. **Small dependencies.** Prefer Node built-ins; justify any new dependency in the PR.

## Adding a rule

1. Add it to `knowledge/rules/<category>.json`.
2. Implement the check (usually `src/analyze/technical.ts`, `geo.ts`, `content.ts` or `repo/scan.ts`) using `sink.emit('<rule id>', evidence)`.
3. Add the id to `src/rules/implemented.ts`; if the optimizer can fix it, add it to `AUTOFIX_RULES` and set `"autofix": true`.
4. Add tests. Run `npm test` and `node bin/searvex rules validate`.

## Adding a framework adapter

Detection in `src/repo/detect.ts`, scanning in `scanApp` (`src/repo/scan.ts`), fixes using the framework's
own idioms in `src/optimize/fixes.ts`, and a fixture in `test/fixtures/repos/<name>`.

## Before opening a PR

- `npm run typecheck && npm test`
- `npm run bundle` (the committed plugin bundle must match `src/`; CI verifies this)
- Update `CHANGELOG.md` and docs when behaviour changes.
- Releases: bump the version in `package.json`, `.claude-plugin/plugin.json` and `src/net/fetcher.ts` together — installed plugins only update when `plugin.json`'s version changes.

By contributing you agree that your contributions are licensed under Apache-2.0.
