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
  status: 'applied' | 'rolled-back' | 'verified' | 'verification-failed';
  verification?: unknown;
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function changesDir(root: string): string {
  return path.join(root, '.searvex', 'changes');
}

function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.searvex-${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
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
  const manifest: Manifest = { changeId, createdAt: new Date().toISOString(), root, fixes: fixes.map((f) => ({ id: f.id, ruleId: f.ruleId, title: f.title })), files: [], status: 'applied' };
  let n = 0;
  const written: ManifestEntry[] = [];
  try {
    for (const [p, c] of finalByPath) {
      const abs = resolveInside(root, p);
      let backup: string | null = null;
      if (c.action === 'modify') {
        backup = `backup/${n++}`;
        fs.writeFileSync(path.join(dir, backup), c.before ?? '');
      }
      atomicWrite(abs, c.after);
      const entry = { path: p, action: c.action, beforeHash: c.before === null ? null : sha(c.before), afterHash: sha(c.after), backup };
      written.push(entry);
      manifest.files.push(entry);
    }
  } catch (e) {
    // Partial failure: undo what was written.
    for (const w of written.reverse()) restoreEntry(root, dir, w);
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
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
  for (const e of m.files) {
    const abs = resolveInside(root, e.path);
    const current = fs.existsSync(abs) ? sha(fs.readFileSync(abs, 'utf8')) : null;
    if (current !== e.afterHash) conflicts.push(e.path);
  }
  if (conflicts.length && !opts.force) return { restored: [], conflicts };
  const restored: string[] = [];
  for (const e of [...m.files].reverse()) {
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
