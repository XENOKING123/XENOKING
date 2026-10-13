// XENO STORE · Save Data Store · shared ZIP central-directory reader.
//
// Reads the *end* of a zip (the central directory) and lists its entries
// without downloading or inflating the whole archive — enough to check that
// a community save contains what it should and nothing it must not.
// Pure TypeScript, no runtime APIs: shared by the edge functions and unit
// tested from Node.

export interface ZipEntry {
  name: string;
  size: number;        // uncompressed size (or -1 when ZIP64 and unknown here)
  compressed: number;
  isDir: boolean;
}

export interface ZipDirectory {
  entries: ZipEntry[];
  truncated: boolean;  // the tail we got did not contain the whole directory
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const ZIP64_LOC_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const MAX_ENTRIES = 20000;

function u16(b: Uint8Array, o: number): number { return b[o] | (b[o + 1] << 8); }
function u32(b: Uint8Array, o: number): number { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000; }
function u64(b: Uint8Array, o: number): number { return u32(b, o) + u32(b, o + 4) * 0x100000000; }

/**
 * Parse the central directory from the last bytes of a zip file.
 * @param tail      the trailing bytes of the archive (1 MiB is plenty for a save zip)
 * @param tailStart absolute offset of tail[0] inside the file
 */
export function readZipDirectory(tail: Uint8Array, tailStart: number): ZipDirectory {
  const n = tail.length;
  let eocd = -1;
  for (let i = n - 22; i >= 0 && i >= n - 22 - 65535; i--) {
    if (u32(tail, i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');
  let count = u16(tail, eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOffset = u32(tail, eocd + 16);
  // ZIP64: the locator sits right before the EOCD record.
  if ((count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) && eocd >= 20 && u32(tail, eocd - 20) === ZIP64_LOC_SIG) {
    const z64Abs = u64(tail, eocd - 20 + 8);
    const z64 = z64Abs - tailStart;
    if (z64 >= 0 && z64 + 56 <= n && u32(tail, z64) === ZIP64_EOCD_SIG) {
      count = u64(tail, z64 + 32);
      cdSize = u64(tail, z64 + 40);
      cdOffset = u64(tail, z64 + 48);
    }
  }
  const start = cdOffset - tailStart;
  const entries: ZipEntry[] = [];
  if (start < 0 || start > n) return { entries, truncated: true };
  let p = start;
  const end = Math.min(n, start + cdSize);
  const dec = new TextDecoder('utf-8', { fatal: false });
  while (p + 46 <= end && entries.length < MAX_ENTRIES && entries.length < count) {
    if (u32(tail, p) !== CEN_SIG) break;
    const flags = u16(tail, p + 8);
    let compressed = u32(tail, p + 20);
    let size = u32(tail, p + 24);
    const nameLen = u16(tail, p + 28);
    const extraLen = u16(tail, p + 30);
    const commentLen = u16(tail, p + 32);
    const attrs = u32(tail, p + 38);
    if (p + 46 + nameLen + extraLen + commentLen > end) break;
    const rawName = tail.subarray(p + 46, p + 46 + nameLen);
    // bit 11 = UTF-8 names; otherwise treat as latin-1-ish bytes
    const name = (flags & 0x800) ? dec.decode(rawName) : Array.from(rawName, c => String.fromCharCode(c)).join('');
    if (size === 0xffffffff || compressed === 0xffffffff) {
      // ZIP64 extra field 0x0001: uncompressed, compressed (each 8 bytes, present only when needed)
      let e = p + 46 + nameLen;
      const eEnd = e + extraLen;
      while (e + 4 <= eEnd) {
        const id = u16(tail, e), len = u16(tail, e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (size === 0xffffffff && q + 8 <= e + 4 + len) { size = u64(tail, q); q += 8; }
          if (compressed === 0xffffffff && q + 8 <= e + 4 + len) { compressed = u64(tail, q); q += 8; }
          break;
        }
        e += 4 + len;
      }
      if (size === 0xffffffff) size = -1;
      if (compressed === 0xffffffff) compressed = -1;
    }
    const isDir = name.endsWith('/') || ((attrs >>> 16) & 0x4000) !== 0 && size === 0;
    entries.push({ name, size, compressed, isDir });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, truncated: entries.length < count };
}

export const SEALED_KEY_RE = /(^|\/)(sealedkey|sealedkey\.bin|keystone|keystone\.bin|[^/]+\.sealedkey)$/i;
export const RAW_IMAGE_RE = /(^|\/)sdimg_[^/]*$/i;
export const MANIFEST = 'xeno-save.json';

export interface SaveLayout {
  ok: boolean;
  layout: 'xeno' | 'garlic' | 'none';
  reasons: string[];
  dataFiles: number;
  hasManifest: boolean;
  hasParamSfo: boolean;
  hasIcon: boolean;
  totalSize: number;
}

/** Does this entry list look like a shareable decrypted PS5 save? */
export function inspectSaveEntries(entries: ZipEntry[]): SaveLayout {
  const reasons: string[] = [];
  let dataFiles = 0, hasManifest = false, hasParamSfo = false, hasIcon = false, totalSize = 0;
  if (!entries.length) reasons.push('the zip is empty');
  // Garlic and some tools wrap everything in one top-level folder: accept that and strip it.
  let prefix = '';
  const tops = new Set(entries.map(e => e.name.split('/')[0]));
  const top = [...tops][0] || '';
  if (tops.size === 1 && top.toLowerCase() !== 'sce_sys' && entries.every(e => e.name.includes('/'))) prefix = top + '/';
  for (const e of entries) {
    const name = e.name;
    if (name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name) || name.startsWith('\\')) reasons.push(`absolute path inside the zip: ${name}`);
    if (name.split(/[\\/]/).includes('..')) reasons.push(`parent-directory path inside the zip: ${name}`);
    if (SEALED_KEY_RE.test(name)) reasons.push(`sealed key inside the zip: ${name}`);
    if (RAW_IMAGE_RE.test(name)) reasons.push(`raw (sealed) save image inside the zip: ${name}`);
    if (e.isDir) continue;
    if (e.size > 0) totalSize += e.size;
    const rel = name.startsWith(prefix) ? name.slice(prefix.length) : name;
    if (rel === MANIFEST) { hasManifest = true; continue; }
    if (rel === 'xeno-backup.json') { reasons.push('this is a raw console backup (xeno-backup.json), not a shareable save'); continue; }
    if (/^sce_sys\/param\.sfo$/i.test(rel)) { hasParamSfo = true; continue; }
    if (/^sce_sys\/icon0\.png$/i.test(rel)) { hasIcon = true; continue; }
    if (/^sce_sys\//i.test(rel)) continue;
    dataFiles++;
  }
  if (!dataFiles) reasons.push('no save files found at the zip root (expected the decrypted save files, optionally with sce_sys/)');
  const layout: SaveLayout['layout'] = hasManifest ? 'xeno' : dataFiles ? 'garlic' : 'none';
  return { ok: reasons.length === 0, layout, reasons: [...new Set(reasons)], dataFiles, hasManifest, hasParamSfo, hasIcon, totalSize };
}
