/**
 * Security plan Phase 3 (multi-user hosting), the Electron side:
 *  - 3.1 office-network mode listens on this computer's LAN addresses only, one listener per
 *    address, never on every interface; who may connect is the same as before (private, tailnet,
 *    loopback, never public) (electron/hostingCore.js planListeners, peerAllowedOn,
 *    lanListenerChanges);
 *  - 3.2 a 100.64.0.0/10 address counts as Tailscale's only when Tailscale confirms it;
 *  - 3.4 / 3.5 proxy robustness: Host header check, per-device connection cap, header and
 *    handshake timeouts, the desktop window's launch pass never forwarded (electron/hosting.js).
 * The decisions are pure functions tested directly; the listener wiring runs on 127.0.0.1.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require('../electron/hostingCore.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const hosting = require('../electron/hosting.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const selfSignedCert = require('../electron/selfSignedCert.js');

const OFFICE = {
  Ethernet: [
    { family: 'IPv4', address: '192.168.1.10', netmask: '255.255.255.0', internal: false },
    { family: 'IPv6', address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', internal: false },
  ],
  'Wi-Fi': [{ family: 'IPv4', address: '10.20.30.40', netmask: '255.255.0.0', internal: false }],
  Loopback: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
  Modem: [{ family: 'IPv4', address: '100.70.1.2', netmask: '255.192.0.0', internal: false }], // carrier-grade NAT
  Public: [{ family: 'IPv4', address: '203.0.113.9', netmask: '255.255.255.0', internal: false }],
};

describe('3.1 office-network mode: where the proxy listens', () => {
  it('reads each LAN address with its subnet; a too-wide or unreadable netmask means that address only', () => {
    expect(core.maskBits('255.255.255.0')).toBe(24);
    expect(core.maskBits('255.255.0.0')).toBe(16);
    expect(core.maskBits('255.255.255.255')).toBe(32);
    expect(core.maskBits('255.0.255.0')).toBeNull();
    expect(core.lanInterfaces(OFFICE)).toEqual([
      { address: '192.168.1.10', prefix: 24 },
      { address: '10.20.30.40', prefix: 16 },
    ]);
    expect(
      core.lanInterfaces({
        a: [{ family: 'IPv4', address: '10.0.0.5', netmask: '0.0.0.0', internal: false }],
        b: [{ family: 'IPv4', address: '192.168.7.7', cidr: '192.168.7.7/24', internal: false }],
        c: [{ family: 'IPv4', address: '172.16.4.4', internal: false }],
      }),
    ).toEqual([
      { address: '10.0.0.5', prefix: 32 },
      { address: '192.168.7.7', prefix: 24 },
      { address: '172.16.4.4', prefix: 32 },
    ]);
    // main.js still gets the plain address list for the certificate.
    expect(core.lanIPv4s(OFFICE)).toEqual(['192.168.1.10', '10.20.30.40']);
  });

  it('listens on each LAN address and the confirmed tailnet one, never on every interface', () => {
    const plan = core.planListeners({ lan: true, tailnetIp: '100.101.102.103', ifaces: OFFICE });
    expect(plan.ok).toBe(true);
    expect(plan.listeners).toEqual([
      { host: '192.168.1.10', kind: 'lan', prefix: 24 },
      { host: '10.20.30.40', kind: 'lan', prefix: 16 },
      { host: '100.101.102.103', kind: 'tailnet' },
    ]);
    expect(plan.listeners.map((l: { host: string }) => l.host)).not.toContain('0.0.0.0');
    // The carrier-grade NAT and public addresses are never listened on.
    expect(plan.listeners.map((l: { host: string }) => l.host)).not.toContain('100.70.1.2');
    expect(plan.listeners.map((l: { host: string }) => l.host)).not.toContain('203.0.113.9');
  });

  it('keeps the bindAll escape hatch, and the tailnet-only and "no office network" outcomes', () => {
    expect(core.planListeners({ lan: true, bindAll: true, ifaces: OFFICE }).listeners).toEqual([{ host: '0.0.0.0', kind: 'all' }]);
    expect(core.planListeners({ bindAll: true }).listeners).toEqual([{ host: '0.0.0.0', kind: 'all' }]);
    expect(core.planListeners({ bindAll: 'true', tailnetIp: '100.64.0.1' }).listeners).toEqual([{ host: '100.64.0.1', kind: 'tailnet' }]);
    expect(core.planListeners({ tailnetIp: '100.64.0.1', ifaces: OFFICE }).listeners).toEqual([{ host: '100.64.0.1', kind: 'tailnet' }]);
    const noTailscale = core.planListeners({ tailnetIp: null, ifaces: OFFICE });
    expect(noTailscale.ok).toBe(false);
    expect(noTailscale.error).toMatch(/Tailscale is not running/);
    const nowhere = core.planListeners({ lan: true, ifaces: { Public: OFFICE.Public } });
    expect(nowhere.ok).toBe(false);
    expect(nowhere.error).toMatch(/not connected to an office network/);
    // Office mode on a computer with only Tailscale still works (as before).
    expect(core.planListeners({ lan: true, tailnetIp: '100.64.0.1', ifaces: {} }).listeners).toEqual([{ host: '100.64.0.1', kind: 'tailnet' }]);
  });

  it('every listener accepts the devices it did before: private, tailnet and loopback, never public', () => {
    const office = { host: '192.168.1.10', kind: 'lan', prefix: 24 };
    const tailnet = { host: '100.101.102.103', kind: 'tailnet' };
    const all = { host: '0.0.0.0', kind: 'all' };
    // Same subnet, another routed private subnet (wired vs Wi-Fi, a guest or mesh split, a
    // site-to-site VPN), a tailnet device, a ULA, loopback: all accepted, on every listener.
    const accepted = [
      '192.168.1.55',
      '::ffff:192.168.1.55',
      '192.168.2.55',
      '10.0.0.9',
      '172.16.0.4',
      '100.64.0.9',
      'fd7a:115c:a1e0::9',
      'fd12:3456::1',
      '127.0.0.1',
    ];
    // The public internet (also mapped), link-local, unspecified, junk: refused, on every listener.
    const refused = ['8.8.8.8', '::ffff:203.0.113.5', '2001:db8::1', '169.254.1.1', 'fe80::1', '0.0.0.0', '100.128.0.1', '', undefined];
    for (const l of [office, tailnet, all]) {
      for (const peer of accepted) expect(core.peerAllowedOn(l, peer), `${l.kind} ${peer}`).toBe(true);
      for (const peer of refused) expect(core.peerAllowedOn(l, peer), `${l.kind} ${String(peer)}`).toBe(false);
      // Exactly the old rule.
      for (const peer of [...accepted, ...refused]) expect(core.peerAllowedOn(l, peer)).toBe(core.isPeerAllowed(peer));
    }
    // A LAN device reaching the tailnet address through a Tailscale subnet router with SNAT off.
    expect(core.peerAllowedOn(tailnet, '192.168.5.20')).toBe(true);
    expect(core.peerAllowedOn(null, '192.168.1.55')).toBe(false);
    expect(core.peerAllowedOn({ host: 'x', kind: 'other' }, '192.168.1.55')).toBe(false);
  });

  it('follows address changes within the networks hosting started on, never onto a new one', () => {
    const plan = core.planListeners({ lan: true, tailnetIp: '100.101.102.103', ifaces: OFFICE });
    const homeSubnets = new Set(
      plan.listeners.filter((l: { kind: string }) => l.kind === 'lan').map((l: { host: string; prefix: number }) => core.subnetKey(l.host, l.prefix)),
    );
    expect([...homeSubnets]).toEqual(['192.168.1.0/24', '10.20.0.0/16']);
    const listening = plan.listeners;
    // Nothing changed.
    expect(core.lanListenerChanges({ listening, ifaces: OFFICE, homeSubnets })).toEqual({ close: [], open: [], missed: new Map() });
    // Wi-Fi dropped: missing once is not enough (a roam or a driver blip leaves it out for a
    // moment)...
    const noWifi = { ...OFFICE, 'Wi-Fi': [] };
    const first = core.lanListenerChanges({ listening, ifaces: noWifi, homeSubnets });
    expect(first.close).toEqual([]);
    expect([...first.missed]).toEqual([['10.20.30.40', 1]]);
    // ...missing on the next check too: only its listener closes; the tailnet listener is never touched.
    const second = core.lanListenerChanges({ listening, ifaces: noWifi, homeSubnets, missed: first.missed });
    expect(second).toEqual({ close: ['10.20.30.40'], open: [], missed: new Map() });
    // Wi-Fi back with a new address from the same network: listened on again.
    const after = listening.filter((l: { host: string }) => l.host !== '10.20.30.40');
    const newAddress = { ...OFFICE, 'Wi-Fi': [{ family: 'IPv4', address: '10.20.99.1', netmask: '255.255.0.0', internal: false }] };
    expect(core.lanListenerChanges({ listening: after, ifaces: newAddress, homeSubnets })).toEqual({
      close: [],
      open: [{ host: '10.20.99.1', kind: 'lan', prefix: 16 }],
      missed: new Map(),
    });
    // The laptop taken to a café: after two checks the office listeners close, and the café
    // network is never listened on.
    const cafe = { 'Wi-Fi': [{ family: 'IPv4', address: '192.168.50.23', netmask: '255.255.255.0', internal: false }] };
    const c1 = core.lanListenerChanges({ listening, ifaces: cafe, homeSubnets });
    expect(c1).toMatchObject({ close: [], open: [] });
    expect(core.lanListenerChanges({ listening, ifaces: cafe, homeSubnets, missed: c1.missed })).toEqual({
      close: ['192.168.1.10', '10.20.30.40'],
      open: [],
      missed: new Map(),
    });
  });

  it('an address left out of the table for one check never closes a healthy listener', () => {
    const plan = core.planListeners({ lan: true, ifaces: OFFICE });
    const homeSubnets = new Set(['192.168.1.0/24', '10.20.0.0/16']);
    let missed = new Map<string, number>();
    // Every other check omits the Ethernet adapter (an adapter flapping for an instant): never closed.
    for (let i = 0; i < 20; i++) {
      const ifaces = i % 2 ? OFFICE : { ...OFFICE, Ethernet: [] };
      const r = core.lanListenerChanges({ listening: plan.listeners, ifaces, homeSubnets, missed });
      expect(r.close).toEqual([]);
      expect(r.open).toEqual([]); // still listening, so nothing is reopened either
      missed = r.missed;
    }
    // Even an empty table for one check closes nothing.
    const empty = core.lanListenerChanges({ listening: plan.listeners, ifaces: {}, homeSubnets, missed: new Map() });
    expect(empty.close).toEqual([]);
    expect(core.lanListenerChanges({ listening: plan.listeners, ifaces: OFFICE, homeSubnets, missed: empty.missed }).missed.size).toBe(0);
  });

  it('share URLs name only the listeners that started', () => {
    const lan = { host: '192.168.1.10', kind: 'lan', prefix: 24 };
    const tailnet = { host: '100.101.102.103', kind: 'tailnet' };
    expect(core.shareUrlsForListeners({ listeners: [lan, tailnet], lan: true, port: 47800 })).toEqual([
      'https://192.168.1.10:47800',
      'https://100.101.102.103:47800',
    ]);
    // 10.20.30.40 failed to start: it is not offered.
    expect(core.shareUrlsForListeners({ listeners: [tailnet], lan: true, port: 47800 })).toEqual(['https://100.101.102.103:47800']);
    expect(core.shareUrlsForListeners({ listeners: [], lan: true, port: 47800 })).toEqual([]);
    expect(core.shareUrlsForListeners({ listeners: [{ host: '0.0.0.0', kind: 'all' }], lan: true, port: 1, tailnetIp: null, ifaces: OFFICE })).toEqual([
      'https://192.168.1.10:1',
      'https://10.20.30.40:1',
    ]);
    expect(core.shareUrlsForListeners({ listeners: [tailnet], port: 47800, tls: true, dnsName: 'pc.tail1.ts.net' })).toEqual([
      'https://pc.tail1.ts.net:47800',
    ]);
  });
});

describe('3.2 the tailnet address needs Tailscale to confirm it', () => {
  const withTailscale = { ...OFFICE, Tailscale: [{ family: 'IPv4', address: '100.101.102.103', netmask: '255.255.255.255', internal: false }] };
  const running = (ip: string, state = 'Running') =>
    JSON.stringify({ BackendState: state, Self: { DNSName: 'office-pc.tail1234.ts.net.', TailscaleIPs: [ip, 'fd7a:115c:a1e0::9'] } });

  it('a carrier-grade NAT address on an interface is not Tailscale', () => {
    // No CLI, or a CLI that could not answer: no tailnet address, whatever the interfaces say.
    expect(core.confirmTailnetIPv4({ status: null, ipOutput: null, ifaces: OFFICE })).toBeNull();
    expect(core.confirmTailnetIPv4({ ifaces: OFFICE })).toBeNull();
  });

  it('reads the address and MagicDNS name from `tailscale status --json` while it is running', () => {
    const status = core.parseTailscaleStatus(running('100.101.102.103'));
    expect(status).toEqual({ running: true, ip: '100.101.102.103', dnsName: 'office-pc.tail1234.ts.net' });
    expect(core.confirmTailnetIPv4({ status, ifaces: withTailscale })).toBe('100.101.102.103');
  });

  it('stopped / signed out, or an address not on this computer, is "not running"', () => {
    for (const state of ['Stopped', 'NeedsLogin', 'Starting', 'NoState']) {
      expect(core.confirmTailnetIPv4({ status: core.parseTailscaleStatus(running('100.101.102.103', state)), ifaces: withTailscale }), state).toBeNull();
    }
    // Tailscale names an address no interface has (userspace networking, a stale answer).
    expect(core.confirmTailnetIPv4({ status: core.parseTailscaleStatus(running('100.99.9.9')), ifaces: withTailscale })).toBeNull();
    // A status that said "not running" is not overridden by `tailscale ip -4`.
    expect(
      core.confirmTailnetIPv4({ status: core.parseTailscaleStatus(running('100.101.102.103', 'Stopped')), ipOutput: '100.101.102.103\n', ifaces: withTailscale }),
    ).toBeNull();
  });

  it('`tailscale ip -4` is used only when the status cannot be read', () => {
    expect(core.parseTailscaleStatus('Tailscale is stopped.')).toBeNull();
    expect(core.parseTailscaleStatus('')).toBeNull();
    expect(core.parseTailscaleStatus('[]')).toBeNull();
    expect(core.confirmTailnetIPv4({ status: null, ipOutput: '100.101.102.103\n', ifaces: withTailscale })).toBe('100.101.102.103');
    // ...and still only for an address on this computer.
    expect(core.confirmTailnetIPv4({ status: null, ipOutput: '100.99.9.9\n', ifaces: withTailscale })).toBeNull();
    // An old CLI without BackendState: its own address list still counts as Tailscale's word.
    const old = core.parseTailscaleStatus(JSON.stringify({ Self: { TailscaleIPs: ['100.101.102.103'] } }));
    expect(old.running).toBeNull();
    expect(core.confirmTailnetIPv4({ status: old, ifaces: withTailscale })).toBe('100.101.102.103');
  });
});

describe('3.5 the Host header must name what the proxy serves', () => {
  const names = core.servedHostNames({ urls: ['https://192.168.1.10:47800', 'https://100.101.102.103:47800'], dnsName: 'Office-PC.tail1234.ts.net.' });

  it('collects the share URL hosts and the MagicDNS name', () => {
    expect([...names].sort()).toEqual(['100.101.102.103', '192.168.1.10', 'office-pc.tail1234.ts.net']);
  });

  it('accepts those names with or without the port', () => {
    const at = { names, localAddress: '192.168.1.10', localPort: 47800 };
    for (const host of ['192.168.1.10:47800', '192.168.1.10', '100.101.102.103:47800', 'office-pc.tail1234.ts.net:47800', 'OFFICE-PC.tail1234.ts.net.:47800']) {
      expect(core.isServedHost(host, at), host).toBe(true);
    }
  });

  it('refuses a rebinding page, a wrong port, and junk', () => {
    const at = { names, localAddress: '192.168.1.10', localPort: 47800 };
    for (const host of [
      'evil.example:47800',
      'evil.example',
      'office-pc:47800', // a short name could be answered by anything on the LAN
      'localhost:47800',
      '127.0.0.1:47800',
      '192.168.1.10:3000',
      '192.168.1.10:',
      '192.168.1.10.evil.example',
      'user@192.168.1.10',
      '',
      '   ',
      '[::1]:47800',
      undefined,
      null,
    ]) {
      expect(core.isServedHost(host, at), String(host)).toBe(false);
    }
  });

  it('accepts the very address the connection arrived on (bindAll: any of this computer\'s addresses)', () => {
    const at = { names: new Set<string>(), localAddress: '::ffff:10.0.0.5', localPort: 47800 };
    expect(core.isServedHost('10.0.0.5:47800', at)).toBe(true);
    expect(core.isServedHost('10.0.0.6:47800', at)).toBe(false);
    expect(core.parseHostHeader('[fd7a:115c:a1e0::9]:47800')).toEqual({ name: 'fd7a:115c:a1e0::9', port: 47800 });
  });
});

describe('3.4 connection bookkeeping', () => {
  it('caps connections per device under the overall cap, and frees a slot on close', () => {
    const conns = core.createConnectionLimiter({ maxTotal: 5, maxPerPeer: 2 });
    expect(conns.acquire('a')).toBe(true);
    expect(conns.acquire('a')).toBe(true);
    expect(conns.acquire('a')).toBe(false); // this device is at its share
    expect(conns.acquire('b')).toBe(true); // others are not affected
    expect(conns.acquire('b')).toBe(true);
    expect(conns.acquire('c')).toBe(true);
    expect(conns.acquire('d')).toBe(false); // the overall cap
    expect(conns.count()).toBe(5);
    conns.release('a');
    expect(conns.count('a')).toBe(1);
    expect(conns.acquire('d')).toBe(true);
    conns.release('zz'); // never acquired: ignored
    expect(conns.count()).toBe(5);
  });

  it('defaults: 20 per device under 400 overall', () => {
    expect(hosting.LIMITS.maxPerPeer).toBe(20);
    expect(hosting.LIMITS.maxConnections).toBe(400);
    expect(hosting.LIMITS.headersTimeoutMs).toBeLessThanOrEqual(10_000);
    const conns = core.createConnectionLimiter();
    for (let i = 0; i < 20; i++) expect(conns.acquire('x')).toBe(true);
    expect(conns.acquire('x')).toBe(false);
  });
});

describe('3.5 the launch pass never leaves through the proxy', () => {
  it('strips only the bka_launch cookie', () => {
    expect(core.stripCookie('a=1; bka_launch=secret; b=2', 'bka_launch')).toBe('a=1; b=2');
    expect(core.stripCookie('BKA_LAUNCH=x;bka_launch=y', 'bka_launch')).toBeNull();
    expect(core.stripCookie(' bka_launch = y ; bka_session=s', 'bka_launch')).toBe('bka_session=s');
    expect(core.stripCookie('bka_launcher=keep', 'bka_launch')).toBe('bka_launcher=keep');
    expect(core.stripCookie(undefined, 'bka_launch')).toBeNull();
    expect(core.stripCookie('', 'bka_launch')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Listener wiring on 127.0.0.1
// ---------------------------------------------------------------------------------------------

const open: http.Server[] = [];
afterAll(async () => {
  await Promise.all(
    open.map(
      (s) =>
        new Promise((r) => {
          s.close(() => r(null));
          s.closeAllConnections?.();
        }),
    ),
  );
});

async function upstream(handler: http.RequestListener): Promise<number> {
  const s = http.createServer(handler);
  open.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return (s.address() as AddressInfo).port;
}

async function listener(spec: Record<string, unknown>, ctx: Record<string, unknown>): Promise<{ server: http.Server; port: number }> {
  const server = await hosting.openListener(spec, {
    port: 0,
    tlsMaterial: null,
    conns: core.createConnectionLimiter(),
    log: () => {},
    ...ctx,
  });
  open.push(server);
  return { server, port: (server.address() as AddressInfo).port };
}

/** Raw request; resolves what came back and whether the server closed the connection. */
function raw(port: number, text: string | null, { keepOpenMs = 0 } = {}): Promise<{ data: string; closed: boolean }> {
  return new Promise((resolve) => {
    let data = '';
    const sock = net.connect(port, '127.0.0.1', () => {
      if (text !== null) sock.write(text);
    });
    sock.on('data', (d) => (data += d.toString()));
    sock.on('error', () => {});
    sock.on('close', () => resolve({ data, closed: true }));
    if (keepOpenMs) setTimeout(() => resolve({ data, closed: false }), keepOpenMs);
  });
}

function waitClose(sock: net.Socket, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    sock.resume(); // read (and drop) whatever the server answers, so its close is seen
    if (sock.destroyed) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    sock.once('close', () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

describe('listener wiring', () => {
  it('refuses a request naming a host it does not serve (421, never forwarded) and forwards a served one', async () => {
    let forwarded = 0;
    const up = await upstream((_q, r) => {
      forwarded++;
      r.end('LEDGER');
    });
    const handler = hosting.createProxyHandler(up, {
      secure: false,
      servesHost: (req: http.IncomingMessage) =>
        core.isServedHost(req.headers.host, { names: new Set(['office-pc.tail1234.ts.net']), localAddress: req.socket.localAddress, localPort: req.socket.localPort }),
    });
    const { port } = await listener({ host: '127.0.0.1', kind: 'all' }, { handler });
    const bad = await raw(port, `GET /api/company-file/info HTTP/1.1\r\nHost: rebind.evil.example:${port}\r\n\r\n`);
    expect(bad.data).toMatch(/^HTTP\/1\.1 421/);
    expect(bad.data).not.toMatch(/LEDGER/);
    expect(forwarded).toBe(0);
    const good = await raw(port, `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    expect(good.data).toMatch(/^HTTP\/1\.1 200/);
    expect(good.data).toMatch(/LEDGER/);
    const named = await raw(port, `GET / HTTP/1.1\r\nHost: office-pc.tail1234.ts.net:${port}\r\nConnection: close\r\n\r\n`);
    expect(named.data).toMatch(/^HTTP\/1\.1 200/);
    expect(forwarded).toBe(2);
  });

  it('never forwards the launch pass header or cookie; other cookies pass', async () => {
    let seen: http.IncomingHttpHeaders = {};
    const up = await upstream((q, r) => {
      seen = q.headers;
      r.end('ok');
    });
    const { port } = await listener({ host: '127.0.0.1', kind: 'all' }, { handler: hosting.createProxyHandler(up, { secure: false }) });
    await fetch(`http://127.0.0.1:${port}/x`, { headers: { 'x-bka-launch': 'stolen', cookie: 'bka_session=s1; bka_launch=stolen; theme=dark' } });
    expect(seen['x-bka-launch']).toBeUndefined();
    expect(seen.cookie).toBe('bka_session=s1; theme=dark');
    expect(seen['x-bka-remote-addr']).toBe('127.0.0.1');
    await fetch(`http://127.0.0.1:${port}/x`, { headers: { cookie: 'bka_launch=stolen' } });
    expect(seen.cookie).toBeUndefined();
  });

  it('a LAN listener serves a device outside its own subnet, as before (here: loopback vs a /24)', async () => {
    let hits = 0;
    const { port } = await listener(
      { host: '127.0.0.1', kind: 'lan', prefix: 24 },
      { handler: (_q: http.IncomingMessage, r: http.ServerResponse) => (hits++, r.end('x')) },
    );
    const r = await raw(port, `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    expect(r.data).toMatch(/^HTTP\/1\.1 200/);
    expect(hits).toBe(1);
  });

  it('a device the peer rule refuses (a public address) is dropped before a byte is read', async () => {
    let hits = 0;
    // A test connection can only come from loopback: stand in a public address for the peer.
    const unmap = vi.spyOn(core, 'unmapAddress').mockReturnValue('203.0.113.5');
    try {
      const { port } = await listener(
        { host: '127.0.0.1', kind: 'lan', prefix: 24 },
        { handler: (_q: http.IncomingMessage, r: http.ServerResponse) => (hits++, r.end('x')) },
      );
      const r = await raw(port, `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
      expect(r.closed).toBe(true);
      expect(r.data).toBe('');
      expect(hits).toBe(0);
    } finally {
      unmap.mockRestore();
    }
  });

  it('one device cannot hold more than its share of connections; a closed one frees a slot', async () => {
    const { port } = await listener(
      { host: '127.0.0.1', kind: 'all' },
      { handler: (_q: http.IncomingMessage, r: http.ServerResponse) => r.end('x'), conns: core.createConnectionLimiter({ maxTotal: 400, maxPerPeer: 3 }) },
    );
    const socks = await Promise.all(
      [0, 1, 2].map(() => new Promise<net.Socket>((resolve) => {
        const s = net.connect(port, '127.0.0.1', () => resolve(s));
        s.on('error', () => {});
      })),
    );
    // Let the server see all three.
    await new Promise((r) => setTimeout(r, 100));
    const fourth = net.connect(port, '127.0.0.1');
    fourth.on('error', () => {});
    expect(await waitClose(fourth, 2000)).toBe(true);
    for (const s of socks) expect(s.destroyed).toBe(false);
    socks[0].destroy();
    await new Promise((r) => setTimeout(r, 100));
    const again = await raw(port, `GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    expect(again.data).toMatch(/^HTTP\/1\.1 200/);
    for (const s of socks) s.destroy();
  });

  it('a connection that never sends its headers is closed after the header timeout', async () => {
    const { port } = await listener(
      { host: '127.0.0.1', kind: 'all' },
      { handler: (_q: http.IncomingMessage, r: http.ServerResponse) => r.end('x'), limits: { headersTimeoutMs: 300, checkIntervalMs: 100 } },
    );
    const silent = net.connect(port, '127.0.0.1');
    silent.on('error', () => {});
    expect(await waitClose(silent, 3000)).toBe(true);
    const slowHeaders: net.Socket = net.connect(port, '127.0.0.1', () => slowHeaders.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n'));
    slowHeaders.on('error', () => {});
    expect(await waitClose(slowHeaders, 3000)).toBe(true);
  });

  it('keep-alive and a slow upload still work with the short header timeout', async () => {
    const up = await upstream((q, r) => {
      let n = 0;
      q.on('data', (c: Buffer) => (n += c.length));
      q.on('end', () => r.end(`got ${n}`));
    });
    const { port } = await listener(
      { host: '127.0.0.1', kind: 'all' },
      { handler: hosting.createProxyHandler(up, { secure: false }), limits: { headersTimeoutMs: 300, checkIntervalMs: 100 } },
    );
    // Idle keep-alive connection between two requests, longer than the header timeout.
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const get = () =>
      new Promise<{ body: string; reused: boolean }>((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/', agent }, (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => resolve({ body, reused: req.reusedSocket }));
        });
        req.on('error', reject);
      });
    expect((await get()).body).toBe('got 0');
    await new Promise((r) => setTimeout(r, 700));
    const second = await get();
    expect(second.body).toBe('got 0');
    expect(second.reused).toBe(true);
    agent.destroy();
    // A body that trickles in over a second (headers sent at once) is forwarded whole.
    const body = await new Promise<string>((resolve) => {
      let data = '';
      const sock = net.connect(port, '127.0.0.1', async () => {
        sock.write(`POST /upload HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 10\r\nConnection: close\r\n\r\n`);
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 100));
          sock.write('x');
        }
      });
      sock.on('data', (d) => (data += d.toString()));
      sock.on('close', () => resolve(data));
    });
    expect(body).toMatch(/^HTTP\/1\.1 200/);
    expect(body).toMatch(/got 10/);
  });

  it('HTTPS: a connection that never finishes the TLS handshake is closed', async () => {
    const made = selfSignedCert.generateCertificate({ names: ['test'], ips: ['127.0.0.1'] });
    const { port } = await listener(
      { host: '127.0.0.1', kind: 'all' },
      {
        tlsMaterial: { cert: made.cert, key: made.key },
        handler: (_q: http.IncomingMessage, r: http.ServerResponse) => r.end('x'),
        limits: { handshakeTimeoutMs: 300, headersTimeoutMs: 300, checkIntervalMs: 100 },
      },
    );
    const stalled = net.connect(port, '127.0.0.1');
    stalled.on('error', () => {});
    expect(await waitClose(stalled, 3000)).toBe(true);
  });

  it('a listener that cannot start does not stop the others', async () => {
    const handler = (_q: http.IncomingMessage, r: http.ServerResponse) => r.end('x');
    const { started, failed } = await hosting.openListeners(
      [
        { host: '127.0.0.1', kind: 'all' },
        { host: '192.0.2.1', kind: 'lan', prefix: 24 }, // not an address of this computer
      ],
      { port: 0, tlsMaterial: null, handler, conns: core.createConnectionLimiter(), log: () => {} },
    );
    for (const s of started) open.push(s.server);
    expect(started.map((s: { listener: { host: string } }) => s.listener.host)).toEqual(['127.0.0.1']);
    expect(failed.map((f: { listener: { host: string } }) => f.listener.host)).toEqual(['192.0.2.1']);
    const port = (started[0].server.address() as AddressInfo).port;
    expect((await raw(port, `GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`)).data).toMatch(/^HTTP\/1\.1 200/);
  });

  it('stopping hosting that never started, or an old-style state, is harmless', async () => {
    await expect(hosting.stopHosting(null)).resolves.toBeUndefined();
    const s = http.createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    await hosting.stopHosting({ servers: [s] });
    expect(s.listening).toBe(false);
    expect(await hosting.refreshLanListeners({})).toBe(false);
  });
});
