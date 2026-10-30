import zlib from 'node:zlib';
import { RunStore } from '../../src/crawl/store.js';

/** Minimal stored website audit for `host` with the given paths. */
export function writeAudit(ws: string, runId: string, startUrl: string, urls: string[], mode: 'website' | 'repository' = 'website'): void {
  const store = new RunStore(ws, runId);
  store.writeJson('report.json', { mode, target: startUrl, runId, crawl: { startUrl }, inventory: { pages: urls.map((url) => ({ url, indexable: true })) }, findings: [] });
}

/** Build a ZIP (CRC fields left at 0: the reader does not need them). */
export function makeZip(files: Array<{ name: string; text: string | Buffer; deflate?: boolean; flags?: number }>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const data = Buffer.isBuffer(f.text) ? f.text : Buffer.from(f.text, 'utf8');
    const comp = f.deflate === false ? data : zlib.deflateRawSync(data);
    const method = f.deflate === false ? 0 : 8;
    const name = Buffer.from(f.name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x800 | (f.flags ?? 0), 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x800 | (f.flags ?? 0), 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
