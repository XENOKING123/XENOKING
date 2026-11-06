/**
 * Extract file-host / archive links from a forum post or web page so the post (discovery source)
 * and the file host (download origin) are recorded separately.
 */
const HOST_PATTERNS: Array<[string, RegExp]> = [
  ['mediafire', /^https?:\/\/(www\.)?mediafire\.com\/(file|file_premium|download|view|folder|\?)/i],
  ['mega', /^https?:\/\/(www\.)?mega\.(nz|co\.nz|io)\/(file|folder|#)/i],
  ['gdrive', /^https?:\/\/(drive|docs)\.google\.com\/(file\/d|uc|open|drive\/folders)/i],
  ['dropbox', /^https?:\/\/(www\.)?dropbox\.com\/(s|sh|scl)\//i],
  ['onedrive', /^https?:\/\/(1drv\.ms|onedrive\.live\.com)\//i],
  ['github', /^https?:\/\/(github\.com\/[^/]+\/[^/]+\/(releases\/download|raw|blob)\/|raw\.githubusercontent\.com\/)/i],
];
const ARCHIVE_EXT = /\.(zip|rar|7z)(\?|#|$)/i;

export interface ExtractedLink {
  url: string;
  host: string;
  text?: string;
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

export function classifyLink(url: string): string | null {
  for (const [host, re] of HOST_PATTERNS) if (re.test(url)) return host;
  try {
    const u = new URL(url);
    if ((u.protocol === 'http:' || u.protocol === 'https:') && ARCHIVE_EXT.test(u.pathname)) return 'direct';
  } catch {
    return null;
  }
  return null;
}

export function extractFileLinks(html: string, baseUrl?: string): ExtractedLink[] {
  const seen = new Set<string>();
  const out: ExtractedLink[] = [];
  const add = (raw: string, text?: string) => {
    let url = decodeEntities(raw.trim());
    try {
      url = new URL(url, baseUrl).toString();
    } catch {
      return;
    }
    const host = classifyLink(url);
    if (!host || seen.has(url)) return;
    seen.add(url);
    out.push({ url, host, text: text?.replace(/<[^>]+>/g, '').trim().slice(0, 200) || undefined });
  };
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) add(m[1], m[2]);
  // bare URLs in text (common in forum posts)
  const text = html.replace(/<[^>]+>/g, ' ');
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>()\[\]]+/g)) add(m[0].replace(/[.,;:!?]+$/, ''));
  return out;
}
