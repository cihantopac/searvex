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

## Updating the knowledge base

1. Re-read each source (prioritise `excerpt` and `url-resolved` levels and anything older than 6 months).
2. Check the Google Search Central changelog (<https://developers.google.com/search/updates>) and the Bing
   Webmaster blog for retirements and new features.
3. Update descriptions, severities, `checked` dates and `level`; bump the file `version`.
4. If guidance changed, deprecate the old rule (`"status": "deprecated"`) rather than deleting it, so
   historical reports stay interpretable.
5. Run `npm test` and `searvex rules validate`.

Known re-verification backlog: Bing help pages (client-rendered, `excerpt` level) and `url-resolved`
sources (images, URL structure, mobile-first, page experience, MDN/W3C pages).
