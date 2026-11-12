# Searvex 1.4.0 — release notes

**Understand Search. Fix What Matters.** This release finds the cause behind a group of findings, sees through
more frameworks, scales past 100,000 pages and adds optional lab and analytics data. 92 sourced rules (one new:
`perf.lab-poor`). The report schema is 1.1 (additive).

## Highlights

- **Fix the cause, not the symptoms.**
  - The HTML report has a **By cause** view: observed root causes with their likely consequences, and the
    templates and files that carry several issue types.
  - One page layout behind unrelated URLs (flat slugs) counts as a single "fix once" task, like a URL template.
  - With Search Console or Bing data joined to an audit, priorities weigh pages by their verified clicks.
- **Repositories, more precisely.**
  - Vue SFCs, Astro pages and Blade views are parsed instead of matched with regexes.
  - New adapters: SvelteKit, Remix and WordPress block themes, including sitemap and robots fixes.
  - Routes behind a login (Laravel `auth` middleware, Next.js auth matchers or login-redirecting layouts) are no
    longer reported for metadata and indexability.
  - A Next.js page that only calls `notFound()` or `redirect()` is no longer counted as a page.
- **Large sites.**
  - The analysis of about 50,000 pages with varied text no longer crashes (`Set maximum size exceeded`).
  - Page texts live in the run directory (`texts.txt`) and the content analysis uses compact structures:
    100,000 pages run under a 2 GB heap; 50,000 pages analyse in about a third less time. Reports are unchanged.
- **Behind a corporate proxy.** `--proxy` / `HTTPS_PROXY` / `NO_PROXY` with `CONNECT` and Basic authentication;
  private targets never go through the proxy.
- **Evidence you can keep.** `--save-html` and `--screenshots` store what the server sent and what the browser
  rendered, linked from the findings (owner-only permissions, 200 MB per run).
- **Deeper competitor research.** Topic clusters covered or missing against each competitor, and the page types
  competitors use for search intents the site lacks (labelled as hypotheses).

## Experimental integrations

Each works against a mock of its API and is labelled experimental until a live run on the owner's account:

- **Lighthouse lab data** — `--lab` runs PageSpeed Insights (mobile) on one page per URL template
  (`searvex psi auth` or `SEARVEX_PSI_API_KEY`). Lab values never decide Core Web Vitals; a score below 50 is the
  new `perf.lab-poor` finding.
- **Google Analytics 4** — `ga4 report <propertyId> [--audit latest]`: organic landing pages and the audit's
  issues on pages with organic traffic.
- **Yandex Webmaster** — `yandex report <siteUrl>`: popular queries of a verified site.

## Upgrade

```bash
npm install -g searvex-seo@1.4.0
```

Claude Code: `/plugin update searvex@searvex`.

### Changes to watch

- `report.json` is schema **1.1**: new optional fields `crawl.proxy`, `crawl.artefacts`,
  `findings[].evidence[].artefact`, `traffic`, `findings[].priority.causedBy` / `.effects`,
  `findings[].structures`, `privateRoutes` and `labData`. Consumers of 1.0 keep working.
- Run directories: `pages.jsonl` records no longer carry page text (`data.mainTextRef` points into the new
  `texts.txt`; `textContent` is empty). Tools that read page text from `pages.jsonl` should read `texts.txt`.
- The `duplicate.title` observation for inherited layout titles lists routes without file paths and ends with
  `(+N more)`.
- Internal-link opportunities with equal scores are ordered by URL instead of discovery order.

## Not in this release

- **Bing AI Performance CSV import:** Bing does not document the export columns; it waits for a real export.
- **Live verification** of Bing (no impressions on the owner's sites yet), PageSpeed Insights, GA4 and Yandex.
- **Local Lighthouse** for local and staging builds (`--lab` needs a public URL).
- **fast-xml-parser 5.12.0** (fixes a low-severity advisory) follows in a patch release once it is two weeks old.

Details: [CHANGELOG](../CHANGELOG.md) · [CLI reference](cli.md) · [schemas](schema.md) ·
[limitations](limitations.md).
