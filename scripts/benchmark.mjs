// Performance benchmark: crawls and analyses a synthetic site served from localhost.
// Usage: npm run build && node scripts/benchmark.mjs [pages=5000] [concurrency=8]
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { crawl } from '../dist/crawl/crawler.js';
import { analyzeCrawl } from '../dist/analyze/audit.js';
import { loadKnowledge } from '../dist/rules/engine.js';
import { RunStore } from '../dist/crawl/store.js';

const N = Number(process.argv[2] ?? 5000);
const C = Number(process.argv[3] ?? 8);
const words = 'kitchen equipment oven chef restaurant durable tested stainless steel commercial grade warranty service'.split(' ');
const para = (i) => Array.from({ length: 250 }, (_, k) => words[(i * 7 + k * 13) % words.length]).join(' ');

const server = http.createServer((req, res) => {
  const m = /^\/p\/(\d+)$/.exec(req.url ?? '');
  const i = req.url === '/' ? 0 : m ? Number(m[1]) : -1;
  if (req.url === '/robots.txt') return res.end('User-agent: *\nAllow: /\n');
  if (i < 0 || i >= N) return res.writeHead(404).end('not found');
  const links = Array.from({ length: 20 }, (_, k) => `<a href="/p/${(i * 31 + k * 97 + 1) % N}">Product ${(i * 31 + k * 97 + 1) % N}</a>`).join(' ');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Product ${i} — Bench</title><meta name="description" content="Product ${i}"><link rel="canonical" href="http://127.0.0.1:${server.address().port}/p/${i}"></head><body><h1>Product ${i}</h1><p>${para(i)}</p><nav>${links}</nav></body></html>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-bench-'));
const store = new RunStore(ws, 'bench');
const policy = { allowPrivate: true, schemes: ['http:', 'https:'], ports: [] };

let peak = 0;
const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 100);
const t0 = performance.now();
const result = await crawl(base + '/', { maxPages: N, maxDepth: 100, concurrency: C, delayMs: 0, useSitemaps: false, policy }, store);
const t1 = performance.now();
const report = await analyzeCrawl(result, loadKnowledge(), { policy, probes: false });
const t2 = performance.now();
clearInterval(sampler);
server.close();
fs.rmSync(ws, { recursive: true, force: true });

const out = {
  date: new Date().toISOString().slice(0, 10),
  node: process.version,
  platform: `${os.platform()} ${os.arch()} (${os.cpus()[0]?.model ?? 'cpu'})`,
  pages: result.pages.length,
  concurrency: C,
  crawlSeconds: +((t1 - t0) / 1000).toFixed(2),
  pagesPerSecond: Math.round(result.pages.length / ((t1 - t0) / 1000)),
  analysisSeconds: +((t2 - t1) / 1000).toFixed(2),
  peakRssMB: Math.round(peak / 1024 / 1024),
  findings: report.findings.length,
};
console.log(JSON.stringify(out, null, 2));
