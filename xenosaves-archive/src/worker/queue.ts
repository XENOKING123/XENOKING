import type { Db } from '../db/pool.js';
import { event } from './events.js';

export interface RecordRow {
  id: number;
  source_id: string;
  source_item_key: string;
  source_page_url: string | null;
  download_url: string | null;
  file_host: string | null;
  platform: string | null;
  game_title: string | null;
  title_id: string | null;
  original_filename: string | null;
  expected_size: number | null;
  expected_hash: string | null;
  status: string;
  redistribution: string;
  attempts: number;
  max_attempts: number;
  raw: Record<string, any>;
}

/**
 * Durable queue on Postgres. Claims use FOR UPDATE SKIP LOCKED so any number of workers can run;
 * a lease (lease_owner + lease_expires_at) marks in-flight work and expires if a worker dies,
 * after which recoverExpiredLeases() puts the record back in the queue.
 * Defence in depth: only QUEUED + redistribution='granted' records from enabled, unpaused,
 * non-blocked/non-external sources can ever be claimed.
 */
export async function claimRecords(db: Db, workerId: string, limit: number, leaseSeconds: number): Promise<RecordRow[]> {
  if (limit <= 0) return [];
  const { rows } = await db.query<RecordRow>(
    `update save_records r
        set status = 'DOWNLOADING', lease_owner = $1, lease_expires_at = now() + make_interval(secs => $3),
            attempts = r.attempts + 1, bytes_downloaded = 0, status_reason = null, updated_at = now()
      where r.id in (
        select r2.id from save_records r2
          join sources s on s.id = r2.source_id
         where r2.status = 'QUEUED'
           and r2.redistribution = 'granted'
           and (r2.next_attempt_at is null or r2.next_attempt_at <= now())
           and s.enabled and not s.paused
           and s.policy in ('MIRROR_ALLOWED', 'PERMISSION_REQUIRED')
         order by r2.next_attempt_at nulls first, r2.id
         limit $2
         for update of r2 skip locked)
      returning r.*`,
    [workerId, limit, leaseSeconds],
  );
  return rows;
}

export async function extendLeases(db: Db, workerId: string, ids: number[], leaseSeconds: number): Promise<void> {
  if (!ids.length) return;
  await db.query(
    `update save_records set lease_expires_at = now() + make_interval(secs => $3)
      where lease_owner = $1 and id = any($2::bigint[]) and status in ('DOWNLOADING','VERIFYING')`,
    [workerId, ids, leaseSeconds],
  );
}

export async function recoverExpiredLeases(db: Db): Promise<number> {
  const { rows } = await db.query(
    `update save_records set status = 'QUEUED', lease_owner = null, lease_expires_at = null,
            status_reason = 'worker lease expired — requeued', updated_at = now()
      where status in ('DOWNLOADING','VERIFYING') and lease_expires_at < now()
      returning id`,
  );
  for (const r of rows) await event(db, { recordId: r.id, level: 'warn', event: 'lease-expired', message: 'requeued after worker stopped responding' });
  return rows.length;
}

/** On graceful shutdown: hand unfinished records back without counting an attempt. */
export async function releaseLeases(db: Db, workerId: string): Promise<number> {
  const { rowCount } = await db.query(
    `update save_records set status = 'QUEUED', lease_owner = null, lease_expires_at = null,
            attempts = greatest(attempts - 1, 0), status_reason = 'worker shut down — requeued', updated_at = now()
      where lease_owner = $1 and status in ('DOWNLOADING','VERIFYING')`,
    [workerId],
  );
  return rowCount ?? 0;
}

export async function setProgress(db: Db, id: number, bytes: number, total: number | null): Promise<void> {
  await db.query('update save_records set bytes_downloaded = $2, bytes_total = $3 where id = $1', [id, bytes, total]);
}

export async function setStatus(db: Db, id: number, status: string, fields: Record<string, unknown> = {}): Promise<void> {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 3}`);
  await db.query(
    `update save_records set status = $2, updated_at = now()${sets.length ? ', ' + sets.join(', ') : ''} where id = $1`,
    [id, status, ...keys.map((k) => fields[k])],
  );
}
