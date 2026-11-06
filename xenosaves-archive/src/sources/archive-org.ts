import { suggestCategory } from '../metadata/category.js';
import { extractTitleId, platformForTitleId, regionFromContentId, regionFromText } from '../metadata/titleid.js';
import type { DiscoveredItem, SourceConnector, SourceContext } from './types.js';

/**
 * Internet Archive items via the official scrape (search) API and per-item metadata API.
 * Redistribution is granted only when the item's `licenseurl` is an open licence / public-domain mark;
 * everything else stays PERMISSION_PENDING (uploaders' rights claims on IA are not verified by IA).
 */
const OPEN_LICENSE = /creativecommons\.org\/(licenses\/(by|by-sa|by-nd)\/|publicdomain\/(zero|mark)\/)/i;
const ARCHIVE_RE = /\.(zip|rar|7z)$/i;

export function iaLicenseGrant(licenseurl: string | undefined | null): { granted: boolean; basis: string | null } {
  if (licenseurl && OPEN_LICENSE.test(licenseurl)) return { granted: true, basis: `item licence ${licenseurl}` };
  return { granted: false, basis: null };
}

function first(v: unknown): string | null {
  if (Array.isArray(v)) return v.length ? String(v[0]) : null;
  return v == null ? null : String(v);
}

export function iaItemsToDiscovered(meta: any, opts: { platformHint?: 'PS4' | 'PS5' } = {}): DiscoveredItem[] {
  const id = meta?.metadata?.identifier;
  if (!id || !Array.isArray(meta.files)) return [];
  const md = meta.metadata;
  const lic = iaLicenseGrant(first(md.licenseurl));
  const itemTitle = first(md.title);
  const itemDesc = first(md.description)?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() ?? null;
  const out: DiscoveredItem[] = [];
  for (const f of meta.files) {
    if (!f?.name || !ARCHIVE_RE.test(f.name) || f.source === 'derivative') continue;
    const text = `${f.name} ${itemTitle ?? ''}`;
    const titleId = extractTitleId(text);
    const cid = regionFromContentId(text);
    const region = cid?.region ?? regionFromText(f.name);
    const cat = suggestCategory(`${f.name} ${itemDesc ?? ''}`);
    out.push({
      sourceItemKey: `${id}/${f.name}`,
      sourcePageUrl: `https://archive.org/details/${encodeURIComponent(id)}`,
      downloadUrl: `https://archive.org/download/${encodeURIComponent(id)}/${f.name.split('/').map(encodeURIComponent).join('/')}`,
      fileHost: 'direct',
      platform: (platformForTitleId(titleId) ?? opts.platformHint ?? null) as any,
      gameTitle: null, // IA filenames rarely state the game unambiguously; filled from PARAM.SFO after download
      titleId,
      region: region ?? null,
      regionSource: cid ? 'content-id' : region ? 'source-filename' : null,
      category: cat,
      categorySource: cat ? 'keyword-heuristic' : null,
      description: itemDesc,
      originalAuthor: first(md.creator),
      uploadedBy: first(md.uploader),
      uploadedBySource: md.uploader ? 'archive.org uploader field' : null,
      originalFilename: f.name.split('/').pop(),
      fileFormat: f.name.split('.').pop().toLowerCase(),
      expectedSize: f.size ? Number(f.size) : null,
      expectedHash: f.sha1 ? `sha1:${f.sha1}` : null,
      redistribution: lic.granted ? 'granted' : 'pending',
      permissionBasis: lic.basis,
      raw: { identifier: id, item_title: itemTitle, licenseurl: first(md.licenseurl), md5: f.md5 ?? null },
    });
  }
  return out;
}

export const archiveOrgConnector: SourceConnector = {
  kind: 'archive-org',
  description: 'Internet Archive items matching a search query (official scrape + metadata APIs, licence-gated)',
  liveTested: false,
  async *discover(ctx: SourceContext): AsyncIterable<DiscoveredItem> {
    const query: string = ctx.source.config.query;
    if (!query) throw new Error('archive-org source needs config.query');
    const maxItems: number = ctx.source.config.maxItems ?? 5000;
    let cursor: string | undefined;
    let seen = 0;
    do {
      const params = new URLSearchParams({ q: query, fields: 'identifier', count: '1000' });
      if (cursor) params.set('cursor', cursor);
      const page: any = await ctx.http.getJson(`https://archive.org/services/search/v1/scrape?${params}`);
      for (const it of page.items ?? []) {
        if (seen++ >= maxItems) return;
        const meta = await ctx.http.getJson(`https://archive.org/metadata/${encodeURIComponent(it.identifier)}`);
        for (const d of iaItemsToDiscovered(meta, { platformHint: ctx.source.config.platform })) yield d;
      }
      cursor = page.cursor;
    } while (cursor);
  },
};
