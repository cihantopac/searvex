# Architecture

Searvex is a TypeScript/Node.js (≥ 20.10) tool chain with three runtime dependencies
(`cheerio`, `parse5` + tree adapter, `fast-xml-parser`, `robots-parser`). Everything else uses
Node built-ins (`node:http(s)`, `node:dns`, `node:zlib`, `util.parseArgs`).

```
src/
├── cli.ts                  argument parsing, command routing, exit codes (0 ok · 1 gate failed · 2 usage/error)
├── index.ts                public library API
├── core/                   shared types (Finding, Evidence, SourceRef…), URL normalisation
├── net/
│   ├── ssrf.ts             IP classification (v4/v6, mapped, NAT64), URL policy
│   └── fetcher.ts          safeFetch: guarded DNS lookup, manual redirects, caps, decompression, TTFB; HostRateLimiter
├── crawl/
│   ├── robots.ts           RFC 9309 behaviour, AI crawler table (purpose + official docs)
│   ├── sitemap.ts          sitemap/index parsing (XXE-safe), limits
│   ├── crawler.ts          BFS queue, worker pool, per-host politeness, checkpoints, resume
│   ├── render.ts           optional Playwright renderer with request-level SSRF checks
│   └── store.ts            .searvex/runs/<id>/ (JSONL + atomic JSON), self-ignored
├── extract/html.ts         parse5 (WHATWG tree construction) → cheerio queries → PageData
├── analyze/
│   ├── context.ts          indexes: byUrl, inlinks, indexable pages, homepage
│   ├── technical.ts        page- and site-level technical checks
│   ├── structured-data.ts  JSON-LD walk, Google required properties, retired types
│   ├── geo.ts              crawler purpose matrix, snippet controls, entities, clarity heuristic
│   ├── content.ts          TF-IDF, clusters, cannibalisation, MinHash/LSH near-duplicates
│   ├── inventory.ts        page types (schema > URL patterns), languages, business model heuristic
│   ├── external-links.ts   robots-aware outbound link checks
│   └── audit.ts            orchestration, probes (http→https, www, llms.txt), scoring
├── repo/
│   ├── fs-safe.ts          root-confined, symlink-free, secret-free file access
│   ├── detect.ts           framework + monorepo workspace detection
│   ├── scan.ts             per-app scanners; static HTML → synthetic crawl
│   └── audit.ts            repository report (reuses website analyzers)
├── optimize/
│   ├── fixes.ts            deterministic planners + agent tasks
│   ├── diff.ts             Myers line diff → unified patches
│   └── transaction.ts      apply with backups/hashes, conflict detection, rollback
├── rules/engine.ts         knowledge base loader, validator, FindingSink
├── integrations/           CrUX, Search Console, CSV import
├── report/                 markdown, html (XSS-safe), sarif
└── commands/               research, monitor, optimize/rollback, repo
knowledge/rules/*.json      the sourced rule base (data, not code)
skills/, agents/            Claude Code plugin components
```

## Key decisions

| Decision | Why |
|---|---|
| Rules are JSON data; checks are code; findings can only be emitted for rules in the KB | Every finding is traceable to an official source; unknown rule ids throw. |
| `FindingSink` groups evidence per rule | Reports stay readable on large sites; counts remain exact. |
| parse5 tree construction instead of a lenient parser | Matches how browsers/Googlebot build the DOM (e.g. a canonical after an invalid head element lands in `<body>` and is ignored by Google). |
| Connection-time DNS validation (`lookup` hook) | Closes the DNS-rebinding window of validate-then-connect. |
| Redirects followed manually | Each hop is re-validated and recorded for chain analysis. |
| Redirecting URLs are not analysed as pages | Their content belongs to the target; prevents false duplicate findings (found in real-world validation). |
| Repository mode reuses website analyzers through a synthetic crawl | One implementation of each check, consistent results across modes. |
| Site origin inferred from canonical/og:url/hreflang in repositories | Avoids false cross-domain canonical findings without `--site-url`. |
| Monorepos: one `AppScan` per detected app | Fixes are planned with the owning app's framework idioms. |
| Optimizer fixes only unambiguous changes | Titles, descriptions, alt text and content need judgement → agent tasks requiring approval. |
| Transactions store original content + hashes | Rollback refuses to overwrite edits made after the change (unless forced). |
| Single-file bundle (`dist/searvex.mjs`) committed for the plugin | Plugins do not run `npm install`; bundle is ~1 MB and unminified for auditability. |
| Health score documented as a Searvex summary | Prevents it being read as a Google metric. |

## Data flow (website audit)

1. `fetchRobots` (RFC 9309 semantics) → crawl-delay → limiter.
2. Sitemaps (rate-limited) seed the queue; start URL seeded at depth 0.
3. Workers fetch with `safeFetch`, parse with `extractPage`, enqueue internal links + canonical/hreflang targets.
4. Records are appended to `pages.jsonl`; `checkpoint.json` every N pages enables `--resume`.
5. `analyzeCrawl` builds a `SiteContext`, runs probes and analyzers, computes scores, records limitations.
6. Reports are rendered from the JSON report (re-renderable later with `searvex report`).

## Extension points

- **New rule:** add to `knowledge/rules/<category>.json` with sources → implement check in an analyzer →
  add to `src/rules/implemented.ts` → add fixture + test. `searvex rules validate` and the consistency test
  enforce the link.
- **New framework adapter:** add detection in `repo/detect.ts`, a `case` in `scanApp`, idiom-aware fixes
  in `optimize/fixes.ts`, and a fixture under `test/fixtures/repos/`.
- **New integration:** keep it read-only and opt-in via environment variables; report "not measured" when absent.
