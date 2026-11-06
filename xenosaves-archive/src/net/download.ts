import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { classifyStatus, FetchFailure, type HttpClient } from './http.js';
import { parseRetryAfter } from './ratelimit.js';

export interface DownloadResult {
  bytes: number;
  resumed: boolean;
  finalUrl: string;
  contentType: string;
  contentDispositionFilename?: string;
}

export interface DownloadOptions {
  url: string;
  dest: string;                 // final path; data accumulates in `${dest}.part`
  maxBytes: number;
  expectedSize?: number | null;
  headers?: Record<string, string>;
  expectBinary?: boolean;       // treat an HTML answer as an access interstitial
  signal?: AbortSignal;
  onProgress?: (bytes: number, total: number | null) => void;
}

export function filenameFromContentDisposition(h: string | null): string | undefined {
  if (!h) return undefined;
  const star = h.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fallthrough */
    }
  }
  const plain = h.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain ? plain[1].trim() : undefined;
}

/**
 * Streams a file to disk. Resumes from an existing .part file with an HTTP Range request when the
 * server supports it (206 + matching Content-Range); otherwise restarts from zero.
 * Never exceeds maxBytes. Classifies failures so the worker can retry or stop.
 */
export async function downloadToFile(http: HttpClient, o: DownloadOptions): Promise<DownloadResult> {
  const part = `${o.dest}.part`;
  let offset = 0;
  try {
    offset = (await fsp.stat(part)).size;
  } catch {
    offset = 0;
  }
  if (o.expectedSize != null && offset > o.expectedSize) {
    await fsp.rm(part, { force: true });
    offset = 0;
  }
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (offset > 0) headers.range = `bytes=${offset}-`;

  const { res, finalUrl, release } = await http.request(o.url, { headers, signal: o.signal });
  try {
    if (res.status === 416 && offset > 0) {
      await res.body?.cancel().catch(() => {});
      // Range not satisfiable: the part file may already be complete.
      if (o.expectedSize != null && offset === o.expectedSize) {
        await fsp.rename(part, o.dest);
        return { bytes: offset, resumed: true, finalUrl, contentType: '' };
      }
      await fsp.rm(part, { force: true });
      throw new FetchFailure('transient', 'range not satisfiable; restarting download from zero', 416, 0);
    }
    const kind = classifyStatus(res.status);
    if (kind) {
      await res.body?.cancel().catch(() => {});
      throw new FetchFailure(kind, `HTTP ${res.status} from ${new URL(finalUrl).host}`, res.status, parseRetryAfter(res.headers.get('retry-after')));
    }
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    if (o.expectBinary !== false && contentType.startsWith('text/html')) {
      await res.body?.cancel().catch(() => {});
      throw new FetchFailure(
        'restricted',
        'host answered with an HTML page instead of the file (login, captcha, quota, password or removed file) — not bypassed',
        res.status,
      );
    }

    let resumed = false;
    let append = false;
    if (res.status === 206 && offset > 0) {
      const cr = res.headers.get('content-range') ?? '';
      const m = cr.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/);
      if (m && Number(m[1]) === offset) {
        resumed = true;
        append = true;
      } else {
        await res.body?.cancel().catch(() => {});
        await fsp.rm(part, { force: true });
        throw new FetchFailure('transient', `unexpected Content-Range "${cr}" on resume; restarting`, 206, 0);
      }
    } else {
      offset = 0;
    }

    const lenHeader = res.headers.get('content-length');
    const remaining = lenHeader != null ? Number(lenHeader) : null;
    const total = remaining != null ? offset + remaining : o.expectedSize ?? null;
    if (total != null && total > o.maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new FetchFailure('too-large', `file is ${total} bytes, above the ${o.maxBytes} byte limit`);
    }
    if (o.expectedSize != null && total != null && total !== o.expectedSize) {
      await res.body?.cancel().catch(() => {});
      throw new FetchFailure('invalid', `server reports ${total} bytes but source lists ${o.expectedSize}`);
    }

    const out = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
    let bytes = offset;
    let lastTick = 0;
    try {
      for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
        bytes += chunk.byteLength;
        if (bytes > o.maxBytes) throw new FetchFailure('too-large', `download exceeded ${o.maxBytes} bytes`);
        if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
        const now = Date.now();
        if (o.onProgress && now - lastTick > 1000) {
          lastTick = now;
          o.onProgress(bytes, total);
        }
      }
    } catch (err) {
      await new Promise<void>((r) => out.end(() => r()));
      if (err instanceof FetchFailure) throw err;
      // connection dropped mid-body: keep the .part file so the next attempt can resume
      throw new FetchFailure('transient', `transfer interrupted at ${bytes} bytes: ${(err as Error).message}`);
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
    if (remaining != null && bytes !== offset + remaining) {
      throw new FetchFailure('transient', `short read: got ${bytes} of ${offset + remaining} bytes`);
    }
    o.onProgress?.(bytes, total);
    await fsp.rename(part, o.dest);
    return {
      bytes,
      resumed,
      finalUrl,
      contentType,
      contentDispositionFilename: filenameFromContentDisposition(res.headers.get('content-disposition')),
    };
  } finally {
    release();
  }
}
