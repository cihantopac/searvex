# Search knowledge base

The rule base lives in `knowledge/rules/*.json` (one file per category). Version: date-based
(`2026.10.30`). It is the single source of truth for titles, severities, engine scope and sources;
code only decides *when* a rule applies.

## Rule schema

```json
{
  "id": "canonical.in-body",
  "title": "rel=canonical outside <head> is ignored",
  "category": "canonicalization",
  "severity": "high",
  "confidence": "verified",
  "engines": ["google"],
  "description": "What is checked and why, neutral and precise.",
  "appliesWhen": "Optional: preconditions.",
  "fix": "Concrete fix.",
  "verify": "How to confirm the fix.",
  "exceptions": "Optional: when not to act.",
  "sources": [{ "title": "…", "url": "https://developers.google.com/…", "checked": "2026-10-30", "level": "fetched" }],
  "status": "active",
  "conflictsWith": [],
  "autofix": true
}
```

- `confidence`: `verified` (directly observed), `heuristic` (inference, may be wrong), `unmeasurable`.
- `engines`: `google`, `bing`, `yandex`, `all`, `ai`. Never merge engine policies into one rule when
  they differ (e.g. crawl-delay: Google ignores it, Yandex dropped it, Bing honours it).
- `sources[].level`: `fetched` (page read directly), `excerpt` (page not fetchable; confirmed from search
  excerpts), `url-resolved` (URL live; statement from maintainer knowledge — pending direct re-read).
- `autofix` must match `AUTOFIX_RULES` in `src/optimize/fixes.ts` (test-enforced).

## Validation (`searvex rules validate`)

Errors: invalid ids/enums, missing fix/verify, active rule without sources, non-official source domain,
invalid or future check dates, `conflictsWith` pointing to unknown rules or to an *active* rule with
overlapping engines, implementation referencing unknown rules. Warnings: sources older than 365 days,
active rules without implementation. CI runs validation and the consistency tests.

Official-domain allowlist: Google (developers/support/search), web.dev, Bing (bing.com, blogs.bing.com,
learn.microsoft.com), Yandex, IndexNow, schema.org, W3C/WHATWG/MDN, IETF/RFC Editor, sitemaps.org,
OpenAI, Anthropic, Perplexity, Apple, Common Crawl, Meta, Amazon, ogp.me, llmstxt.org.

## Myth firewall

Documented in [research/official-sources-2026-10.md](research/official-sources-2026-10.md#myths-that-are-deliberately-not-rules).
Popular practices without official support are **not** rules, or appear only as `info` with an explicit
"no effect" explanation (meta keywords, llms.txt, title truncation). Tests guard these.

## Automatic source revalidation

`searvex rules check-sources` fetches every cited source (politely, per-host delay) and compares it with
`knowledge/source-snapshots.json`: HTTP status, redirects, page title, the page's own "last updated" date
(Google/web.dev/MDN patterns) and a SHA-256 of its normalised main text. Results: `unchanged`, `new`,
`date-changed`, `content-changed`, `redirected`, `broken`, `unreadable` (client-rendered pages, e.g. Bing
help). Exit code 1 when anything needs review. `--update` records the new snapshot. A weekly GitHub
workflow (`.github/workflows/sources.yml`) runs the check; rules are never changed automatically.

First run (2026-10-30): 14 sources redirected — Google moved its crawling documentation to
`developers.google.com/crawling/…`. The cited facts (500 KiB robots.txt limit, no crawl-delay, 10 redirect
hops, 429 handling, 15 MB fetch limit, Google-Extended not affecting Search) were re-verified on the new pages
before the URLs were updated.

## Updating the knowledge base

1. Re-read each source (prioritise `excerpt` and `url-resolved` levels and anything older than 6 months).
2. Check the Google Search Central changelog (<https://developers.google.com/search/updates>) and the Bing
   Webmaster blog for retirements and new features.
3. Update descriptions, severities, `checked` dates and `level`; bump the file `version`.
4. If guidance changed, deprecate the old rule (`"status": "deprecated"`) rather than deleting it, so
   historical reports stay interpretable.
5. Run `npm test` and `searvex rules validate`.

Re-verification round (2026-10-30): every `excerpt` and `url-resolved` source was re-read. Bing help pages
were read rendered in a browser. 146 of 148 citations are now `fetched`. Sources that did not state the rule's
claim were replaced (Bing duplicate-content and sitemap blog posts → Google "Build a sitemap" and Bing Webmaster
Guidelines "Sitemaps should: List only canonical URLs"; site-names → Organization structured data). Still
`url-resolved`: `canonical.target-error` and `sd.invalid-json` (the cited pages do not state the claim
explicitly).
