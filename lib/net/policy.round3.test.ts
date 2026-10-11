/**
 * Re-test round 2 (tester): policyFetch's cross-origin header allowlist.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { normalizePolicy } from './policy';

const stored = vi.hoisted(() => ({ policy: null as unknown }));
vi.mock('@/lib/services/networkPolicy', () => ({
  getNetworkPolicy: async () => stored.policy,
}));
import { policyFetch } from './guard';

describe('policyFetch — cross-origin header allowlist', () => {
  const ctx = { db: {} as never, companyId: 'co-round3-guard' };
  let fetchSpy: ReturnType<typeof vi.fn>;
  const realFetch = globalThis.fetch;
  const redirect = (status: number, location: string) => new Response(null, { status, headers: { location } });
  const hdrs = (i: number) => new Headers((fetchSpy.mock.calls[i] as [string, RequestInit])[1].headers);

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    stored.policy = normalizePolicy({ mode: 'tailnet-only' });
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const secrets: Record<string, string> = {
    Authorization: 'Bearer a',
    'Proxy-Authorization': 'Basic b',
    Cookie: 'sid=c',
    'X-Api-Key': 'd',
    'anthropic-api-key': 'e',
    'X-Goog-Api-Key': 'f',
    'X-Auth-Token': 'g',
    'PLAID-SECRET': 'h',
    'PLAID-CLIENT-ID': 'i',
  };

  it.each([
    ['plain object', (): HeadersInit => ({ ...secrets, Accept: 'application/json', 'User-Agent': 'bka' })],
    ['Headers instance', (): HeadersInit => new Headers({ ...secrets, Accept: 'application/json', 'User-Agent': 'bka' })],
    [
      'tuple array',
      (): HeadersInit => [...Object.entries(secrets), ['Accept', 'application/json'], ['User-Agent', 'bka']] as [string, string][],
    ],
  ])('drops every credential-like header on a cross-origin hop (%s)', async (_n, make) => {
    fetchSpy.mockResolvedValueOnce(redirect(302, 'http://100.64.0.10/n')).mockResolvedValueOnce(new Response('ok'));
    await policyFetch('http://100.64.0.9/x', { headers: make() }, { purpose: 'bank-feeds', ctx });
    const h = hdrs(1);
    for (const k of Object.keys(secrets)) expect(h.get(k), k).toBeNull();
    expect(h.get('accept')).toBe('application/json');
    expect(h.get('user-agent')).toBe('bka');
  });

  it('same-origin redirects keep credentials', async () => {
    fetchSpy.mockResolvedValueOnce(redirect(302, '/v2')).mockResolvedValueOnce(new Response('ok'));
    await policyFetch('http://100.64.0.9/v1', { headers: secrets }, { purpose: 'ai', ctx });
    expect(hdrs(1).get('authorization')).toBe('Bearer a');
    expect(hdrs(1).get('x-api-key')).toBe('d');
  });

  it('credentials stay dropped when a later hop comes back to the original origin', async () => {
    fetchSpy
      .mockResolvedValueOnce(redirect(302, 'http://100.64.0.10/bounce'))
      .mockResolvedValueOnce(redirect(302, 'http://100.64.0.9/back'))
      .mockResolvedValueOnce(new Response('ok'));
    await policyFetch('http://100.64.0.9/x', { headers: secrets }, { purpose: 'ai', ctx });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(hdrs(2).get('authorization')).toBeNull();
    expect(hdrs(2).get('cookie')).toBeNull();
  });

  it('http -> https on the same host is a different origin, so credentials are dropped', async () => {
    fetchSpy.mockResolvedValueOnce(redirect(301, 'https://100.64.0.9/x')).mockResolvedValueOnce(new Response('ok'));
    await policyFetch('http://100.64.0.9/x', { headers: secrets }, { purpose: 'ai', ctx });
    expect(hdrs(1).get('authorization')).toBeNull();
  });

  it('a cross-origin redirect to a blocked host is refused before any request reaches it', async () => {
    fetchSpy.mockResolvedValueOnce(redirect(302, 'https://evil.example.com/collect'));
    await expect(policyFetch('http://100.64.0.9/x', { headers: secrets }, { purpose: 'ai', ctx })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a 303 cross-origin after POST drops the body and still allowlists headers', async () => {
    fetchSpy.mockResolvedValueOnce(redirect(303, 'http://100.64.0.10/r')).mockResolvedValueOnce(new Response('ok'));
    await policyFetch(
      'http://100.64.0.9/x',
      { method: 'POST', body: '{"secret":"s"}', headers: { ...secrets, 'Content-Type': 'application/json' } },
      { purpose: 'email', ctx },
    );
    const [, init2] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(init2.method).toBe('GET');
    expect(init2.body).toBeUndefined();
    expect(hdrs(1).get('authorization')).toBeNull();
  });

  it('the caller-supplied init object is not mutated', async () => {
    fetchSpy.mockResolvedValueOnce(redirect(302, 'http://100.64.0.10/n')).mockResolvedValueOnce(new Response('ok'));
    const init: RequestInit = { headers: { ...secrets } };
    await policyFetch('http://100.64.0.9/x', init, { purpose: 'ai', ctx });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer a');
    expect(init.redirect).toBeUndefined();
  });
});
