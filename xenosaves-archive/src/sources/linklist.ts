import fs from 'node:fs/promises';
import { hostIdFor } from '../hosts/index.js';
import { suggestCategory } from '../metadata/category.js';
import { extractTitleId, platformForTitleId, regionFromContentId, regionFromText } from '../metadata/titleid.js';
import type { DiscoveredItem, SourceConnector, SourceContext } from './types.js';

/**
 * A curated list of (post page, file link, metadata) rows — for community submissions, or a dataset a
 * site owner provides together with redistribution permission. Accepts JSON (array of objects) or CSV.
 * Each row keeps the discovery page (`page_url`) separate from the file host link (`download_url`).
 */
export interface LinkRow {
  id?: string;
  page_url?: string;
  download_url: string;
  game?: string;
  title_id?: string;
  platform?: string;
  region?: string;
  category?: string;
  description?: string;
  author?: string;
  uploader?: string;
  filename?: string;
  size?: number | string;
  sha256?: string;
  redistribution?: 'granted' | 'pending' | 'denied';
  permission_basis?: string;
}

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  const [header, ...body] = rows;
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

/** Column aliases so output from existing scrapers can be imported without reformatting. */
const ALIASES: Record<keyof LinkRow, string[]> = {
  id: ['id', 'save_id', 'file_id', 'uid'],
  page_url: ['page_url', 'page', 'post_url', 'thread_url', 'source_url', 'source_page', 'url_page', 'topic_url'],
  download_url: ['download_url', 'download', 'download_link', 'file_url', 'file_link', 'link', 'url', 'mirror', 'mediafire', 'mega'],
  game: ['game', 'game_title', 'game_name', 'title', 'name'],
  title_id: ['title_id', 'titleid', 'cusa', 'ppsa', 'cusa_id', 'game_id', 'serial'],
  platform: ['platform', 'console', 'system'],
  region: ['region'],
  category: ['category', 'type', 'save_type', 'tag'],
  description: ['description', 'desc', 'details', 'notes', 'body', 'text'],
  author: ['author', 'creator', 'made_by', 'credits', 'original_author'],
  uploader: ['uploader', 'uploaded_by', 'poster', 'user', 'username'],
  filename: ['filename', 'file_name', 'original_filename', 'file'],
  size: ['size', 'file_size', 'bytes', 'size_bytes'],
  sha256: ['sha256', 'hash'],
  redistribution: ['redistribution'],
  permission_basis: ['permission_basis', 'permission', 'license', 'licence'],
};

export function normalizeRow(raw: Record<string, unknown>): LinkRow {
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) lower[k.trim().toLowerCase().replace(/[\s-]+/g, '_')] = v;
  const out: Record<string, unknown> = {};
  for (const [field, names] of Object.entries(ALIASES)) {
    for (const n of names) {
      const v = lower[n];
      if (v !== undefined && v !== null && String(v).trim() !== '') {
        out[field] = typeof v === 'string' ? v.trim() : v;
        break;
      }
    }
  }
  // A size like "12.5 MB" is a display string, not bytes — keep it in raw only.
  if (out.size !== undefined && !/^\d+$/.test(String(out.size))) delete out.size;
  if (out.sha256 !== undefined && !/^[0-9a-fA-F]{64}$/.test(String(out.sha256))) delete out.sha256;
  if (out.redistribution && !['granted', 'pending', 'denied'].includes(String(out.redistribution))) delete out.redistribution;
  return out as unknown as LinkRow;
}

export function rowToItem(r: LinkRow, sourcePolicyGranted: boolean, sourceEvidence: string | null): DiscoveredItem {
  const text = [r.game, r.description, r.filename, r.page_url].filter(Boolean).join(' ');
  const titleId = r.title_id ? extractTitleId(r.title_id) : extractTitleId(text);
  const content = regionFromContentId(text);
  const region = r.region?.toUpperCase() || content?.region || regionFromText(text);
  const cat = r.category || suggestCategory(r.description ?? r.filename ?? '');
  const platform = (r.platform?.toUpperCase() === 'PS5' ? 'PS5' : r.platform?.toUpperCase() === 'PS4' ? 'PS4' : platformForTitleId(titleId)) as any;
  const grant = r.redistribution ?? (sourcePolicyGranted ? 'granted' : 'pending');
  return {
    sourceItemKey: r.id || r.download_url,
    sourcePageUrl: r.page_url || null,
    downloadUrl: r.download_url,
    fileHost: hostIdFor(r.download_url),
    platform,
    gameTitle: r.game || null,
    titleId,
    region: region || null,
    regionSource: r.region ? 'source' : content ? 'content-id' : region ? 'source-text' : null,
    category: cat || null,
    categorySource: r.category ? 'source' : cat ? 'keyword-heuristic' : null,
    description: r.description || null,
    originalAuthor: r.author || null,
    uploadedBy: r.uploader || null,
    uploadedBySource: r.uploader ? 'source' : null,
    originalFilename: r.filename || null,
    fileFormat: (r.filename ?? r.download_url).match(/\.(zip|rar|7z)(\?|$)/i)?.[1]?.toLowerCase() ?? null,
    expectedSize: r.size ? Number(r.size) || null : null,
    expectedHash: r.sha256 ? `sha256:${r.sha256.toLowerCase()}` : null,
    redistribution: grant,
    permissionBasis: grant === 'granted' ? r.permission_basis || sourceEvidence || null : null,
    raw: { row: r },
  };
}

export const linkListConnector: SourceConnector = {
  kind: 'link-list',
  description: 'Curated JSON/CSV list of save posts + file-host links (submissions or permission-granted datasets)',
  liveTested: true,
  async *discover(ctx: SourceContext): AsyncIterable<DiscoveredItem> {
    const { file, url } = ctx.source.config as { file?: string; url?: string };
    let text: string;
    let name: string;
    if (file) {
      text = await fs.readFile(file, 'utf8');
      name = file;
    } else if (url) {
      text = (await ctx.http.getText(url, { maxBytes: 50 * 1024 * 1024 })).text;
      name = url;
    } else throw new Error('link-list source needs config.file or config.url');
    let rawRows: Record<string, unknown>[];
    if (name.toLowerCase().endsWith('.csv')) rawRows = parseCsv(text);
    else if (name.toLowerCase().endsWith('.jsonl') || name.toLowerCase().endsWith('.ndjson')) {
      rawRows = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
    } else {
      const parsed = JSON.parse(text);
      rawRows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.saves) ? parsed.saves : Array.isArray(parsed?.items) ? parsed.items : [];
    }
    const granted = ctx.source.policy === 'MIRROR_ALLOWED';
    for (const raw of rawRows) {
      // One post can list several file links — import each as its own item, keeping the post page.
      const links = Array.isArray((raw as any).links) ? ((raw as any).links as unknown[]).map(String) : null;
      const base = normalizeRow(raw);
      const urls = links?.length ? links : base.download_url ? [base.download_url] : [];
      for (const [i, u] of urls.entries()) {
        const r: LinkRow = { ...base, download_url: u, id: base.id ? (urls.length > 1 ? `${base.id}#${i + 1}` : base.id) : undefined };
        const item = rowToItem(r, granted, ctx.source.permission_evidence);
        item.raw = { row: raw };
        yield item;
      }
    }
  },
};
