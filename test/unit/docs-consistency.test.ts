import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Documentation drift checks: versions, commands, subcommands and environment variables mentioned in the
 * README, docs and plugin skills must match the code.
 */
const read = (f: string) => fs.readFileSync(f, 'utf8');
const version = JSON.parse(read('package.json')).version as string;
const cli = read('src/cli.ts');
const gsc = read('src/commands/gsc.ts');
const commands = [...cli.slice(cli.indexOf('switch (cmd)')).matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]!);
const docsCli = read('docs/cli.md');
const skills = fs.readdirSync('skills').map((d) => read(path.join('skills', d, 'SKILL.md')));

function srcFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? srcFiles(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
}

describe('documentation consistency', () => {
  it('versions match across CHANGELOG, README, limitations and the plugin manifest', () => {
    expect(/## \[(\d+\.\d+\.\d+)\]/.exec(read('CHANGELOG.md'))?.[1]).toBe(version);
    expect(/Status: \*\*v(\d+\.\d+\.\d+)/.exec(read('README.md'))?.[1]).toBe(version);
    expect(/Known limits \(v(\d+\.\d+\.\d+)\)/.exec(read('docs/limitations.md'))?.[1]).toBe(version);
    expect(JSON.parse(read('.claude-plugin/plugin.json')).version).toBe(version);
  });

  it('every CLI command is in --help and in docs/cli.md', () => {
    expect(commands.length).toBeGreaterThan(10);
    const help = cli.slice(cli.indexOf('const HELP'), cli.indexOf('export const SEVERITY_ORDER'));
    for (const c of commands) {
      expect(help, `--help lacks ${c}`).toMatch(new RegExp(`\\n  ${c}\\b`));
      expect(docsCli, `docs/cli.md lacks ${c}`).toMatch(new RegExp(`\\| \`${c}\\b`));
    }
  });

  it('commands and gsc subcommands used in skills and docs exist', () => {
    const gscUsage = /gsc subcommands: ([^']+)'/.exec(gsc)?.[1] ?? '';
    const gscSubs = new Set([...gscUsage.matchAll(/(?:^|\| )([a-z]+)/g)].map((m) => m[1]!));
    expect(gscSubs).toEqual(new Set(['auth', 'status', 'sites', 'report', 'import', 'logout']));
    for (const text of [...skills, read('README.md'), docsCli]) {
      for (const m of text.matchAll(/(?:searvex\.mjs"|(?:^|`|=\S* )searvex) ([a-z][a-z-]+)/gm)) expect(commands, `unknown command "${m[1]}"`).toContain(m[1]);
      for (const m of text.matchAll(/\bgsc ([a-z]+)\b/g)) expect(gscSubs, `unknown gsc subcommand "${m[1]}"`).toContain(m[1]);
    }
  });

  it('every SEARVEX_* environment variable read by the code is documented', () => {
    const vars = new Set<string>();
    for (const f of srcFiles('src')) for (const m of read(f).matchAll(/process\.env\['(SEARVEX_[A-Z_]+)'\]/g)) vars.add(m[1]!);
    // Endpoint overrides exist for tests only and are intentionally undocumented.
    for (const v of [...vars].filter((x) => !/_(URL|API_BASE)$/.test(x))) expect(docsCli, `docs/cli.md lacks ${v}`).toContain(v);
  });
});
