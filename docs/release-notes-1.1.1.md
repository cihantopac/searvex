# Searvex 1.1.1 — release notes

**Understand Search. Fix What Matters.** A visual polish release. The analysis engine, its 90 sourced rules,
its evidence and the CLI are unchanged.

## Highlights

- **One brand, everywhere.** Report themes, charts, buttons, diagrams and screenshots now use the approved
  Searvex palette: teal `#0e4f55`, ink `#13201f`, warm paper `#f6f1e7`, with coral `#b8432d` reserved for the
  logo's caret. Light and dark palettes keep WCAG AA contrast; severity colours keep their meaning.
- **Overview leads with action.** The three issues to fix first now sit directly below the key numbers.
- **Limits in one line.** What a run did not cover (Search Console data, AI citations, Core Web Vitals,
  JavaScript rendering, partial crawls) is a one-line summary with expandable details.
- **Better Turkish.** The limits summary and its details are fully translated; several awkward interface
  terms were replaced.
- **Mobile.** Tighter KPI grid and a smaller score gauge on narrow screens.
- **Shorter README** with fresh, unedited screenshots of the final report.

## Upgrade

```bash
npm install -g searvex-seo@1.1.1
```

Claude Code: `/plugin update searvex@searvex`. Re-render an existing run with the new look:
`searvex report <runId|latest> --format html`.

No breaking changes.
