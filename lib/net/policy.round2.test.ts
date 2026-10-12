/**
 * Re-test round 1 (tester): the fail-closed BKA_NETWORK_MODE ceiling, and policyFetch's
 * refusal to replay request bodies / credentials to a different origin after a redirect.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { decideOutbound, envModeCeiling, normalizePolicy, type OutboundPurpose } from './policy';

const stored = vi.hoisted(() => ({ policy: null as unknown }));
vi.mock('@/lib/services/networkPolicy', () => ({
  getNetworkPolicy: async () => stored.policy,
}));
import { policyFetch } from './guard';

const pol = (mode: 'offline' | 'tailnet-only' | 'allow-cloud', optIn: Partial<Record<OutboundPurpose, boolean>> = {}) =>
  normalizePolicy({ mode, cloudOptIn: optIn });

describe('envModeCeiling — fail closed', () => {
  it.each([
    ['OFFLINE', 'offline'],
    ['\toffline\n', 'offline'],
    ['TAILNET-ONLY', 'tailnet-only'],
    ['Allow-Cloud', 'allow-cloud'],
    // Set but unrecognised: never "no ceiling".
    ['allow_cloud', 'offline'],
    ['tailnet', 'offline'],
    ['none', 'offline'],
    ['0', 'offline'],
    ['false', 'offline'],
    ['off line', 'offline'],
  ])('%j -> %s', (raw, want) => {
    expect(envModeCeiling({ BKA_NETWORK_MODE: raw })).toBe(want);
  });

  it('unset or blank means no ceiling', () => {
    expect(envModeCeiling({})).toBeUndefined();
    expect(envModeCeiling({ BKA_NETWORK_MODE: '' })).toBeUndefined();
    expect(envModeCeiling({ BKA_NETWORK_MODE: '   ' })).toBeUndefined();
  });

  it('a typo ceiling blocks an allow-cloud company with every opt-in, for every purpose and class except loopback', () => {
    const p = pol('allow-cloud', { ai: true, email: true, 'bank-feeds': true, updates: true });
    const ceiling = envModeCeiling({ BKA_NETWORK_MODE: 'Offlien' });
    for (const purpose of ['ai', 'email', 'bank-feeds', 'updates'] as const) {
      expect(decideOutbound(p, 'https://api.anthropic.com/v1/messages', purpose, ceiling).allowed).toBe(false);
      expect(decideOutbound(p, 'http://100.64.0.2/', purpose, ceiling).allowed).toBe(false);
      expect(decideOutbound(p, 'http://192.168.0.2/', purpose, ceiling).allowed).toBe(false);
      expect(decideOutbound(p, 'http://127.0.0.1:3000/', purpose, ceiling).allowed).toBe(true);
    }
  });

  it('an allow-cloud ceiling never loosens a tailnet-only company', () => {
    const p = pol('tailnet-only', { ai: true });
    const d = decideOutbound(p, 'https://api.anthropic.com/', 'ai', envModeCeiling({ BKA_NETWORK_MODE: 'ALLOW-CLOUD' }));
    expect(d.allowed).toBe(false);
    expect(d.mode).toBe('tailnet-only');
  });

  it('the default ceiling argument reads process.env (case-insensitively)', () => {
    const prev = process.env.BKA_NETWORK_MODE;
    try {
      process.env.BKA_NETWORK_MODE = 'OFFLINE';
      expect(decideOutbound(pol('tailnet-only'), 'http://100.64.0.2/', 'ai').allowed).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.BKA_NETWORK_MODE;
      else process.env.BKA_NETWORK_MODE = prev;
    }
  });
});

describe('policyFetch — body / credential replay on redirect', () => {
  const ctx = { db: {} as never, companyId: 'co-round2-guard' };
  let fetchSpy: ReturnType<typeof vi.fn>;
  const realFetch = globalThis.fetch;
  const redirect = (status: number, location: string) => new Response(null, { status, headers: { location } });

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    stored.policy = pol('tailnet-only');
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it.each([307, 308])('cross-origin %i after POST/PUT/PATCH/DELETE (any case) is refused before the second request', async (status) => {
    for (const method of ['POST', 'put', 'Patch', 'DELETE']) {
      fetchSpy.mockReset();
      fetchSpy.mockResolvedValueOnce(redirect(status, 'http://100.64.0.10/steal'));
      await expect(
        policyFetch('http://100.64.0.9/x', { method, body: '{"secret":"s"}' }, { purpose: 'bank-feeds', ctx }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    }
  });

  it('a different PORT on the same host is a different origin (body not replayed)', async () => {
    fetchSpy.mockResolvedValueOnce(redirect(307, 'http://100.64.0.9:8081/x'));
    await expect(
      policyFetch('http://100.64.0.9/x', { method: 'POST', body: 'b' }, { purpose: 'ai', ctx }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('same-origin 307 after POST replays method and body (legit API behaviour)', async () => {
    fetchSpy.mockResolvedValueOnce(redirect(307, '/v2/x')).mockResolvedValueOnce(new Response('ok'));
    await policyFetch('http://100.64.0.9/v1/x', { method: 'POST', body: 'b' }, { purpose: 'ai', ctx });
    const [u2, init2] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(u2).toBe('http://100.64.0.9/v2/x');
    expect(init2.method).toBe('POST');
    expect(init2.body).toBe('b');
  });

  it('cross-origin 302 after POST becomes a bodyless GET with credentials stripped', async () => {
    fetchSpy.mockResolvedValueOnce(redirect(302, 'http://100.64.0.10/done')).mockResolvedValueOnce(new Response('ok'));
    await policyFetch(
      'http://100.64.0.9/x',
      { method: 'POST', body: 'b', headers: { Authorization: 'Bearer t' } },
      { purpose: 'ai', ctx },
    );
    const [, init2] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(init2.method).toBe('GET');
    expect(init2.body).toBeUndefined();
    expect(new Headers(init2.headers).get('authorization')).toBeNull();
  });

  it('cross-origin redirect strips Proxy-Authorization too (it is a credential header)', async () => {
    fetchSpy.mockResolvedValueOnce(redirect(302, 'http://100.64.0.10/n')).mockResolvedValueOnce(new Response('ok'));
    await policyFetch(
      'http://100.64.0.9/x',
      { headers: { 'Proxy-Authorization': 'Basic dXNlcjpwYXNz' } },
      { purpose: 'updates', ctx },
    );
    const [, init2] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(new Headers(init2.headers).get('proxy-authorization')).toBeNull();
  });
});
