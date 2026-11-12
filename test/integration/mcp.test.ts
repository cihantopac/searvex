import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTools, handleMessage, serveMcp } from '../../src/mcp/server.js';
import { loadKnowledge } from '../../src/rules/engine.js';
import { DEFAULT_POLICY } from '../../src/net/ssrf.js';
import { page, startServer, text, type TestServer } from '../helpers/server.js';

let site: TestServer;
let ws: string;
const kb = loadKnowledge();
const serial = <T>(fn: () => Promise<T>) => fn();
type Res = { result?: Record<string, unknown>; error?: { code: number; message: string; data?: unknown } };

beforeAll(async () => {
  site = await startServer({
    '/': { body: page({ title: 'Home page of the site', body: `<h1>Home</h1>${text(150)}<a href="/a">a</a>` }) },
    '/a': { body: page({ title: 'Page A of the site', body: `<h1>A</h1>${text(150)}` }) },
  });
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-mcp-'));
});
afterAll(async () => {
  await site.close();
  fs.rmSync(ws, { recursive: true, force: true });
});

const tools = (allowPrivate: boolean) => buildTools({ workspace: ws, kb, policy: { ...DEFAULT_POLICY, allowPrivate }, crawl: { delayMs: 0, concurrency: 1 } }, serial);
const call = async (t: ReturnType<typeof tools>, method: string, params: Record<string, unknown> = {}, id = 1) => (await handleMessage({ jsonrpc: '2.0', id, method, params }, t)) as Res;

describe('H2: MCP protocol', () => {
  it('negotiates the version on initialize and lists read-only tools', async () => {
    const t = tools(false);
    expect((await call(t, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } })).result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'searvex' } });
    expect((await call(t, 'initialize', { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 'x', version: '1' } })).result!['protocolVersion']).toBe('2025-11-25');
    const list = (await call(t, 'tools/list')).result!['tools'] as Array<{ name: string; annotations: { readOnlyHint: boolean } }>;
    expect(list.map((x) => x.name)).toEqual(['audit', 'geo', 'report', 'findings', 'prompt', 'rules']);
    expect(list.every((x) => x.annotations.readOnlyHint)).toBe(true);
    expect(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, t)).toBeNull();
  });

  it('serves stateless 2026-07-28 requests and refuses unknown versions and methods', async () => {
    const t = tools(false);
    const meta = (v: string) => ({ _meta: { 'io.modelcontextprotocol/protocolVersion': v, 'io.modelcontextprotocol/clientCapabilities': {} } });
    const ok = await call(t, 'tools/list', meta('2026-07-28'));
    expect(ok.result!['_meta']).toEqual({ 'io.modelcontextprotocol/serverInfo': { name: 'searvex', version: expect.any(String) } });
    expect((await call(t, 'tools/list', meta('1900-01-01'))).error).toMatchObject({ code: -32022, data: { requested: '1900-01-01' } });
    expect((await call(t, 'resources/list')).error!.code).toBe(-32601);
    expect((await call(t, 'tools/call', { name: 'optimize' })).error!.code).toBe(-32602);
    expect((await handleMessage([{ jsonrpc: '2.0', id: 1, method: 'ping' }], t)) as Res).toMatchObject({ error: { code: -32600 } });
  });
});

describe('H2: tools', () => {
  it('the network policy fixed at start applies: a private target is a tool error the model can read', async () => {
    const r = (await call(tools(false), 'tools/call', { name: 'audit', arguments: { url: site.url + '/' } })).result!;
    expect(r['isError']).toBe(true);
    expect((r['content'] as Array<{ text: string }>)[0]!.text).toMatch(/blocked by the network policy|not allowed/i);
  });

  it('audit, then report, findings, prompt and rules on the stored run', async () => {
    const t = tools(true);
    const audit = (await call(t, 'tools/call', { name: 'audit', arguments: { url: site.url + '/', maxPages: 5 } })).result!;
    expect(audit['isError']).toBe(false);
    const s = audit['structuredContent'] as { runId: string; schemaVersion: string; findings: number; top: unknown[] };
    expect(s.schemaVersion).toMatch(/^1\.\d+$/);
    expect(s.findings).toBeGreaterThan(0);
    const report = (await call(t, 'tools/call', { name: 'report', arguments: { runId: s.runId } })).result!['structuredContent'] as { runId: string; findings: Array<{ affected?: { urls?: string[] } }> };
    expect(report.runId).toBe(s.runId);
    expect(report.findings.every((f) => !f.affected?.urls)).toBe(true);
    const high = (await call(t, 'tools/call', { name: 'findings', arguments: { runId: s.runId, minSeverity: 'medium', limit: 50 } })).result!['structuredContent'] as { findings: Array<{ severity: string }> };
    expect(high.findings.every((f) => ['critical', 'high', 'medium'].includes(f.severity))).toBe(true);
    const prompt = (await call(t, 'tools/call', { name: 'prompt', arguments: { runId: s.runId } })).result!;
    expect((prompt['content'] as Array<{ text: string }>)[0]!.text.length).toBeGreaterThan(100);
    expect((await call(t, 'tools/call', { name: 'prompt', arguments: { runId: s.runId, rules: ['nope.rule'] } })).result!['isError']).toBe(true);
    const rule = (await call(t, 'tools/call', { name: 'rules', arguments: { id: 'title.missing' } })).result!['structuredContent'] as { sources: unknown[] };
    expect(rule.sources.length).toBeGreaterThan(0);
  });

  it('stdio framing: one JSON-RPC message per line on stdout, nothing else; parse errors are answered', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let out = '';
    output.on('data', (c) => (out += String(c)));
    const done = serveMcp({ workspace: ws, kb, policy: DEFAULT_POLICY, crawl: {} }, input, output);
    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}\n');
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    input.write('not json\n');
    input.write('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"rules","arguments":{"category":"geo"}}}\n');
    input.end();
    await done;
    const lines = out.trim().split('\n').map((l) => JSON.parse(l) as { id: number | null; error?: { code: number } });
    expect(lines.map((l) => l.id).sort()).toEqual([1, 2, null].sort());
    expect(lines.find((l) => l.id === null)!.error!.code).toBe(-32700);
  });
});
