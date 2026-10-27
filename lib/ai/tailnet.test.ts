import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { classifyEndpoint, classifyHost, discoverTailnetPeers, parseTailscaleStatus } from './tailnet';
import { clearTailnetVerifications, recordTailnetVerification } from '@/lib/net/cidr';

// gpu-box.tail1234.ts.net was resolved to a tailnet address (lib/net/tailnetVerify.ts).
beforeAll(() => recordTailnetVerification('gpu-box.tail1234.ts.net', true));
afterAll(() => clearTailnetVerifications());

describe('classifyHost', () => {
  it.each([
    ['localhost', 'loopback'],
    ['127.0.0.1', 'loopback'],
    ['::1', 'loopback'],
    ['[::1]', 'loopback'],
    ['100.64.0.1', 'tailnet'],
    ['100.101.102.103', 'tailnet'],
    ['100.127.255.254', 'tailnet'],
    ['100.128.0.1', 'public'], // just outside 100.64.0.0/10
    ['100.63.255.255', 'public'],
    ['gpu-box.tail1234.ts.net', 'tailnet'],
    ['funnel-box.tail1234.ts.net', 'public'], // not verified: could be a public Funnel name
    ['fd7a:115c:a1e0::1', 'tailnet'],
    ['10.0.0.5', 'lan'],
    ['172.16.4.2', 'lan'],
    ['172.32.0.1', 'public'],
    ['192.168.1.20', 'lan'],
    // Same classes as the network policy (review round 5): link-local is never called, and a
    // short or .local name could resolve anywhere, so it is not trusted with unredacted data.
    ['169.254.1.1', 'invalid'],
    ['gpu-box', 'public'],
    ['printer.local', 'public'],
    ['api.anthropic.com', 'public'],
    ['8.8.8.8', 'public'],
    ['', 'invalid'],
    ['bad host!', 'invalid'],
  ])('%s → %s', (host, expected) => {
    expect(classifyHost(host)).toBe(expected);
  });
});

describe('classifyEndpoint', () => {
  it('tailnet HTTP is private with no warning', () => {
    const c = classifyEndpoint('http://gpu-box.tail1234.ts.net:11434');
    expect(c).toMatchObject({ hostClass: 'tailnet', protocol: 'http', isPrivate: true, warning: null });
  });
  it('public HTTP gets a strong warning and is not private', () => {
    const c = classifyEndpoint('http://203.0.113.9:11434');
    expect(c.isPrivate).toBe(false);
    expect(c.warning).toMatch(/PUBLIC address over plain HTTP/);
  });
  it('public HTTPS is treated as cloud', () => {
    const c = classifyEndpoint('https://api.openai.com/v1');
    expect(c.isPrivate).toBe(false);
    expect(c.warning).toMatch(/CLOUD/);
  });
  it('rejects bad URLs and schemes', () => {
    expect(classifyEndpoint('not a url').hostClass).toBe('invalid');
    expect(classifyEndpoint('ftp://10.0.0.1').hostClass).toBe('invalid');
    expect(classifyEndpoint(null).isPrivate).toBe(false);
  });
});

const STATUS = JSON.stringify({
  BackendState: 'Running',
  MagicDNSSuffix: 'tail1234.ts.net',
  Self: { HostName: 'workstation', DNSName: 'workstation.tail1234.ts.net.', TailscaleIPs: ['100.64.0.2'], OS: 'windows', Online: true },
  Peer: {
    k1: { HostName: 'gpu-box', DNSName: 'gpu-box.tail1234.ts.net.', TailscaleIPs: ['100.101.1.5', 'fd7a:115c:a1e0::5'], OS: 'linux', Online: true },
    k2: { HostName: 'old-laptop', DNSName: 'old-laptop.tail1234.ts.net.', TailscaleIPs: ['100.101.1.9'], OS: 'macOS', Online: false },
  },
});

describe('tailscale discovery', () => {
  it('parses status JSON (online first, trailing dot stripped)', () => {
    const r = parseTailscaleStatus(STATUS);
    expect(r.available).toBe(true);
    expect(r.tailnetName).toBe('tail1234.ts.net');
    expect(r.peers.map((p) => p.hostName)).toEqual(['gpu-box', 'workstation', 'old-laptop']);
    expect(r.peers[0]).toMatchObject({ dnsName: 'gpu-box.tail1234.ts.net', online: true, self: false });
    expect(r.peers.find((p) => p.self)?.hostName).toBe('workstation');
  });

  it('reports a stopped backend as unavailable', () => {
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'Stopped' }))).toMatchObject({ available: false });
  });

  it('is graceful when the CLI is missing (mocked runner, no process spawned)', async () => {
    const missing = Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' });
    const r = await discoverTailnetPeers(async () => {
      throw missing;
    });
    expect(r).toEqual({ available: false, reason: 'Tailscale CLI not found.', peers: [] });
  });

  it('uses the mocked runner output', async () => {
    const calls: string[][] = [];
    const r = await discoverTailnetPeers(async (cmd, args) => {
      calls.push([cmd, ...args]);
      return STATUS;
    });
    expect(calls[0]).toEqual(['tailscale', 'status', '--json']);
    expect(r.peers).toHaveLength(3);
  });

  it('survives garbage output', async () => {
    const r = await discoverTailnetPeers(async () => 'not json');
    expect(r.available).toBe(false);
  });
});
