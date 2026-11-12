// GitHub Action entry (action.yml): runs `searvex audit`, writes the step outputs and a job summary, and always
// exits 0 so the SARIF upload runs; the last action step fails the job with the audit's exit code.
// Inputs come from INPUT_* environment variables. SEARVEX_ACTION_BIN replaces the npx command (tests).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const env = process.env;
const target = env.INPUT_TARGET || '.';
const failOn = env.INPUT_FAIL_ON || 'high';
const maxPages = env.INPUT_MAX_PAGES || '50';
const version = env.INPUT_VERSION || 'latest';
const extra = (env.INPUT_ARGS || '').split(/\s+/).filter(Boolean);
const out = path.join(env.RUNNER_TEMP || os.tmpdir(), `searvex-${process.pid}`);
fs.mkdirSync(out, { recursive: true });

const isUrl = /^https?:\/\//i.test(target);
const args = ['audit', target, '--out', out, '--format', 'json,md,html,sarif', '--quiet', ...(failOn !== 'none' ? ['--fail-on', failOn] : []), ...(isUrl ? ['--max-pages', maxPages] : []), ...extra];
const [cmd, ...pre] = env.SEARVEX_ACTION_BIN ? [process.execPath, env.SEARVEX_ACTION_BIN] : ['npx', '--yes', `searvex-seo@${version}`];
console.log(`searvex ${args.join(' ')}`);
const res = spawnSync(cmd, [...pre, ...args], { stdio: 'inherit', shell: process.platform === 'win32' && cmd === 'npx' });
const code = res.status ?? 3;

const runs = path.join(out, '.searvex', 'runs');
const runDir = fs.existsSync(runs)
  ? fs
      .readdirSync(runs)
      .map((d) => path.join(runs, d))
      .filter((d) => fs.existsSync(path.join(d, 'report.json')))
      .sort()
      .at(-1)
  : undefined;
const file = (name) => (runDir && fs.existsSync(path.join(runDir, name)) ? path.join(runDir, name) : '');

const outputs = { 'exit-code': String(code), sarif: file('report.sarif'), report: file('report.json'), 'run-dir': runDir ?? '' };
if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''));

if (env.GITHUB_STEP_SUMMARY && outputs.report) {
  const r = JSON.parse(fs.readFileSync(outputs.report, 'utf8'));
  const count = (s) => r.findings.filter((f) => f.severity === s).length;
  const top = r.findings
    .filter((f) => f.severity !== 'info' && !f.context)
    .sort((a, b) => (b.priority?.score ?? 0) - (a.priority?.score ?? 0))
    .slice(0, 10)
    .map((f) => `| ${f.severity} | ${String(f.title).replace(/\|/g, '\\|')} | \`${f.ruleId}\` | ${f.affected?.count ?? f.evidence.length} |`);
  const lines = [
    `## Searvex audit — ${r.target}`,
    '',
    `Health score **${r.scores?.overall ?? 'n/a'}** · critical ${count('critical')} · high ${count('high')} · medium ${count('medium')} · low ${count('low')} · exit code ${code}`,
    '',
    ...(top.length ? ['| Severity | Issue | Rule | Affected |', '|---|---|---|---|', ...top, ''] : []),
    `Full reports (HTML, Markdown, JSON, SARIF) are in \`${runDir}\`; upload them with actions/upload-artifact to keep them.`,
    '',
  ];
  fs.appendFileSync(env.GITHUB_STEP_SUMMARY, lines.join('\n'));
}
process.exit(0);
