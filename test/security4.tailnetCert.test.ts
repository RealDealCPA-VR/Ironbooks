/**
 * Security plan 4.8 for tailnet hosting (work package G3, item 2): the private key of the
 * certificate `tailscale cert` issues does not stay a plain file in the roaming profile
 * (userData/tls) when the operating system can protect it. It is read into memory, kept wrapped
 * by Electron safeStorage in `<name>.key.sealed`, and the plain file is deleted — the same as the
 * office-network certificate (electron/selfSignedCert.js). Every start still asks Tailscale first;
 * when that fails, the kept certificate and wrapped key are served while the certificate is valid.
 * Without safeStorage, or when wrapping fails, the files are exactly as before.
 *
 * electron/hosting.js obtainTlsCert, with a fake safeStorage and a fake `tailscale cert`.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-require-imports */
const hosting = require('../electron/hosting.js');
const selfSignedCert = require('../electron/selfSignedCert.js');
/* eslint-enable @typescript-eslint/no-require-imports */

const DNS = 'office-pc.tail1234.ts.net';
const DAY = 24 * 3600 * 1000;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-tailnet-cert-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

let dir: string;
let n = 0;
beforeEach(() => {
  dir = path.join(root, `tls-${n++}`);
});

/** A stand-in for Electron safeStorage: reversible, and never the plain text on disk. */
function fakeSafeStorage({ available = true, backend = 'gnome_libsecret' } = {}) {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (s: string) => Buffer.from(`SEALED:${Buffer.from(s, 'utf8').toString('base64').split('').reverse().join('')}`),
    decryptString: (b: Buffer) => {
      const t = Buffer.from(b).toString('utf8');
      if (!t.startsWith('SEALED:')) throw new Error('not sealed by this account');
      return Buffer.from(t.slice(7).split('').reverse().join(''), 'base64').toString('utf8');
    },
  };
}

/** A certificate + key like the ones `tailscale cert` writes (PEM). */
function issue(days = 90, now = new Date()) {
  return selfSignedCert.generateCertificate({ commonName: DNS, names: [DNS], days, now });
}

/** A fake `tailscale cert`: writes the files where it is told, as the real CLI does. */
function certRunner(material: { cert: string; key: string } | null, calls: string[][] = []) {
  return async (args: string[], opts: { cwd: string }) => {
    calls.push([...args, `cwd=${opts.cwd}`]);
    if (!material) throw new Error('certificate issuance failed');
    const certFile = args[args.indexOf('--cert-file') + 1];
    const keyFile = args[args.indexOf('--key-file') + 1];
    fs.writeFileSync(certFile, material.cert);
    fs.writeFileSync(keyFile, material.key);
    return { stdout: '' };
  };
}

const files = () => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
const KEY = () => path.join(dir, `${DNS}.key`);
const SEALED = () => path.join(dir, `${DNS}.key.sealed`);

describe('tailnet certificate key wrapped by safeStorage', () => {
  it('asks Tailscale for the certificate exactly as before', async () => {
    const calls: string[][] = [];
    await hosting.obtainTlsCert(dir, () => {}, DNS, { protect: fakeSafeStorage(), runCert: certRunner(issue(), calls), platform: 'win32' });
    expect(calls).toEqual([['cert', '--cert-file', path.join(dir, `${DNS}.crt`), '--key-file', KEY(), DNS, `cwd=${dir}`]]);
    // No name, no certificate (plain HTTP), and Tailscale is not asked.
    expect(await hosting.obtainTlsCert(dir, () => {}, null, { protect: fakeSafeStorage(), runCert: certRunner(issue(), calls) })).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('serves the new certificate from memory, keeps the key wrapped, and deletes the plain key file', async () => {
    const issued = issue();
    const logs: string[] = [];
    const protect = fakeSafeStorage();
    const got = await hosting.obtainTlsCert(dir, (m: string) => logs.push(m), DNS, { protect, runCert: certRunner(issued), platform: 'win32' });
    expect(got.dnsName).toBe(DNS);
    expect(got.cert.toString()).toBe(issued.cert);
    expect(got.key.toString()).toBe(issued.key);
    expect(files()).toEqual([`${DNS}.crt`, `${DNS}.key.sealed`]);
    expect(fs.existsSync(KEY())).toBe(false);
    const sealed = fs.readFileSync(SEALED());
    expect(sealed.toString()).not.toContain('PRIVATE KEY');
    expect(protect.decryptString(sealed)).toBe(issued.key);
    expect(logs).toEqual([]);
  });

  it('next start: a fresh certificate from Tailscale is preferred (it renews), and the wrapped key follows it', async () => {
    const first = issue();
    const protect = fakeSafeStorage();
    await hosting.obtainTlsCert(dir, () => {}, DNS, { protect, runCert: certRunner(first), platform: 'win32' });
    const renewed = issue();
    const got = await hosting.obtainTlsCert(dir, () => {}, DNS, { protect, runCert: certRunner(renewed), platform: 'win32' });
    expect(got.cert.toString()).toBe(renewed.cert);
    expect(got.key.toString()).toBe(renewed.key);
    expect(protect.decryptString(fs.readFileSync(SEALED()))).toBe(renewed.key);
    expect(fs.existsSync(KEY())).toBe(false);
  });

  it('next start, Tailscale cannot issue: the kept certificate and wrapped key are served while valid', async () => {
    const issued = issue(90);
    const protect = fakeSafeStorage();
    await hosting.obtainTlsCert(dir, () => {}, DNS, { protect, runCert: certRunner(issued), platform: 'win32' });
    const logs: string[] = [];
    const got = await hosting.obtainTlsCert(dir, (m: string) => logs.push(m), DNS, { protect, runCert: certRunner(null), platform: 'win32' });
    expect(got).not.toBeNull();
    expect(got.dnsName).toBe(DNS);
    expect(got.cert.toString()).toBe(issued.cert);
    expect(got.key.toString()).toBe(issued.key);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/tailscale cert unavailable \(certificate issuance failed\); serving HTTPS with the certificate from an earlier start/);
    expect(fs.existsSync(KEY())).toBe(false);
  });

  it('...but never an expired certificate, nor a key that is not its own, nor one this account cannot unwrap: plain HTTP as before', async () => {
    const issued = issue(30);
    const protect = fakeSafeStorage();
    await hosting.obtainTlsCert(dir, () => {}, DNS, { protect, runCert: certRunner(issued), platform: 'win32' });
    const plainHttp = /tailscale cert unavailable \(certificate issuance failed\); serving plain HTTP over the tailnet/;

    // Expired.
    const later = Date.now() + 31 * DAY;
    let logs: string[] = [];
    expect(await hosting.obtainTlsCert(dir, (m: string) => logs.push(m), DNS, { protect, runCert: certRunner(null), platform: 'win32', now: () => later })).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(plainHttp);

    // Another account's (or a damaged) wrapped key.
    logs = [];
    const otherAccount = { ...fakeSafeStorage(), decryptString: () => { throw new Error('cannot unwrap'); } };
    expect(await hosting.obtainTlsCert(dir, (m: string) => logs.push(m), DNS, { protect: otherAccount, runCert: certRunner(null), platform: 'win32' })).toBeNull();
    expect(logs[0]).toMatch(plainHttp);

    // The certificate on disk is not the wrapped key's.
    fs.writeFileSync(path.join(dir, `${DNS}.crt`), issue().cert);
    logs = [];
    expect(await hosting.obtainTlsCert(dir, (m: string) => logs.push(m), DNS, { protect, runCert: certRunner(null), platform: 'win32' })).toBeNull();
    expect(logs[0]).toMatch(plainHttp);

    // Nothing kept at all (first start).
    dir = path.join(root, `tls-${n++}`);
    logs = [];
    expect(await hosting.obtainTlsCert(dir, (m: string) => logs.push(m), DNS, { protect, runCert: certRunner(null), platform: 'win32' })).toBeNull();
    expect(logs).toEqual([expect.stringMatching(plainHttp)]);
  });
});

describe('without safeStorage: exactly the files of before', () => {
  const cases: Array<[string, unknown, string]> = [
    ['no safeStorage passed (older caller, tests)', null, 'win32'],
    ['safeStorage not available', fakeSafeStorage({ available: false }), 'win32'],
    ["Linux's plain-text fallback", fakeSafeStorage({ backend: 'basic_text' }), 'linux'],
  ];
  it.each(cases)('%s: the plain key file stays, nothing is wrapped', async (_label, protect, platform) => {
    const issued = issue();
    const logs: string[] = [];
    const got = await hosting.obtainTlsCert(dir, (m: string) => logs.push(m), DNS, { protect, runCert: certRunner(issued), platform });
    expect(got.key.toString()).toBe(issued.key);
    expect(files()).toEqual([`${DNS}.crt`, `${DNS}.key`]);
    expect(fs.readFileSync(KEY(), 'utf8')).toBe(issued.key);
    expect(logs).toEqual([]);
    // And when Tailscale cannot issue, plain HTTP as before (the files on disk are not used).
    expect(await hosting.obtainTlsCert(dir, (m: string) => logs.push(m), DNS, { protect, runCert: certRunner(null), platform })).toBeNull();
    expect(logs).toEqual([expect.stringMatching(/serving plain HTTP over the tailnet/)]);
  });
});

describe('a failure in wrapping never stops hosting', () => {
  it.each([
    ['wrapping throws', { encryptString: () => { throw new Error('DPAPI failed'); } }],
    ['the wrapped key does not read back', { decryptString: () => 'something else' }],
  ])('%s: served from the plain file as before, one log line', async (_label, broken) => {
    const issued = issue();
    const logs: string[] = [];
    const protect = { ...fakeSafeStorage(), ...broken };
    const got = await hosting.obtainTlsCert(dir, (m: string) => logs.push(m), DNS, { protect, runCert: certRunner(issued), platform: 'win32' });
    expect(got.cert.toString()).toBe(issued.cert);
    expect(got.key.toString()).toBe(issued.key);
    expect(fs.readFileSync(KEY(), 'utf8')).toBe(issued.key);
    expect(files()).toEqual([`${DNS}.crt`, `${DNS}.key`]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^\[hosting\] could not wrap the certificate key \(.+\); it stays a plain file for now$/);
    expect(logs[0]).not.toContain('PRIVATE KEY');
  });

  it('the wrapped copy cannot be written (the folder is not writable): the plain file stays', async () => {
    const issued = issue();
    const logs: string[] = [];
    // A folder where the wrapped file should go: writing it fails.
    fs.mkdirSync(SEALED(), { recursive: true });
    const got = await hosting.obtainTlsCert(dir, (m: string) => logs.push(m), DNS, { protect: fakeSafeStorage(), runCert: certRunner(issued), platform: 'win32' });
    expect(got.key.toString()).toBe(issued.key);
    expect(fs.readFileSync(KEY(), 'utf8')).toBe(issued.key);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/could not wrap the certificate key/);
    // No temporary file left behind.
    expect(files().filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('wiring', () => {
  const src = (f: string) => fs.readFileSync(path.resolve(__dirname, '..', 'electron', f), 'utf8').replace(/\r\n/g, '\n');

  it('startHosting hands safeStorage (opts.protect) to obtainTlsCert', () => {
    expect(src('hosting.js')).toMatch(/await obtainTlsCert\(opts\.certDir, log, self\.dnsName, \{ protect: opts\.protect \|\| null \}\)/);
  });

  it('main.js passes safeStorage to startHosting', () => {
    const main = src('main.js');
    const at = main.indexOf('hostingState = await hosting.startHosting({');
    expect(at).toBeGreaterThan(-1);
    const call = main.slice(at, main.indexOf('});', at));
    expect(call).toMatch(/\n\s*protect: safeStorage,\n/);
  });
});
