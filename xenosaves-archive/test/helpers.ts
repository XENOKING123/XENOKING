import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yazl from 'yazl';

export function tmpDir(prefix = 'xsa-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface ZipEntry {
  name: string;
  data: Buffer | string;
  mode?: number;
  compress?: boolean;
}

export async function makeZip(entries: ZipEntry[]): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const e of entries) {
    zip.addBuffer(Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data), e.name, { mode: e.mode, compress: e.compress ?? true, mtime: new Date('2024-01-01T00:00:00Z') });
  }
  zip.end();
  const chunks: Buffer[] = [];
  for await (const c of zip.outputStream as any) chunks.push(c);
  return Buffer.concat(chunks);
}

/** Replace a same-length filename everywhere in a zip (to craft names yazl refuses, e.g. "../"). */
export function patchZipName(zip: Buffer, from: string, to: string): Buffer {
  if (from.length !== to.length) throw new Error('names must be the same length');
  const out = Buffer.from(zip);
  const f = Buffer.from(from);
  let i = out.indexOf(f);
  while (i >= 0) {
    Buffer.from(to).copy(out, i);
    i = out.indexOf(f, i + 1);
  }
  return out;
}

/** Build a minimal valid PARAM.SFO */
export function makeSfo(fields: Record<string, string | number>): Buffer {
  const keys = Object.keys(fields).sort();
  const keyTable: Buffer[] = [];
  const dataTable: Buffer[] = [];
  const index: Buffer[] = [];
  let keyOff = 0;
  let dataOff = 0;
  for (const k of keys) {
    const v = fields[k];
    const kb = Buffer.from(k + '\0', 'latin1');
    let db: Buffer;
    let fmt: number;
    let len: number;
    if (typeof v === 'number') {
      db = Buffer.alloc(4);
      db.writeUInt32LE(v);
      fmt = 0x0404;
      len = 4;
    } else {
      const s = Buffer.from(v + '\0', 'utf8');
      const max = Math.ceil(s.length / 4) * 4;
      db = Buffer.alloc(max);
      s.copy(db);
      fmt = 0x0204;
      len = s.length;
    }
    const ie = Buffer.alloc(16);
    ie.writeUInt16LE(keyOff, 0);
    ie.writeUInt16LE(fmt, 2);
    ie.writeUInt32LE(len, 4);
    ie.writeUInt32LE(db.length, 8);
    ie.writeUInt32LE(dataOff, 12);
    index.push(ie);
    keyTable.push(kb);
    dataTable.push(db);
    keyOff += kb.length;
    dataOff += db.length;
  }
  let keys0 = Buffer.concat(keyTable);
  const pad = (4 - (keys0.length % 4)) % 4;
  keys0 = Buffer.concat([keys0, Buffer.alloc(pad)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46535000, 0);
  header.writeUInt32LE(0x0101, 4);
  const keyStart = 20 + index.length * 16;
  header.writeUInt32LE(keyStart, 8);
  header.writeUInt32LE(keyStart + keys0.length, 12);
  header.writeUInt32LE(keys.length, 16);
  return Buffer.concat([header, ...index, keys0, ...dataTable]);
}

export async function goodSaveZip(title = 'Bloodborne', titleId = 'CUSA00207', payload = 'save-data-'): Promise<Buffer> {
  return makeZip([
    { name: `${titleId}/SPRJ0005/sce_sys/param.sfo`, data: makeSfo({ TITLE_ID: titleId, MAINTITLE: title, SUBTITLE: 'NG+2', ACCOUNT_ID: 'deadbeefcafebabe', SAVEDATA_BLOCKS: 1024 }) },
    { name: `${titleId}/SPRJ0005/userdata0000`, data: Buffer.from(payload.repeat(5000)) },
  ]);
}
