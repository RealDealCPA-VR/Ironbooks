/**
 * Blank-window regression (1.1.0–1.3.0): Next.js spells loopback as "localhost" in the URLs
 * middleware sees, so the /unlock redirect on a fresh launch points at http://localhost:<port>/.
 *  - The desktop window must load the app from that same origin, or the navigation guard
 *    (electron/security.js) cancels the first redirect and the window stays navy.
 *  - The multi-user host proxy must move those redirects onto the address a teammate used,
 *    or their app is sent to "localhost" on their own computer.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { NextURL } from 'next/dist/server/web/next-url';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require('../electron/hostingCore.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createProxyHandler } = require('../electron/hosting.js');

describe('Next.js loopback spelling (the premise)', () => {
  it('a middleware URL for 127.0.0.1 comes out as localhost', () => {
    const u = new NextURL('http://127.0.0.1:51278/');
    u.pathname = '/unlock';
    expect(u.toString()).toBe('http://localhost:51278/unlock');
  });
});

describe('desktop window origin', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const start = main.slice(main.indexOf('async function startNextServer'), main.indexOf('function waitForServer'));

  it('the window loads the app from localhost while the server binds 127.0.0.1', () => {
    expect(start).toContain("HOSTNAME: '127.0.0.1'");
    expect(start).toContain('return `http://localhost:${port}`;');
    expect(start).not.toMatch(/`http:\/\/127\.0\.0\.1:\$\{port\}`/);
  });
});

describe('rewriteUpstreamLocation', () => {
  const upstream = 51278;
  const remote = { secure: false, host: '100.64.0.1:47800' };

  it.each([
    ['http://localhost:51278/unlock?next=%2F', 'http://100.64.0.1:47800/unlock?next=%2F'],
    ['http://127.0.0.1:51278/login?next=%2Freports', 'http://100.64.0.1:47800/login?next=%2Freports'],
    ['http://[::1]:51278/portal/login', 'http://100.64.0.1:47800/portal/login'],
  ])('moves %s onto the teammate origin', (location, expected) => {
    expect(core.rewriteUpstreamLocation(location, upstream, remote)).toBe(expected);
  });

  it('uses https when the proxy serves TLS', () => {
    expect(
      core.rewriteUpstreamLocation('http://localhost:51278/unlock', upstream, { secure: true, host: 'office.tail1234.ts.net:47800' }),
    ).toBe('https://office.tail1234.ts.net:47800/unlock');
  });

  it.each([
    '/unlock?next=%2F', // relative: already resolves against the proxy origin
    'http://localhost:3000/unlock', // some other local port
    'https://localhost:51278/unlock', // not the plain-http upstream
    'https://fire.irs.gov/upload', // external
    'http://localhost.evil.com:51278/x',
    'not a url',
  ])('leaves %s alone', (location) => {
    expect(core.rewriteUpstreamLocation(location, upstream, remote)).toBe(location);
  });

  it('a hostile Host header never turns into a different path or credentials', () => {
    for (const host of ['evil.com/path', 'a@b', 'x?y', '', undefined]) {
      expect(core.rewriteUpstreamLocation('http://localhost:51278/unlock', upstream, { secure: false, host })).toBe(
        'http://localhost:51278/unlock',
      );
    }
  });
});

describe('host proxy — redirects from the app server', () => {
  const servers: http.Server[] = [];
  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r(null)))));
  });
  const listen = (server: http.Server): Promise<number> => {
    servers.push(server);
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
  };

  it("an /unlock redirect reaches the teammate on the host's address", async () => {
    let upstreamPort = 0;
    upstreamPort = await listen(
      http.createServer((req, res) => {
        res.writeHead(307, { location: `http://localhost:${upstreamPort}/unlock?next=%2F` });
        res.end();
      }),
    );
    const proxyPort = await listen(http.createServer(createProxyHandler(upstreamPort, { secure: false })));
    const location = await new Promise<string | undefined>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: proxyPort, path: '/', headers: { host: '100.64.0.1:47800' } },
        (res) => {
          res.resume();
          resolve(res.headers.location);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(location).toBe('http://100.64.0.1:47800/unlock?next=%2F');
  });
});
