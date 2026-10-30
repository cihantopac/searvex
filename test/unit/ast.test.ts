import { describe, expect, it } from 'vitest';
import { jsxAnchorsWithoutHref, jsxImagesWithoutAlt, nextMetadata, parseSource } from '../../src/repo/ast.js';
import { anchorsWithoutHref, imgWithoutAlt } from '../../src/repo/scan.js';

const meta = (src: string, file = 'app/page.tsx') => nextMetadata(parseSource(src, file)!);

describe('Next.js metadata (AST)', () => {
  it('reads a literal metadata export, including TS wrappers', () => {
    expect(meta(`import type { Metadata } from 'next';
      export const metadata: Metadata = { title: 'Pricing', description: 'Plans', alternates: { canonical: '/pricing' } } satisfies Metadata;`))
      .toMatchObject({ exported: true, title: true, description: true, canonical: true, noindex: false });
  });

  it('ignores title keys in unrelated objects (regex false negative)', () => {
    const src = `const features = [{ title: 'Fast' }, { title: 'Safe' }];
      export const metadata = { description: 'Our product' };
      export default function Page() { return <ul>{features.map((f) => <li key={f.title}>{f.title}</li>)}</ul>; }`;
    expect(meta(src).title).toBe(false);
  });

  it('follows generateMetadata return statements and local objects', () => {
    expect(meta(`export async function generateMetadata({ params }) {
        const post = await getPost(params.slug);
        if (!post) return { title: 'Not found', robots: { index: false } };
        return { title: post.title, description: post.summary };
      }`)).toMatchObject({ title: true, description: null, noindex: null });
    expect(meta(`const base = { title: 'Docs', description: 'd' }; export const metadata = base;`)).toMatchObject({ title: true, description: true });
    expect(meta(`export const generateMetadata = () => ({ title: 'x' });`)).toMatchObject({ title: true, description: false });
    // notFound()/redirect() throw: those branches return no metadata (real-world: Vercel Commerce).
    expect(meta(`export async function generateMetadata() {
        const p = await get(); if (!p) return notFound();
        return { title: p.title, robots: { index: p.visible } };
      }`)).toMatchObject({ title: true, canonical: false, noindex: null });
  });

  it('treats spreads and computed values as unknown, empty values as missing', () => {
    expect(meta(`export const metadata = { ...shared, description: 'd' };`).title).toBeNull();
    expect(meta(`export const metadata = makeMetadata('Pricing');`).title).toBeNull();
    expect(meta(`export const metadata = { title: '', description: undefined };`)).toMatchObject({ title: false, description: false });
  });

  it('reads robots noindex in object and string form', () => {
    expect(meta(`export const metadata = { robots: { index: false, follow: true } };`).noindex).toBe(true);
    expect(meta(`export const metadata = { robots: 'noindex, nofollow' };`).noindex).toBe(true);
    expect(meta(`export const metadata = { robots: { index: true } };`).noindex).toBe(false);
  });

  it('reports no export when there is none', () => {
    expect(meta(`export default function Page() { return null }`).exported).toBe(false);
  });
});

describe('JSX elements (AST vs regex)', () => {
  const src = `export function Card({ img, ...rest }) {
  return (
    <div>
      <img src={img} onClick={() => open(img)} alt="Product photo" />
      <Image src={img} {...rest} />
      <img src="/x.png" />
      <a onClick={() => go()}>More</a>
      <a href={url}>Docs</a>
      <a href="#">Top</a>
    </div>
  );
}`;
  const ast = parseSource(src, 'Card.tsx')!;

  it('handles arrow functions inside attributes, spreads and computed hrefs', () => {
    expect(jsxImagesWithoutAlt(ast)).toEqual([6]);
    expect(jsxAnchorsWithoutHref(ast)).toEqual([7, 9]);
  });

  it('documents the regex false positive the AST removes', () => {
    // The regex stops at the ">" of "=>" and misses the alt attribute after it.
    expect(imgWithoutAlt(src)).toContain(4);
    expect(anchorsWithoutHref(src)).toContain(7);
  });

  it('returns null for unparseable input so callers can fall back to regexes', () => {
    expect(parseSource('function (', 'x.tsx')).toBeNull();
    expect(parseSource('<div><span></div>', 'x.tsx')).toBeNull();
  });

  it('parses .ts type assertions without JSX and .js files with JSX', () => {
    expect(parseSource('const x = <string>y;', 'a.ts')).not.toBeNull();
    expect(parseSource('export default () => <img src="a" />;', 'a.js')).not.toBeNull();
  });
});
