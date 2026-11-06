import dns from 'node:dns';
import net from 'node:net';

/**
 * SSRF protection: only public http(s) destinations on standard ports.
 * Checked on every request AND every redirect hop, and enforced again at socket
 * connect time (guarded DNS lookup) so DNS rebinding cannot reach private ranges.
 */

const V4_BLOCKS: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

function v4Blocked(ip: string): boolean {
  const n = v4ToInt(ip);
  return V4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (v4ToInt(base) & mask);
  });
}

function expandV6(ip: string): number[] | null {
  // returns 8 hextets
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  // embedded IPv4 tail
  const v4tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4tail) {
    const n = v4ToInt(v4tail[1]);
    s = s.slice(0, -v4tail[1].length) + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16);
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const fill = parts.length === 2 ? 8 - head.length - tail.length : 0;
  const all = [...head, ...Array(fill).fill('0'), ...tail];
  if (all.length !== 8) return null;
  return all.map((h) => parseInt(h || '0', 16));
}

function v6Blocked(ip: string): boolean {
  const h = expandV6(ip);
  if (!h) return true;
  const embeddedV4 = () => `${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`;
  if (h.every((x) => x === 0)) return true; // ::
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true; // ::1
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return v4Blocked(embeddedV4()); // ::ffff:a.b.c.d
  if (h.slice(0, 6).every((x) => x === 0)) return true; // deprecated IPv4-compatible
  if (h[0] === 0x64 && h[1] === 0xff9b) return v4Blocked(embeddedV4()); // NAT64
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h[0] & 0xff00) === 0xff00) return true; // multicast
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // documentation
  if (h[0] === 0x2002) {
    // 6to4 embeds an IPv4 address in hextets 1-2
    const v4 = `${h[1] >> 8}.${h[1] & 255}.${h[2] >> 8}.${h[2] & 255}`;
    return v4Blocked(v4);
  }
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const fam = net.isIP(ip);
  if (fam === 4) return v4Blocked(ip);
  if (fam === 6) return v6Blocked(ip);
  return true;
}

export class UnsafeUrlError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'UnsafeUrlError';
  }
}

const BLOCKED_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home.arpa', '.intranet', '.corp'];

export function assertSafeUrl(raw: string, opts: { allowPrivate?: boolean } = {}): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UnsafeUrlError(`invalid URL: ${raw}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new UnsafeUrlError(`scheme not allowed: ${u.protocol}`);
  if (u.username || u.password) throw new UnsafeUrlError('credentials in URL are not allowed');
  if (opts.allowPrivate) return u;
  if (u.port && !['80', '443'].includes(u.port)) throw new UnsafeUrlError(`port not allowed: ${u.port}`);
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || BLOCKED_SUFFIXES.some((s) => host.endsWith(s)) || !host.includes('.') && !net.isIP(host)) {
    throw new UnsafeUrlError(`host not allowed: ${host}`);
  }
  if (net.isIP(host) && isPrivateAddress(host)) throw new UnsafeUrlError(`private address not allowed: ${host}`);
  return u;
}

/** Resolve and reject hostnames that resolve to any private address (used when traffic goes via an egress proxy). */
export async function assertPublicDns(hostname: string, opts: { allowPrivate?: boolean } = {}): Promise<void> {
  if (opts.allowPrivate) return;
  const host = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new UnsafeUrlError(`private address not allowed: ${host}`);
    return;
  }
  let addrs: dns.LookupAddress[];
  try {
    addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    // When an egress proxy does DNS for us the local resolver may not resolve public names;
    // the proxy remains the enforcement point in that deployment mode.
    if (process.env.HTTPS_PROXY || process.env.https_proxy) return;
    throw new UnsafeUrlError(`DNS lookup failed for ${host}: ${(err as Error).message}`);
  }
  const bad = addrs.find((a) => isPrivateAddress(a.address));
  if (bad) throw new UnsafeUrlError(`${host} resolves to private address ${bad.address}`);
}

/** dns.lookup replacement for undici's connector: refuses private results at connect time (anti-rebinding). */
export function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: dns.LookupOptions, cb: (...args: any[]) => void) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses: any) => {
      if (err) return cb(err);
      const list: dns.LookupAddress[] = Array.isArray(addresses) ? addresses : [{ address: addresses, family: 4 }];
      const ok = allowPrivate ? list : list.filter((a) => !isPrivateAddress(a.address));
      if (!ok.length) return cb(new UnsafeUrlError(`${hostname} resolves only to private addresses`));
      if ((options as any).all) return cb(null, ok);
      cb(null, ok[0].address, ok[0].family);
    });
  };
}
