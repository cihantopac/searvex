import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { RunStore } from '../crawl/store.js';
import { unifiedDiff } from '../optimize/diff.js';
import { planFixes, type FixPlan } from '../optimize/fixes.js';
import { applyFixes, listChanges, rollback, writeManifest, ConflictError } from '../optimize/transaction.js';
import { auditRepository } from '../repo/audit.js';
import { loadKnowledge } from '../rules/engine.js';
import { UsageError, type GlobalFlags } from '../cli.js';

function gitDirty(root: string): boolean | null {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().length > 0;
  } catch {
    return null;
  }
}

export function renderPlan(plan: FixPlan): string {
  const L: string[] = [];
  L.push(`Automatic fixes (${plan.fixes.length}):`);
  for (const f of plan.fixes) L.push(`  ${f.id}  [${f.ruleId}] ${f.title} — ${f.changes.map((c) => `${c.action} ${c.path}`).join(', ')}\n        ${f.rationale}`);
  if (plan.tasks.length) {
    L.push(`\nTasks needing judgement (${plan.tasks.length}) — draft with your agent, review, then re-run audit:`);
    for (const t of plan.tasks) {
      L.push(`  [${t.ruleId}] ${t.title}: ${t.instruction}`);
      for (const l of t.locations.slice(0, 5)) L.push(`      - ${l.file ?? l.url ?? ''}${l.line ? ':' + l.line : ''}${l.observed ? ' — ' + l.observed : ''}`);
      if (t.locations.length > 5) L.push(`      … ${t.locations.length - 5} more`);
    }
  }
  if (plan.skipped.length) {
    L.push(`\nSkipped (${plan.skipped.length}):`);
    for (const s of plan.skipped) L.push(`  [${s.ruleId}] ${s.reason}`);
  }
  return L.join('\n');
}

export async function commandOptimize(flags: GlobalFlags): Promise<number> {
  const v = flags.values;
  const target = flags.positionals[1];
  if (!target || !fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new UsageError('optimize requires a repository directory');
  const root = fs.realpathSync(target);
  const siteUrl = v['site-url'] as string | undefined;
  if (siteUrl && !/^https?:\/\//.test(siteUrl)) throw new UsageError('--site-url must be an absolute http(s) URL');
  const lang = v['lang'] as string | undefined;
  if (lang && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang)) throw new UsageError('--lang must be a BCP 47 language tag, e.g. en or pt-BR');
  const kb = loadKnowledge();
  const before = auditRepository(root, { siteUrl, kb });
  const plan = planFixes(before.report, before.scan, { siteUrl, lang, only: v['only'] as string[] | undefined });
  const store = new RunStore(root, RunStore.newRunId('optimize'));
  store.writeJson('meta.json', { kind: 'optimize', target: root, startedAt: new Date().toISOString() });
  const patch = plan.fixes.flatMap((f) => f.changes.map((c) => unifiedDiff(c.path, c.before, c.after))).join('\n');
  store.writeJson('plan.json', { ...plan, fixes: plan.fixes.map((f) => ({ ...f, changes: f.changes.map((c) => ({ path: c.path, action: c.action })) })) });
  store.writeText('plan.patch', patch + '\n');

  if (v['json'] && !v['apply']) {
    process.stdout.write(JSON.stringify({ framework: before.scan.detection.framework, plan: { ...plan, fixes: plan.fixes.map((f) => ({ ...f, diff: f.changes.map((c) => unifiedDiff(c.path, c.before, c.after)).join('\n'), changes: f.changes.map((c) => ({ path: c.path, action: c.action })) })) } }, null, 2) + '\n');
    return 0;
  }
  console.log(`Repository: ${root} (${before.scan.detection.framework})\n`);
  console.log(renderPlan(plan));
  if (!plan.fixes.length) return 0;
  if (!v['apply']) {
    console.log(`\nDry run — no files changed. Preview diff: ${store.file('plan.patch')}`);
    console.log('Apply with: searvex optimize <path> --apply [same options]');
    return 0;
  }
  if (gitDirty(root)) console.log('\nNote: the git working tree has uncommitted changes; Searvex keeps its own backups, but committing first is recommended.');
  if (!v['yes']) {
    if (!process.stdin.isTTY) throw new UsageError('Refusing to apply without confirmation in a non-interactive shell; pass --yes after reviewing the dry run.');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`\nApply ${plan.fixes.length} fix(es) to ${new Set(plan.fixes.flatMap((f) => f.changes.map((c) => c.path))).size} file(s)? [y/N] `);
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) return (console.log('Aborted.'), 0);
  }
  let manifest;
  try {
    manifest = applyFixes(root, plan.fixes);
  } catch (e) {
    if (e instanceof ConflictError) throw new UsageError(`${e.message}. Re-run the dry run.`);
    throw e;
  }
  console.log(`\nApplied change ${manifest.changeId} (${manifest.files.length} file(s)). Verifying…`);

  // Verify: targeted findings must decrease and no new issue types may appear.
  const after = auditRepository(root, { siteUrl, kb });
  const count = (r: typeof before.report, id: string) => r.findings.find((f) => f.ruleId === id)?.count ?? 0;
  const targeted = [...new Set(plan.fixes.map((f) => f.ruleId))];
  const results = targeted.map((id) => ({ ruleId: id, before: count(before.report, id), after: count(after.report, id) }));
  const beforeIds = new Set(before.report.findings.filter((f) => f.severity !== 'info').map((f) => f.ruleId));
  const introduced = after.report.findings.filter((f) => f.severity !== 'info' && !beforeIds.has(f.ruleId)).map((f) => f.ruleId);
  const notImproved = results.filter((r) => r.after >= r.before);
  manifest.verification = { results, introduced, scoreBefore: before.report.scores.overall, scoreAfter: after.report.scores.overall };
  for (const r of results) console.log(`  ${r.after < r.before ? '✓' : '✗'} ${r.ruleId}: ${r.before} → ${r.after}`);
  if (introduced.length || notImproved.length) {
    manifest.status = 'verification-failed';
    writeManifest(root, manifest);
    const rb = rollback(root, manifest.changeId, { force: true });
    console.log(`\nVerification failed (${introduced.length ? 'new issues: ' + introduced.join(', ') : 'no improvement for ' + notImproved.map((r) => r.ruleId).join(', ')}). Rolled back ${rb.restored.length} file(s).`);
    return 1;
  }
  manifest.status = 'verified';
  writeManifest(root, manifest);
  console.log(`\nVerified. Health score ${before.report.scores.overall} → ${after.report.scores.overall}.`);
  console.log(`Undo with: searvex rollback ${manifest.changeId} ${target}`);
  return 0;
}

export async function commandRollback(flags: GlobalFlags): Promise<number> {
  const id = flags.positionals[1];
  const root = fs.realpathSync(path.resolve(flags.positionals[2] ?? process.cwd()));
  if (!id) throw new UsageError('rollback requires a change id (or "list")');
  if (id === 'list') {
    for (const m of listChanges(root)) console.log(`${m.changeId}  ${m.status.padEnd(20)} ${m.files.length} file(s)  ${m.fixes.map((f) => f.ruleId).join(', ')}`);
    return 0;
  }
  const res = rollback(root, id, { force: !!flags.values['yes'] });
  if (res.conflicts.length && !res.restored.length) {
    console.error(`Files were modified after change ${id}: ${res.conflicts.join(', ')}\nRe-run with --yes to overwrite those edits with the original content.`);
    return 1;
  }
  console.log(`Rolled back ${id}: restored ${res.restored.length} file(s).`);
  return 0;
}
