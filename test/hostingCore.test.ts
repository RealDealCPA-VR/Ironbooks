/**
 * Multi-user hosting — pure address/bind logic used by the Electron shell
 * (electron/hostingCore.js, CommonJS), plus the reverse proxy's header guarantees
 * (electron/hosting.js createProxyHandler) exercised against a real local HTTP server.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require('../electron/hostingCore.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createProxyHandler } = require('../electron/hosting.js');

describe('tailnet detection', () => {
  it('parses `tailscale ip -4` output', () => {
    expect(core.parseTailscaleIpOutput('100.101.102.103\n')).toBe('100.101.102.103');
    expect(core.parseTailscaleIpOutput('\r\n100.64.0.7\r\n')).toBe('100.64.0.7');
    expect(core.parseTailscaleIpOutput('192.168.1.4\n')).toBeNull();
    expect(core.parseTailscaleIpOutput('')).toBeNull();
  });

  it('falls back to a 100.64.0.0/10 interface address', () => {
    const ifaces = {
      Ethernet: [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      Tailscale: [
        { address: 'fd7a:115c:a1e0::1', family: 'IPv6', internal: false },
        { address: '100.88.1.2', family: 'IPv4', internal: false },
      ],
    };
    expect(core.pickTailnetIPv4FromInterfaces(ifaces)).toBe('100.88.1.2');
    expect(core.pickTailnetIPv4FromInterfaces({ eth0: [{ address: '100.128.0.1', family: 'IPv4' }] })).toBeNull();
  });
});

describe('bind-address selection', () => {
  it('binds the proxy to the tailnet IP only; the app server stays on 127.0.0.1', () => {
    const r = core.selectBindAddresses({ tailnetIp: '100.101.102.103' });
    expect(r).toMatchObject({ ok: true, serverHost: '127.0.0.1', proxyHosts: ['100.101.102.103'] });
  });

  it('never falls back to 0.0.0.0 when Tailscale is missing', () => {
    const r = core.selectBindAddresses({ tailnetIp: null });
    expect(r.ok).toBe(false);
    expect(r.proxyHosts).toEqual([]);
    expect(r.error).toMatch(/Tailscale/);
    // A non-tailnet address is not accepted as the "tailnet IP" either.
    expect(core.selectBindAddresses({ tailnetIp: '192.168.1.20' }).ok).toBe(false);
  });

  it('uses 0.0.0.0 only when explicitly chosen', () => {
    expect(core.selectBindAddresses({ tailnetIp: '100.64.0.1', bindAll: true }).proxyHosts).toEqual(['0.0.0.0']);
    expect(core.selectBindAddresses({ tailnetIp: '100.64.0.1', bindAll: 'yes' }).proxyHosts).toEqual(['100.64.0.1']);
  });

  it('builds share URLs (MagicDNS name when TLS is on)', () => {
    expect(core.shareUrls({ proxyHosts: ['100.64.0.1'], port: 47800, tls: false })).toEqual(['http://100.64.0.1:47800']);
    expect(
      core.shareUrls({ proxyHosts: ['100.64.0.1'], port: 47800, tls: true, dnsName: 'pc.tail1.ts.net' }),
    ).toEqual(['https://pc.tail1.ts.net:47800']);
    expect(core.shareUrls({ proxyHosts: ['0.0.0.0'], port: 1234, tls: false, tailnetIp: '100.64.0.9' })).toEqual([
      'http://100.64.0.9:1234',
    ]);
  });
});

describe('peer filtering + "Open company on host…" address validation', () => {
  it('admits loopback/LAN/tailnet peers only', () => {
    expect(core.isPeerAllowed('::ffff:100.70.1.1')).toBe(true);
    expect(core.isPeerAllowed('127.0.0.1')).toBe(true);
    expect(core.isPeerAllowed('192.168.0.10')).toBe(true);
    expect(core.isPeerAllowed('fd7a:115c:a1e0::9')).toBe(true);
    expect(core.isPeerAllowed('8.8.8.8')).toBe(false);
    expect(core.isPeerAllowed('::ffff:203.0.113.5')).toBe(false);
    expect(core.isPeerAllowed('2001:db8::1')).toBe(false);
  });

  it('normalizes typed addresses and adds the default port', () => {
    expect(core.normalizeHostAddress('100.101.102.103')).toMatchObject({
      ok: true,
      origin: 'http://100.101.102.103:47800',
      port: 47800,
    });
    expect(core.normalizeHostAddress('https://office-pc.tail1234.ts.net:8443')).toMatchObject({
      ok: true,
      origin: 'https://office-pc.tail1234.ts.net:8443',
    });
    expect(core.normalizeHostAddress('192.168.1.20:5000').origin).toBe('http://192.168.1.20:5000');
  });

  it('refuses public hosts, credentials, odd schemes and privileged ports', () => {
    expect(core.normalizeHostAddress('example.com').ok).toBe(false);
    expect(core.normalizeHostAddress('8.8.8.8').ok).toBe(false);
    expect(core.normalizeHostAddress('http://user:pw@100.64.0.1').ok).toBe(false);
    expect(core.normalizeHostAddress('ftp://100.64.0.1').ok).toBe(false);
    expect(core.normalizeHostAddress('100.64.0.1:80').ok).toBe(false);
    expect(core.normalizeHostAddress('').ok).toBe(false);
  });
});

describe('host proxy header guarantees', () => {
  const servers: http.Server[] = [];
  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r(null)))));
  });

  function listen(server: http.Server): Promise<number> {
    servers.push(server);
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
  }

  it('overwrites the remote-address header and strips the internal token', async () => {
    let seen: http.IncomingHttpHeaders = {};
    const upstreamPort = await listen(
      http.createServer((req, res) => {
        seen = req.headers;
        res.setHeader('set-cookie', ['a=1', 'b=2']);
        res.end('hello');
      }),
    );
    const proxyPort = await listen(http.createServer(createProxyHandler(upstreamPort, { secure: false })));

    const res = await fetch(`http://127.0.0.1:${proxyPort}/api/x?y=1`, {
      headers: {
        'x-bka-remote-addr': 'local', // forged by the client
        'x-bka-internal': 'stolen-token',
        'x-forwarded-proto': 'https',
      },
    });
    expect(await res.text()).toBe('hello');
    expect(seen['x-bka-remote-addr']).toBe('127.0.0.1');
    expect(seen['x-bka-internal']).toBeUndefined();
    expect(seen['x-forwarded-proto']).toBe('http');
    expect(res.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
  });
});
