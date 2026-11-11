import { parseFragment } from 'parse5';
import { parseSource, prop, walkAst, type Node } from './ast.js';

/**
 * Parsers for single-file components (plan G5): Vue SFC `<script>` blocks and Astro frontmatter go through the
 * same Babel AST as JS/TS sources; Astro templates through parse5 with source locations; Blade views through a
 * small tokenizer. They replace regexes that matched inside comments, strings and unrelated attributes.
 *
 * `true` / `false` = set / not set; `null` = decided at runtime (spread props, computed arguments): never reported.
 */
export interface PageMeta {
  hasTitle: boolean | null;
  hasDescription: boolean | null;
  noindex: boolean;
}

const HEAD_CALLS = new Set(['useHead', 'useSeoMeta', 'useServerHead', 'useServerSeoMeta', 'definePageMeta']);

const literal = (n: Node | null | undefined): string | null => (n && (n.type === 'StringLiteral' || n.type === 'TemplateLiteral') ? (n.type === 'StringLiteral' ? (n['value'] as string) : ((n['quasis'] as Node[]).map((q) => (q['value'] as { cooked: string }).cooked).join(''))) : null);

/** `true` when a key holds a non-empty value, `false` when absent, `null` when unknowable (spread). */
function has(obj: Node, key: string): boolean | null {
  const v = prop(obj, key);
  if (v === null) return null;
  if (v === undefined) return false;
  const s = literal(v);
  return s === null ? true : s.trim().length > 0;
}

/** `meta: [{ name: 'description', content: … }]` inside useHead. */
function metaEntry(obj: Node, name: string): Node | null {
  const meta = prop(obj, 'meta');
  if (!meta || meta.type !== 'ArrayExpression') return null;
  for (const e of meta['elements'] as Node[]) if (e?.type === 'ObjectExpression' && literal(prop(e, 'name') ?? null)?.toLowerCase() === name) return e;
  return null;
}

const or = (a: boolean | null, b: boolean | null): boolean | null => (a === true || b === true ? true : a === null || b === null ? null : false);

/** Head metadata set from script code (`useHead`, `useSeoMeta`, `definePageMeta`). */
export function scriptHeadMeta(code: string, file: string): PageMeta & { calls: number } {
  const program = parseSource(code, file);
  const out = { hasTitle: false as boolean | null, hasDescription: false as boolean | null, noindex: false, calls: 0 };
  if (!program) return { hasTitle: null, hasDescription: null, noindex: false, calls: 0 };
  walkAst(program, (n) => {
    if (n.type !== 'CallExpression') return;
    const callee = n['callee'] as Node;
    const name = callee.type === 'Identifier' ? (callee['name'] as string) : null;
    if (!name || !HEAD_CALLS.has(name)) return;
    out.calls++;
    const arg = (n['arguments'] as Node[])[0];
    if (!arg || arg.type !== 'ObjectExpression') {
      // A function, variable or computed object: decided at runtime.
      out.hasTitle = or(out.hasTitle, null);
      out.hasDescription = or(out.hasDescription, null);
      return;
    }
    out.hasTitle = or(out.hasTitle, or(has(arg, 'title'), has(arg, 'titleTemplate')));
    const desc = metaEntry(arg, 'description');
    out.hasDescription = or(out.hasDescription, or(has(arg, 'description'), desc ? true : false));
    const robots = literal(prop(arg, 'robots') ?? null) ?? literal(metaEntry(arg, 'robots') ? (prop(metaEntry(arg, 'robots')!, 'content') ?? null) : null);
    if (robots && /noindex/i.test(robots)) out.noindex = true;
  });
  return out;
}

/** Top-level `<script>` blocks of a Vue SFC with their language. */
export function vueScripts(src: string): Array<{ code: string; lang: string }> {
  const out: Array<{ code: string; lang: string }> = [];
  for (const m of src.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const lang = /\blang\s*=\s*["']?(ts|tsx|js|jsx)/i.exec(m[1] ?? '')?.[1]?.toLowerCase() ?? 'js';
    out.push({ code: m[2] ?? '', lang });
  }
  return out;
}

/** Vue SFC page metadata: script head calls, plus Nuxt's `<Title>` / `<Meta>` template components. */
export function vuePageMeta(src: string): PageMeta {
  let meta: PageMeta = { hasTitle: false, hasDescription: false, noindex: false };
  for (const s of vueScripts(src)) {
    const m = scriptHeadMeta(s.code, `component.${s.lang === 'js' ? 'js' : s.lang}`);
    meta = { hasTitle: or(meta.hasTitle, m.hasTitle), hasDescription: or(meta.hasDescription, m.hasDescription), noindex: meta.noindex || m.noindex };
  }
  const template = /<template\b[^>]*>([\s\S]*)<\/template>/i.exec(src)?.[1] ?? '';
  if (/<Title\b/.test(template)) meta.hasTitle = true;
  if (/<Meta\b[^>]*name\s*=\s*["']description["']/i.test(template)) meta.hasDescription = true;
  if (/<Meta\b[^>]*name\s*=\s*["']robots["'][^>]*noindex/i.test(template)) meta.noindex = true;
  return meta;
}

interface P5Node {
  nodeName: string;
  tagName?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: P5Node[];
  content?: P5Node;
  sourceCodeLocation?: { startOffset: number } | null;
}

/** Astro page metadata: frontmatter (YAML for Markdown, TS for .astro) and the template's head and layout props. */
export function astroPageMeta(src: string, file: string): PageMeta {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
  const front = fm?.[1] ?? '';
  const template = fm ? src.slice(fm[0].length) : src;
  if (/\.mdx?$/i.test(file)) {
    return {
      hasTitle: /^title\s*:\s*\S/m.test(front) || /<title\b/i.test(template),
      hasDescription: /^description\s*:\s*\S/m.test(front),
      noindex: /^(robots|noindex)\s*:.*(noindex|true)/m.test(front),
    };
  }
  let hasTitle: boolean | null = false;
  let hasDescription: boolean | null = false;
  let noindex = false;
  const root = parseFragment(template, { sourceCodeLocationInfo: true }) as unknown as P5Node;
  const visit = (n: P5Node) => {
    if (n.tagName) {
      const at = n.sourceCodeLocation?.startOffset;
      // parse5 lower-cases tag names; the source tells a component (<Layout>) from an element (<a>).
      const component = at !== undefined && /^<[A-Z]/.test(template.slice(at, at + 2));
      const attrs = n.attrs ?? [];
      const attr = (name: string) => attrs.find((a) => a.name === name || a.name === `:${name}`);
      if (n.tagName === 'title') hasTitle = true;
      if (n.tagName === 'meta') {
        const name = attr('name')?.value.toLowerCase();
        if (name === 'description') hasDescription = true;
        if (name === 'robots' && /noindex/i.test(attr('content')?.value ?? '')) noindex = true;
      }
      if (component) {
        if (attr('title')) hasTitle = true;
        if (attr('description')) hasDescription = true;
        if (attr('noindex') || /noindex/i.test(attr('robots')?.value ?? '')) noindex = true;
        // `{...post.data}` spread into a layout usually carries the title: unknown, not missing.
        if (attrs.some((a) => a.name.startsWith('{...'))) {
          hasTitle = hasTitle === true ? true : null;
          hasDescription = hasDescription === true ? true : null;
        }
      }
    }
    for (const c of n.childNodes ?? []) visit(c);
    if (n.content) visit(n.content);
  };
  visit(root);
  // Head metadata set in frontmatter code (SEO helpers that receive an object literal).
  if (front) {
    const program = parseSource(front, 'frontmatter.ts');
    if (program)
      walkAst(program, (n) => {
        if (n.type === 'Identifier' && n['name'] === 'Astro') return;
        if (n.type === 'ObjectProperty' && !n['computed'] && (n['key'] as Node)?.type === 'Identifier' && (n['key'] as Node)['name'] === 'noindex' && (n['value'] as Node)?.type === 'BooleanLiteral' && (n['value'] as Node)['value'] === true) noindex = true;
      });
  }
  return { hasTitle, hasDescription, noindex };
}

/** Blade source without comments, `@verbatim` and `@php` blocks: what the view actually renders as markup. */
export function bladeMarkup(src: string): string {
  return src
    .replace(/\{\{--[\s\S]*?--\}\}/g, '')
    .replace(/@verbatim[\s\S]*?@endverbatim/g, '')
    .replace(/@php\b[\s\S]*?@endphp/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

/** Whether a Blade layout renders a `<title>` (outside comments and raw PHP). */
export function bladeHasTitle(src: string): boolean {
  return /<title\b/i.test(bladeMarkup(src));
}
