# Limitations & unsupported scenarios

Searvex reports what it can observe and labels everything else. Known limits (v0.7.0):

## Data Searvex does not have

- **Traffic, rankings, impressions, CTR:** only via Search Console (`gsc auth` with your own OAuth client, or
  `gsc import` of a CSV export) or Bing Webmaster Tools. Never estimated; without data they are "Not measured".
- **Search Console CSV exports** have no query × page combination and at most 1,000 rows per table, so query →
  page mapping, shared-query analysis and intent mismatches need the API. Turkish and English UI
  exports are verified against real downloads of the same property (file names, headers, number format,
  filters; identical results); other UI languages are recognised from published UI terms (best-effort). An export whose pages span several subdomains is
  treated as a domain property (`sc-domain:`), whose totals include every subdomain.
- **Shared queries** (several pages with impressions for one query) are classified heuristically; one
  aggregated period cannot prove harmful cannibalisation.
- **Search volumes, keyword difficulty, SERP features, backlinks:** not fetched; no paid data providers.
  Research reports topic *coverage* differences, not demand.
- **AI citations:** not observable directly. Official sources are Bing Webmaster Tools AI Performance
  (preview) and Search Console; no AI-visibility integration is implemented yet.
- **Core Web Vitals field data:** only with a CrUX API key, and only for origins with enough traffic.
  No Lighthouse/lab measurements.
- **Bing Webmaster:** API key only; reports are built from the top pages by clicks, so totals are not site
  totals. **Yandex Webmaster, GA4:** not implemented.
- **Experimental in v1.0:** the Search Console API, Bing Webmaster and CrUX are implemented and tested against
  recorded API behaviour, but have not yet been verified against the live services. They are documented, not
  advertised as fully supported. The Search Console **CSV import is supported** (verified with real exports).
- **Google OAuth:** each user needs their own Google Cloud "Desktop app" client; there is no hosted one-click
  login. Clients in "Testing" status get refresh tokens that expire after 7 days.

## Website mode

- Public pages only; login-protected areas are out of scope.
- Response times are single samples from one location.
- JavaScript is not executed unless `--render` is used (requires Playwright; covered by a CI job).
- Content-language detection supports en, tr, de, fr, es, it, pt, nl and needs ~30 words; other languages are not judged.
- Site-level findings (orphans, duplicates, hreflang returns) cover the crawled subset when the page limit is hit.
- Some sites serve different HTML to different user agents (e.g. Next.js streaming metadata, bot
  protection). Searvex sees what `SearvexBot` receives; verify critical cases with Search Console URL Inspection.
- Faceted navigation is detected from parameter explosion and paginated canonicals; deeper crawl-budget
  analysis for very large catalogues is not implemented.
- Business model and page types are heuristics (schema first, then URL patterns).

## Repository mode

- Not treated as site content: `test(s)`, `__tests__`, `spec(s)`, `e2e`, `fixture(s)`, `testdata`, `bench(marks)`,
  `example(s)`, `sample(s)`, `eval(s)`, `snapshot(s)`, `stories`, `coverage` folders; HTML fragments without a
  document element; `.html` files in template folders (`templates/`, `layouts/`, `partials/` …); Filament admin
  views. Point Searvex at such a folder directly to audit it. A repository with nothing else reports the health
  score as **n/a**.
- Login-protected server views (e.g. Laravel routes behind `auth` middleware) are not recognised statically;
  metadata findings on such layouts can be ignored.
- Static sites: `about.html` is treated as `/about` when its canonical or the sitemap uses that clean URL. URLs in
  the sitemap that no file serves are reported only when no other app in the repository has a matching route,
  and then as heuristic (a server rewrite outside the repository may still serve them).
- Static analysis: JS/TS/JSX/TSX sources are parsed into an AST (@babel/parser). Next.js `metadata` /
  `generateMetadata` objects are read key by key: a key in another object does not count, and branches that
  throw (`notFound()`, `redirect()`) are ignored. Metadata computed at runtime (CMS content, i18n
  dictionaries, spread props, helper calls) is treated as unknown rather than missing. Astro templates, Vue
  SFC templates, Blade and PHP are still checked with regexes; a file that does not parse also falls back to
  them.
- Supported: Next.js (app & pages router), Astro, Nuxt, Laravel (Blade), WordPress classic themes,
  Vite/CRA SPAs, static HTML (and committed build output), monorepos (npm/yarn/pnpm workspaces).
- Partial: SvelteKit, Remix, Gatsby, Eleventy, Hugo, Jekyll (detected; generic checks only).
- Not supported: WordPress block themes (no `header.php`), Angular, Django/Rails templates, CMS databases.
- Automatic fixes exist for 9 rule types; everything requiring judgement is an agent task.

## Scale

- Analysis is in memory (~25 KB per page). Tested to 20,000 pages; for larger sites use `--max-pages`,
  `--include` to audit sections, or `--resume` across sessions.

## Platforms

- Automated tests pass on Linux, macOS and Windows (Node 20, 22, 24) in CI. Manual testing has been on macOS.
