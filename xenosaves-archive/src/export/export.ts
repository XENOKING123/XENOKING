import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import yazl from 'yazl';
import type { Db } from '../db/pool.js';
import type { ObjectStorage } from '../storage/index.js';
import { catalogCsv, catalogRows, type CatalogFilter } from './catalog.js';
import { friendlySaveName, gameFolderName } from './naming.js';

/**
 * Chunked, resumable, checksum-verified export of the stored collection into a virtual layout:
 *   PS4/CUSA00207-Bloodborne/<record-id>_<original filename>  + metadata.json per game
 *   catalog.json / catalog.csv / export-manifest.json at the top level.
 * Archives are written STORED (no recompression). Chunks are capped (default 2 GiB) — no giant single ZIP.
 */
export interface ExportOptions {
  outDir: string;
  filter: CatalogFilter;
  chunkBytes?: number;
  format?: 'zip' | 'dir';
  prefix?: string;
}

interface ManifestFile {
  path: string;
  sha256: string;
  size: number;
  record_ids: number[];
  storage_key: string;
}
interface ManifestChunk {
  name: string;
  files: ManifestFile[];
  metadata: Record<string, unknown[]>;
  status: 'pending' | 'complete';
  bytes?: number;
  sha256?: string;
}
interface Manifest {
  created_at: string;
  filter: CatalogFilter;
  format: 'zip' | 'dir';
  chunk_bytes: number;
  total_files: number;
  total_bytes: number;
  chunks: ManifestChunk[];
}

export { slug } from './naming.js';

async function sha256File(p: string): Promise<string> {
  const h = crypto.createHash('sha256');
  for await (const c of fs.createReadStream(p)) h.update(c as Buffer);
  return h.digest('hex');
}

export async function planExport(db: Db, opts: ExportOptions): Promise<{ manifest: Manifest; rows: any[] }> {
  const rows = await catalogRows(db, opts.filter);
  const chunkBytes = opts.chunkBytes ?? 2 * 1024 ** 3;
  // One file per (game folder, blob); credits for every record sharing it.
  const byKey = new Map<string, ManifestFile & { folder: string }>();
  const metaByFolder = new Map<string, unknown[]>();
  for (const r of rows) {
    const folder = gameFolderName(r);
    const k = `${folder}|${r.sha256}`;
    const { storage_key, ...pub } = r;
    metaByFolder.set(folder, [...(metaByFolder.get(folder) ?? []), pub]);
    const existing = byKey.get(k);
    if (existing) {
      existing.record_ids.push(r.id);
      continue;
    }
    const fname = friendlySaveName(r);
    byKey.set(k, { folder, path: `${folder}/${fname}`, sha256: r.sha256, size: Number(r.file_size), record_ids: [r.id], storage_key });
  }
  const files = [...byKey.values()];
  const chunks: ManifestChunk[] = [];
  let cur: ManifestChunk | null = null;
  let curBytes = 0;
  for (const f of files) {
    if (!cur || (curBytes + f.size > chunkBytes && cur.files.length)) {
      cur = { name: `${opts.prefix ?? 'xenosaves-archive'}-part-${String(chunks.length + 1).padStart(4, '0')}`, files: [], metadata: {}, status: 'pending' };
      chunks.push(cur);
      curBytes = 0;
    }
    const { folder, ...mf } = f;
    cur.files.push(mf);
    cur.metadata[folder] = metaByFolder.get(folder) ?? [];
    curBytes += f.size;
  }
  return {
    manifest: {
      created_at: new Date().toISOString(),
      filter: opts.filter,
      format: opts.format ?? 'zip',
      chunk_bytes: chunkBytes,
      total_files: files.length,
      total_bytes: files.reduce((a, f) => a + f.size, 0),
      chunks,
    },
    rows,
  };
}

export async function runExport(db: Db, storage: ObjectStorage, opts: ExportOptions, onLog: (m: string) => void = () => {}) {
  await fsp.mkdir(opts.outDir, { recursive: true });
  const manifestPath = path.join(opts.outDir, 'export-manifest.json');
  const { manifest: fresh, rows } = await planExport(db, opts);
  let manifest = fresh;
  // Resume: keep completed chunks from a previous run with the same filter/format/chunk size.
  try {
    const prev: Manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
    if (JSON.stringify(prev.filter) === JSON.stringify(fresh.filter) && prev.format === fresh.format && prev.chunk_bytes === fresh.chunk_bytes) {
      for (const c of fresh.chunks) {
        const old = prev.chunks.find((p) => p.name === c.name && JSON.stringify(p.files.map((f) => f.sha256)) === JSON.stringify(c.files.map((f) => f.sha256)));
        if (old?.status === 'complete') Object.assign(c, { status: 'complete', bytes: old.bytes, sha256: old.sha256 });
      }
      manifest = fresh;
    }
  } catch {
    /* no previous manifest */
  }
  const save = () => fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await save();
  const pub = rows.map(({ storage_key, ...r }) => r);
  await fsp.writeFile(path.join(opts.outDir, 'catalog.json'), JSON.stringify(pub, null, 2));
  await fsp.writeFile(path.join(opts.outDir, 'catalog.csv'), catalogCsv(pub));

  for (const chunk of manifest.chunks) {
    if (chunk.status === 'complete') {
      const p = path.join(opts.outDir, manifest.format === 'zip' ? `${chunk.name}.zip` : chunk.name);
      if (manifest.format === 'dir' || (fs.existsSync(p) && (await sha256File(p)) === chunk.sha256)) {
        onLog(`skip ${chunk.name} (already complete)`);
        continue;
      }
      chunk.status = 'pending';
    }
    onLog(`writing ${chunk.name} (${chunk.files.length} files)`);
    if (manifest.format === 'dir') await writeDirChunk(storage, opts.outDir, chunk);
    else await writeZipChunk(storage, opts.outDir, chunk);
    chunk.status = 'complete';
    await save();
  }
  return manifest;
}

async function writeDirChunk(storage: ObjectStorage, outDir: string, chunk: ManifestChunk) {
  for (const f of chunk.files) {
    const dest = path.join(outDir, f.path);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest) && (await sha256File(dest)) === f.sha256) continue;
    await pipeline(await storage.getStream(f.storage_key), fs.createWriteStream(`${dest}.part`));
    const got = await sha256File(`${dest}.part`);
    if (got !== f.sha256) throw new Error(`checksum mismatch exporting ${f.path}: ${got} != ${f.sha256}`);
    await fsp.rename(`${dest}.part`, dest);
  }
  for (const [folder, meta] of Object.entries(chunk.metadata)) {
    await fsp.writeFile(path.join(outDir, folder, 'metadata.json'), JSON.stringify(meta, null, 2));
  }
}

async function writeZipChunk(storage: ObjectStorage, outDir: string, chunk: ManifestChunk) {
  const finalPath = path.join(outDir, `${chunk.name}.zip`);
  const tmp = `${finalPath}.part`;
  const zip = new yazl.ZipFile();
  const done = pipeline(zip.outputStream, fs.createWriteStream(tmp));
  for (const f of chunk.files) {
    zip.addReadStream(await storage.getStream(f.storage_key), f.path, { compress: false, size: f.size } as any);
  }
  for (const [folder, meta] of Object.entries(chunk.metadata)) {
    zip.addBuffer(Buffer.from(JSON.stringify(meta, null, 2)), `${folder}/metadata.json`);
  }
  zip.end();
  await done;
  // Verify every archive inside the chunk against its SHA-256 before marking it complete.
  await verifyZipChunk(tmp, chunk);
  await fsp.rename(tmp, finalPath);
  chunk.bytes = (await fsp.stat(finalPath)).size;
  chunk.sha256 = await sha256File(finalPath);
}

export async function verifyZipChunk(zipPath: string, chunk: { files: Array<{ path: string; sha256: string }> }): Promise<void> {
  const expected = new Map(chunk.files.map((f) => [f.path, f.sha256]));
  const seen = new Set<string>();
  const zf: yauzl.ZipFile = await new Promise((res, rej) => yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (e, z) => (e || !z ? rej(e) : res(z))));
  try {
    await new Promise<void>((resolve, reject) => {
      zf.on('error', reject);
      zf.on('end', () => resolve());
      zf.on('entry', (entry: yauzl.Entry) => {
        const want = expected.get(entry.fileName);
        if (!want) return zf.readEntry();
        zf.openReadStream(entry, async (err, s) => {
          if (err || !s) return reject(err);
          const h = crypto.createHash('sha256');
          for await (const c of s) h.update(c as Buffer);
          const got = h.digest('hex');
          if (got !== want) return reject(new Error(`export verification failed for ${entry.fileName}`));
          seen.add(entry.fileName);
          zf.readEntry();
        });
      });
      zf.readEntry();
    });
  } finally {
    zf.close();
  }
  if (seen.size !== expected.size) throw new Error(`export chunk missing ${expected.size - seen.size} files`);
}
