/**
 * PARAM.SFO parser (PS3/PS4/PS5 save metadata). Pure data parsing; never executes anything.
 * Fields that identify a person's account (ACCOUNT_ID, USER_ID) are dropped.
 */
const DROP = new Set(['ACCOUNT_ID', 'USER_ID', 'PARAMS', 'PARAMS2', 'SAVEDATA_LIST_PARAM']);

export function parseSfo(buf: Buffer): Record<string, string | number> | null {
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46535000) return null; // "\0PSF"
  const keyTable = buf.readUInt32LE(8);
  const dataTable = buf.readUInt32LE(12);
  const count = buf.readUInt32LE(16);
  if (count > 512 || keyTable > buf.length || dataTable > buf.length) return null;
  const out: Record<string, string | number> = {};
  for (let i = 0; i < count; i++) {
    const base = 20 + i * 16;
    if (base + 16 > buf.length) return null;
    const keyOff = buf.readUInt16LE(base);
    const fmt = buf.readUInt16LE(base + 2);
    const len = buf.readUInt32LE(base + 4);
    const dataOff = buf.readUInt32LE(base + 12);
    const kStart = keyTable + keyOff;
    if (kStart >= buf.length) return null;
    let kEnd = buf.indexOf(0, kStart);
    if (kEnd < 0) kEnd = buf.length;
    const key = buf.toString('latin1', kStart, kEnd);
    if (!/^[A-Z0-9_]{1,64}$/.test(key) || DROP.has(key)) continue;
    const dStart = dataTable + dataOff;
    if (dStart + len > buf.length) continue;
    if (fmt === 0x0404 && len >= 4) {
      out[key] = buf.readUInt32LE(dStart);
    } else if (fmt === 0x0204 || fmt === 0x0004) {
      out[key] = buf.toString('utf8', dStart, dStart + len).split('\0')[0].slice(0, 2048);
    }
  }
  return out;
}
