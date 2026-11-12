# Searvex 1.5.0 — release notes

**Understand Search. Fix What Matters.** Searvex now works inside other tools: AI clients over MCP, GitHub code
scanning through an Action, and community rule packs that extend the rule base without code. 92 sourced core
rules; the report schema is 1.2 (additive).

## Highlights

- **Community rule packs.**
  - `--rules-pack <name|dir>` adds rule files from `knowledge/packs/<name>/` or any folder (repeatable).
  - Pack rules use a declarative page check: a field (title, description, H1, lang, canonical, JSON-LD types,
    `og:`/`twitter:` properties, a response header), a test (missing, present, matches, not-matches,
    longer-than, shorter-than) and an optional URL pattern.
  - They meet the same sourcing rules as core rules (official sources with check dates), carry their pack name
    in every id and can never replace a core rule. Risky regular expressions are refused.
  - Pack findings are labelled in every report (`findings[].pack`, `tool.packs`). Format:
    [knowledge/packs/README.md](../knowledge/packs/README.md); guide in [CONTRIBUTING.md](../CONTRIBUTING.md).
- **MCP server for AI clients.**
  - `searvex mcp` serves the tools `audit`, `geo`, `report`, `findings`, `prompt` and `rules` on stdio, read-only.
  - It speaks the initialize handshake (protocol 2025-03-26 to 2025-11-25) and the stateless 2026-07-28 protocol.
  - The network policy is fixed by the server's flags; a tool call cannot reach private addresses unless the
    server was started with `--allow-private`. Audits run one at a time, capped by `--max-pages`.
  - Claude Code: `claude mcp add searvex -- searvex mcp`.
- **GitHub Action.**
  - `uses: cihantopac/searvex@v1.5.0` audits a website or the checked-out repository, uploads SARIF to code
    scanning, writes a job summary (score and top issues) and fails the job at `fail-on`.
  - The example workflow is in the [README](../README.md#quick-start).

## Upgrade

```bash
npm install -g searvex-seo@1.5.0
```

Claude Code: `/plugin update searvex@searvex`.

### Changes to watch

- `report.json` is schema **1.2**: new optional fields `findings[].pack` and `tool.packs`. Consumers of 1.0 and
  1.1 keep working.
- Without `--rules-pack`, audits and reports are unchanged.

## Not in this release

- **Plugin icon and directory submission** wait for the final brand mark.
- **GitHub Marketplace listing** of the action is a manual step on GitHub.
- **fast-xml-parser 5.12.0** (low-severity advisory) follows in a patch release once it is two weeks old.
- Still waiting for owner data: Bing live verification, the Bing AI Performance import, and live runs of
  PageSpeed Insights, GA4 and Yandex (experimental).

Details: [CHANGELOG](../CHANGELOG.md) · [CLI reference](cli.md) · [schemas](schema.md) ·
[limitations](limitations.md).
