/**
 * Title-ID and region helpers. Everything here is extraction from text the source published —
 * nothing is guessed. Region is only derived from a full content ID (e.g. "UP9000-CUSA00207_00-..."),
 * because bare CUSA/PPSA IDs do not encode a region.
 */

const PS4_PREFIXES = ['CUSA', 'PCAS', 'PCJS', 'PCKS', 'PLAS', 'PLJS', 'PLJM', 'PLKS'];
const PS5_PREFIXES = ['PPSA', 'ECAS', 'ECJS', 'ECKS', 'ELAS', 'ELJS', 'ELJM', 'ELKS'];

const TITLE_ID_RE = new RegExp(`\\b(${[...PS4_PREFIXES, ...PS5_PREFIXES].join('|')})[-_ ]?(\\d{5})\\b`, 'i');
const TITLE_ID_RE_G = new RegExp(TITLE_ID_RE.source, 'gi');
const CONTENT_ID_RE = /\b([A-Z]{2})(\d{4})-((?:CUSA|PPSA)\d{5})_\d{2}-[A-Z0-9]{16}\b/;

export function extractTitleId(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(TITLE_ID_RE);
  return m ? `${m[1].toUpperCase()}${m[2]}` : null;
}

export function extractAllTitleIds(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(TITLE_ID_RE_G)) out.add(`${m[1].toUpperCase()}${m[2]}`);
  return [...out];
}

export function platformForTitleId(titleId: string | null | undefined): 'PS4' | 'PS5' | null {
  if (!titleId) return null;
  const p = titleId.slice(0, 4).toUpperCase();
  if (PS4_PREFIXES.includes(p)) return 'PS4';
  if (PS5_PREFIXES.includes(p)) return 'PS5';
  return null;
}

const CONTENT_ID_REGION: Record<string, string> = { UP: 'US', EP: 'EU', JP: 'JP', HP: 'ASIA' };

export function regionFromContentId(text: string | null | undefined): { region: string; contentId: string } | null {
  if (!text) return null;
  const m = text.match(CONTENT_ID_RE);
  if (!m) return null;
  const region = CONTENT_ID_REGION[m[1]];
  return region ? { region, contentId: m[0] } : null;
}

/** Region words as written by the source (e.g. "[EU]", "USA version"). Returned verbatim-normalised only when explicit. */
export function regionFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(/(?:\[|\(|\b)(USA?|EUR?|Europe|JPN?|Japan|Asia|ASIA|KOR|Korea)(?:\]|\)|\b)/);
  if (!m) return null;
  const v = m[1].toUpperCase();
  if (v.startsWith('US')) return 'US';
  if (v.startsWith('EU')) return 'EU';
  if (v.startsWith('JP') || v === 'JAPAN') return 'JP';
  if (v === 'ASIA') return 'ASIA';
  if (v.startsWith('KOR')) return 'KR';
  return null;
}
