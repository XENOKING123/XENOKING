import type { HostResolver } from './index.js';

/** GitHub: raw files, blob pages (→ raw), /raw/ paths and release assets. */
export const githubResolver: HostResolver = {
  id: 'github',
  label: 'GitHub (raw files & release assets)',
  matches: (u) => ['raw.githubusercontent.com', 'github.com', 'objects.githubusercontent.com'].includes(u.hostname),
  async resolve(u) {
    if (u.hostname === 'github.com') {
      // /owner/repo/blob/ref/path -> raw.githubusercontent.com/owner/repo/ref/path
      const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
      if (m) return { url: `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` };
      // /owner/repo/raw/... and /owner/repo/releases/download/... redirect to the file host
    }
    return { url: u.toString() };
  },
};
