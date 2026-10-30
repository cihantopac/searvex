# Quality criteria, test results & benchmarks

Last updated: 2026-10-30 (v0.1.0). Environment: macOS (Apple M4), Node 22.23.2.

## Criteria (definition of done)

| Criterion | Evidence | Status |
|---|---|---|
| End-to-end analysis from URL and from repository | E2E tests on bundled CLI; real sites & repos below | ✅ |
| Sourced, current rule base | 84 rules, 0 validation errors; official-domain allowlist; check dates 2026-10-30 | ✅ |
| Accurate inventory and technical findings | Planted-issue fixtures (23 expected + 9 false-positive guards); real-site review | ✅ (see open issues) |
| Prioritised recommendations from real data | severity × affected share; verified/heuristic/unmeasurable labels | ✅ |
| Safe, tested code optimisation | apply → verify → rollback tests incl. byte-for-byte restore, conflict detection | ✅ |
| Before/after verification and rollback | automatic verification with auto-rollback; manifest hashes | ✅ |
| Measurable coverage, benchmarks | below | ✅ |
| Usable reports and UX | MD/HTML/JSON/SARIF; real Claude Code plugin run | 🟡 more user testing needed |
| Safe data handling, clean install | SSRF/FS/secret tests; plugin validation passes | 🟡 Windows/Linux not yet run locally (CI matrix configured) |
| Documented limitations | [limitations.md](limitations.md) | ✅ |

## Automated tests

`npm test` — 159 tests in 9 files (unit, integration, E2E on the bundled CLI).

| Area | What is tested |
|---|---|
| SSRF | 22 address classes (v4/v6/mapped/NAT64), 12 blocked URL forms, connection-time loopback block, redirect-to-metadata block, size cap, redirect loops, timeouts |
| Parsing | URL normalisation, robots longest-match/wildcards/groups, sitemap index/alternates/XXE, HTML5 tree construction, SVG titles, accessible link names, shadow DOM text, X-Robots-Tag, hreflang codes, Google required properties, CSV, diff, tokenizer |
| Website audit | Synthetic e-commerce site with 23 planted issues + 9 false-positive guards; robots compliance (disallowed URL never fetched); user agent; inventory; crawler purposes; redirect hops |
| Crawler | Checkpoint/resume without refetch, robots 5xx → full disallow, start-URL 404 → critical |
| Integrations | External links (robots-aware, 403 not "broken"), CrUX parsing/thresholds, monitor regressions |
| Repository | 6 framework fixtures + monorepo, origin inference, network rules excluded, spread props |
| Optimizer | static/Laravel/WordPress/Next.js fixes, byte-for-byte rollback, plan conflicts, rollback conflicts, CLI dry-run/apply/rollback, secret & traversal refusal |
| Rule base | validation, sources, implementation consistency, autofix consistency, myth guards, stale warnings, scoring |
| Reports | HTML inert embedding of hostile content, Markdown escaping, SARIF structure |

Coverage (v8, `src/**`): **lines 87.0% · statements 81.6% · functions 85.4% · branches 71.1%**.
Not covered: Playwright renderer (optional dependency), live Search Console API calls.

## Real-world validation (2026-10-30)

Polite settings: ≤ 25 pages per site, 1 s per-host delay, robots.txt honoured (Apache's `Crawl-delay: 4`
was applied automatically).

| Site (type) | Result | Defects found in Searvex → fixed |
|---|---|---|
| apache.org (corporate) | `apache.org` and `www.apache.org` both 200 (verified true), uncrawlable `href="#"` links, missing alt | — |
| wikipedia.org (multilingual portal) | single portal page (language links are other hosts); declared sitemap 403 | false `title.multiple` (SVG titles) |
| developer.mozilla.org (docs/blog) | **real issue found: `/en-US/404` is listed in MDN's sitemap** and is noindexed | false `title.multiple` (4 of 5 titles inside SVG); 71 false empty anchors (aria-labelledby, declarative shadow DOM, card links) → 4 → 0 after card-pattern rule; soft-404 on a noindexed page; sitemap fetches were not rate-limited |
| linear.app (JS-heavy SaaS, Next.js) | canonical streamed into `<body>` | now explained as Next.js streaming metadata (UA-dependent) and marked heuristic |
| demo.vercel.store (e-commerce demo) | start URL returns 404 (site removed) | previously scored 99 with no critical finding → new rule `http.start-url-error` |
| overreacted.io (blog) | no canonicals, no sitemap, no H1 on homepage | `perf.slow-ttfb` measured full response → TTFB now measured separately |

Repository mode on real open-source projects:

| Repository | Result | Defects found → fixed |
|---|---|---|
| vercel/commerce (Next.js app router) | 5 routes; no canonical metadata anywhere (verified by grep); sitemap/robots routes recognised | — |
| laravel/laravel (skeleton) | missing description & canonical; robots.txt without sitemap. `optimize --apply` → verified (1 → 0) → rollback left a clean git tree | `.searvex/` made the tree dirty → now self-ignored |
| Automattic/_s (WordPress starter theme) | no findings — theme declares title-tag, language_attributes, viewport, wp_head | — |
| withastro/astro examples/blog | no findings | false `title.missing` for `<Layout {...post.data}>` spread props → treated as unknown |

Claude Code plugin: loaded with `claude --plugin-dir .` (6 skills, 2 agents, ~588 always-on tokens);
`/searvex:audit` executed end-to-end with a real model and produced a correct, sourced summary. That run
exposed missing autofix information → now shown in reports and `rules show`, and KB flags are test-locked
to optimizer capabilities.

## Benchmarks

`npm run build && node scripts/benchmark.mjs <pages> <concurrency>` — synthetic site on localhost
(250-word pages, 20 internal links each), no delay.

| Pages | Concurrency | Crawl | Pages/s | Analysis | Peak RSS |
|---|---|---|---|---|---|
| 5,000 | 8 | 3.9 s | 1,272 | 0.7 s | 243 MB |
| 20,000 | 8 | 17.0 s | 1,179 | 3.5 s | 562 MB |

Real sites are bounded by politeness (per-host delay, Crawl-delay), not by Searvex throughput.
Memory grows ~25 KB/page (stored text capped at 20,000 chars/page).

## Open quality issues

See [progress.md](progress.md#technical-debt--open-issues).
