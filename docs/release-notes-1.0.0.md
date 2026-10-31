# Searvex 1.0.0 — release notes

Searvex is a developer-first SEO and GEO (AI search) engineering tool: it audits websites and code
repositories against a sourced rule base, explains what to fix first, applies safe code fixes with rollback,
and reads your own search data when you connect it. It runs locally — no account, server or paid API.

## Install

```bash
npm install -g searvex-seo     # the command is "searvex"
searvex audit https://example.com
searvex audit ./my-repo
```

Claude Code plugin: `/plugin marketplace add cihantopac/searvex`, then `/plugin install searvex@searvex`, and
run `/searvex <url or path>`. Node.js 20.10 or newer. JavaScript rendering (`--render`) needs Playwright:
`npm i -D playwright && npx playwright install chromium`.

## What is supported

| Capability | Status |
|---|---|
| Website audit: crawlability, indexability, canonicals, redirects, robots.txt, sitemaps, hreflang, structured data, metadata, content, internal links, GEO/AI-crawler access | supported |
| JavaScript rendering with raw-vs-rendered comparison (`--render`, isolated browser) | supported |
| Repository audit with file:line evidence (Next.js, Astro, Nuxt, Laravel, WordPress classic themes, static sites, monorepos) | supported |
| Safe fixes: dry run → apply → verify → rollback (9 rule types) | supported |
| Research (competitor coverage), ecosystem (brand family), monitor (run diffs) | supported |
| Reports: Markdown, interactive HTML, JSON, SARIF | supported |
| Search Console: CSV/ZIP import (no account), API with your own OAuth client | supported |
| Chrome UX Report field data (your own API key) | supported |
| Bing Webmaster API | experimental — works end to end, not yet compared with real non-empty data |
| GA4, Yandex Webmaster, Lighthouse lab data, AI-citation measurement | not implemented |

Searvex never estimates traffic, rankings, search volume, backlinks or AI citations. Without a connected source
they are reported as **not measured**. The health score summarises Searvex findings; it is not a search-engine
metric.

## Highlights since 0.7.0

- Search data can no longer be attached to the wrong website in any command.
- Hostile pages cannot stall `--render`; the optimizer survives interruptions and never overwrites your edits.
- Credentials and API keys can live in the OS keychain; keys are entered without echo and never printed.
- "Fix first" points at root causes, e.g. a site that switches language in the browser and thereby changes
  titles, canonicals and hreflang for Googlebot.
- Fewer false positives in repository mode (test data, templates, error pages, monorepos) and website mode
  (redirect-only links, cross-language cannibalisation, aspect-ratio images, 3-letter language codes).

Full list: [CHANGELOG.md](../CHANGELOG.md).

## Data handling and security

Everything runs on your machine; Searvex has no server. Crawls respect robots.txt, Crawl-delay and rate limits
and identify as `SearvexBot`. Network access is limited to public addresses (SSRF and DNS-rebinding
protection; cloud metadata always blocked); `--render` routes all browser traffic through a local policy proxy.
Repository mode never reads secret files and never follows symlinks. Details: [security.md](security.md),
[privacy.md](privacy.md).

## Known limitations

See [limitations.md](limitations.md). The most relevant: analysis is in memory (measured to 50,000 pages,
1.1 GB); Search Console API access needs your own Google Cloud "Desktop app" client; Bing is experimental;
login-protected areas and server routes behind authentication are not recognised in repository mode; the
plugin has no directory icon yet.

## Evidence

[release-checklist.md](release-checklist.md) lists every acceptance criterion with its evidence;
[quality.md](quality.md) has the real-world validation rounds, live integration checks and benchmarks.
