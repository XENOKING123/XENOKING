import type { Db } from '../db/pool.js';

/** SQL predicate for records the public API may expose and serve. */
export function servableWhere(serveUnscanned: boolean): string {
  return `r.status = 'STORED' and r.redistribution = 'granted' and b.quarantined = false and b.deleted_at is null
    and s.policy in ('MIRROR_ALLOWED','PERMISSION_REQUIRED')
    and (r.verified ${serveUnscanned ? `or ((b.checks->'archive'->>'verdict') = 'ok' and coalesce(b.checks->'malware_scan'->>'status','') <> 'infected')` : ''})`;
}

export const RECORD_SELECT = `
  r.id, r.game_title, r.platform, r.title_id, r.region, r.region_source, r.category, r.category_source, r.description,
  r.original_author, r.uploaded_by, r.uploaded_by_source, r.original_filename, r.file_format, r.verified,
  r.redistribution, r.permission_basis, r.source_page_url, r.download_url, r.downloaded_at, r.discovered_at, r.raw,
  r.source_id, s.name as source_name, s.homepage as source_homepage, s.license as source_license,
  b.sha256, b.size_bytes, b.archive_format, b.entry_count, b.uncompressed_bytes, b.checks, b.sfo,
  (select count(*)::int from downloads d where d.record_id = r.id) as download_count`;

export function publicRecord(row: any) {
  const checks = row.checks ?? {};
  return {
    id: row.id,
    game: row.game_title,
    platform: row.platform,
    title_id: row.title_id,
    region: row.region,
    region_source: row.region_source,
    category: row.category,
    category_source: row.category_source,
    description: row.description,
    original_author: row.original_author,
    uploaded_by: row.uploaded_by,
    uploaded_by_source: row.uploaded_by_source,
    original_filename: row.original_filename,
    file_format: row.file_format,
    file_size: row.size_bytes,
    sha256: row.sha256,
    downloaded_at: row.downloaded_at,
    verified: row.verified,
    verification: {
      integrity: 'sha256 computed on download; storage upload checksum-verified',
      published_hash: checks.published_hash?.status ?? 'none',
      archive_safety: checks.archive?.verdict ?? null,
      archive_warnings: checks.archive?.warnings ?? [],
      malware_scan: checks.malware_scan?.status ?? 'not_run',
    },
    source: {
      id: row.source_id,
      name: row.source_name,
      page_url: row.source_page_url,
      original_download_url: row.download_url,
      license: row.source_license,
    },
    redistribution: { status: row.redistribution, basis: row.permission_basis },
    download_count: row.download_count,
  };
}

export interface SaveQuery {
  q?: string;
  platform?: string;
  title_id?: string;
  region?: string;
  category?: string;
  source?: string;
  sort?: string;
  page?: number;
  page_size?: number;
}

export async function searchSaves(db: Db, serveUnscanned: boolean, query: SaveQuery) {
  const where = [servableWhere(serveUnscanned)];
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (query.q) {
    const like = p(`%${query.q.replace(/[%_\\]/g, '\\$&')}%`);
    where.push(`(r.game_title ilike ${like} or r.description ilike ${like} or r.title_id ilike ${like} or r.original_filename ilike ${like})`);
  }
  if (query.platform) where.push(`r.platform = ${p(query.platform.toUpperCase())}`);
  if (query.title_id) where.push(`r.title_id = ${p(query.title_id.toUpperCase())}`);
  if (query.region) where.push(`r.region = ${p(query.region.toUpperCase())}`);
  if (query.category) where.push(`r.category = ${p(query.category)}`);
  if (query.source) where.push(`r.source_id = ${p(query.source)}`);
  const order =
    query.sort === 'downloads'
      ? 'download_count desc, r.id desc'
      : query.sort === 'title'
        ? 'r.game_title asc nulls last, r.id'
        : query.sort === 'size'
          ? 'b.size_bytes desc'
          : 'r.downloaded_at desc nulls last, r.id desc';
  const pageSize = Math.min(Math.max(Number(query.page_size) || 50, 1), 200);
  const page = Math.max(Number(query.page) || 1, 1);
  const base = `from save_records r join sources s on s.id = r.source_id join blobs b on b.sha256 = r.blob_sha256 where ${where.join(' and ')}`;
  const total = (await db.query(`select count(*)::int as n ${base}`, params)).rows[0].n;
  const rows = (await db.query(`select ${RECORD_SELECT} ${base} order by ${order} limit ${pageSize} offset ${(page - 1) * pageSize}`, params)).rows;
  return { total, page, page_size: pageSize, results: rows.map(publicRecord) };
}

export async function getSave(db: Db, serveUnscanned: boolean, id: number) {
  const r = await db.query(
    `select ${RECORD_SELECT}, b.storage_key from save_records r join sources s on s.id = r.source_id join blobs b on b.sha256 = r.blob_sha256
      where r.id = $1 and ${servableWhere(serveUnscanned)}`,
    [id],
  );
  if (!r.rows[0]) return null;
  const row = r.rows[0];
  // Every source that published this exact file (credits are preserved across duplicates)
  const credits = await db.query(
    `select r.id, r.source_id, s.name as source_name, r.source_page_url, r.uploaded_by, r.original_author, r.description
       from save_records r join sources s on s.id = r.source_id where r.blob_sha256 = $1 and r.status = 'STORED' order by r.id`,
    [row.sha256],
  );
  return { ...publicRecord(row), storage_key: row.storage_key as string, credits: credits.rows, archive: { entries: row.entry_count, uncompressed_bytes: row.uncompressed_bytes, param_sfo: row.sfo } };
}

export async function listGames(db: Db, serveUnscanned: boolean, q: { platform?: string; q?: string; page?: number; page_size?: number }) {
  const where = [servableWhere(serveUnscanned)];
  const params: unknown[] = [];
  if (q.platform) {
    params.push(q.platform.toUpperCase());
    where.push(`r.platform = $${params.length}`);
  }
  if (q.q) {
    params.push(`%${q.q.replace(/[%_\\]/g, '\\$&')}%`);
    where.push(`(r.game_title ilike $${params.length} or r.title_id ilike $${params.length})`);
  }
  const pageSize = Math.min(Math.max(Number(q.page_size) || 100, 1), 500);
  const page = Math.max(Number(q.page) || 1, 1);
  const rows = (
    await db.query(
      `select r.platform, r.title_id, max(r.game_title) as game, count(*)::int as save_count, sum(b.size_bytes)::bigint as total_bytes,
              array_agg(distinct r.category) filter (where r.category is not null) as categories, max(r.downloaded_at) as last_added
         from save_records r join sources s on s.id = r.source_id join blobs b on b.sha256 = r.blob_sha256
        where ${where.join(' and ')}
        group by r.platform, r.title_id
        order by max(r.game_title) nulls last
        limit ${pageSize} offset ${(page - 1) * pageSize}`,
      params,
    )
  ).rows;
  return { page, page_size: pageSize, results: rows };
}

export async function stats(db: Db) {
  const s = (
    await db.query(`
      select
        (select count(*)::int from save_records) as total_records,
        (select count(*)::int from save_records where status = 'STORED') as stored_records,
        (select count(*)::int from blobs where deleted_at is null and not quarantined) as unique_files,
        (select coalesce(sum(size_bytes),0)::bigint from blobs where deleted_at is null) as stored_bytes,
        (select coalesce(sum(b.size_bytes),0)::bigint from save_records r join blobs b on b.sha256 = r.blob_sha256 where r.status = 'STORED') as logical_bytes,
        (select count(*)::int from save_records where status = 'FAILED') as failed,
        (select count(*)::int from save_records where status = 'PERMISSION_PENDING') as permission_pending,
        (select count(*)::int from save_records where status = 'RESTRICTED') as restricted,
        (select count(*)::int from save_records where status = 'QUARANTINED') as quarantined,
        (select count(*)::int from save_records where status = 'QUEUED') as queued,
        (select count(*)::int from save_records where status in ('DOWNLOADING','VERIFYING')) as in_progress,
        (select count(*)::int from save_records where status = 'STORED' and verified) as verified_records,
        (select count(*)::int from sources) as sources,
        (select count(*)::int from downloads) as api_downloads`)
  ).rows[0];
  const dup = (
    await db.query(
      `select coalesce(sum(n-1),0)::int as d, coalesce(sum(size_bytes*(n-1)),0)::bigint as saved
         from (select b.size_bytes, count(*) as n from save_records r join blobs b on b.sha256 = r.blob_sha256
                where r.status = 'STORED' group by b.sha256, b.size_bytes) x`,
    )
  ).rows[0];
  return { ...s, duplicate_records: dup.d, dedup_saved_bytes: Number(dup.saved) };
}
