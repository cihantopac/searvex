import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Local credential storage. The engine only depends on `CredentialStore`, so an OS keychain backend or a
 * future hosted token service can replace the file backend without touching the integrations.
 *
 * Backends (`SEARVEX_CREDENTIAL_STORE`):
 * - `file` (default): `<config dir>/credentials.json`, directory 0700 and file 0600 on POSIX systems. Windows
 *   does not apply POSIX modes; the file then relies on the per-user profile ACL (docs/security.md).
 * - `keychain`: the operating system's store, through tools that ship with it (no native dependencies):
 *   macOS Keychain (`security`), the Secret Service on Linux (`secret-tool`, libsecret), and on Windows
 *   DPAPI encryption bound to the user account (`powershell.exe`), stored as ciphertext in the config dir.
 *   Secrets are passed on stdin, never as command-line arguments (which other processes can read).
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

export class CredentialStoreError extends Error {}

export interface ToolResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
/** Runs an OS tool; replaceable in tests. `input` goes to stdin. */
export type ToolRunner = (cmd: string, args: string[], input?: string) => ToolResult;

export const runTool: ToolRunner = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  if (r.error) return { status: null, stdout: '', stderr: (r.error as NodeJS.ErrnoException).code ?? r.error.message };
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

export type KeychainKind = 'macos' | 'secret-service' | 'windows-dpapi';

export function keychainKind(platform: NodeJS.Platform = process.platform): KeychainKind | null {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows-dpapi';
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') return 'secret-service';
  return null;
}

const SERVICE = 'searvex';
const PS_PROTECT =
  "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$s=[Console]::In.ReadToEnd();[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($s),$null,'CurrentUser'))";
const PS_UNPROTECT =
  "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$s=[Console]::In.ReadToEnd().Trim();[Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($s),$null,'CurrentUser')))";

/**
 * OS keychain store. Credentials saved earlier by the file backend stay readable (and are removed from the
 * file when the credential is saved again or deleted), so switching backends needs no manual migration.
 */
export class KeychainCredentialStore implements CredentialStore {
  private readonly legacy: FileCredentialStore;

  constructor(
    readonly kind: KeychainKind,
    private readonly run: ToolRunner = runTool,
    private readonly dir = configDir(),
  ) {
    this.legacy = new FileCredentialStore(dir);
  }

  get(name: string): StoredCredential | null {
    const raw = this.read(checkName(name));
    if (raw === null) return this.legacy.get(name);
    try {
      return JSON.parse(raw) as StoredCredential;
    } catch {
      throw new CredentialStoreError(`The ${this.label()} entry "${SERVICE}/${name}" is not a Searvex credential; remove it and authorize again.`);
    }
  }

  set(name: string, cred: StoredCredential): void {
    const json = JSON.stringify(cred);
    this.write(checkName(name), json);
    // Read back: some tools report success without storing (e.g. a locked or missing keyring).
    if (this.read(name) !== json) throw new CredentialStoreError(`The ${this.label()} did not store the credential. Unlock it, or use SEARVEX_CREDENTIAL_STORE=file.`);
    this.legacy.delete(name);
  }

  delete(name: string): boolean {
    const removed = this.remove(checkName(name));
    return this.legacy.delete(name) || removed;
  }

  describe(): string {
    return `${this.label()} (service "${SERVICE}")`;
  }

  private label(): string {
    return { macos: 'macOS Keychain', 'secret-service': 'Secret Service keyring (libsecret)', 'windows-dpapi': 'Windows DPAPI (current user)' }[this.kind];
  }

  private dpapiFile(name: string): string {
    return path.join(this.dir, 'credentials.dpapi', `${name}.b64`);
  }

  private fail(action: string, r: ToolResult): never {
    const tool = { macos: 'security', 'secret-service': 'secret-tool', 'windows-dpapi': 'powershell.exe' }[this.kind];
    const why = r.status === null ? `${tool} is not available (${r.stderr})` : `${tool} exited with ${r.status}`;
    throw new CredentialStoreError(`Cannot ${action} the credential in the ${this.label()}: ${why}. Use SEARVEX_CREDENTIAL_STORE=file to keep it in the config directory instead.`);
  }

  private read(name: string): string | null {
    if (this.kind === 'windows-dpapi') {
      const f = this.dpapiFile(name);
      if (!fs.existsSync(f)) return null;
      const r = this.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_UNPROTECT], fs.readFileSync(f, 'utf8'));
      if (r.status !== 0) this.fail('read', r);
      return r.stdout;
    }
    const r = this.kind === 'macos' ? this.run('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w']) : this.run('secret-tool', ['lookup', 'service', SERVICE, 'account', name]);
    if (r.status === null) this.fail('read', r);
    // Not found: security exits 44, secret-tool exits 1 with empty output.
    if (r.status !== 0) return null;
    const out = r.stdout.replace(/\n$/, '');
    // `security -w` prints the password as hex when it contains non-ASCII bytes; stored JSON starts with "{".
    if (this.kind === 'macos' && /^(?:[0-9a-f]{2})+$/i.test(out) && !out.startsWith('{')) return Buffer.from(out, 'hex').toString('utf8');
    return out || null;
  }

  private write(name: string, json: string): void {
    if (this.kind === 'windows-dpapi') {
      const r = this.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_PROTECT], json);
      if (r.status !== 0 || !r.stdout.trim()) this.fail('store', r);
      const f = this.dpapiFile(name);
      fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, r.stdout.trim(), { mode: 0o600 });
      fs.renameSync(tmp, f);
      return;
    }
    // `security -i` reads the command from stdin, so the hex-encoded secret never appears in argv.
    const r =
      this.kind === 'macos'
        ? this.run('security', ['-i'], `add-generic-password -U -s ${SERVICE} -a ${name} -l Searvex-${name} -X ${Buffer.from(json, 'utf8').toString('hex')}\n`)
        : this.run('secret-tool', ['store', `--label=Searvex ${name}`, 'service', SERVICE, 'account', name], json);
    if (r.status !== 0) this.fail('store', r);
  }

  private remove(name: string): boolean {
    if (this.kind === 'windows-dpapi') {
      const f = this.dpapiFile(name);
      if (!fs.existsSync(f)) return false;
      fs.rmSync(f);
      return true;
    }
    if (this.read(name) === null) return false;
    const r = this.kind === 'macos' ? this.run('security', ['delete-generic-password', '-s', SERVICE, '-a', name]) : this.run('secret-tool', ['clear', 'service', SERVICE, 'account', name]);
    if (r.status !== 0) this.fail('delete', r);
    return true;
  }
}

function checkName(name: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) throw new CredentialStoreError(`Invalid credential name: ${name}`);
  return name;
}

/** Store selected by SEARVEX_CREDENTIAL_STORE (`file`, the default, or `keychain`). */
export function defaultCredentialStore(): CredentialStore {
  const choice = (process.env['SEARVEX_CREDENTIAL_STORE'] ?? 'file').toLowerCase();
  if (choice === 'file') return new FileCredentialStore();
  if (choice === 'keychain') {
    const kind = keychainKind();
    if (!kind) throw new CredentialStoreError(`No OS keychain support on ${process.platform}; use SEARVEX_CREDENTIAL_STORE=file.`);
    return new KeychainCredentialStore(kind);
  }
  throw new CredentialStoreError(`SEARVEX_CREDENTIAL_STORE must be "file" or "keychain" (got "${choice}").`);
}
