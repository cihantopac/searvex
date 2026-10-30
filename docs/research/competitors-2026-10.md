# Competitor & OSS landscape (2026-10-30)

| Tool | Type | Strengths | Gaps |
|---|---|---|---|
| Screaming Frog SEO Spider | Commercial desktop (+CLI) | Deep crawling, custom extraction, JS rendering | GUI-first, report-only, no repo awareness, closed rules; free ≤500 URLs |
| Sitebulb | Commercial desktop/cloud | Prioritised hints, visualisations | Closed, no code fixes |
| Semrush Site Audit | SaaS | Keyword/backlink data, AI visibility add-ons | Expensive, black-box checks, no CI/repo |
| Ahrefs Webmaster Tools | Freemium SaaS | 170+ checks, backlinks | Verified sites only, credit limits, no fixes |
| Lighthouse | OSS (Apache-2.0) | Authoritative perf/a11y lab data | One page at a time, shallow SEO |
| unlighthouse | OSS (MIT) | Site-wide Lighthouse | Perf-centric, no GEO, no fixes |
| seonaut | OSS (MIT, Go) | Self-hosted crawler audit | Small rule set, no GEO/fixes |
| OpenSEO (every-app/open-seo) | OSS (MIT, TS) + MCP | Semrush/Ahrefs alternative dashboards | Requires paid DataForSEO key; not a code-fixing tool |
| GEO Optimizer (Auriti-Labs) | OSS Python CLI/MCP | GEO checks, SARIF GitHub Action | Narrow, heuristic scores, encourages llms.txt |
| claude-seo, geo-seo-claude | OSS Claude Code skills (10k+ stars) | Broad prompt-driven coverage, PDF reports | Non-deterministic, unsourced rules, no transactional fixes |

Sources: vendor pricing/product pages and GitHub repositories (see links collected during research:
screamingfrog.co.uk, github.com/harlan-zw/unlighthouse, github.com/StJudeWasHere/seonaut,
github.com/every-app/open-seo, github.com/Auriti-Labs/geo-optimizer-skill, github.com/AgriciDaniel/claude-seo,
github.com/zubair-trabzada/geo-seo-claude). Star counts and prices are approximate at check time.

## Differentiation chosen for Searvex

1. **Deterministic engine + agent layer.** Crawling, parsing, checks, scoring and fixes are code; the LLM explains and strategises.
2. **Sourced, versioned rule base** with check dates, engine scope, verification level and a validator (`searvex rules validate`).
3. **Myth firewall**: popular-but-unsupported practices (llms.txt as ranking factor, length limits, keyword density) are documented and never emitted as issues.
4. **Repository mode**: framework detection and source-mapped findings (Next.js, Astro, Nuxt, static HTML, …).
5. **Transactional fixes**: dry-run diff → apply with backup manifest → verify → one-command rollback.
6. **CI-ready**: JSON / SARIF output and non-zero exit on configurable severity, run-to-run regression diff.
7. **Local-first, keyless**: no paid API required; GSC/Bing/CrUX integrations optional and read-only.
8. **Honest measurement**: every finding is `verified`, `heuristic` or `unmeasurable`; no fabricated metrics.
