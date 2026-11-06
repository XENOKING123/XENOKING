import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import { withTx, type Db } from '../db/pool.js';
import { resolverFor, type HostContext } from '../hosts/index.js';
import { downloadToFile } from '../net/download.js';
import { FetchFailure, type HttpClient } from '../net/http.js';
import { backoffMs } from '../net/ratelimit.js';
import { extractTitleId, platformForTitleId } from '../metadata/titleid.js';
import { blobKey, quarantineKey, type ObjectStorage } from '../storage/index.js';
import { inspectArchive, type InspectResult } from '../verify/archive.js';
import { scanFile, type ScanResult } from '../verify/scan.js';
import { event, pgJson } from './events.js';
import { setProgress, setStatus, type RecordRow } from './queue.js';

export interface PipelineDeps {
  db: Db;
  cfg: Config;
  storage: ObjectStorage;
  http: HttpClient;
  hostCtx: HostContext;
  workerId: string;
}

export interface FileHashes {
  sha256: string;
  sha1: string;
  gitBlobSha1: string;
  size: number;
}

export async function hashFile(filePath: string): Promise<FileHashes> {
  const size = (await fsp.stat(filePath)).size;
  const sha256 = crypto.createHash('sha256');
  const sha1 = crypto.createHash('sha1');
  const git = crypto.createHash('sha1').update(`blob ${size}\0`);
  for await (const chunk of fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 })) {
    sha256.update(chunk as Buffer);
    sha1.update(chunk as Buffer);
    git.update(chunk as Buffer);
  }
  return { sha256: sha256.digest('hex'), sha1: sha1.digest('hex'), gitBlobSha1: git.digest('hex'), size };
}

/** Compare against a hash the source published ("git-blob-sha1:…", "sha1:…", "sha256:…"). */
export function checkExpectedHash(expected: string | null, h: FileHashes): { status: 'match' | 'mismatch' | 'none'; detail?: string } {
  if (!expected) return { status: 'none' };
  const [algo, value] = expected.split(':');
  const v = value?.toLowerCase();
  const got = algo === 'git-blob-sha1' ? h.gitBlobSha1 : algo === 'sha1' ? h.sha1 : algo === 'sha256' ? h.sha256 : null;
  if (!got || !v) return { status: 'none', detail: `unsupported published hash ${algo}` };
  return got === v ? { status: 'match', detail: expected } : { status: 'mismatch', detail: `${algo} expected ${v} got ${got}` };
}

/**
 * Optional official access a site granted for archiving (e.g. an API token). Configured per source as
 *   config.auth = { header: "Authorization", prefix: "Bearer ", env: "TTG_ARCHIVE_TOKEN", hosts: ["www.thetechgame.com"] }
 * The secret lives only in the server environment and is sent only to the listed hosts.
 */
export async function sourceAuthHeaders(db: Db, sourceId: string, url: string): Promise<Record<string, string>> {
  const r = await db.query(`select config->'auth' as auth from sources where id = $1`, [sourceId]);
  const auth = r.rows[0]?.auth as { header?: string; prefix?: string; env?: string; hosts?: string[] } | null;
  if (!auth?.header || !auth.env || !Array.isArray(auth.hosts)) return {};
  const host = new URL(url).hostname.toLowerCase();
  if (!auth.hosts.map((h) => h.toLowerCase()).includes(host)) return {};
  const secret = process.env[auth.env];
  if (!secret || !/^[A-Za-z0-9_-]+$/.test(auth.header)) return {};
  return { [auth.header.toLowerCase()]: `${auth.prefix ?? ''}${secret}` };
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._ ()[\]-]+/g, '_').slice(0, 180) || 'save';
}

/**
 * Process one claimed record end to end. Every exit path leaves the record in a terminal or retryable
 * state with a reason, and removes temp files.
 */
export async function processRecord(deps: PipelineDeps, rec: RecordRow, signal?: AbortSignal): Promise<string> {
  const { db, cfg, storage, http } = deps;
  const dir = path.join(cfg.workDir, String(rec.id));
  await fsp.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'download.bin');
  try {
    if (!rec.download_url) {
      await setStatus(db, rec.id, 'RESTRICTED', { status_reason: 'no download link', lease_owner: null });
      return 'RESTRICTED';
    }

    // 0) Same link already stored by another record → reuse it, never download twice.
    const twin = await db.query(
      `select blob_sha256 from save_records where download_url = $1 and id <> $2 and status = 'STORED' and blob_sha256 is not null limit 1`,
      [rec.download_url, rec.id],
    );
    if (twin.rows[0]) {
      return await linkExistingBlob(deps, rec, twin.rows[0].blob_sha256, 'duplicate-url');
    }

    // 1) Resolve the host link (re-done every attempt: direct URLs from hosts expire)
    await event(db, { recordId: rec.id, sourceId: rec.source_id, event: 'download-start', message: `attempt ${rec.attempts} via ${rec.file_host ?? 'auto'}` });
    const resolver = resolverFor(rec.download_url);
    const resolved = await resolver.resolve(new URL(rec.download_url), deps.hostCtx);
    let lastProgress = 0;
    const onProgress = (bytes: number, total: number | null) => {
      const now = Date.now();
      if (now - lastProgress < 1000) return;
      lastProgress = now;
      setProgress(db, rec.id, bytes, total).catch(() => {});
    };
    const headers = { ...(resolved.headers ?? {}), ...(await sourceAuthHeaders(db, rec.source_id, resolved.url)) };
    const dl = resolved.custom
      ? await resolved.custom(filePath, { maxBytes: cfg.limits.maxDownloadBytes, onProgress })
      : await downloadToFile(http, {
          url: resolved.url,
          dest: filePath,
          headers,
          maxBytes: cfg.limits.maxDownloadBytes,
          expectedSize: rec.expected_size,
          expectBinary: true,
          signal,
          onProgress,
        });
    await setProgress(db, rec.id, dl.bytes, dl.bytes);
    await setStatus(db, rec.id, 'VERIFYING');
    await event(db, { recordId: rec.id, sourceId: rec.source_id, event: 'downloaded', message: `${dl.bytes} bytes${dl.resumed ? ' (resumed)' : ''} from ${new URL(dl.finalUrl).host}` });

    // 2) Hash + size + published-hash verification
    const h = await hashFile(filePath);
    if (rec.expected_size != null && rec.expected_size !== h.size) {
      throw new FetchFailure('invalid', `size mismatch: source lists ${rec.expected_size}, got ${h.size}`);
    }
    const published = checkExpectedHash(rec.expected_hash, h);
    if (published.status === 'mismatch') {
      // Could be a truncated/corrupted transfer — retry rather than store a bad copy.
      await fsp.rm(filePath, { force: true });
      throw new FetchFailure('transient', `published hash mismatch (${published.detail})`);
    }

    // 3) Exact duplicate of a stored file → link, credit both sources, skip upload.
    const existing = await db.query('select sha256 from blobs where sha256 = $1 and deleted_at is null', [h.sha256]);
    if (existing.rows[0]) return await linkExistingBlob(deps, rec, h.sha256, 'duplicate-content');

    // 4) Archive safety + malware scan
    const inspect = await inspectArchive(filePath, {
      maxEntries: cfg.limits.maxEntries,
      maxUncompressedBytes: cfg.limits.maxUncompressedBytes,
      maxCompressionRatio: cfg.limits.maxCompressionRatio,
    });
    if (inspect.verdict === 'restricted') {
      await setStatus(db, rec.id, 'RESTRICTED', { status_reason: inspect.reasons.join('; '), lease_owner: null, lease_expires_at: null });
      await event(db, { recordId: rec.id, sourceId: rec.source_id, level: 'warn', event: 'restricted', message: inspect.reasons.join('; ') });
      return 'RESTRICTED';
    }
    if (inspect.verdict === 'invalid') {
      await setStatus(db, rec.id, 'FAILED', { status_reason: inspect.reasons.join('; '), last_error: inspect.reasons.join('; '), lease_owner: null, lease_expires_at: null });
      await event(db, { recordId: rec.id, sourceId: rec.source_id, level: 'error', event: 'invalid-archive', message: inspect.reasons.join('; ') });
      return 'FAILED';
    }
    const scan: ScanResult = await scanFile(filePath, cfg.clamav);
    const quarantine = inspect.verdict === 'quarantine' || scan.status === 'infected';
    const checks = buildChecks(h, published, inspect, scan, dl.resumed);
    const verified = !quarantine && scan.status === 'clean' && inspect.warnings.length === 0; // published-hash mismatches never reach here
    const key = quarantine ? quarantineKey(h.sha256) : blobKey(h.sha256);

    // 5) Upload (multipart for large files, integrity-verified by the driver)
    if (!(await storage.head(key))) {
      await storage.putFile(key, filePath, { sha256: h.sha256, size: h.size, contentType: contentTypeFor(inspect.format) });
    }
    await event(db, { recordId: rec.id, sourceId: rec.source_id, event: 'uploaded', message: `${key} (${h.size} bytes)` });

    // 6) Metadata + state, atomically
    const sfoTitleId = extractTitleId(String(inspect.sfo?.TITLE_ID ?? '')) ?? null;
    const status = quarantine ? 'QUARANTINED' : 'STORED';
    await withTx(db, async (tx) => {
      await tx.query(
        `insert into blobs (sha256, size_bytes, storage_key, archive_format, entry_count, uncompressed_bytes, content_fingerprint, manifest, sfo, checks, quarantined)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (sha256) do nothing`,
        [
          h.sha256, h.size, key, inspect.format, inspect.entryCount, inspect.uncompressedBytes, inspect.fingerprint,
          pgJson(inspect.entries.slice(0, 500)), inspect.sfo ? pgJson({ ...inspect.sfo, _path: inspect.sfoPath }) : null,
          pgJson(checks), quarantine,
        ],
      );
      await tx.query(
        `update save_records set status = $2, blob_sha256 = $3, verified = $4, downloaded_at = now(), lease_owner = null, lease_expires_at = null,
                status_reason = $5, last_error = null, next_attempt_at = null,
                original_filename = coalesce(original_filename, $6),
                file_format = coalesce(file_format, $7),
                title_id = coalesce(title_id, $8),
                platform = coalesce(platform, $9),
                game_title = coalesce(game_title, $10),
                raw = raw || $11::jsonb,
                updated_at = now()
          where id = $1`,
        [
          rec.id, status, h.sha256, verified,
          quarantine ? [...inspect.reasons, scan.status === 'infected' ? `malware: ${scan.signature}` : ''].filter(Boolean).join('; ') : null,
          dl.contentDispositionFilename ? safeName(dl.contentDispositionFilename) : null,
          inspect.format,
          sfoTitleId,
          platformForTitleId(sfoTitleId),
          inspect.sfo?.MAINTITLE ? String(inspect.sfo.MAINTITLE) : null,
          pgJson({
            metadata_from_param_sfo: inspect.sfo ? Object.keys(inspect.sfo) : [],
            game_title_source: rec.game_title ? 'source' : inspect.sfo?.MAINTITLE ? 'param.sfo MAINTITLE' : null,
          }),
        ],
      );
    });
    await event(db, {
      recordId: rec.id,
      sourceId: rec.source_id,
      level: quarantine ? 'warn' : 'info',
      event: quarantine ? 'quarantined' : 'stored',
      message: `${h.sha256} ${quarantine ? inspect.reasons.join('; ') : verified ? 'verified' : 'stored (verification incomplete: ' + incompleteReasons(published, scan, inspect).join(', ') + ')'}`,
      details: { sha256: h.sha256, size: h.size, checks },
    });
    await maybeAlertStorage(deps);
    return status;
  } catch (err) {
    return await handleFailure(deps, rec, err);
  } finally {
    // Keep .part files only for transient failures (resume); everything else is removed.
    const part = `${filePath}.part`;
    const keepPart = fs.existsSync(part) && (await db.query('select status from save_records where id=$1', [rec.id])).rows[0]?.status === 'QUEUED';
    if (!keepPart) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    else await fsp.rm(filePath, { force: true }).catch(() => {});
  }
}

function incompleteReasons(published: { status: string }, scan: ScanResult, inspect: InspectResult): string[] {
  const out: string[] = [];
  if (scan.status !== 'clean') out.push(`malware scan ${scan.status}${scan.detail ? ` (${scan.detail})` : ''}`);
  if (inspect.warnings.length) out.push(...inspect.warnings);
  if (published.status === 'none') out.push('no source-published hash to compare');
  return out;
}

function buildChecks(h: FileHashes, published: { status: string; detail?: string }, inspect: InspectResult, scan: ScanResult, resumed: boolean) {
  return {
    sha256: h.sha256,
    size_bytes: h.size,
    published_hash: published,
    archive: {
      format: inspect.format,
      verdict: inspect.verdict,
      reasons: inspect.reasons,
      warnings: inspect.warnings,
      entries: inspect.entryCount,
      uncompressed_bytes: inspect.uncompressedBytes,
      checks_run: ['magic-bytes', 'path-traversal', 'symlinks', 'encryption', 'entry-count', 'size/ratio (zip-bomb)', 'executable-types', 'executable-headers', inspect.format === 'zip' ? 'full-decompress-and-hash' : '7z-integrity-test'],
    },
    privacy: { param_sfo_found: Boolean(inspect.sfo), account_fields_dropped_from_metadata: true },
    malware_scan: scan,
    resumed_download: resumed,
    checked_at: new Date().toISOString(),
  };
}

function contentTypeFor(format: string): string {
  return { zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed', gz: 'application/gzip', tar: 'application/x-tar' }[format] ?? 'application/octet-stream';
}

async function linkExistingBlob(deps: PipelineDeps, rec: RecordRow, sha256: string, why: 'duplicate-url' | 'duplicate-content'): Promise<string> {
  const { db } = deps;
  const b = (await db.query('select quarantined, sfo from blobs where sha256 = $1', [sha256])).rows[0];
  // Facts read from the file itself (PARAM.SFO) fill gaps the source left — never overwrite source data.
  const sfoTitleId = extractTitleId(String(b?.sfo?.TITLE_ID ?? '')) ?? null;
  if (b?.sfo) {
    await db.query(
      `update save_records set title_id = coalesce(title_id, $2), platform = coalesce(platform, $3), game_title = coalesce(game_title, $4),
              raw = raw || jsonb_build_object('game_title_source', case when game_title is null and $4::text is not null then 'param.sfo MAINTITLE' else raw->>'game_title_source' end)
        where id = $1`,
      [rec.id, sfoTitleId, platformForTitleId(sfoTitleId), b.sfo.MAINTITLE ? String(b.sfo.MAINTITLE) : null],
    );
  }
  const status = b?.quarantined ? 'QUARANTINED' : 'STORED';
  const verified = (await db.query('select bool_or(verified) as v from save_records where blob_sha256 = $1', [sha256])).rows[0]?.v ?? false;
  await setStatus(db, rec.id, status, {
    blob_sha256: sha256,
    verified,
    downloaded_at: new Date(),
    lease_owner: null,
    lease_expires_at: null,
    status_reason: why === 'duplicate-url' ? 'same link already stored — reused, not downloaded again' : 'identical file already stored — deduplicated',
  });
  await event(db, { recordId: rec.id, sourceId: rec.source_id, event: why, message: `linked to existing blob ${sha256}` });
  return status;
}

async function handleFailure(deps: PipelineDeps, rec: RecordRow, err: unknown): Promise<string> {
  const { db } = deps;
  const f = err instanceof FetchFailure ? err : new FetchFailure('transient', (err as Error)?.message ?? String(err));
  const msg = f.message.slice(0, 2000);
  if (f.kind === 'transient' && rec.attempts < rec.max_attempts) {
    const delay = backoffMs(rec.attempts, { retryAfterMs: f.retryAfterMs, baseMs: deps.cfg.worker.pollMs < 1000 ? 200 : 30_000 });
    await setStatus(db, rec.id, 'QUEUED', {
      last_error: msg,
      status_reason: `retry ${rec.attempts}/${rec.max_attempts} scheduled`,
      next_attempt_at: new Date(Date.now() + delay),
      lease_owner: null,
      lease_expires_at: null,
    });
    await event(db, { recordId: rec.id, sourceId: rec.source_id, level: 'warn', event: 'retry-scheduled', message: `${msg} — retry in ${Math.round(delay / 1000)}s` });
    return 'QUEUED';
  }
  const status = f.kind === 'restricted' ? 'RESTRICTED' : 'FAILED';
  const reason =
    f.kind === 'dead-link' ? `dead link: ${msg}` : f.kind === 'transient' ? `retries exhausted: ${msg}` : f.kind === 'unsafe' ? `unsafe destination blocked: ${msg}` : msg;
  await setStatus(db, rec.id, status, { last_error: msg, status_reason: reason, lease_owner: null, lease_expires_at: null });
  await event(db, { recordId: rec.id, sourceId: rec.source_id, level: status === 'FAILED' ? 'error' : 'warn', event: f.kind, message: reason });
  return status;
}

let lastAlertAt = 0;
async function maybeAlertStorage(deps: PipelineDeps): Promise<void> {
  const { db, cfg } = deps;
  const r = await db.query(
    `select coalesce(sum(size_bytes),0) as used, (select value from settings where key='storage_soft_limit_bytes') as soft
       from blobs where deleted_at is null`,
  );
  const used = Number(r.rows[0].used);
  const soft = Number(r.rows[0].soft);
  if (used < soft || Date.now() - lastAlertAt < 6 * 3600_000) return;
  lastAlertAt = Date.now();
  await event(db, { level: 'warn', event: 'storage-threshold', message: `storage used ${used} bytes ≥ soft limit ${soft}` });
  if (cfg.alertWebhookUrl) {
    await deps.http
      .request(cfg.alertWebhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: `XenoSaves Archive: storage used ${(used / 1024 ** 3).toFixed(1)} GiB ≥ soft limit ${(soft / 1024 ** 3).toFixed(1)} GiB` }),
      })
      .then(async ({ res, release }) => {
        await res.body?.cancel().catch(() => {});
        release();
      })
      .catch(() => {});
  }
}
