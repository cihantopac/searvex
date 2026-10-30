/**
 * Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). Returns rows keyed by header.
 * The delimiter is detected from the header line (`,`, `;` or tab) unless given: spreadsheet programs in
 * many locales save CSV with `;`.
 */
export function parseCsv(text: string, delimiter?: string): Record<string, string>[] {
  return tableToRecords(parseCsvTable(text, delimiter));
}

/** Parse into raw rows (first row = header), skipping blank lines. */
export function parseCsvTable(text: string, delimiter?: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const sep = delimiter ?? detectDelimiter(src);
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim()));
}

function tableToRecords(rows: string[][]): Record<string, string>[] {
  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ''])));
}

/** Count candidate delimiters outside quotes on the first line. */
export function detectDelimiter(text: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const c of text) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === '\n' || c === '\r')) break;
    else if (!quoted && c in counts) counts[c]!++;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]!;
  return best[1] > 0 ? best[0] : ',';
}

/** Decode a text file honouring UTF-8/UTF-16 byte-order marks (Excel "Unicode text" is UTF-16LE). */
export function decodeText(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return buf.toString('utf8').replace(/^﻿/, '');
}
