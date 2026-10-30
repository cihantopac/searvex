import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isSecretPath, readText, resolveInside, walk } from '../../src/repo/fs-safe.js';
import { anchorsWithoutHref, imgWithoutAlt } from '../../src/repo/scan.js';

let root: string;
let outside: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-fs-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-out-'));
  fs.writeFileSync(path.join(outside, 'secret.html'), 'outside');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.html'), '<html></html>');
  fs.writeFileSync(path.join(root, '.env'), 'API_KEY=supersecret');
  fs.writeFileSync(path.join(root, 'id_rsa'), 'KEY');
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', 'x.html'), '');
  fs.symlinkSync(outside, path.join(root, 'linked'));
  fs.symlinkSync(path.join(outside, 'secret.html'), path.join(root, 'src', 'evil.html'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('safe filesystem access', () => {
  it('never walks symlinks, secrets or dependency folders', () => {
    const { files, skipped } = walk(root);
    const rels = files.map((f) => f.rel);
    expect(rels).toEqual(['src/a.html']);
    expect(skipped.symlinks).toBe(2);
    expect(skipped.secrets).toBe(2);
  });

  it('rejects path traversal and symlink escapes', () => {
    expect(() => resolveInside(root, '../etc/passwd')).toThrow(/escapes/);
    expect(() => resolveInside(root, '/etc/passwd')).toThrow(/escapes/);
    expect(() => resolveInside(root, 'linked/secret.html')).toThrow(/symlink/);
    expect(() => readText(root, 'src/evil.html')).toThrow();
  });

  it('refuses to read secret files even when asked directly', () => {
    expect(() => readText(root, '.env')).toThrow(/secret/);
    expect(isSecretPath('config/.env.production')).toBe(true);
    expect(isSecretPath('wp-config.php')).toBe(true);
    expect(isSecretPath('src/environment.ts')).toBe(false);
  });
});

describe('source pattern checks', () => {
  it('finds images without alt and anchors without href with line numbers', () => {
    const src = 'a\n<img src="x.png" />\n<Image src={p} alt="ok" />\n<img {...props} />\n<a onClick={go}>Go</a>\n<a href="/x">X</a>';
    expect(imgWithoutAlt(src)).toEqual([2]);
    expect(anchorsWithoutHref(src)).toEqual([5]);
  });
});
