import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Config } from '../config.js';
import type { ObjectInfo, ObjectStorage, PutOptions } from './index.js';

/**
 * Filesystem object store for development and single-box deployments.
 * Signed URLs point at the API's /files/:token route, which verifies an HMAC.
 */
export class LocalStorage implements ObjectStorage {
  readonly driver = 'local';
  private root: string;
  constructor(private cfg: Config) {
    this.root = path.resolve(cfg.storage.localDir);
    fs.mkdirSync(this.root, { recursive: true });
  }

  private pathFor(key: string): string {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(this.root + path.sep)) throw new Error('invalid storage key');
    return p;
  }

  async putFile(key: string, filePath: string, opts: PutOptions): Promise<void> {
    const dest = this.pathFor(key);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.uploading-${process.pid}-${Date.now()}`;
    const hash = crypto.createHash('sha256');
    const src = fs.createReadStream(filePath);
    src.on('data', (c) => hash.update(c));
    await pipeline(src, fs.createWriteStream(tmp));
    const got = hash.digest('hex');
    if (got !== opts.sha256) {
      await fsp.rm(tmp, { force: true });
      throw new Error(`integrity check failed while storing ${key}: ${got} != ${opts.sha256}`);
    }
    await fsp.rename(tmp, dest);
    await fsp.writeFile(`${dest}.meta.json`, JSON.stringify({ sha256: opts.sha256, size: opts.size, contentType: opts.contentType }));
  }

  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const st = await fsp.stat(this.pathFor(key));
      let metadata: Record<string, string> | undefined;
      try {
        metadata = JSON.parse(await fsp.readFile(`${this.pathFor(key)}.meta.json`, 'utf8'));
      } catch {
        metadata = undefined;
      }
      return { key, size: st.size, lastModified: st.mtime, metadata };
    } catch {
      return null;
    }
  }

  async getStream(key: string): Promise<Readable> {
    return fs.createReadStream(this.pathFor(key));
  }

  async delete(key: string): Promise<void> {
    await fsp.rm(this.pathFor(key), { force: true });
    await fsp.rm(`${this.pathFor(key)}.meta.json`, { force: true });
  }

  async *list(prefix: string): AsyncIterable<ObjectInfo> {
    const base = this.pathFor(prefix.replace(/\/+$/, '') || '.');
    async function* walk(dir: string, root: string): AsyncIterable<ObjectInfo> {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) yield* walk(full, root);
        else if (!e.name.endsWith('.meta.json') && !e.name.includes('.uploading-')) {
          const st = await fsp.stat(full);
          yield { key: path.relative(root, full).split(path.sep).join('/'), size: st.size, lastModified: st.mtime };
        }
      }
    }
    yield* walk(base, this.root);
  }

  async signedDownloadUrl(key: string, opts: { filename: string; ttlSeconds: number }): Promise<string> {
    const token = signLocalToken(this.cfg.signingSecret, key, opts.filename, Math.floor(Date.now() / 1000) + opts.ttlSeconds);
    return `${this.cfg.publicBaseUrl.replace(/\/$/, '')}/files/${token}`;
  }
}

export function signLocalToken(secret: string, key: string, filename: string, exp: number): string {
  const payload = Buffer.from(JSON.stringify({ k: key, f: filename, e: exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyLocalToken(secret: string, token: string): { key: string; filename: string } | null {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expect = crypto.createHmac('sha256', secret).update(payload).digest();
  let got: Buffer;
  try {
    got = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect)) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof obj.e !== 'number' || obj.e < Math.floor(Date.now() / 1000)) return null;
    return { key: String(obj.k), filename: String(obj.f) };
  } catch {
    return null;
  }
}
