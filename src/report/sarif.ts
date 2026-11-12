import type { AuditReport } from '../analyze/audit.js';
import type { Severity } from '../core/types.js';
import type { KnowledgeBase } from '../rules/engine.js';

const LEVEL: Record<Severity, 'error' | 'warning' | 'note' | 'none'> = { critical: 'error', high: 'error', medium: 'warning', low: 'note', info: 'none' };

/** SARIF 2.1.0 output for GitHub code scanning and other CI tools. */
export function renderSarif(r: AuditReport, kb: KnowledgeBase): object {
  const ruleIds = [...new Set(r.findings.map((f) => f.ruleId))];
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'Searvex',
            version: r.tool.version,
            informationUri: 'https://github.com/cihantopac/searvex',
            rules: ruleIds.map((id) => {
              // A pack rule is unknown when a report is re-rendered without its --rules-pack: fall back to the finding.
              const f = r.findings.find((x) => x.ruleId === id)!;
              const rule = kb.rules.get(id);
              return {
                id,
                name: id.replace(/[.-](\w)/g, (_, c: string) => c.toUpperCase()),
                shortDescription: { text: rule?.title ?? f.title },
                fullDescription: { text: rule?.description ?? f.message },
                help: { text: `${rule?.fix ?? f.fix ?? ''}${rule ? `\nSources: ${rule.sources.map((s) => s.url).join(' ')}` : ''}` },
                helpUri: rule?.sources[0]?.url,
                properties: { category: f.category, engines: f.engines, confidence: f.confidence, ...(f.pack ? { pack: f.pack } : {}) },
              };
            }),
          },
        },
        results: r.findings.flatMap((f) =>
          f.evidence.map((e) => ({
            ruleId: f.ruleId,
            // Pre-launch context findings must not fail code-scanning gates.
            level: f.context ? 'note' : LEVEL[f.severity],
            message: { text: `${f.title}${e.observed ? ': ' + e.observed : ''}` },
            locations: [
              e.file
                ? { physicalLocation: { artifactLocation: { uri: e.file }, region: e.line ? { startLine: e.line } : undefined } }
                : { physicalLocation: { artifactLocation: { uri: e.url ?? r.target } } },
            ],
            properties: { confidence: f.confidence, ...(f.context ? { context: f.context } : {}) },
          })),
        ),
      },
    ],
  };
}
