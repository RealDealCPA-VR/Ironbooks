/**
 * P2 security: *.ts.net names are tailnet only when they RESOLVE to tailnet addresses.
 * Tailscale Funnel names under ts.net resolve to public relay addresses, so they must be treated
 * as cloud (opt-in + AI redaction), not as the private tailnet. DNS is mocked.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { classifyHost, clearTailnetVerifications, TAILNET_VERIFY_TTL_MS, isVerifiedTailnetName } from './cidr';
import { setHostLookup, verifyTailnetName, verifyTailnetUrls } from './tailnetVerify';
import { decideOutbound, DEFAULT_NETWORK_POLICY } from './policy';
import { classifyEndpoint } from '@/lib/ai/tailnet';
import { localityOf } from '@/lib/ai/providers';

const DNS: Record<string, string[]> = {
  'gpu-box.tail1234.ts.net': ['100.101.1.5', 'fd7a:115c:a1e0::5'],
  'somehost.tail1234.ts.net': ['198.51.100.7'], // Funnel: public relay
  'mixed.tail1234.ts.net': ['100.101.1.6', '203.0.113.4'],
};
const lookups: string[] = [];
function mockDns() {
  setHostLookup(async (h) => {
    lookups.push(h);
    if (!(h in DNS)) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    return DNS[h];
  });
}

afterEach(() => {
  setHostLookup(null);
  clearTailnetVerifications();
  lookups.length = 0;
});

describe('*.ts.net classification needs DNS proof', () => {
  it('an unverified *.ts.net name is public (cloud), not tailnet', () => {
    expect(classifyHost('somehost.tailxxxx.ts.net')).toBe('public');
    const d = decideOutbound(DEFAULT_NETWORK_POLICY, 'https://somehost.tailxxxx.ts.net/v1/chat/completions', 'ai', undefined);
    expect(d.hostClass).toBe('public');
    expect(d.allowed).toBe(false);
    expect(localityOf({ kind: 'openai-compatible', baseUrl: 'https://somehost.tailxxxx.ts.net/v1' } as never)).toBe('cloud');
  });

  it('a MagicDNS name resolving only to tailnet addresses (IPv4 + IPv6) is tailnet', async () => {
    mockDns();
    expect(await verifyTailnetName('gpu-box.tail1234.ts.net')).toBe(true);
    expect(classifyHost('gpu-box.tail1234.ts.net')).toBe('tailnet');
    expect(classifyEndpoint('http://gpu-box.tail1234.ts.net:11434').isPrivate).toBe(true);
    expect(localityOf({ kind: 'ollama', baseUrl: 'http://gpu-box.tail1234.ts.net:11434' } as never)).toBe('local');
    const d = decideOutbound(DEFAULT_NETWORK_POLICY, 'http://gpu-box.tail1234.ts.net:11434/api/chat', 'ai', undefined);
    expect(d).toMatchObject({ allowed: true, hostClass: 'tailnet' });
  });

  it('a Funnel name (public relay address), a mixed answer, or no answer stays public', async () => {
    mockDns();
    expect(await verifyTailnetName('somehost.tail1234.ts.net')).toBe(false);
    expect(await verifyTailnetName('mixed.tail1234.ts.net')).toBe(false);
    expect(await verifyTailnetName('nxdomain.tail1234.ts.net')).toBe(false);
    for (const h of ['somehost.tail1234.ts.net', 'mixed.tail1234.ts.net', 'nxdomain.tail1234.ts.net']) {
      expect(classifyHost(h)).toBe('public');
      expect(classifyEndpoint(`https://${h}/v1`).isPrivate).toBe(false);
    }
  });

  it('a verification expires, and a later public answer revokes it', async () => {
    mockDns();
    await verifyTailnetName('gpu-box.tail1234.ts.net');
    expect(isVerifiedTailnetName('gpu-box.tail1234.ts.net', Date.now() + TAILNET_VERIFY_TTL_MS + 1)).toBe(false);
    await verifyTailnetName('gpu-box.tail1234.ts.net');
    DNS['gpu-box.tail1234.ts.net'] = ['198.51.100.9']; // re-pointed at a public address
    expect(await verifyTailnetName('gpu-box.tail1234.ts.net')).toBe(false);
    expect(classifyHost('gpu-box.tail1234.ts.net')).toBe('public');
    DNS['gpu-box.tail1234.ts.net'] = ['100.101.1.5', 'fd7a:115c:a1e0::5'];
  });

  it('only *.ts.net names are looked up', async () => {
    mockDns();
    await verifyTailnetUrls(['https://api.anthropic.com/v1', 'http://100.64.0.1:11434', 'not a url', null, 'http://gpu-box.tail1234.ts.net:11434']);
    expect(lookups).toEqual(['gpu-box.tail1234.ts.net']);
    expect(await verifyTailnetName('evil-ts.net')).toBe(false);
    expect(lookups).toEqual(['gpu-box.tail1234.ts.net']);
  });
});
