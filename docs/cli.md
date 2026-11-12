# CLI reference

```
searvex <command> [target] [options]
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Completed |
| `1` | `--fail-on` threshold met, optimize verification failed, rollback conflict, or a `gsc\|bing\|crux status` integration that is not configured or not working |
| `2` | Usage error (unknown command or option, invalid value, a target blocked by the network policy: a private address without `--allow-private`, or a host or port excluded by `--allow-host`, `--deny-host` or `--ports`, an unusable `--proxy` / `HTTPS_PROXY`, or proxy authentication that failed with `407`). A policy-blocked target still gets a `report.json` in its run directory (`crawl.status: "unreachable"`, `crawl.error` starting with `Blocked:`), but no HTML or Markdown report, and one `searvex: …` line on stderr |
| `3` | Runtime error (until 1.1.1 this was `2`): one `searvex: <message>` line; the stack trace only with `SEARVEX_DEBUG=1`. Also an unreachable upstream proxy (`Proxy unreachable …`) |
| `4` | Target not analysable, nothing was fetched. `crawl.status: "unreachable"`: the start URL failed at the network level (DNS, TCP, TLS). `crawl.status: "robots-blocked"`: robots.txt blocked every queued URL, because it answered 5xx/429 (RFC 9309: assume complete disallow) or disallows them; the report keeps the one site finding to fix (`robots.unreachable` or `robots.disallow-all`; none when only `SearvexBot` is disallowed). Reports are written with no page findings, `scores.overall: null` and `scores.notApplicable`; one `searvex: …` line goes to stderr, also with `--json` and `--quiet`; `monitor` does not diff, and the run is never a baseline |
| `5` | Interrupted: the first SIGINT/SIGTERM, or the `--max-duration` deadline, stops the crawl; pages in flight finish (bounded by `--timeout`), what was crawled is analysed and every requested format is written with `crawl.interrupted: "signal" \| "max-duration"` and a limitation line. Host/locale/llms.txt probes, `--check-external` and CrUX are skipped. A second signal exits at once with `130` (SIGINT) or `143` (SIGTERM). An interrupted run is never a monitor baseline; continue it with `--resume <runId>` (`audit`, `geo`, `monitor`, `run`) |

### Error output

Every error is one `searvex: <message>` line on stderr. Usage errors (exit `2`) end with
`Run "searvex --help" for usage.`; runtime errors (exit `3`) end with `Run with SEARVEX_DEBUG=1 for details.`.
With `--json`, the next stderr line is a JSON object:

```json
{"error":{"code":2,"kind":"usage","message":"Unknown command: nope"}}
```

`kind` is `usage`, `policy` (target blocked by the network policy), `runtime`, `unreachable` or
`robots-blocked` (exit `4`), or `interrupted` (exit `5`).

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
| `crux auth` · `crux status` · `crux logout` | Store the Chrome UX Report API key (hidden prompt) after a test query; check it; remove it. Website audits then add real-user Core Web Vitals (p75, 28 days) for origins with enough traffic. |
| `psi auth` · `psi status` · `psi logout` | Store the PageSpeed Insights API key (hidden prompt) after a test run on example.com; check it; remove it. Website audits with `--lab` then add Lighthouse lab data for sampled templates. |
| `bing auth` · `bing status` · `bing sites` · `bing logout` | Store the Bing Webmaster API key (hidden prompt, or piped stdin) in the credential store after checking it with `GetUserSites`; show whether it works; list the account's sites; remove it (keys stay valid until regenerated in Bing). |
| `bing report <siteUrl> [--days 28] [--audit …] [--max-pages 25]` | Same analysis on Bing Webmaster Tools data (key from `bing auth` or `SEARVEX_BING_API_KEY`). The site must be a verified site of the account (unknown sites return empty data, which would look like "no traffic"). Page stats select the top pages, `GetPageQueryStats` supplies query × page rows. Read-only; the key is never printed. |
| `ga4 auth --client <file>` · `ga4 status` · `ga4 properties` · `ga4 logout` | **Experimental.** Authorize read-only Google Analytics access (`analytics.readonly`) with the same kind of "Desktop app" OAuth client as `gsc auth` (enable the Google Analytics Data and Admin APIs in its project); check it; list readable properties; revoke and remove it. |
| `ga4 report <propertyId> [--days 28] [--audit latest\|<runId>] [--max-rows 1000]` | **Experimental** (not yet verified against a live property). Organic Search landing pages of a GA4 property (sessions, engaged sessions, key events by host and path). With `--audit`, only pages on the audit's host (and its www twin) are joined: pages with organic traffic and open audit issues, and indexable pages without organic sessions. GA4 sessions are not Search Console clicks and do not change priorities. Writes `ga4-report.md/json`. |
| `yandex auth` · `yandex status` · `yandex sites` · `yandex logout` | **Experimental.** Store a Yandex OAuth token with Webmaster access (hidden prompt; from a Yandex OAuth app you create at oauth.yandex.com) after listing the account's sites; check it; list sites and their verification; remove it (revoke the token at oauth.yandex.com). |
| `yandex report <siteUrl> [--days 28] [--max-rows 500]` | **Experimental** (not yet verified against a live site). Popular Yandex queries of a verified site of the account: impressions, clicks, CTR, average position. Query level only (the API gives no page × query breakdown), so it is not joined to audits. Writes `yandex-report.md/json`. |
| `monitor <url>` | Re-audit and diff with the previous run of the same target (`--baseline <runId>` to choose). Regression = new/worsened critical or high issues. Writes `monitor.md/json/html` (before/after view). Search data: `--import <export.zip|*.csv>` (with `--property P` when the export has no pages table) or the Search Console API via `--site-url P` / `SEARVEX_GSC_SITE`; data whose property does not cover the monitored site is refused (`--site-url`, `--import`) or reported as not measured (`SEARVEX_GSC_SITE`). A `--baseline` of another website is refused. |
| `rules list [--category c]` · `rules show <id>` · `rules validate [--strict]` | Inspect and validate the knowledge base; with `--rules-pack`, also the pack's rules and checks. |
| `report <runId\|latest> [--format …]` | Re-render a stored report. |
| `open [runId\|latest]` | Open a stored HTML report in the default browser (`open` / `xdg-open` / Explorer, no shell). |
| `review <runId\|latest> <ref\|ruleId> <confirmed\|rejected\|fixed> [--note text]` | Record a review of a finding after an agent or person re-checked it. Stored in `reviews.json` next to the audit and shown separately in the HTML report; scanner evidence is never changed. `ref` is the stable occurrence reference shown in the report and in repair prompts (`ruleId#hash`). |
| `prompt <runId\|latest>` | Print the repair prompt the HTML action center builds, outside the browser: every issue that counts toward the score, or `--rules a,b`. `--lang en\|tr` (default `en`), `--format md\|json` (default `md`; JSON: `{runId, rules, prompt}`). Evidence is redacted and bounded the same way as in the HTML. |
| `schema [report\|events\|error]` | Print the published JSON Schema (draft-07) of `report.json`, of one `--progress ndjson` event, or of the `--json` error object (default `report`). The files ship in the package under `schema/`; see [schema.md](schema.md). |
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
| `--lab` | off | Lighthouse lab data through PageSpeed Insights (mobile, performance category) for one page per URL template: the homepage, then the templates with the most pages, each represented by its best-linked page. Needs `psi auth` or `SEARVEX_PSI_API_KEY` and a public URL (Google fetches the pages; local and private hosts are skipped and the limitations say so). Runs are sequential, 10–30 s each. Scores below 50 (Lighthouse's "poor" band) are reported as `perf.lab-poor`; lab values are never Core Web Vitals pass/fail. Experimental: verified against a mock of the API, not yet against the live service. |
| `--lab-samples <n>` | 5 | Templates measured with `--lab` (1–20) |
| `--rules-pack <name\|dir>` | — | Add a community rule pack: a folder in `knowledge/packs/` by name, or any directory (repeatable or comma-separated). Pack rules use declarative page checks, meet the same sourcing rules as core rules, are labelled with their pack in every report (`findings[].pack`, `tool.packs`) and can never replace a core rule. Also for `rules list\|show\|validate`. Format: [knowledge/packs/README.md](../knowledge/packs/README.md). |
| `--resume <runId>` | — | Continue an interrupted crawl from its checkpoint (written every 25 pages or 10 seconds, and at the start) |
| `--save-html` | off | Keep each fetched HTML body, as served and up to 2 MB, under `artefacts/html/` in the run directory (`.html.txt`, owner-only permissions; 200 MB per run with screenshots). Finding evidence and the HTML report link the file |
| `--screenshots` | off | With `--render` only: one viewport PNG per rendered page under `artefacts/screenshots/`, linked like `--save-html` |
| `--compact` | off | `report.json`: write only the count of each finding's affected URLs (for very large crawls) |
| `--max-duration <s>` | — | Stop crawling after `s` seconds (1–604800) and write a partial report (exit `5`) |
| `--format <list>` | md,html,json | Any of `md,html,json,sarif` |
| `--out <dir>` | cwd (repo root for repo audits) | Workspace that receives `.searvex/` |
| `--fail-on <severity>` | — | `critical\|high\|medium\|low`; exit 1 when matching findings exist (unmeasurable ignored) |
| `--allow-private` | off | Allow localhost/private network targets (local dev servers) |
| `--allow-host <glob>` | — | Only contact matching hosts (repeatable or comma-separated). `*` matches any characters, dots included; `*.example.com` does not match `example.com`, so list the target too. Enforced on every request, redirect hop, connection-time DNS lookup, `--render` browser request and `--check-external` link |
| `--deny-host <glob>` | — | Never contact matching hosts (repeatable); wins over `--allow-host`. A denied target is policy-blocked (exit `2`); any other denied URL is skipped (`inventory.unfetched` reason `policy-blocked`, no finding) |
| `--ports <list>` | any | Only contact these ports, e.g. `80,443,8080` |
| `--proxy <url\|none>` | `HTTPS_PROXY` / `HTTP_PROXY` | Upstream HTTP(S) proxy, `http://[user:pass@]host:port` or `https://…` (Basic authentication). Every proxied request uses a `CONNECT` tunnel and TLS end to end; private, loopback and reserved targets never go through it (with `--allow-private` they go direct). `NO_PROXY` (suffixes, hosts, IPs, `host:port`, `*`) goes direct. `none` ignores the environment. A link-local proxy, a proxy denied by `--deny-host`, a path or another scheme is a usage error. Used by crawling, `--render`, `--check-external` and `rules check-sources`; the search-data integrations (Search Console, Bing, CrUX) connect directly. Design: [design/proxy.md](design/proxy.md) |
| `--proxy-resolve <proxy\|local>` | `proxy` | `proxy`: Searvex resolves the target locally and blocks private answers, then sends `CONNECT host:port`. Passing it explicitly also lets names that local DNS cannot resolve (a DNS-less sandbox) go to the proxy unchecked. `local`: `CONNECT` to the locally resolved and checked address (strict; breaks proxies that filter by host name) |
| `--pre-launch` | off | Pre-launch profile for a local or staging build (`audit`, `geo`, `monitor`, `run`). The site is audited as it will be once live: noindex pages are evaluated as indexable and their noindex goes to a **launch checklist**; findings of rules tagged `environment` (`https.not-used`, `perf.no-compression`, `canonical.http-https`, and the launch items `index.noindex`, `index.noindex-in-sitemap`, `robots.disallow-all`, `canonical.target-noindex`, `robots.sitemap-unreachable`) get `context` and are excluded from the score, `--fail-on`, priorities and monitor regressions. Score line: `(pre-launch profile)`. On a local or private target without the flag the CLI suggests it; it is never enabled silently. |
| `--site-url <url>` | — | Public URL of the site. **URL mode** (`audit`, `geo`, `monitor`, `run`): audit a local or staging build as that site — canonical, hreflang, sitemap (`Sitemap:` directives, `<loc>`, sitemap indexes) and link URLs on the public origin are mapped to the crawled origin, so a canonical to the public URL of the same page counts as self and the declared sitemap is read from the build. Only the exact origin is mapped (`http://` or `www.` variants of it are not). The report header says "Audited `<crawled origin>` as `<site URL>`". Not applied to `research`, `ecosystem` or competitor crawls. **Repository mode:** base URL for fixes (canonical, sitemap). **monitor:** a value on the target's own origin, or `sc-domain:…`, is the Search Console property; a URL on another origin is an origin mapping only. |
| `--lang <tag>` | — | Document language for `html lang` fixes when the framework has no locale idiom; `prompt`: `en` or `tr` |
| `--rules <a,b>` | — | `prompt`: only these rule ids (comma-separated or repeatable) |
| `--only <ruleId>` | — | Restrict optimize to specific rules (repeatable) |
| `--apply`, `--yes` | — | Optimize: write changes / skip confirmation |
| `--competitor <url>` | — | Research: competitor site (repeatable) |
| `--import <csv>` | — | Monitor: Search Console Performance export |
| `--reuse` | — | Ecosystem: use stored runs instead of crawling |
| `--open` | off | Open the HTML report when the command finishes |
| `--note <text>` | — | Review: short reason, e.g. why a finding is a false positive |
| `--json` | — | Print JSON to stdout |
| `--progress ndjson` | — | Progress as JSON events on stderr, one per line: `start`, `phase` (`crawl`/`analyze`/`report`), `page` (url, status, blocked, fetched, crawled, queued), `finding-summary`, `signal`, `end` (exit code, report paths, `interrupted`). Every stderr line is then a JSON object: plain log lines are suppressed and errors are written as the JSON error object. Works together with `--json` on stdout |
| `-q, --quiet` | — | Less output |

## Environment

| Variable | Purpose |
|---|---|
| `SEARVEX_CRUX_API_KEY` | Chrome UX Report API key (instead of `searvex crux auth`) |
| `SEARVEX_PSI_API_KEY` | PageSpeed Insights API key for `--lab` (instead of `searvex psi auth`) |
| `SEARVEX_GSC_TOKEN` | OAuth access token with `webmasters.readonly` scope |
| `SEARVEX_GA4_TOKEN` | OAuth access token with `analytics.readonly` scope (alternative to `searvex ga4 auth`; experimental) |
| `SEARVEX_YANDEX_TOKEN` | Yandex OAuth token with Webmaster access (instead of `searvex yandex auth`; experimental) |
| `SEARVEX_GSC_SITE` | Search Console property for `monitor`, e.g. `sc-domain:example.com` |
| `SEARVEX_BING_API_KEY` | Bing Webmaster Tools API key (instead of `searvex bing auth`) |
| `SEARVEX_CREDENTIAL_STORE` | `file` (default: 0600 JSON file in the config dir) or `keychain`: macOS Keychain (`security`), Secret Service (`secret-tool`, libsecret) or Windows DPAPI (`powershell.exe`). Secrets go to the tools on stdin, never as arguments. Credentials saved by the file store remain readable and move to the keychain on the next save. |
| `SEARVEX_CONFIG_DIR` | Override the user config directory (credentials, search-data choices) |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` (and lowercase) | Upstream proxy when `--proxy` is not given; `NO_PROXY` lists hosts reached directly. See `--proxy` |
| `SEARVEX_DEBUG` | `1`: print the stack trace of a runtime error (exit `3`). By default a runtime error is one `searvex: <message>` line |

## Output files (`.searvex/runs/<runId>/`)

| File | Content |
|---|---|
| `report.json` / `.md` / `.html` / `.sarif` | Audit report; `report.html` is the interactive action center (English/Turkish, light/dark/system theme, issue selection and repair prompts) |
| `context.json` | Repository linked to the audit and rules with a concrete automatic patch (used by `report`/`review` to re-render the HTML) |
| `reviews.json` | Reviews recorded with `searvex review` |
| `repository-report.html` / `.md` / `.json` | `run` only: the repository audit of the same run |
| `pages.jsonl` | One crawled page record per line (since 1.4.0 without the page text: `data.mainTextRef` points into `texts.txt`) |
| `texts.txt` | Main-content text of each crawled page (up to 20,000 characters), read back by the analysis and `--resume` |
| `checkpoint.json` | Queue + seen set for `--resume` |
| `artefacts/html/*.html.txt`, `artefacts/screenshots/*.png` | `--save-html` / `--screenshots` evidence, named `<hash>-<path slug>` |
| `crawl-summary.json` | Robots, sitemaps, stats |
| `meta.json` | Run metadata |
| `research.json` / `.md` | Research output |
| `monitor.json` / `.md` | Run diff |
| `plan.json` / `plan.patch` | Optimize dry-run plan and combined patch |

### Run status and counters in `report.json` (website mode)

| Field | Meaning |
|---|---|
| `crawl.status` | `complete`, `unreachable` or `robots-blocked` (see exit code `4`; a proxy that refuses `CONNECT` to the start URL is `unreachable` with the proxy named in `crawl.error`) |
| `crawl.artefacts` | Evidence artefacts written (`html`, `screenshots`, `bytes`, `skipped` over the run budget) with `--save-html` / `--screenshots` (since schema 1.1) |
| `findings[].evidence[].artefact` | `{ html?, screenshot? }`: the artefacts of the page, relative to the run directory (since schema 1.1) |
| `traffic` | Search data that weighted the priorities (`source`, `metric`, `pages`, `clicks`, `impressions`), written into the joined audit by `gsc report --audit`, `gsc import --audit`, `bing report --audit` and `monitor --import` with a pages table (since schema 1.1) |
| `crawl.proxy` | Upstream proxy used: `endpoint` (`host:port`, never credentials), `resolve` and `unresolvedAllowed` (since schema 1.1) |
| `crawl.crawled` | URLs processed, including URLs blocked by robots.txt (never requested) |
| `crawl.fetched` | URLs for which an HTTP request was made (since 1.3.0) |
| `crawl.blocked` | URLs not requested because robots.txt disallows them |
| `scores.overall` | 0–100, or `null` when `scores.notApplicable` says why nothing was audited (since 1.3.0; was `100`) |
| `inventory.pages` | HTML pages that answered 200 without a redirect |
| `findings[].ref` / `.remediation` | Stable finding reference (its rule id) and how it gets fixed: `auto` (a concrete patch exists in the linked repository), `agent` or `manual` (since 1.3.0) |
| `findings[].evidence[].ref` | Stable occurrence reference `<ruleId>#<hash>`, the one the HTML report, repair prompts and `searvex review` use (since 1.3.0) |
| `findings[].affected` | `{ count, urls, truncated? }`: every affected URL (website) or file (repository), sorted; complete up to 10,000, `truncated` counts the rest. Evidence stays a sample of at most 50. robots.txt and llms.txt are not listed. With `--compact`, only `count` (since 1.3.0) |
| `findings[].priority.causedBy` / `.effects` | Observed root cause a finding is likely a consequence of (`{ruleId, why}`), and on the cause the rule ids of its likely consequences; the HTML report shows them in **By cause** (since schema 1.1) |
| `findings[].structures` | Page-structure templates of the affected pages (`id` = layout skeleton hash, `pages`, `example` URL): one template behind unrelated URLs such as flat slugs. When at most two layouts cover the pages that URL patterns split, the finding counts as "fix once" (since schema 1.1) |
| `privateRoutes` | Repository mode: routes that need a login (`route`, `file`, `reason`: auth middleware, a login-redirecting layout); their metadata and indexability findings are not reported (since schema 1.1) |
| `labData` | With `--lab`: Lighthouse lab data per sampled template (`samples[]` with `template`, `pages`, `url`, `score`, `lcpMs`, `fcpMs`, `tbtMs`, `cls`, `speedIndexMs`, `ttfbMs`; `errors[]`; `skipped` when nothing was measured). Lab values, not Core Web Vitals (since schema 1.1) |
| `rootCauseGroups` | Per rule id: occurrences grouped by URL template, source file, shared layout or site, with page counts (since 1.3.0) |
| `inventory.unfetched` | Every other crawled URL with `status` and `reason` (`robots-blocked`, `error`, `redirect`, `non-200`, `not-html`), capped at 10,000; `inventory.unfetchedTotal` is the full count (since 1.3.0) |

The CLI summary and the Markdown/HTML reports show *pages fetched*, plus *blocked by robots.txt* when that count is
not 0.

Change backups live in `.searvex/changes/<changeId>/` (manifest with hashes + original file copies).
`.searvex/` contains its own `.gitignore`.

## CI example

```yaml
- run: npx -y searvex-seo audit https://staging.example.com --max-pages 200 --format sarif,md --fail-on high
- uses: github/codeql-action/upload-sarif@v3
  with: { sarif_file: .searvex/runs }
```
