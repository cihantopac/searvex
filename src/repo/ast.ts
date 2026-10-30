import { parse } from '@babel/parser';

/**
 * AST helpers for JavaScript/TypeScript framework sources (Next.js metadata exports, JSX elements).
 * Regexes cannot tell `title:` in `export const metadata` from `title:` in any other object, and they cut
 * JSX tags at the first `>` (e.g. inside `onClick={() => …}`). Results are tri-state: `null` means the
 * value is computed at runtime (spread, variable, function call) and cannot be judged statically.
 */
// Babel's own node types are not a runtime dependency; a structural type is enough for read-only walks.
export interface Node {
  type: string;
  loc?: { start: { line: number } } | null;
  [key: string]: unknown;
}

const JS_EXT = /\.(tsx|jsx|ts|js|mjs|cjs|mts|cts)$/i;

export function isJsSource(file: string): boolean {
  return JS_EXT.test(file);
}

/** Parse a JS/TS/JSX/TSX file; null when the parser gives up (callers fall back to regexes). */
export function parseSource(text: string, file: string): Node | null {
  const ts = /\.(tsx?|mts|cts)$/i.test(file);
  // `.ts` files cannot contain JSX (`<T>x` is a type assertion there); plain `.js` often does (React).
  const jsx = !/\.(ts|mts|cts)$/i.test(file);
  try {
    const ast = parse(text, {
      sourceType: 'unambiguous',
      errorRecovery: true,
      allowReturnOutsideFunction: true,
      plugins: [...(ts ? (['typescript'] as const) : []), ...(jsx ? (['jsx'] as const) : []), 'decorators-legacy'],
    });
    return ast.program as unknown as Node;
  } catch {
    return null;
  }
}

const isNode = (v: unknown): v is Node => !!v && typeof v === 'object' && typeof (v as Node).type === 'string';

/** Depth-first walk over every node; return false from `visit` to skip a subtree. */
export function walkAst(node: Node, visit: (n: Node, parent: Node | null) => boolean | void, parent: Node | null = null): void {
  if (visit(node, parent) === false) return;
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments' || key === 'extra') continue;
    const v = node[key];
    if (Array.isArray(v)) for (const c of v) isNode(c) && walkAst(c, visit, node);
    else if (isNode(v)) walkAst(v, visit, node);
  }
}

/** Strip TS wrappers: `x as Metadata`, `x satisfies Metadata`, `<Metadata>x`, `x!`, parentheses. */
function unwrap(n: Node | null | undefined): Node | null {
  let cur = n ?? null;
  while (cur && ['TSAsExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'TSNonNullExpression', 'ParenthesizedExpression'].includes(cur.type)) cur = cur['expression'] as Node;
  return cur;
}

function keyName(p: Node): string | null {
  if (p['computed']) return null;
  const k = p['key'] as Node | undefined;
  if (!k) return null;
  if (k.type === 'Identifier') return k['name'] as string;
  if (k.type === 'StringLiteral') return k['value'] as string;
  return null;
}

/** Look up a property of an object literal: the value node, `undefined` when absent, `null` when unknowable. */
export function prop(obj: Node, name: string): Node | undefined | null {
  let found: Node | undefined;
  let spread = false;
  for (const p of obj['properties'] as Node[]) {
    if (p.type === 'SpreadElement') {
      spread = true;
      found = undefined; // a later spread may override an earlier key
      continue;
    }
    if ((p.type === 'ObjectProperty' || p.type === 'ObjectMethod') && keyName(p) === name) {
      found = p.type === 'ObjectProperty' ? (p['value'] as Node) : p;
      spread = false;
    }
  }
  if (found) return found;
  return spread ? null : undefined;
}

const isEmptyLiteral = (n: Node) => n.type === 'NullLiteral' || (n.type === 'Identifier' && n['name'] === 'undefined') || (n.type === 'StringLiteral' && !(n['value'] as string).trim());

/** true/false when a key is (not) set to a meaningful value; null when it depends on runtime values. */
function present(obj: Node | null, name: string): boolean | null {
  if (!obj) return null;
  const v = prop(obj, name);
  if (v === null) return null;
  if (v === undefined) return false;
  return !isEmptyLiteral(unwrap(v)!);
}

export interface NextMetadata {
  /** The module exports `metadata` or `generateMetadata`. */
  exported: boolean;
  title: boolean | null;
  description: boolean | null;
  canonical: boolean | null;
  noindex: boolean | null;
  line?: number;
}

const NONE: NextMetadata = { exported: false, title: false, description: false, canonical: false, noindex: false };

/** Top-level `const x = { … }` declarations, to resolve `export const metadata = base`. */
function localObjects(program: Node): Map<string, Node> {
  const m = new Map<string, Node>();
  for (const st of program['body'] as Node[]) {
    const decl = st.type === 'ExportNamedDeclaration' ? (st['declaration'] as Node | null) : st;
    if (decl?.type !== 'VariableDeclaration') continue;
    for (const d of decl['declarations'] as Node[]) {
      const id = d['id'] as Node;
      const init = unwrap(d['init'] as Node | null);
      if (id.type === 'Identifier' && init?.type === 'ObjectExpression') m.set(id['name'] as string, init);
    }
  }
  return m;
}

/** next/navigation helpers that throw instead of returning: `return notFound()` yields no metadata. */
const NEVER_RETURNS = new Set(['notFound', 'redirect', 'permanentRedirect', 'unauthorized', 'forbidden']);

function throwsInstead(n: Node | null | undefined): boolean {
  const u = unwrap(n);
  if (u?.type !== 'CallExpression') return false;
  const callee = u['callee'] as Node;
  return callee.type === 'Identifier' && NEVER_RETURNS.has(callee['name'] as string);
}

/** Object literals a metadata function returns (its own return statements, not nested functions'). */
function returnedObjects(fn: Node, locals: Map<string, Node>): Array<Node | null> {
  const body = fn['body'] as Node;
  if (body.type !== 'BlockStatement') return [resolveObject(body, locals)];
  const out: Array<Node | null> = [];
  walkAst(body, (n) => {
    if (n !== body && /Function|ClassMethod|ObjectMethod/.test(n.type)) return false;
    if (n.type === 'ReturnStatement' && !throwsInstead(n['argument'] as Node | null)) out.push(resolveObject(n['argument'] as Node | null, locals));
  });
  return out;
}

function resolveObject(n: Node | null | undefined, locals: Map<string, Node>): Node | null {
  const u = unwrap(n);
  if (!u) return null;
  if (u.type === 'ObjectExpression') return u;
  if (u.type === 'Identifier') return locals.get(u['name'] as string) ?? null;
  return null;
}

/** Combine several possible return values: a key is set only if every branch sets it. */
function all(objs: Array<Node | null>, f: (o: Node | null) => boolean | null): boolean | null {
  if (!objs.length) return null;
  const vals = objs.map(f);
  if (vals.every((v) => v === true)) return true;
  if (vals.some((v) => v === null)) return null;
  return vals.some((v) => v === true) ? null : false;
}

function canonicalOf(o: Node | null): boolean | null {
  if (!o) return null;
  const alt = prop(o, 'alternates');
  if (alt === null) return null;
  if (alt === undefined) return false;
  const a = unwrap(alt);
  return a?.type === 'ObjectExpression' ? present(a, 'canonical') : null;
}

function noindexOf(o: Node | null): boolean | null {
  if (!o) return null;
  const r = prop(o, 'robots');
  if (r === null) return null;
  if (r === undefined) return false;
  const v = unwrap(r)!;
  if (v.type === 'StringLiteral') return /noindex/i.test(v['value'] as string);
  if (v.type !== 'ObjectExpression') return null;
  const idx = prop(v, 'index');
  if (idx === null) return null;
  if (idx === undefined) return false;
  const iv = unwrap(idx)!;
  return iv.type === 'BooleanLiteral' ? iv['value'] === false : null;
}

/** Read the Next.js App Router metadata export of a page or layout. */
export function nextMetadata(program: Node): NextMetadata {
  const locals = localObjects(program);
  let objs: Array<Node | null> | null = null;
  let line: number | undefined;
  for (const st of program['body'] as Node[]) {
    if (st.type !== 'ExportNamedDeclaration') continue;
    const decl = st['declaration'] as Node | null;
    if (decl?.type === 'VariableDeclaration') {
      for (const d of decl['declarations'] as Node[]) {
        const name = (d['id'] as Node)['name'];
        const init = unwrap(d['init'] as Node | null);
        if (name === 'metadata') objs = [resolveObject(init, locals)];
        else if (name === 'generateMetadata' && init && /FunctionExpression|ArrowFunctionExpression/.test(init.type)) objs = returnedObjects(init, locals);
        else continue;
        line = st.loc?.start.line;
      }
    } else if (decl?.type === 'FunctionDeclaration' && (decl['id'] as Node | null)?.['name'] === 'generateMetadata') {
      objs = returnedObjects(decl, locals);
      line = st.loc?.start.line;
    } else if (!decl) {
      // `export { metadata }` / `export { meta as metadata }`
      for (const s of (st['specifiers'] as Node[] | undefined) ?? []) {
        const exp = s['exported'] as Node;
        if (exp?.['name'] !== 'metadata') continue;
        objs = [locals.get((s['local'] as Node)['name'] as string) ?? null];
        line = st.loc?.start.line;
      }
    }
  }
  if (!objs) return { ...NONE };
  return {
    exported: true,
    title: all(objs, (o) => present(o, 'title')),
    description: all(objs, (o) => present(o, 'description')),
    canonical: all(objs, canonicalOf),
    noindex: all(objs, noindexOf),
    line,
  };
}

export interface JsxTag {
  name: string;
  line: number;
  /** Attribute name → value node (null for boolean attributes such as `<a download>`). */
  attrs: Map<string, Node | null>;
  /** `{...props}` present: any attribute may be set at runtime. */
  spread: boolean;
}

function jsxName(n: Node): string | null {
  if (n.type === 'JSXIdentifier') return n['name'] as string;
  if (n.type === 'JSXMemberExpression') return `${jsxName(n['object'] as Node)}.${jsxName(n['property'] as Node)}`;
  if (n.type === 'JSXNamespacedName') return `${(n['namespace'] as Node)['name']}:${(n['name'] as Node)['name']}`;
  return null;
}

/** Every JSX opening element whose name is in `names`. */
export function jsxTags(program: Node, names: Set<string>): JsxTag[] {
  const out: JsxTag[] = [];
  walkAst(program, (n) => {
    if (n.type !== 'JSXOpeningElement') return;
    const name = jsxName(n['name'] as Node);
    if (!name || !names.has(name)) return;
    const attrs = new Map<string, Node | null>();
    let spread = false;
    for (const a of n['attributes'] as Node[]) {
      if (a.type === 'JSXSpreadAttribute') spread = true;
      else {
        const an = jsxName(a['name'] as Node);
        if (an) attrs.set(an, (a['value'] as Node | null) ?? null);
      }
    }
    out.push({ name, line: n.loc?.start.line ?? 0, attrs, spread });
  });
  return out;
}

/** Static string value of a JSX attribute: `"x"`, `{'x'}`, `` {`x`} ``; null when computed. */
export function attrString(v: Node | null | undefined): string | null {
  if (!v) return null;
  if (v.type === 'StringLiteral') return v['value'] as string;
  if (v.type === 'JSXExpressionContainer') {
    const e = unwrap(v['expression'] as Node);
    if (e?.type === 'StringLiteral') return e['value'] as string;
    if (e?.type === 'TemplateLiteral' && !(e['expressions'] as Node[]).length) return ((e['quasis'] as Node[])[0]!['value'] as { cooked: string }).cooked;
  }
  return null;
}

/** JSX <img>/<Image> without alt (no spread props), by line. */
export function jsxImagesWithoutAlt(program: Node): number[] {
  return jsxTags(program, new Set(['img', 'Image'])).filter((t) => !t.spread && !t.attrs.has('alt')).map((t) => t.line);
}

/** JSX <a> without a crawlable href (missing, `#`, or `javascript:`), by line. */
export function jsxAnchorsWithoutHref(program: Node): number[] {
  return jsxTags(program, new Set(['a']))
    .filter((t) => {
      if (t.spread) return false;
      if (!t.attrs.has('href')) return true;
      const v = attrString(t.attrs.get('href'));
      return v !== null && (v === '#' || /^javascript:/i.test(v.trim()));
    })
    .map((t) => t.line);
}
