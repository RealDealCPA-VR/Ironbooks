/**
 * middleware.ts, review round 3:
 *  - DNS rebinding: a request naming a host other than this computer is refused unless it came
 *    through the multi-user proxy (which always stamps x-bka-remote-addr and sec-bka-proxy);
 *  - CSRF: a state-changing API request from another site or another port on localhost (same
 *    site, different origin) is refused; the app's own same-origin requests and non-browser
 *    callers (no Sec-Fetch-Site) are not.
 *
 * Requests are built the way the real server hands them to middleware: the standalone server
 * listens on 127.0.0.1, and Next.js builds req.nextUrl from THAT address (it always says
 * localhost), while the name the caller used only arrives in the Host header. The old tests put
 * the hostile name in the URL, which the real server never does, so they passed while the guard
 * let every rebinding page through (security plan 1.1a).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../middleware';
import { classifyHost } from '../lib/net/cidr';
import { PROXY_SECRET_ENV, PROXY_SECRET_HEADER } from '../lib/net/loopbackHost';

const SERVER = 'http://localhost:51234';

/** A request as the server sees it: its own URL, the caller's Host header (null: none sent). */
const req = (route: string, init: { method?: string; host?: string | null; headers?: Record<string, string> } = {}) => {
  const headers = new Headers(init.headers);
  const host = init.host === undefined ? 'localhost:51234' : init.host;
  if (host === null) headers.delete('host');
  else headers.set('host', host);
  return new NextRequest(`${SERVER}${route}`, { method: init.method ?? 'GET', headers });
};

describe('middleware: DNS rebinding', () => {
  it('builds requests like the real server (the premise of these tests)', () => {
    const r = req('/api/company-file/info', { host: 'evil.example:51234' });
    expect(r.nextUrl.hostname).toBe('localhost');
    expect(r.headers.get('host')).toBe('evil.example:51234');
  });

  it('refuses a request whose Host names another computer and did not come through the proxy', async () => {
    for (const host of ['evil.example:51234', 'evil.example', '192.168.1.5:51234', 'localhost.evil.com:51234', '[::2]:51234', '']) {
      const res = middleware(req('/api/company-file/info', { host }));
      expect(res.status, host).toBe(403);
      expect((await res.json()).code).toBe('FORBIDDEN');
    }
    // Pages too, not only the API.
    expect(middleware(req('/login', { host: 'evil.example:51234' })).status).toBe(403);
  });

  it('lets this computer and proxied teammates through', () => {
    for (const host of ['localhost:51234', '127.0.0.1:51234', 'LOCALHOST:51234', '[::1]:51234', '127.0.0.1']) {
      expect(middleware(req('/api/company', { host })).status, host).toBe(200);
    }
    expect(
      middleware(
        req('/api/company', { host: 'office-pc:8443', headers: { 'x-bka-remote-addr': '192.168.1.20', 'sec-bka-proxy': '1' } }),
      ).status,
    ).toBe(200);
  });

  it('lets a request with no Host header through (only a program on this computer can omit it)', () => {
    // Every browser names the host, so this is never a rebinding page; such a program already
    // reaches 127.0.0.1 directly and gets no more trust than a teammate without the launch pass.
    const r = req('/api/company', { host: null });
    expect(r.headers.get('host')).toBeNull();
    expect(middleware(r).status).toBe(200);
  });

  it('refuses a rebinding page that adds its own x-bka-remote-addr (it cannot set a Sec- header)', () => {
    expect(
      middleware(req('/api/company-file/info', { host: 'evil.example:51234', headers: { 'x-bka-remote-addr': '1.2.3.4' } })).status,
    ).toBe(403);
    expect(
      middleware(req('/api/company-file/info', { host: 'evil.example:51234', headers: { 'sec-bka-proxy': '1' } })).status,
    ).toBe(403);
  });
});

describe('middleware: the multi-user proxy secret (work package G3)', () => {
  // Any program on this computer can send x-bka-remote-addr and sec-bka-proxy to 127.0.0.1 itself.
  // While the shell has given the server a proxy secret, only the proxy's stamp of it makes a
  // request "proxied" (exempt from the Host rule); anything else is held to the Host rule.
  const SECRET = 'd2'.repeat(32);
  const proxyHeaders = { 'x-bka-remote-addr': '192.168.1.20', 'sec-bka-proxy': '1' };
  afterEach(() => {
    delete process.env[PROXY_SECRET_ENV];
  });

  it('refuses forged proxy headers naming a hostile host when they lack the stamp', async () => {
    process.env[PROXY_SECRET_ENV] = SECRET;
    for (const stamp of [null, 'wrong', 'e3'.repeat(32), '']) {
      const headers: Record<string, string> = { ...proxyHeaders };
      if (stamp !== null) headers[PROXY_SECRET_HEADER] = stamp;
      for (const host of ['evil.example:51234', 'office-pc:8443', '192.168.1.5:47800']) {
        const res = middleware(req('/api/company-file/info', { host, headers }));
        expect(res.status, `${host} ${stamp}`).toBe(403);
        expect((await res.json()).code).toBe('FORBIDDEN');
      }
    }
  });

  it('forged proxy headers on a loopback Host pass the ordinary Host rule (and are classed remote later)', () => {
    process.env[PROXY_SECRET_ENV] = SECRET;
    expect(middleware(req('/api/company', { host: '127.0.0.1:51234', headers: proxyHeaders })).status).toBe(200);
  });

  it("lets the proxy's own requests through on the host name the teammate used", () => {
    process.env[PROXY_SECRET_ENV] = SECRET;
    const headers = { ...proxyHeaders, [PROXY_SECRET_HEADER]: SECRET };
    for (const host of ['office-pc:8443', 'office-pc.tail1234.ts.net:47800', '192.168.1.5:47800']) {
      expect(middleware(req('/api/company', { host, headers })).status, host).toBe(200);
    }
  });

  it('no proxy secret configured: the two headers are enough, as before', () => {
    expect(middleware(req('/api/company', { host: 'office-pc:8443', headers: proxyHeaders })).status).toBe(200);
  });
});

describe('middleware: cross-site requests', () => {
  it('refuses a POST from another site or another localhost port', () => {
    for (const site of ['cross-site', 'same-site']) {
      const res = middleware(req('/api/users', { method: 'POST', headers: { 'sec-fetch-site': site } }));
      expect(res.status).toBe(403);
    }
  });

  it('allows the app itself, the desktop shell, and reads', () => {
    expect(middleware(req('/api/users', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(200);
    expect(middleware(req('/api/users', { method: 'POST', host: '127.0.0.1:51234' })).status).toBe(200);
    expect(middleware(req('/api/users', { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(200);
  });
});

describe('network policy: localhost', () => {
  it('only the name localhost itself is this computer', () => {
    expect(classifyHost('localhost')).toBe('loopback');
    expect(classifyHost('ollama.localhost')).not.toBe('loopback');
  });
});
