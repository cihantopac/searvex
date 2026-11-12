# Limitations & unsupported scenarios

Searvex reports what it can observe and labels everything else. Known limits (v1.3.0):

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
- **Experimental in v1.0:** Bing Webmaster works end to end against the live API, but the owner's sites had no
  Bing data yet, so parsing of real query/page rows is not verified live. It is documented, not advertised as
  fully supported. The Search Console **API and CSV import** and **CrUX** are supported (verified live and
  with real exports; `gsc logout` revocation at Google is verified against a mock server only).
- **Google OAuth:** each user needs their own Google Cloud "Desktop app" client; there is no hosted one-click
  login. Clients in "Testing" status get refresh tokens that expire after 7 days.

## Website mode

- Public pages only; login-protected areas are out of scope.
- Response times are single samples from one location.
- JavaScript is not executed unless `--render` is used (requires Playwright; covered by a CI job).
- Content-language detection supports en, tr, de, fr, es, it, pt, nl and needs ~30 words; other languages are not judged.
- Site-level findings (duplicates, hreflang returns) cover the crawled subset when the page limit is hit;
  orphan pages are then not reported at all, because uncrawled pages may link to them.
- Some sites serve different HTML to different user agents (e.g. Next.js streaming metadata, bot
  protection). Searvex sees what `SearvexBot` receives; verify critical cases with Search Console URL Inspection.
- Faceted navigation is detected from parameter explosion and paginated canonicals; deeper crawl-budget
  analysis for very large catalogues is not implemented.
- Business model and page types are heuristics (schema first, then URL patterns).
- Image sizing (`img.dimensions-missing`) understands the inline `style`, simple class/id rules in the page's own
  `<style>` and fixed-size utility classes; external stylesheets are not fetched, so some CSS-sized images can
  still be reported (the rule is heuristic).
- The Organization-or-Person suggestion uses a heuristic personal-site signal (a name-like homepage title, no
  commercial pages); it does not know who owns the site.
- An interrupted run (SIGINT/SIGTERM, `--max-duration`) is a partial report: site-level findings use the crawled
  subset and the extra probes are skipped. A process killed with SIGKILL writes no report; `--resume` continues
  from the last checkpoint (at most 25 pages or 10 seconds old). On Windows, Ctrl+C (SIGINT) and `--max-duration`
  stop gracefully, but a termination sent by another process cannot be caught and ends the run without a report.

## Local and staging builds

- `--site-url` maps only the exact public origin (scheme, host, port); `http://` and `www.` variants of it are
  real differences and stay unmapped. Finding evidence shows the crawled origin, not the public URL.
- `--pre-launch` evaluates noindex pages as if they were indexable and moves tagged findings out of the score.
  Rules are tagged in the knowledge base (`environment`), not detected from the server, so on a production site
  the profile would hide real HTTPS, compression and noindex problems: use it only for builds that are not live.
- Upstream proxy (`--proxy`, HTTPS_PROXY): `CONNECT` only, Basic authentication only (no NTLM/Kerberos, SOCKS or
  PAC). In the default `proxy` resolution mode the proxy resolves names itself; when its DNS view differs from the
  local one (split-horizon DNS), Searvex cannot see the address it connected to (`--proxy-resolve local` closes
  this at the cost of host-filtering proxies). The search-data integrations (Search Console, Bing, CrUX) connect
  directly, not through the proxy.

## Repository mode

- Not treated as site content: `test(s)`, `__tests__`, `spec(s)`, `e2e`, `fixture(s)`, `testdata`, `bench(marks)`,
  `example(s)`, `sample(s)`, `eval(s)`, `snapshot(s)`, `stories`, `coverage` folders; HTML fragments without a
  document element; `.html` files in template folders (`templates/`, `layouts/`, `partials/` …); Filament admin
  views. Point Searvex at such a folder directly to audit it. A repository with nothing else reports the health
  score as **n/a**.
- Login-protected routes are recognised from Laravel `auth` middleware and from Next.js auth middleware matchers
  or login-redirecting layouts. Guards written another way (a custom middleware name, a check inside the page
  component, a catch-all matcher) are not recognised, and such routes are still checked. Laravel views are shared
  by public and private routes, so findings in a Blade layout are kept; the private routes are listed.
- Static sites: `about.html` is treated as `/about` when its canonical or the sitemap uses that clean URL. URLs in
  the sitemap that no file serves are reported only when no other app in the repository has a matching route,
  and then as heuristic (a server rewrite outside the repository may still serve them).
- Static analysis: JS/TS/JSX/TSX sources are parsed into an AST (@babel/parser). Next.js `metadata` /
  `generateMetadata` objects are read key by key: a key in another object does not count, and branches that
  throw (`notFound()`, `redirect()`) are ignored; a page that calls one unconditionally is not indexable. Metadata computed at runtime (CMS content, i18n
  dictionaries, spread props, helper calls) is treated as unknown rather than missing. Vue SFC `<script>`
  blocks and Astro frontmatter go through the same AST, Astro templates through an HTML parser (a `title` prop
  on a component counts, an HTML `title` attribute does not), and Blade views through a tokenizer that drops
  comments, `@verbatim` and `@php` blocks. SvelteKit `<svelte:head>` is read from the markup (an SEO component
  in it is unknown); Remix `meta` exports through the AST, with `root.tsx` as fallback (Remix's own merge rules for
  nested routes are not modelled); block themes only for the post title level. Vue templates other than Nuxt's
  `<Title>`/`<Meta>`, Blade `@section`/`@yield` resolution across views and PHP code are not analysed.
- Supported: Next.js (app & pages router), Astro, Nuxt, SvelteKit, Remix, Laravel (Blade), WordPress classic and
  block themes, Vite/CRA SPAs, static HTML (and committed build output), monorepos (npm/yarn/pnpm workspaces).
- Partial: Gatsby, Eleventy, Hugo, Jekyll (detected; generic checks only).
- Not supported: Angular, Django/Rails templates, CMS databases.
- Automatic fixes exist for 12 rule types; everything requiring judgement is an agent task. In repositories with
  several apps, sitemaps are a task (one `--site-url` cannot tell which host serves which app); run `optimize` on
  the app folder with its own `--site-url` instead.
- The HTML report cannot change code: repair prompts are handed to a coding agent, and website-only audits get a
  remediation brief. Root-cause groups are inferred from URL templates and files; a "shared layout" group is a
  strong hint, not proof, that one component causes the issue.
- Turkish texts cover the interface and Searvex's own rule titles and fixes; per-finding messages, engine
  limitations and source titles stay in English.

## Scale

- Analysis is in memory. Measured to 50,000 pages of varied text (1.1 GB peak RSS, ~2.5 min crawl and analysis on
  an Apple M4); for larger sites use `--max-pages`, `--include` to audit sections, or `--resume` across sessions.

## Platforms

- Automated tests pass on Linux, macOS and Windows (Node 20, 22, 24) in CI. Manual testing has been on macOS.
