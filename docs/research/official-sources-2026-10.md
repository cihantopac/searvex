# Official source verification — 2026-10-30

Method: official pages fetched directly unless marked *excerpt* (see [README](README.md)).
Known gaps: Bing help pages (`bing.com/webmasters/help/*`) render client-side and could only be
verified from excerpts; no official ByteDance (Bytespider) documentation exists.

## Changes since 2025 that the rule base must reflect

- **FAQ rich results removed** from Google Search on 2026-05-07; docs removed 2026-06-15
  (<https://developers.google.com/search/updates>). HowTo was removed in 2023.
- **Google documents that it does not use `llms.txt`** (AI optimization guide, mythbusting section, 2026-06-15):
  <https://developers.google.com/search/docs/fundamentals/ai-optimization-guide#mythbusting>.
- **Search Console "Search generative AI" setting** controls inclusion in AI Overviews / AI Mode:
  <https://developers.google.com/search/docs/crawling-indexing/control-what-you-share> (changelog 2026-10-21).
- **Bing Webmaster Tools AI Performance** report (public preview since 2026-02): citations across Copilot and
  Bing AI summaries by page and grounding query; sampled, no clicks.
  <https://blogs.bing.com/webmaster/2026/2/Introducing-AI-Performance-in-Bing-Webmaster-Tools-Public-Preview/> (*excerpt*).
- June 2025 simplification phased out Book Actions, Course Info, ClaimReview, Estimated Salary, Learning Video,
  Special Announcement, Vehicle Listing: <https://developers.google.com/search/blog/2025/06/simplifying-search-results>.
- Nov 2025: Practice Problem deprecated; Dataset markup only used by Dataset Search.

## Crawling & robots

| Fact | Engines | Source | Level |
|---|---|---|---|
| RFC 9309 robots.txt; parsers read ≥500 KiB; 4xx = allow all, 5xx = disallow all; crawl-delay undefined | all | <https://www.rfc-editor.org/rfc/rfc9309.html> | fetched |
| Google ignores crawl-delay; 500 KiB limit; cached ≤24h; 5xx → crawl pause then last good copy ≤30 days | google | <https://developers.google.com/crawling/docs/robots-txt/robots-txt-spec> | fetched |
| Bing honours crawl-delay | bing | <https://www.bing.com/webmasters/help/crawl-control-55a30303> | excerpt |
| Yandex ignores Crawl-delay since 2018-02-22 (use Crawl rate setting); supports Clean-param | yandex | <https://yandex.com/support/webmaster/en/controlling-robot/robots-txt.html> | fetched |
| robots.txt does not prevent indexing; noindex must be crawlable | google | <https://developers.google.com/search/docs/crawling-indexing/block-indexing> | fetched |
| Google robots meta directives (noindex, nofollow, none, nosnippet, indexifembedded, max-snippet, max-image-preview, max-video-preview, notranslate, noimageindex, unavailable_after); noarchive/nocache no longer used by Google | google | <https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag> | fetched |
| Bing NOARCHIVE excludes content from Copilot answers/training; NOCACHE limits to URL/title/snippet | bing | <https://blogs.bing.com/webmaster/2023/9/Announcing-new-options-for-webmasters-to-control-usage-of-their-content-in-Bing-Chat/> | fetched |
| Yandex meta robots: noindex, nofollow, none, noarchive (meta + header) | yandex | <https://yandex.com/showcaptcha?cc=1&form-fb-hint=2.115&mt=29E12DC1BB66015BB4FE79DF9797AE99094C10B8B16BB4C219B90302CE5D413AFA70A3D7254DC0AA1F74E5844459FC87BFC3907B61830FBC19C907A6080E5070B70370761DC3C5C5641AC902F29E106856AE83E2CD2108388A474DEA17B5346C55662AF7BFE8488E18CCB56EC551B39B028F5F685CA04F8BD7468F9365D8F113E4B14A6DE8FC1650C5&retpath=aHR0cHM6Ly95YW5kZXguY29tL3N1cHBvcnQvd2VibWFzdGVyL2NvbnRyb2xsaW5nLXJvYm90L2h0bWwuaHRtbA%2C%2C_04b6f9e07c157641d47111d5f22abcae&t=2%252F1793371317%252Fb0a414ab64b21cfe33b53b40fd8e0123&u=9670647425019679259&s=d696889c6fc2d917594019078c379394> | fetched |
| Google crawlers fetch the first 15 MB of a file | google | <https://developers.google.com/crawling/docs/crawlers-fetchers/overview-google-crawlers> | fetched (partial) |

## Canonical, hreflang, titles

| Fact | Engines | Source | Level |
|---|---|---|---|
| rel=canonical is a strong signal (below redirects); absolute URLs; no robots.txt / noindex for canonicalisation | google | <https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls> | fetched |
| Bing: canonical consolidates signals for search and Copilot; sitemaps list canonical URLs only | bing | <https://blogs.bing.com/webmaster/2025/12/Does-Duplicate-Content-Hurt-SEO-and-AI-Search-Visibility/> | excerpt |
| hreflang: reciprocal, self-reference, x-default, ISO 639-1 (+ ISO 3166-1 alpha-2), fully-qualified; Google ignores `lang` attr for language detection | google | <https://developers.google.com/search/docs/specialty/international/localized-versions> | fetched |
| Bing recommends hreflang (2025) | bing | same Bing blog post as above | excerpt |
| Yandex supports hreflang link elements and x-default | yandex | <https://yandex.com/support/webmaster/en/yandex-indexing/locale-pages> | excerpt |
| No title / meta description length limit; truncated by device width | google | <https://developers.google.com/search/docs/appearance/title-link>, <https://developers.google.com/search/docs/appearance/snippet> | fetched |
| meta keywords has no effect | google | <https://developers.google.com/search/docs/crawling-indexing/special-tags> | fetched |

## Structured data

| Fact | Source | Level |
|---|---|---|
| JSON-LD recommended; Microdata/RDFa supported; no hidden-content markup; no rich-result guarantee | <https://developers.google.com/search/docs/appearance/structured-data/sd-policies> | fetched |
| HowTo removed (2023), FAQ limited (2023) → removed (2026) | <https://developers.google.com/search/blog/2023/08/howto-faq-changes>, <https://developers.google.com/search/updates> | fetched |
| Search gallery (current supported features) | <https://developers.google.com/search/docs/appearance/structured-data/search-gallery> | fetched |
| Rich Results Test | <https://search.google.com/test/rich-results> | fetched |

## Performance, sitemaps, indexing

| Fact | Source | Level |
|---|---|---|
| CWV: LCP ≤2.5 s, INP ≤200 ms, CLS ≤0.1 at p75, per device | <https://web.dev/articles/vitals> | fetched |
| Sitemaps: 50,000 URLs / 50 MB; lastmod used only if consistently accurate; priority & changefreq ignored | <https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap> | fetched |
| Bing ignores changefreq/priority; lastmod must be accurate | <https://blogs.bing.com/webmaster/2025/7/Keeping-Content-Discoverable-with-Sitemaps-in-AI-Powered-Search/> | excerpt |
| IndexNow: key 8–128 chars at `/{key}.txt`, ≤10,000 URLs/POST; participants Bing, Yandex, Seznam, Naver, Yep, …; Google not a participant | <https://www.indexnow.org/documentation>, <https://www.indexnow.org/searchengines.json> | fetched |
| Google Indexing API only for JobPosting / BroadcastEvent-in-VideoObject; 200 publish/day default | <https://developers.google.com/search/apis/indexing-api/v3/quickstart> | fetched |

## AI / GEO

| Fact | Source | Level |
|---|---|---|
| AI Overviews / AI Mode: no additional requirements, no special files or schema; controls: nosnippet, data-nosnippet, max-snippet, noindex | <https://developers.google.com/search/docs/appearance/ai-features> | fetched |
| Google mythbusting: no llms.txt, no chunking, no special schema needed ("neither harm nor help") | <https://developers.google.com/search/docs/fundamentals/ai-optimization-guide#mythbusting> | fetched |
| Google-Extended: robots token only; Gemini training/grounding; no effect on Search inclusion or ranking | <https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers> | fetched |
| OpenAI: GPTBot (training), OAI-SearchBot (ChatGPT search), ChatGPT-User (user-triggered; robots may not apply) | <https://developers.openai.com/api/docs/bots> | fetched |
| Anthropic: ClaudeBot (training), Claude-SearchBot (search), Claude-User (user fetch) | <https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler> | fetched |
| Perplexity: PerplexityBot (search, not training), Perplexity-User (user fetch) | <https://docs.perplexity.ai/docs/resources/perplexity-crawlers> | fetched |
| Apple: Applebot (search), Applebot-Extended (training opt-out token, does not crawl) | <https://support.apple.com/en-us/119829> | fetched |
| CCBot (Common Crawl dataset) | <https://commoncrawl.org/ccbot> | fetched |
| Meta: meta-externalagent (training/indexing), meta-externalfetcher (user fetch) | <https://developers.facebook.com/documentation/sharing/webmasters/web-crawlers> | fetched |
| Amazon: Amazonbot (may train), Amzn-SearchBot (search), Amzn-User (user) | <https://developer.amazon.com/amazonbot> | fetched |
| Bytespider | — | **unverified** (no official docs) |
| llms.txt is a 2024 proposal, not a standard | <https://llmstxt.org/> | fetched |

## APIs

| Fact | Source | Level |
|---|---|---|
| GSC searchanalytics.query: dimensions country/device/page/query/searchAppearance/date/hour; rowLimit ≤25,000 | <https://developers.google.com/webmaster-tools/v1/searchanalytics/query> | fetched |
| GSC limits: 1,200 QPM per site/user; URL Inspection 2,000/day, 600/min per site | <https://developers.google.com/webmaster-tools/limits> | fetched |
| Bing Webmaster API: OAuth 2.0 or API key | <https://learn.microsoft.com/en-us/bingwebmaster/getting-access> | fetched |
| Yandex Webmaster API v4.1 (OAuth) | <https://yandex.com/dev/webmaster/doc/en/> | fetched |
| GA4 Data API quotas | <https://developers.google.com/analytics/devguides/reporting/data/v1/quotas> | fetched |

## Quality, spam, JS, status codes

| Fact | Source |
|---|---|
| Spam policies (cloaking, doorways, expired domain abuse, scaled content abuse, site reputation abuse, link spam, …) | <https://developers.google.com/search/docs/essentials/spam-policies> |
| JS SEO: crawl → render → index; links must be `<a href>`; noindex in raw HTML may skip rendering | <https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics>, <https://developers.google.com/search/docs/crawling-indexing/links-crawlable> |
| 5xx/429 slow crawling; up to 10 redirect hops; soft 404 definition | <https://developers.google.com/crawling/docs/troubleshooting/http-status-codes> |
| Permanent: 301, 308, instant meta refresh; temporary: 302, 303, 307; JS redirects last resort | <https://developers.google.com/search/docs/crawling-indexing/301-redirects> |
| E-E-A-T is not itself a ranking factor; no preferred word count | <https://developers.google.com/search/docs/fundamentals/creating-helpful-content> |

## Myths that are deliberately NOT rules

1. Meta keywords help ranking — Google: no effect.
2. Fixed title/description length (60/160) — no limit; Searvex only reports *truncation risk* as heuristic info.
3. Keyword density targets — no source; keyword stuffing is spam.
4. Minimum/ideal word count — Google: no preferred word count. Searvex's "low text" check is a heuristic prompt to review intent, never a word-count target.
5. llms.txt as ranking/AI-visibility factor — Google: not used.
6. Special schema/chunking for AI Overviews — Google: not needed.
7. Blocking Google-Extended removes you from AI Overviews — it does not.
8. robots.txt Disallow removes pages from the index — it does not.
9. Text-to-HTML ratio — no official source.
10. Sitemap priority/changefreq — ignored by Google and Bing.
11. FAQ/HowTo markup earns rich results — removed from Google Search.
12. E-E-A-T as a scoreable factor — not a ranking factor.
13. IndexNow speeds up Google — Google is not a participant.
14. Crawl-delay works everywhere — Google ignores it, Yandex dropped it.
