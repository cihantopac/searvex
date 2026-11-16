# Searvex 1.6.0 — release notes

**Understand Search. Fix What Matters.** This release redesigns the HTML report so it is calm, visual and quick to
read. The data stays the same. 92 sourced core rules; report schema 1.2 (unchanged).

## Highlights

- **A redesigned report.**
  - Three colours: neutral surfaces, the brand teal for structure and data, and coral only for actions and
    critical/high severity.
  - Short labels on screen. Longer explanations sit behind (i) toggles and disclosures, and none were removed.
  - Works in light, dark and system themes, in English and Turkish, and on a phone.
- **Fewer tabs:** Overview · Issues · GEO · Search · Changes · Details.
  - Priorities is folded into Overview and Issues.
  - By cause and Evidence move under Details.
- **Overview at a glance:**
  - the score ring with a one-line verdict;
  - the key numbers;
  - what was not measured, collapsible;
  - "Fix first";
  - an area strip that filters the issue list;
  - the change since the last run.
- **Issues that read like a list:**
  - Each row shows a severity dot, the title, where it occurs and the page count.
  - Opening a row shows the problem, the fix, how to verify it and its tags.
  - Root-cause groups, evidence and official sources sit one click deeper.
  - Severity chips filter the list; fix method, evidence level and info notes are under "Filters".
- **Selection and prompt.** A floating selection bar and a simpler repair-prompt dialog.
- **New README and screenshots,** plus a new social preview image.

## Upgrade

```bash
npm install -g searvex-seo@1.6.0
```

Claude Code: `/plugin update searvex@searvex`. GitHub Action: `uses: cihantopac/searvex@v1.6.0`.

### Changes to watch

- `report.json`, `report.md`, SARIF and the repair prompt text are unchanged.
- Scripts that read `report.html` through its markup (tab ids, CSS classes) need updating:
  - the tab ids are now `overview`, `issues`, `geo`, `search`, `changes` and `details`;
  - issue rows are `.row` elements.
  - Use `report.json` for automation.
- **Security:** fast-xml-parser is now 5.12.0, which fixes the low-severity advisory GHSA-474x-hrwr-fgx4
  (quadratic CPU on unterminated tags in a sitemap). `npm audit` reports no known vulnerabilities in runtime
  dependencies.

## Not in this release

- **Plugin icon and directory submission** wait for the final brand mark.
- **GitHub Marketplace listing** of the action is a manual step on GitHub.
- Still waiting for owner data: Bing live verification, the Bing AI Performance import, and live runs of
  PageSpeed Insights, GA4 and Yandex (experimental).

Details: [CHANGELOG](../CHANGELOG.md) · [CLI reference](cli.md) · [schemas](schema.md) ·
[limitations](limitations.md).
