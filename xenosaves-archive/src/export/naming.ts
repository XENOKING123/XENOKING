/**
 * Human-friendly file names for exports and API downloads, built only from stored metadata:
 *   PS4/CUSA43228-Like-a-Dragon-Gaiden/Platinum-Save-intended-for-trophy-progression-812.zip
 * The record id suffix keeps names unique; generic source names like "00000001.zip" are replaced.
 */
export function slug(s: string | null | undefined, max = 60): string {
  return (s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[™®©]/g, '')
    .replace(/[^\w\s.-]/g, ' ')
    .trim()
    .replace(/[\s._]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, max)
    .replace(/^-+|-+$/g, '');
}

export function gameFolderName(r: { platform: string | null; title_id: string | null; game: string | null }): string {
  const plat = r.platform ?? 'UNKNOWN-PLATFORM';
  const name = [r.title_id, slug(r.game, 80)].filter(Boolean).join('-') || 'Unknown-Game';
  return `${plat}/${name}`;
}

export function friendlySaveName(r: { id: number; category?: string | null; description?: string | null; original_filename?: string | null; file_format?: string | null }): string {
  const m = r.original_filename?.match(/^(.*)\.(zip|rar|7z)$/i);
  const ext = (m?.[2] ?? r.file_format ?? 'zip').toLowerCase();
  const stem = m?.[1] ?? r.original_filename ?? '';
  const generic = !stem || /^\d+$/.test(stem) || /^(save|savedata|data|file|download)[-_ ]?\d*$/i.test(stem);
  const cat = r.category ? slug(r.category, 30) : '';
  let desc = slug(r.description, 60);
  if (cat && desc.toLowerCase().startsWith(cat.toLowerCase())) desc = desc.slice(cat.length).replace(/^-+/, '');
  const parts = [cat, desc || (generic ? '' : slug(stem, 60))].filter(Boolean);
  return `${parts.join('-') || 'Save'}-${r.id}.${ext}`;
}
