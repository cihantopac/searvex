import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { auditRepository } from '../../src/repo/audit.js';
import { pageNeverRenders, parseSource } from '../../src/repo/ast.js';
import { md } from '../../src/report/markdown.js';

const dirs: string[] = [];
const repo = (files: Record<string, string>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-never-'));
  dirs.push(dir);
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  return dir;
};
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const never = (src: string) => pageNeverRenders(parseSource(src, 'page.tsx')!);

describe('pages that never render (Frameva feedback 2026-11-12)', () => {
  it('an unconditional notFound() / redirect() in the default export', () => {
    expect(never(`import { notFound } from 'next/navigation';\nexport default function CatchAll() { notFound(); }`)).toBe(true);
    expect(never(`export default async function P() { const s = await getSession(); redirect('/login'); }`)).toBe(true);
    expect(never(`const P = () => notFound();\nexport default P;`)).toBe(true);
    expect(never(`export default function P() { return permanentRedirect('/new'); }`)).toBe(true);
  });

  it('a conditional call, or a return before it, can still render', () => {
    expect(never(`export default function P({ params }) { if (!params.slug) notFound(); return <main />; }`)).toBe(false);
    expect(never(`export default function P({ ok }) { if (ok) { return <main />; } notFound(); }`)).toBe(false);
    expect(never(`export default function P() { return <main />; }`)).toBe(false);
    expect(never(`export const metadata = {}; export function helper() { notFound(); }`)).toBe(false);
  });

  it('the route is not indexable and gets no metadata findings; the title list stays readable', () => {
    const pages: Record<string, string> = {};
    for (const s of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) pages[`app/[locale]/${s}/page.tsx`] = `export default function P() { return <h1>${s}</h1>; }`;
    const dir = repo({
      'package.json': JSON.stringify({ dependencies: { next: '15.0.0', react: '19.0.0' } }),
      'app/[locale]/layout.tsx': `export const metadata = { title: 'Acme', description: 'Acme app' };\nexport default function L({ children }) { return <html lang="en"><body>{children}</body></html>; }`,
      'app/[locale]/[...rest]/page.tsx': `import { notFound } from 'next/navigation';\nexport default function CatchAll() { notFound(); }`,
      ...pages,
    });
    const { report, scan } = auditRepository(dir);
    expect(scan.routes.find((r) => r.file.includes('[...rest]'))).toMatchObject({ noindex: true });
    const files = report.findings.flatMap((f) => f.evidence.map((e) => `${f.ruleId} ${e.file ?? ''} ${e.observed ?? ''}`));
    expect(files.filter((l) => l.includes('[...rest]'))).toEqual([]);
    const dup = report.findings.find((f) => f.ruleId === 'duplicate.title')!;
    expect(dup.evidence[0]!.observed).toMatch(/^10 routes inherit/);
    expect(dup.evidence[0]!.observed).toMatch(/\(\+2 more\)$/);
    expect(dup.evidence[0]!.observed).not.toMatch(/page\.tsx/);
  });

  it('report.md marks cut text with an ellipsis', () => {
    expect(md('x'.repeat(400))).toBe('x'.repeat(299) + '…');
    expect(md('short')).toBe('short');
  });
});
