/**
 * The machine contract of Searvex output. `scripts/schema.mjs` generates the published JSON Schemas in
 * `schema/` from the types exported here; `test/unit/schema.test.ts` fails when they drift.
 *
 * Versioning (docs/schema.md): an additive change (new optional field, new enum value) raises the minor schema
 * version, a breaking change (removed or renamed field, changed type or meaning) the major. The schema version is
 * independent of the package version.
 */
import type { ErrorKind } from './cli.js';

/** Version of the report, event and error schemas (`report.json` → `schemaVersion`). */
export const SCHEMA_VERSION = '1.0' as const;

/** The JSON error object written on stderr with --json or --progress ndjson. */
export interface ErrorOutput {
  error: {
    /** Process exit code: 2 usage/policy, 3 runtime, 4 not analysable, 5 interrupted. */
    code: number;
    kind: ErrorKind;
    message: string;
  };
}

export type { AuditReport } from './analyze/audit.js';
export type { ProgressEvent } from './progress.js';
