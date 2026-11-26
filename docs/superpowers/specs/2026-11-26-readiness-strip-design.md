# Readiness strip on the report overview — design

Status: draft for owner approval · 2026-11-26 · target release 1.7.0

## Why

The health score measures defects. A site can score 100/100 and still have almost nothing a search or answer engine can use. The Frameva field report (2026-11-26) showed exactly this: https://frameva.io scored 100/100, but it had no structured data on any page, and almost all of its ~20 indexable pages were legal documents. Those facts were only in informational rows, which are hidden by default (`SHOWINFO=false`). The verdict said "No issues found.", and a product owner read that as "done".

**Goal:** show next to the score, at a glance, whether the site is ready for search, without changing what the score means.

## Goals, non-goals, anti-goals

- **Goals:**
  - Three readiness signals on the overview, each with a measured value or "Not measured".
  - When the defect verdict is positive but a signal is low, the verdict says so.
  - The same data goes into `report.json`, so agents and the Markdown report see what the HTML shows.
- **Non-goals:**
  - The health score, its method, `--fail-on`, priorities and the findings are unchanged.
  - No new rules and no new findings.
  - No update notice or phone-home. The stale-plugin note from the field report is out of scope.
- **Anti-goals:**
  - A second headline score (the owner rejected option B).
  - Invented weights.
  - Coral used for "low".
  - Reporting a number Searvex did not measure. Unknown is always "Not measured", never 0.
  - Calling a legitimate choice a gap. Blocking AI *training* crawlers is a business decision, and llms.txt is not used by Google (Searvex already says "no scoring impact"). Neither lowers readiness.

## Approaches considered

1. **The engine computes `readiness` and the report renders it (chosen).**
   - Only the engine knows what was measured. For example, repository mode without a static-site build has no page types and no robots.txt.
   - Only the engine can count JSON-LD, microdata and RDFa together.
   - The Markdown report and agents get the same values.
   - Cost: an additive schema change (1.2 → 1.3).
2. **The client derives readiness from existing fields.** Rejected because of three problems:
   - Structured data could only be counted from JSON-LD (`geo.answerability…signals.structuredData`).
   - In repository mode, "not measured" versus "0" would be guesswork.
   - Agents would not see it.
3. **A second readiness score (ring).** Rejected by the owner, who chose A (signals with fixed thresholds).

## The three signals

Shared definitions:

- **Indexable pages:** `inventory.pages` with `indexable: true`, as the rules decide it. `inventory.pages` already lists only HTML pages that answered 200 without a redirect, so errors, 404s and redirects never count. The pre-launch profile already treats deliberate noindex as indexable.
- **Content pages:** indexable pages whose inventory `type` is not `legal`. The type comes from URL patterns or schema, so it is heuristic, and the detail says so.

| Key | Label (EN / TR) | Value shown | Low when | Not measured when |
|---|---|---|---|---|
| `structuredData` | Structured data / Yapısal veri | % of content pages with at least one typed structured-data node, counted exactly like `inventory.structuredData.pagesWithStructuredData` (`pageSchemaTypes`: JSON-LD, microdata and RDFa types) | below 50 % | no content page exists, or repository mode without a static-site build |
| `contentPages` | Content pages / İçerik sayfaları | number of content pages | fewer than 10 | repository mode without a static-site build (route types are unknown) |
| `aiSearch` | AI search / Yapay zekâ araması | "Open" / "Blocked" | a bot that triggers either existing rule is disallowed for the homepage. That is Googlebot or Bingbot (`geo.search-bot-blocked`), or OAI-SearchBot, Claude-SearchBot or PerplexityBot with purpose `ai-search` (`geo.ai-search-bot-blocked`). The same conditions are reused, and the detail says "for the homepage". | robots.txt was unreachable, or no bot matrix exists (`geo.bots` is empty). In repository mode, also when no robots file was found in the repository: a missing file there is unknown, not allow-all. In website mode a 404 robots.txt is a real measurement (allow-all), so it reads Open. |

Notes on the table:

- When a signal is low, its dot is filled in neutral grey ("Low" in the accessible name).
- The 50 % and 10 thresholds are my call, and the owner can change them. They are constants in one place (`src/analyze/readiness.ts`), listed in the report detail and in docs/schema.md.
- `aiSearch` detail shows two things, both informational and never "low":
  - llms.txt: present, absent or not checked;
  - the number of AI training crawlers that are blocked.
- A partial crawl (truncated or interrupted) keeps the values. They describe the crawled pages, and the detail says "Based on N crawled pages (partial crawl)".
- Repository mode with several static-site apps uses the first app, the same one `inventory` and `geo` already describe. The detail names that app's origin.
- `ready` is `false` as soon as any *measured* signal is low, even when the others are not measured. The verdict only states what was measured.
- An unreachable or robots-blocked target has no `readiness` field at all, and the overview shows no strip, like the other sections in that case.

## report.json (schema 1.3, additive)

```ts
readiness?: {
  ready: boolean | null;            // true: every measured signal ok; false: any low; null: none measured
  structuredData: Signal & { pages: number; of: number; percent: number };
  contentPages: Signal & { pages: number; indexable: number; legal: number };
  aiSearch: Signal & { blocked: string[]; llmsTxt: 'present' | 'absent' | 'not-checked'; trainingBlocked: number };
  thresholds: { structuredDataPercent: 50; contentPages: 10 };
}
type Signal = { status: 'ok' | 'low' | 'not-measured'; partial?: true };
```

Rules for the field:

- Numeric fields are present only when the signal's status is not `not-measured`.
- The field is optional, so reports from before 1.7.0 still validate.
- `SCHEMA_VERSION` becomes `'1.3'`. The generated `schema/report.schema.json` and `docs/schema.md` are updated.
- The HTML report reads `readiness` from the report it was given. A report without the field (older JSON re-rendered) shows no strip and the old verdict.

## Overview UI

Placement: a strip inside the hero surface, under the key numbers and above the "Not measured" disclosure.

```
 ┌───────────────────────────────────────────────────────────────┐
 │  (100)   No issues found. Not search-ready yet.               │
 │          Score counts defects only.                           │
 │          Issue types 2 · Pages 16 · Critical 0                │
 │  ───────────────────────────────────────────────────────────  │
 │  Search readiness                                             │
 │  ○ Structured data 0%   ○ Content pages 3   ● AI search Open  │
 │  ▸ 3 not measured                                             │
 └───────────────────────────────────────────────────────────────┘
```

**Items:**

- Each item is a button showing a label of 3 words or fewer, the value, and a small dot:
  - ok: teal filled dot;
  - low: neutral hollow ring, with a darker value;
  - not measured: faint "—", with the value "Not measured".
- No coral anywhere in the strip.
- The accessible name reads, for example: "Structured data: 0 %, low".

**Tapping an item** opens one detail panel under the strip. This is a disclosure: one panel is open at a time, the button carries `aria-expanded`, and tapping again closes it. Each panel holds:

- one sentence on what is measured and the threshold;
- the numbers behind the value, for example "0 of 3 content pages · 17 legal pages excluded";
- "Heuristic" where it applies (page types);
- a link to the related rows:

| Item | Link | What it opens |
|---|---|---|
| Structured data | "Show rows ›" | Issues tab with informational rows on (`SHOWINFO=true`, with the checkbox synced), filtered to category `structured-data`. `sd.none` is an info finding emitted per page without structured data, so the list is not empty when the value is low. |
| AI search | "AI access ›" | GEO tab (website mode only) |
| Content pages | — | No link, because there are no rows to show. The panel lists the indexable page count by type, top 5. |

This is a two-step interaction instead of "tap goes straight to the filtered rows". It is my call:

- the explanation of *why* a signal is low has to live somewhere, and the owner wants details behind disclosures;
- the content-pages signal has no rows to filter to.

**Verdict:**

| Existing verdict | Any signal low | Result |
|---|---|---|
| `ov.verdict.none` "No issues found." | yes | `ov.verdict.noneNotReady` "No issues found. Not search-ready yet." / TR "Sorun bulunmadı. Aramaya henüz hazır değil." |
| `ov.verdict.good` "Good shape." | yes | `ov.verdict.goodNotReady` "Good shape. Not search-ready yet." / TR "İyi durumda. Aramaya henüz hazır değil." |
| fair, poor, na | — | Unchanged, because the defects are the message there |
| any | no (or `ready` is `null`) | Unchanged |

The "Fix first" suffix is appended as today.

**Section:** "Search readiness" / "Arama hazırlığı" heading with an `h2`-style note: "Separate from the score: what search and AI engines can use." All strings get EN and TR keys with parity, in ES5 client code, rendered through `el()`/textContent only. CSP is unchanged.

**Repository mode:**

- The same strip appears, but an item whose data does not exist shows "Not measured".
- When every item is not measured, the strip is not shown. A row of three dashes is noise.

## Markdown report

One summary-table row: `| Search readiness | structured data 0 % (low) · content pages 3 (low) · AI search open |`. Not-measured signals print "not measured".

## Tests and release

- **Unit** (`test/unit/readiness.test.ts`):
  - thresholds at the boundary: 49/50 %, 9/10 pages;
  - legal pages are excluded;
  - microdata-only and RDFa-only pages count;
  - an invalid JSON-LD block alone does not count;
  - blocked AI search bots;
  - training-only blocks and missing llms.txt do not lower readiness;
  - an unreachable robots.txt gives not measured;
  - repository mode with and without a static site;
  - `ready` is `null` when nothing was measured.
- **Schema:** report-json and schema-contract tests validate the 1.3 field; a 1.2 report without the field still validates.
- **Browser** (`test/integration/html-reports.test.ts`, Playwright):
  - the strip renders three items;
  - the verdict reads "No issues found. Not search-ready yet." on a defect-free fixture with no structured data;
  - tapping an item toggles `aria-expanded` and shows the detail;
  - "Show rows ›" lands on the Issues tab with info rows visible and filtered;
  - no coral in the strip (computed colour);
  - EN/TR parity;
  - no CSP violations.
- **Screenshots:** regenerate `docs/assets/dashboard-*.webp` and `mobile-tr-dark.webp` with `scripts/screenshots.mjs`.
- **Release files:** rebuild and commit `dist/searvex.mjs`; add a CHANGELOG "Unreleased" entry; update docs/schema.md.

## Left to the builder

- The exact module shape of `src/analyze/readiness.ts`, and where the repository mode calls it.
- CSS details within the existing tokens: spacing, and the layout that stacks the items on mobile.
- The exact wording of each detail sentence, kept to one short sentence in EN and TR.
