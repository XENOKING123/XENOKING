import type { HostResolver } from './index.js';

/**
 * OneDrive public share links via the documented Shares API:
 *   GET https://api.onedrive.com/v1.0/shares/u!{base64url(shareUrl)}/root/content
 * Works only for anonymous ("anyone with the link") shares; others return 401/403 -> restricted.
 */
export function oneDriveShareContentUrl(shareUrl: string): string {
  const b64 = Buffer.from(shareUrl, 'utf8').toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
  return `https://api.onedrive.com/v1.0/shares/u!${b64}/root/content`;
}

export const onedriveResolver: HostResolver = {
  id: 'onedrive',
  label: 'OneDrive public share',
  matches: (u) => ['1drv.ms', 'onedrive.live.com'].includes(u.hostname) || /\.sharepoint\.com$/.test(u.hostname),
  async resolve(u) {
    return { url: oneDriveShareContentUrl(u.toString()) };
  },
};
