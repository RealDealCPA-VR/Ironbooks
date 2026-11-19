/**
 * The multi-user proxy's per-launch secret (work package G3, item 1).
 *
 * The app server on 127.0.0.1 takes a request for a teammate's when it carries x-bka-remote-addr
 * (and, in middleware, sec-bka-proxy: 1). Any program on this computer can send both straight to
 * 127.0.0.1 and claim any teammate's address: it gained no privilege (remote-level trust), but it
 * could spend that teammate's per-device sign-in lockout and put a false address in session and
 * audit records. While the shell has given the server a proxy secret (BKA_PROXY_SECRET), only a
 * request carrying it (stamped by electron/hosting.js) counts as proxied; any other one claiming
 * an address is "this computer, outside Ironbooks" and its claim is not used. Without a secret
 * (`next dev`, the tests, the e2e scripts) everything is as before.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { LAUNCH_PASS_COOKIE, LAUNCH_PASS_ENV, LAUNCH_PASS_HEADER } from './launchPass';
import { UNVERIFIED_LOCAL_ADDR, cookieSecure, originFromHeaders } from './requestInfo';
import { PROXY_SECRET_ENV, PROXY_SECRET_HEADER, carriesProxySecret, expectedProxySecret, isProxiedRequest } from './loopbackHost';
import { GLOBAL_KEY_WEIGHT, attemptKeys, loginLimiter } from './rateLimit';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const hostingCore = require('../../electron/hostingCore.js');

const SECRET = 'b7'.repeat(32);
const PASS = 'a1'.repeat(32);
const TEAMMATE = '100.64.0.7';
const h = (headers: Record<string, string>) => new Headers(headers);
/** What the proxy forwards for a teammate (electron/hosting.js createProxyHandler). */
const proxied = (extra: Record<string, string> = {}) =>
  h({ 'x-bka-remote-addr': TEAMMATE, 'sec-bka-proxy': '1', 'x-forwarded-proto': 'https', [PROXY_SECRET_HEADER]: SECRET, ...extra });
/** A program on this computer sending the proxy's headers itself. */
const forged = (extra: Record<string, string> = {}) =>
  h({ 'x-bka-remote-addr': TEAMMATE, 'sec-bka-proxy': '1', 'x-forwarded-proto': 'https', 'user-agent': 'curl/8', ...extra });

afterEach(() => {
  delete process.env[PROXY_SECRET_ENV];
  delete process.env[LAUNCH_PASS_ENV];
});

describe('the shell and the server agree on the names', () => {
  it('environment variable and header', () => {
    expect(hostingCore.PROXY_SECRET_ENV).toBe(PROXY_SECRET_ENV);
    expect(hostingCore.PROXY_SECRET_HEADER).toBe(PROXY_SECRET_HEADER);
    expect(PROXY_SECRET_ENV).toBe('BKA_PROXY_SECRET');
  });
});

describe('expectedProxySecret / carriesProxySecret', () => {
  it('is not enforced without a secret (dev server, tests, e2e scripts)', () => {
    expect(expectedProxySecret({})).toBeNull();
    expect(expectedProxySecret({ [PROXY_SECRET_ENV]: '' })).toBeNull();
    expect(expectedProxySecret({ [PROXY_SECRET_ENV]: SECRET })).toBe(SECRET);
    expect(carriesProxySecret(h({}), null)).toBe(true);
  });

  it('accepts exactly this launch\'s secret and nothing else', () => {
    expect(carriesProxySecret(h({ [PROXY_SECRET_HEADER]: SECRET }), SECRET)).toBe(true);
    for (const bad of ['', 'wrong', SECRET.slice(1), SECRET + '0', SECRET.toUpperCase(), 'c8'.repeat(32), `${SECRET}, ${SECRET}`]) {
      expect(carriesProxySecret(h({ [PROXY_SECRET_HEADER]: bad }), SECRET), bad).toBe(false);
    }
    expect(carriesProxySecret(h({}), SECRET)).toBe(false);
    // The launch pass is not the proxy secret.
    expect(carriesProxySecret(h({ [PROXY_SECRET_HEADER]: PASS, [LAUNCH_PASS_HEADER]: SECRET }), SECRET)).toBe(false);
  });
});

describe('originFromHeaders with a proxy secret configured', () => {
  it('forged proxy headers without the stamp: this computer, outside Ironbooks; the claimed address is ignored', () => {
    process.env[PROXY_SECRET_ENV] = SECRET;
    const o = originFromHeaders(forged());
    expect(o).toEqual({ remote: true, addr: UNVERIFIED_LOCAL_ADDR, https: false, userAgent: 'curl/8' });
    expect(JSON.stringify(o)).not.toContain(TEAMMATE);
    expect(cookieSecure(o)).toBe(false);
    // A wrong stamp is no stamp.
    expect(originFromHeaders(forged({ [PROXY_SECRET_HEADER]: 'c8'.repeat(32) })).addr).toBe(UNVERIFIED_LOCAL_ADDR);
    expect(originFromHeaders(forged({ [PROXY_SECRET_HEADER]: '' })).addr).toBe(UNVERIFIED_LOCAL_ADDR);
  });

  it('still remote-level trust when it also carries the launch pass (it is not the app window)', () => {
    process.env[PROXY_SECRET_ENV] = SECRET;
    process.env[LAUNCH_PASS_ENV] = PASS;
    const o = originFromHeaders(forged({ cookie: `${LAUNCH_PASS_COOKIE}=${PASS}`, [LAUNCH_PASS_HEADER]: PASS }));
    expect(o.remote).toBe(true);
    expect(o.addr).toBe(UNVERIFIED_LOCAL_ADDR);
  });

  it('with the stamp: a teammate through the proxy, with their real address', () => {
    process.env[PROXY_SECRET_ENV] = SECRET;
    expect(originFromHeaders(proxied({ 'user-agent': 'Ironbooks/2' }))).toEqual({
      remote: true,
      addr: TEAMMATE,
      https: true,
      userAgent: 'Ironbooks/2',
    });
  });

  it('requests without x-bka-remote-addr are unchanged (launch pass rules)', () => {
    process.env[PROXY_SECRET_ENV] = SECRET;
    expect(originFromHeaders(h({}))).toEqual({ remote: false, addr: 'local', https: false, userAgent: null });
    process.env[LAUNCH_PASS_ENV] = PASS;
    expect(originFromHeaders(h({})).addr).toBe(UNVERIFIED_LOCAL_ADDR);
    expect(originFromHeaders(h({ [LAUNCH_PASS_HEADER]: PASS }))).toEqual({ remote: false, addr: 'local', https: false, userAgent: null });
    // The stamp alone makes nothing remote or local.
    expect(originFromHeaders(h({ [LAUNCH_PASS_HEADER]: PASS, [PROXY_SECRET_HEADER]: SECRET })).remote).toBe(false);
  });
});

describe('no proxy secret configured: exactly as before', () => {
  it('x-bka-remote-addr alone is a proxied teammate', () => {
    expect(originFromHeaders(forged())).toEqual({ remote: true, addr: TEAMMATE, https: true, userAgent: 'curl/8' });
    expect(originFromHeaders(h({ 'x-bka-remote-addr': '192.168.1.20' })).addr).toBe('192.168.1.20');
  });

  it('isProxiedRequest needs both headers, as before', () => {
    expect(isProxiedRequest(h({ 'x-bka-remote-addr': '1.2.3.4', 'sec-bka-proxy': '1' }))).toBe(true);
    expect(isProxiedRequest(h({ 'x-bka-remote-addr': '1.2.3.4' }))).toBe(false);
    expect(isProxiedRequest(h({ 'sec-bka-proxy': '1' }))).toBe(false);
  });
});

describe('isProxiedRequest with a proxy secret configured', () => {
  it('both headers are not enough; the stamp is needed too', () => {
    process.env[PROXY_SECRET_ENV] = SECRET;
    expect(isProxiedRequest(forged())).toBe(false);
    expect(isProxiedRequest(forged({ [PROXY_SECRET_HEADER]: 'c8'.repeat(32) }))).toBe(false);
    expect(isProxiedRequest(proxied())).toBe(true);
    // The stamp without the other two is not a proxied request either.
    expect(isProxiedRequest(h({ [PROXY_SECRET_HEADER]: SECRET }))).toBe(false);
    expect(isProxiedRequest(h({ [PROXY_SECRET_HEADER]: SECRET, 'x-bka-remote-addr': TEAMMATE }))).toBe(false);
  });

  it('the expected value can be passed in (middleware and tests read the same rule)', () => {
    expect(isProxiedRequest(forged(), SECRET)).toBe(false);
    expect(isProxiedRequest(proxied(), SECRET)).toBe(true);
    expect(isProxiedRequest(forged(), null)).toBe(true);
  });
});

describe("a program on this computer cannot spend a teammate's sign-in attempts", () => {
  it('its guesses are counted under its own address, never the one it claims', () => {
    process.env[PROXY_SECRET_ENV] = SECRET;
    const g = globalThis as unknown as { __bkaLoginLimiter?: unknown };
    g.__bkaLoginLimiter = undefined;
    const limiter = loginLimiter();
    const t0 = 1_700_000_000_000;
    // Exactly what the sign-in route does with each request's origin.
    const guess = (headers: Headers, now: number) => {
      const keys = attemptKeys('login', 'pat@co.com', originFromHeaders(headers).addr);
      const weights = { [keys[keys.length - 1]]: GLOBAL_KEY_WEIGHT };
      const gate = limiter.begin(keys, now, weights);
      if (!gate.allowed) return keys;
      limiter.recordFailure(keys, now, weights);
      gate.release();
      return keys;
    };
    let keys: string[] = [];
    for (let i = 0; i < 8; i++) keys = guess(forged(), t0 + i);
    expect(keys.join('|')).not.toContain(TEAMMATE);
    expect(keys.join('|')).toContain(UNVERIFIED_LOCAL_ADDR);
    // Pat, through the proxy from their own computer, can still sign in.
    expect(limiter.check(attemptKeys('login', 'pat@co.com', originFromHeaders(proxied()).addr), t0 + 20).allowed).toBe(true);
    g.__bkaLoginLimiter = undefined;
  });
});
