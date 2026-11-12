import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const BIN = path.resolve('bin/searvex');
const hasBundle = fs.existsSync(path.resolve('dist/searvex.mjs'));

describe.runIf(hasBundle)('H2: searvex mcp over stdio (bundled CLI)', () => {
  it('answers initialize, tools/list and tools/call with JSON-RPC lines only', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-mcp-e2e-'));
    const child = spawn(process.execPath, [BIN, 'mcp', '--out', ws], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SEARVEX_CREDENTIAL_STORE: 'file' } });
    let out = '';
    child.stdout.on('data', (c) => (out += String(c)));
    const send = (m: object) => child.stdin.write(JSON.stringify(m) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'report', arguments: {} } });
    child.stdin.end();
    const code = await new Promise<number | null>((r) => child.on('close', r));
    fs.rmSync(ws, { recursive: true, force: true });
    expect(code).toBe(0);
    const lines = out.trim().split('\n').map((l) => JSON.parse(l) as { id: number; result: Record<string, unknown> });
    expect(lines.map((l) => l.id).sort()).toEqual([1, 2, 3]);
    expect(lines.find((l) => l.id === 1)!.result['protocolVersion']).toBe('2025-11-25');
    expect((lines.find((l) => l.id === 2)!.result['tools'] as unknown[]).length).toBe(6);
    // No stored report yet: a readable tool error, not a protocol error.
    expect(lines.find((l) => l.id === 3)!.result).toMatchObject({ isError: true });
  }, 30_000);
});
