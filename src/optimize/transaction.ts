import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveInside, isSecretPath } from '../repo/fs-safe.js';
import type { Fix } from './fixes.js';
import { ensureSelfIgnored } from '../crawl/store.js';

/**
 * Transactional file changes with backups, integrity hashes and rollback.
 * Layout: <root>/.searvex/changes/<changeId>/{manifest.json, backup/<n>}
 */
export interface ManifestEntry {
  path: string;
  action: 'modify' | 'create';
  beforeHash: string | null;
  afterHash: string;
  backup: string | null;
}

export interface Manifest {
  changeId: string;
  createdAt: string;
  root: string;
  fixes: Array<{ id: string; ruleId: string; title: string }>;
  files: ManifestEntry[];
  /**
   * `applying` is written before the first file changes (a journal): if the process dies mid-way, the manifest
   * and backups already exist and `rollback` restores whatever was written.
   */
  status: 'applying' | 'applied' | 'rolled-back' | 'verified' | 'verification-failed';
  verification?: unknown;
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function changesDir(root: string): string {
  return path.join(root, '.searvex', 'changes');
}

/** Write via a temporary file and rename; keeps the existing file's permission bits. */
function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o7777 : undefined;
  const tmp = `${file}.searvex-${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, content, mode === undefined ? undefined : { mode });
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

const hashOf = (abs: string): string | null => (fs.existsSync(abs) ? sha(fs.readFileSync(abs, 'utf8')) : null);

/** Changes whose apply was interrupted (manifest still `applying`); they must be rolled back first. */
export function interruptedChanges(root: string): Manifest[] {
  return listChanges(root).filter((m) => m.status === 'applying');
}

export class ConflictError extends Error {}

export function applyFixes(root: string, fixes: Fix[]): Manifest {
  const changeId = `chg-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const dir = path.join(changesDir(root), changeId);
  // Merge multiple fixes touching the same file: the last staged content wins (planner chains edits).
  const finalByPath = new Map<string, { before: string | null; after: string; action: 'modify' | 'create' }>();
  for (const f of fixes) for (const c of f.changes) {
    const prev = finalByPath.get(c.path);
    finalByPath.set(c.path, { before: prev ? prev.before : c.before, after: c.after, action: prev?.action ?? c.action });
  }
  // Pre-flight: validate every path and make sure files did not change since planning.
  for (const [p, c] of finalByPath) {
    if (isSecretPath(p)) throw new ConflictError(`Refusing to modify secret-bearing file: ${p}`);
    const abs = resolveInside(root, p);
    const exists = fs.existsSync(abs);
    if (exists && fs.lstatSync(abs).isSymbolicLink()) throw new ConflictError(`Refusing to modify symlink: ${p}`);
    if (c.action === 'create' && exists) throw new ConflictError(`File appeared since planning: ${p}`);
    if (c.action === 'modify' && (!exists || fs.readFileSync(abs, 'utf8') !== c.before)) throw new ConflictError(`File changed since planning: ${p}`);
  }
  fs.mkdirSync(path.join(dir, 'backup'), { recursive: true });
  ensureSelfIgnored(root);
  const manifest: Manifest = { changeId, createdAt: new Date().toISOString(), root, fixes: fixes.map((f) => ({ id: f.id, ruleId: f.ruleId, title: f.title })), files: [], status: 'applying' };
  // Journal first: every backup and the full manifest exist before the first project file is touched.
  let n = 0;
  for (const [p, c] of finalByPath) {
    let backup: string | null = null;
    if (c.action === 'modify') {
      backup = `backup/${n++}`;
      fs.writeFileSync(path.join(dir, backup), c.before ?? '');
    }
    manifest.files.push({ path: p, action: c.action, beforeHash: c.before === null ? null : sha(c.before), afterHash: sha(c.after), backup });
  }
  writeManifest(root, manifest);
  const written: ManifestEntry[] = [];
  try {
    for (const e of manifest.files) {
      atomicWrite(resolveInside(root, e.path), finalByPath.get(e.path)!.after);
      written.push(e);
    }
  } catch (e) {
    // Partial failure: undo what was written. The journal stays if undoing fails too.
    try {
      for (const w of written.reverse()) restoreEntry(root, dir, w);
    } catch (undo) {
      throw new Error(`Applying ${changeId} failed (${(e as Error).message}) and undoing it failed (${(undo as Error).message}); run "searvex rollback ${changeId}" to restore the files.`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  manifest.status = 'applied';
  writeManifest(root, manifest);
  return manifest;
}

function restoreEntry(root: string, dir: string, e: ManifestEntry): void {
  const abs = resolveInside(root, e.path);
  if (e.action === 'create') fs.rmSync(abs, { force: true });
  else if (e.backup) atomicWrite(abs, fs.readFileSync(path.join(dir, e.backup), 'utf8'));
}

export function readManifest(root: string, changeId: string): Manifest {
  if (!/^chg-[\w-]+$/.test(changeId)) throw new Error(`Invalid change id: ${changeId}`);
  const f = path.join(changesDir(root), changeId, 'manifest.json');
  if (!fs.existsSync(f)) throw new Error(`Unknown change: ${changeId}`);
  return JSON.parse(fs.readFileSync(f, 'utf8')) as Manifest;
}

export function writeManifest(root: string, m: Manifest): void {
  fs.writeFileSync(path.join(changesDir(root), m.changeId, 'manifest.json'), JSON.stringify(m, null, 2));
}

/** Roll back a change. Refuses when a file was edited after the change (unless force). */
export function rollback(root: string, changeId: string, opts: { force?: boolean } = {}): { restored: string[]; conflicts: string[] } {
  const m = readManifest(root, changeId);
  if (m.status === 'rolled-back') throw new Error(`Change ${changeId} was already rolled back`);
  const dir = path.join(changesDir(root), changeId);
  const conflicts: string[] = [];
  const pending: ManifestEntry[] = [];
  for (const e of m.files) {
    const current = hashOf(resolveInside(root, e.path));
    // Already in the original state (an interrupted apply never reached it): nothing to restore.
    if (current === e.beforeHash) continue;
    pending.push(e);
    if (current !== e.afterHash) conflicts.push(e.path);
  }
  if (conflicts.length && !opts.force) return { restored: [], conflicts };
  const restored: string[] = [];
  for (const e of pending.reverse()) {
    restoreEntry(root, dir, e);
    restored.push(e.path);
  }
  m.status = 'rolled-back';
  writeManifest(root, m);
  return { restored, conflicts };
}

export function listChanges(root: string): Manifest[] {
  const d = changesDir(root);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((x) => fs.existsSync(path.join(d, x, 'manifest.json'))).sort().map((x) => readManifest(root, x));
}
