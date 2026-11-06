import { classifyStatus, FetchFailure } from '../net/http.js';
import type { HostResolver } from './index.js';

/**
 * Google Drive public files.
 *  - With GOOGLE_API_KEY: official Drive v3 API  files/{id}?alt=media  (public files only).
 *  - Without: the normal public download endpoint. Large files show Google's "can't scan for viruses"
 *    notice; submitting that notice's own form is exactly the user's "Download anyway" click.
 *  - "Quota exceeded", sign-in, or access-request pages are recorded as restricted — never bypassed.
 */
export function gdriveFileId(u: URL): string | null {
  const m = u.pathname.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/) ?? u.pathname.match(/\/d\/([A-Za-z0-9_-]{10,})/);
  if (m) return m[1];
  const id = u.searchParams.get('id');
  return id && /^[A-Za-z0-9_-]{10,}$/.test(id) ? id : null;
}

export type GdriveHtmlOutcome =
  | { kind: 'confirm'; url: string }
  | { kind: 'restricted'; reason: string }
  | { kind: 'dead'; reason: string }
  | { kind: 'unknown' };

export function interpretGdriveHtml(html: string, base: string): GdriveHtmlOutcome {
  if (/Too many users have viewed or downloaded this file recently|download quota (for this file )?(has been|is) exceeded/i.test(html)) {
    return { kind: 'restricted', reason: 'Google Drive download quota exceeded for this file' };
  }
  if (/accounts\.google\.com\/(ServiceLogin|signin)|You need access|Request access/i.test(html)) {
    return { kind: 'restricted', reason: 'Google Drive file is private / requires sign-in or access request' };
  }
  if (/Sorry, the file you have requested does not exist|file you have requested has been removed|404\. That’s an error/i.test(html)) {
    return { kind: 'dead', reason: 'Google Drive file does not exist or was removed' };
  }
  const form = html.match(/<form[^>]*id="download-form"[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i);
  if (form) {
    const action = new URL(form[1].replace(/&amp;/g, '&'), base);
    for (const inp of form[2].matchAll(/<input[^>]*type="hidden"[^>]*>/gi)) {
      const name = inp[0].match(/name="([^"]+)"/)?.[1];
      const value = inp[0].match(/value="([^"]*)"/)?.[1] ?? '';
      if (name) action.searchParams.set(name, value.replace(/&amp;/g, '&'));
    }
    return { kind: 'confirm', url: action.toString() };
  }
  return { kind: 'unknown' };
}

export const gdriveResolver: HostResolver = {
  id: 'gdrive',
  label: 'Google Drive public file',
  matches: (u) => ['drive.google.com', 'docs.google.com', 'drive.usercontent.google.com'].includes(u.hostname),
  async resolve(u, ctx) {
    if (u.pathname.includes('/folders/')) {
      throw new FetchFailure('restricted', 'Google Drive folder links must be expanded with the Drive API (GOOGLE_API_KEY) — not supported without it');
    }
    const id = gdriveFileId(u);
    if (!id) throw new FetchFailure('invalid', `cannot find a Google Drive file id in ${u}`);
    if (ctx.googleApiKey) {
      return { url: `https://www.googleapis.com/drive/v3/files/${id}?alt=media&key=${encodeURIComponent(ctx.googleApiKey)}` };
    }
    const start = `https://drive.usercontent.google.com/download?id=${id}&export=download`;
    const { res, finalUrl, release } = await ctx.http.request(start);
    try {
      const kind = classifyStatus(res.status);
      if (kind) throw new FetchFailure(kind, `Google Drive answered HTTP ${res.status}`, res.status);
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('text/html')) {
        await res.body?.cancel().catch(() => {});
        return { url: start };
      }
      const html = await res.text();
      const outcome = interpretGdriveHtml(html.slice(0, 2_000_000), finalUrl);
      if (outcome.kind === 'confirm') return { url: outcome.url };
      if (outcome.kind === 'restricted') throw new FetchFailure('restricted', outcome.reason);
      if (outcome.kind === 'dead') throw new FetchFailure('dead-link', outcome.reason);
      throw new FetchFailure('restricted', 'Google Drive returned an unrecognised page instead of the file');
    } finally {
      release();
    }
  },
};
