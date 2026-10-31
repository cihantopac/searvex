import fs from 'node:fs';
import path from 'node:path';
import { decodeText, parseCsvTable } from './csv.js';
import { isZip, readZip } from './zip.js';

/**
 * Import of Search Console "Performance → Export → Download CSV" files, without any Google account
 * access. The export is a ZIP with one CSV per report tab (queries, pages, countries, devices, search
 * appearance, dates) plus a filters file; users may also pass the individual CSVs.
 *
 * Tables are recognised by their headers (localised to the Search Console UI language), not by file
 * name. English and Turkish headers are the primary targets; German, French, Spanish, Italian, Portuguese
 * and Dutch synonyms are best-effort until confirmed with real exports. Numbers may use a decimal comma.
 *
 * Limits of the export (reported to the user): queries and pages come as separate tables, so query → page
 * mapping is impossible; each table holds at most the rows the UI shows (1,000).
 */
export type GscTable = 'queries' | 'pages' | 'countries' | 'devices' | 'appearance' | 'dates';

export interface DimRow {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscExport {
  files: string[];
  tables: Partial<Record<GscTable, DimRow[]>>;
  filters: Array<{ name: string; value: string }>;
  searchType?: string;
  dateLabel?: string;
  period: { startDate?: string; endDate?: string; days?: number };
  warnings: string[];
}

export class GscImportError extends Error {}

const UI_ROW_LIMIT = 1000;

const norm = (s: string) =>
  s
    .replace(/^﻿/, '')
    .trim()
    .toLocaleLowerCase('tr')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i')
    .replace(/\s+/g, ' ');

/** Header synonyms (normalised: lower case, no diacritics). */
const METRICS: Record<'clicks' | 'impressions' | 'ctr' | 'position', string[]> = {
  clicks: ['clicks', 'click', 'tiklamalar', 'tiklama', 'klicks', 'clics', 'clic', 'cliques', 'klikken'],
  impressions: ['impressions', 'impression', 'gosterimler', 'gosterim', 'impressionen', 'impresiones', 'impressioni', 'impressoes', 'vertoningen'],
  ctr: ['ctr', 'to', 'tiklama orani', 'to (tiklama orani)', 'average ctr', 'ortalama to'],
  position: ['position', 'average position', 'konum', 'ortalama konum', 'pozisyon', 'ortalama pozisyon', 'posicion', 'posizione', 'posicao', 'positie', 'durchschnittliche position'],
};

const KEYS: Array<[GscTable | 'filters', RegExp]> = [
  ['queries', /quer|sorgu|suchanfrage|requete|consulta|zoekopdracht|ricerca/],
  ['pages', /^(top )?pages?$|sayfa|seite|pagina|^pages les|^page$/],
  ['countries', /countr|ulke|^land|pays|^pais|paese|^pa[ií]s/],
  ['devices', /device|cihaz|gerat|appareil|dispositiv|apparaat/],
  ['appearance', /appearance|gorunum|darstellung|apparence|aspecto|aspetto|weergave/],
  ['dates', /^date$|^dates$|tarih|^datum|^fecha|^data$/],
  ['filters', /^filters?$|^filtre|^filtro|^filtres?$/],
];

function metricIndex(header: string[]): Partial<Record<keyof typeof METRICS, number>> {
  const out: Partial<Record<keyof typeof METRICS, number>> = {};
  header.forEach((h, i) => {
    const n = norm(h);
    for (const [k, syn] of Object.entries(METRICS) as Array<[keyof typeof METRICS, string[]]>) if (out[k] === undefined && syn.includes(n)) out[k] = i;
  });
  return out;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DOT_DATE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;

function toIsoDate(s: string): string | null {
  const t = s.trim();
  if (ISO_DATE.test(t)) return t;
  const m = DOT_DATE.exec(t);
  return m ? `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}` : null;
}

function identifyKey(header: string, values: string[], fileName: string): GscTable | 'filters' | null {
  const n = norm(header);
  for (const [t, re] of KEYS) if (re.test(n)) return t;
  // Fall back to the values, then to the file name.
  const sample = values.slice(0, 20).filter((v) => v.trim());
  if (sample.length && sample.every((v) => /^https?:\/\//i.test(v.trim()))) return 'pages';
  if (sample.length && sample.every((v) => toIsoDate(v))) return 'dates';
  const f = norm(path.basename(fileName, path.extname(fileName)));
  for (const [t, re] of KEYS) if (re.test(f)) return t;
  return null;
}

/**
 * Decimal comma when the fractional columns (CTR, position) use commas and never dots, e.g. "12,3" or
 * "%3,5". Integer columns then use dots or spaces as thousands separators.
 */
function usesDecimalComma(rows: string[][], cols: number[]): boolean {
  let comma = 0;
  let dot = 0;
  for (const r of rows.slice(0, 200))
    for (const c of cols) {
      const v = (r[c] ?? '').replace(/[%\s ]/g, '');
      if (/^\d+,\d+$/.test(v)) comma++;
      if (/^\d+\.\d+$/.test(v)) dot++;
    }
  return comma > 0 && dot === 0;
}

export function parseLocaleNumber(raw: string, decimalComma: boolean): number | null {
  let v = raw.replace(/[\s  %]/g, '');
  if (v === '' || v === '-' || v === '—') return null;
  v = decimalComma ? v.replace(/\./g, '').replace(',', '.') : v.replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(v)) return null;
  return Number(v);
}

interface ParsedTable {
  kind: GscTable | 'filters';
  rows: DimRow[];
  filters: Array<{ name: string; value: string }>;
  warnings: string[];
}

export function parseGscTable(text: string, fileName: string): ParsedTable | null {
  const table = parseCsvTable(text);
  const [header, ...body] = table;
  if (!header || !header.length) return null;
  const kind = identifyKey(header[0]!, body.map((r) => r[0] ?? ''), fileName);
  if (!kind) return null;
  const base = path.basename(fileName);
  if (kind === 'filters') return { kind, rows: [], filters: body.map((r) => ({ name: (r[0] ?? '').trim(), value: (r[1] ?? '').trim() })).filter((f) => f.name), warnings: [] };
  const warnings: string[] = [];
  let idx = metricIndex(header);
  if (idx.clicks === undefined || idx.impressions === undefined) {
    // Search Console tables are always: key, clicks, impressions, CTR, position.
    if (header.length === 5) {
      idx = { clicks: 1, impressions: 2, ctr: 3, position: 4 };
      warnings.push(`${base}: column names not recognised (${header.join(', ')}); assumed the Search Console order key, clicks, impressions, CTR, position.`);
    } else throw new GscImportError(`${base}: could not find clicks and impressions columns in: ${header.join(', ')}`);
  }
  const decimalComma = usesDecimalComma(body, [idx.ctr, idx.position].filter((x): x is number => x !== undefined));
  const rows: DimRow[] = [];
  let bad = 0;
  for (const r of body) {
    const key = (r[0] ?? '').trim();
    const clicks = parseLocaleNumber(r[idx.clicks!] ?? '', decimalComma);
    const impressions = parseLocaleNumber(r[idx.impressions!] ?? '', decimalComma);
    const position = idx.position !== undefined ? parseLocaleNumber(r[idx.position] ?? '', decimalComma) : null;
    if (!key || clicks === null || impressions === null || clicks < 0 || impressions < 0) {
      bad++;
      continue;
    }
    // CTR is recomputed from clicks/impressions: exports differ in percent formatting, and the ratio is exact.
    rows.push({ key: kind === 'dates' ? (toIsoDate(key) ?? key) : key, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: position ?? 0 });
  }
  if (bad) {
    if (bad > Math.max(2, body.length * 0.1)) throw new GscImportError(`${base}: ${bad} of ${body.length} rows have unreadable numbers; is this a Search Console performance export?`);
    warnings.push(`${base}: skipped ${bad} row(s) with unreadable values.`);
  }
  if (idx.position === undefined) warnings.push(`${base}: no position column; positions are not measured for this table.`);
  if ((kind === 'queries' || kind === 'pages') && rows.length >= UI_ROW_LIMIT) warnings.push(`${base}: ${rows.length} rows — the Search Console UI exports at most ${UI_ROW_LIMIT} rows per table, so this table is probably truncated. The API ("Google ile bağlan" / gsc auth) has no such limit.`);
  return { kind, rows, filters: [], warnings };
}

const FILTER_SEARCH_TYPE = /search type|arama turu|suchtyp|type de recherche|tipo de busqueda|tipo di ricerca/;
const FILTER_DATE = /^date$|^tarih|zeitraum|^datum|^periode|^fecha|^intervallo|^data$/;
const FILTER_SUBSET = /quer|sorgu|suchanfrage|requete|consulta|page|sayfa|seite|pagina|countr|ulke|land|pays|pais|device|cihaz|gerat|appareil|dispositiv|appearance|gorunum/;

/** Read files (ZIP or CSV) into one export. Throws GscImportError with actionable messages. */
export function importGscFiles(files: string[]): GscExport {
  const out: GscExport = { files: [], tables: {}, filters: [], period: {}, warnings: [] };
  const inputs: Array<{ name: string; text: string }> = [];
  for (const file of files) {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(file);
    } catch (e) {
      throw new GscImportError(`Cannot read ${file}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
    out.files.push(path.basename(file));
    if (isZip(buf)) {
      for (const entry of readZip(buf)) if (/\.(csv|tsv|txt)$/i.test(entry.name)) inputs.push({ name: entry.name, text: decodeText(entry.data) });
    } else inputs.push({ name: file, text: decodeText(buf) });
  }
  const unknown: string[] = [];
  for (const { name, text } of inputs) {
    const t = parseGscTable(text, name);
    if (!t) {
      unknown.push(path.basename(name));
      continue;
    }
    out.warnings.push(...t.warnings);
    if (t.kind === 'filters') out.filters.push(...t.filters);
    else if (out.tables[t.kind]) out.warnings.push(`${path.basename(name)}: a second ${t.kind} table was ignored.`);
    else out.tables[t.kind] = t.rows;
  }
  if (!Object.keys(out.tables).length) {
    throw new GscImportError(
      `No Search Console performance table found in ${out.files.join(', ')}${unknown.length ? ` (unrecognised: ${unknown.join(', ')})` : ''}. ` +
        'Export it from Search Console → Performance → Export → Download CSV, and pass the ZIP or the CSV files.',
    );
  }
  if (unknown.length) out.warnings.push(`Ignored files that are not Search Console tables: ${unknown.join(', ')}.`);
  for (const f of out.filters) {
    const n = norm(f.name);
    if (FILTER_SEARCH_TYPE.test(n)) out.searchType = f.value;
    else if (FILTER_DATE.test(n)) out.dateLabel = f.value;
    else if (FILTER_SUBSET.test(n)) out.warnings.push(`The export is filtered (${f.name}: ${f.value}); all figures cover only that subset.`);
  }
  const dates = (out.tables.dates ?? []).map((d) => d.key).filter((d) => ISO_DATE.test(d)).sort();
  if (dates.length) {
    const startDate = dates[0]!;
    const endDate = dates.at(-1)!;
    out.period = { startDate, endDate, days: Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86400000) + 1 };
  }
  return out;
}
