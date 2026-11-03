# Searvex 1.2.0 — release notes

**Understand Search. Fix What Matters.** Trustworthy in pre-launch use. Local and staging builds no longer
lose points for their test server or a deliberate pre-launch state, and scripts get clear exit codes for an
unreachable target. 91 sourced rules (one new).

## Highlights

- **Audit a build as its public site.** `--site-url https://example.com` in `audit`, `geo`, `monitor` and
  `run` maps the public origin to the crawled one. A canonical to the page's own public URL counts as
  self-canonical, the declared sitemap is read from the build, and absolute internal links are crawled. The
  report header says "Audited `http://127.0.0.1:4400` as `https://example.com`".
- **Pre-launch profile.** `--pre-launch` audits the build as it will be once live.
  - Test-server findings (no HTTPS, no compression) are listed as **environment-dependent**.
  - Deliberate pre-launch states (noindex, disallow-all, a public sitemap host that is not live yet) go to a
    **launch checklist**.
  - Neither group counts toward the score, `--fail-on`, the priorities or monitor regressions.
  - Noindex pages are checked as indexable pages, so real issues on them still show up.
  - On a local or private target the CLI suggests the flag.
- **Unreachable target ≠ broken site.** When the start URL fails at the network level (DNS, TCP, TLS),
  Searvex writes its reports with no findings and no score, and exits `4`. It no longer reports
  `robots.unreachable` with a misleading score. A target blocked by the network policy (localhost without
  `--allow-private`) is a usage error with a hint.
- **Exit codes:**

  | Code | Meaning |
  |---|---|
  | `0` | completed |
  | `1` | `--fail-on` |
  | `2` | usage error |
  | `3` | runtime error (was `2`) |
  | `4` | target unreachable |
  | `5` | reserved for interrupted runs |

- **New rule `robots.sitemap-unreachable`.** A sitemap declared in robots.txt that cannot be fetched is no
  longer reported as a missing sitemap.
- **Fewer false positives:**
  - Images sized in CSS (inline style, simple `<style>` rules, fixed-size utility classes) are no longer
    reported as missing dimensions.
  - Next.js routes that are noindex through a layout no longer get `canonical.missing`.
  - Personal sites are pointed to Person / ProfilePage markup instead of Organization.
- **Complete `--help`.** Every option is listed, including `--timeout`, and a test keeps it that way.

## Upgrade

```bash
npm install -g searvex-seo@1.2.0
```

Claude Code: `/plugin update searvex@searvex`.

### Breaking changes

- Runtime errors exit with `3` instead of `2`. Scripts that treat `2` as a crash should check `3`. `2` still
  means a usage error.
- A target blocked by the network policy now exits `2` (usage error) instead of `0` with a
  `robots.unreachable` report. Add `--allow-private` for local servers.
- A declared but failing sitemap is now `robots.sitemap-unreachable` instead of `robots.no-sitemap`. The first
  `monitor` run after the upgrade shows this once as one resolved and one new finding.

## Not in this release

Planned items deferred to the next release:

- graceful SIGINT/SIGTERM handling and `--max-duration` with a partial report (exit `5`);
- structured `--progress ndjson`;
- `--allow-host` / `--deny-host` / `--ports` (the upstream proxy still needs a design note first);
- a versioned JSON contract (`schemaVersion`, `schema/report.schema.json`, `searvex schema`).

Details: [CHANGELOG](../CHANGELOG.md) · [CLI reference](cli.md) · [limitations](limitations.md).
