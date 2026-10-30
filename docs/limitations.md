# Limitations & unsupported scenarios

Searvex reports what it can observe and labels everything else. Known limits (v0.3.0):

## Data Searvex does not have

- **Traffic, rankings, impressions, CTR:** only via Search Console (token or CSV import). Never estimated.
- **Search volumes, keyword difficulty, SERP features, backlinks:** not fetched; no paid data providers.
  Research reports topic *coverage* differences, not demand.
- **AI citations:** not observable directly. Official sources are Bing Webmaster Tools AI Performance
  (preview) and Search Console; integrations are not implemented yet (CSV import is generic).
- **Core Web Vitals field data:** only with a CrUX API key, and only for origins with enough traffic.
  No Lighthouse/lab measurements.
- **Bing Webmaster, Yandex Webmaster, GA4 APIs:** not implemented.

## Website mode

- Public pages only; login-protected areas are out of scope.
- Response times are single samples from one location.
- JavaScript is not executed unless `--render` is used (requires Playwright; covered by a CI job).
- Content-language detection supports en, tr, de, fr, es, it, pt, nl and needs ~30 words; other languages are not judged.
- Site-level findings (orphans, duplicates, hreflang returns) cover the crawled subset when the page limit is hit.
- Some sites serve different HTML to different user agents (e.g. Next.js streaming metadata, bot
  protection). Searvex sees what `SearvexBot` receives; verify critical cases with Search Console URL Inspection.
- Faceted navigation and pagination patterns are not detected yet beyond tracking/session parameters.
- Business model and page types are heuristics (schema first, then URL patterns).

## Repository mode

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
