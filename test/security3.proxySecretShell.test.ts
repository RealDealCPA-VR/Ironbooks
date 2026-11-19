/**
 * Work package G3, item 1, the desktop shell side (electron/main.js; what can be checked without
 * starting Electron): this launch's proxy secret goes to every server the shell starts by
 * environment (never on the command line), and the same value to the multi-user proxy, which
 * only ever sends it to the app server on this computer.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PROXY_SECRET_ENV } from '../lib/net/loopbackHost';

const require = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-require-imports */
const hostingCore = require('../electron/hostingCore.js');
/* eslint-enable @typescript-eslint/no-require-imports */

const read = (f: string) => fs.readFileSync(path.resolve(__dirname, '..', 'electron', f), 'utf8').replace(/\r\n/g, '\n');
const main = read('main.js');
const hostingSrc = read('hosting.js');

/** The body of a top-level function in main.js (up to the next top-level declaration). */
const fnBody = (signature: string) => {
  const at = main.indexOf(signature);
  expect(at, signature).toBeGreaterThan(-1);
  const rest = main.slice(at + signature.length);
  const end = rest.search(/\n(?:async function |function |const |let |ipcMain\.|app\.on\()/);
  return main.slice(at, at + signature.length + (end < 0 ? rest.length : end));
};

describe('the proxy secret in the shell', () => {
  it('every server the shell starts gets it by environment, never on the command line', () => {
    expect(hostingCore.PROXY_SECRET_ENV).toBe(PROXY_SECRET_ENV);
    for (const sig of ['async function startNextServer() {', 'async function startScratchServer(dataDir) {']) {
      const body = fnBody(sig);
      expect(body, sig).toMatch(/\n\s*BKA_PROXY_SECRET: hosting\.proxySecret\(\),\n/);
      // Set after the inherited environment, so a value on this computer cannot replace it.
      expect(body.indexOf('BKA_PROXY_SECRET:')).toBeGreaterThan(body.indexOf('...localServer.inheritedServerEnv('));
      expect(body).not.toMatch(/\[[^\]\n]*proxySecret/);
    }
  });

  it('the multi-user proxy gets the same value', () => {
    const at = main.indexOf('hostingState = await hosting.startHosting({');
    expect(at).toBeGreaterThan(-1);
    const call = main.slice(at, main.indexOf('});', at));
    expect(call).toMatch(/\n\s*proxySecret: hosting\.proxySecret\(\),\n/);
    // ...which stamps it on what it forwards.
    expect(hostingSrc).toMatch(/proxySecret: opts\.proxySecret \|\| null,/);
  });

  it('is never logged, and only ever sent to the app server on this computer', () => {
    const uses = [...main.split('\n'), ...hostingSrc.split('\n')].filter((l) => /proxySecret\(\)|\bstamp\b|launchProxySecret/.test(l) && !/^\s*(\/\/|\*)/.test(l));
    for (const l of uses) expect(l, l).not.toMatch(/console\.|log\(/);
    // The proxy's only outgoing request is to 127.0.0.1.
    expect(hostingSrc.match(/http\.request\(/g)).toHaveLength(1);
    expect(hostingSrc).toMatch(/http\.request\(\s*\{ host: '127\.0\.0\.1', port: upstreamPort,/);
  });
});
