import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const hasBundle = fs.existsSync(path.resolve('dist/searvex.mjs'));
const actionYml = fs.readFileSync('action.yml', 'utf8');

describe('H1: GitHub Action definition', () => {
  it('passes inputs to scripts only through env (no expression interpolation in run commands)', () => {
    const runs = actionYml.split('\n').filter((l) => /^\s+run:/.test(l));
    expect(runs.length).toBeGreaterThanOrEqual(2);
    for (const l of runs) expect(l).not.toMatch(/\$\{\{/);
  });

  it('is valid YAML for GitHub: no plain (unquoted) value contains ": "', () => {
    // GitHub's parser rejects "description: text (needs \"a: b\")" unless the value is quoted.
    for (const [i, l] of actionYml.split('\n').entries()) {
      const m = /^\s*[\w-]+: (.*)$/.exec(l);
      if (m && !/^["'|>]/.test(m[1]!) && !m[1]!.startsWith('${{')) expect(m[1], `action.yml line ${i + 1}`).not.toMatch(/: /);
    }
  });

  it('defaults to the searvex-seo version of this release', () => {
    const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version as string;
    expect(/version:\n\s+description:[^\n]*\n\s+default: "([^"]+)"/.exec(actionYml)?.[1]).toBe(version);
  });
});

describe.runIf(hasBundle)('H1: action/run.mjs with the bundled CLI', () => {
  it('audits a repository, writes the outputs and the job summary, and reports the exit code without failing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-action-'));
    const repo = path.join(tmp, 'site');
    fs.mkdirSync(repo);
    // A static page without title, description or lang: high-severity findings.
    fs.writeFileSync(path.join(repo, 'index.html'), '<!doctype html><html><head></head><body><p>Hello there, this is a page.</p></body></html>');
    const output = path.join(tmp, 'output.txt');
    const summary = path.join(tmp, 'summary.md');
    const res = spawnSync(process.execPath, ['action/run.mjs'], {
      encoding: 'utf8',
      env: { ...process.env, SEARVEX_CREDENTIAL_STORE: 'file', SEARVEX_ACTION_BIN: path.resolve('dist/searvex.mjs'), RUNNER_TEMP: tmp, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, INPUT_TARGET: repo, INPUT_FAIL_ON: 'high' },
    });
    expect(res.status).toBe(0);
    const out = Object.fromEntries(fs.readFileSync(output, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    expect(out['exit-code']).toBe('1');
    const sarif = JSON.parse(fs.readFileSync(out['sarif']!, 'utf8')) as { version: string; runs: Array<{ results: unknown[] }> };
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0]!.results.length).toBeGreaterThan(0);
    expect(fs.existsSync(out['report']!)).toBe(true);
    expect(fs.readFileSync(summary, 'utf8')).toMatch(/## Searvex audit — [\s\S]*exit code 1[\s\S]*\| Severity \| Issue \| Rule \| Affected \|/);
    fs.rmSync(tmp, { recursive: true, force: true });
  }, 60_000);
});
