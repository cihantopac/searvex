# Searvex 1.3.0 — release notes

**Understand Search. Fix What Matters.** In this release a run reports honestly what it did, and its output is a
versioned contract that pipelines and coding agents can rely on. 91 sourced rules (no new rule; six sources
re-verified).

## Highlights

- **Nothing fetched means no score.**
  - When robots.txt blocks every URL, no page is analysed. This happens when robots.txt answers 5xx/429 (RFC 9309:
    assume complete disallow) or disallows every URL.
  - Such a run is now `crawl.status: "robots-blocked"`, exits `4`, has no score and keeps the one finding you have
    to fix (`robots.unreachable` or `robots.disallow-all`).
  - With `--pre-launch`, a staging build that blocks all crawlers puts that finding in the launch checklist.
  - In every "nothing to audit" case `scores.overall` is now `null` instead of `100`.
- **Counters mean what they say.**
  - `crawl.fetched` counts the requests actually made; `crawl.crawled` keeps meaning "URLs processed".
  - The summary and reports show *pages fetched* and *blocked by robots.txt*.
  - `inventory.unfetched` lists every other URL the crawl touched, with its reason.
- **Stop a run and still get a report.**
  - The first SIGINT/SIGTERM, or the new `--max-duration <s>`, stops the crawl and lets pages in flight finish.
  - Every requested format is then written as a partial report (`crawl.interrupted`), and the run exits `5`.
  - A second signal exits at once.
  - Checkpoints are written every 25 pages or 10 seconds, so `--resume` works after an early kill.
- **Complete JSON.** `report.json` now carries what only the HTML report used to compute:
  - finding references and remediation class (`auto`, `agent`, `manual`);
  - stable evidence refs;
  - root-cause groups;
  - **every affected URL per finding** (`affected.count` / `urls`, complete up to 10,000). `--compact` keeps
    only the counts.
- **A versioned contract.**
  - `report.json` has `schemaVersion: "1.0"`.
  - JSON Schemas for the report, the progress events and the error object are generated from the TypeScript
    types, ship in the package (`schema/`) and are printed by `searvex schema`.
  - The policy is in [schema.md](schema.md).
  - `tool.rules` records the rule-file version of every rule that fired.
- **For pipelines.**
  - `--progress ndjson` writes one JSON event per line on stderr: start, phase, page, finding summary, end.
  - With `--json`, errors are also written as a JSON object on stderr.
  - A runtime error is one line; set `SEARVEX_DEBUG=1` for the stack trace.
- **Repair prompts outside the browser.** `searvex prompt latest [--rules a,b] [--lang tr] [--format json]` prints
  the prompt the HTML action center builds. The package now exports the prompt and remediation helpers.
- **Host and port limits.**
  - `--allow-host`, `--deny-host` and `--ports` are enforced on every request, redirect hop, connection-time
    DNS lookup, `--render` browser request and `--check-external` link.
  - A denied target exits `2`; other denied URLs are skipped and never reported as broken.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | completed |
| `1` | `--fail-on` |
| `2` | usage error, or a target blocked by the network policy (still writes `report.json`) |
| `3` | runtime error |
| `4` | target not analysable: unreachable, or robots.txt blocks every URL |
| `5` | interrupted: partial report written |

## Upgrade

```bash
npm install -g searvex-seo@1.3.0
```

Claude Code: `/plugin update searvex@searvex`.

### Breaking changes

- `scores.overall` can be `null`. It is `null` when `scores.notApplicable` is set: an unreachable target, a
  robots-blocked target, or a repository without a website. Code that reads `overall` as a number must handle
  `null`. This also applies to `monitor`'s `scoreAfter` and to `ecosystem`'s per-site `score`.
- A site whose robots.txt answers 5xx/429 or disallows every URL used to exit `0` with a score. It now exits `4`
  with `crawl.status: "robots-blocked"`.
- `--check-external` no longer counts links the network policy forbids (for example private addresses) as broken.
- Findings that stand for a group of pages count every page as affected:
  - affected rules: `duplicate.title`, `duplicate.description`, `duplicate.content` and
    `content.cannibalization`;
  - `affectedUrls` and their priority can therefore rise for the same site;
  - the first `monitor` run after the upgrade compares counts made the old way and the new way.

## Not in this release

- **Upstream (corporate) proxy.** The design is in [design/proxy.md](design/proxy.md) and waits for approval
  before it is implemented.
- **Evidence artefacts** (`--save-html`, `--screenshots`): planned for 1.4.0.
- **Windows:** Ctrl+C and `--max-duration` stop a run gracefully. A termination sent by another process cannot
  be caught on Windows, so it ends the run without a report.

Details: [CHANGELOG](../CHANGELOG.md) · [CLI reference](cli.md) · [schemas](schema.md) ·
[limitations](limitations.md).
