/**
 * middleware.ts, review round 3:
 *  - DNS rebinding: a request naming a host other than this computer is refused unless it came
 *    through the multi-user proxy (which always stamps x-bka-remote-addr);
 *  - CSRF: a state-changing API request from another site or another port on localhost (same
 *    site, different origin) is refused; the app's own same-origin requests and non-browser
 *    callers (no Sec-Fetch-Site) are not.
 */
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../middleware';
import { classifyHost } from '../lib/net/cidr';

const req = (url: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
  new NextRequest(url, { method: init.method ?? 'GET', headers: init.headers });

describe('middleware: DNS rebinding', () => {
  it('refuses a request for another host name that did not come through the proxy', async () => {
    const res = middleware(req('http://evil.example:51234/api/company'));
    expect(res.status).toBe(403);
  });

  it('lets this computer and proxied teammates through', () => {
    expect(middleware(req('http://localhost:51234/api/company')).status).toBe(200);
    expect(middleware(req('http://127.0.0.1:51234/api/company')).status).toBe(200);
    expect(middleware(req('https://office-pc:8443/api/company', { headers: { 'x-bka-remote-addr': '192.168.1.20' } })).status).toBe(200);
  });
});

describe('middleware: cross-site requests', () => {
  it('refuses a POST from another site or another localhost port', () => {
    for (const site of ['cross-site', 'same-site']) {
      const res = middleware(req('http://localhost:51234/api/users', { method: 'POST', headers: { 'sec-fetch-site': site } }));
      expect(res.status).toBe(403);
    }
  });

  it('allows the app itself, the desktop shell, and reads', () => {
    expect(middleware(req('http://localhost:51234/api/users', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(200);
    expect(middleware(req('http://localhost:51234/api/users', { method: 'POST' })).status).toBe(200);
    expect(middleware(req('http://localhost:51234/api/users', { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(200);
  });
});

describe('network policy: localhost', () => {
  it('only the name localhost itself is this computer', () => {
    expect(classifyHost('localhost')).toBe('loopback');
    expect(classifyHost('ollama.localhost')).not.toBe('loopback');
  });
});
