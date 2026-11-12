import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Byte range of a page text in the run's `texts.txt`. */
export interface TextRef {
  offset: number;
  length: number;
}

/** Keep Searvex artifacts out of the user's git status without touching their .gitignore. */
export function ensureSelfIgnored(root: string): void {
  const f = path.join(root, '.searvex', '.gitignore');
  if (!fs.existsSync(f)) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '# Created by Searvex: run data, reports and change backups stay local.\n*\n');
  }
}

/**
 * Run storage under `<workspace>/.searvex/runs/<runId>/`.
 * Files are append-only JSONL plus small JSON checkpoints written atomically
 * (write to temp file, then rename) so an interrupted run can always be resumed.
 */
export class RunStore {
  readonly dir: string;
  private textBytes: number | undefined;

  constructor(
    readonly root: string,
    readonly runId: string,
  ) {
    this.dir = path.join(root, '.searvex', 'runs', runId);
  }

  static newRunId(prefix = 'run'): string {
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
    return `${prefix}-${ts}-${crypto.randomBytes(3).toString('hex')}`;
  }

  static latest(root: string, prefix?: string): string | null {
    const dir = path.join(root, '.searvex', 'runs');
    if (!fs.existsSync(dir)) return null;
    const runs = fs
      .readdirSync(dir)
      .filter((d) => !prefix || d.startsWith(prefix))
      .filter((d) => fs.existsSync(path.join(dir, d, 'meta.json')))
      .sort();
    return runs.at(-1) ?? null;
  }

  static list(root: string): string[] {
    const dir = path.join(root, '.searvex', 'runs');
    return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  }

  ensure(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    ensureSelfIgnored(this.root);
  }

  file(name: string): string {
    if (name.includes('/') || name.includes('\\') || name.includes('..')) throw new Error(`Invalid store file name: ${name}`);
    return path.join(this.dir, name);
  }

  writeJson(name: string, data: unknown): void {
    this.ensure();
    const target = this.file(name);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, target);
  }

  readJson<T>(name: string): T | null {
    const f = this.file(name);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8')) as T;
  }

  append(name: string, record: unknown): void {
    this.ensure();
    fs.appendFileSync(this.file(name), JSON.stringify(record) + '\n');
  }

  readLines<T>(name: string): T[] {
    const f = this.file(name);
    if (!fs.existsSync(f)) return [];
    const out: T[] = [];
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        // A crash can leave a half-written last line; skip it.
      }
    }
    return out;
  }

  /**
   * Write an evidence artefact (`--save-html`, `--screenshots`) under `artefacts/<kind>/` with owner-only
   * permissions (0700 directory, 0600 file): bodies are stored as served and may contain personal data.
   * Returns the path relative to the run directory.
   */
  writeArtefact(kind: 'html' | 'screenshots', name: string, data: string | Buffer): string {
    if (!/^[\w.-]+$/.test(name) || name.includes('..')) throw new Error(`Invalid artefact name: ${name}`);
    this.ensure();
    const dir = path.join(this.dir, 'artefacts', kind);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(path.join(this.dir, 'artefacts'), 0o700);
    fs.writeFileSync(path.join(dir, name), data, { mode: 0o600 });
    return `artefacts/${kind}/${name}`;
  }

  /**
   * Append a page's main text to `texts.txt` and return its byte range. Page records keep only this reference,
   * so large crawls do not hold every page's text in memory; analysis reads it back with `readText`.
   */
  appendText(text: string): TextRef {
    this.ensure();
    const f = this.file('texts.txt');
    this.textBytes ??= fs.existsSync(f) ? fs.statSync(f).size : 0;
    const buf = Buffer.from(text, 'utf8');
    fs.appendFileSync(f, buf);
    const ref = { offset: this.textBytes, length: buf.length };
    this.textBytes += buf.length;
    return ref;
  }

  /** Read a text written by `appendText`. The file is opened per read: no descriptor stays open. */
  readText(ref: TextRef): string {
    const fd = fs.openSync(this.file('texts.txt'), 'r');
    try {
      const buf = Buffer.alloc(ref.length);
      fs.readSync(fd, buf, 0, ref.length, ref.offset);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  }

  writeText(name: string, text: string): string {
    this.ensure();
    const f = this.file(name);
    fs.writeFileSync(f, text);
    return f;
  }
}
