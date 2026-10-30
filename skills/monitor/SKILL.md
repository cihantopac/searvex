---
description: Re-audit a website with Searvex and compare against the previous run to find regressions and improvements; optionally include Search Console data (read-only).
argument-hint: "<url> [--baseline runId] [--import gsc-export.csv]"
allowed-tools: Bash(node *) Bash(searvex *) Read
---

Run `node "${CLAUDE_PLUGIN_ROOT}/dist/searvex.mjs" monitor $ARGUMENTS` and read `monitor.md`.

Report: score change, new and worsened issues (regressions first), resolved issues, and — only if real
data was provided — Search Console clicks/impressions/CTR/position. Search Console data comes from
`SEARVEX_GSC_TOKEN` + `SEARVEX_GSC_SITE` (read-only OAuth token) or `--import` of a Performance CSV export.
If none is configured, say performance was not measured; never estimate traffic.
For recurring checks, suggest running the same command on a schedule (CI or cron) with `--fail-on high`.
