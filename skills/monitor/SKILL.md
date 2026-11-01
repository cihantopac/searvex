---
description: Single step 3 of the /searvex workflow - Re-audit a website with Searvex and compare against the previous run to find regressions and improvements; optionally include Search Console data (read-only).
argument-hint: "<url> [--baseline runId] [--import gsc-export.csv]"
allowed-tools: Bash(node *) Bash(searvex *) Read
---

Run `node "${CLAUDE_PLUGIN_ROOT}/dist/searvex.mjs" monitor $ARGUMENTS` and read `monitor.md`.

If the user has Search Console access, run `node "${CLAUDE_PLUGIN_ROOT}/dist/searvex.mjs" gsc report <property> --audit latest`
(after a one-time `gsc auth --client <their Desktop OAuth client JSON>`, which the user runs in their own terminal),
or `gsc import <export.zip> --audit latest` for a Performance CSV export; for Bing use `bing report <siteUrl>` after
the user stored a key with `searvex bing auth` in their own terminal (never ask for the key in chat). These give verified queries, striking-distance opportunities, low-CTR pages and queries
shared by several pages — present them as verified data, separately from heuristics.

Report in 80–150 words: score change, new and worsened issues (regressions first), resolved issues, and —
only if real data was provided — Search Console clicks/impressions/CTR/position. Link `monitor.html` (and the
audit's `report.html`, whose "Changes" tab shows the same comparison) instead of listing every change. Search Console data comes from
`SEARVEX_GSC_TOKEN` + `SEARVEX_GSC_SITE` (read-only OAuth token) or `--import` of a Performance CSV export.
If none is configured, say performance was not measured; never estimate traffic.
For recurring checks, suggest running the same command on a schedule (CI or cron) with `--fail-on high`.
