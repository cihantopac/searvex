<h1 align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/cihantopac/searvex/main/docs/assets/brand/primary-reversed.svg">
  <img alt="Searvex" src="https://raw.githubusercontent.com/cihantopac/searvex/main/docs/assets/brand/primary-color.svg" width="320">
</picture>
</h1>

<p align="center"><strong>Understand Search. Fix What Matters.</strong></p>

<p align="center">
Open-source SEO and AI-search auditor for websites and code repositories. It finds what is actually wrong,
groups it by root cause, explains it with official sources and fixes the safe parts in your code — with
verification and one-command rollback. CLI and Claude Code plugin.
</p>

<p align="center">
<a href="https://www.npmjs.com/package/searvex-seo"><img alt="npm" src="https://img.shields.io/npm/v/searvex-seo?color=0e4f55&label=npm"></a>
<a href="https://github.com/cihantopac/searvex/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/cihantopac/searvex/actions/workflows/ci.yml/badge.svg"></a>
<a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-0e4f55"></a>
<img alt="Node ≥ 20.10" src="https://img.shields.io/badge/node-%E2%89%A5%2020.10-0e4f55">
</p>

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/cihantopac/searvex/main/docs/assets/dashboard-dark.webp">
  <img alt="Searvex HTML report: health score, issue groups, affected URLs, condition by area and the three issues to fix first" src="https://raw.githubusercontent.com/cihantopac/searvex/main/docs/assets/dashboard-light.webp" width="900">
</picture>
<br><sub>Real report of a live site (ovokodo.com, 52 pages, 2026-11-01). English / Türkçe · light / dark / system.</sub>
</p>

## What Searvex does

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/cihantopac/searvex/main/docs/assets/workflow-dark.svg">
  <img alt="Workflow: Audit, Understand, Prioritize, Fix, Verify, Monitor" src="https://raw.githubusercontent.com/cihantopac/searvex/main/docs/assets/workflow-light.svg" width="900">
</picture>

- **Audit** a live site (robots.txt-compliant crawl) or a repository (Next.js, Astro, Nuxt, Laravel, WordPress, static HTML).
- **Understand** every finding: evidence, the official source it is based on and the date that source was checked.
- **Prioritize** by root cause: one broken layout on 50 pages is one task, not 50.
- **Fix** what can be fixed safely, in your code, after you approve a diff — or hand the rest to your coding agent with a ready-made repair prompt.
- **Verify** by re-auditing; failed verification rolls back automatically.
- **Monitor** what improved or regressed since the last run.

## From findings to fixes

<table>
<tr>
<td width="50%" valign="top">

**Select what to fix.** Issues are grouped by root cause — a URL template, a source file or a shared layout — and labelled by how they get fixed:

- **Automatic** — a deterministic Searvex optimizer produced a verified patch.
- **Agent-assisted** — needs source or content judgement.
- **Manual** — deployment, server, Search Console or business decisions.

</td>
<td width="50%" valign="top">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/cihantopac/searvex/main/docs/assets/issues-dark.webp">
  <img alt="Issues grouped by root cause with selection checkboxes" src="https://raw.githubusercontent.com/cihantopac/searvex/main/docs/assets/issues-light.webp">
</picture>

</td>
</tr>
<tr>
<td width="50%" valign="top">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/cihantopac/searvex/main/docs/assets/prompt-dark.webp">
  <img alt="Editable repair prompt with copy and Markdown download" src="https://raw.githubusercontent.com/cihantopac/searvex/main/docs/assets/prompt-light.webp">
</picture>

</td>
<td width="50%" valign="top">

**Generate a repair prompt** for Claude Code, Codex or any coding agent: target and run id, stable finding references, exact URLs or `file:line`, root-cause groups, evidence, the fix and how to verify it. The receiving agent is told to re-check the source, reject false positives, fix root causes once, get approval and re-audit.

Secrets are redacted and crawled text is fenced as untrusted data. Without a repository the prompt becomes a remediation brief — the report never pretends it can edit your site.

</td>
</tr>
</table>

## Capabilities

| | |
|---|---|
| **Technical SEO** | Crawlability, indexability, canonicals, redirects, hreflang, metadata, structured data (Google rich-result requirements), links, performance signals, security. |
| **GEO / AI search** | AI crawler access by purpose (search vs. training vs. user fetch), snippet controls, entity consistency, content clarity. AI citations are reported as *not measured*. |
| **Repository checks** | Findings with `file:line` for framework source code, not only rendered HTML. |
| **Search Console & CrUX** | Optional, read-only: Search Console API (your own OAuth client) or CSV export, Chrome UX Report field data. Measured data is kept apart from inference. |
| **Competitor research** | Topic and page-type coverage gaps against competitors you name — labelled as hypotheses, not demand. |
| **Optimization** | 12 rule types fixed automatically (e.g. missing `lang`/viewport, canonicals, sitemap + robots.txt, identical duplicate `<title>`/description, hreflang codes and relative URLs): dry run → approval → apply → verify → rollback. |
| **Monitoring** | Changes since the previous run in every report; `monitor` and `--fail-on high` for CI. |

## Evidence, not claims

Status: **v1.1.0** ([release notes](docs/release-notes-1.1.0.md), [changelog](CHANGELOG.md)).

- **90 rules**, each with an official source and check date: **71 verified**, **17 heuristic**, **2 unmeasurable** (reported, never scored). `searvex rules show <id>`.
- **Automated tests** across unit, integration, Playwright and end-to-end runs of the bundled CLI; CI on Linux, macOS and Windows with Node 20, 22 and 24 ([quality report](docs/quality.md)).
- **Real-world validation** on 13 public sites and 9 repositories; **live** Search Console and CrUX checks returned values identical to the official exports and raw API.
- **Real issues it found**, confirmed against live HTML: a 404 page listed in MDN's sitemap; two `<title>` elements on every page of an Inertia.js site; Turkish URLs that switch to English (and to "page not found") for an en-US browser.
- **Safety:** read-only by default, SSRF protection, robots.txt always honoured, secret files never read, changes journaled with byte-for-byte rollback, reports rendered without `innerHTML` under a strict CSP.

Searvex never promises rankings, indexing, traffic or AI citations. The health score is Searvex's own summary of its findings, not a search-engine metric.

## Quick start

Requires **Node.js ≥ 20.10**. The npm package is `searvex-seo`; the command is `searvex`.

```bash
npm install -g searvex-seo
```

```bash
searvex audit https://example.com --open
```

```bash
searvex audit ./my-site --site-url https://example.com
```

```bash
searvex optimize ./my-site --site-url https://example.com --lang en
```

Reports land in `.searvex/runs/<runId>/` (`report.html`, `.md`, `.json`, optional `.sarif`). `searvex open latest`
opens the newest one. Full reference: [docs/cli.md](docs/cli.md).

**Claude Code plugin** — no npm install needed:

```
/plugin marketplace add cihantopac/searvex
/plugin install searvex@searvex
```

Then `/searvex <url> [path]` runs the whole workflow with approval checkpoints and answers with a short
summary plus the report link. Single steps: `/searvex:audit`, `/searvex:geo`, `/searvex:research`,
`/searvex:optimize`, `/searvex:monitor`.

**Optional search data** (read-only, asked once per site):

```bash
searvex connect https://example.com
```

```bash
searvex gsc import performance-export.zip --audit latest
```

```bash
searvex crux auth
```

Without them, clicks, impressions, positions and Core Web Vitals are shown as **not measured** — never estimated.

<details>
<summary><b>More commands</b></summary>

```bash
searvex run https://example.com ./my-site --competitor https://rival.example   # whole workflow, one crawl
searvex geo https://example.com                                                 # AI crawler access
searvex research https://example.com --competitor https://rival.example        # coverage gaps
searvex monitor https://example.com --fail-on high                              # regressions in CI
searvex ecosystem https://company.example https://product.example              # related sites
searvex review latest <ref> rejected --note "behind login"                     # record a verdict
searvex rollback <changeId> ./my-site
searvex gsc auth --client client_secret.json && searvex gsc report --audit latest
searvex bing auth && searvex bing report https://example.com/                   # experimental
```

| Integration | Status |
|---|---|
| Search Console CSV/ZIP import | supported (verified with real TR + EN exports) |
| Search Console API (`gsc auth`) | supported (verified live) |
| CrUX API (`crux auth`) | supported (verified live) |
| JavaScript rendering (`--render`, Playwright) | supported |
| Bing Webmaster API (`bing auth`) | experimental |

</details>

## Limitations

Website mode sees public pages only. Market data (search volumes, backlinks, SERP features) and AI citations are
not fetched or estimated. Repository mode is static analysis: runtime-computed metadata is resolved
conservatively. In repositories with several apps, sitemaps are left to a reviewed task because one site URL
cannot tell which host serves which app. Full list: [docs/limitations.md](docs/limitations.md).

## Related tools

Complementary open-source tools by the same author — independent, not required:

| | |
|---|---|
| [**Relivaro**](https://github.com/cihantopac/relivaro) | Software reliability, security and release readiness. |
| [**Jourilo**](https://github.com/cihantopac/jourilo) | UX and conversion engineering in real browser journeys. |
| [**Markilo**](https://github.com/cihantopac/markilo) | Brand identity and vector design for Claude Code. |

## Contributing, security, license

Rules, framework adapters and fixtures are the most valuable contributions — every rule needs an official source
and a test fixture ([CONTRIBUTING.md](CONTRIBUTING.md)). Security: [SECURITY.md](SECURITY.md),
[docs/security.md](docs/security.md), [docs/privacy.md](docs/privacy.md). Architecture:
[docs/architecture.md](docs/architecture.md).

[Apache-2.0](LICENSE). Name availability notes: [docs/research/name-availability-2026-10.md](docs/research/name-availability-2026-10.md) (not legal trademark clearance).
