import type { Readable } from 'node:stream';
import type { Config } from '../config.js';
import { LocalStorage } from './local.js';
import { S3Storage } from './s3.js';

export interface ObjectInfo {
  key: string;
  size: number;
  lastModified?: Date;
  metadata?: Record<string, string>;
}

export interface PutOptions {
  sha256: string;
  size: number;
  contentType?: string;
}

export interface ObjectStorage {
  readonly driver: string;
  putFile(key: string, filePath: string, opts: PutOptions): Promise<void>;
  head(key: string): Promise<ObjectInfo | null>;
  getStream(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  list(prefix: string): AsyncIterable<ObjectInfo>;
  signedDownloadUrl(key: string, opts: { filename: string; ttlSeconds: number }): Promise<string>;
}

/** Content-addressed key for a stored archive. Folder-style layouts are a virtual export view only. */
export function blobKey(sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('invalid sha256');
  return `blobs/sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

export function quarantineKey(sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('invalid sha256');
  return `quarantine/sha256/${sha256}`;
}

export function createStorage(cfg: Config): ObjectStorage {
  if (cfg.storage.driver === 's3') return new S3Storage(cfg);
  return new LocalStorage(cfg);
}

export async function withRetries<T>(fn: () => Promise<T>, attempts = 4, baseMs = 500): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, baseMs * 2 ** i + Math.random() * baseMs));
    }
  }
  throw lastErr;
}
