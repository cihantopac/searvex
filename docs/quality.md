# Quality criteria, test results & benchmarks

Last updated: 2026-10-30 (v0.3.0). Environment: macOS (Apple M4), Node 22.23.2; CI: Linux, macOS, Windows × Node 20/22/24 + Playwright job.

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
| Safe data handling, clean install | SSRF/FS/secret tests; plugin validation; CI clean install from tarball on Linux, macOS, Windows × Node 20/22/24 | ✅ |
| Documented limitations | [limitations.md](limitations.md) | ✅ |

## Automated tests

`npm test` — 187 tests in 13 files (unit, integration, Playwright rendering, E2E on the bundled CLI).

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

Coverage (v8, `src/**`, without the Playwright job): **lines 88.3% · statements 83.7% · functions 87.8% · branches 72.9%**.
Not covered: live Search Console / CrUX API calls.

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

## Real-world validation round 2 — permitted SaaS product family (2026-10-30)

Target: a 7-site product family (company site + 6 products: SaaS apps and a publication), Laravel + Inertia
SSR, Turkish/English. Public crawling was authorised by the owner; raw captures are kept outside this
repository. Settings: ≤ 60 pages per site, 1 s per-host delay, robots.txt honoured. Four audit rounds
(r1 → r4) plus three ecosystem runs; each defect below was verified against the live HTML before fixing
and is covered by an anonymised regression fixture.

| Defect in Searvex (r1) | Evidence | Fix | Effect |
|---|---|---|---|
| hreflang checked on non-canonical `?filter` variants | variants canonicalise to the clean URL | only canonical, indexable pages | 129 false hreflang findings → 0 |
| `/blog?` treated as a different URL from `/blog` | empty query string | normalisation | duplicate records removed |
| Cloudflare `/cdn-cgi/l/email-protection` reported broken (linked from 53 pages) | 404 by design for non-JS clients | excluded | 4 sites: false high finding → 0 |
| Outbound link "broken" (503) | site served 503 to HEAD only | GET confirmation | 4 false findings → 0 |
| Near-duplicates 94–98% on help pages | shared nav/footer and an in-`<main>` category sidebar | main-content extraction + per-section template removal | 42 → 0 and 16 → 0 on two sites; real duplicates still caught (test) |
| "Entity inconsistent" for product vs parent company | WebSite = product, Organization = parent | per-role comparison, top-level nodes | 7 false findings → 0 |
| SaaS apps classified as e-commerce | `Offer` inside `SoftwareApplication` | scored classifier | 3/3 corrected; publication now "publisher" |
| Topic overlap driven by shared footer headings | footer `<h3>` "Product family", "Legal" | headings in site chrome excluded | overlap now reflects content (e.g. two products sharing DNS/domain topics) |
| Turkish "İlgili" tokenised as "lgili" | combining dot after lowercasing | tokenizer fix | Turkish terms intact |
| Schema gaps always empty in research | used retired-type findings | real structured-data inventory | gaps computed from JSON-LD/Microdata/RDFa |

Verified issues Searvex now reports for the owner (examples): duplicate `<title>`/meta description on 257
pages caused by the Inertia head manager (with the framework-specific fix), English pages declaring
`lang="tr"`, untranslated Turkish H1/H2 on English pages, the parent site not declaring its products in
structured data while products declare it as parent, a product site without its own Organization node,
two sites without hreflang while the rest of the family is bilingual.

### Round 3 — rendering and locale probes (2026-10-30)

`--render` on two family sites (15 pages each) and an Accept-Language probe on all seven:
- 6 of 7 sites serve English content on the same URL for `Accept-Language: en-US` (Turkish without the header);
  2 sites also switch language **client-side** for an English browser locale, changing the canonical to the
  `/en/` URL (verified with Playwright using en-US, tr-TR and de-DE). Google documents that locale-adaptive
  pages may not have all locales crawled/indexed → new rule `lang.locale-adaptive` (server and client detection).
- Defect found in Searvex: in render mode the raw-HTML duplicate `<title>` disappeared from the report (the head
  manager removes it after hydration) although non-rendering crawlers still see it → now reported as
  "raw HTML only".
- Raw vs rendered title/canonical differences confirmed on 25 pages (`index.render-mismatch`).

### Round 4 — v0.5.0 features on the same family (2026-10-30)

Seven sites, 40 pages each, 279 pages in total, with probes enabled:
- Internal-link opportunities: the first version suggested links from Turkish pages to English pages, and it
  rated help pages as similar because they shared help-centre template words ("help centre", "categories",
  "topic"). Fixes: pages that declare different languages are never paired; terms that appear on ≥80% of the
  pages in a section are dropped. A 50% cut-off was tried first, but it also dropped the shared subject of a
  topical blog. After the fixes there are 16 suggestions, for example a help article on importing old mail
  linked to the blog post on mail migration (67% similarity). The same pair had been flagged by hand in round 2.
- `ecosystem` had disabled the per-site probes, so `lang.locale-adaptive` (6 of 7 sites) was missing from family
  audits. Probes are now on, and the finding reproduces on exactly the 6 sites verified by hand in round 3.
- The HTML report, `ecosystem.html` and the Templates tab were checked visually in a browser on real data.
- Source re-verification found a knowledge-base citation that had been replaced by a Yandex captcha URL. Bot
  challenges are now detected and never stored.

## Benchmarks

`npm run build && node scripts/benchmark.mjs <pages> <concurrency>` — synthetic site on localhost
(250-word pages, 20 internal links each), no delay.

| Pages | Concurrency | Crawl | Pages/s | Analysis | Peak RSS |
|---|---|---|---|---|---|
| 5,000 | 8 | 3.9 s | 1,272 | 0.7 s | 243 MB |
| 20,000 | 8 | 17.0 s | 1,179 | 3.5 s | 562 MB |
| 20,000 (v0.3.0: template-aware duplicates, hashed shingles) | 8 | 18.7 s | 1,069 | 3.8 s | 584 MB |
| 7-site ecosystem, 40 pages each, real network, 1 s/host delay | parallel | 82 s total | — | — | — |

Real sites are bounded by politeness (per-host delay, Crawl-delay), not by Searvex throughput.
Memory grows ~25 KB/page (stored text capped at 20,000 chars/page).

## Open quality issues

See [progress.md](progress.md#technical-debt--open-issues).
