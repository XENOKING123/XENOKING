import type { HostResolver } from './index.js';

/** Plain HTTP(S) links to an archive file. Fallback for any host without a dedicated resolver. */
export const directResolver: HostResolver = {
  id: 'direct',
  label: 'Direct HTTP(S) link',
  matches: () => true,
  async resolve(u) {
    return { url: u.toString() };
  },
};
