import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_NETWORK_POLICY,
  OUTBOUND_PURPOSES,
  decideOutbound,
  effectiveMode,
  envModeCeiling,
  normalizePolicy,
  type NetworkPolicy,
  type OutboundPurpose,
} from './policy';

// guard.ts reads the company policy from the DB; stub it so these stay pure unit tests.
const stored = vi.hoisted(() => ({ policy: null as unknown }));
vi.mock('@/lib/services/networkPolicy', () => ({
  getNetworkPolicy: async () => stored.policy,
}));
import { assertOutboundAllowed, policyFetch, recentOutbound } from './guard';
import { recordTailnetVerification } from './cidr';

const policy = (mode: NetworkPolicy['mode'], optIn: Partial<Record<OutboundPurpose, boolean>> = {}): NetworkPolicy =>
  normalizePolicy({ mode, cloudOptIn: optIn });

describe('normalizePolicy', () => {
  it('defaults to tailnet-only with every cloud purpose off except update checks', () => {
    expect(normalizePolicy(undefined)).toEqual({
      mode: 'tailnet-only',
      cloudOptIn: { ai: false, email: false, 'vendor-lookup': false, updates: true },
      vendorLookupUrl: null,
    });
    expect(DEFAULT_NETWORK_POLICY.mode).toBe('tailnet-only');
  });
  it('a stored opt-in for the removed Plaid bank feeds is dropped, not carried over', () => {
    const p = normalizePolicy({ mode: 'allow-cloud', cloudOptIn: { 'bank-feeds': true, ai: false } });
    expect(p.cloudOptIn).toEqual({ ai: false, email: false, 'vendor-lookup': false, updates: true });
    expect(Object.keys(p.cloudOptIn)).not.toContain('bank-feeds');
  });
  it('drops unknown modes/purposes and non-boolean opt-ins', () => {
    const p = normalizePolicy({ mode: 'yolo', cloudOptIn: { ai: 'yes', email: true, telemetry: true } });
    expect(p.mode).toBe('tailnet-only');
    expect(p.cloudOptIn).toEqual({ ai: false, email: true, 'vendor-lookup': false, updates: true });
  });
  it('keeps update checks off only when explicitly false', () => {
    expect(normalizePolicy({ cloudOptIn: { updates: false } }).cloudOptIn.updates).toBe(false);
    expect(normalizePolicy({ cloudOptIn: { updates: 'no' } }).cloudOptIn.updates).toBe(true);
  });
});

describe('update checks (on by default)', () => {
  const FEED = 'https://github.com/RealDealCPA-VR/Ironbooks/releases';
  it('reach the release feed in tailnet-only and allow-cloud modes by default', () => {
    expect(decideOutbound(normalizePolicy(undefined), FEED, 'updates', undefined).allowed).toBe(true);
    expect(decideOutbound(policy('allow-cloud'), FEED, 'updates', undefined).allowed).toBe(true);
  });
  it('can be turned off per company in either mode', () => {
    for (const mode of ['tailnet-only', 'allow-cloud'] as const) {
      const d = decideOutbound(policy(mode, { updates: false }), FEED, 'updates', undefined);
      expect(d.allowed).toBe(false);
      expect(d.reason).toMatch(/Privacy & Network/);
    }
  });
  it('are blocked offline and by a machine ceiling below allow-cloud', () => {
    expect(decideOutbound(policy('offline'), FEED, 'updates', undefined).allowed).toBe(false);
    expect(decideOutbound(policy('allow-cloud'), FEED, 'updates', 'tailnet-only').allowed).toBe(false);
    expect(decideOutbound(policy('tailnet-only'), FEED, 'updates', 'tailnet-only').allowed).toBe(false);
    expect(decideOutbound(policy('tailnet-only'), FEED, 'updates', 'allow-cloud').allowed).toBe(true);
  });
  it('do not open the internet to any other purpose in tailnet-only mode', () => {
    const pol = policy('tailnet-only', { ai: true, email: true });
    expect(decideOutbound(pol, 'https://api.anthropic.com/v1/messages', 'ai', undefined).allowed).toBe(false);
    expect(decideOutbound(pol, 'smtps://smtp.gmail.com:465', 'email', undefined).allowed).toBe(false);
  });
});

describe('effectiveMode / env ceiling', () => {
  it('takes the more restrictive of company mode and ceiling', () => {
    expect(effectiveMode('allow-cloud', 'offline')).toBe('offline');
    expect(effectiveMode('allow-cloud', 'tailnet-only')).toBe('tailnet-only');
    expect(effectiveMode('offline', 'allow-cloud')).toBe('offline');
    expect(effectiveMode('tailnet-only', undefined)).toBe('tailnet-only');
  });
  it('reads BKA_NETWORK_MODE and ignores junk', () => {
    expect(envModeCeiling({ BKA_NETWORK_MODE: 'offline' })).toBe('offline');
    expect(envModeCeiling({ BKA_NETWORK_MODE: 'nope' })).toBe('offline'); // typo fails closed
    expect(envModeCeiling({ BKA_NETWORK_MODE: '  ' })).toBeUndefined();
    expect(envModeCeiling({})).toBeUndefined();
  });
});

describe('decideOutbound — per mode and purpose', () => {
  const CLOUD = 'https://api.anthropic.com/v1/messages';
  const TAILNET = 'http://100.100.1.2:11434/api';
  const MAGICDNS = 'https://gpu-box.tail1234.ts.net/v1';
  const LAN = 'smtp://192.168.1.5:25';
  const LOCAL = 'http://127.0.0.1:8080/';

  it('offline: only loopback, for every purpose', () => {
    for (const p of OUTBOUND_PURPOSES) {
      // Vendor lookup relays to public search engines, so offline refuses it even on this computer.
      expect(decideOutbound(policy('offline', { [p]: true }), LOCAL, p, undefined).allowed).toBe(p !== 'vendor-lookup');
      expect(decideOutbound(policy('offline'), TAILNET, p, undefined).allowed).toBe(false);
      expect(decideOutbound(policy('offline'), LAN, p, undefined).allowed).toBe(false);
      expect(decideOutbound(policy('offline', { [p]: true }), CLOUD, p, undefined).allowed).toBe(false);
    }
  });

  it('tailnet-only (default): loopback + LAN + tailnet, never the internet — even when opted in (update checks aside)', () => {
    // The MagicDNS name was resolved to a tailnet address (lib/net/tailnetVerify.ts).
    recordTailnetVerification('gpu-box.tail1234.ts.net', true);
    for (const p of OUTBOUND_PURPOSES) {
      const pol = policy('tailnet-only', { [p]: true });
      expect(decideOutbound(pol, LOCAL, p, undefined).allowed).toBe(true);
      expect(decideOutbound(pol, LAN, p, undefined).allowed).toBe(true);
      expect(decideOutbound(pol, TAILNET, p, undefined).allowed).toBe(true);
      expect(decideOutbound(pol, MAGICDNS, p, undefined).allowed).toBe(true);
      if (p === 'updates') continue; // version-only release check; see 'update checks' below
      const d = decideOutbound(pol, CLOUD, p, undefined);
      expect(d.allowed).toBe(false);
      expect(d.hostClass).toBe('public');
      expect(d.reason).toMatch(/Privacy & Network/);
    }
  });

  it('allow-cloud: public destinations only for opted-in purposes', () => {
    const pol = policy('allow-cloud', { ai: true, updates: false });
    expect(decideOutbound(pol, CLOUD, 'ai', undefined).allowed).toBe(true);
    expect(decideOutbound(pol, 'smtps://smtp.gmail.com:465', 'email', undefined).allowed).toBe(false);
    expect(decideOutbound(pol, 'https://github.com/', 'updates', undefined).allowed).toBe(false);
    // Private destinations need no opt-in.
    expect(decideOutbound(pol, LAN, 'email', undefined).allowed).toBe(true);
  });

  it('the machine ceiling overrides a company opt-in', () => {
    const pol = policy('allow-cloud', { ai: true });
    expect(decideOutbound(pol, CLOUD, 'ai', 'tailnet-only').allowed).toBe(false);
    expect(decideOutbound(pol, TAILNET, 'ai', 'offline').allowed).toBe(false);
  });

  it('never allows unroutable/special destinations, bad protocols or URL credentials', () => {
    const pol = policy('allow-cloud', { ai: true, email: true });
    expect(decideOutbound(pol, 'http://169.254.169.254/latest/meta-data', 'ai', undefined).allowed).toBe(false);
    expect(decideOutbound(pol, 'http://0.0.0.0:80/', 'ai', undefined).allowed).toBe(false);
    expect(decideOutbound(pol, 'file:///etc/passwd', 'ai', undefined).allowed).toBe(false);
    expect(decideOutbound(pol, 'ftp://192.168.1.1/', 'ai', undefined).allowed).toBe(false);
    expect(decideOutbound(pol, 'https://user:pw@api.anthropic.com/', 'ai', undefined).allowed).toBe(false);
    expect(decideOutbound(pol, 'not a url', 'ai', undefined).allowed).toBe(false);
  });

  it('cannot be tricked by numeric IPv4 spellings', () => {
    const pol = policy('tailnet-only');
    // 0x08080808 = 8.8.8.8 — public, so blocked in tailnet-only mode.
    expect(decideOutbound(pol, 'http://0x08080808/', 'ai', undefined).allowed).toBe(false);
    expect(decideOutbound(pol, 'http://134744072/', 'ai', undefined).allowed).toBe(false);
  });
});

describe('guard — assertOutboundAllowed / policyFetch', () => {
  const ctx = { db: {} as never, companyId: 'co-guard-test' };
  let fetchSpy: ReturnType<typeof vi.fn>;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('throws FORBIDDEN (and logs the attempt) when blocked', async () => {
    stored.policy = policy('tailnet-only');
    await expect(assertOutboundAllowed('https://api.anthropic.com/', 'ai', ctx)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const log = recentOutbound(ctx.companyId);
    expect(log[0]).toMatchObject({ purpose: 'ai', host: 'api.anthropic.com', allowed: false });
  });

  it('policyFetch never contacts a blocked destination', async () => {
    stored.policy = policy('tailnet-only');
    await expect(
      policyFetch('https://api.anthropic.com/v1/messages', { method: 'POST' }, { purpose: 'ai', ctx }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('re-checks every redirect hop (allowed tailnet host → public host is refused)', async () => {
    stored.policy = policy('tailnet-only');
    fetchSpy.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'https://exfil.example.com/steal' } }),
    );
    await expect(
      policyFetch('http://100.100.1.2:8080/start', undefined, { purpose: 'ai', ctx }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('follows allowed redirects and strips credentials across origins', async () => {
    stored.policy = policy('tailnet-only');
    fetchSpy
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: 'http://100.100.1.3/next' } }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const res = await policyFetch(
      'http://100.100.1.2/start',
      { method: 'GET', headers: { authorization: 'Bearer secret', 'content-type': 'text/plain' } },
      { purpose: 'ai', ctx },
    );
    expect(await res.text()).toBe('ok');
    const [secondUrl, secondInit] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(secondUrl).toBe('http://100.100.1.3/next');
    const h = new Headers(secondInit.headers);
    expect(h.get('authorization')).toBeNull();
    expect(h.get('content-type')).toBe('text/plain');
  });

  it('307/308 keep method + body on the same origin, but never resend a body to another origin', async () => {
    stored.policy = policy('tailnet-only');
    fetchSpy
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: '/next' } }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    await policyFetch('http://100.100.1.2/start', { method: 'POST', body: 'x' }, { purpose: 'email', ctx });
    const [, sameInit] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(sameInit.method).toBe('POST');
    expect(sameInit.body).toBe('x');

    fetchSpy.mockReset();
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 308, headers: { location: 'http://100.100.1.3/x' } }));
    await expect(
      policyFetch('http://100.100.1.2/start', { method: 'POST', body: '{"secret":"s"}' }, { purpose: 'email', ctx }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
