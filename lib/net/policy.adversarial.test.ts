/**
 * Adversarial QA for the local-only network policy (tester pass): address-spelling tricks,
 * cross-purpose opt-in leakage, malformed stored policy, redirect abuse in policyFetch, and
 * that the activity log never captures payload-bearing parts of a URL.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { classifyHost } from './cidr';
import { decideOutbound, envModeCeiling, normalizePolicy, OUTBOUND_PURPOSES, type OutboundPurpose } from './policy';

const stored = vi.hoisted(() => ({ policy: null as unknown }));
vi.mock('@/lib/services/networkPolicy', () => ({
  getNetworkPolicy: async () => stored.policy,
}));
import { policyFetch, recentOutbound, checkOutbound } from './guard';

const pol = (mode: 'offline' | 'tailnet-only' | 'allow-cloud', optIn: Partial<Record<OutboundPurpose, boolean>> = {}) =>
  normalizePolicy({ mode, cloudOptIn: optIn });

describe('classifyHost — spellings that must not escape their class', () => {
  it.each([
    // IPv4-mapped IPv6 in HEX form (not dotted) must still classify the embedded IPv4.
    ['::ffff:7f00:1', 'loopback'],
    ['::ffff:a9fe:a9fe', 'invalid'], // 169.254.169.254 (cloud metadata)
    ['[::ffff:a9fe:a9fe]', 'invalid'],
    ['::ffff:6440:1', 'tailnet'], // 100.64.0.1
    ['::ffff:808:808', 'public'], // 8.8.8.8
    // Decimal / octal / short spellings of the metadata address.
    ['2852039166', 'invalid'],
    ['0251.0376.0251.0376', 'invalid'],
    ['169.254.43518', 'invalid'],
    // CGNAT boundaries.
    ['100.63.255.255', 'public'],
    ['100.127.255.255', 'tailnet'],
    // RFC1918 boundaries.
    ['172.15.255.255', 'public'],
    ['172.31.255.255', 'lan'],
    ['192.167.255.255', 'public'],
    ['11.0.0.0', 'public'],
    // Name tricks.
    ['office.ts.net.evil.com', 'public'],
    ['evilts.net', 'public'],
    ['localhost.evil.com', 'public'],
    ['127.0.0.1.nip.io', 'public'],
    ['100.64.0.1.sslip.io', 'public'],
    ['intranet', 'public'],
    // 0.0.0.0 short spelling ("0") connects to this machine on most stacks — must never be
    // treated as a public/allowed host.
    ['0', 'invalid'],
  ])('%s → %s', (host, expected) => {
    expect(classifyHost(host)).toBe(expected);
  });

  it('never throws on hostile input', () => {
    for (const h of ['[', ']', '[::1', '::1]', '%00', 'a'.repeat(5000), '..', '.', '\u0000', '::::', '1.2.3.4.5']) {
      expect(() => classifyHost(h)).not.toThrow();
      expect(['public', 'invalid']).toContain(classifyHost(h));
    }
    // Non-string input (JS callers) is invalid, not a crash.
    expect(classifyHost(undefined as unknown as string)).toBe('invalid');
    expect(classifyHost(42 as unknown as string)).toBe('invalid');
  });
});

describe('decideOutbound — adversarial', () => {
  it('opting in one purpose never opens another', () => {
    for (const p of OUTBOUND_PURPOSES) {
      // Update checks are on by default, so turn them off explicitly unless they are the one opted in.
      const policy = pol('allow-cloud', { updates: false, [p]: true });
      for (const q of OUTBOUND_PURPOSES) {
        const d = decideOutbound(policy, 'https://api.example.com/', q, undefined);
        expect(d.allowed).toBe(p === q);
      }
    }
  });

  it('even an all-opted-in cloud policy refuses metadata, multicast and IPv6 link-local', () => {
    const all = pol('allow-cloud', { ai: true, email: true, updates: true });
    for (const url of [
      'http://[::ffff:a9fe:a9fe]/latest/meta-data',
      'http://2852039166/',
      'http://[fe80::1]/',
      'http://224.0.0.251/',
      'http://0/',
      'smtp://169.254.1.1:25',
    ]) {
      expect(decideOutbound(all, url, 'ai', undefined).allowed, url).toBe(false);
    }
  });

  it('refuses non-network protocols for every purpose even to loopback', () => {
    const all = pol('allow-cloud', { ai: true, email: true, updates: true });
    for (const url of ['file:///C:/Windows/win.ini', 'data:text/plain,hi', 'javascript:alert(1)', 'ws://127.0.0.1/', 'gopher://127.0.0.1/']) {
      expect(decideOutbound(all, url, 'ai', undefined).allowed, url).toBe(false);
    }
  });

  it('an unknown purpose (e.g. from an untrusted query string) is refused, even to loopback', () => {
    const d = decideOutbound(pol('allow-cloud'), 'http://127.0.0.1/', 'AI' as OutboundPurpose, undefined);
    expect(d.allowed).toBe(false);
    const d2 = decideOutbound(pol('allow-cloud'), 'http://127.0.0.1/', '__proto__' as OutboundPurpose, undefined);
    expect(d2.allowed).toBe(false);
  });

  it('a tampered stored policy cannot opt in via truthy non-booleans or prototype keys', () => {
    const p = normalizePolicy(JSON.parse('{"mode":"allow-cloud","cloudOptIn":{"ai":"true","email":1,"__proto__":{"email":true}}}'));
    expect(p.cloudOptIn).toEqual({ ai: false, email: false, updates: true });
    expect(decideOutbound(p, 'smtps://smtp.example.com:465', 'email', undefined).allowed).toBe(false);
    expect(normalizePolicy({ mode: 'ALLOW-CLOUD' }).mode).toBe('tailnet-only');
    expect(normalizePolicy('allow-cloud').mode).toBe('tailnet-only');
    expect(normalizePolicy(null).mode).toBe('tailnet-only');
  });

  it('machine ceiling: an operator writing BKA_NETWORK_MODE=OFFLINE (any case / padding) is honoured', () => {
    // The ceiling only ever restricts — a typo in case must not silently fail OPEN to the
    // company's (possibly allow-cloud) setting.
    expect(envModeCeiling({ BKA_NETWORK_MODE: ' offline ' })).toBe('offline');
    expect(envModeCeiling({ BKA_NETWORK_MODE: 'OFFLINE' })).toBe('offline');
    expect(envModeCeiling({ BKA_NETWORK_MODE: 'Tailnet-Only' })).toBe('tailnet-only');
  });
});

describe('policyFetch — redirect abuse', () => {
  const ctx = { db: {} as never, companyId: 'co-adversarial-guard' };
  let fetchSpy: ReturnType<typeof vi.fn>;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    stored.policy = pol('tailnet-only');
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const redirect = (status: number, location: string) => new Response(null, { status, headers: { location } });

  it('protocol-relative redirect to a public host is refused before contacting it', async () => {
    fetchSpy.mockResolvedValueOnce(redirect(302, '//exfil.example.com/x'));
    await expect(policyFetch('http://192.168.1.5/a', undefined, { purpose: 'ai', ctx })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('redirect to the cloud metadata address (decimal spelling) is refused', async () => {
    stored.policy = pol('allow-cloud', { ai: true });
    fetchSpy.mockResolvedValueOnce(redirect(301, 'http://2852039166/latest/meta-data/'));
    await expect(policyFetch('https://api.example.com/', undefined, { purpose: 'ai', ctx })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('redirect to file: is refused', async () => {
    fetchSpy.mockResolvedValueOnce(redirect(302, 'file:///etc/passwd'));
    await expect(policyFetch('http://100.64.0.9/', undefined, { purpose: 'updates', ctx })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('an endless redirect loop stops (FORBIDDEN) after a bounded number of hops', async () => {
    fetchSpy.mockImplementation(async () => redirect(302, 'http://100.64.0.9/loop'));
    await expect(policyFetch('http://100.64.0.9/loop', undefined, { purpose: 'ai', ctx })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it('cross-origin redirect strips cookie and x-api-key too, whatever the header container', async () => {
    fetchSpy
      .mockResolvedValueOnce(redirect(307, 'http://100.64.0.10/next'))
      .mockResolvedValueOnce(new Response('ok'));
    await policyFetch(
      'http://100.64.0.9/start',
      {
        // GET: a cross-origin 307/308 never replays a request BODY at all (see guard.ts).
        method: 'GET',
        headers: [
          ['Authorization', 'Bearer s3cret'],
          ['Cookie', 'sid=abc'],
          ['X-Api-Key', 'sk-ant-xyz'],
          ['Accept', 'application/json'],
        ],
      },
      { purpose: 'ai', ctx },
    );
    const h = new Headers((fetchSpy.mock.calls[1] as [string, RequestInit])[1].headers);
    expect(h.get('authorization')).toBeNull();
    expect(h.get('cookie')).toBeNull();
    expect(h.get('x-api-key')).toBeNull();
    expect(h.get('accept')).toBe('application/json');
  });

  it('same-origin redirect keeps credentials; 303 after POST becomes a bodyless GET', async () => {
    fetchSpy
      .mockResolvedValueOnce(redirect(303, '/done'))
      .mockResolvedValueOnce(new Response('ok'));
    await policyFetch(
      'http://100.64.0.9/start',
      { method: 'POST', body: 'payload', headers: { authorization: 'Bearer keep' } },
      { purpose: 'ai', ctx },
    );
    const [url2, init2] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(url2).toBe('http://100.64.0.9/done');
    expect(init2.method).toBe('GET');
    expect(init2.body).toBeUndefined();
    expect(new Headers(init2.headers).get('authorization')).toBe('Bearer keep');
  });

  it('never follows redirects natively (redirect: manual is forced even if caller asked to follow)', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('ok'));
    await policyFetch('http://100.64.0.9/', { redirect: 'follow' }, { purpose: 'ai', ctx });
    expect((fetchSpy.mock.calls[0] as [string, RequestInit])[1].redirect).toBe('manual');
  });

  it('the activity log keeps host + purpose only — never paths, query strings or userinfo', async () => {
    const c2 = { db: {} as never, companyId: 'co-log-privacy' };
    fetchSpy.mockResolvedValue(new Response('ok'));
    await policyFetch('http://100.64.0.9/customers/ACME-SECRET?token=TOPSECRET123', undefined, { purpose: 'ai', ctx: c2 });
    await checkOutbound('https://api.anthropic.com/v1/messages?key=TOPSECRET456', 'ai', c2);
    const dump = JSON.stringify(recentOutbound(c2.companyId));
    expect(dump).not.toMatch(/TOPSECRET|ACME-SECRET/);
    // and entries are per company
    expect(recentOutbound('some-other-company')).toEqual([]);
  });
});
