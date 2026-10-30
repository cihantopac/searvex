import path from 'node:path';
import { RunStore } from '../crawl/store.js';
import { auditRepository } from '../repo/audit.js';
import { loadKnowledge } from '../rules/engine.js';
import { failOnExit, printSummary, UsageError, writeReports, type GlobalFlags } from '../cli.js';

export async function commandRepo(flags: GlobalFlags): Promise<number> {
  const v = flags.values;
  const target = flags.positionals[1];
  if (!target) throw new UsageError('A repository path is required');
  const root = path.resolve(target);
  const siteUrl = v['site-url'] as string | undefined;
  if (siteUrl && !/^https?:\/\//.test(siteUrl)) throw new UsageError('--site-url must be an absolute http(s) URL');
  const kb = loadKnowledge();
  const { report, scan } = auditRepository(root, { siteUrl, kb });
  const store = new RunStore(path.resolve(String(v['out'] ?? root)), RunStore.newRunId('repo'));
  report.runId = store.runId;
  store.writeJson('meta.json', { kind: 'repository', target: root, framework: scan.detection.framework, startedAt: report.generatedAt });
  store.writeJson('scan.json', { detection: scan.detection, apps: scan.apps.map((a) => ({ appRoot: a.appRoot, framework: a.framework, routes: a.routes, locations: a.locations, originSource: a.originSource })), skipped: scan.skipped });
  const files = writeReports(store, report, kb, String(v['format'] ?? 'md,html,json').split(','));
  if (!v['json'] && !v['quiet']) {
    console.log(`\nRepository: ${root}`);
    console.log(`Apps: ${scan.apps.map((a) => `${a.framework}${a.appRoot === '.' ? '' : ' @ ' + a.appRoot}`).join(', ')}`);
    console.log(`Routes/pages found: ${scan.routes.length} · files scanned: ${scan.files.length}`);
  }
  printSummary(report, files, v);
  return failOnExit(report, v['fail-on']);
}
