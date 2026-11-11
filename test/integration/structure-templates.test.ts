import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditWebsite, type AuditReport } from '../../src/analyze/audit.js';
import { extractPage } from '../../src/extract/html.js';
import { DEFAULT_POLICY } from '../../src/net/ssrf.js';
import { startServer, text, type TestServer } from '../helpers/server.js';

/** One product template: same landmarks, classes and heading levels; different text and URL. */
const product = (name: string, extra = '') =>
  `<!doctype html><html lang="en"><head><title>${name} — handmade product of the shop</title></head><body class="shop"><header class="site-header"><nav><a href="/">Home</a></nav></header><main class="product-${name.length}"><h1>${name}</h1><div class="gallery g-${name.length}"></div><section class="details"><h2>Details</h2><p>${text(150)} ${name}</p>${extra}</section></main><footer class="site-footer">Shop</footer></body></html>`;
const article = (title: string) =>
  `<!doctype html><html lang="en"><head><title>${title} — notes from the workshop blog</title></head><body><div class="wrapper"><article><h1>${title}</h1><h3>Intro</h3><p>${text(200)}</p></article></div></body></html>`;

const SLUGS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
let site: TestServer;
let ws: string;
let report: AuditReport;

beforeAll(async () => {
  const routes: Record<string, { body: string }> = {
    '/': { body: `<!doctype html><html lang="en"><head><title>Home page of the workshop shop</title><meta name="description" content="Handmade products and notes from the workshop."></head><body><h1>Shop</h1>${text(150)}${SLUGS.map((s) => `<a href="/${s}">${s}</a>`).join('')}<a href="/notes/one">n1</a><a href="/notes/two">n2</a></body></html>` },
    '/notes/one': { body: article('First notes') },
    '/notes/two': { body: article('Second notes') },
  };
  // Pages with a description, so the finding is not on most pages (that would be the "shared layout" case).
  for (let i = 0; i < 8; i++) {
    routes[`/guides/g${i}`] = { body: article(`Guide number ${i}`).replace('</title>', '</title><meta name="description" content="A guide from the workshop with useful steps.">') };
    routes['/'].body = routes['/'].body.replace('</body>', `<a href="/guides/g${i}">g${i}</a></body>`);
  }
  // Flat slugs: six URL patterns, one product template, none with a meta description.
  for (const s of SLUGS) routes[`/${s}`] = { body: product(s[0]!.toUpperCase() + s.slice(1), s === 'delta' ? '<ul><li>extra list</li></ul>' : '') };
  site = await startServer(routes);
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-structure-'));
  ({ report } = await auditWebsite(site.url + '/', { workspace: ws, probes: false, crawl: { policy: { ...DEFAULT_POLICY, allowPrivate: true }, delayMs: 0 } }));
});

afterAll(async () => {
  await site.close();
  fs.rmSync(ws, { recursive: true, force: true });
});

describe('G2: page-structure templates', () => {
  it('one template gives one skeleton, whatever the text, URL or numbered classes', () => {
    const a = extractPage(product('Alpha'), 'https://e.com/alpha').skeleton;
    expect(extractPage(product('Gamma-long-name', '<ul><li>x</li></ul>'), 'https://e.com/g').skeleton).toBe(a);
    expect(extractPage(article('Notes'), 'https://e.com/notes/x').skeleton).not.toBe(a);
    expect(a).toMatch(/^[0-9a-z]{4,8}$/);
  });

  it('finds the template behind flat slugs and says "fix once"', () => {
    const f = report.findings.find((x) => x.ruleId === 'description.missing')!;
    expect(f.count).toBe(8);
    expect(f.templates!.length).toBeGreaterThan(2);
    expect(f.structures![0]).toMatchObject({ pages: 6, example: expect.stringMatching(new RegExp(`/(${SLUGS.join('|')})$`)) });
    expect(f.structures![1]).toMatchObject({ pages: 2, example: expect.stringMatching(/\/notes\//) });
    expect(f.priority!.effort).toBe('low');
    expect(f.priority!.reasons.join(' ')).toMatch(/one page structure behind \d+ URL patterns \(2 layouts\) — fix once/);
  });
});
