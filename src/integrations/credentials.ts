import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Local credential storage. The engine only depends on `CredentialStore`, so an OS keychain backend or a
 * future hosted token service can replace the file backend without touching the integrations.
 *
 * File backend: `<config dir>/credentials.json`, directory 0700 and file 0600 on POSIX systems. Windows does
 * not apply POSIX modes; the file then relies on the per-user profile ACL (documented in docs/security.md).
 */
export interface StoredCredential {
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  scope: string;
  createdAt: string;
}

export interface CredentialStore {
  get(name: string): StoredCredential | null;
  set(name: string, cred: StoredCredential): void;
  delete(name: string): boolean;
  /** Where credentials live, for user-facing messages (never includes secrets). */
  describe(): string;
}

export function configDir(): string {
  if (process.env['SEARVEX_CONFIG_DIR']) return process.env['SEARVEX_CONFIG_DIR'];
  if (process.platform === 'win32') return path.join(process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'searvex');
  return path.join(process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config'), 'searvex');
}

export class FileCredentialStore implements CredentialStore {
  constructor(private readonly dir = configDir()) {}

  get file(): string {
    return path.join(this.dir, 'credentials.json');
  }

  readAll(): Record<string, StoredCredential> {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, StoredCredential>;
    } catch {
      return {};
    }
  }

  get(name: string): StoredCredential | null {
    return this.readAll()[name] ?? null;
  }

  set(name: string, cred: StoredCredential): void {
    this.write({ ...this.readAll(), [name]: cred });
  }

  delete(name: string): boolean {
    const all = this.readAll();
    if (!all[name]) return false;
    delete all[name];
    this.write(all);
    return true;
  }

  describe(): string {
    return process.platform === 'win32' ? `${this.file} (user profile; Windows does not apply POSIX file modes)` : `${this.file} (permissions 0600)`;
  }

  private write(all: Record<string, StoredCredential>): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // Write to a temporary file first so an interrupted write never leaves a truncated credentials file.
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
  }
}

export const defaultCredentialStore = (): CredentialStore => new FileCredentialStore();
