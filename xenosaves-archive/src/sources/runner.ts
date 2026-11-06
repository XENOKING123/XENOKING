import type { Db } from '../db/pool.js';
import { normalizeLink } from '../hosts/index.js';
import { event, pgJson } from '../worker/events.js';
import { CONNECTORS } from './registry.js';
import type { DiscoveredItem, SourceContext, SourceRow } from './types.js';

export interface DiscoveryStats {
  seen: number;
  inserted: number;
  updated: number;
  queued: number;
  permissionPending: number;
  restricted: number;
  durationMs: number;
}

/** Decide the initial state for a newly discovered item. Permission is never assumed. */
export function initialState(source: SourceRow, item: DiscoveredItem): {
  status: 'QUEUED' | 'PERMISSION_PENDING' | 'RESTRICTED';
  redistribution: 'granted' | 'pending' | 'denied';
  basis: string | null;
  reason: string | null;
} {
  if (source.policy === 'EXTERNAL_ONLY') {
    return { status: 'RESTRICTED', redistribution: 'pending', basis: null, reason: 'external-only source: catalogued with its link, never downloaded' };
  }
  if (item.restrictedReason) return { status: 'RESTRICTED', redistribution: item.redistribution ?? 'pending', basis: null, reason: item.restrictedReason };
  if (item.redistribution === 'denied') return { status: 'RESTRICTED', redistribution: 'denied', basis: null, reason: 'redistribution denied' };
  if (!item.downloadUrl) return { status: 'RESTRICTED', redistribution: 'pending', basis: null, reason: 'no public download link' };
  // Item-level grant must carry its own evidence (e.g. a detected repository licence).
  if (item.redistribution === 'granted' && item.permissionBasis) {
    return { status: 'QUEUED', redistribution: 'granted', basis: item.permissionBasis, reason: null };
  }
  if (source.policy === 'MIRROR_ALLOWED' && item.redistribution !== 'pending' && source.permission_evidence) {
    return { status: 'QUEUED', redistribution: 'granted', basis: `source permission: ${source.permission_evidence}`, reason: null };
  }
  return { status: 'PERMISSION_PENDING', redistribution: 'pending', basis: null, reason: 'redistribution permission not established' };
}

export async function runDiscovery(db: Db, ctx: Omit<SourceContext, 'source'>, sourceId: string): Promise<DiscoveryStats> {
  const { rows } = await db.query<SourceRow>('select * from sources where id = $1', [sourceId]);
  const source = rows[0];
  if (!source) throw new Error(`unknown source ${sourceId}`);
  if (source.policy === 'BLOCKED') throw new Error(`source ${sourceId} is BLOCKED: its terms forbid automated access`);
  const connector = CONNECTORS[source.kind];
  if (!connector) throw new Error(`no connector for kind ${source.kind}`);

  // One discovery per source at a time across all processes.
  const lock = await db.connect();
  const started = Date.now();
  const stats: DiscoveryStats = { seen: 0, inserted: 0, updated: 0, queued: 0, permissionPending: 0, restricted: 0, durationMs: 0 };
  try {
    const got = await lock.query('select pg_try_advisory_lock(hashtext($1)) as ok', [`discover:${sourceId}`]);
    if (!got.rows[0].ok) throw new Error(`discovery for ${sourceId} is already running`);
    await db.query(`update sources set last_discovery_status = 'running', last_discovery_error = null, updated_at = now() where id = $1`, [sourceId]);
    await event(db, { sourceId, event: 'discovery-start', message: `connector ${connector.kind}` });
    const runStartedAt = new Date();

    for await (const item of connector.discover({ ...ctx, source })) {
      stats.seen++;
      const init = initialState(source, item);
      const r = await db.query(
        `insert into save_records (
           source_id, source_item_key, source_page_url, download_url, file_host, platform, game_title, title_id,
           region, region_source, category, category_source, description, original_author, uploaded_by, uploaded_by_source,
           original_filename, file_format, expected_size, expected_hash, status, status_reason, redistribution,
           permission_basis, raw, last_seen_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25, now())
         on conflict (source_id, source_item_key) do update set
           source_page_url = excluded.source_page_url,
           download_url = excluded.download_url,
           file_host = excluded.file_host,
           platform = coalesce(excluded.platform, save_records.platform),
           game_title = coalesce(excluded.game_title, save_records.game_title),
           title_id = coalesce(excluded.title_id, save_records.title_id),
           region = coalesce(save_records.region, excluded.region),
           region_source = coalesce(save_records.region_source, excluded.region_source),
           category = case when save_records.category_source = 'owner' then save_records.category else excluded.category end,
           category_source = case when save_records.category_source = 'owner' then save_records.category_source else excluded.category_source end,
           description = excluded.description,
           original_author = coalesce(excluded.original_author, save_records.original_author),
           uploaded_by = coalesce(excluded.uploaded_by, save_records.uploaded_by),
           uploaded_by_source = coalesce(excluded.uploaded_by_source, save_records.uploaded_by_source),
           original_filename = excluded.original_filename,
           expected_size = coalesce(excluded.expected_size, save_records.expected_size),
           expected_hash = coalesce(excluded.expected_hash, save_records.expected_hash),
           raw = save_records.raw || excluded.raw,
           last_seen_at = now(),
           updated_at = now()
         returning (xmax = 0) as inserted, id, status`,
        [
          source.id,
          item.sourceItemKey,
          item.sourcePageUrl ?? null,
          item.downloadUrl ? normalizeLink(item.downloadUrl) : null,
          item.fileHost ?? null,
          item.platform ?? null,
          item.gameTitle ?? null,
          item.titleId ?? null,
          item.region ?? null,
          item.regionSource ?? null,
          item.category ?? null,
          item.categorySource ?? null,
          item.description?.replace(/\u0000/g, '') ?? null,
          item.originalAuthor ?? null,
          item.uploadedBy ?? null,
          item.uploadedBySource ?? null,
          item.originalFilename ?? null,
          item.fileFormat ?? null,
          item.expectedSize ?? null,
          item.expectedHash ?? null,
          init.status,
          init.reason,
          init.redistribution,
          init.basis,
          pgJson(item.raw ?? {}),
        ],
      );
      const row = r.rows[0];
      if (row.inserted) {
        stats.inserted++;
        await event(db, { recordId: row.id, sourceId, event: 'discovered', message: `${init.status}${init.reason ? ` — ${init.reason}` : ''}` });
      } else {
        stats.updated++;
        // Permission can change between runs (licence added/removed) — re-evaluate records not yet stored.
        if (row.status === 'PERMISSION_PENDING' && init.status === 'QUEUED') {
          await db.query(
            `update save_records set status = 'QUEUED', redistribution = 'granted', permission_basis = $2, status_reason = null, updated_at = now() where id = $1`,
            [row.id, init.basis],
          );
          row.status = 'QUEUED';
          await event(db, { recordId: row.id, sourceId, event: 'permission-granted', message: init.basis ?? '' });
        } else if (['QUEUED', 'FAILED'].includes(row.status) && init.status !== 'QUEUED') {
          await db.query(
            `update save_records set status = $2, redistribution = $3, permission_basis = null, status_reason = $4, updated_at = now() where id = $1`,
            [row.id, init.status, init.redistribution, init.reason],
          );
          row.status = init.status;
          await event(db, { recordId: row.id, sourceId, level: 'warn', event: 'permission-revoked', message: init.reason ?? '' });
        }
      }
      if (row.status === 'QUEUED') stats.queued++;
      else if (row.status === 'PERMISSION_PENDING') stats.permissionPending++;
      else if (row.status === 'RESTRICTED') stats.restricted++;
    }

    // Items no longer listed by the source: flag (do not delete) so dead listings are visible.
    const missing = await db.query(
      `update save_records set raw = raw || jsonb_build_object('missing_from_source_since', to_jsonb(now()))
        where source_id = $1 and last_seen_at < $2 and not (raw ? 'missing_from_source_since') returning id`,
      [sourceId, runStartedAt],
    );
    stats.durationMs = Date.now() - started;
    await db.query(
      `update sources set last_discovery_at = now(), last_discovery_status = 'ok', last_discovery_stats = $2, updated_at = now() where id = $1`,
      [sourceId, JSON.stringify({ ...stats, missingFromSource: missing.rowCount })],
    );
    await event(db, { sourceId, event: 'discovery-done', message: `seen ${stats.seen}, new ${stats.inserted}, queued ${stats.queued}, pending ${stats.permissionPending}`, details: stats });
    return stats;
  } catch (err) {
    await db.query(
      `update sources set last_discovery_at = now(), last_discovery_status = 'error', last_discovery_error = $2, updated_at = now() where id = $1`,
      [sourceId, (err as Error).message.slice(0, 2000)],
    );
    await event(db, { sourceId, level: 'error', event: 'discovery-error', message: (err as Error).message });
    throw err;
  } finally {
    await lock.query('select pg_advisory_unlock(hashtext($1))', [`discover:${sourceId}`]).catch(() => {});
    lock.release();
  }
}
