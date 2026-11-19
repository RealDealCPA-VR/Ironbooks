/**
 * Security plan, desktop shell side of package D (electron/): what can be checked without Electron.
 *
 *  1.3  this Windows account's device secret for saved keys of outside services
 *       (electron/deviceVault.js): wrapped by the operating system, created once, never lost on
 *       the account that made it, never in the way of starting; handed to every server the shell
 *       starts in its environment, never on the command line or in a log;
 *  3.5  the connection code teammates compare is 20 characters, the same on both computers;
 *  4.8  the office-network certificate's private key is kept wrapped by the operating system
 *       (electron/selfSignedCert.js), an existing plain key is wrapped in place (same certificate);
 *  sandbox record: the server opening a sandbox copy gets this computer's record of where it came
 *       from (config.sandbox), and only for that copy.
 */
import { afterAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-require-imports */
const deviceVault = require('../electron/deviceVault.js');
const selfSignedCert = require('../electron/selfSignedCert.js');
/* eslint-enable @typescript-eslint/no-require-imports */

const main = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const fnBody = (signature: string) => {
  const at = main.indexOf(signature);
  expect(at, signature).toBeGreaterThan(-1);
  const rest = main.slice(at + signature.length);
  const end = rest.search(/\n(?:async function |function |const |let |ipcMain\.|app\.on\()/);
  return main.slice(at, at + signature.length + (end < 0 ? rest.length : end));
};

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-sec1-device-'));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const freshDir = () => {
  const d = path.join(ROOT, `case-${++n}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

/** A stand-in for Electron safeStorage: wraps with a key only this "Windows account" has. */
function fakeSafeStorage(account: string, { available = true, backend = 'dpapi' } = {}) {
  const key = crypto.createHash('sha256').update(account).digest();
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString(plain: string): Buffer {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), ct]);
    },
    decryptString(buf: Buffer): string {
      const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
    },
  };
}

const quiet = () => undefined;

describe('1.3: the device secret (electron/deviceVault.js)', () => {
  it('is made once, kept wrapped (never readable in the file), and the same on every launch', () => {
    const dir = freshDir();
    const ss = fakeSafeStorage('alice');
    const s1 = deviceVault.loadOrCreateDeviceSecret({ dir, safeStorage: ss, log: quiet });
    expect(s1).toMatch(/^[0-9a-f]{64}$/);
    const raw = fs.readFileSync(path.join(dir, deviceVault.VAULT_FILE), 'utf8');
    expect(raw).not.toContain(s1);
    expect(deviceVault.loadOrCreateDeviceSecret({ dir, safeStorage: ss, log: quiet })).toBe(s1);
  });

  it('a profile another account cannot unwrap gets a new secret beside the old one; the old account keeps its own', () => {
    const dir = freshDir();
    const alice = fakeSafeStorage('alice');
    const bob = fakeSafeStorage('bob');
    const logs: string[] = [];
    const a = deviceVault.loadOrCreateDeviceSecret({ dir, safeStorage: alice, log: quiet });
    const b = deviceVault.loadOrCreateDeviceSecret({ dir, safeStorage: bob, log: (m: string) => logs.push(m) });
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(b).not.toBe(a);
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain(a);
    // Back on the first account (the userData folder was on a USB stick, or roamed): nothing lost.
    expect(deviceVault.loadOrCreateDeviceSecret({ dir, safeStorage: alice, log: quiet })).toBe(a);
    expect(deviceVault.loadOrCreateDeviceSecret({ dir, safeStorage: bob, log: quiet })).toBe(b);
  });

  it('a damaged file is set aside (never deleted) and start-up goes on with a new secret', () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, deviceVault.VAULT_FILE), '{"v":1,"secr');
    const s = deviceVault.loadOrCreateDeviceSecret({ dir, safeStorage: fakeSafeStorage('alice'), log: quiet, now: () => 42 });
    expect(s).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(path.join(dir, `${deviceVault.VAULT_FILE}.damaged-42`), 'utf8')).toBe('{"v":1,"secr');
  });

  it('a file that cannot be read right now is never overwritten: no secret this launch', () => {
    const dir = freshDir();
    const ss = fakeSafeStorage('alice');
    const s = deviceVault.loadOrCreateDeviceSecret({ dir, safeStorage: ss, log: quiet });
    const file = path.join(dir, deviceVault.VAULT_FILE);
    const before = fs.readFileSync(file);
    const lockedFs = { ...fs, readFileSync: () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); } };
    expect(deviceVault.loadOrCreateDeviceSecret({ dir, safeStorage: ss, fs: lockedFs, log: quiet })).toBe('');
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(deviceVault.loadOrCreateDeviceSecret({ dir, safeStorage: ss, log: quiet })).toBe(s);
  });

  it('no protection from the operating system (Linux plain-text fallback, none at all): no secret, nothing written', () => {
    for (const ss of [
      fakeSafeStorage('x', { available: false }),
      fakeSafeStorage('x', { backend: 'basic_text' }),
      null,
      { isEncryptionAvailable: () => { throw new Error('not ready'); } },
    ]) {
      const dir = freshDir();
      expect(deviceVault.loadOrCreateDeviceSecret({ dir, safeStorage: ss, platform: 'linux', log: quiet })).toBe('');
      expect(fs.existsSync(path.join(dir, deviceVault.VAULT_FILE))).toBe(false);
    }
    // basic_text is only a Linux name: Windows (DPAPI) is used.
    expect(deviceVault.loadOrCreateDeviceSecret({ dir: freshDir(), safeStorage: fakeSafeStorage('x', { backend: 'basic_text' }), platform: 'win32', log: quiet })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never throws: a failing wrap gives no secret (the server keeps the file key, as before)', () => {
    const broken = { ...fakeSafeStorage('x'), encryptString: () => { throw new Error('DPAPI failed'); } };
    expect(deviceVault.loadOrCreateDeviceSecret({ dir: freshDir(), safeStorage: broken, log: quiet })).toBe('');
    const liar = { ...fakeSafeStorage('x'), decryptString: () => 'not-the-secret' };
    expect(deviceVault.loadOrCreateDeviceSecret({ dir: freshDir(), safeStorage: liar, log: quiet })).toBe('');
  });

  it('main.js: made after app ready, handed to every server by environment only, never logged', () => {
    const getter = fnBody('function deviceVaultSecret() {');
    expect(getter).toMatch(/deviceVault\.loadOrCreateDeviceSecret\(\{ dir: app\.getPath\('userData'\), safeStorage \}\)/);
    expect(main).toMatch(/const \{ app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, shell, session, safeStorage \} = require\('electron'\);/);
    expect(deviceVault.DEVICE_VAULT_ENV).toBe('BKA_DEVICE_VAULT');
    const company = fnBody('async function startNextServer() {');
    const scratch = fnBody('async function startScratchServer(dataDir) {');
    for (const body of [company, scratch]) {
      // Set explicitly (also '' when there is none): never one inherited from this computer's environment.
      expect(body).toMatch(/BKA_DEVICE_VAULT: deviceVaultSecret\(\),/);
      expect(body).not.toMatch(/\[serverEntry, [^\]]*deviceVault|server\.js'\), [^\]]*deviceVault/);
    }
    for (const line of main.split('\n').filter((l) => /deviceVaultSecret\(|BKA_DEVICE_VAULT/.test(l))) {
      expect(line, line).not.toMatch(/console\.|dialog\.|log\(/);
    }
    // Every server start is after app ready (safeStorage needs it): createWindow and user actions only.
    const ready = main.indexOf('app.whenReady().then(');
    expect(ready).toBeGreaterThan(-1);
    expect(main.match(/await startNextServer\(\)/g)).toHaveLength(1);
    expect(fnBody('async function createWindow() {')).toMatch(/await startNextServer\(\)/);
  });
});

describe('3.5: the connection code', () => {
  // The function as main.js has it, evaluated on its own.
  const src = `${main.match(/const CONNECTION_CODE_CHARS = \d+;/)![0]}\n${fnBody('function connectionCode(pin) {')}\nreturn connectionCode;`;
  const connectionCode = new Function(src)() as (pin: string) => string;
  const pin = crypto.createHash('sha256').update('cert').digest('hex');

  it('is 20 hex characters of the certificate fingerprint, in groups of five', () => {
    const code = connectionCode(pin);
    expect(code).toMatch(/^[0-9A-F]{5}-[0-9A-F]{5}-[0-9A-F]{5}-[0-9A-F]{5}$/);
    expect(code.replace(/-/g, '')).toBe(pin.slice(0, 20).toUpperCase());
    expect(connectionCode('')).toBe('');
  });

  it('both sides show the same function: the join prompt and the host page (hostingStatus)', () => {
    expect(fnBody('async function confirmHostPin(filePath, pin) {')).toMatch(/Connection code: \$\{connectionCode\(pin\)\}/);
    expect(fnBody('function hostingStatus() {')).toMatch(/connectionCode: hostingState && hostingState\.fingerprint \? connectionCode\(hostingState\.fingerprint\) : null/);
    expect(main).not.toMatch(/\.slice\(0, 12\)/);
    // The saved pin is still the whole fingerprint.
    expect(fnBody('async function confirmHostPin(filePath, pin) {')).toMatch(/const next = \{ \.\.\.pins, \[filePath\]: pin \};/);
  });
});

describe("4.8: the office-network certificate's private key", () => {
  const ss = fakeSafeStorage('alice');

  it('a new certificate keeps its key wrapped only; the key works in memory', () => {
    const dir = freshDir();
    const made = selfSignedCert.loadOrCreate(dir, { names: ['x'] }, { protect: ss });
    expect(fs.existsSync(path.join(dir, selfSignedCert.KEY_FILE))).toBe(false);
    const sealed = fs.readFileSync(path.join(dir, selfSignedCert.SEALED_KEY_FILE));
    expect(sealed.includes(Buffer.from('PRIVATE KEY'))).toBe(false);
    expect(() => crypto.createPrivateKey(made.key)).not.toThrow();
    const again = selfSignedCert.loadOrCreate(dir, { names: ['x'] }, { protect: ss });
    expect(again.fingerprint).toBe(made.fingerprint);
    expect(again.key).toBe(made.key);
  });

  it('a plain key from an earlier version is wrapped in place: same certificate (pins keep working), plain file gone', () => {
    const dir = freshDir();
    const old = selfSignedCert.loadOrCreate(dir, { names: ['x'] }); // an earlier version: plain key
    expect(fs.existsSync(path.join(dir, selfSignedCert.KEY_FILE))).toBe(true);
    const now = selfSignedCert.loadOrCreate(dir, { names: ['x'] }, { protect: ss });
    expect(now.fingerprint).toBe(old.fingerprint);
    expect(now.key).toBe(old.key);
    expect(fs.existsSync(path.join(dir, selfSignedCert.KEY_FILE))).toBe(false);
    expect(fs.existsSync(path.join(dir, selfSignedCert.SEALED_KEY_FILE))).toBe(true);
    expect(selfSignedCert.loadOrCreate(dir, { names: ['x'] }, { protect: ss }).fingerprint).toBe(old.fingerprint);
  });

  it('a failed wrap keeps the plain key (never deleted before the wrapped copy is checked)', () => {
    const dir = freshDir();
    const old = selfSignedCert.loadOrCreate(dir, { names: ['x'] });
    const broken = { ...ss, encryptString: () => { throw new Error('DPAPI failed'); } };
    const now = selfSignedCert.loadOrCreate(dir, { names: ['x'] }, { protect: broken });
    expect(now.fingerprint).toBe(old.fingerprint);
    expect(fs.existsSync(path.join(dir, selfSignedCert.KEY_FILE))).toBe(true);
  });

  it('without protection from the operating system: a plain key file, as before', () => {
    const dir = freshDir();
    selfSignedCert.loadOrCreate(dir, { names: ['x'] }, { protect: fakeSafeStorage('x', { backend: 'basic_text' }), platform: 'linux' });
    expect(fs.existsSync(path.join(dir, selfSignedCert.KEY_FILE))).toBe(true);
    expect(fs.existsSync(path.join(dir, selfSignedCert.SEALED_KEY_FILE))).toBe(false);
  });

  it('main.js passes safeStorage; electron/hosting.js only uses the key handed to it in memory', () => {
    const body = fnBody('async function setHostingNow(enable, { quiet = false, lan = false } = {}) {');
    expect(body).toMatch(/selfSignedCert\.loadOrCreate\(\s*certDir,[\s\S]*?\{ protect: safeStorage \},\s*\)/);
    const hosting = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'hosting.js'), 'utf8');
    expect(hosting).not.toMatch(/lan-host\.key/);
    expect(hosting).toMatch(/key: opts\.lanCert\.key/);
  });
});

describe('sandbox source record for the server', () => {
  const src = `${fnBody('function sandboxRecordFor(dataDir) {')}\nreturn sandboxRecordFor;`;
  const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  const make = (sandbox: unknown) => new Function('loadConfig', 'samePath', src)(() => ({ sandbox }), samePath) as (d: string) => { dir: string; realDir: string };

  it('is the real file this computer recorded, only for the sandbox copy being opened', () => {
    const sb = { dir: 'C:\\Sandboxes\\a\\data', realDir: 'Z:\\Books\\Acme.ironbooks', realFile: null };
    expect(make(sb)('C:\\Sandboxes\\a\\data')).toEqual({ dir: sb.dir, realDir: sb.realDir });
    expect(make(sb)('C:\\Other\\data')).toEqual({ dir: '', realDir: '' });
    expect(make(null)('C:\\Sandboxes\\a\\data')).toEqual({ dir: '', realDir: '' });
    expect(make({ dir: sb.dir })('C:\\Sandboxes\\a\\data')).toEqual({ dir: '', realDir: '' });
  });

  it('main.js passes it to the company server only (a scratch server never gets one)', () => {
    const company = fnBody('async function startNextServer() {');
    expect(company).toMatch(/const sandboxRecord = sandboxRecordFor\(dataDir\);/);
    expect(company).toMatch(/BKA_SANDBOX_DIR: sandboxRecord\.dir,\s*BKA_SANDBOX_REAL_DIR: sandboxRecord\.realDir,/);
    const scratch = fnBody('async function startScratchServer(dataDir) {');
    expect(scratch).toMatch(/BKA_SANDBOX_DIR: '',\s*BKA_SANDBOX_REAL_DIR: '',/);
  });
});
