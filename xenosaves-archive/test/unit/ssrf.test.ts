import { describe, expect, it } from 'vitest';
import { assertPublicDns, assertSafeUrl, isPrivateAddress, UnsafeUrlError } from '../../src/net/ssrf.js';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '198.18.0.1', '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2002:7f00:1::1', '2001:db8::1',
  ])('blocks %s', (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '140.82.112.3', '185.199.108.133', '2606:4700:4700::1111', '::ffff:8.8.8.8', '172.32.0.1'])(
    'allows public %s',
    (ip) => expect(isPrivateAddress(ip)).toBe(false),
  );

  it('treats garbage as unsafe', () => expect(isPrivateAddress('not-an-ip')).toBe(true));
});

describe('assertSafeUrl', () => {
  it('accepts public https URLs', () => {
    expect(assertSafeUrl('https://raw.githubusercontent.com/a/b/c.zip').hostname).toBe('raw.githubusercontent.com');
  });
  it.each([
    ['file:///etc/passwd', /scheme/],
    ['ftp://example.com/x.zip', /scheme/],
    ['gopher://example.com/', /scheme/],
    ['http://user:pw@example.com/x.zip', /credentials/],
    ['http://localhost/x', /host not allowed/],
    ['http://foo.internal/x', /host not allowed/],
    ['http://printer.local/x', /host not allowed/],
    ['http://127.0.0.1/x', /private/],
    ['http://[::1]/x', /private/],
    ['http://169.254.169.254/latest/meta-data/', /private/],
    ['http://example.com:8080/x', /port/],
    ['http://intranet/x', /host not allowed/],
  ])('rejects %s', (url, re) => {
    expect(() => assertSafeUrl(url)).toThrow(UnsafeUrlError);
    expect(() => assertSafeUrl(url)).toThrow(re);
  });
  it('allowPrivate (tests only) skips host checks but never allows other schemes', () => {
    expect(assertSafeUrl('http://127.0.0.1:9999/x', { allowPrivate: true }).port).toBe('9999');
    expect(() => assertSafeUrl('file:///etc/passwd', { allowPrivate: true })).toThrow(/scheme/);
  });
});

describe('assertPublicDns', () => {
  it('rejects literal private IPs', async () => {
    await expect(assertPublicDns('10.0.0.5')).rejects.toThrow(/private/);
  });
  it('rejects names that resolve to loopback', async () => {
    await expect(assertPublicDns('localhost')).rejects.toThrow(/private/);
  });
});
