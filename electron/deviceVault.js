// This computer's secret for saved keys of outside services (security plan 1.3).
//
// AI provider keys, the "Continue with ChatGPT" sign-in and the mail server password belong to the
// computer (Windows account) that entered them, not to the company file: a copy of the file, a
// backup or a portable file must not carry anything that opens them. The app server seals them
// under one random 32-byte secret per Windows user profile (lib/ai/keyVault.ts "v3:"), which is
// kept here, in userData, wrapped by the operating system (Electron safeStorage: DPAPI on Windows,
// the Keychain on macOS). The server cannot call safeStorage (it runs as plain Node), so the shell
// unwraps the secret and hands it to every server it starts in its environment (BKA_DEVICE_VAULT),
// never on the command line and never in a log.
//
// Never in the way of opening the books:
//  - no safeStorage (Linux without a keyring: the 'basic_text' backend, which is no protection):
//    no secret at all, and the server keeps the company file's own key as before;
//  - a wrapped secret this account cannot unwrap (the profile was copied from another computer, a
//    userData folder on a USB stick, the Windows key was reset) is KEPT, and a new secret is added
//    beside it: keys sealed under the old one ask to be set up again here, and the computer that can
//    still unwrap it keeps using it (the first secret that unwraps wins);
//  - a file that cannot be read at all (locked for a moment) is never overwritten: no secret this
//    launch;
//  - a damaged file is set aside (renamed), never deleted.
//
// Pure (fs, safeStorage and randomness injected) so it is unit-tested without Electron.

'use strict';

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const path = require('node:path');

const VAULT_FILE = 'device-vault.json';
/** The environment variable the shell passes the unwrapped secret to its servers in. */
const DEVICE_VAULT_ENV = 'BKA_DEVICE_VAULT';
/** Wrapped secrets kept for other computers / accounts sharing this userData folder. */
const MAX_KEPT = 8;
const HEX64 = /^[0-9a-f]{64}$/;

/** True when safeStorage really protects what it wraps (never Linux's plain-text fallback). */
function osProtectionAvailable(safeStorage, platform = process.platform) {
  try {
    if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function' || !safeStorage.isEncryptionAvailable()) return false;
    if (platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
      const backend = safeStorage.getSelectedStorageBackend();
      if (backend === 'basic_text' || backend === 'unknown') return false;
    }
    return true;
  } catch {
    return false;
  }
}

function unwrap(safeStorage, b64) {
  try {
    const plain = safeStorage.decryptString(Buffer.from(String(b64), 'base64'));
    return typeof plain === 'string' && HEX64.test(plain) ? plain : null;
  } catch {
    return null;
  }
}

/**
 * This Windows account's device secret (64 hex characters), created on first need; '' when the
 * operating system cannot protect it or anything goes wrong (the server then works as before).
 * Never throws.
 */
function loadOrCreateDeviceSecret({
  dir,
  safeStorage,
  platform = process.platform,
  fs = nodeFs,
  randomBytes = crypto.randomBytes,
  log = (msg) => console.warn(msg),
  now = () => Date.now(),
} = {}) {
  try {
    if (!dir || !osProtectionAvailable(safeStorage, platform)) return '';
    const file = path.join(dir, VAULT_FILE);
    let kept = [];
    if (fs.existsSync(file)) {
      let raw;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch {
        // There, but not readable right now: never replace it (it may hold this computer's secret).
        log('[device-vault] could not read the saved key file; saved AI and email keys wait until the next start.');
        return '';
      }
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      if (parsed && Array.isArray(parsed.secrets)) {
        kept = parsed.secrets.filter((s) => typeof s === 'string' && s.length > 0 && s.length < 4096);
        for (const wrapped of kept) {
          const secret = unwrap(safeStorage, wrapped);
          if (secret) return secret;
        }
        log('[device-vault] this Windows account cannot unlock the saved key file; making a new one (AI and email are set up again on this computer).');
      } else {
        try {
          fs.renameSync(file, `${file}.damaged-${now()}`);
        } catch {
          return '';
        }
        log('[device-vault] the saved key file was damaged and was set aside; making a new one (AI and email are set up again on this computer).');
        kept = [];
      }
    }
    const secret = randomBytes(32).toString('hex');
    const wrapped = safeStorage.encryptString(secret).toString('base64');
    // Check the round trip before anything is written: a secret that can't be unwrapped again
    // would seal keys nobody can open.
    if (unwrap(safeStorage, wrapped) !== secret) return '';
    const secrets = [wrapped, ...kept].slice(0, MAX_KEPT);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, secrets }) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    return secret;
  } catch {
    return '';
  }
}

module.exports = { VAULT_FILE, DEVICE_VAULT_ENV, MAX_KEPT, osProtectionAvailable, loadOrCreateDeviceSecret };
