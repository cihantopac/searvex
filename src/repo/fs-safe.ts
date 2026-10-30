import fs from 'node:fs';
import path from 'node:path';

/**
 * Safe repository file access.
 * - Every path is resolved and must stay inside the root (no traversal via "..", absolute paths or symlinks).
 * - Symlinks are never followed during walking.
 * - Secret-bearing files are never read, so their contents can never reach reports or an LLM.
 */

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'vendor', '.next', '.nuxt', '.output', '.svelte-kit', '.astro', '.vercel', '.netlify',
  '.turbo', '.cache', 'coverage', '.searvex', '__pycache__', '.venv', 'venv', 'target', 'storage', 'bootstrap/cache', '.idea', '.vscode',
]);

const SECRET_PATTERNS = [
  /(^|[\\/])\.env(\..*)?$/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i, /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|[\\/])\.npmrc$/i, /(^|[\\/])\.pypirc$/i, /(^|[\\/])\.netrc$/i, /(^|[\\/])credentials(\.json)?$/i, /secrets?\.(json|ya?ml|toml)$/i,
  /(^|[\\/])wp-config\.php$/i, /(^|[\\/])\.htpasswd$/i, /service-account.*\.json$/i, /(^|[\\/])auth\.json$/i,
];

export function isSecretPath(p: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(p));
}

export class PathEscapeError extends Error {}

/** Resolve `rel` inside `root`, rejecting anything that escapes it (including through symlinks). */
export function resolveInside(root: string, rel: string): string {
  const realRoot = fs.realpathSync(root);
  const abs = path.resolve(realRoot, rel);
  const relative = path.relative(realRoot, abs);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new PathEscapeError(`Path escapes repository root: ${rel}`);
  // Check the deepest existing ancestor's real path (handles symlinked directories).
  let probe = abs;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const realProbe = fs.realpathSync(probe);
  const r2 = path.relative(realRoot, realProbe);
  if (r2.startsWith('..') || path.isAbsolute(r2)) throw new PathEscapeError(`Path resolves outside repository root via symlink: ${rel}`);
  return abs;
}

export interface WalkOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  include?: (rel: string) => boolean;
}

export interface WalkedFile {
  rel: string;
  abs: string;
  size: number;
}

export function walk(root: string, opts: WalkOptions = {}): { files: WalkedFile[]; skipped: { symlinks: number; secrets: number; large: number; truncated: boolean } } {
  const maxFiles = opts.maxFiles ?? 50000;
  const maxBytes = opts.maxFileBytes ?? 2 * 1024 * 1024;
  const realRoot = fs.realpathSync(root);
  const files: WalkedFile[] = [];
  const skipped = { symlinks: 0, secrets: 0, large: 0, truncated: false };
  const stack = [''];
  while (stack.length) {
    const relDir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(realRoot, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isSymbolicLink()) {
        skipped.symlinks++;
        continue;
      }
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || SKIP_DIRS.has(rel)) continue;
        if (e.name.startsWith('.') && e.name !== '.well-known' && e.name !== '.vitepress') continue;
        stack.push(rel);
        continue;
      }
      if (!e.isFile()) continue;
      if (isSecretPath(rel)) {
        skipped.secrets++;
        continue;
      }
      if (opts.include && !opts.include(rel)) continue;
      const abs = path.join(realRoot, rel);
      const size = fs.statSync(abs).size;
      if (size > maxBytes) {
        skipped.large++;
        continue;
      }
      files.push({ rel, abs, size });
      if (files.length >= maxFiles) {
        skipped.truncated = true;
        return { files, skipped };
      }
    }
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return { files, skipped };
}

export function readText(root: string, rel: string): string {
  if (isSecretPath(rel)) throw new Error(`Refusing to read secret-bearing file: ${rel}`);
  const abs = resolveInside(root, rel);
  const st = fs.lstatSync(abs);
  if (st.isSymbolicLink()) throw new PathEscapeError(`Refusing to read symlink: ${rel}`);
  return fs.readFileSync(abs, 'utf8');
}

export function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}
