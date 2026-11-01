// The company file's own passwords: encryption at rest for "ABC Company.ironbooks" and every
// copy of it (backups, safety copies, condense archives, Save Copy As, "unsaved changes" copies).
//
// A protected company file has one random 256-bit FILE KEY. Every entry of the file except its
// plaintext manifest is encrypted with it (AES-256-GCM, a fresh nonce per entry and per save, the
// entry's names as additional data — electron/companyFileFormat.js). The file key itself is never
// written anywhere: the manifest carries KEY SLOTS, each holding the file key wrapped (AES-256-GCM)
// with a key derived (scrypt, its own salt) from one secret:
//
//   password   one per user who has a password — the same user name + password that signs in
//   challenge  one per user who set a challenge question — the normalized answer
//                ("I forgot my password", lib/challengeQuestions.ts)
//   recovery   one printable recovery key, shown once — the way back in when every password is lost
//
// A slot is found by a lookup tag (an HMAC of the user name with the file's random lookup salt),
// so the manifest never lists user names. The app server keeps the file key in memory only
// (lib/services/fileProtection.ts): never in a file, the environment, a log or a URL.
//
// Pure Node (crypto): used by the desktop shell and the app server, and unit-tested from vitest
// (test/fileCrypto.test.ts).
'use strict';

const crypto = require('node:crypto');

const CIPHER = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const SLOT_KINDS = new Set(['password', 'challenge', 'recovery']);

/**
 * scrypt cost for new slots: N=2^16, r=8 (64 MiB, about 150-300 ms on an ordinary office PC — a
 * guess at a password costs an attacker the same). Each slot records the parameters it was made
 * with, so a later version can raise them; a sign-in re-wraps a slot made with weaker ones.
 */
const DEFAULT_KDF = Object.freeze({ name: 'scrypt', N: 65536, r: 8, p: 1 });
/** Unit tests only (NODE_ENV=test and BKA_TEST_FAST_KDF=1): the same code with a cheap cost. */
const TEST_KDF = Object.freeze({ name: 'scrypt', N: 1024, r: 8, p: 1 });
/** Never derive with absurd parameters from a tampered manifest (a memory / CPU bomb). */
const MAX_N = 1 << 20;
const MAX_R = 32;
const MAX_P = 16;

function currentKdf() {
  return process.env.NODE_ENV === 'test' && process.env.BKA_TEST_FAST_KDF === '1' ? TEST_KDF : DEFAULT_KDF;
}

function b64(buf) {
  return Buffer.from(buf).toString('base64url');
}

function unb64(s) {
  return typeof s === 'string' && /^[A-Za-z0-9_-]*$/.test(s) ? Buffer.from(s, 'base64url') : null;
}

function validKdf(kdf) {
  if (!kdf || typeof kdf !== 'object' || kdf.name !== 'scrypt') return false;
  const { N, r, p } = kdf;
  return (
    Number.isInteger(N) && N >= 2 && N <= MAX_N && (N & (N - 1)) === 0 &&
    Number.isInteger(r) && r >= 1 && r <= MAX_R &&
    Number.isInteger(p) && p >= 1 && p <= MAX_P
  );
}

/** True when a slot was made with at least today's cost (otherwise a sign-in re-wraps it). */
function kdfIsCurrent(kdf) {
  const cur = currentKdf();
  return validKdf(kdf) && kdf.N >= cur.N && kdf.r >= cur.r && kdf.p >= cur.p;
}

/** The key-encryption key for one secret (async: runs on the thread pool, never blocks requests). */
function deriveKek(secret, salt, kdf) {
  const pass = Buffer.from(String(secret).normalize('NFC'), 'utf8');
  const saltBuf = typeof salt === 'string' ? unb64(salt) : salt;
  if (!saltBuf || !validKdf(kdf)) return Promise.reject(new Error('invalid key slot parameters'));
  return new Promise((resolve, reject) => {
    crypto.scrypt(pass, saltBuf, KEY_BYTES, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r * kdf.p + (1 << 20) }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

function slotAad(kind, salt) {
  return Buffer.from(`ironbooks-slot/v1\n${kind}\n${salt}`, 'utf8');
}

/** A fresh random file key (32 bytes). */
function generateFileKey() {
  return crypto.randomBytes(KEY_BYTES);
}

/** The file's random lookup salt (slots are found by an HMAC of the user name with it). */
function newLookupSalt() {
  return b64(crypto.randomBytes(SALT_BYTES));
}

/** "Mary" and " mary " are the same user name (lib/services/users.ts normLogin). */
function normalizeLogin(login) {
  return String(login || '').trim().toLowerCase();
}

/**
 * The lookup tag of a user name: which slots are that user's, without naming them.
 * @param {string | null | undefined} lookupSalt
 * @param {string | null | undefined} login
 * @returns {string}
 */
function lookupTag(lookupSalt, login) {
  const salt = unb64(lookupSalt) || Buffer.alloc(0);
  return crypto.createHmac('sha256', salt).update(`login\n${normalizeLogin(login)}`).digest('base64url').slice(0, 22);
}

/**
 * A short digest that names a file key without revealing it: tells whether the key in memory is
 * the one a backup or a copy was made with (HMAC of a constant with the key).
 */
function keyCheckOf(fileKey) {
  return crypto.createHmac('sha256', fileKey).update('ironbooks/key-check/v1').digest('base64url').slice(0, 22);
}

/**
 * Wrap `fileKey` into a new slot for `secret` (a password, a normalized challenge answer, or a
 * normalized recovery key). `tag` (lookupTag) names whose slot it is; `question` is shown before
 * the challenge answer is asked (it comes from a fixed list, lib/challengeQuestions.ts).
 * @param {{ kind: string, secret: string, fileKey: Buffer, tag?: string | null, question?: string | null, kdf?: { name: string, N: number, r: number, p: number } }} opts
 * @returns {Promise<Record<string, any>>}
 */
async function makeSlot({ kind, secret, fileKey, tag = null, question = null, kdf = currentKdf() }) {
  if (!SLOT_KINDS.has(kind)) throw new Error(`unknown key slot kind ${kind}`);
  if (!Buffer.isBuffer(fileKey) || fileKey.length !== KEY_BYTES) throw new Error('invalid file key');
  if (typeof secret !== 'string' || !secret) throw new Error('a key slot needs a secret');
  const salt = b64(crypto.randomBytes(SALT_BYTES));
  const kek = await deriveKek(secret, salt, kdf);
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const c = crypto.createCipheriv(CIPHER, kek, nonce);
  c.setAAD(slotAad(kind, salt));
  const wrapped = Buffer.concat([c.update(fileKey), c.final(), c.getAuthTag()]);
  return {
    kind,
    ...(tag ? { tag } : {}),
    ...(question ? { question } : {}),
    kdf: { name: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p },
    salt,
    nonce: b64(nonce),
    wrapped: b64(wrapped),
  };
}

/** The same slot with a new lookup tag (the user name changed; the secret did not). */
function retagSlot(slot, tag) {
  return { ...slot, tag };
}

function wellFormedSlot(slot) {
  if (!slot || typeof slot !== 'object' || !SLOT_KINDS.has(slot.kind) || !validKdf(slot.kdf)) return false;
  const salt = unb64(slot.salt);
  const nonce = unb64(slot.nonce);
  const wrapped = unb64(slot.wrapped);
  return Boolean(salt && salt.length >= 8 && nonce && nonce.length === NONCE_BYTES && wrapped && wrapped.length === KEY_BYTES + TAG_BYTES);
}

/**
 * Unwrap a slot with `secret`: the file key, or null when the secret is wrong or the slot was
 * tampered with (the GCM tag covers the key, the kind and the salt).
 * @param {any} slot
 * @param {string | null | undefined} secret
 * @returns {Promise<Buffer | null>}
 */
async function openSlot(slot, secret) {
  if (!wellFormedSlot(slot) || typeof secret !== 'string' || !secret) return null;
  let kek;
  try {
    kek = await deriveKek(secret, slot.salt, slot.kdf);
  } catch {
    return null;
  }
  try {
    const wrapped = unb64(slot.wrapped);
    const d = crypto.createDecipheriv(CIPHER, kek, unb64(slot.nonce));
    d.setAAD(slotAad(slot.kind, slot.salt));
    d.setAuthTag(wrapped.subarray(KEY_BYTES));
    const key = Buffer.concat([d.update(wrapped.subarray(0, KEY_BYTES)), d.final()]);
    return key.length === KEY_BYTES ? key : null;
  } catch {
    return null;
  }
}

/**
 * Spend exactly what opening a slot costs, for a user name that has none: a wrong user name and
 * a wrong password take the same time (no way to find out which user names exist).
 * @param {unknown} secret
 * @param {{ name: string, N: number, r: number, p: number }} [kdf]
 * @returns {Promise<null>}
 */
async function burnKdf(secret, kdf = currentKdf()) {
  try {
    await deriveKek(String(secret || 'x'), crypto.randomBytes(SALT_BYTES), kdf);
  } catch {
    /* nothing to protect */
  }
  return null;
}

/**
 * The slots of `encryption` (a manifest's block) for one kind and, for user slots, one tag.
 * @param {any} encryption
 * @param {string} kind
 * @param {string | null} [tag]
 * @returns {Array<Record<string, any>>}
 */
function findSlots(encryption, kind, tag = null) {
  const slots = encryption && Array.isArray(encryption.slots) ? encryption.slots : [];
  return slots.filter((s) => s && s.kind === kind && (kind === 'recovery' || (tag && s.tag === tag)));
}

/**
 * Try `secret` on the slots of one kind (and user, by `login`): the file key or null. Always
 * spends at least one derivation, so the answer takes as long whether or not the user exists.
 * A key that does not match the block's keyCheck (a slot pasted in from another file) is refused.
 * @param {any} encryption
 * @param {{ kind: string, login?: string | null, secret: string }} opts
 * @returns {Promise<Buffer | null>}
 */
async function unlockWith(encryption, { kind, login = null, secret }) {
  const tag = kind === 'recovery' ? null : lookupTag(encryption && encryption.lookupSalt, login || '');
  const candidates = findSlots(encryption, kind, tag).filter(wellFormedSlot);
  if (!candidates.length) return burnKdf(secret);
  for (const slot of candidates) {
    const key = await openSlot(slot, secret);
    if (key && (!encryption.keyCheck || keyCheckOf(key) === encryption.keyCheck)) return key;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Recovery keys: 24 characters, Crockford base32 (no I, L, O, U), read in six groups of four
// ("7K3Q-9XHD-…"). 120 random bits — far beyond guessing, even offline.
// ---------------------------------------------------------------------------

const RK_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RK_LENGTH = 24;

function generateRecoveryKey() {
  const bytes = crypto.randomBytes(15); // 120 bits = 24 base32 characters
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += RK_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return formatRecoveryKey(out);
}

/**
 * What the person typed, as the 24 characters the key is made of: case, spaces and dashes do not
 * matter, and the letters people confuse with digits (O, I, L) read as 0 and 1. Null when it can't
 * be a recovery key.
 */
function normalizeRecoveryKey(input) {
  if (typeof input !== 'string') return null;
  const s = input
    .toUpperCase()
    .replace(/[\s\-_.]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (s.length !== RK_LENGTH) return null;
  for (const ch of s) if (!RK_ALPHABET.includes(ch)) return null;
  return s;
}

/** "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX". */
function formatRecoveryKey(normalized) {
  const s = normalizeRecoveryKey(normalized) || String(normalized || '');
  return s.match(/.{1,4}/g).join('-');
}

// ---------------------------------------------------------------------------
// Entries: AES-256-GCM, nonce | ciphertext | tag. The names are the additional data, so an entry
// moved to another name, another file or another save does not decrypt.
// ---------------------------------------------------------------------------

/** Additional data of one encrypted entry: the container (sealId) and both of its names. */
function entryAad(sealId, zipName, name) {
  return Buffer.from(`ironbooks-sealed/v1\n${sealId}\n${zipName}\n${name}`, 'utf8');
}

class TamperedError extends Error {
  constructor(what) {
    super(`${what} failed its integrity check — the file is damaged or was changed outside Ironbooks.`);
    this.name = 'TamperedError';
    this.code = 'TAMPERED';
  }
}

function sealBytes(fileKey, plaintext, aad) {
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const c = crypto.createCipheriv(CIPHER, fileKey, nonce);
  c.setAAD(aad);
  return Buffer.concat([nonce, c.update(plaintext), c.final(), c.getAuthTag()]);
}

/**
 * Decrypt and VERIFY one entry: the whole entry is authenticated before a single byte is returned
 * (so nothing unverified is ever written to disk). Throws TamperedError otherwise.
 */
function openBytes(fileKey, sealed, aad, what = 'An entry of the company file') {
  if (!Buffer.isBuffer(sealed) || sealed.length < NONCE_BYTES + TAG_BYTES) throw new TamperedError(what);
  try {
    const d = crypto.createDecipheriv(CIPHER, fileKey, sealed.subarray(0, NONCE_BYTES));
    d.setAAD(aad);
    d.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    return Buffer.concat([d.update(sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES)), d.final()]);
  } catch {
    throw new TamperedError(what);
  }
}

function newSealId() {
  return b64(crypto.randomBytes(16));
}

// ---------------------------------------------------------------------------
// A whole file under ONE password: the portable company file (.bkp) and the Accountant's Copy
// transfer file (.ibac), when they are given a password (on by default). Layout:
//   "IRONBOOKS-PROTECTED\n" | uint32 header length | header JSON | ciphertext | GCM tag
// The header ({ v, kind, kdf, salt, nonce }) is the additional data, so it can't be changed; the
// file is verified as a whole before a single byte of it is used.
// ---------------------------------------------------------------------------

const ENVELOPE_MAGIC = Buffer.from('IRONBOOKS-PROTECTED\n', 'utf8');

/** True when `buf` is a file protected with a password (sealWithPassword). */
function isPasswordSealed(buf) {
  return Buffer.isBuffer(buf) && buf.length > ENVELOPE_MAGIC.length + 4 && buf.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC);
}

function envelopeParts(buf) {
  if (!isPasswordSealed(buf)) return null;
  const len = buf.readUInt32BE(ENVELOPE_MAGIC.length);
  const start = ENVELOPE_MAGIC.length + 4;
  if (len <= 0 || len > 64 * 1024 || start + len + TAG_BYTES > buf.length) return null;
  let header;
  try {
    header = JSON.parse(buf.subarray(start, start + len).toString('utf8'));
  } catch {
    return null;
  }
  if (!header || header.v !== 1 || !validKdf(header.kdf) || !unb64(header.salt) || !unb64(header.nonce)) return null;
  return { header, aad: buf.subarray(0, start + len), body: buf.subarray(start + len) };
}

/** The plain header of a password-protected file ({ v, kind, kdf, ... }), or null. */
function passwordEnvelopeInfo(buf) {
  const parts = envelopeParts(buf);
  return parts ? { kind: parts.header.kind || null } : null;
}

/**
 * Encrypt `plain` (a whole file) under `password`: a key derived with scrypt (its own salt, the
 * same cost as a key slot), AES-256-GCM.
 * @param {Buffer} plain
 * @param {string} password
 * @param {{ kind?: string }} [opts]
 * @returns {Promise<Buffer>}
 */
async function sealWithPassword(plain, password, { kind = 'file' } = {}) {
  if (typeof password !== 'string' || !password) throw new Error('a password is required');
  const kdf = currentKdf();
  const salt = b64(crypto.randomBytes(SALT_BYTES));
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const header = Buffer.from(JSON.stringify({ v: 1, kind, cipher: CIPHER, kdf: { name: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p }, salt, nonce: b64(nonce) }), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length, 0);
  const aad = Buffer.concat([ENVELOPE_MAGIC, len, header]);
  const kek = await deriveKek(password, salt, kdf);
  const c = crypto.createCipheriv(CIPHER, kek, nonce);
  c.setAAD(aad);
  return Buffer.concat([aad, c.update(plain), c.final(), c.getAuthTag()]);
}

/**
 * Decrypt a password-protected file: the plain bytes, or null when the password is wrong (or the
 * file was changed — the two can't be told apart, and neither opens it).
 * @param {Buffer} buf
 * @param {string} password
 * @returns {Promise<Buffer | null>}
 */
async function openWithPassword(buf, password) {
  const parts = envelopeParts(buf);
  if (!parts || typeof password !== 'string' || !password) {
    await burnKdf(password);
    return null;
  }
  let kek;
  try {
    kek = await deriveKek(password, parts.header.salt, parts.header.kdf);
  } catch {
    return null;
  }
  try {
    const d = crypto.createDecipheriv(CIPHER, kek, unb64(parts.header.nonce));
    d.setAAD(parts.aad);
    d.setAuthTag(parts.body.subarray(parts.body.length - TAG_BYTES));
    return Buffer.concat([d.update(parts.body.subarray(0, parts.body.length - TAG_BYTES)), d.final()]);
  } catch {
    return null;
  }
}

module.exports = {
  CIPHER,
  KEY_BYTES,
  DEFAULT_KDF,
  currentKdf,
  kdfIsCurrent,
  validKdf,
  generateFileKey,
  newLookupSalt,
  normalizeLogin,
  lookupTag,
  keyCheckOf,
  makeSlot,
  retagSlot,
  wellFormedSlot,
  openSlot,
  burnKdf,
  findSlots,
  unlockWith,
  generateRecoveryKey,
  normalizeRecoveryKey,
  formatRecoveryKey,
  entryAad,
  sealBytes,
  openBytes,
  newSealId,
  TamperedError,
  isPasswordSealed,
  passwordEnvelopeInfo,
  sealWithPassword,
  openWithPassword,
};
