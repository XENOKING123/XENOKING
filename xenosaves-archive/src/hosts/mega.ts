import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { FetchFailure } from '../net/http.js';
import type { HostResolver } from './index.js';

/**
 * MEGA public file links (https://mega.nz/file/<id>#<key>) via the megajs client — MEGA's transfer
 * protocol with client-side decryption using the key the uploader published in the link.
 * Transfer-quota errors are honoured by waiting (long retry), never by rotating IPs/accounts.
 * Links without a key or folder links are not fetched.
 */
export function parseMegaLink(u: URL): { kind: 'file' | 'folder'; id: string; key: string } | null {
  let m = u.pathname.match(/^\/(file|folder)\/([A-Za-z0-9_-]+)/);
  if (m && u.hash.length > 1) return { kind: m[1] as 'file' | 'folder', id: m[2], key: u.hash.slice(1).split('/')[0] };
  m = u.hash.match(/^#(F?)!([A-Za-z0-9_-]+)!([A-Za-z0-9_-]+)/); // legacy #!id!key / #F!id!key
  if (m) return { kind: m[1] ? 'folder' : 'file', id: m[2], key: m[3] };
  return null;
}

export const megaResolver: HostResolver = {
  id: 'mega',
  label: 'MEGA public file',
  matches: (u) => /(^|\.)mega\.(nz|co\.nz|io)$/.test(u.hostname),
  async resolve(u) {
    const link = parseMegaLink(u);
    if (!link) throw new FetchFailure('restricted', 'MEGA link has no decryption key — the uploader did not make it public');
    if (link.kind === 'folder') throw new FetchFailure('restricted', 'MEGA folder links must be expanded to file links before queueing');
    return {
      url: u.toString(),
      custom: async (dest, opts) => {
        const { File } = await import('megajs');
        let file: any;
        try {
          file = File.fromURL(u.toString());
          await file.loadAttributes();
        } catch (err) {
          const msg = String((err as Error).message ?? err);
          if (/ENOENT|EBLOCKED|-9|-16/.test(msg)) throw new FetchFailure('dead-link', `MEGA: ${msg}`);
          if (/EKEY|-14/.test(msg)) throw new FetchFailure('restricted', `MEGA: invalid key — ${msg}`);
          throw new FetchFailure('transient', `MEGA: ${msg}`);
        }
        const size = Number(file.size ?? 0);
        if (size > opts.maxBytes) throw new FetchFailure('too-large', `MEGA file is ${size} bytes, above limit`);
        const part = `${dest}.part`;
        const out = fs.createWriteStream(part);
        let bytes = 0;
        try {
          const stream = file.download({});
          for await (const chunk of stream as AsyncIterable<Buffer>) {
            bytes += chunk.length;
            if (bytes > opts.maxBytes) throw new FetchFailure('too-large', 'MEGA download exceeded limit');
            if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
            opts.onProgress?.(bytes, size);
          }
        } catch (err) {
          out.destroy();
          await fsp.rm(part, { force: true });
          if (err instanceof FetchFailure) throw err;
          const msg = String((err as Error).message ?? err);
          if (/EOVERQUOTA|Bandwidth limit|transfer quota|-17/i.test(msg)) {
            throw new FetchFailure('transient', 'MEGA transfer quota reached — waiting for it to reset (not bypassed)', undefined, 6 * 3600_000);
          }
          throw new FetchFailure('transient', `MEGA download failed: ${msg}`);
        }
        await new Promise<void>((r) => out.end(() => r()));
        await fsp.rename(part, dest);
        return { bytes, resumed: false, finalUrl: u.toString(), contentType: 'application/octet-stream', contentDispositionFilename: file.name };
      },
    };
  },
};
