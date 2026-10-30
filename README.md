# Searvex

**Open-source search intelligence & optimization engine.** Searvex audits websites and code
repositories for technical SEO and GEO/AEO (AI search) issues against a **sourced, versioned rule
base**, researches competitors, and applies **safe, verified code fixes with one-command rollback**.
It ships as a standalone CLI and as a Claude Code plugin.

> Status: **v0.7.0 (early)**. The engine, rule base, CLI and plugin are tested (automated tests incl. Playwright rendering, CI on Linux/macOS/Windows,
> real-site and real-repository validation — see [docs/quality.md](docs/quality.md)). Expect rough
> edges; read [Limitations](#limitations) before relying on it.

## Why Searvex

| | Searvex | Typical crawlers (Screaming Frog, Sitebulb) | Prompt-only SEO skills |
|---|---|---|---|
| Deterministic, reproducible checks | ✅ code, not prompts | ✅ | ❌ |
| Every finding cites an official source + check date | ✅ `searvex rules show <id>` | ❌ | ❌ |
| Myth firewall (no keyword density, fixed title lengths, llms.txt-as-ranking-factor…) | ✅ | partly | ❌ |
| Repository mode: findings with `file:line` for Next.js, Astro, Nuxt, Laravel, WordPress, static sites | ✅ | ❌ | partial |
| Safe fixes: dry-run diff → apply → re-verify → rollback | ✅ | ❌ | ❌ |
| GEO: AI crawler access by *purpose* (training vs search vs user fetch) | ✅ | partial | partial |
| Honest measurement: each finding is `verified`, `heuristic` or `unmeasurable` | ✅ | ❌ | ❌ |
| Local-first, no paid API required | ✅ | desktop app | ✅ |

Competitor research and differentiation notes: [docs/research/competitors-2026-10.md](docs/research/competitors-2026-10.md).

## Install

Requires **Node.js ≥ 20.10** (Windows, macOS, Linux).

```bash
npm install -g github:cihantopac/searvex
```

```bash
searvex --help
```

### Claude Code plugin

In Claude Code:

```
/plugin marketplace add cihantopac/searvex
/plugin install searvex@searvex
```

Then use **`/searvex <url> [path]`** — it runs the whole workflow in a fixed order (scope → competitors →
audit → GEO → change since last run → research → repository audit → fix plan → approved fixes → content
plan → monitoring) with approval checkpoints. Single steps are available as the namespaced skills `/searvex:audit`, `/searvex:research`,
`/searvex:optimize`, `/searvex:geo`, `/searvex:monitor`. The plugin bundles the CLI
(`dist/searvex.mjs`), so no `npm install` is needed.

## Usage

```bash
# Everything in order with one crawl: audit → GEO → change since last run → research → repo audit → fix plan (dry run)
searvex run https://example.com ./my-site --competitor https://rival-a.com

# Website mode: crawl (robots.txt-compliant, rate-limited) and audit
searvex audit https://example.com --max-pages 300

# Repository mode: detect the framework and analyse source files
searvex audit ./my-next-app

# Safe fixes for a repository: dry run first (default), then apply with verification
searvex optimize ./my-site --site-url https://example.com --lang en
searvex optimize ./my-site --site-url https://example.com --lang en --apply
searvex rollback <changeId> ./my-site

# GEO / AI-search readiness
searvex geo https://example.com

# Brand family / product ecosystem across related sites
searvex ecosystem https://company.example https://product-a.example https://product-b.example

# Competitor & content-gap research (competitors are passed explicitly)
searvex research https://example.com --competitor https://rival-a.com --competitor https://rival-b.com

# Regression monitoring against the previous run (optionally with Search Console data)
searvex monitor https://example.com --fail-on high

# Optional search performance data: Google / CSV / skip (asked once per site)
searvex connect https://example.com
searvex gsc import performance-export.zip --audit latest   # Search Console CSV export, no account access
searvex gsc auth --client client_secret.json               # your own Google OAuth "Desktop app" client
searvex gsc report sc-domain:example.com --audit latest
SEARVEX_BING_API_KEY=… searvex bing report https://example.com/

# Inspect the rule base and re-verify its official sources
searvex rules check-sources
searvex rules list
searvex rules show canonical.in-body
searvex rules validate
```

Reports are written to `.searvex/runs/<runId>/` as Markdown, interactive HTML, JSON and SARIF
(`--format md,html,json,sarif`). Use `--fail-on high` in CI to fail builds on serious issues.
Full reference: [docs/cli.md](docs/cli.md).

### Optional integrations (read-only, opt-in)

| Variable | Enables |
|---|---|
| `SEARVEX_CRUX_API_KEY` | Real-user Core Web Vitals (Chrome UX Report API) |
| `searvex gsc auth` (or `SEARVEX_GSC_TOKEN`) | Search Console query × page analysis, `monitor` performance |
| `SEARVEX_BING_API_KEY` | Bing Webmaster Tools query × page analysis |
| `searvex gsc import export.zip` | Search Console Performance CSV/ZIP exports (no account access; no query × page data) |
| `npm i -D playwright` | `--render`: JavaScript rendering and raw-vs-rendered comparison |

Without them, Searvex reports these metrics as **not measured** — it never estimates them.

## What it checks

87 rules across crawlability, indexability, canonicalisation, international (hreflang), metadata,
structured data (Google rich-result requirements), performance, security, links, content and GEO.
Examples: robots.txt failures and AI crawler access, redirect chains and loops, noindex/sitemap
conflicts, canonical conflicts (including canonicals pushed into `<body>` by invalid head markup),
hreflang reciprocity and codes, soft 404s, client-side-only rendering, duplicate and near-duplicate
content (template-aware), retired rich-result types (FAQ, HowTo), entity consistency, declared vs actual
content language, untranslated headings on localized pages.

Each rule records the engines it applies to (Google, Bing, Yandex, AI systems), the official source
URLs with check dates, how to fix and how to verify — see [docs/knowledge-base.md](docs/knowledge-base.md).

## How it works

```
CLI / Claude Code skills
        │
        ├── Website mode: safe fetcher → crawler (robots, sitemaps, queue, checkpoints) → HTML5 extraction
        ├── Repository mode: safe file walker → framework detection → source checks / static-site analysis
        │
        ├── Analyzers: technical · structured data · GEO · content · inventory   ← rule knowledge base
        ├── Reports: Markdown · HTML · JSON · SARIF
        └── Optimizer: deterministic fix planners → transaction (backup, verify, rollback)
```

The deterministic engine measures; the agent (Claude) explains, prioritises, researches competitors
and drafts judgement-based changes (titles, descriptions, alt text) for the user's approval.
Details: [docs/architecture.md](docs/architecture.md).

## Security & privacy

- Read-only by default. Nothing is published, submitted (e.g. IndexNow) or changed on live sites.
- SSRF protection with connection-time DNS validation (anti-rebinding), per-redirect re-validation,
  size and time limits; private networks require `--allow-private`.
- robots.txt (RFC 9309) is always honoured, including for outbound link checks; per-host rate limiting,
  `Crawl-delay`, `429/Retry-After` backoff. User agent: `SearvexBot`.
- Repository access never follows symlinks, never reads secret files (`.env`, keys, credentials) and
  refuses paths outside the repository.
- Crawled content is treated as untrusted; HTML reports are rendered without `innerHTML` and with a CSP.

See [docs/security.md](docs/security.md), [docs/privacy.md](docs/privacy.md) and [SECURITY.md](SECURITY.md).

## Limitations

- Website mode sees public pages only; no traffic, rankings or analytics without an integration.
- Market data (search volumes, SERP features, backlinks) is not fetched — Searvex does not fabricate it.
  The research skill discovers competitors via web search; volumes stay "unknown" unless you provide data.
- AI citations cannot be observed directly; Bing Webmaster Tools AI Performance and Search Console are
  the official sources.
- Repository mode is static analysis: runtime-computed metadata (CMS, i18n, data fetching) is resolved
  conservatively. Use website mode against a deployment for rendered output.
- Analysis is in-memory: tested to 20,000 pages (~25 KB/page); very large sites need `--max-pages` or sections (`--include`).

Full list: [docs/limitations.md](docs/limitations.md).

## Contributing

Rules, framework adapters and fixtures are the most valuable contributions. Every rule needs an
official source and a test fixture. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE). "Searvex" name availability notes: [docs/research/name-availability-2026-10.md](docs/research/name-availability-2026-10.md)
(not legal trademark clearance).
