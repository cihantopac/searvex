import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialStoreError, defaultCredentialStore, FileCredentialStore, KeychainCredentialStore, type KeychainKind, type ToolRunner } from '../../src/integrations/credentials.js';

const cred = (refreshToken = 'rt-secret-1') => ({ clientId: 'cid', clientSecret: 'cs-secret', refreshToken, scope: 'scope', createdAt: '2026-10-31T00:00:00Z' });

/** In-memory imitation of `security`, `secret-tool` and the DPAPI PowerShell helpers; records argv. */
function fakeTools() {
  const items = new Map<string, string>();
  const argv: string[][] = [];
  const run: ToolRunner = (cmd, args, input) => {
    argv.push([cmd, ...args]);
    const val = (flag: string) => args[args.indexOf(flag) + 1]!;
    if (cmd === 'security' && args[0] === '-i') {
      const m = /-a (\S+) .*-X ([0-9a-f]+)/.exec(input ?? '')!;
      items.set(m[1]!, Buffer.from(m[2]!, 'hex').toString('utf8'));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'security' && args[0] === 'find-generic-password') {
      const v = items.get(val('-a'));
      return v === undefined ? { status: 44, stdout: '', stderr: 'not found' } : { status: 0, stdout: /[^\x20-\x7e]/.test(v) ? Buffer.from(v).toString('hex') + '\n' : v + '\n', stderr: '' };
    }
    if (cmd === 'security' && args[0] === 'delete-generic-password') return { status: items.delete(val('-a')) ? 0 : 44, stdout: '', stderr: '' };
    if (cmd === 'secret-tool') {
      const account = args[args.length - 1]!;
      if (args[0] === 'store') return items.set(account, input ?? ''), { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'lookup') return items.has(account) ? { status: 0, stdout: items.get(account)!, stderr: '' } : { status: 1, stdout: '', stderr: '' };
      if (args[0] === 'clear') return items.delete(account), { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'powershell.exe') {
      const script = args.at(-1)!;
      if (script.includes('::Protect(')) return { status: 0, stdout: Buffer.from('enc:' + input).toString('base64'), stderr: '' };
      return { status: 0, stdout: Buffer.from(input!.trim(), 'base64').toString('utf8').replace(/^enc:/, ''), stderr: '' };
    }
    return { status: null, stdout: '', stderr: 'ENOENT' };
  };
  return { run, items, argv };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-cred-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe.each<KeychainKind>(['macos', 'secret-service', 'windows-dpapi'])('keychain store (%s)', (kind) => {
  it('round-trips, rotates and deletes a credential without putting secrets in command-line arguments', () => {
    const t = fakeTools();
    const s = new KeychainCredentialStore(kind, t.run, dir);
    expect(s.get('gsc')).toBeNull();
    s.set('gsc', { ...cred(), clientId: 'cïd "quoted"' });
    expect(s.get('gsc')!.clientId).toBe('cïd "quoted"');
    s.set('gsc', cred('rt-secret-2'));
    expect(s.get('gsc')!.refreshToken).toBe('rt-secret-2');
    expect(s.delete('gsc')).toBe(true);
    expect(s.get('gsc')).toBeNull();
    expect(s.delete('gsc')).toBe(false);
    const args = t.argv.flat().join(' ');
    for (const secret of ['rt-secret', 'cs-secret', Buffer.from('rt-secret').toString('hex')]) expect(args).not.toContain(secret);
    if (kind === 'windows-dpapi') {
      // Only ciphertext reaches the disk.
      s.set('gsc', cred());
      const f = path.join(dir, 'credentials.dpapi', 'gsc.b64');
      expect(fs.readFileSync(f, 'utf8')).not.toContain('rt-secret');
    }
  });

  it('reads a credential saved by the file backend and moves it out of the file on the next save', () => {
    const file = new FileCredentialStore(dir);
    file.set('gsc', cred('rt-legacy'));
    const s = new KeychainCredentialStore(kind, fakeTools().run, dir);
    expect(s.get('gsc')!.refreshToken).toBe('rt-legacy');
    s.set('gsc', cred('rt-new'));
    expect(file.get('gsc')).toBeNull();
    expect(fs.readFileSync(file.file, 'utf8')).not.toContain('rt-');
    expect(s.get('gsc')!.refreshToken).toBe('rt-new');
  });

  it('fails loudly (no silent fallback) when the OS tool is missing or does not store', () => {
    const missing = new KeychainCredentialStore(kind, () => ({ status: null, stdout: '', stderr: 'ENOENT' }), dir);
    expect(() => missing.set('gsc', cred())).toThrow(/SEARVEX_CREDENTIAL_STORE=file/);
    expect(fs.existsSync(path.join(dir, 'credentials.json'))).toBe(false);
    // Writes report success but nothing is stored (e.g. a locked keyring); DPAPI returns unrelated ciphertext.
    const t = fakeTools();
    const lying: ToolRunner = (cmd, args, input) => {
      const isWrite = args[0] === '-i' || args[0] === 'store' || (cmd === 'powershell.exe' && args.at(-1)!.includes('::Protect('));
      if (!isWrite) return t.run(cmd, args, input);
      return { status: 0, stdout: cmd === 'powershell.exe' ? Buffer.from('enc:{}').toString('base64') : '', stderr: '' };
    };
    expect(() => new KeychainCredentialStore(kind, lying, dir).set('gsc', cred())).toThrow(/did not store/);
  });

  it('rejects names that could be read as tool options', () => {
    const s = new KeychainCredentialStore(kind, fakeTools().run, dir);
    expect(() => s.set('-w', cred())).toThrow(CredentialStoreError);
    expect(() => s.get('../x')).toThrow(CredentialStoreError);
  });
});

describe('store selection', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('defaults to the file store; keychain is opt-in; other values are rejected', () => {
    vi.stubEnv('SEARVEX_CREDENTIAL_STORE', '');
    vi.stubEnv('SEARVEX_CREDENTIAL_STORE', undefined as never);
    expect(defaultCredentialStore()).toBeInstanceOf(FileCredentialStore);
    vi.stubEnv('SEARVEX_CREDENTIAL_STORE', 'keychain');
    expect(defaultCredentialStore()).toBeInstanceOf(KeychainCredentialStore);
    vi.stubEnv('SEARVEX_CREDENTIAL_STORE', 'vault');
    expect(() => defaultCredentialStore()).toThrow(/file" or "keychain/);
  });
});

/** Real OS stores: Windows DPAPI always runs on Windows (CI); macOS Keychain only when opted in locally. */
const realKind = process.platform === 'win32' ? 'windows-dpapi' : process.platform === 'darwin' && process.env['SEARVEX_TEST_KEYCHAIN'] === '1' ? 'macos' : null;
describe.runIf(realKind)('real OS credential store', () => {
  it('round-trips a credential with non-ASCII text', () => {
    const s = new KeychainCredentialStore(realKind!, undefined, dir);
    const c = { ...cred('rt-real-test'), clientId: 'cïd "quoted" ğüş' };
    try {
      s.set('searvex-selftest', c);
      expect(s.get('searvex-selftest')).toEqual(c);
    } finally {
      s.delete('searvex-selftest');
    }
    expect(s.get('searvex-selftest')).toBeNull();
  });
});
