<h1 align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/cihantopac/searvex/main/docs/assets/brand/primary-reversed.svg">
  <img alt="Searvex" src="https://raw.githubusercontent.com/cihantopac/searvex/main/docs/assets/brand/primary-color.svg" width="320">
</picture>
</h1>

<p align="center"><strong>Understand Search. Fix What Matters.</strong></p>

<p align="center">
Open-source SEO and AI-search auditor for websites and code repositories.<br>
Finds what is wrong, groups it by root cause and fixes the safe parts in your code — with rollback.
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
  <img alt="Searvex report overview: health score, issue groups, what was not covered, and the three issues to fix first" src="https://raw.githubusercontent.com/cihantopac/searvex/main/docs/assets/dashboard-light.webp" width="900">
</picture>
<br><sub>Unedited capture of a real report (ovokodo.com, 52 pages). English / Türkçe · light / dark / system.</sub>
</p>

## Quick start

```bash
npm install -g searvex-seo
```

```bash
searvex audit https://example.com --open
```

Or as a **Claude Code plugin**, no npm install needed:

```
/plugin marketplace add cihantopac/searvex
/plugin install searvex@searvex
```

Then run `/searvex <url> [path]`. Requires Node.js ≥ 20.10. Full reference: [docs/cli.md](docs/cli.md).

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/cihantopac/searvex/main/docs/assets/workflow-dark.svg">
  <img alt="Workflow: Audit, Understand, Prioritize, Fix, Verify, Monitor" src="https://raw.githubusercontent.com/cihantopac/searvex/main/docs/assets/workflow-light.svg" width="900">
</picture>

| | |
|---|---|
| **Audit** | A live site (robots.txt-compliant crawl) or a repository: Next.js, Astro, Nuxt, Laravel, WordPress, static HTML. |
| **Understand** | Every finding comes with evidence, an official source and the date that source was checked. |
| **Prioritize** | One broken layout on 50 pages is one task, not 50. |
| **Fix** | Approve a diff for safe fixes, or hand the rest to your coding agent with a ready-made repair prompt. |
| **Verify & monitor** | Re-audit after a change; failed verification rolls back. Regressions show up in the next run and in CI. |

## From findings to fixes

<table>
<tr>
<td width="50%" valign="top">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/cihantopac/searvex/main/docs/assets/issues-dark.webp">
  <img alt="Issues grouped by root cause, with selection checkboxes" src="https://raw.githubusercontent.com/cihantopac/searvex/main/docs/assets/issues-light.webp">
</picture>
<p><b>Select what to fix.</b> Issues are grouped by root cause and labelled <i>automatic</i>, <i>agent-assisted</i> or <i>manual</i>.</p>
</td>
<td width="50%" valign="top">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/cihantopac/searvex/main/docs/assets/prompt-dark.webp">
  <img alt="Editable repair prompt with copy and Markdown download" src="https://raw.githubusercontent.com/cihantopac/searvex/main/docs/assets/prompt-light.webp">
</picture>
<p><b>Generate a repair prompt</b> for Claude Code, Codex or any agent: exact URLs or <code>file:line</code>, evidence, fix and verification. Secrets redacted.</p>
</td>
</tr>
</table>

## What it checks

- **Technical SEO** — crawlability, indexability, canonicals, redirects, hreflang, metadata, structured data, links, performance and security signals.
- **GEO / AI search** — AI crawler access by purpose, snippet controls, entity consistency, content clarity.
- **Repositories** — findings with `file:line` in framework source, plus 12 rule types fixed automatically (dry run → approval → apply → verify → rollback).
- **Search data, optional and read-only** — Search Console (API or CSV export) and Chrome UX Report. Without them, clicks and Core Web Vitals are shown as *not measured*, never estimated.
- **Competitors** — topic and page-type coverage gaps, labelled as hypotheses.

## Evidence, not claims

Status: **v1.1.1** ([release notes](docs/release-notes-1.1.1.md), [changelog](CHANGELOG.md)).

- **90 rules**, each tied to an official source: 71 verified, 17 heuristic, 2 reported as unmeasurable. `searvex rules show <id>`
- **Tested** with unit, integration, browser and end-to-end runs; CI on Linux, macOS and Windows with Node 20, 22 and 24 ([quality report](docs/quality.md)).
- **Validated** on 13 public sites and 9 repositories; live Search Console and CrUX values matched the official exports.
- **Safe by default** — read-only, SSRF protection, robots.txt honoured, secret files never read, every change journaled with byte-for-byte rollback.

Searvex never promises rankings, traffic or AI citations. The health score is Searvex's own summary, not a search-engine metric. See [limitations](docs/limitations.md).

## Documentation

[CLI reference](docs/cli.md) · [Architecture](docs/architecture.md) · [Knowledge base](docs/knowledge-base.md) · [Security](docs/security.md) · [Privacy](docs/privacy.md)

## Related tools

Independent open-source tools by the same author:

- [**Relivaro**](https://github.com/cihantopac/relivaro) — software reliability, security and release readiness.
- [**Jourilo**](https://github.com/cihantopac/jourilo) — UX and conversion engineering in real browser journeys.
- [**Markilo**](https://github.com/cihantopac/markilo) — brand identity and vector design for Claude Code (made the Searvex identity).

## Contributing & license

Rules, framework adapters and fixtures are the most valuable contributions; every rule needs an official source and a test fixture ([CONTRIBUTING.md](CONTRIBUTING.md)). Report vulnerabilities via [SECURITY.md](SECURITY.md).

[Apache-2.0](LICENSE)
