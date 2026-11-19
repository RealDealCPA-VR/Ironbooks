/**
 * Security plan 1.1c / 1.1d: the per-launch pass and the shell's start-up check.
 *
 *  - originFromHeaders (the one place every `origin.remote` check reads) treats a request that did
 *    not come through the multi-user proxy and lacks this launch's pass as REMOTE, but only while
 *    BKA_LAUNCH_PASS is set: `next dev`, the tests and the e2e scripts run without one.
 *  - GET /api/handshake answers a nonce with a keyed hash only the server holding the shell's
 *    internal token can give, and the shell (electron/localServer.js) computes the same one.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { NextRequest } from 'next/server';
import {
  LAUNCH_PASS_COOKIE,
  LAUNCH_PASS_ENV,
  LAUNCH_PASS_HEADER,
  carriesLaunchPass,
  constantTimeEqual,
} from './launchPass';
import { UNVERIFIED_LOCAL_ADDR, cookieSecure, getRequestOrigin, originFromHeaders } from './requestInfo';
import { serverCheckProof } from './internalToken';
import { isLoopbackHostHeader, isProxiedRequest } from './loopbackHost';
import { isLoopbackHostHeader as contextIsLoopbackHostHeader } from '@/lib/context';
import { GET as handshakeGET } from '@/app/api/handshake/route';
import { apiRuleFor } from '@/lib/permissions/routes';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const shell = require('../../electron/localServer.js');

const PASS = 'a1'.repeat(32);
const h = (headers: Record<string, string>) => new Headers(headers);

afterEach(() => {
  delete process.env[LAUNCH_PASS_ENV];
  delete process.env.BKA_INTERNAL_TOKEN;
});

describe('constantTimeEqual', () => {
  it('is plain equality for strings of the same length, and false otherwise', () => {
    expect(constantTimeEqual(PASS, PASS)).toBe(true);
    expect(constantTimeEqual(PASS, PASS.slice(0, -1) + '2')).toBe(false);
    expect(constantTimeEqual(PASS, PASS.slice(1))).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });
});

describe('carriesLaunchPass', () => {
  it('is not enforced without a pass (dev server, tests, e2e scripts)', () => {
    expect(carriesLaunchPass(h({}), null)).toBe(true);
  });

  it('accepts the pass as the cookie or the header, constant-time, and nothing else', () => {
    expect(carriesLaunchPass(h({}), PASS)).toBe(false);
    expect(carriesLaunchPass(h({ cookie: `bka_session=x; ${LAUNCH_PASS_COOKIE}=${PASS}; ib-theme=auto.blue` }), PASS)).toBe(true);
    expect(carriesLaunchPass(h({ [LAUNCH_PASS_HEADER]: PASS }), PASS)).toBe(true);
    expect(carriesLaunchPass(h({ cookie: `${LAUNCH_PASS_COOKIE}=${PASS.toUpperCase()}` }), PASS)).toBe(false);
    expect(carriesLaunchPass(h({ cookie: `${LAUNCH_PASS_COOKIE}=` }), PASS)).toBe(false);
    expect(carriesLaunchPass(h({ cookie: `x${LAUNCH_PASS_COOKIE}=${PASS}` }), PASS)).toBe(false);
    expect(carriesLaunchPass(h({ [LAUNCH_PASS_HEADER]: 'wrong' }), PASS)).toBe(false);
    // A page cannot push the real cookie out by adding one of its own with the same name.
    expect(carriesLaunchPass(h({ cookie: `${LAUNCH_PASS_COOKIE}=guess; ${LAUNCH_PASS_COOKIE}=${PASS}` }), PASS)).toBe(true);
  });
});

describe('originFromHeaders: the per-launch pass', () => {
  it('no pass configured: a request on this computer is local, as before', () => {
    expect(originFromHeaders(h({}))).toEqual({ remote: false, addr: 'local', https: false, userAgent: null });
  });

  it('pass configured, request without it: remote-level trust under its own address', () => {
    process.env[LAUNCH_PASS_ENV] = PASS;
    const o = originFromHeaders(h({ 'user-agent': 'curl/8', 'x-forwarded-proto': 'https' }));
    expect(o).toEqual({ remote: true, addr: UNVERIFIED_LOCAL_ADDR, https: false, userAgent: 'curl/8' });
    // Its failed sign-ins are counted apart from the person at this computer ('local' realm).
    expect(o.addr).not.toBe('local');
    expect(cookieSecure(o)).toBe(false);
    expect(originFromHeaders(h({ cookie: `${LAUNCH_PASS_COOKIE}=nope` })).remote).toBe(true);
  });

  it('pass configured, request with it: local (the window by cookie, the shell by header)', () => {
    process.env[LAUNCH_PASS_ENV] = PASS;
    expect(originFromHeaders(h({ cookie: `${LAUNCH_PASS_COOKIE}=${PASS}` }))).toEqual({
      remote: false,
      addr: 'local',
      https: false,
      userAgent: null,
    });
    expect(originFromHeaders(h({ [LAUNCH_PASS_HEADER]: PASS })).remote).toBe(false);
  });

  it('proxied requests are remote with their peer address, pass or not', () => {
    for (const pass of [undefined, PASS]) {
      if (pass) process.env[LAUNCH_PASS_ENV] = pass;
      const o = originFromHeaders(
        h({ 'x-bka-remote-addr': '100.64.0.9', 'x-forwarded-proto': 'https', cookie: `${LAUNCH_PASS_COOKIE}=${PASS}`, [LAUNCH_PASS_HEADER]: PASS }),
      );
      expect(o).toEqual({ remote: true, addr: '100.64.0.9', https: true, userAgent: null });
    }
  });

  it('outside a request (scripts, tests) still counts as local', async () => {
    process.env[LAUNCH_PASS_ENV] = PASS;
    expect((await getRequestOrigin()).remote).toBe(false);
  });
});

describe('the Host rule shared by middleware and the first-run fallback', () => {
  it('is one function, re-exported by lib/context', () => {
    expect(contextIsLoopbackHostHeader).toBe(isLoopbackHostHeader);
  });

  it('a proxied request needs both the peer address and the Sec- mark', () => {
    expect(isProxiedRequest(h({ 'x-bka-remote-addr': '1.2.3.4', 'sec-bka-proxy': '1' }))).toBe(true);
    expect(isProxiedRequest(h({ 'x-bka-remote-addr': '1.2.3.4' }))).toBe(false);
    expect(isProxiedRequest(h({ 'sec-bka-proxy': '1' }))).toBe(false);
  });
});

describe('GET /api/handshake (the shell checks it started the server on that port)', () => {
  const ask = (nonce: string | null) =>
    handshakeGET(new NextRequest(`http://127.0.0.1:51234/api/handshake${nonce === null ? '' : `?nonce=${nonce}`}`));
  const NONCE = 'c3'.repeat(32);

  it('is a public route, so it answers before anyone signs in', () => {
    expect(apiRuleFor('/api/handshake', 'GET')).toBe('public');
  });

  it("answers with the same keyed hash the shell expects, and nothing else", async () => {
    process.env.BKA_INTERNAL_TOKEN = 'd4'.repeat(32);
    const res = await ask(NONCE);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(Object.keys(body)).toEqual(['proof']);
    expect(body.proof).toBe(shell.handshakeProof('d4'.repeat(32), NONCE));
    expect(body.proof).toBe(serverCheckProof(NONCE));
    expect(JSON.stringify(body)).not.toContain('d4d4');
    // Another nonce, another answer: a recorded answer is useless later.
    expect((await (await ask('e5'.repeat(32))).json()).proof).not.toBe(body.proof);
  });

  it('a server holding another token gives an answer the shell rejects', async () => {
    process.env.BKA_INTERNAL_TOKEN = 'f6'.repeat(32);
    const body = await (await ask(NONCE)).json();
    expect(body.proof).not.toBe(shell.handshakeProof('d4'.repeat(32), NONCE));
  });

  it('404 without a token (not started by the desktop shell) or with a malformed nonce', async () => {
    expect((await ask(NONCE)).status).toBe(404);
    process.env.BKA_INTERNAL_TOKEN = 'd4'.repeat(32);
    for (const bad of [null, '', 'xyz', 'c3'.repeat(8), 'C3'.repeat(32), 'c3'.repeat(65), `${'c3'.repeat(32)}%0a`]) {
      expect((await ask(bad)).status, String(bad)).toBe(404);
    }
  });
});

describe('the shell and the server agree on the names', () => {
  it('cookie, header and environment variable', () => {
    expect(shell.LAUNCH_PASS_COOKIE).toBe(LAUNCH_PASS_COOKIE);
    expect(shell.LAUNCH_PASS_HEADER).toBe(LAUNCH_PASS_HEADER);
    expect(shell.LAUNCH_PASS_ENV).toBe(LAUNCH_PASS_ENV);
    expect(shell.HANDSHAKE_ROUTE).toBe('/api/handshake');
  });
});
