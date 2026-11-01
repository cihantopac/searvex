# Searvex 1.1.0 — release notes

**Understand Search. Fix What Matters.** 1.1.0 changes how Searvex presents, prioritises and hands over
its findings. The analysis engine, its 90 sourced rules and its evidence are unchanged.

## Highlights

- **SEO action center.** `report.html` opens on what matters: health score (Searvex's own metric), issue
  groups, affected URLs, condition by area, the three issues to fix first and the limits of the run. Tabs for
  Priorities, Issues, GEO, Search performance (with connected data), Changes (with a previous run) and Evidence.
- **English and Turkish**, detected from the browser and switchable; **light, dark or system theme**. Both are
  remembered and work offline under the same strict CSP.
- **Root causes instead of repetition.** A rule that hits most page types becomes one "shared layout" group;
  other occurrences are grouped by URL template or source file, with exact URLs and evidence one click away.
- **Select → repair prompt.** Pick issues, groups or everything visible and generate an editable prompt for
  Claude Code, Codex or another coding agent — or a remediation brief when there is no repository.
- **Automatic vs. agent-assisted vs. manual** is explicit. "Automatic" means a dry-run plan produced a concrete,
  verifiable patch for this repository.
- **Reviews.** `searvex review` stores confirmed / rejected / fixed verdicts next to the audit; the report shows
  them beside the original evidence.
- **Short answers in Claude Code.** Skills reply in 80–150 words with the report link and one next action.
- **12 automatic fix types** (was 9) and a safety fix for monorepo sitemaps.

## Upgrade

```bash
npm install -g searvex-seo@1.1.0
```

Claude Code: `/plugin update searvex@searvex` (or reinstall). Existing runs can be re-rendered with the new report:
`searvex report <runId|latest> --format html`.

No breaking CLI changes. The terminal summary of `audit` is shorter; use `--json` or `report.md` for the full
list in scripts.

## Verification

- Automated tests: unit, integration, Playwright (report interaction: selection, prompt, download, language and
  theme persistence, mobile overflow) and end-to-end CLI runs. CI on Linux, macOS and Windows, Node 20/22/24.
- Real site: ovokodo.com (52 pages, polite crawl). 41 template-level groups collapsed to 9 root-cause groups; the
  duplicate `<title>` on 50 pages is shown as one shared-layout issue with the Inertia.js cause in the evidence.
- Real repository copy (static TR/EN site + Laravel API monorepo): the generated repair prompt carried the
  correct files, references and verification steps; the dry run exposed the monorepo sitemap defect fixed in
  this release. The original repository was not modified.
- Automatic fixes on the bundled static-site fixture: 8 rules verified 1 → 0, Searvex health score 84 → 97, the
  Changes tab shows the comparison, rollback restores the files byte for byte (tested).

Details: [quality.md](quality.md).

## Known limitations

- The report cannot change code or live sites; prompts are handed to a coding agent.
- Turkish covers the interface and rule titles/fixes; per-finding messages and engine notes stay in English.
- "Shared layout" groups are inferred from URL patterns and counts — a strong hint, not proof.
- README images load from the `main` branch on GitHub and npm; they appear once this release is merged.

Full list: [limitations.md](limitations.md).
