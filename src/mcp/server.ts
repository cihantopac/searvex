import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { auditWebsite, compactAffected, type AuditReport } from '../analyze/audit.js';
import { RunStore } from '../crawl/store.js';
import { SEARVEX_VERSION } from '../net/fetcher.js';
import type { NetPolicy } from '../net/ssrf.js';
import { loadExtras } from '../report/extras.js';
import { buildRepairPrompt } from '../report/prompt.js';
import { repairPromptInput } from '../report/prompt-input.js';
import type { KnowledgeBase } from '../rules/engine.js';
import type { Severity } from '../core/types.js';

/** Most severe first (as in the CLI). */
const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

/**
 * `searvex mcp` (plan H2): a read-only Model Context Protocol server over stdio (newline-delimited JSON-RPC 2.0).
 * Tools: audit, geo, report, findings, prompt, rules. Nothing that changes files is exposed (no optimize --apply).
 * The network policy is fixed when the server starts (`--allow-private`, host and port limits, proxy); a tool call
 * cannot widen it. Audits run one at a time. Supports the initialize handshake (2025-03-26 … 2025-11-25) and the
 * stateless 2026-07-28 protocol (version in each request's `_meta`).
 */
export const MCP_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'] as const;
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';

export interface McpServerOptions {
  workspace: string;
  kb: KnowledgeBase;
  policy: NetPolicy;
  /** Crawl defaults for audit tools (delay, timeout …); max pages comes from the call (≤ maxPagesCap). */
  crawl: Record<string, unknown>;
  maxPagesCap?: number;
}

type Json = Record<string, unknown>;
interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  run: (args: Json) => Promise<{ text: string; structured?: Json; isError?: boolean }>;
}

const runIdArg = { type: 'string', description: 'Run id from .searvex/runs, or "latest" (default)' };

function latestReport(workspace: string, ref: unknown): { store: RunStore; report: AuditReport } {
  const want = typeof ref === 'string' && ref ? ref : 'latest';
  const ids = want === 'latest' ? RunStore.list(workspace).filter((r) => fs.existsSync(path.join(workspace, '.searvex', 'runs', r, 'report.json'))) : [want];
  const id = ids.at(-1);
  if (!id || !/^[\w.-]+$/.test(id)) throw new ToolError(want === 'latest' ? `No stored report in ${workspace}. Run the audit tool first.` : `Invalid run id: ${want}`);
  const store = new RunStore(workspace, id);
  const report = store.readJson<AuditReport>('report.json');
  if (!report) throw new ToolError(`Run ${id} has no report.json`);
  return { store, report };
}

class ToolError extends Error {}

/** A short, model-friendly summary of a report (the full object is in structuredContent of `report`). */
export function reportSummary(r: AuditReport): Json {
  const bySeverity: Record<string, number> = {};
  for (const f of r.findings) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
  const top = [...r.findings]
    .filter((f) => f.severity !== 'info' && !f.context)
    .sort((a, b) => (b.priority?.score ?? 0) - (a.priority?.score ?? 0))
    .slice(0, 10)
    .map((f) => ({ ruleId: f.ruleId, title: f.title, severity: f.severity, affected: f.affected?.count ?? (f as { count?: number }).count ?? f.evidence.length, ...(f.pack ? { pack: f.pack } : {}) }));
  return { runId: r.runId, schemaVersion: r.schemaVersion, mode: r.mode, target: r.target, status: r.crawl?.status, scores: r.scores, findings: r.findings.length, bySeverity, top };
}

export function buildTools(o: McpServerOptions, queue: <T>(fn: () => Promise<T>) => Promise<T>): Tool[] {
  const cap = o.maxPagesCap ?? 500;
  const audit = async (args: Json, maxDefault: number) => {
    const url = String(args['url'] ?? '');
    if (!/^https?:\/\//i.test(url)) throw new ToolError('url must be an http(s) URL');
    const maxPages = Math.max(1, Math.min(cap, Number(args['maxPages'] ?? maxDefault) || maxDefault));
    return queue(async () => {
      const { report } = await auditWebsite(url, { workspace: o.workspace, kb: o.kb, probes: true, compact: false, crawl: { ...o.crawl, policy: o.policy, maxPages } });
      // Unreachable or blocked by the server's network policy: an error the model can read (the report is stored).
      if (report.crawl.status === 'unreachable') throw new ToolError(`${url} was not audited (run ${report.runId}): ${report.crawl.error ?? 'unreachable'}`);
      return report;
    });
  };
  return [
    {
      name: 'audit',
      title: 'Audit a website',
      description: 'Crawl a public website (robots.txt respected) and audit technical SEO, GEO and content. Returns a summary; the full report is stored and readable with the report and findings tools.',
      inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'Start URL (http or https)' }, maxPages: { type: 'integer', minimum: 1, maximum: cap, description: `Pages to crawl (default 50, at most ${cap})` } }, required: ['url'] },
      run: async (args) => {
        const r = await audit(args, 50);
        const s = reportSummary(r);
        return { text: JSON.stringify(s, null, 2), structured: s };
      },
    },
    {
      name: 'geo',
      title: 'GEO / AI-search readiness',
      description: 'Audit a website (default 20 pages) and return its GEO section: AI crawler access by purpose, snippet controls, llms.txt, entity and content clarity notes.',
      inputSchema: { type: 'object', properties: { url: { type: 'string' }, maxPages: { type: 'integer', minimum: 1, maximum: cap } }, required: ['url'] },
      run: async (args) => {
        const r = await audit(args, 20);
        const out = { runId: r.runId, target: r.target, scores: r.scores, geo: r.geo, findings: r.findings.filter((f) => f.category === 'geo').map((f) => ({ ruleId: f.ruleId, title: f.title, severity: f.severity, observed: f.evidence[0]?.observed })) };
        return { text: JSON.stringify(out, null, 2), structured: out as Json };
      },
    },
    {
      name: 'report',
      title: 'Stored report',
      description: 'The stored report.json of a run (schema in "searvex schema report"), with per-finding affected URLs reduced to counts. Use findings for filtered lists.',
      inputSchema: { type: 'object', properties: { runId: runIdArg } },
      run: async (args) => {
        const { report } = latestReport(o.workspace, args['runId']);
        const compact = compactAffected(structuredClone(report));
        return { text: JSON.stringify(reportSummary(report), null, 2), structured: compact as unknown as Json };
      },
    },
    {
      name: 'findings',
      title: 'Findings of a run',
      description: 'Findings of a stored run, filtered by severity (minimum), category or rule id, most important first.',
      inputSchema: {
        type: 'object',
        properties: { runId: runIdArg, minSeverity: { type: 'string', enum: [...SEVERITY_ORDER] }, category: { type: 'string' }, ruleId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200, description: 'default 25' } },
      },
      run: async (args) => {
        const { report } = latestReport(o.workspace, args['runId']);
        // minSeverity "medium" keeps critical, high and medium (the order is most severe first).
        const min = typeof args['minSeverity'] === 'string' ? SEVERITY_ORDER.indexOf(args['minSeverity'] as Severity) : -1;
        const limit = Math.max(1, Math.min(200, Number(args['limit'] ?? 25) || 25));
        const list = report.findings
          .filter((f) => (min < 0 ? true : SEVERITY_ORDER.indexOf(f.severity) <= min))
          .filter((f) => !args['category'] || f.category === args['category'])
          .filter((f) => !args['ruleId'] || f.ruleId === args['ruleId'])
          .sort((a, b) => (b.priority?.score ?? 0) - (a.priority?.score ?? 0))
          .slice(0, limit)
          .map((f) => ({ ...f, evidence: f.evidence.slice(0, 5), affected: f.affected ? { count: f.affected.count } : undefined }));
        const out = { runId: report.runId, total: report.findings.length, returned: list.length, findings: list };
        return { text: JSON.stringify(out, null, 2), structured: out as unknown as Json };
      },
    },
    {
      name: 'prompt',
      title: 'Repair prompt',
      description: 'The repair prompt the HTML action center builds for a run (exact URLs or file:line, evidence, fix and verification), for a coding agent. Optionally limited to rule ids.',
      inputSchema: { type: 'object', properties: { runId: runIdArg, rules: { type: 'array', items: { type: 'string' } }, lang: { type: 'string', enum: ['en', 'tr'] } } },
      run: async (args) => {
        const { store, report } = latestReport(o.workspace, args['runId']);
        const rules = Array.isArray(args['rules']) ? (args['rules'] as unknown[]).map(String) : undefined;
        const unknown = rules?.filter((id) => !report.findings.some((f) => f.ruleId === id)) ?? [];
        if (unknown.length) throw new ToolError(`Not a finding of run ${report.runId}: ${unknown.join(', ')}`);
        const input = repairPromptInput(report, o.kb, loadExtras(store, report), { lang: args['lang'] === 'tr' ? 'tr' : 'en', rules });
        if (!input.items.length) throw new ToolError(`Run ${report.runId} has no issues to repair`);
        const prompt = buildRepairPrompt(input);
        return { text: prompt, structured: { runId: report.runId, rules: input.items.map((i) => i.ruleId), prompt } };
      },
    },
    {
      name: 'rules',
      title: 'Rule base',
      description: 'The sourced rule base: a list (optionally by category), or one rule with its description, fix, verification and official sources.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, category: { type: 'string' } } },
      run: async (args) => {
        if (args['id']) {
          const r = o.kb.rules.get(String(args['id']));
          if (!r) throw new ToolError(`Unknown rule: ${String(args['id'])}`);
          return { text: JSON.stringify(r, null, 2), structured: r as unknown as Json };
        }
        const rules = [...o.kb.rules.values()].filter((r) => !args['category'] || r.category === args['category']).map((r) => ({ id: r.id, title: r.title, category: r.category, severity: r.severity, confidence: r.confidence, ...(r.pack ? { pack: r.pack } : {}) }));
        const out = { version: o.kb.version, count: rules.length, rules };
        return { text: JSON.stringify(out, null, 2), structured: out };
      },
    },
  ];
}

/** Handle one JSON-RPC message; returns the response, or null for notifications. */
export async function handleMessage(msg: unknown, tools: Tool[]): Promise<Json | null> {
  const err = (id: unknown, code: number, message: string, data?: unknown): Json => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } });
  if (Array.isArray(msg)) return err(null, -32600, 'Batches are not supported');
  if (!msg || typeof msg !== 'object' || (msg as Json)['jsonrpc'] !== '2.0' || typeof (msg as Json)['method'] !== 'string') return err((msg as Json | null)?.['id'], -32600, 'Invalid request');
  const m = msg as { id?: string | number; method: string; params?: Json };
  const isNotification = m.id === undefined;
  const params = m.params ?? {};
  const meta = (params['_meta'] as Json | undefined) ?? {};
  const requested = meta[META_VERSION];
  if (typeof requested === 'string' && !(MCP_VERSIONS as readonly string[]).includes(requested)) return isNotification ? null : err(m.id, -32022, 'Unsupported protocol version', { supported: MCP_VERSIONS, requested });
  // Stateless (2026-07-28) results identify the server in their _meta.
  const ok = (result: Json): Json => ({ jsonrpc: '2.0', id: m.id!, result: typeof requested === 'string' ? { ...result, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'searvex', version: SEARVEX_VERSION } } } : result });
  if (isNotification) return null;
  switch (m.method) {
    case 'initialize': {
      const v = String(params['protocolVersion'] ?? '');
      const version = (MCP_VERSIONS as readonly string[]).includes(v) && v !== '2026-07-28' ? v : '2025-11-25';
      return ok({
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: 'searvex', title: 'Searvex', version: SEARVEX_VERSION },
        instructions: 'Searvex audits websites for technical SEO, GEO and content (read-only). Run "audit" first, then read results with "findings", "report" or "prompt". Findings cite official sources ("rules"). Never claims rankings or traffic.',
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: tools.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema, annotations: { readOnlyHint: true, openWorldHint: name === 'audit' || name === 'geo' } })) });
    case 'tools/call': {
      const tool = tools.find((t) => t.name === params['name']);
      if (!tool) return err(m.id, -32602, `Unknown tool: ${String(params['name'])}`);
      try {
        const r = await tool.run((params['arguments'] as Json | undefined) ?? {});
        return ok({ content: [{ type: 'text', text: r.text }], ...(r.structured ? { structuredContent: r.structured } : {}), isError: false });
      } catch (e) {
        // Tool failures go to the model as results it can read and correct, not as protocol errors.
        return ok({ content: [{ type: 'text', text: (e as Error).message }], isError: true });
      }
    }
    default:
      return err(m.id, -32601, `Method not found: ${m.method}`);
  }
}

/** Serve on stdin/stdout until stdin closes. stdout carries only JSON-RPC; logs go to stderr. */
export async function serveMcp(o: McpServerOptions, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  let chain: Promise<unknown> = Promise.resolve();
  const queue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };
  const tools = buildTools(o, queue);
  const log = console.log;
  console.log = (...a: unknown[]) => console.error(...a);
  const pending = new Set<Promise<void>>();
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
        continue;
      }
      const p = handleMessage(msg, tools).then((res) => {
        if (res) output.write(JSON.stringify(res) + '\n');
      });
      pending.add(p);
      void p.finally(() => pending.delete(p));
    }
    await Promise.all(pending);
  } finally {
    console.log = log;
  }
}
