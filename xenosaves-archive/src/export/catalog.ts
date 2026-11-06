import type { Db } from '../db/pool.js';

export interface CatalogFilter {
  platform?: string;
  titleId?: string;
  region?: string;
  category?: string;
  source?: string;
  /** include stored records whose redistribution is not granted (owner's private backup only) */
  includeUnpermitted?: boolean;
}

export async function catalogRows(db: Db, f: CatalogFilter = {}) {
  const where = [`r.status = 'STORED'`, 'b.deleted_at is null', 'not b.quarantined'];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (!f.includeUnpermitted) where.push(`r.redistribution = 'granted'`);
  if (f.platform) add('r.platform = ?', f.platform.toUpperCase());
  if (f.titleId) add('r.title_id = ?', f.titleId.toUpperCase());
  if (f.region) add('r.region = ?', f.region.toUpperCase());
  if (f.category) add('r.category = ?', f.category);
  if (f.source) add('r.source_id = ?', f.source);
  const { rows } = await db.query(
    `select r.id, r.platform, r.title_id, r.game_title as game, r.region, r.region_source, r.category, r.category_source, r.description,
            r.original_author, r.uploaded_by, r.uploaded_by_source, r.source_id, s.name as source_name, r.source_page_url, r.download_url as original_download_url,
            r.original_filename, r.file_format, b.size_bytes as file_size, b.sha256, r.downloaded_at, r.verified, r.redistribution, r.permission_basis,
            b.storage_key, b.checks->'malware_scan'->>'status' as malware_scan, b.checks->'archive'->>'verdict' as archive_safety
       from save_records r join blobs b on b.sha256 = r.blob_sha256 join sources s on s.id = r.source_id
      where ${where.join(' and ')}
      order by r.platform nulls last, r.title_id nulls last, r.id`,
    params,
  );
  return rows;
}

const CSV_COLS = [
  'id', 'platform', 'title_id', 'game', 'region', 'category', 'category_source', 'description', 'original_author', 'uploaded_by',
  'source_id', 'source_name', 'source_page_url', 'original_download_url', 'original_filename', 'file_format', 'file_size', 'sha256',
  'downloaded_at', 'verified', 'malware_scan', 'archive_safety', 'redistribution', 'permission_basis',
];

export function catalogCsv(rows: any[]): string {
  const esc = (v: unknown) => {
    if (v == null) return '';
    const s = v instanceof Date ? v.toISOString() : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [CSV_COLS.join(','), ...rows.map((r) => CSV_COLS.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}
