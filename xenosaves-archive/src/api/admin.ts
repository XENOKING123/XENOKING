import type { FastifyInstance } from 'fastify';
import type { App } from '../app.js';
import { withTx } from '../db/pool.js';
import { log } from '../log.js';
import { RobotsCache } from '../net/robots.js';
import { runDiscovery } from '../sources/runner.js';
import { audit, event } from '../worker/events.js';
import { newApiKey, sha256Hex } from './auth.js';
import { stats } from './queries.js';
import { catalogCsv, catalogRows } from '../export/catalog.js';

const STATUSES = ['DISCOVERED', 'PERMISSION_PENDING', 'QUEUED', 'DOWNLOADING', 'VERIFYING', 'STORED', 'FAILED', 'RESTRICTED', 'QUARANTINED', 'REMOVED'];
const POLICIES = ['MIRROR_ALLOWED', 'PERMISSION_REQUIRED', 'EXTERNAL_ONLY', 'BLOCKED'];

/** Delete a blob from storage once no live record references it (takedowns / removals). */
export async function deleteBlobIfOrphaned(app: App, sha256: string): Promise<boolean> {
  const refs = await app.db.query(`select count(*)::int as n from save_records where blob_sha256 = $1 and status <> 'REMOVED'`, [sha256]);
  if (refs.rows[0].n > 0) return false;
  const b = await app.db.query('select storage_key from blobs where sha256 = $1 and deleted_at is null', [sha256]);
  if (!b.rows[0]) return false;
  await app.storage.delete(b.rows[0].storage_key);
  await app.db.query('update blobs set deleted_at = now() where sha256 = $1', [sha256]);
  return true;
}

export function registerAdminRoutes(r: FastifyInstance, app: App) {
  const { db } = app;
  const actor = () => 'owner';

  r.get('/overview', async () => {
    const s = await stats(db);
    const byStatus = (await db.query(`select status, count(*)::int as n from save_records group by status`)).rows;
    const sources = (
      await db.query(`
        select s.id, s.name, s.kind, s.policy, s.enabled, s.paused, s.license, s.homepage, s.permission_evidence,
               s.last_discovery_at, s.last_discovery_status, s.last_discovery_error, s.last_discovery_stats, s.discovery_interval_minutes,
               coalesce(jsonb_object_agg(x.status, x.n) filter (where x.status is not null), '{}'::jsonb) as counts,
               coalesce(sum(x.bytes),0)::bigint as stored_bytes
          from sources s
          left join (select r.source_id, r.status::text as status, count(*)::int as n, sum(b.size_bytes) as bytes
                       from save_records r left join blobs b on b.sha256 = r.blob_sha256 group by r.source_id, r.status) x on x.source_id = s.id
         group by s.id order by s.id`)
    ).rows;
    const settings = Object.fromEntries((await db.query('select key, value from settings')).rows.map((x) => [x.key, x.value]));
    const workers = (await db.query(`select id, started_at, last_seen, info, last_seen > now() - interval '1 minute' as alive from workers order by last_seen desc limit 20`)).rows;
    const recentEvents = (await db.query(`select e.id, e.at, e.level, e.event, e.message, e.record_id, e.source_id from job_events e order by e.id desc limit 60`)).rows;
    const recentStored = (
      await db.query(`select r.id, r.game_title, r.title_id, r.platform, r.category, r.source_id, r.downloaded_at, r.verified, b.size_bytes
                        from save_records r join blobs b on b.sha256 = r.blob_sha256 where r.status = 'STORED' order by r.downloaded_at desc nulls last limit 25`)
    ).rows;
    const inProgress = (
      await db.query(`select id, source_id, game_title, original_filename, status, bytes_downloaded, bytes_total, lease_owner, attempts
                        from save_records where status in ('DOWNLOADING','VERIFYING') order by updated_at desc limit 50`)
    ).rows;
    return { stats: s, byStatus, sources, settings, workers, recentEvents, recentStored, inProgress };
  });

  r.get('/records', async (req) => {
    const q = req.query as any;
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.status && STATUSES.includes(q.status)) {
      params.push(q.status);
      where.push(`r.status = $${params.length}`);
    }
    if (q.source) {
      params.push(q.source);
      where.push(`r.source_id = $${params.length}`);
    }
    if (q.q) {
      params.push(`%${String(q.q).replace(/[%_\\]/g, '\\$&')}%`);
      where.push(`(r.game_title ilike $${params.length} or r.title_id ilike $${params.length} or r.description ilike $${params.length} or r.source_item_key ilike $${params.length})`);
    }
    const page = Math.max(Number(q.page) || 1, 1);
    const size = Math.min(Math.max(Number(q.page_size) || 50, 1), 500);
    const w = where.length ? `where ${where.join(' and ')}` : '';
    const total = (await db.query(`select count(*)::int as n from save_records r ${w}`, params)).rows[0].n;
    const rows = (
      await db.query(
        `select r.id, r.source_id, r.source_item_key, r.game_title, r.title_id, r.platform, r.category, r.status, r.status_reason, r.redistribution,
                r.attempts, r.last_error, r.next_attempt_at, r.verified, r.blob_sha256, r.download_url, r.source_page_url, r.updated_at, b.size_bytes
           from save_records r left join blobs b on b.sha256 = r.blob_sha256 ${w} order by r.updated_at desc limit ${size} offset ${(page - 1) * size}`,
        params,
      )
    ).rows;
    return { total, page, page_size: size, results: rows };
  });

  r.get('/records/:id', async (req, reply) => {
    const id = Number((req.params as any).id);
    const rec = (await db.query(`select r.*, b.checks, b.manifest, b.sfo, b.storage_key, b.size_bytes from save_records r left join blobs b on b.sha256 = r.blob_sha256 where r.id = $1`, [id])).rows[0];
    if (!rec) return reply.code(404).send({ error: 'not_found' });
    const events = (await db.query('select at, level, event, message, details from job_events where record_id = $1 order by id desc limit 200', [id])).rows;
    return { record: rec, events };
  });

  r.post('/records/:id/retry', async (req, reply) => {
    const id = Number((req.params as any).id);
    const u = await db.query(
      `update save_records set status = 'QUEUED', attempts = 0, next_attempt_at = null, last_error = null, status_reason = 'manual retry', updated_at = now()
        where id = $1 and status in ('FAILED','RESTRICTED','QUEUED') and redistribution = 'granted' returning id`,
      [id],
    );
    if (!u.rowCount) return reply.code(409).send({ error: 'record is not retryable (must be FAILED/RESTRICTED with redistribution granted)' });
    await audit(db, actor(), 'record.retry', String(id));
    await event(db, { recordId: id, event: 'manual-retry' });
    return { ok: true };
  });

  r.post('/records/retry-failed', async (req) => {
    const body = (req.body ?? {}) as { source_id?: string };
    const u = await db.query(
      `update save_records set status = 'QUEUED', attempts = 0, next_attempt_at = null, status_reason = 'bulk retry', updated_at = now()
        where status = 'FAILED' and redistribution = 'granted' and ($1::text is null or source_id = $1) returning id`,
      [body.source_id ?? null],
    );
    await audit(db, actor(), 'records.retry_failed', body.source_id ?? null, { count: u.rowCount });
    return { requeued: u.rowCount };
  });

  r.post('/records/:id/permission', async (req, reply) => {
    const id = Number((req.params as any).id);
    const { decision, basis } = (req.body ?? {}) as { decision?: string; basis?: string };
    if (decision === 'grant') {
      if (!basis || basis.trim().length < 10) return reply.code(400).send({ error: 'granting requires a written permission basis (link or note, ≥10 chars)' });
      const u = await db.query(
        `update save_records set redistribution = 'granted', permission_basis = $2, status = case when status in ('PERMISSION_PENDING','RESTRICTED') then 'QUEUED'::record_status else status end,
                status_reason = 'permission granted by owner', updated_at = now() where id = $1 returning status`,
        [id, `owner: ${basis.trim()}`],
      );
      if (!u.rowCount) return reply.code(404).send({ error: 'not_found' });
    } else if (decision === 'deny') {
      const u = await db.query(
        `update save_records set redistribution = 'denied', permission_basis = null, status = case when status = 'STORED' then status else 'RESTRICTED'::record_status end,
                status_reason = 'permission denied by owner', updated_at = now() where id = $1 returning id`,
        [id],
      );
      if (!u.rowCount) return reply.code(404).send({ error: 'not_found' });
    } else return reply.code(400).send({ error: 'decision must be grant or deny' });
    await audit(db, actor(), `record.permission.${decision}`, String(id), { basis });
    await event(db, { recordId: id, event: `permission-${decision}`, message: basis ?? '' });
    return { ok: true };
  });

  /**
   * Re-check a QUARANTINED record after reviewing it (e.g. a false positive): the quarantined object is
   * deleted and the record re-downloaded and re-inspected from scratch under the current rules.
   */
  r.post('/records/:id/recheck', async (req, reply) => {
    const id = Number((req.params as any).id);
    const rec = (await db.query(`select blob_sha256, redistribution from save_records where id = $1 and status = 'QUARANTINED'`, [id])).rows[0];
    if (!rec) return reply.code(409).send({ error: 'only QUARANTINED records can be re-checked' });
    if (rec.redistribution !== 'granted') return reply.code(409).send({ error: 'redistribution not granted' });
    if (rec.blob_sha256) {
      const others = await db.query(`select count(*)::int as n from save_records where blob_sha256 = $1 and id <> $2 and status <> 'REMOVED'`, [rec.blob_sha256, id]);
      await db.query(`update save_records set blob_sha256 = null where id = $1`, [id]);
      if (others.rows[0].n === 0) {
        const b = (await db.query('select storage_key from blobs where sha256 = $1 and quarantined', [rec.blob_sha256])).rows[0];
        if (b) {
          await app.storage.delete(b.storage_key);
          await db.query('delete from blobs where sha256 = $1', [rec.blob_sha256]);
        }
      }
    }
    await db.query(`update save_records set status = 'QUEUED', attempts = 0, next_attempt_at = null, status_reason = 'owner re-check of quarantine', updated_at = now() where id = $1`, [id]);
    await audit(db, actor(), 'record.recheck', String(id));
    await event(db, { recordId: id, event: 'recheck', message: 'quarantine reviewed by owner; re-downloading and re-inspecting' });
    return { ok: true };
  });

  /** Takedown / removal: record becomes REMOVED; the stored object is deleted when no other record uses it. */
  r.post('/records/:id/remove', async (req, reply) => {
    const id = Number((req.params as any).id);
    const { reason } = (req.body ?? {}) as { reason?: string };
    if (!reason || reason.trim().length < 3) return reply.code(400).send({ error: 'reason required' });
    const rec = (await db.query(`update save_records set status = 'REMOVED', status_reason = $2, updated_at = now() where id = $1 returning blob_sha256`, [id, `removed: ${reason}`])).rows[0];
    if (!rec) return reply.code(404).send({ error: 'not_found' });
    const deleted = rec.blob_sha256 ? await deleteBlobIfOrphaned(app, rec.blob_sha256) : false;
    await audit(db, actor(), 'record.remove', String(id), { reason, object_deleted: deleted });
    await event(db, { recordId: id, level: 'warn', event: 'removed', message: reason });
    return { ok: true, object_deleted: deleted };
  });

  r.post('/sources/:id', async (req, reply) => {
    const id = (req.params as any).id as string;
    const b = (req.body ?? {}) as { enabled?: boolean; paused?: boolean; policy?: string; permission_evidence?: string; discovery_interval_minutes?: number };
    const cur = (await db.query('select * from sources where id = $1', [id])).rows[0];
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    if (b.policy && !POLICIES.includes(b.policy)) return reply.code(400).send({ error: 'bad policy' });
    const evidence = b.permission_evidence ?? cur.permission_evidence;
    if (b.policy === 'MIRROR_ALLOWED' && (!evidence || evidence.trim().length < 10)) {
      return reply.code(400).send({ error: 'MIRROR_ALLOWED requires permission_evidence (licence link or written permission)' });
    }
    await withTx(db, async (tx) => {
      await tx.query(
        `update sources set enabled = coalesce($2, enabled), paused = coalesce($3, paused), policy = coalesce($4::source_policy, policy),
                permission_evidence = coalesce($5, permission_evidence), discovery_interval_minutes = coalesce($6, discovery_interval_minutes), updated_at = now()
          where id = $1`,
        [id, b.enabled ?? null, b.paused ?? null, b.policy ?? null, b.permission_evidence ?? null, b.discovery_interval_minutes ?? null],
      );
      if (b.policy && b.policy !== cur.policy) {
        if (b.policy === 'MIRROR_ALLOWED') {
          await tx.query(
            `update save_records set status = 'QUEUED', redistribution = 'granted', permission_basis = $2, status_reason = 'source permission recorded', updated_at = now()
              where source_id = $1 and status = 'PERMISSION_PENDING' and redistribution <> 'denied'`,
            [id, `source permission: ${evidence}`],
          );
        } else {
          // Downgrade: stop downloading and stop serving until permission is re-established.
          await tx.query(
            `update save_records set status = 'PERMISSION_PENDING', redistribution = 'pending', permission_basis = null, status_reason = 'source permission withdrawn', updated_at = now()
              where source_id = $1 and status in ('QUEUED','FAILED') and permission_basis like 'source permission:%'`,
            [id],
          );
          await tx.query(
            `update save_records set redistribution = 'pending', status_reason = 'source permission withdrawn — not served', updated_at = now()
              where source_id = $1 and status = 'STORED' and permission_basis like 'source permission:%'`,
            [id],
          );
          if (b.policy === 'EXTERNAL_ONLY' || b.policy === 'BLOCKED') {
            await tx.query(`update save_records set status = 'RESTRICTED', status_reason = $2 where source_id = $1 and status in ('QUEUED','PERMISSION_PENDING','FAILED')`, [
              id,
              `source policy ${b.policy}`,
            ]);
          }
        }
      }
      await audit(tx, actor(), 'source.update', id, { before: { enabled: cur.enabled, paused: cur.paused, policy: cur.policy }, after: b });
    });
    return { ok: true };
  });

  r.post('/sources/:id/discover', async (req, reply) => {
    const id = (req.params as any).id as string;
    const src = (await db.query('select id from sources where id = $1', [id])).rows[0];
    if (!src) return reply.code(404).send({ error: 'not_found' });
    await audit(db, actor(), 'source.discover', id);
    // Run in the background; progress shows in source status + events.
    runDiscovery(db, { cfg: app.cfg, http: app.http, robots: new RobotsCache(app.http), log }, id).catch((e) => log.warn({ err: e, source: id }, 'discovery failed'));
    return { started: true };
  });

  r.post('/collection', async (req, reply) => {
    const { state } = (req.body ?? {}) as { state?: string };
    if (!['running', 'paused', 'stopped'].includes(state ?? '')) return reply.code(400).send({ error: 'state must be running|paused|stopped' });
    await db.query(`update settings set value = $1, updated_at = now() where key = 'collection_state'`, [JSON.stringify(state)]);
    await audit(db, actor(), 'collection.state', state!);
    return { ok: true, state };
  });

  r.post('/settings', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const allowed: Record<string, (v: unknown) => boolean> = {
      global_concurrency: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 64,
      storage_soft_limit_bytes: (v) => Number.isInteger(v) && (v as number) > 0,
      storage_hard_limit_bytes: (v) => Number.isInteger(v) && (v as number) > 0,
    };
    for (const [k, v] of Object.entries(body)) {
      if (!allowed[k] || !allowed[k](v)) return reply.code(400).send({ error: `invalid setting ${k}` });
    }
    for (const [k, v] of Object.entries(body)) {
      await db.query(`insert into settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value, updated_at = now()`, [k, JSON.stringify(v)]);
    }
    await audit(db, actor(), 'settings.update', null, body);
    return { ok: true };
  });

  r.get('/duplicates', async () => {
    const exact = (
      await db.query(`select b.sha256, b.size_bytes, count(*)::int as records, array_agg(r.source_id || ':' || r.source_item_key order by r.id) as items
                        from save_records r join blobs b on b.sha256 = r.blob_sha256 where r.status = 'STORED'
                       group by b.sha256, b.size_bytes having count(*) > 1 order by count(*) desc limit 200`)
    ).rows;
    // Same contents, different archive bytes (re-zipped copies) — reported for review, never auto-merged.
    const repacked = (
      await db.query(`select content_fingerprint, count(*)::int as blobs, array_agg(sha256) as sha256s, sum(size_bytes)::bigint as bytes
                        from blobs where content_fingerprint is not null and deleted_at is null group by content_fingerprint having count(*) > 1 limit 200`)
    ).rows;
    return { exact, repacked };
  });

  r.get('/catalog.json', async () => catalogRows(db));
  r.get('/catalog.csv', async (_req, reply) => {
    reply.header('content-type', 'text/csv; charset=utf-8');
    return catalogCsv(await catalogRows(db));
  });

  r.get('/api-keys', async () => (await db.query('select id, name, scopes, created_at, revoked_at from api_keys order by id')).rows);
  r.post('/api-keys', async (req, reply) => {
    const { name, scopes } = (req.body ?? {}) as { name?: string; scopes?: string[] };
    if (!name) return reply.code(400).send({ error: 'name required' });
    const key = newApiKey();
    const sc = (scopes ?? ['catalog', 'download']).filter((s) => ['catalog', 'download'].includes(s));
    const row = (await db.query('insert into api_keys (name, key_hash, scopes) values ($1,$2,$3) returning id', [name, sha256Hex(key), sc])).rows[0];
    await audit(db, actor(), 'api_key.create', String(row.id), { name, scopes: sc });
    return { id: row.id, key, note: 'shown once — store it server-side only' };
  });
  r.delete('/api-keys/:id', async (req) => {
    const id = Number((req.params as any).id);
    await db.query('update api_keys set revoked_at = now() where id = $1', [id]);
    await audit(db, actor(), 'api_key.revoke', String(id));
    return { ok: true };
  });

  r.get('/audit', async () => (await db.query('select * from audit_log order by id desc limit 200')).rows);
}
