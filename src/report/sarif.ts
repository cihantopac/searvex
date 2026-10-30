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
              const rule = kb.rules.get(id)!;
              return {
                id,
                name: id.replace(/[.-](\w)/g, (_, c: string) => c.toUpperCase()),
                shortDescription: { text: rule.title },
                fullDescription: { text: rule.description },
                help: { text: `${rule.fix}\nSources: ${rule.sources.map((s) => s.url).join(' ')}` },
                helpUri: rule.sources[0]?.url,
                properties: { category: rule.category, engines: rule.engines, confidence: rule.confidence },
              };
            }),
          },
        },
        results: r.findings.flatMap((f) =>
          f.evidence.map((e) => ({
            ruleId: f.ruleId,
            level: LEVEL[f.severity],
            message: { text: `${f.title}${e.observed ? ': ' + e.observed : ''}` },
            locations: [
              e.file
                ? { physicalLocation: { artifactLocation: { uri: e.file }, region: e.line ? { startLine: e.line } : undefined } }
                : { physicalLocation: { artifactLocation: { uri: e.url ?? r.target } } },
            ],
            properties: { confidence: f.confidence },
          })),
        ),
      },
    ],
  };
}
