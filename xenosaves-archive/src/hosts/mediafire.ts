import { FetchFailure } from '../net/http.js';
import type { HostResolver } from './index.js';

/**
 * MediaFire public file pages. Reads the page's own "Download" button target — the same link a
 * visitor clicks. Captcha pages, "dangerous file" blocks, password-protected and removed files are
 * classified, never worked around.
 */
export type MediafireOutcome =
  | { kind: 'link'; url: string; filename?: string; size?: string }
  | { kind: 'restricted'; reason: string }
  | { kind: 'dead'; reason: string }
  | { kind: 'unknown' };

export function interpretMediafireHtml(html: string): MediafireOutcome {
  if (/g-recaptcha|h-captcha|cf-turnstile|captcha/i.test(html) && !/id="downloadButton"/.test(html)) {
    return { kind: 'restricted', reason: 'MediaFire is showing a captcha — not bypassed' };
  }
  if (/This file is password protected|password-protected file|id="pwd_form"|name="downloadp"/i.test(html)) {
    return { kind: 'restricted', reason: 'MediaFire file is password protected — not bypassed' };
  }
  if (/Invalid or Deleted File|File Removed for Violation|The key you provided for file access was invalid|file you requested was removed/i.test(html)) {
    return { kind: 'dead', reason: 'MediaFire file is deleted or invalid' };
  }
  if (/dangerous file|has been blocked|blocked for violation/i.test(html) && !/id="downloadButton"/.test(html)) {
    return { kind: 'restricted', reason: 'MediaFire blocked this file' };
  }
  const btn = html.match(/<a[^>]*id="downloadButton"[^>]*>/i)?.[0];
  if (btn) {
    let href = btn.match(/href="([^"]+)"/)?.[1];
    const scrambled = btn.match(/data-scrambled-url="([^"]+)"/)?.[1];
    if ((!href || !/^https?:/.test(href)) && scrambled) {
      // The page's own script base64-decodes this attribute into the button href.
      try {
        href = Buffer.from(scrambled, 'base64').toString('utf8');
      } catch {
        href = undefined;
      }
    }
    if (href && /^https?:\/\/download\d*\.mediafire\.com\//.test(href)) {
      const filename = html.match(/<div class="filename">([^<]+)<\/div>/)?.[1]?.trim();
      const size = btn.match(/\(([\d.]+\s*[KMG]B)\)/i)?.[1] ?? html.match(/Download \(([\d.]+\s*[KMG]B)\)/i)?.[1];
      return { kind: 'link', url: href.replace(/&amp;/g, '&'), filename, size };
    }
  }
  return { kind: 'unknown' };
}

export const mediafireResolver: HostResolver = {
  id: 'mediafire',
  label: 'MediaFire public file',
  matches: (u) => /(^|\.)mediafire\.com$/.test(u.hostname),
  async resolve(u, ctx) {
    if (/^download\d*\.mediafire\.com$/.test(u.hostname)) return { url: u.toString() };
    if (u.pathname.startsWith('/folder/')) {
      throw new FetchFailure('restricted', 'MediaFire folder link: expand it to file links during discovery (folder API) before queueing');
    }
    const { text } = await ctx.http.getText(u.toString(), { maxBytes: 3 * 1024 * 1024 });
    const out = interpretMediafireHtml(text);
    if (out.kind === 'link') return { url: out.url, filename: out.filename };
    if (out.kind === 'restricted') throw new FetchFailure('restricted', out.reason);
    if (out.kind === 'dead') throw new FetchFailure('dead-link', out.reason);
    throw new FetchFailure('restricted', 'MediaFire page did not contain a public download link');
  },
};
