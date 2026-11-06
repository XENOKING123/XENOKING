import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import yauzl from 'yauzl';
import { parseSfo } from '../metadata/sfo.js';

/**
 * Archive inspection WITHOUT extraction to disk and WITHOUT executing anything.
 *  - ZIP: every entry is stream-decompressed in memory (bounded) so sizes cannot lie;
 *         per-entry SHA-256 feeds a content fingerprint that matches re-packed copies.
 *  - RAR/7z/TAR/GZ: listed and integrity-tested by the 7-Zip CLI (`7z l` / `7z t`), never extracted.
 */

export type ArchiveFormat = 'zip' | 'rar' | '7z' | 'tar' | 'gz' | 'html' | 'unknown';

export interface InspectLimits {
  maxEntries: number;
  maxUncompressedBytes: number;
  maxCompressionRatio: number;
}

export interface EntryInfo {
  path: string;
  size: number;
  packed?: number;
  sha256?: string;
  crc?: string;
}

export interface InspectResult {
  format: ArchiveFormat;
  verdict: 'ok' | 'restricted' | 'quarantine' | 'invalid';
  reasons: string[];
  warnings: string[];
  entryCount: number;
  uncompressedBytes: number;
  fingerprint: string | null;
  entries: EntryInfo[];          // capped listing for the manifest
  sfo: Record<string, string | number> | null;
  sfoPath?: string;
}

const EXEC_EXT = new Set([
  'exe', 'dll', 'scr', 'com', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'msi', 'msp',
  'jar', 'hta', 'cpl', 'lnk', 'reg', 'sh', 'app', 'apk', 'deb', 'rpm', 'dmg', 'elf', 'self', 'sprx', 'prx', 'pkg', 'iso',
]);
const RATIO_RULE_MIN_BYTES = 512 * 1024 * 1024;
const NESTED_EXT = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'cab']);

export async function detectFormat(filePath: string): Promise<ArchiveFormat> {
  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(512);
    const { bytesRead } = await fh.read(buf, 0, 512, 0);
    const b = buf.subarray(0, bytesRead);
    if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && [0x03, 0x05, 0x07].includes(b[2])) return 'zip';
    if (b.length >= 6 && b.subarray(0, 6).toString('latin1') === 'Rar!\x1a\x07') return 'rar';
    if (b.length >= 6 && b.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return '7z';
    if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return 'gz';
    if (b.length >= 262 && b.subarray(257, 262).toString('latin1') === 'ustar') return 'tar';
    const head = b.toString('utf8').trimStart().slice(0, 64).toLowerCase();
    if (head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<head')) return 'html';
    return 'unknown';
  } finally {
    await fh.close();
  }
}

/** Reject traversal, absolute paths, drive letters, NULs and control chars. Returns normalised path or null. */
export function safeEntryPath(name: string): string | null {
  if (!name || name.includes('\0') || /[\x00-\x1f]/.test(name)) return null;
  const n = name.replace(/\\/g, '/');
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.startsWith('//')) return null;
  const parts = n.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) return null;
  return parts.join('/');
}

function ext(p: string): string {
  const base = p.split('/').pop() ?? '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}

export function looksExecutable(head: Buffer): string | null {
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return 'PE/MZ executable header';
  if (head.length >= 4 && head.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return 'ELF executable header';
  if (head.length >= 4 && head.subarray(0, 4).equals(Buffer.from([0x4f, 0x15, 0x3d, 0x1d]))) return 'PlayStation SELF executable header';
  if (head.length >= 4) {
    const m = head.readUInt32BE(0);
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(m)) return 'Mach-O executable header';
  }
  if (head.length >= 2 && head[0] === 0x23 && head[1] === 0x21) return 'script shebang';
  return null;
}

/** Fingerprint of archive *contents*, independent of compression/packing order. */
export function contentFingerprint(entries: EntryInfo[]): string | null {
  const files = entries.filter((e) => !e.path.endsWith('/'));
  if (!files.length) return null;
  // Strip a single shared top-level folder so "Save/x" and "x" match.
  const tops = new Set(files.map((e) => (e.path.includes('/') ? e.path.split('/')[0] : '')));
  const strip = tops.size === 1 && !tops.has('') ? [...tops][0].length + 1 : 0;
  const lines = files
    .map((e) => `${e.path.slice(strip).toLowerCase()}\t${e.size}\t${e.sha256 ?? e.crc ?? ''}`)
    .sort();
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

function emptyResult(format: ArchiveFormat): InspectResult {
  return { format, verdict: 'ok', reasons: [], warnings: [], entryCount: 0, uncompressedBytes: 0, fingerprint: null, entries: [], sfo: null };
}

export async function inspectArchive(filePath: string, limits: InspectLimits, sevenZipPath = '7z'): Promise<InspectResult> {
  const format = await detectFormat(filePath);
  if (format === 'html') {
    return { ...emptyResult(format), verdict: 'restricted', reasons: ['file is an HTML page (login/captcha/quota/interstitial), not an archive'] };
  }
  if (format === 'unknown') {
    return { ...emptyResult(format), verdict: 'invalid', reasons: ['not a recognised archive format (zip/rar/7z/tar/gz)'] };
  }
  if (format === 'zip') return inspectZip(filePath, limits);
  return inspectWith7z(filePath, format, limits, sevenZipPath);
}

function openZip(filePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) =>
    yauzl.open(filePath, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: false, decodeStrings: true }, (err, zf) =>
      err || !zf ? reject(err ?? new Error('zip open failed')) : resolve(zf),
    ),
  );
}

export async function inspectZip(filePath: string, limits: InspectLimits): Promise<InspectResult> {
  const r = emptyResult('zip');
  let zf: yauzl.ZipFile;
  try {
    zf = await openZip(filePath);
  } catch (err) {
    return { ...r, verdict: 'invalid', reasons: [`corrupt zip: ${(err as Error).message}`] };
  }
  const all: EntryInfo[] = [];
  let total = 0;
  const done = new Promise<void>((resolve, reject) => {
    zf.on('error', reject);
    zf.on('end', () => resolve());
    zf.on('entry', (entry: yauzl.Entry) => {
      (async () => {
        r.entryCount++;
        if (r.entryCount > limits.maxEntries) {
          r.verdict = 'quarantine';
          r.reasons.push(`too many entries (> ${limits.maxEntries})`);
          return resolve();
        }
        const safe = safeEntryPath(entry.fileName);
        if (safe === null) {
          r.verdict = 'quarantine';
          r.reasons.push(`unsafe path in archive: ${JSON.stringify(entry.fileName).slice(0, 200)}`);
        }
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (mode === 0o120000) {
          r.verdict = 'quarantine';
          r.reasons.push(`symbolic link in archive: ${entry.fileName.slice(0, 200)}`);
        }
        const isDir = entry.fileName.endsWith('/');
        if (isDir) {
          zf.readEntry();
          return;
        }
        if (entry.generalPurposeBitFlag & 0x1) {
          if (r.verdict === 'ok') r.verdict = 'restricted';
          r.reasons.push('password-protected archive — not bypassed');
          zf.readEntry();
          return;
        }
        const ratio = entry.uncompressedSize / Math.max(1, entry.compressedSize);
        // Sparse save slots (zero-padded) legitimately compress >1000:1, and nothing is ever extracted to disk
        // (actual decompressed bytes are capped below), so the ratio rule only applies to very large entries.
        if (entry.uncompressedSize > RATIO_RULE_MIN_BYTES && ratio > limits.maxCompressionRatio) {
          r.verdict = 'quarantine';
          r.reasons.push(`compression ratio ${Math.round(ratio)}:1 on ${entry.fileName.slice(0, 120)} (zip bomb guard)`);
          return resolve();
        }
        if (total + entry.uncompressedSize > limits.maxUncompressedBytes) {
          r.verdict = 'quarantine';
          r.reasons.push(`declared uncompressed size exceeds ${limits.maxUncompressedBytes} bytes`);
          return resolve();
        }
        const p = safe ?? entry.fileName;
        const e = ext(p);
        if (EXEC_EXT.has(e)) {
          r.verdict = 'quarantine';
          r.reasons.push(`executable/installer file type in archive: ${p.slice(0, 200)}`);
        }
        if (NESTED_EXT.has(e)) r.warnings.push(`nested archive not deep-inspected: ${p.slice(0, 200)}`);
        // stream-decompress (bounded) to hash content and sniff headers
        const stream = await new Promise<NodeJS.ReadableStream>((res, rej) =>
          zf.openReadStream(entry, (err, s) => (err || !s ? rej(err ?? new Error('read failed')) : res(s))),
        );
        const hash = crypto.createHash('sha256');
        let head = Buffer.alloc(0);
        let n = 0;
        const isSfo = /(^|\/)param\.sfo$/i.test(p);
        const sfoChunks: Buffer[] = [];
        for await (const chunk of stream as AsyncIterable<Buffer>) {
          n += chunk.length;
          total += chunk.length;
          if (total > limits.maxUncompressedBytes) {
            r.verdict = 'quarantine';
            r.reasons.push(`actual uncompressed size exceeds ${limits.maxUncompressedBytes} bytes`);
            (stream as any).destroy?.();
            return resolve();
          }
          if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
          if (isSfo && n <= 256 * 1024) sfoChunks.push(chunk);
          hash.update(chunk);
        }
        const exe = looksExecutable(head);
        if (exe) {
          r.verdict = 'quarantine';
          r.reasons.push(`${exe} in ${p.slice(0, 200)}`);
        }
        if (isSfo && !r.sfo) {
          r.sfo = parseSfo(Buffer.concat(sfoChunks));
          if (r.sfo) r.sfoPath = p;
        }
        all.push({ path: p, size: n, packed: entry.compressedSize, sha256: hash.digest('hex') });
        zf.readEntry();
      })().catch(reject);
    });
    zf.readEntry();
  });
  try {
    await done;
  } catch (err) {
    const msg = (err as Error).message;
    if (/invalid relative path|absolute path|invalid characters in fileName/i.test(msg)) {
      // yauzl refuses traversal/absolute names itself — that is a hostile archive, not a corrupt one.
      r.verdict = 'quarantine';
      r.reasons.push(`unsafe path in archive: ${msg.slice(0, 200)}`);
    } else {
      r.verdict = 'invalid';
      r.reasons.push(`corrupt zip: ${msg}`);
    }
  } finally {
    zf.close();
  }
  r.uncompressedBytes = total;
  r.entries = all.slice(0, 2000);
  r.fingerprint = r.verdict === 'ok' ? contentFingerprint(all) : null;
  if (r.verdict === 'ok' && all.length === 0) {
    r.verdict = 'invalid';
    r.reasons.push('archive contains no files');
  }
  return r;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '';
    let stderr = '';
    const cap = 32 * 1024 * 1024;
    child.stdout.on('data', (d) => {
      if (stdout.length < cap) stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < 1024 * 1024) stderr += d.toString('utf8');
    });
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export async function inspectWith7z(filePath: string, format: ArchiveFormat, limits: InspectLimits, sevenZip = '7z'): Promise<InspectResult> {
  const r = emptyResult(format);
  let listing: { code: number; stdout: string; stderr: string };
  try {
    // -p with a fixed non-secret value prevents an interactive prompt; encrypted archives then fail to list
    // and are classified as password-protected. No password guessing is ever attempted.
    listing = await run(sevenZip, ['l', '-slt', '-ba', '-sccUTF-8', '-pXSA_NO_PASSWORD', '--', filePath], 120_000);
  } catch (err) {
    return { ...r, verdict: 'invalid', reasons: [`7-Zip unavailable: ${(err as Error).message}`] };
  }
  const out = listing.stdout + '\n' + listing.stderr;
  if (/Wrong password|Can not open encrypted archive|Cannot open encrypted archive|encrypted/i.test(listing.stderr)) {
    return { ...r, verdict: 'restricted', reasons: ['password-protected archive — not bypassed'] };
  }
  if (listing.code !== 0) {
    return { ...r, verdict: 'invalid', reasons: [`7-Zip could not read archive: ${out.trim().split('\n').slice(-2).join(' ').slice(0, 300)}`] };
  }
  const blocks = listing.stdout.split(/\r?\n\r?\n/).filter((b) => /^Path = /m.test(b));
  const entries: EntryInfo[] = [];
  let total = 0;
  for (const b of blocks) {
    const get = (k: string) => b.match(new RegExp(`^${k} = (.*)$`, 'm'))?.[1]?.trim();
    const path = get('Path') ?? '';
    const folder = get('Folder') === '+';
    const size = Number(get('Size') ?? 0) || 0;
    const packed = Number(get('Packed Size') ?? 0) || 0;
    const attrs = get('Attributes') ?? '';
    r.entryCount++;
    if (get('Encrypted') === '+') {
      if (r.verdict === 'ok') r.verdict = 'restricted';
      r.reasons.push('password-protected archive — not bypassed');
      break;
    }
    const safe = safeEntryPath(path);
    if (safe === null) {
      r.verdict = 'quarantine';
      r.reasons.push(`unsafe path in archive: ${JSON.stringify(path).slice(0, 200)}`);
    }
    if (/(^|\s)l[rwx-]{9}/.test(attrs)) {
      r.verdict = 'quarantine';
      r.reasons.push(`symbolic link in archive: ${path.slice(0, 200)}`);
    }
    if (folder) continue;
    total += size;
    const e = ext(safe ?? path);
    if (EXEC_EXT.has(e)) {
      r.verdict = 'quarantine';
      r.reasons.push(`executable/installer file type in archive: ${path.slice(0, 200)}`);
    }
    if (NESTED_EXT.has(e)) r.warnings.push(`nested archive not deep-inspected: ${path.slice(0, 200)}`);
    if (packed > 0 && size > RATIO_RULE_MIN_BYTES && size / packed > limits.maxCompressionRatio) {
      r.verdict = 'quarantine';
      r.reasons.push(`compression ratio ${Math.round(size / packed)}:1 on ${path.slice(0, 120)} (zip bomb guard)`);
    }
    entries.push({ path: safe ?? path, size, packed, crc: get('CRC') });
  }
  if (r.entryCount > limits.maxEntries) {
    r.verdict = 'quarantine';
    r.reasons.push(`too many entries (> ${limits.maxEntries})`);
  }
  if (total > limits.maxUncompressedBytes) {
    r.verdict = 'quarantine';
    r.reasons.push(`uncompressed size exceeds ${limits.maxUncompressedBytes} bytes`);
  }
  r.uncompressedBytes = total;
  r.entries = entries.slice(0, 2000);
  if (r.verdict === 'ok') {
    // Integrity test (CRC check) decompresses in memory only; nothing is written to disk.
    const t = await run(sevenZip, ['t', '-ba', '-pXSA_NO_PASSWORD', '--', filePath], 600_000);
    if (t.code !== 0) {
      r.verdict = 'invalid';
      r.reasons.push(`archive failed integrity test: ${(t.stdout + t.stderr).trim().split('\n').slice(-2).join(' ').slice(0, 300)}`);
    }
  }
  r.fingerprint = r.verdict === 'ok' ? contentFingerprint(entries) : null;
  if (r.verdict === 'ok' && entries.length === 0) {
    r.verdict = 'invalid';
    r.reasons.push('archive contains no files');
  }
  return r;
}
