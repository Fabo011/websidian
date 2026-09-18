import { BadRequestException } from '@nestjs/common';
import { assertPublicHttpUrl, isBlockedAddress } from './ssrf-guard';

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1', // loopback
    '169.254.169.254', // cloud metadata (link-local)
    '10.0.0.5', // RFC1918
    '172.16.0.1', // RFC1918
    '192.168.1.1', // RFC1918
    '100.64.0.1', // carrier-grade NAT
    '0.0.0.0', // unspecified
    '::1', // IPv6 loopback
    'fe80::1', // IPv6 link-local
    'fc00::1', // IPv6 unique-local
    '::ffff:10.0.0.1', // IPv4-mapped private
    'not-an-ip', // unparseable -> fail closed
  ])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '93.184.216.34', // example.com
    '2606:2800:220:1:248:1893:25c8:1946', // public IPv6
  ])('allows public %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe('assertPublicHttpUrl', () => {
  it('accepts a normal https host', () => {
    expect(() =>
      assertPublicHttpUrl('https://cloud.example.com/remote.php/dav'),
    ).not.toThrow();
  });

  it('accepts a public IP literal', () => {
    expect(() => assertPublicHttpUrl('https://1.1.1.1')).not.toThrow();
  });

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:5432',
    'https://10.0.0.5',
    'http://[::1]/',
  ])('rejects private/metadata literal %s', (url) => {
    expect(() => assertPublicHttpUrl(url)).toThrow(BadRequestException);
  });

  it.each(['file:///etc/passwd', 'gopher://x', 'ftp://host/'])(
    'rejects non-http scheme %s',
    (url) => {
      expect(() => assertPublicHttpUrl(url)).toThrow(BadRequestException);
    },
  );

  it('rejects garbage', () => {
    expect(() => assertPublicHttpUrl('not a url')).toThrow(BadRequestException);
  });
});
