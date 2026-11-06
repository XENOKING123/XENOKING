import type { HostResolver } from './index.js';

/** Dropbox shared links: the documented `dl=1` parameter forces a direct download of a public link. */
export const dropboxResolver: HostResolver = {
  id: 'dropbox',
  label: 'Dropbox shared link',
  matches: (u) => /(^|\.)dropbox\.com$/.test(u.hostname) || u.hostname === 'dl.dropboxusercontent.com',
  async resolve(u) {
    if (u.hostname === 'dl.dropboxusercontent.com') return { url: u.toString() };
    const out = new URL(u.toString());
    out.searchParams.delete('dl');
    out.searchParams.delete('raw');
    out.searchParams.set('dl', '1');
    return { url: out.toString() };
  },
};
