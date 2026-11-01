import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AuditReport } from '../analyze/audit.js';
import { RunStore } from '../crawl/store.js';
import { loadKnowledge } from '../rules/engine.js';
import { findingRef } from '../report/remediation.js';
import type { FindingReview } from '../report/html.js';
import { UsageError, writeReports, type GlobalFlags } from '../cli.js';

/** `latest` → newest run with a report.json; otherwise the run id must exist. */
export function resolveRun(workspace: string, id: string | undefined): string {
  const ref = id ?? 'latest';
  const withReport = RunStore.list(workspace).filter((r) => fs.existsSync(path.join(workspace, '.searvex', 'runs', r, 'report.json')));
  const runId = ref === 'latest' ? withReport.at(-1) : withReport.find((r) => r === ref);
  if (!runId) throw new UsageError(ref === 'latest' ? 'No stored audit reports found (run "searvex audit" first)' : `No audit report for run ${ref}`);
  return runId;
}

/** Open a local file with the platform's default handler (no shell; arguments passed as an array). */
export function openFile(file: string): boolean {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [file]] : process.platform === 'win32' ? ['explorer.exe', [file]] : ['xdg-open', [file]];
  try {
    const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function commandOpen(flags: GlobalFlags): number {
  const workspace = path.resolve(String(flags.values['out'] ?? process.cwd()));
  const runId = resolveRun(workspace, flags.positionals[1]);
  const file = new RunStore(workspace, runId).file('report.html');
  if (!fs.existsSync(file)) throw new UsageError(`Run ${runId} has no report.html (searvex report ${runId} --format html)`);
  openFile(file);
  console.log(file);
  return 0;
}

const STATUSES = ['confirmed', 'rejected', 'fixed'] as const;

/**
 * Record a review of a finding after an agent (or person) re-checked it against the source. Reviews are stored in
 * `reviews.json` next to the audit and shown separately in the report: scanner evidence is never replaced.
 */
export function commandReview(flags: GlobalFlags): number {
  const v = flags.values;
  const [, runRef, target, status] = flags.positionals;
  if (!target || !status) throw new UsageError('Usage: searvex review <runId|latest> <ref|ruleId> <confirmed|rejected|fixed> [--note text]');
  if (!(STATUSES as readonly string[]).includes(status)) throw new UsageError(`Status must be one of ${STATUSES.join(', ')}`);
  const workspace = path.resolve(String(v['out'] ?? process.cwd()));
  const store = new RunStore(workspace, resolveRun(workspace, runRef));
  const report = store.readJson<AuditReport>('report.json')!;
  const [ruleId, hash] = target.split('#');
  const finding = report.findings.find((f) => f.ruleId === ruleId);
  if (!finding) throw new UsageError(`No finding for rule ${ruleId} in run ${store.runId}`);
  if (hash && !finding.evidence.some((e) => findingRef(finding.ruleId, e) === target)) throw new UsageError(`Unknown reference ${target} (copy it from the report or the repair prompt)`);
  const note = typeof v['note'] === 'string' ? v['note'].replace(/[\r\n]+/g, ' ').slice(0, 500) : undefined;
  const review: FindingReview = { ruleId: finding.ruleId, ...(hash ? { ref: target } : {}), status: status as FindingReview['status'], ...(note ? { note } : {}), at: new Date().toISOString() };
  const reviews = [...(store.readJson<FindingReview[]>('reviews.json') ?? []), review];
  store.writeJson('reviews.json', reviews);
  const files = writeReports(store, report, loadKnowledge(), ['html']);
  if (v['json']) process.stdout.write(JSON.stringify(review, null, 2) + '\n');
  else if (!v['quiet']) console.log(`Recorded: ${target} → ${status}. Report updated: ${files[0]}`);
  return 0;
}
