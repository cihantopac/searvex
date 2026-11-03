import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditWebsite, indexableSummary } from '../../src/analyze/audit.js';
import { auditRepository } from '../../src/repo/audit.js';
import { DEFAULT_POLICY } from '../../src/net/ssrf.js';
import { summaryText } from '../../src/cli.js';
import { page, startServer, text, type TestServer } from '../helpers/server.js';

let ws: string;
const servers: TestServer[] = [];
const policy = { ...DEFAULT_POLICY, allowPrivate: true };

beforeAll(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-small-'));
});

afterAll(async () => {
  for (const s of servers) await s.close();
  fs.rmSync(ws, { recursive: true, force: true });
});

const orgFinding = async (routes: Parameters<typeof startServer>[0]) => {
  const s = await startServer(routes);
  servers.push(s);
  const { report } = await auditWebsite(s.url + '/', { workspace: ws, crawl: { policy, delayMs: 0 }, probes: false });
  return report.findings.find((f) => f.ruleId === 'geo.organization-missing');
};

describe('A4 Organization or Person suggestion', () => {
  it('a personal site without structured data is pointed to ProfilePage / Person (heuristic)', async () => {
    const f = await orgFinding({
      '/': { body: page({ title: 'Jane Doe — designer and developer', body: `<h1>Jane Doe</h1><a href="/about">About</a>${text(200)}` }) },
      '/about': { body: page({ title: 'About Jane Doe', body: `<h1>About</h1>${text(200)}` }) },
    });
    expect(f?.evidence[0]?.observed).toMatch(/looks like a personal site \(heuristic: homepage title starts with a name \("Jane Doe"\).*\): add ProfilePage with a Person mainEntity/);
    expect(f?.message).toMatch(/Person \/ ProfilePage/);
  });

  it('a company site gets the Organization-or-Person suggestion', async () => {
    const f = await orgFinding({
      '/': { body: page({ title: 'Acme Labs — rockets for everyone', body: `<h1>Acme</h1><a href="/pricing">Pricing</a>${text(200)}` }) },
      '/pricing': { body: page({ title: 'Pricing — Acme Labs', body: `<h1>Pricing</h1>${text(200)}` }) },
    });
    expect(f?.evidence[0]?.observed).toMatch(/add Organization \(company or brand\) or ProfilePage with a Person mainEntity \(personal site\)/);
    expect(f?.message).toMatch(/no Organization markup .* and no Person \/ ProfilePage markup/);
  });
});

describe('A6 repository-mode indexability', () => {
  const repo = (files: Record<string, string>) => {
    const dir = fs.mkdtempSync(path.join(ws, 'repo-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'site', dependencies: { next: '15.0.0', react: '19.0.0' } }));
    for (const [f, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), body);
    }
    return dir;
  };
  const layout = (robots: string) =>
    `export const metadata = { title: 'Jane Doe', description: 'Site', ${robots} };\nexport default function RootLayout({ children }) { return <html lang="en"><body>{children}</body></html>; }\n`;
  const pageSrc = (extra = '') => `export const metadata = { title: 'Home', description: 'Home page'${extra} };\nexport default function Page() { return <h1>Home</h1>; }\n`;

  it('a noindex root layout makes its routes noindex: no canonical.missing, and the summary says why nothing is indexable', () => {
    const { report } = auditRepository(repo({ 'app/layout.tsx': layout('robots: { index: false, follow: true }'), 'app/page.tsx': pageSrc() }));
    const ids = report.findings.map((f) => f.ruleId);
    expect(ids).not.toContain('canonical.missing');
    expect(report.findings.find((f) => f.ruleId === 'index.noindex')?.evidence[0]?.observed).toMatch(/inherited from a layout/);
    expect(indexableSummary(report)).toBe('0 indexable: all noindex');
    expect(summaryText(report, [])).toMatch(/1 routes\/pages, 0 indexable: all noindex/);
  });

  it('a page that sets its own robots overrides the layout', () => {
    const { report } = auditRepository(repo({ 'app/layout.tsx': layout('robots: { index: false }'), 'app/page.tsx': pageSrc(", robots: { index: true }") }));
    const ids = report.findings.map((f) => f.ruleId);
    expect(ids).toContain('canonical.missing');
    expect(ids).not.toContain('index.noindex');
    expect(indexableSummary(report)).toBe('1 indexable');
  });
});
