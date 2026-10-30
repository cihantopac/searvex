# CLI reference

```
searvex <command> [target] [options]
```

Exit codes: `0` success · `1` `--fail-on` threshold met, optimize verification failed or rollback conflict · `2` usage or runtime error.

## Commands

| Command | Description |
|---|---|
| `run <url> [path]` | Full workflow in order with one crawl: 1 website audit · 2 GEO · 3 change since previous run · 4 competitor research (`--competitor`) · 5 repository audit · 6 fix plan (dry run, never applied). Writes `summary.md/json` and `plan.patch`. Missing inputs skip their steps. |
| `ecosystem <url> <url>…` | Brand-family analysis across 2–20 related sites (crawled in parallel, `--max-pages` per site, default 60): entity graph, cross-links, topic overlap, family-wide issues, language coverage. `--reuse` analyses the latest stored run of each site instead of crawling. Writes `ecosystem.md/json/html`. |
| `audit <url\|path>` | Website audit (URL) or repository audit (path). Writes reports to `.searvex/runs/<runId>/`. |
| `geo <url>` | GEO/AI-search readiness summary (default 50 pages). |
| `research <url> [--competitor <url>…]` | Target profile, competitor profiles (max 10), topic/page-type gaps (default 150 pages per site). |
| `optimize <path>` | Plan deterministic fixes; dry run by default. `--apply` (with confirmation or `--yes`) writes, verifies and auto-rolls back on failure. |
| `rollback <changeId> [path]` | Restore files changed by an optimization. Refuses if files changed afterwards (use `--yes` to force). `rollback list [path]` lists changes. |
| `connect <url> [--choice google\|csv\|skip] [--property P]` | The optional search-data step: shows the three choices (Google ile bağlan · CSV içe aktar · Şimdilik geç) with the command for each, and records a choice per site in the user config dir (`search-data.json`). Never starts OAuth; safe in CI. |
| `gsc auth --client <file> [--force]` | Authorise read-only Search Console access with **your own** OAuth "Desktop app" client (loopback + PKCE). Reuses a valid stored authorization unless `--force`; refused in CI. Refresh token stored in the user config dir (`~/.config/searvex/credentials.json`, `%APPDATA%\searvex` on Windows; 0600 on POSIX). |
| `gsc status` | Whether a credential is stored and still valid (exit 1 when none). |
| `gsc logout` | Revoke the authorization at Google and delete the stored credential. |
| `gsc sites` | List the properties the credential can read. |
| `gsc import <export.zip\|*.csv> [--property P] [--audit latest\|<runId>]` | Analyse a Search Console Performance export (Export → Download CSV) without account access. Queries and pages are separate tables in the export, so query → page sections are reported as "Not measured". The site is inferred from the pages table, or given with `--property`; pages of another property are rejected. |
| `gsc report [property] [--days 28] [--audit latest\|<runId>] [--max-rows n]` | Query × page analysis: top queries/pages, page → primary query, striking distance (positions 8–20), low CTR vs the site's own median at the same position, queries shared by several pages, indexable pages without impressions, audit issues on pages with traffic, an intent mix and intent mismatches (intent inferred from query wording and page type; clicks/impressions are verified). The property must be accessible to the credential; without one, the single accessible property covering the newest audit is used. `--audit` only joins an audit of the same site (domain property: any subdomain/protocol; URL prefix: exact protocol, host and path) and refuses ambiguous choices. Shared queries are classified (navigational, parent/child, dominant, mixed intent, possible competition); only the last two are flagged for review. Writes `search-performance.md/json`. |
| `bing report <siteUrl> [--days 28] [--audit …] [--max-pages 25]` | Same analysis on Bing Webmaster Tools data (`SEARVEX_BING_API_KEY`): page stats select the top pages, `GetPageQueryStats` supplies query × page rows. Read-only; the key is never printed. |
| `monitor <url>` | Re-audit and diff with the previous run of the same target (`--baseline <runId>` to choose). Regression = new/worsened critical or high issues. Writes `monitor.md/json/html` (before/after view). |
| `rules list [--category c]` · `rules show <id>` · `rules validate [--strict]` | Inspect and validate the knowledge base. |
| `report <runId\|latest> [--format …]` | Re-render a stored report. |
| `runs` | List stored runs. |

## Options

| Option | Default | Description |
|---|---|---|
| `--max-pages <n>` | 500 | Page limit (crawl stops; site-level findings use the crawled subset) |
| `--depth <n>` | 10 | Max click depth from the start URL |
| `--concurrency <n>` | 4 | Parallel requests (politeness is per host) |
| `--delay <ms>` | 250 | Minimum delay between requests to the same host; robots.txt `Crawl-delay` raises it |
| `--timeout <ms>` | 15000 | Per-request timeout |
| `--render` | off | Render pages with Playwright (install separately) and compare raw vs rendered |
| `--include <regex>` / `--exclude <regex>` | — | Restrict crawl scope (repeatable) |
| `--no-sitemap` | — | Do not seed from sitemaps |
| `--check-external` | off | Check outbound links (HEAD, robots-aware, max 200) |
| `--resume <runId>` | — | Continue an interrupted crawl from its checkpoint |
| `--format <list>` | md,html,json | Any of `md,html,json,sarif` |
| `--out <dir>` | cwd (repo root for repo audits) | Workspace that receives `.searvex/` |
| `--fail-on <severity>` | — | `critical\|high\|medium\|low`; exit 1 when matching findings exist (unmeasurable ignored) |
| `--allow-private` | off | Allow localhost/private network targets (local dev servers) |
| `--site-url <url>` | — | Public URL for repository analysis and fixes (canonical, sitemap) |
| `--lang <tag>` | — | Document language for `html lang` fixes when the framework has no locale idiom |
| `--only <ruleId>` | — | Restrict optimize to specific rules (repeatable) |
| `--apply`, `--yes` | — | Optimize: write changes / skip confirmation |
| `--competitor <url>` | — | Research: competitor site (repeatable) |
| `--import <csv>` | — | Monitor: Search Console Performance export |
| `--reuse` | — | Ecosystem: use stored runs instead of crawling |
| `--json` | — | Print JSON to stdout |
| `-q, --quiet` | — | Less output |

## Environment

| Variable | Purpose |
|---|---|
| `SEARVEX_CRUX_API_KEY` | Chrome UX Report API key for real-user Core Web Vitals |
| `SEARVEX_GSC_TOKEN` | OAuth access token with `webmasters.readonly` scope |
| `SEARVEX_GSC_SITE` | Search Console property for `monitor`, e.g. `sc-domain:example.com` |
| `SEARVEX_BING_API_KEY` | Bing Webmaster Tools API key for `bing report` |
| `SEARVEX_CONFIG_DIR` | Override the user config directory (credentials, search-data choices) |

## Output files (`.searvex/runs/<runId>/`)

| File | Content |
|---|---|
| `report.json` / `.md` / `.html` / `.sarif` | Audit report |
| `pages.jsonl` | One crawled page record per line |
| `checkpoint.json` | Queue + seen set for `--resume` |
| `crawl-summary.json` | Robots, sitemaps, stats |
| `meta.json` | Run metadata |
| `research.json` / `.md` | Research output |
| `monitor.json` / `.md` | Run diff |
| `plan.json` / `plan.patch` | Optimize dry-run plan and combined patch |

Change backups live in `.searvex/changes/<changeId>/` (manifest with hashes + original file copies).
`.searvex/` contains its own `.gitignore`.

## CI example

```yaml
- run: npx -y github:cihantopac/searvex audit https://staging.example.com --max-pages 200 --format sarif,md --fail-on high
- uses: github/codeql-action/upload-sarif@v3
  with: { sarif_file: .searvex/runs }
```
