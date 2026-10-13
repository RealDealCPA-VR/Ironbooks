import { describe, it, expect } from 'vitest';
import { classifyHost, inCidr4, inCidr6, normalizeHost, parseIPv4, parseIPv6 } from './cidr';

describe('parseIPv4 / inCidr4', () => {
  it('parses dotted quads and rejects junk', () => {
    expect(parseIPv4('100.64.0.1')).toBe(0x64400001);
    expect(parseIPv4('256.1.1.1')).toBeNull();
    expect(parseIPv4('1.2.3')).toBeNull();
    expect(parseIPv4('a.b.c.d')).toBeNull();
  });

  it('matches CIDR boundaries exactly', () => {
    expect(inCidr4('100.64.0.0', '100.64.0.0/10')).toBe(true);
    expect(inCidr4('100.127.255.255', '100.64.0.0/10')).toBe(true);
    expect(inCidr4('100.128.0.0', '100.64.0.0/10')).toBe(false);
    expect(inCidr4('100.63.255.255', '100.64.0.0/10')).toBe(false);
    expect(inCidr4('172.31.255.255', '172.16.0.0/12')).toBe(true);
    expect(inCidr4('172.32.0.0', '172.16.0.0/12')).toBe(false);
    expect(inCidr4('8.8.8.8', '0.0.0.0/0')).toBe(true);
    expect(inCidr4('10.0.0.1', '10.0.0.1/32')).toBe(true);
  });
});

describe('parseIPv6 / inCidr6', () => {
  it('expands :: compression and embedded IPv4', () => {
    expect(parseIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6('fd7a:115c:a1e0::1')).toEqual([0xfd7a, 0x115c, 0xa1e0, 0, 0, 0, 0, 1]);
    expect(parseIPv6('::ffff:10.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0a00, 0x0001]);
    expect(parseIPv6('1::2::3')).toBeNull();
    expect(parseIPv6('12345::')).toBeNull();
  });
  it('matches prefixes', () => {
    expect(inCidr6(parseIPv6('fd7a:115c:a1e0:ab12::5')!, 'fd7a:115c:a1e0::/48')).toBe(true);
    expect(inCidr6(parseIPv6('fd7a:115c:a1e1::5')!, 'fd7a:115c:a1e0::/48')).toBe(false);
    expect(inCidr6(parseIPv6('fc00::1')!, 'fc00::/7')).toBe(true);
    expect(inCidr6(parseIPv6('fdff::1')!, 'fc00::/7')).toBe(true);
    expect(inCidr6(parseIPv6('fe00::1')!, 'fc00::/7')).toBe(false);
  });
});

describe('classifyHost', () => {
  it.each([
    ['localhost', 'loopback'],
    ['LOCALHOST.', 'loopback'],
    ['127.0.0.1', 'loopback'],
    ['127.8.9.10', 'loopback'],
    ['::1', 'loopback'],
    ['[::1]', 'loopback'],
    ['10.1.2.3', 'lan'],
    ['172.16.0.9', 'lan'],
    ['192.168.1.20', 'lan'],
    ['fd12:3456::1', 'lan'],
    ['100.64.0.1', 'tailnet'],
    ['100.101.102.103', 'tailnet'],
    ['100.127.255.254', 'tailnet'],
    ['fd7a:115c:a1e0::1234', 'tailnet'],
    // *.ts.net is public until DNS shows it is on the tailnet (Funnel names are public).
    ['office-pc.tail1234.ts.net', 'public'],
    ['OFFICE-PC.TAIL1234.TS.NET.', 'public'],
    ['100.128.0.1', 'public'],
    ['8.8.8.8', 'public'],
    ['172.32.0.1', 'public'],
    ['api.anthropic.com', 'public'],
    ['ts.net', 'public'],
    ['evil-ts.net', 'public'],
    ['2606:4700::1111', 'public'],
    ['::ffff:8.8.8.8', 'public'],
    ['::ffff:192.168.0.1', 'lan'],
    ['169.254.169.254', 'invalid'],
    ['0.0.0.0', 'invalid'],
    ['224.0.0.1', 'invalid'],
    ['255.255.255.255', 'invalid'],
    ['fe80::1', 'invalid'],
    ['::', 'invalid'],
    ['', 'invalid'],
    ['bad host!', 'invalid'],
  ])('%s → %s', (host, expected) => {
    expect(classifyHost(host)).toBe(expected);
  });

  it('canonicalizes alternative IPv4 spellings before classifying', () => {
    // WHATWG URL parsing turns these into dotted quads — they must not dodge the CIDR checks.
    expect(normalizeHost('2130706433')).toBe('127.0.0.1');
    expect(classifyHost('2130706433')).toBe('loopback');
    expect(classifyHost('0x7f.1')).toBe('loopback');
    expect(classifyHost('0xa9fea9fe')).toBe('invalid'); // 169.254.169.254
  });
});
