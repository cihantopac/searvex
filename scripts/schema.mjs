#!/usr/bin/env node
/**
 * Generate the published JSON Schemas (`schema/*.schema.json`) from the TypeScript types exported by
 * `src/contract.ts`, with the TypeScript compiler API (no extra dependency).
 *
 *   node scripts/schema.mjs           write schema/report|events|error.schema.json
 *   node scripts/schema.mjs --check   exit 1 when the committed files are out of date
 *
 * Supported type shapes (the report is plain data): primitives, literals, unions, arrays, tuples, interfaces,
 * object literals, intersections, index signatures (Record) and named types (emitted once under
 * `definitions`). Anything else (functions, classes with methods) is an error, so a non-serialisable field cannot
 * slip into the contract.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'src', 'contract.ts');
const SRC = path.join(ROOT, 'src') + path.sep;
const BASE_ID = 'https://raw.githubusercontent.com/cihantopac/searvex/main/schema/';

export const SCHEMAS = [
  { name: 'report', type: 'AuditReport', title: 'Searvex report.json', description: 'An audit report (website or repository mode) as written to report.json and printed by --json.' },
  { name: 'events', type: 'ProgressEvent', title: 'Searvex progress event', description: 'One line of --progress ndjson output on stderr.' },
  { name: 'error', type: 'ErrorOutput', title: 'Searvex error object', description: 'The JSON error line written on stderr with --json or --progress ndjson.' },
];

/**
 * Build every schema. `strict: true` adds `additionalProperties: false` to object types without an index
 * signature: the tests validate against it to catch fields the types do not declare. The published schemas
 * are not strict, so a consumer of schema 1.0 accepts a 1.x report with new optional fields.
 */
export function generateSchemas({ strict = false } = {}) {
  const program = ts.createProgram([ENTRY], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    types: ['node'],
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(ENTRY);
  if (!source) throw new Error(`Cannot read ${ENTRY}`);
  const exports = checker.getExportsOfModule(checker.getSymbolAtLocation(source));
  const versionSym = exports.find((s) => s.name === 'SCHEMA_VERSION');
  const versionType = checker.getTypeOfSymbolAtLocation(versionSym, source);
  const version = versionType.isStringLiteral() ? versionType.value : null;
  if (!version) throw new Error('SCHEMA_VERSION must be a string literal');

  const out = {};
  for (const spec of SCHEMAS) {
    const sym = exports.find((s) => s.name === spec.type);
    if (!sym) throw new Error(`src/contract.ts does not export ${spec.type}`);
    const target = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
    const definitions = {};
    const names = new Map();
    const root = convert(checker, checker.getDeclaredTypeOfSymbol(target), { definitions, names, strict, path: spec.type, top: true });
    out[spec.name] = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: `${BASE_ID}${spec.name}.schema.json`,
      title: spec.title,
      description: `${spec.description} Schema version ${version} (see docs/schema.md).`,
      'x-searvex-schema-version': version,
      ...root,
      definitions: sortKeys(definitions),
    };
  }
  return { version, schemas: out };
}

function sortKeys(o) {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

function docOf(checker, sym) {
  const text = ts.displayPartsToString(sym.getDocumentationComment(checker)).trim();
  return text ? text.replace(/\s+/g, ' ') : undefined;
}

/** Named type declared in src/ (interfaces and type aliases), or null for anonymous and library types. */
function namedSymbol(type) {
  const sym = type.aliasSymbol ?? (type.flags & ts.TypeFlags.Object && type.objectFlags & ts.ObjectFlags.Interface ? type.symbol : undefined);
  if (!sym || type.aliasTypeArguments?.length) return null;
  const decl = sym.declarations?.[0];
  if (!decl || !path.resolve(decl.getSourceFile().fileName).startsWith(SRC)) return null;
  return sym;
}

function convert(checker, type, ctx) {
  const named = ctx.top ? null : namedSymbol(type);
  if (named) {
    let name = ctx.names.get(named);
    if (!name) {
      name = named.name;
      let i = 2;
      const used = new Set(ctx.names.values());
      while (used.has(name)) name = `${named.name}${i++}`;
      ctx.names.set(named, name);
      ctx.definitions[name] = {}; // placeholder for recursion
      const body = convertInline(checker, type, { ...ctx, path: name });
      const doc = docOf(checker, named);
      ctx.definitions[name] = doc && !body.description ? { description: doc, ...body } : body;
    }
    return { $ref: `#/definitions/${name}` };
  }
  return convertInline(checker, type, { ...ctx, top: false });
}

function convertInline(checker, type, ctx) {
  const f = type.flags;
  if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return {};
  if (f & ts.TypeFlags.String) return { type: 'string' };
  if (f & ts.TypeFlags.Number) return { type: 'number' };
  if (f & ts.TypeFlags.Boolean) return { type: 'boolean' };
  if (f & ts.TypeFlags.Null) return { type: 'null' };
  if (f & ts.TypeFlags.StringLiteral) return { type: 'string', const: type.value };
  if (f & ts.TypeFlags.NumberLiteral) return { type: 'number', const: type.value };
  if (f & ts.TypeFlags.BooleanLiteral) return { type: 'boolean', const: type.intrinsicName === 'true' };
  if (type.isUnion()) return convertUnion(checker, type, ctx);
  if (checker.isTupleType(type)) {
    const items = checker.getTypeArguments(type).map((t, i) => convert(checker, t, { ...ctx, path: `${ctx.path}[${i}]` }));
    return { type: 'array', items, minItems: items.length, maxItems: items.length };
  }
  if (checker.isArrayType(type)) return { type: 'array', items: convert(checker, checker.getTypeArguments(type)[0], { ...ctx, path: `${ctx.path}[]` }) };
  if (f & ts.TypeFlags.Object || type.isIntersection()) return convertObject(checker, type, ctx);
  throw new Error(`Unsupported type at ${ctx.path}: ${checker.typeToString(type)}`);
}

function convertUnion(checker, type, ctx) {
  const parts = type.types.filter((t) => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)));
  const bools = parts.filter((t) => t.flags & ts.TypeFlags.BooleanLiteral);
  const rest = parts.filter((t) => !(t.flags & ts.TypeFlags.BooleanLiteral));
  const members = bools.length === 2 ? [{ type: 'boolean' }] : bools.map((t) => convertInline(checker, t, ctx));
  const strings = rest.filter((t) => t.flags & ts.TypeFlags.StringLiteral);
  const others = rest.filter((t) => !(t.flags & ts.TypeFlags.StringLiteral));
  if (strings.length) members.push(strings.length === 1 ? { type: 'string', const: strings[0].value } : { type: 'string', enum: strings.map((t) => t.value).sort() });
  for (const t of others) members.push(convert(checker, t, ctx));
  if (members.length === 1) return members[0];
  // `T | null` stays readable as a type list when both sides are plain.
  const simple = members.every((m) => Object.keys(m).length === 1 && typeof m.type === 'string');
  return simple ? { type: members.map((m) => m.type) } : { anyOf: members };
}

function convertObject(checker, type, ctx) {
  if (type.getCallSignatures().length || type.getConstructSignatures().length) throw new Error(`Function type at ${ctx.path}: not serialisable`);
  const properties = {};
  const required = [];
  for (const prop of checker.getPropertiesOfType(type)) {
    const decl = prop.valueDeclaration ?? prop.declarations?.[0];
    const propType = decl ? checker.getTypeOfSymbolAtLocation(prop, decl) : checker.getTypeOfSymbol(prop);
    if (propType.getCallSignatures().length) throw new Error(`Method ${ctx.path}.${prop.name}: not serialisable`);
    const schema = convert(checker, propType, { ...ctx, path: `${ctx.path}.${prop.name}` });
    const doc = docOf(checker, prop);
    properties[prop.name] = doc ? (schema.$ref ? { description: doc, allOf: [schema] } : { description: doc, ...schema }) : schema;
    if (!(prop.flags & ts.SymbolFlags.Optional)) required.push(prop.name);
  }
  const out = { type: 'object', properties };
  if (required.length) out.required = required;
  const index = checker.getIndexInfosOfType(type).find((i) => i.keyType.flags & (ts.TypeFlags.String | ts.TypeFlags.Number));
  if (index) out.additionalProperties = convert(checker, index.type, { ...ctx, path: `${ctx.path}[key]` });
  else if (ctx.strict) out.additionalProperties = false;
  return out;
}

export function schemaFile(name) {
  return path.join(ROOT, 'schema', `${name}.schema.json`);
}

export function serialise(schema) {
  return JSON.stringify(schema, null, 2) + '\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { schemas } = generateSchemas();
  const check = process.argv.includes('--check');
  let stale = 0;
  fs.mkdirSync(path.join(ROOT, 'schema'), { recursive: true });
  for (const [name, schema] of Object.entries(schemas)) {
    const file = schemaFile(name);
    const text = serialise(schema);
    if (check) {
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) {
        console.error(`schema/${name}.schema.json is out of date: run "node scripts/schema.mjs"`);
        stale++;
      }
    } else fs.writeFileSync(file, text);
  }
  process.exitCode = stale ? 1 : 0;
}
