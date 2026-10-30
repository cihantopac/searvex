import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Run storage under `<workspace>/.searvex/runs/<runId>/`.
 * Files are append-only JSONL plus small JSON checkpoints written atomically
 * (write to temp file, then rename) so an interrupted run can always be resumed.
 */
export class RunStore {
  readonly dir: string;

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

  writeText(name: string, text: string): string {
    this.ensure();
    const f = this.file(name);
    fs.writeFileSync(f, text);
    return f;
  }
}
