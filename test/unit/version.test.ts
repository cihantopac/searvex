import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SEARVEX_VERSION } from '../../src/net/fetcher.js';

describe('version consistency', () => {
  it('package.json, plugin manifest and runtime version match (installed plugins update only on manifest bumps)', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
    const plugin = JSON.parse(fs.readFileSync('.claude-plugin/plugin.json', 'utf8')).version;
    expect(plugin).toBe(pkg);
    expect(SEARVEX_VERSION).toBe(pkg);
  });
});
