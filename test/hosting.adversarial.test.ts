/**
 * Adversarial QA (tester pass) for the Electron-side hosting helpers and renderer hardening:
 *  - "Open company on host…" address validation against URL-parser tricks,
 *  - peer filtering / bind selection edge cases,
 *  - host proxy header guarantees under header-smuggling attempts,
 *  - electron/security.js request + navigation filtering (with a stub `electron` module),
 *  - login rate limiter keying.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { LoginRateLimiter, attemptKeys } from '@/lib/net/rateLimit';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require('../electron/hostingCore.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createProxyHandler } = require('../electron/hosting.js');

describe('normalizeHostAddress — URL parser tricks', () => {
  it.each([
    'http://100.64.0.1@evil.com',
    'http://evil.com#@100.64.0.1',
    'http://evil.com\\@100.64.0.1',
    'http://evil.com?@100.64.0.1',
    '100.64.0.1.evil.com',
    'office.ts.net.evil.com',
    'http://[2001:db8::1]:47800',
    'javascript:alert(1)',
    'file:///C:/Windows',
    'ws://100.64.0.1:47800',
    'http://169.254.169.254:47800',
    'http://0.0.0.0:47800',
    '8.8.8.8:47800',
  ])('refuses %s', (input) => {
    expect(core.normalizeHostAddress(input).ok).toBe(false);
  });

  it('canonical numeric spellings of a tailnet address are accepted as that address', () => {
    const r = core.normalizeHostAddress('0x64.0x40.0.1:47801');
    expect(r.ok).toBe(true);
    expect(r.host).toBe('100.64.0.1');
  });

  it('ports: out-of-range and privileged ports refused, explicit high ports kept', () => {
    expect(core.normalizeHostAddress('100.64.0.1:0').ok).toBe(false);
    expect(core.normalizeHostAddress('100.64.0.1:65536').ok).toBe(false);
    expect(core.normalizeHostAddress('https://100.64.0.1:443').ok).toBe(false);
    expect(core.normalizeHostAddress('100.64.0.1:65535').port).toBe(65535);
    expect(core.normalizeHostAddress('[fd7a:115c:a1e0::5]:50000')).toMatchObject({ ok: true, port: 50000 });
  });

  it('non-string / hostile input never throws', () => {
    for (const v of [null, undefined, 42, {}, [], '   ', '\u0000', 'http://', '::::']) {
      expect(() => core.normalizeHostAddress(v)).not.toThrow();
      expect(core.normalizeHostAddress(v).ok).toBe(false);
    }
  });
});

describe('peer filtering / bind selection edge cases', () => {
  it('public, link-local and unspecified peers are refused', () => {
    for (const a of ['169.254.1.1', 'fe80::1%eth0', '0.0.0.0', '::', '100.128.0.1', '100.63.255.255', '', undefined, null, '::ffff:169.254.169.254']) {
      expect(core.isPeerAllowed(a), String(a)).toBe(false);
    }
  });

  it('a malformed or public "tailnet IP" never yields a bind address, and 0.0.0.0 needs literal true', () => {
    for (const ip of ['100.64.0.1 ', '100.64.0', '0.0.0.0', '8.8.8.8', '100.128.0.1', 'fd7a:115c:a1e0::1', undefined]) {
      const r = core.selectBindAddresses({ tailnetIp: ip });
      expect(r.ok, String(ip)).toBe(false);
      expect(r.proxyHosts).toEqual([]);
    }
    for (const v of [1, 'true', {}, [true]]) {
      expect(core.selectBindAddresses({ tailnetIp: null, bindAll: v }).proxyHosts).not.toContain('0.0.0.0');
    }
    // The app server itself is always loopback-only.
    expect(core.selectBindAddresses({ tailnetIp: '100.64.0.1', bindAll: true }).serverHost).toBe('127.0.0.1');
  });

  it('tailscale output with junk / IPv6 first still finds the IPv4', () => {
    expect(core.parseTailscaleIpOutput('fd7a:115c:a1e0::1\n  100.99.1.2  \n')).toBe('100.99.1.2');
    expect(core.parseTailscaleIpOutput('error: not logged in\n')).toBeNull();
    expect(core.parseTailscaleIpOutput(undefined)).toBeNull();
  });
});

describe('host proxy — header smuggling', () => {
  const servers: http.Server[] = [];
  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r(null)))));
  });
  const listen = (server: http.Server): Promise<number> => {
    servers.push(server);
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
  };

  it('duplicate / mixed-case forged identity headers are all replaced', async () => {
    let raw: string[] = [];
    const upstreamPort = await listen(
      http.createServer((req, res) => {
        raw = req.rawHeaders;
        res.end('ok');
      }),
    );
    const proxyPort = await listen(http.createServer(createProxyHandler(upstreamPort, { secure: true })));

    // Raw socket so we can send duplicate and oddly-cased headers verbatim.
    await new Promise<void>((resolve, reject) => {
      const sock = net.connect(proxyPort, '127.0.0.1', () => {
        sock.write(
          'GET /api/x HTTP/1.1\r\n' +
            'Host: 100.64.0.1:47800\r\n' +
            'X-BKA-Remote-Addr: local\r\n' +
            'x-bka-remote-addr: local\r\n' +
            'X-Bka-Internal: stolen\r\n' +
            'X-Forwarded-Proto: http\r\n' +
            'Connection: close\r\n\r\n',
        );
      });
      sock.on('data', () => {});
      sock.on('end', () => resolve());
      sock.on('error', reject);
    });
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < raw.length; i += 2) pairs.push([raw[i].toLowerCase(), raw[i + 1]]);
    const remote = pairs.filter(([k]) => k === 'x-bka-remote-addr');
    expect(remote).toEqual([['x-bka-remote-addr', '127.0.0.1']]);
    expect(pairs.some(([k]) => k === 'x-bka-internal')).toBe(false);
    expect(pairs.filter(([k]) => k === 'x-forwarded-proto')).toEqual([['x-forwarded-proto', 'https']]);
  });
});

describe('electron/security.js — renderer filtering', () => {
  // Stub the `electron` module so security.js can be exercised without Electron.
  const handlers: Record<string, (...a: unknown[]) => void> = {};
  let beforeRequest: (d: { url: string; webContentsId?: number }, cb: (r: { cancel?: boolean }) => void) => void = () => {};
  const opened: string[] = [];
  const fake = {
    app: { on: (ev: string, fn: (...a: unknown[]) => void) => (handlers[ev] = fn) },
    shell: { openExternal: async (u: string) => void opened.push(u) },
    session: {
      defaultSession: {
        setPermissionRequestHandler: () => {},
        setPermissionCheckHandler: () => {},
        setSpellCheckerEnabled: () => {},
        webRequest: { onBeforeRequest: (fn: typeof beforeRequest) => (beforeRequest = fn) },
      },
    },
  };
  const electronPath = require.resolve('electron');
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: fake } as unknown as NodeJS.Module;
  const secPath = require.resolve('../electron/security.js');
  delete require.cache[secPath];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { install } = require('../electron/security.js');
  const sec = install({ getAppOrigin: () => 'http://127.0.0.1:3123', isDev: false, log: () => {} });

  const decide = (url: string, webContentsId: number | undefined = 1) => {
    let r: { cancel?: boolean } = {};
    beforeRequest({ url, webContentsId }, (x) => (r = x));
    return !r.cancel;
  };

  it('allows only the app origin + internal schemes from the renderer', () => {
    expect(decide('http://127.0.0.1:3123/api/x')).toBe(true);
    expect(decide('data:image/png;base64,AAAA')).toBe(true);
    for (const u of [
      'http://127.0.0.1:3124/',
      'http://localhost:3123/',
      'https://fonts.googleapis.com/css2?family=Inter',
      'https://cdn.jsdelivr.net/npm/x',
      'https://www.google-analytics.com/collect',
      'ws://127.0.0.1:3123/_next/webpack-hmr',
      'file:///C:/Windows/win.ini',
      'http://100.64.0.1:47800/',
    ]) {
      expect(decide(u), u).toBe(false);
    }
  });

  it('no third-party bank widget can load (Plaid was removed; bank data comes from imported statements)', () => {
    for (const url of ['https://cdn.plaid.com/link/v2/stable/link-initialize.js', 'https://production.plaid.com/x', 'https://plaid.com/']) {
      expect(decide(url), url).toBe(false);
    }
  });

  it('blocks navigation and pop-ups to remote origins; only https links go to the system browser', () => {
    let navHandler: (e: { preventDefault: () => void }, url: string) => void = () => {};
    let openHandler: (d: { url: string }) => { action: string } = () => ({ action: 'allow' });
    const contents = {
      setWindowOpenHandler: (fn: typeof openHandler) => (openHandler = fn),
      on: (ev: string, fn: typeof navHandler) => {
        if (ev === 'will-navigate') navHandler = fn;
      },
    };
    handlers['web-contents-created']({}, contents);
    const prevented = (url: string) => {
      let p = false;
      navHandler({ preventDefault: () => (p = true) }, url);
      return p;
    };
    expect(prevented('http://127.0.0.1:3123/invoices')).toBe(false);
    expect(prevented('https://evil.example.com/phish')).toBe(true);
    expect(prevented('file:///C:/Users/')).toBe(true);
    expect(prevented('javascript:alert(1)')).toBe(true);
    expect(openHandler({ url: 'https://evil.example.com/' }).action).toBe('deny');
    expect(openHandler({ url: 'http://127.0.0.1:3123/print' }).action).toBe('allow');
    opened.length = 0;
    openHandler({ url: 'file:///C:/Windows/System32/calc.exe' });
    openHandler({ url: 'ms-msdt:/id PCWDiagnostic' });
    openHandler({ url: 'smb://attacker/share' });
    expect(opened).toEqual([]);
  });
  vi.restoreAllMocks();
});

describe('login rate limiter — keying', () => {
  it('email case / whitespace variants share one account bucket', () => {
    const l = new LoginRateLimiter({ maxFailures: 3, windowMs: 60_000, lockoutMs: 60_000, maxLockoutMs: 60_000 });
    const t = 1_000_000;
    l.recordFailure(attemptKeys('login', 'Boss@Firm.com', '100.64.0.2'), t);
    l.recordFailure(attemptKeys('login', '  boss@firm.com ', '100.64.0.3'), t);
    l.recordFailure(attemptKeys('login', 'BOSS@FIRM.COM', '100.64.0.4'), t);
    expect(l.check(attemptKeys('login', 'boss@firm.com', '100.64.0.9'), t + 1).allowed).toBe(false);
  });

  it('login, unlock and portal counters are independent', () => {
    const l = new LoginRateLimiter({ maxFailures: 2, windowMs: 60_000, lockoutMs: 60_000, maxLockoutMs: 60_000 });
    l.recordFailure(attemptKeys('portal', 'a@b.c', 'x'), 0);
    l.recordFailure(attemptKeys('portal', 'a@b.c', 'x'), 0);
    expect(l.check(attemptKeys('portal', 'a@b.c', 'y'), 1).allowed).toBe(false);
    expect(l.check(attemptKeys('login', 'a@b.c', 'x'), 1).allowed).toBe(true);
  });

  it('a success does not reset an active lockout on another key (global still counts)', () => {
    const l = new LoginRateLimiter({ maxFailures: 2, windowMs: 60_000, lockoutMs: 60_000, maxLockoutMs: 60_000 });
    const keys = attemptKeys('login', 'a@b.c', 'x');
    l.recordFailure(keys, 0, { [keys[2]]: 1 });
    l.recordFailure(keys, 0, { [keys[2]]: 1 });
    l.recordSuccess(keys.slice(0, -1));
    expect(l.check(attemptKeys('login', 'other@b.c', 'z'), 1).allowed).toBe(false); // global locked
  });
});
