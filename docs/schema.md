# Output contract and schemas

Searvex output that other programs read is versioned and described by JSON Schemas (draft-07):

| Output | Schema | Printed by |
|---|---|---|
| `report.json` and `--json` of `audit`, `monitor`'s report, repository audits | `schema/report.schema.json` | `searvex schema report` |
| One line of `--progress ndjson` on stderr | `schema/events.schema.json` | `searvex schema events` |
| The JSON error line on stderr (`--json`, `--progress ndjson`) | `schema/error.schema.json` | `searvex schema error` |

The files ship in the npm package (`node_modules/searvex-seo/schema/`). Their `$id` points at the copy on the
`main` branch; validate against the copy of the version you run.

## Versioning

- `report.json` carries `schemaVersion` (currently `"1.1"`); each schema states its version in
  `x-searvex-schema-version`.
- **Minor** (`1.0` → `1.1`): additive changes only, such as a new optional field or a new enum value.
- **Major** (`1.x` → `2.0`): a field is removed or renamed, or its type or meaning changes.
- The schema version is independent of the package version: a package release may leave it unchanged.
- The published schemas do not forbid unknown properties, so a validator for `1.0` accepts a `1.x` report. Read
  `schemaVersion` and reject a major version you do not know.
- Reports written before 1.3.0 have no `schemaVersion` and do not match the schema exactly: `scores.overall` was a
  number where it is now `null`, and the 1.3.0 fields are missing.

## Schema history

| Version | Package | Change |
|---|---|---|
| 1.1 | 1.4.0 | Added `crawl.proxy` (upstream proxy endpoint and resolution mode), `crawl.artefacts` and `findings[].evidence[].artefact` (evidence artefacts), `traffic` (traffic-weighted priorities), `findings[].priority.causedBy` / `.effects` (root causes) |
| 1.0 | 1.3.0 | First published schema |

## How the schemas are made

`scripts/schema.mjs` generates them from the TypeScript types exported by `src/contract.ts` (`AuditReport`,
`ProgressEvent`, `ErrorOutput`) with the TypeScript compiler API. The doc comments become `description`s. `npm
run build` regenerates them, and `node scripts/schema.mjs --check` reports stale files.

`test/integration/schema-contract.test.ts` fails when:
- a type changed without regenerating the schemas;
- any report shape does not validate against a **strict** variant of the schema (no undeclared fields). The
  shapes tested are a full website audit, compact, pre-launch, interrupted, robots-blocked, unreachable,
  repository audits of every fixture framework, CLI `--json`, every progress event and the error objects.

The validator (`ajv`) is a development dependency only; Searvex itself does not validate at run time.

## Stable identifiers

- `findings[].ref` is the rule id (one finding per rule per report).
- `findings[].evidence[].ref` is `<ruleId>#<hash of url|file|line>`: stable across runs for the same occurrence.
  The HTML report, repair prompts and `searvex review` use it.
- `rootCauseGroups[ruleId][].id` is `<ruleId>@<template|file|layout|site>`.
