import zlib from 'node:zlib';

/**
 * Minimal, read-only ZIP reader for user-supplied exports (Search Console "Download CSV" produces a ZIP).
 * Entries are returned in memory and never written to disk, so path traversal in entry names is harmless;
 * names are still reported verbatim only as basenames. Defensive limits guard against zip bombs.
 * Supported: stored (0) and deflate (8) entries. Not supported: ZIP64, encryption, multi-disk archives.
 */
export interface ZipEntry {
  name: string;
  data: Buffer;
}

export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

const DEFAULT_LIMITS: ZipLimits = { maxEntries: 64, maxEntryBytes: 64 * 1024 * 1024, maxTotalBytes: 128 * 1024 * 1024 };

export function isZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50;
}

export function readZip(buf: Buffer, limits: Partial<ZipLimits> = {}): ZipEntry[] {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  // End of central directory: signature 0x06054b50, within the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 0xffff - 22); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported');
  if (count > lim.maxEntries) throw new Error(`ZIP has ${count} entries (limit ${lim.maxEntries})`);
  if (cdOffset + cdSize > buf.length) throw new Error('Corrupt ZIP: central directory outside the file');
  const entries: ZipEntry[] = [];
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt ZIP: bad central directory entry');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // directory
    if (flags & 0x1) throw new Error(`Encrypted ZIP entries are not supported (${name})`);
    if (size > lim.maxEntryBytes) throw new Error(`ZIP entry ${name} is too large (${size} bytes)`);
    total += size;
    if (total > lim.maxTotalBytes) throw new Error('ZIP content exceeds the size limit');
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`Corrupt ZIP: bad local header for ${name}`);
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const raw = buf.subarray(start, start + compSize);
    if (raw.length !== compSize) throw new Error(`Corrupt ZIP: truncated entry ${name}`);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: lim.maxEntryBytes });
    else throw new Error(`Unsupported ZIP compression method ${method} (${name})`);
    if (data.length !== size) throw new Error(`Corrupt ZIP: size mismatch for ${name}`);
    entries.push({ name, data });
  }
  return entries;
}
