import { FetchFailure, type HttpClient } from '../net/http.js';
import type { DownloadResult } from '../net/download.js';

/**
 * File-host resolvers turn a *published link* into a direct download request using each host's
 * supported API or its normal public download workflow. They run again on every attempt, so
 * expiring direct URLs are never persisted. Anything gated (login, captcha, password, quota,
 * paywall, private file) raises a 'restricted' failure — it is recorded, never bypassed.
 */
export interface ResolvedDownload {
  url: string;
  headers?: Record<string, string>;
  filename?: string;
  size?: number;
  /** Hosts with a non-HTTP transfer protocol (MEGA) download through their own client. */
  custom?: (dest: string, opts: { maxBytes: number; onProgress?: (b: number, t: number | null) => void }) => Promise<DownloadResult>;
}

export interface HostContext {
  http: HttpClient;
  googleApiKey?: string;
}

export interface HostResolver {
  id: string;
  label: string;
  matches(u: URL): boolean;
  resolve(u: URL, ctx: HostContext): Promise<ResolvedDownload>;
}

import { githubResolver } from './github.js';
import { dropboxResolver } from './dropbox.js';
import { onedriveResolver } from './onedrive.js';
import { gdriveResolver } from './gdrive.js';
import { mediafireResolver } from './mediafire.js';
import { megaResolver } from './mega.js';
import { directResolver } from './direct.js';

export const RESOLVERS: HostResolver[] = [
  githubResolver,
  dropboxResolver,
  onedriveResolver,
  gdriveResolver,
  mediafireResolver,
  megaResolver,
  directResolver, // must stay last: generic fallback
];

export function resolverFor(url: string): HostResolver {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new FetchFailure('invalid', `invalid download URL: ${url}`);
  }
  return RESOLVERS.find((r) => r.matches(u)) ?? directResolver;
}

export function hostIdFor(url: string): string {
  try {
    return resolverFor(url).id;
  } catch {
    return 'unknown';
  }
}

/** Normalise a link for duplicate-URL detection (drop tracking params/fragments except MEGA keys). */
export function normalizeLink(url: string): string {
  try {
    const u = new URL(url);
    u.hostname = u.hostname.toLowerCase();
    if (!/mega\.(nz|co\.nz)$/.test(u.hostname)) u.hash = '';
    for (const p of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$)/i.test(p)) u.searchParams.delete(p);
    return u.toString();
  } catch {
    return url;
  }
}
