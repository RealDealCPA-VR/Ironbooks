// The single-file company file: "ABC Company.ironbooks", the way QuickBooks has "ABC Company.QBW".
//
// One ordinary file you can copy to a USB stick, put on the office file server, e-mail to your
// accountant or double-click to open. Inside it is a standard zip archive:
//
//   ironbooks-company.json     the manifest (first entry, stored uncompressed so the No Company
//                              Open list and the "in use" checks can read it from the first few
//                              kilobytes of the file without reading the rest)
//   bookkeeper-manifest.json   the .bka backup manifest: a company file is also a valid full
//                              backup, and Restore accepts it like any .bka
//   PG_VERSION, base/, …       the embedded database folder (PGlite), plus attachments/ and the
//                              running transaction log (transactions.bktlg)
//
// A company file protected with passwords (format 2, electron/fileCrypto.js) keeps only the
// manifest in plain text — the company name, file id, save ids, dates, app version and the key
// slots — and every other entry encrypted with the file key under an opaque name:
//
//   ironbooks-company.json     the manifest, with `encryption` { sealId, keyCheck, lookupSalt, slots }
//   sealed/000001, …           one encrypted entry per file (AES-256-GCM: nonce | data | tag; the
//                              sealId and the entry's opaque and real names are the additional data;
//                              layout 2: under a subkey of the file key for this container alone)
//   sealed/index               encrypted: the real names, sizes and checksums of the entries above,
//                              the save's private details (transaction-log head, who saved it) and
//                              a copy of the plain manifest's listing — checked when the file is
//                              opened, so the plain fields can't be changed without the key
//
// Backups (.bka) of a protected file use the same layout with the backup manifest as the plain
// first entry, so a backup is protected exactly like the file it was made from.
//
// While the file is open, the app works in a private working copy of that folder on this
// computer (electron/companySession.js) and saves it back here (lib/services/companyFileSave.ts):
// the whole archive is written to a temporary file next to the company file and renamed over
// it, so the company file on disk is always either the previous save or the new one, never a
// half-written mix — even if the network or the power drops in the middle of a save.
//
// Pure Node (fs, zlib, crypto): used by the desktop shell (open, extract, read the manifest)
// and by the app server (save), and unit-tested from vitest (test/companyFileFormat.test.ts).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const fileCrypto = require('./fileCrypto');

const deflateRaw = promisify(zlib.deflateRaw);
const inflateRaw = promisify(zlib.inflateRaw);

const COMPANY_FILE_EXT = '.ironbooks';
const COMPANY_MANIFEST_ENTRY = 'ironbooks-company.json';
/** Same name and shape as lib/services/backup.ts BACKUP_MANIFEST_ENTRY. */
const BACKUP_MANIFEST_ENTRY = 'bookkeeper-manifest.json';
const COMPANY_FILE_SCHEMA = 'ironbooks-company-file/v1';
/**
 * Bump when a company file written by this version can't be read by older ones. 2: the file may
 * be encrypted (sealed). Every save writes 2, so Ironbooks 1.6 — which refuses anything above 1 —
 * never opens (and so never downgrades) a file a newer version has saved.
 */
const COMPANY_FILE_FORMAT_VERSION = 2;
/** The backup manifest's format (lib/services/backup.ts BACKUP_FORMAT_VERSION): 2 = may be sealed. */
const BACKUP_FORMAT_VERSION = 2;
/** The encrypted list of a sealed container's entries. */
const SEALED_INDEX_ENTRY = 'sealed/index';
const SEALED_PREFIX = 'sealed/';

/**
 * Paths in the working folder that never go into the company file: the working copy's own open
 * lock and clock probes (lib/db/dirLock.ts), this computer's session-signing key (lib/auth.ts —
 * every computer makes its own), a sandbox marker, the "this folder is protected" marker (the
 * database's own protection record is what counts; lib/services/fileProtection.ts writes the
 * marker wherever the books are decrypted), PostgreSQL's per-run scratch files, and leftovers of
 * an earlier save.
 */
function isExcludedPath(rel) {
  const p = rel.replace(/\\/g, '/');
  const base = p.split('/').pop() || '';
  if (p === 'ironbooks.lock' || p === '.auth-secret' || p === '.ironbooks-sandbox.json' || p === '.ironbooks-protected' || p === 'postmaster.pid') {
    return true;
  }
  if (base.startsWith('.ironbooks-clock-')) return true;
  // A lock moved aside during a takeover (lib/db/dirLock.ts) that a crash left behind.
  if (p.startsWith('ironbooks.lock.takeover-')) return true;
  if (p.startsWith('pg_stat_tmp/')) return true;
  return false;
}

/** Zip entry names are relative, forward-slash paths with no "..", drive letters or NULs. */
function safeEntryName(name) {
  if (typeof name !== 'string' || !name || name.length > 1024) return null;
  const n = name.replace(/\\/g, '/');
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.includes('\0')) return null;
  const parts = n.split('/');
  const isDir = n.endsWith('/');
  const segs = isDir ? parts.slice(0, -1) : parts;
  if (!segs.length || segs.some((s) => s === '' || s === '.' || s === '..')) return null;
  return n;
}

// ---------------------------------------------------------------------------
// CRC-32 (zlib.crc32 when this Node has it)
// ---------------------------------------------------------------------------

let crcTable = null;
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Snapshot: read the working folder
// ---------------------------------------------------------------------------

/**
 * Read every file of `dir` SYNCHRONOUSLY. The embedded database runs in the same process and
 * only writes between JavaScript turns, so a snapshot taken in one turn is exactly what a power
 * cut at that instant would leave on disk — which PostgreSQL is built to recover from. Files under
 * `lazyPrefixes` (attachments, which are written once and never changed) are only listed here
 * and read later, so a snapshot of a file with many scanned receipts stays quick.
 *
 * Returns [{ name, dir?: true, data?: Buffer, file?: string, mtimeMs }], directories included
 * (PostgreSQL needs its empty ones).
 */
function snapshotDir(dir, { lazyPrefixes = ['attachments/'] } = {}) {
  const out = [];
  const walk = (abs, rel) => {
    let names;
    try {
      names = fs.readdirSync(abs, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      throw err;
    }
    names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of names) {
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (isExcludedPath(childRel)) continue;
      const childAbs = path.join(abs, d.name);
      if (d.isDirectory()) {
        out.push({ name: `${childRel}/`, dir: true });
        walk(childAbs, childRel);
      } else if (d.isFile()) {
        let st;
        try {
          st = fs.statSync(childAbs);
        } catch (err) {
          if (err && err.code === 'ENOENT') continue; // removed while listing
          throw err;
        }
        if (lazyPrefixes.some((p) => childRel.startsWith(p))) {
          out.push({ name: childRel, file: childAbs, size: st.size, mtimeMs: st.mtimeMs });
        } else {
          let data;
          try {
            data = fs.readFileSync(childAbs);
          } catch (err) {
            if (err && err.code === 'ENOENT') continue;
            throw err;
          }
          out.push({ name: childRel, data, mtimeMs: st.mtimeMs });
        }
      }
    }
  };
  walk(dir, '');
  return out;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function dosDateTime(ms) {
  const d = new Date(ms || Date.now());
  const year = Math.max(1980, d.getFullYear());
  return {
    time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31),
    date: (((year - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31),
  };
}

/** File types that are already compressed: storing them costs nothing and saves the CPU. */
const STORE_EXT = /\.(jpe?g|png|gif|webp|heic|pdf|zip|gz|7z|xlsx|docx|bka|bkp|ironbooks|mp4|mov)$/i;

const UINT32_MAX = 0xffffffff;

function zip64Extra(fields) {
  // Header 0x0001, then the 8-byte values present (sizes / offset), in spec order.
  const body = Buffer.alloc(fields.length * 8);
  fields.forEach((v, i) => body.writeBigUInt64LE(BigInt(v), i * 8));
  const head = Buffer.alloc(4);
  head.writeUInt16LE(0x0001, 0);
  head.writeUInt16LE(body.length, 2);
  return Buffer.concat([head, body]);
}

function shouldDeflate(entry, name, raw) {
  return !entry.store && raw.length > 64 && !STORE_EXT.test(name);
}

/**
 * Compress one entry. `cache` (optional Map, kept by the caller between saves) remembers each
 * file's compressed bytes by name + size + CRC, so a save only compresses what changed.
 */
async function prepareEntry(entry, cache) {
  const name = safeEntryName(entry.name);
  if (!name) throw new Error(`Unsafe name in company file: ${entry.name}`);
  const nameBuf = Buffer.from(name, 'utf8');
  if (entry.dir) {
    return { name, nameBuf, method: 0, crc: 0, size: 0, compressed: Buffer.alloc(0), mtimeMs: entry.mtimeMs, dir: true };
  }
  let raw = entry.data;
  if (!raw && entry.file) {
    try {
      raw = await fs.promises.readFile(entry.file);
    } catch (err) {
      if (err && err.code === 'ENOENT') return null; // an attachment deleted since the snapshot
      throw err;
    }
  }
  raw = raw || Buffer.alloc(0);
  const crc = crc32(raw);
  const key = `${name}\u0000${raw.length}\u0000${crc}`;
  const hit = cache && cache.get(name);
  if (hit && hit.key === key) {
    return { name, nameBuf, method: hit.method, crc, size: raw.length, compressed: hit.compressed, mtimeMs: entry.mtimeMs };
  }
  let method = 0;
  let compressed = raw;
  if (shouldDeflate(entry, name, raw)) {
    const z = await deflateRaw(raw, { level: 6 });
    if (z.length < raw.length) {
      method = 8;
      compressed = z;
    }
  }
  if (cache) cache.set(name, { key, method, compressed });
  return { name, nameBuf, method, crc, size: raw.length, compressed, mtimeMs: entry.mtimeMs };
}

/** prepareEntry for in-memory archives (backups built by the app server): synchronous, no cache. */
function prepareEntrySync(entry) {
  const name = safeEntryName(entry.name);
  if (!name) throw new Error(`Unsafe name in archive: ${entry.name}`);
  const nameBuf = Buffer.from(name, 'utf8');
  if (entry.dir) return { name, nameBuf, method: 0, crc: 0, size: 0, compressed: Buffer.alloc(0), mtimeMs: entry.mtimeMs, dir: true };
  let raw = entry.data;
  if (!raw && entry.file) {
    try {
      raw = fs.readFileSync(entry.file);
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      throw err;
    }
  }
  raw = raw || Buffer.alloc(0);
  let method = 0;
  let compressed = raw;
  if (shouldDeflate(entry, name, raw)) {
    const z = zlib.deflateRawSync(raw, { level: 6 });
    if (z.length < raw.length) {
      method = 8;
      compressed = z;
    }
  }
  return { name, nameBuf, method, crc: crc32(raw), size: raw.length, compressed, mtimeMs: entry.mtimeMs };
}

/**
 * JSON with its object keys sorted (at every level): two listings compare equal exactly when they
 * hold the same fields and values, whatever order they were written in.
 */
function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

/** A sealed manifest's encryption block without its key slots (those are rewritten in place). */
function encryptionListing(enc) {
  if (!enc || typeof enc !== 'object') return null;
  const out = { ...enc };
  delete out.slots;
  return out;
}

/**
 * What of a sealed container's plain manifest is bound into its encrypted index (and so checked
 * once the file key is known): every plain field, the encryption details too — except the key
 * slots, which open the key and are themselves authenticated.
 */
function listingOf(manifest) {
  const out = { ...manifest };
  if (out.encryption) out.encryption = encryptionListing(out.encryption);
  return out;
}

/**
 * Sealing (encryption) of a container being written. `seal` = { fileKey, sealId, v (layout),
 * plain: Set of entry names kept in plain text (the first manifest), info: private details for
 * the index, bound: { head, fields } — the plain manifest's listing, bound into the index }.
 * Each other entry is replaced by an encrypted one under an opaque name; directories are only
 * listed in the index; the index is the last entry.
 */
function makeSealer(seal) {
  if (!seal) return null;
  const index = [];
  const sealedAt = Date.now();
  const key = fileCrypto.containerKey(seal.fileKey, seal.sealId, seal.v);
  let n = 0;
  return {
    /** The entry as written: itself (plain), an encrypted stand-in, or null (listed only). */
    transform(e) {
      if (seal.plain.has(e.name)) return e;
      if (e.name === SEALED_INDEX_ENTRY || e.name.startsWith(SEALED_PREFIX)) {
        throw new Error(`Reserved name in company file: ${e.name}`);
      }
      if (e.dir) {
        index.push({ name: e.name, dir: true });
        return null;
      }
      n++;
      const z = `${SEALED_PREFIX}${String(n).padStart(6, '0')}`;
      const sealed = fileCrypto.sealBytes(key, e.compressed, fileCrypto.entryAad(seal.sealId, z, e.name));
      index.push({ z, name: e.name, m: e.method, size: e.size, crc: e.crc, t: Math.round(e.mtimeMs || 0) });
      return { name: z, nameBuf: Buffer.from(z, 'utf8'), method: 0, crc: crc32(sealed), size: sealed.length, compressed: sealed, mtimeMs: sealedAt };
    },
    /** The encrypted index, the container's last entry. */
    finish() {
      const body = Buffer.from(
        JSON.stringify({ v: seal.v === 1 ? 1 : 2, sealId: seal.sealId, entries: index, info: seal.info || {}, ...(seal.v === 1 || !seal.bound ? {} : { plain: seal.bound }) }),
        'utf8',
      );
      const sealed = fileCrypto.sealBytes(key, body, fileCrypto.entryAad(seal.sealId, SEALED_INDEX_ENTRY, SEALED_INDEX_ENTRY));
      return {
        name: SEALED_INDEX_ENTRY,
        nameBuf: Buffer.from(SEALED_INDEX_ENTRY, 'utf8'),
        method: 0,
        crc: crc32(sealed),
        size: sealed.length,
        compressed: sealed,
        mtimeMs: sealedAt,
      };
    },
  };
}

function localHeader(e) {
  const { time, date } = dosDateTime(e.mtimeMs);
  const big = e.size >= UINT32_MAX || e.compressed.length >= UINT32_MAX;
  const localExtra = big ? zip64Extra([e.size, e.compressed.length]) : Buffer.alloc(0);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(big ? 45 : 20, 4); // version needed
  lh.writeUInt16LE(0x0800, 6); // UTF-8 names
  lh.writeUInt16LE(e.method, 8);
  lh.writeUInt16LE(time, 10);
  lh.writeUInt16LE(date, 12);
  lh.writeUInt32LE(e.crc, 14);
  lh.writeUInt32LE(big ? UINT32_MAX : e.compressed.length, 18);
  lh.writeUInt32LE(big ? UINT32_MAX : e.size, 22);
  lh.writeUInt16LE(e.nameBuf.length, 26);
  lh.writeUInt16LE(localExtra.length, 28);
  return { header: Buffer.concat([lh, e.nameBuf, localExtra]), time, date };
}

function centralHeader(e) {
  const fields = [];
  if (e.size >= UINT32_MAX) fields.push(e.size);
  if (e.compressed.length >= UINT32_MAX) fields.push(e.compressed.length);
  if (e.localOffset >= UINT32_MAX) fields.push(e.localOffset);
  const extra = fields.length ? zip64Extra(fields) : Buffer.alloc(0);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE((3 << 8) | (fields.length ? 45 : 20), 4); // made by: Unix, so modes travel
  ch.writeUInt16LE(fields.length ? 45 : 20, 6);
  ch.writeUInt16LE(0x0800, 8);
  ch.writeUInt16LE(e.method, 10);
  ch.writeUInt16LE(e.time, 12);
  ch.writeUInt16LE(e.date, 14);
  ch.writeUInt32LE(e.crc, 16);
  ch.writeUInt32LE(e.compressed.length >= UINT32_MAX ? UINT32_MAX : e.compressed.length, 20);
  ch.writeUInt32LE(e.size >= UINT32_MAX ? UINT32_MAX : e.size, 24);
  ch.writeUInt16LE(e.nameBuf.length, 28);
  ch.writeUInt16LE(extra.length, 30);
  ch.writeUInt16LE(0, 32); // comment
  ch.writeUInt16LE(0, 34); // disk
  ch.writeUInt16LE(0, 36); // internal attrs
  // External attrs: unix mode in the high word, MS-DOS directory bit in the low one.
  ch.writeUInt32LE(e.dir ? ((0o40755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0, 38);
  ch.writeUInt32LE(e.localOffset >= UINT32_MAX ? UINT32_MAX : e.localOffset, 42);
  return Buffer.concat([ch, e.nameBuf, extra]);
}

function endRecords(count, cdStart, cdSize, z64Start) {
  const needZip64 = count > 0xfffe || cdStart >= UINT32_MAX || cdSize >= UINT32_MAX;
  const parts = [];
  if (needZip64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeUInt16LE(45, 12);
    rec.writeUInt16LE(45, 14);
    rec.writeUInt32LE(0, 16);
    rec.writeUInt32LE(0, 20);
    rec.writeBigUInt64LE(BigInt(count), 24);
    rec.writeBigUInt64LE(BigInt(count), 32);
    rec.writeBigUInt64LE(BigInt(cdSize), 40);
    rec.writeBigUInt64LE(BigInt(cdStart), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeUInt32LE(0, 4);
    loc.writeBigUInt64LE(BigInt(z64Start), 8);
    loc.writeUInt32LE(1, 16);
    parts.push(rec, loc);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(needZip64 ? 0xffff : count, 8);
  end.writeUInt16LE(needZip64 ? 0xffff : count, 10);
  end.writeUInt32LE(needZip64 ? UINT32_MAX : cdSize, 12);
  end.writeUInt32LE(needZip64 ? UINT32_MAX : cdStart, 16);
  end.writeUInt16LE(0, 20);
  parts.push(end);
  return Buffer.concat(parts);
}

/**
 * Write `entries` as a zip archive to `filePath` (created/truncated). The manifest entries should
 * come first. Uses ZIP64 records only when the archive needs them (over 4 GB or 65,535 entries).
 * With `seal` (makeSealer), every entry but the plain manifest is encrypted.
 */
/**
 * @param {string} filePath
 * @param {Array<Record<string, any>>} entries
 * @param {{ cache?: Map<string, any>, seal?: Record<string, any> | null }} [opts]
 */
async function writeZip(filePath, entries, { cache, seal } = {}) {
  const fh = await fs.promises.open(filePath, 'w');
  const central = [];
  let offset = 0;
  const write = async (buf) => {
    let done = 0;
    while (done < buf.length) {
      const { bytesWritten } = await fh.write(buf, done, buf.length - done, offset + done);
      done += bytesWritten;
    }
    offset += buf.length;
  };
  const sealer = makeSealer(seal);
  const emit = async (e) => {
    const localOffset = offset;
    const { header, time, date } = localHeader(e);
    await write(header);
    if (e.compressed.length) await write(e.compressed);
    central.push({ ...e, compressed: { length: e.compressed.length }, time, date, localOffset });
  };
  try {
    const seen = new Set();
    for (const raw of entries) {
      const prepared = await prepareEntry(raw, cache);
      if (!prepared) continue;
      if (seen.has(prepared.name)) continue;
      seen.add(prepared.name);
      const e = sealer ? sealer.transform(prepared) : prepared;
      if (e) await emit(e);
    }
    if (sealer) await emit(sealer.finish());

    const cdStart = offset;
    for (const e of central) await write(centralHeader(e));
    const cdSize = offset - cdStart;
    await write(endRecords(central.length, cdStart, cdSize, offset));
    await fh.sync();
    return { bytes: offset, entries: central.length };
  } finally {
    await fh.close();
  }
}

/**
 * The same archive built in memory (synchronously): backups made by the app server
 * (lib/services/backup.ts createBackup), sealed like the company file when it is protected.
 */
function zipBufferSync(entries, { seal } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  const sealer = makeSealer(seal);
  const emit = (e) => {
    const localOffset = offset;
    const { header, time, date } = localHeader(e);
    parts.push(header, e.compressed);
    offset += header.length + e.compressed.length;
    central.push({ ...e, compressed: { length: e.compressed.length }, time, date, localOffset });
  };
  const seen = new Set();
  for (const raw of entries) {
    const prepared = prepareEntrySync(raw);
    if (!prepared || seen.has(prepared.name)) continue;
    seen.add(prepared.name);
    const e = sealer ? sealer.transform(prepared) : prepared;
    if (e) emit(e);
  }
  if (sealer) emit(sealer.finish());
  const cdStart = offset;
  for (const e of central) {
    const h = centralHeader(e);
    parts.push(h);
    offset += h.length;
  }
  parts.push(endRecords(central.length, cdStart, offset - cdStart, offset));
  return Buffer.concat(parts);
}

/** Errors that mean "someone has the file open for a moment" (antivirus, a reader on the share). */
const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EEXIST']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** rename() with retries: Windows refuses to replace a file another program has open for a moment. */
async function renameWithRetry(from, to, attempts = 12) {
  for (let i = 0; ; i++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (err) {
      if (!BUSY_CODES.has(err && err.code) || i >= attempts - 1) throw err;
      await sleep(Math.min(2000, 100 * 2 ** i));
    }
  }
}

/** A temporary save this old is not in progress: it was cut short (a crash, a power cut). */
const STALE_SAVE_MS = 60 * 60_000;

/**
 * Remove temporary files of saves of `filePath` that were cut short (each is as big as the company
 * file, and would otherwise stay on the file server forever). Only this file's own, and only ones
 * no save can still be writing. Best effort.
 */
function removeStaleSaves(filePath, now = Date.now()) {
  const dir = path.dirname(filePath);
  const prefix = `.${path.basename(filePath)}.saving-`;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (!n.startsWith(prefix) || !/^[0-9a-f]{8}$/.test(n.slice(prefix.length))) continue;
    const p = path.join(dir, n);
    try {
      if (now - fs.statSync(p).mtimeMs > STALE_SAVE_MS) fs.rmSync(p, { force: true });
    } catch {
      /* in use or gone: next time */
    }
  }
}

/**
 * The `encryption` block of a sealed container's plain manifest. `protection` = { fileKey,
 * keyCheck, lookupSalt, slots } (lib/services/fileProtection.ts); `sealId` is new for every write.
 */
function encryptionBlock(protection, sealId) {
  return {
    // Layout 2: entries under a per-container subkey, the listing bound into the index. (Tests
    // write layout 1, the first protected files' layout, with protection.sealV = 1.)
    v: protection.sealV === 1 ? 1 : fileCrypto.SEAL_VERSION,
    cipher: fileCrypto.CIPHER,
    kdf: 'scrypt',
    sealId,
    keyCheck: protection.keyCheck || fileCrypto.keyCheckOf(protection.fileKey),
    lookupSalt: protection.lookupSalt || null,
    slots: Array.isArray(protection.slots) ? protection.slots : [],
  };
}

function checkProtection(protection) {
  if (!protection) return null;
  if (!Buffer.isBuffer(protection.fileKey) || protection.fileKey.length !== fileCrypto.KEY_BYTES) {
    throw new Error('A protected company file needs its file key to be saved.');
  }
  if (protection.keyCheck && protection.keyCheck !== fileCrypto.keyCheckOf(protection.fileKey)) {
    throw new Error('The file key does not belong to this company file.');
  }
  return protection;
}

/** Plain fields of a sealed manifest: only what the No Company Open list shows (+ the layout guard). */
const SEALED_PLAIN_FIELDS = ['formatVersion', 'fileId', 'companyName', 'saveId', 'previousSaveId', 'savedAt', 'appVersion', 'dbSchema', 'training'];

/**
 * Write a whole company file atomically: build it as `<file>.saving-<random>` in the same folder
 * (same disk / share, so the rename cannot copy), flush it to disk, then rename it over the
 * company file. A failure at any point leaves the previous company file untouched and the
 * temporary file removed.
 *
 * `manifest` is the company manifest (object); `entries` the snapshot (snapshotDir). With
 * `protection` ({ fileKey, keyCheck, lookupSalt, slots }) the file is sealed: only the manifest's
 * listing fields and the key slots stay readable; everything else, the backup manifest and the
 * manifest's private details (transaction-log head, who saved it) included, is encrypted.
 *
 * @param {string} filePath
 * `beforeRename()` runs once the new file is fully written, just before it replaces the company
 * file: throwing there leaves the company file untouched (the save re-checks it still may).
 *
 * @param {{ manifest: Record<string, unknown>, backupManifest?: Record<string, unknown> | null, entries: Array<Record<string, any>>, cache?: Map<string, any>, protection?: Record<string, any> | null, beforeRename?: () => void | Promise<void> }} opts
 */
async function writeCompanyFile(filePath, { manifest, backupManifest, entries, cache, protection, beforeRename }) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.saving-${crypto.randomBytes(4).toString('hex')}`);
  const prot = checkProtection(protection);
  let seal = null;
  let plainManifest = { schema: COMPANY_FILE_SCHEMA, ...manifest };
  if (prot) {
    const sealId = fileCrypto.newSealId();
    const visible = {};
    const info = {};
    for (const [k, v] of Object.entries(manifest)) {
      if (SEALED_PLAIN_FIELDS.includes(k)) visible[k] = v;
      else info[k] = v;
    }
    plainManifest = { schema: COMPANY_FILE_SCHEMA, ...visible, formatVersion: COMPANY_FILE_FORMAT_VERSION, encryption: encryptionBlock(prot, sealId) };
    // The listing (save ids, training flag, layout, …) is bound into the encrypted index: changed
    // without the key, the file is refused as tampered when it is opened.
    seal = {
      fileKey: prot.fileKey,
      sealId,
      v: plainManifest.encryption.v,
      plain: new Set([COMPANY_MANIFEST_ENTRY]),
      info,
      bound: { head: COMPANY_MANIFEST_ENTRY, fields: listingOf(plainManifest) },
    };
  }
  const head = [{ name: COMPANY_MANIFEST_ENTRY, data: Buffer.from(JSON.stringify(plainManifest, null, 2), 'utf8'), store: true }];
  if (backupManifest) {
    head.push({ name: BACKUP_MANIFEST_ENTRY, data: Buffer.from(JSON.stringify(backupManifest, null, 2), 'utf8'), store: true });
  }
  try {
    const result = await writeZip(
      tmp,
      [...head, ...entries.filter((e) => e.name !== COMPANY_MANIFEST_ENTRY && e.name !== BACKUP_MANIFEST_ENTRY)],
      { cache, seal },
    );
    if (beforeRename) await beforeRename();
    await renameWithRetry(tmp, filePath);
    removeStaleSaves(filePath);
    return result;
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    throw err;
  }
}

/**
 * A backup archive (.bka) in memory: the backup manifest first, then `entries` — sealed with
 * `protection` like the company file it was made from (the plain manifest then carries only the
 * backup's listing fields and the key slots).
 */
const SEALED_BACKUP_PLAIN_FIELDS = ['app', 'formatVersion', 'kind', 'companyName', 'createdAt', 'appVersion', 'dbSchemaAt'];

function buildBackupArchive({ backupManifest, entries, protection }) {
  const prot = checkProtection(protection);
  if (!prot) {
    return zipBufferSync([{ name: BACKUP_MANIFEST_ENTRY, data: Buffer.from(JSON.stringify(backupManifest, null, 2), 'utf8'), store: true }, ...entries.filter((e) => e.name !== BACKUP_MANIFEST_ENTRY)]);
  }
  const sealId = fileCrypto.newSealId();
  const visible = {};
  const info = {};
  for (const [k, v] of Object.entries(backupManifest)) {
    if (SEALED_BACKUP_PLAIN_FIELDS.includes(k)) visible[k] = v;
    else info[k] = v;
  }
  const plain = { ...visible, formatVersion: BACKUP_FORMAT_VERSION, encryption: encryptionBlock(prot, sealId) };
  return zipBufferSync(
    [{ name: BACKUP_MANIFEST_ENTRY, data: Buffer.from(JSON.stringify(plain, null, 2), 'utf8'), store: true }, ...entries.filter((e) => e.name !== BACKUP_MANIFEST_ENTRY)],
    {
      seal: {
        fileKey: prot.fileKey,
        sealId,
        v: plain.encryption.v,
        plain: new Set([BACKUP_MANIFEST_ENTRY]),
        info,
        bound: { head: BACKUP_MANIFEST_ENTRY, fields: listingOf(plain) },
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

class NotACompanyFileError extends Error {
  constructor(detail) {
    super(`This is not an Ironbooks company file (${detail}).`);
    this.name = 'NotACompanyFileError';
  }
}

/** A sealed file opened without its file key: someone has to sign in (or use the recovery key). */
class SealedFileError extends Error {
  constructor() {
    super('This company file is protected with passwords. Sign in with your user name and password (or use its recovery key) to open it.');
    this.name = 'SealedFileError';
    this.code = 'SEALED';
  }
}

// A company file is read with positioned reads (the directory at its end, then each entry where
// it lies), never as one buffer: Node refuses to read a file over 2 GiB in one go, and a company
// file with many scanned receipts can be larger than that — saving one works (ZIP64), so opening
// it must too. It also keeps memory to one entry at a time instead of the whole file.

/** Room for the end-of-directory record, its longest comment and the ZIP64 locator before it. */
const TAIL_BYTES = 22 + 0xffff + 20;

/** Reads `len` bytes at `pos` (fewer at the end of the file). */
function bufferReader(buf) {
  return { size: buf.length, read: (pos, len) => buf.subarray(pos, Math.min(buf.length, pos + len)) };
}

function syncFileReader(fd, size) {
  return {
    size,
    read(pos, len) {
      const out = Buffer.alloc(Math.max(0, Math.min(len, size - pos)));
      let done = 0;
      while (done < out.length) {
        const n = fs.readSync(fd, out, done, out.length - done, pos + done);
        if (!n) break;
        done += n;
      }
      return done === out.length ? out : out.subarray(0, done);
    },
  };
}

async function openFileReader(filePath) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    return {
      size,
      async read(pos, len) {
        const out = Buffer.alloc(Math.max(0, Math.min(len, size - pos)));
        let done = 0;
        while (done < out.length) {
          const { bytesRead } = await fh.read(out, done, out.length - done, pos + done);
          if (!bytesRead) break;
          done += bytesRead;
        }
        return done === out.length ? out : out.subarray(0, done);
      },
      close: () => fh.close(),
    };
  } catch (err) {
    await fh.close().catch(() => {});
    throw err;
  }
}

/**
 * Where the central directory is, from the last bytes of the file (`tail`, starting at file
 * offset `tailStart`): { count, cdSize, cdOffset } or { zip64At } when the ZIP64 record must be read.
 */
function directoryFromTail(tail, tailStart, size) {
  const min = Math.max(0, size - (22 + 0xffff) - tailStart);
  let eocd = -1;
  for (let i = tail.length - 22; i >= min; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new NotACompanyFileError('no zip directory found — the file may be damaged or incomplete');
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === UINT32_MAX || cdOffset === UINT32_MAX) {
    const locAt = eocd - 20;
    if (locAt < 0 || tail.readUInt32LE(locAt) !== 0x07064b50) throw new NotACompanyFileError('damaged ZIP64 directory');
    return { zip64At: Number(tail.readBigUInt64LE(locAt + 8)) };
  }
  return { count, cdSize, cdOffset };
}

function directoryFromZip64(rec) {
  if (rec.length < 56 || rec.readUInt32LE(0) !== 0x06064b50) throw new NotACompanyFileError('damaged ZIP64 directory');
  return {
    count: Number(rec.readBigUInt64LE(32)),
    cdSize: Number(rec.readBigUInt64LE(40)),
    cdOffset: Number(rec.readBigUInt64LE(48)),
  };
}

/** The central directory's entries: [{ name, method, crc, csize, size, offset }]. */
function parseCentralEntries(cd, count) {
  const out = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new NotACompanyFileError('damaged zip directory');
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    let csize = cd.readUInt32LE(p + 20);
    let size = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let offset = cd.readUInt32LE(p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > cd.length) throw new NotACompanyFileError('damaged zip directory');
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    // ZIP64 extra: replaces the 0xFFFFFFFF fields, in order size, csize, offset.
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = cd.readUInt16LE(x);
      const len = cd.readUInt16LE(x + 2);
      if (id === 0x0001) {
        let q = x + 4;
        if (size === UINT32_MAX && q + 8 <= xEnd) {
          size = Number(cd.readBigUInt64LE(q));
          q += 8;
        }
        if (csize === UINT32_MAX && q + 8 <= xEnd) {
          csize = Number(cd.readBigUInt64LE(q));
          q += 8;
        }
        if (offset === UINT32_MAX && q + 8 <= xEnd) offset = Number(cd.readBigUInt64LE(q));
      }
      x += 4 + len;
    }
    out.push({ name, method, crc, csize, size, offset });
    p = xEnd + commentLen;
  }
  return out;
}

function checkDirectoryBounds(d, size) {
  if (!Number.isSafeInteger(d.cdOffset) || !Number.isSafeInteger(d.cdSize) || d.cdOffset + d.cdSize > size) {
    throw new NotACompanyFileError('the file is incomplete');
  }
}

/** The central directory of a zip, through a synchronous reader. */
function readDirectorySync(reader) {
  const tailStart = Math.max(0, reader.size - TAIL_BYTES);
  let d = directoryFromTail(reader.read(tailStart, reader.size - tailStart), tailStart, reader.size);
  if (d.zip64At !== undefined) d = directoryFromZip64(reader.read(d.zip64At, 56));
  checkDirectoryBounds(d, reader.size);
  return parseCentralEntries(reader.read(d.cdOffset, d.cdSize), d.count);
}

/** The central directory of a zip, through an asynchronous reader. */
async function readDirectory(reader) {
  const tailStart = Math.max(0, reader.size - TAIL_BYTES);
  let d = directoryFromTail(await reader.read(tailStart, reader.size - tailStart), tailStart, reader.size);
  if (d.zip64At !== undefined) d = directoryFromZip64(await reader.read(d.zip64At, 56));
  checkDirectoryBounds(d, reader.size);
  return parseCentralEntries(await reader.read(d.cdOffset, d.cdSize), d.count);
}

/** Parse the central directory of a whole-file buffer: [{ name, method, crc, csize, size, offset }]. */
function readCentralDirectory(buf) {
  return readDirectorySync(bufferReader(buf));
}

/** Where an entry's (still compressed) bytes start, from its local header. */
function entryDataStart(header, e, size) {
  if (header.length < 30 || header.readUInt32LE(0) !== 0x04034b50) throw new NotACompanyFileError(`damaged entry ${e.name}`);
  const start = e.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  if (start + e.csize > size) throw new NotACompanyFileError(`entry ${e.name} is cut short`);
  return start;
}

/** The (still compressed) bytes of one entry, read from the file (header and data in one read). */
async function readEntryBytes(reader, e) {
  const guess = 30 + Buffer.byteLength(e.name, 'utf8') + 64;
  const head = await reader.read(e.offset, guess + e.csize);
  const start = entryDataStart(head, e, reader.size);
  const rel = start - e.offset;
  if (rel + e.csize <= head.length) return head.subarray(rel, rel + e.csize);
  return reader.read(start, e.csize); // a longer local extra field than guessed
}

/** readEntryBytes through a synchronous reader. */
function readEntryBytesSync(reader, e) {
  const guess = 30 + Buffer.byteLength(e.name, 'utf8') + 64;
  const head = reader.read(e.offset, guess + e.csize);
  const start = entryDataStart(head, e, reader.size);
  const rel = start - e.offset;
  if (rel + e.csize <= head.length) return head.subarray(rel, rel + e.csize);
  return reader.read(start, e.csize);
}

function checkInflated(data, e) {
  if (data.length !== e.size || crc32(data) !== e.crc) {
    throw new NotACompanyFileError(`${e.name} failed its checksum — the file is damaged`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Size limits when unpacking (a small crafted file must never inflate into gigabytes in memory)
// ---------------------------------------------------------------------------

/** Largest single entry: a Postgres table segment is at most 1 GB; attachments are far smaller. */
const MAX_ENTRY_BYTES = 1.25 * 1024 * 1024 * 1024;
/** Largest company file / backup unpacked in total. */
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024 * 1024;
/** The plain manifests and the encrypted index are small lists. */
const MAX_LISTING_BYTES = 64 * 1024 * 1024;

function maxTotalBytes() {
  const v = Number(process.env.BKA_MAX_UNPACKED_BYTES);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_TOTAL_BYTES;
}

function tooBigError(what) {
  return new NotACompanyFileError(`${what} is larger than any company file can be — the file is damaged or was made to look like one`);
}

/** Refuse entries (and a whole set of them) that claim more than a company file can hold. */
function checkSizes(entries, limit = MAX_ENTRY_BYTES) {
  let total = 0;
  for (const e of entries) {
    const size = Number(e && e.size) || 0;
    if (size < 0 || size > limit) throw tooBigError(e.name || 'An entry');
    total += size;
  }
  if (total > maxTotalBytes()) throw tooBigError('What it unpacks to');
  return total;
}

/** Inflate output is capped at the entry's declared size: a bomb that lies about it stops there. */
function inflateOptions(e, limit) {
  const size = Number(e.size) || 0;
  if (size < 0 || size > limit) throw tooBigError(e.name || 'An entry');
  return { maxOutputLength: Math.max(1, size) };
}

function inflateFailed(err, e) {
  if (err && (err.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError)) return tooBigError(e.name || 'An entry');
  return new NotACompanyFileError(`${e.name} could not be unpacked — the file is damaged`);
}

async function inflateBytes(bytes, e, limit = MAX_ENTRY_BYTES) {
  let data;
  if (e.method === 0) data = bytes;
  else if (e.method === 8) {
    const options = inflateOptions(e, limit);
    try {
      data = await inflateRaw(bytes, options);
    } catch (err) {
      throw inflateFailed(err, e);
    }
  } else throw new NotACompanyFileError(`unsupported compression in ${e.name}`);
  return checkInflated(data, e);
}

function inflateBytesSync(bytes, e, limit = MAX_ENTRY_BYTES) {
  let data;
  if (e.method === 0) data = bytes;
  else if (e.method === 8) {
    const options = inflateOptions(e, limit);
    try {
      data = zlib.inflateRawSync(bytes, options);
    } catch (err) {
      throw inflateFailed(err, e);
    }
  } else throw new NotACompanyFileError(`unsupported compression in ${e.name}`);
  return checkInflated(data, e);
}

function parseManifest(data) {
  try {
    const m = JSON.parse(data.toString('utf8'));
    return m && typeof m === 'object' && m.schema === COMPANY_FILE_SCHEMA ? m : null;
  } catch {
    return null;
  }
}

/** True when a (company or backup) manifest says its container is sealed (encrypted). */
function isSealedManifest(m) {
  return Boolean(m && typeof m === 'object' && m.encryption && typeof m.encryption === 'object' && typeof m.encryption.sealId === 'string');
}

/**
 * The first entry of a zip when it is stored and small enough to sit in `head` (the No Company
 * Open fast path): { name, data } or null.
 */
function firstStoredEntry(head, n) {
  if (n < 30 || head.readUInt32LE(0) !== 0x04034b50) return null;
  const method = head.readUInt16LE(8);
  const csize = head.readUInt32LE(18);
  const nameLen = head.readUInt16LE(26);
  const extraLen = head.readUInt16LE(28);
  const name = head.toString('utf8', 30, 30 + nameLen);
  const start = 30 + nameLen + extraLen;
  if (method !== 0 || start + csize > n) return null;
  return { name, data: head.subarray(start, start + csize) };
}

/**
 * Does a company file hold books (a database)? A protected one always does (its protection lives
 * in the database); a plain one when its listing has PG_VERSION or its manifest records a layout.
 * lib/db openDb: a working copy without a database is then a lost copy, never a new company.
 */
function companyFileHoldsBooks(filePath) {
  const m = readCompanyManifest(filePath);
  if (!m) return false;
  if (isSealedManifest(m) || m.dbSchema) return true;
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const reader = syncFileReader(fd, fs.fstatSync(fd).size);
    return readDirectorySync(reader).some((e) => e.name === 'PG_VERSION');
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Read a plain (stored) manifest entry by name, through a synchronous reader; null if absent. */
function readStoredEntrySync(reader, list, name) {
  const e = list.find((x) => x.name === name);
  if (!e || e.method !== 0) return null;
  const data = readEntryBytesSync(reader, e);
  return crc32(data) === e.crc ? data : null;
}

/**
 * The manifest of a company file, read from the first few kilobytes only (it is the first entry,
 * stored). Falls back to the directory when it was written by something else. Returns null for
 * a file that is not a company file (or can't be read).
 */
function readCompanyManifest(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    // A sealed manifest carries the key slots: give it room (about half a kilobyte per slot).
    const head = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    const first = firstStoredEntry(head, n);
    if (first && first.name === COMPANY_MANIFEST_ENTRY) return parseManifest(first.data);
    // Not where we put it: look it up in the directory (positioned reads: any file size).
    const reader = syncFileReader(fd, fs.fstatSync(fd).size);
    const data = readStoredEntrySync(reader, readDirectorySync(reader), COMPANY_MANIFEST_ENTRY);
    return data ? parseManifest(data) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * The plain manifest of any Ironbooks archive — a company file or a backup (.bka) — and which of
 * the two it is: { name, manifest } (manifest null when unreadable), or null when neither is
 * there. From a whole-archive buffer (the app server's backup uploads) or a file path.
 */
function readArchiveHead(source) {
  let fd;
  try {
    let reader;
    if (Buffer.isBuffer(source)) reader = bufferReader(source);
    else {
      fd = fs.openSync(source, 'r');
      reader = syncFileReader(fd, fs.fstatSync(fd).size);
    }
    const list = readDirectorySync(reader);
    for (const name of [COMPANY_MANIFEST_ENTRY, BACKUP_MANIFEST_ENTRY]) {
      if (!list.some((e) => e.name === name)) continue;
      const data = readStoredEntrySync(reader, list, name);
      let manifest = null;
      if (data) {
        try {
          manifest = JSON.parse(data.toString('utf8'));
        } catch {
          manifest = null;
        }
      }
      // A backup manifest inside a sealed company file is itself sealed (not stored in plain text).
      if (name === COMPANY_MANIFEST_ENTRY || manifest) return { name, manifest: manifest && typeof manifest === 'object' ? manifest : null };
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** True when `filePath` is a regular file that holds an Ironbooks company manifest. */
function isCompanyFile(filePath) {
  try {
    if (!fs.statSync(filePath).isFile()) return false;
  } catch {
    return false;
  }
  return readCompanyManifest(filePath) !== null;
}

/** The entries of `list` to extract into `root`: names confined to it, our own manifests left out. */
function extractionPlan(list, root) {
  const files = [];
  for (const e of list) {
    if (e.name === COMPANY_MANIFEST_ENTRY || e.name === BACKUP_MANIFEST_ENTRY) continue;
    const name = safeEntryName(e.name);
    if (!name || isExcludedPath(name)) continue;
    const target = path.resolve(root, ...name.split('/').filter(Boolean));
    if (target !== root && !target.startsWith(root + path.sep)) continue;
    files.push({ e, name, target });
  }
  return files;
}

// --- Sealed containers ---------------------------------------------------------------------

function sealIdOf(manifest) {
  const id = manifest && manifest.encryption && manifest.encryption.sealId;
  if (typeof id !== 'string' || !id) throw new NotACompanyFileError('its encryption details are unreadable');
  return id;
}

function parseIndex(plain, sealId) {
  let index;
  try {
    index = JSON.parse(plain.toString('utf8'));
  } catch {
    throw new fileCrypto.TamperedError('The list of what is in the company file');
  }
  if (!index || index.sealId !== sealId || !Array.isArray(index.entries)) {
    throw new fileCrypto.TamperedError('The list of what is in the company file');
  }
  return index;
}

/** The key a sealed container's entries were encrypted with (its layout says how; fileCrypto.containerKey). */
function entriesKeyOf(manifest, fileKey) {
  const v = manifest.encryption.v;
  if (typeof v === 'number' && v > fileCrypto.SEAL_VERSION) throw newerFormatError('file');
  return fileCrypto.containerKey(fileKey, sealIdOf(manifest), v);
}

const LISTING_WHAT = 'The details of the company file (its name, save or layout)';

/**
 * The plain manifest of a sealed container (`headName`: the company or the backup manifest) must
 * be the one its index was written with — checked as soon as the file key is known, before
 * anything is used or written. Changed without the key (a save id, the training flag, the layout,
 * the company name), the file is refused as tampered. The key slots are exempt: they are
 * rewritten in place and are authenticated themselves. Layout 1 (the first protected files) did
 * not bind its listing.
 */
function checkListingBinding(manifest, index, headName) {
  const bound = index && index.plain;
  if (!bound || typeof bound !== 'object') {
    if (manifest.encryption && manifest.encryption.v !== 1 && manifest.encryption.v !== undefined) throw new fileCrypto.TamperedError(LISTING_WHAT);
    return;
  }
  if (bound.head === headName) {
    if (canonicalJson(listingOf(manifest)) !== canonicalJson(bound.fields)) throw new fileCrypto.TamperedError(LISTING_WHAT);
    return;
  }
  // A company file made from a protected backup without decrypting it (sealedBackupAsCompanyFile)
  // carries the backup's bound listing: its own new listing is checked where it can be (the same
  // encryption details and company name, the backup's layout, never a training file) and is
  // rewritten — and bound — by its first save.
  const fields = bound.fields && typeof bound.fields === 'object' ? bound.fields : {};
  if (headName !== COMPANY_MANIFEST_ENTRY || bound.head !== BACKUP_MANIFEST_ENTRY) throw new fileCrypto.TamperedError(LISTING_WHAT);
  const ok =
    canonicalJson(encryptionListing(manifest.encryption)) === canonicalJson(fields.encryption) &&
    manifest.training !== true &&
    (typeof fields.companyName !== 'string' || !fields.companyName || manifest.companyName === fields.companyName) &&
    (typeof fields.dbSchemaAt !== 'number' || !manifest.dbSchema || Number(manifest.dbSchema.lastMigrationAt) === fields.dbSchemaAt);
  if (!ok) throw new fileCrypto.TamperedError(LISTING_WHAT);
}

/** The decrypted index of a sealed container ({ entries, info }), through an async reader. */
async function readSealedIndex(reader, list, manifest, fileKey, headName) {
  const sealId = sealIdOf(manifest);
  const e = list.find((x) => x.name === SEALED_INDEX_ENTRY);
  if (!e) throw new NotACompanyFileError('its encrypted contents are missing');
  const sealed = await inflateBytes(await readEntryBytes(reader, e), e, MAX_LISTING_BYTES);
  const plain = fileCrypto.openBytes(entriesKeyOf(manifest, fileKey), sealed, fileCrypto.entryAad(sealId, SEALED_INDEX_ENTRY, SEALED_INDEX_ENTRY), 'The list of what is in the company file');
  const index = parseIndex(plain, sealId);
  checkListingBinding(manifest, index, headName);
  return index;
}

function readSealedIndexSync(reader, list, manifest, fileKey, headName) {
  const sealId = sealIdOf(manifest);
  const e = list.find((x) => x.name === SEALED_INDEX_ENTRY);
  if (!e) throw new NotACompanyFileError('its encrypted contents are missing');
  const sealed = inflateBytesSync(readEntryBytesSync(reader, e), e, MAX_LISTING_BYTES);
  const plain = fileCrypto.openBytes(entriesKeyOf(manifest, fileKey), sealed, fileCrypto.entryAad(sealId, SEALED_INDEX_ENTRY, SEALED_INDEX_ENTRY), 'The list of what is in the company file');
  const index = parseIndex(plain, sealId);
  checkListingBinding(manifest, index, headName);
  return index;
}

/**
 * Turn one index row's encrypted entry back into its verified bytes: authenticate and decrypt the
 * whole entry (nothing is used before its tag checks out), then inflate and check its CRC.
 * `entriesKey` is the container's key (entriesKeyOf).
 */
function unsealRow(sealedBytes, row, sealId, entriesKey, inflateSync) {
  const compressed = fileCrypto.openBytes(entriesKey, sealedBytes, fileCrypto.entryAad(sealId, row.z, row.name), `${row.name} in the company file`);
  const e = { name: row.name, method: row.m, size: row.size, crc: row.crc };
  return inflateSync ? inflateBytesSync(compressed, e) : inflateBytes(compressed, e);
}

/** The extraction plan of a sealed container: index rows confined to `root`, each with its zip entry. */
function sealedPlan(index, list, root) {
  const byZ = new Map(list.map((e) => [e.name, e]));
  const files = [];
  for (const row of index.entries) {
    if (!row || typeof row.name !== 'string') continue;
    if (row.name === COMPANY_MANIFEST_ENTRY || row.name === BACKUP_MANIFEST_ENTRY) continue;
    const name = safeEntryName(row.name);
    if (!name || isExcludedPath(name)) continue;
    const target = path.resolve(root, ...name.split('/').filter(Boolean));
    if (target !== root && !target.startsWith(root + path.sep)) continue;
    if (row.dir || name.endsWith('/')) {
      files.push({ name: name.endsWith('/') ? name : `${name}/`, target, row });
      continue;
    }
    const e = byZ.get(row.z);
    if (!e || typeof row.z !== 'string' || !row.z.startsWith(SEALED_PREFIX)) {
      throw new NotACompanyFileError(`${row.name} is missing from it — the file is damaged`);
    }
    files.push({ e, name, target, row });
  }
  return files;
}

/**
 * Write the planned entries into `root` (which must not exist or be empty), one entry at a time,
 * each checked against its CRC (and, sealed, its authentication tag) before it is written. If
 * anything fails — a damaged entry, a full disk — everything written is removed again, so a
 * damaged file never leaves a half-extracted folder behind. `decode(f)` returns an entry's bytes.
 */
async function extractInto(reader, files, root, notEmptyMessage, decode) {
  // Before anything is written: no entry, and not all of them together, may claim more than a
  // company file can hold (a sealed row's own size, and the encrypted entry that carries it).
  checkSizes(files.filter((f) => !f.name.endsWith('/')).map((f) => (f.row ? { name: f.name, size: Math.max(Number(f.row.size) || 0, Number(f.e && f.e.size) || 0) } : f.e)));
  const existed = fs.existsSync(root);
  fs.mkdirSync(root, { recursive: true });
  if (fs.readdirSync(root).length) throw new Error(`${notEmptyMessage}: ${root}`);
  try {
    for (const f of files) {
      if (f.name.endsWith('/')) {
        fs.mkdirSync(f.target, { recursive: true });
        continue;
      }
      const data = decode ? await decode(f) : await inflateBytes(await readEntryBytes(reader, f.e), f.e);
      fs.mkdirSync(path.dirname(f.target), { recursive: true });
      fs.writeFileSync(f.target, data);
    }
  } catch (err) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      if (existed) fs.mkdirSync(root, { recursive: true });
    } catch {
      /* best effort */
    }
    throw err;
  }
}

/** extractInto for a sealed container (`headName`: its plain manifest entry). */
async function extractSealedInto(reader, list, manifest, fileKey, root, notEmptyMessage, headName) {
  const sealId = sealIdOf(manifest);
  const index = await readSealedIndex(reader, list, manifest, fileKey, headName);
  const files = sealedPlan(index, list, root);
  const key = entriesKeyOf(manifest, fileKey);
  await extractInto(reader, files, root, notEmptyMessage, async (f) => {
    const sealed = await inflateBytes(await readEntryBytes(reader, f.e), f.e);
    return unsealRow(sealed, f.row, sealId, key, false);
  });
  return index;
}

function newerFormatError(what) {
  const err = new Error(
    what === 'backup'
      ? 'This backup was made by a newer version of Ironbooks. Update Ironbooks (Help > Check for Updates) to restore it.'
      : 'This company file was saved by a newer version of Ironbooks. Update Ironbooks (Help > Check for Updates) to open it.',
  );
  err.code = 'NEWER_FORMAT';
  return err;
}

/**
 * Extract a company file into `destDir` (which must not exist or be empty). Every entry is
 * checked against its CRC, names are confined to `destDir`, and on any problem nothing is left
 * behind (a damaged file never leaves a half-extracted working copy). Returns the manifest.
 *
 * A sealed (password-protected) file needs `fileKey` (lib/services/fileProtection.ts unlocks it
 * from a key slot); without one this throws SealedFileError before anything is written. The
 * manifest it returns then carries the save's private details back (`fingerprint`, `savedBy`).
 */
async function extractCompanyFile(filePath, destDir, { fileKey } = {}) {
  const reader = await openFileReader(filePath);
  try {
    const list = await readDirectory(reader);
    const manifestEntry = list.find((e) => e.name === COMPANY_MANIFEST_ENTRY);
    if (!manifestEntry) throw new NotACompanyFileError('no company manifest');
    const manifest = parseManifest(await inflateBytes(await readEntryBytes(reader, manifestEntry), manifestEntry, MAX_LISTING_BYTES));
    if (!manifest) throw new NotACompanyFileError('unreadable company manifest');
    if (Number(manifest.formatVersion) > COMPANY_FILE_FORMAT_VERSION) throw newerFormatError('file');
    const root = path.resolve(destDir);
    if (isSealedManifest(manifest)) {
      if (!fileKey) throw new SealedFileError();
      const index = await extractSealedInto(reader, list, manifest, fileKey, root, 'The working folder is not empty', COMPANY_MANIFEST_ENTRY);
      return { ...(index.info || {}), ...manifest };
    }
    await extractInto(reader, extractionPlan(list, root), root, 'The working folder is not empty');
    return manifest;
  } finally {
    await reader.close();
  }
}

/**
 * Check a sealed company file with its key without extracting it: its index opens, and its plain
 * listing (save ids, training flag, layout, name) is the one the index was written with. Used when
 * a sign-in reuses the working copy already on this computer (the open plan was worked out from
 * the plain listing before anyone signed in). Throws TamperedError; returns the index's private
 * details. A file sealed with another key (keyCheck) is not this check's business: returns null.
 */
async function verifySealedCompanyFile(filePath, fileKey) {
  const reader = await openFileReader(filePath);
  try {
    const list = await readDirectory(reader);
    const manifestEntry = list.find((e) => e.name === COMPANY_MANIFEST_ENTRY);
    if (!manifestEntry) throw new NotACompanyFileError('no company manifest');
    const manifest = parseManifest(await inflateBytes(await readEntryBytes(reader, manifestEntry), manifestEntry, MAX_LISTING_BYTES));
    if (!manifest || !isSealedManifest(manifest)) return null;
    if (manifest.encryption.keyCheck && manifest.encryption.keyCheck !== fileCrypto.keyCheckOf(fileKey)) return null;
    const index = await readSealedIndex(reader, list, manifest, fileKey, COMPANY_MANIFEST_ENTRY);
    return index.info || {};
  } finally {
    await reader.close();
  }
}

/** Refusals shared by the backup readers: not ours, a newer layout, a one-company backup. */
function checkBackupManifest(manifest, knownSchemaAt) {
  if (!manifest || manifest.app !== 'bookkeeper-ai') throw new NotACompanyFileError('it is not an Ironbooks backup');
  const newerLayout = Number.isFinite(knownSchemaAt) && typeof manifest.dbSchemaAt === 'number' && manifest.dbSchemaAt > knownSchemaAt;
  if (typeof manifest.formatVersion !== 'number' || manifest.formatVersion > BACKUP_FORMAT_VERSION || newerLayout) {
    throw newerFormatError('backup');
  }
  if (manifest.kind === 'company') {
    const err = new Error(
      'This is a backup of one company, not of a whole company file. Open (or create) a company file, then use File > Back Up and Restore > Restore Company.',
    );
    err.code = 'COMPANY_BACKUP';
    throw err;
  }
}

/**
 * Extract a full backup (.bka: the database folder plus bookkeeper-manifest.json, the format of
 * lib/services/backup.ts createBackup) into `destDir`, to restore it as a NEW company file
 * (QuickBooks: Open or Restore Company > Restore a backup copy). Same checks as
 * extractCompanyFile (CRCs, confined names, nothing left behind on a problem). `knownSchemaAt`
 * (the newest database migration this app ships): a backup made with a newer layout is refused.
 * A sealed backup needs its `fileKey` (SealedFileError otherwise).
 * Returns { companyName, createdAt }.
 */
async function extractBackupArchive(filePath, destDir, { knownSchemaAt, fileKey } = {}) {
  const reader = await openFileReader(filePath);
  try {
    const list = await readDirectory(reader);
    const head = readArchiveHeadFromList(await readStoredEntries(reader, list), list);
    const root = path.resolve(destDir);
    if (head && head.manifest && isSealedManifest(head.manifest)) {
      if (head.name === COMPANY_MANIFEST_ENTRY && Number(head.manifest.formatVersion) > COMPANY_FILE_FORMAT_VERSION) throw newerFormatError('backup');
      if (head.name === BACKUP_MANIFEST_ENTRY) checkBackupManifest(head.manifest, knownSchemaAt);
      else if (Number.isFinite(knownSchemaAt) && savedByNewer(head.manifest, knownSchemaAt)) throw newerFormatError('backup');
      if (!fileKey) throw new SealedFileError();
      const index = await readSealedIndex(reader, list, head.manifest, fileKey, head.name);
      // A sealed company file restored as a backup: its own backup manifest is inside.
      const innerRow = index.entries.find((r) => r && r.name === BACKUP_MANIFEST_ENTRY && r.z);
      let manifest = head.name === BACKUP_MANIFEST_ENTRY ? { ...(index.info || {}), ...head.manifest } : null;
      if (innerRow) {
        const e = list.find((x) => x.name === innerRow.z);
        if (e) {
          const sealed = await inflateBytes(await readEntryBytes(reader, e), e);
          try {
            manifest = JSON.parse((await unsealRow(sealed, innerRow, sealIdOf(head.manifest), entriesKeyOf(head.manifest, fileKey), false)).toString('utf8'));
          } catch (err) {
            if (err && err.code === 'TAMPERED') throw err;
            throw new NotACompanyFileError('the backup information in it is unreadable');
          }
          checkBackupManifest(manifest, knownSchemaAt);
        }
      }
      await extractSealedInto(reader, list, head.manifest, fileKey, root, 'The folder is not empty', head.name);
      return {
        companyName: (manifest && manifest.companyName) || head.manifest.companyName || null,
        createdAt: (manifest && manifest.createdAt) || head.manifest.savedAt || null,
      };
    }
    const manifestEntry = list.find((e) => e.name === BACKUP_MANIFEST_ENTRY);
    let manifest = null;
    if (manifestEntry) {
      try {
        manifest = JSON.parse((await inflateBytes(await readEntryBytes(reader, manifestEntry), manifestEntry, MAX_LISTING_BYTES)).toString('utf8'));
      } catch {
        throw new NotACompanyFileError('the backup information in it is unreadable');
      }
      checkBackupManifest(manifest, knownSchemaAt);
    } else if (!list.some((e) => e.name === 'PG_VERSION')) {
      throw new NotACompanyFileError('it does not hold a company');
    }
    await extractInto(reader, extractionPlan(list, root), root, 'The folder is not empty');
    return { companyName: (manifest && manifest.companyName) || null, createdAt: (manifest && manifest.createdAt) || null };
  } finally {
    await reader.close();
  }
}

function savedByNewer(manifest, knownSchemaAt) {
  const at = Number(manifest && manifest.dbSchema && manifest.dbSchema.lastMigrationAt);
  return Number.isFinite(knownSchemaAt) && knownSchemaAt > 0 && Number.isFinite(at) && at > knownSchemaAt;
}

/** The stored (plain) manifest entries of a zip, through an async reader: Map name -> Buffer. */
async function readStoredEntries(reader, list) {
  const out = new Map();
  for (const name of [COMPANY_MANIFEST_ENTRY, BACKUP_MANIFEST_ENTRY]) {
    const e = list.find((x) => x.name === name);
    if (!e || e.method !== 0) continue;
    const data = await readEntryBytes(reader, e);
    if (crc32(data) === e.crc) out.set(name, data);
  }
  return out;
}

function readArchiveHeadFromList(stored, list) {
  for (const name of [COMPANY_MANIFEST_ENTRY, BACKUP_MANIFEST_ENTRY]) {
    if (!list.some((e) => e.name === name)) continue;
    const data = stored.get(name);
    let manifest = null;
    if (data) {
      try {
        manifest = JSON.parse(data.toString('utf8'));
      } catch {
        manifest = null;
      }
    }
    if (name === COMPANY_MANIFEST_ENTRY || manifest) return { name, manifest };
  }
  return null;
}

/**
 * Open a sealed archive held in memory (a backup uploaded to the app server, a pre-op copy, a
 * condense archive): verify and decrypt every entry with `fileKey`. Returns
 * { headName, head, info, entries: [{ name, data?, dir? }] }; the backup manifest, when the
 * archive is a company file, is among the entries. Throws TamperedError on any change.
 */
function unsealArchiveSync(buffer, fileKey) {
  const reader = bufferReader(buffer);
  const list = readDirectorySync(reader);
  const head = readArchiveHead(buffer);
  if (!head || !head.manifest || !isSealedManifest(head.manifest)) throw new NotACompanyFileError('it is not a protected Ironbooks file');
  const sealId = sealIdOf(head.manifest);
  const index = readSealedIndexSync(reader, list, head.manifest, fileKey, head.name);
  const key = entriesKeyOf(head.manifest, fileKey);
  const byZ = new Map(list.map((e) => [e.name, e]));
  // Every entry is inflated into memory: none, and not all together, may claim more than a company
  // file can hold (the index's own sizes, and the sealed entries that carry them).
  checkSizes(list);
  checkSizes(index.entries.filter((r) => r && typeof r.name === 'string' && !r.dir).map((r) => ({ name: r.name, size: r.size })));
  const entries = [];
  for (const row of index.entries) {
    if (!row || typeof row.name !== 'string') continue;
    const name = safeEntryName(row.name);
    if (!name) continue;
    if (row.dir || name.endsWith('/')) {
      entries.push({ name: name.endsWith('/') ? name : `${name}/`, dir: true });
      continue;
    }
    const e = byZ.get(row.z);
    if (!e) throw new NotACompanyFileError(`${row.name} is missing from it — the file is damaged`);
    const sealed = inflateBytesSync(readEntryBytesSync(reader, e), e);
    entries.push({ name, data: unsealRow(sealed, row, sealId, key, true) });
  }
  return { headName: head.name, head: head.manifest, info: index.info || {}, entries };
}

/**
 * Restore a sealed backup (.bka) as a NEW company file without ever decrypting it: the encrypted
 * entries are copied as they are, under a new company manifest that carries the same key slots.
 * Opening the new file asks for a user name and password from the backup (or its recovery key),
 * like the file it was made from. `manifest` = the new company manifest's fields.
 */
async function sealedBackupAsCompanyFile(bkaPath, target, { manifest, knownSchemaAt } = {}) {
  const reader = await openFileReader(bkaPath);
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.saving-${crypto.randomBytes(4).toString('hex')}`);
  try {
    const list = await readDirectory(reader);
    const head = readArchiveHeadFromList(await readStoredEntries(reader, list), list);
    if (!head || !head.manifest || !isSealedManifest(head.manifest)) throw new NotACompanyFileError('it is not a protected Ironbooks backup');
    if (head.name === BACKUP_MANIFEST_ENTRY) checkBackupManifest(head.manifest, knownSchemaAt);
    else if (Number(head.manifest.formatVersion) > COMPANY_FILE_FORMAT_VERSION || savedByNewer(head.manifest, knownSchemaAt)) throw newerFormatError('backup');
    if (!list.some((e) => e.name === SEALED_INDEX_ENTRY)) throw new NotACompanyFileError('its encrypted contents are missing');
    const plain = {
      schema: COMPANY_FILE_SCHEMA,
      ...manifest,
      formatVersion: COMPANY_FILE_FORMAT_VERSION,
      ...(head.manifest.dbSchemaAt ? { dbSchema: { migrations: 0, lastMigrationAt: head.manifest.dbSchemaAt } } : {}),
      ...(head.manifest.dbSchema ? { dbSchema: head.manifest.dbSchema } : {}),
      encryption: head.manifest.encryption,
    };
    const entries = [{ name: COMPANY_MANIFEST_ENTRY, data: Buffer.from(JSON.stringify(plain, null, 2), 'utf8'), store: true }];
    // Copied through memory: capped like any unpacking.
    checkSizes(list.filter((e) => e.name.startsWith(SEALED_PREFIX)));
    for (const e of list) {
      if (!e.name.startsWith(SEALED_PREFIX)) continue;
      entries.push({ name: e.name, data: await inflateBytes(await readEntryBytes(reader, e), e), store: true });
    }
    await writeZip(tmp, entries);
    await renameWithRetry(tmp, target);
    return { companyName: head.manifest.companyName || null, createdAt: head.manifest.createdAt || head.manifest.savedAt || null };
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    throw err;
  } finally {
    await reader.close();
  }
}

/** "ABC Company.ironbooks" -> "ABC Company". */
function companyFileBaseName(filePath) {
  return path.basename(filePath).replace(/\.(ironbooks|bookkeeper)$/i, '');
}

module.exports = {
  MAX_ENTRY_BYTES,
  checkSizes,
  COMPANY_FILE_EXT,
  COMPANY_MANIFEST_ENTRY,
  BACKUP_MANIFEST_ENTRY,
  COMPANY_FILE_SCHEMA,
  COMPANY_FILE_FORMAT_VERSION,
  BACKUP_FORMAT_VERSION,
  SEALED_INDEX_ENTRY,
  NotACompanyFileError,
  SealedFileError,
  isExcludedPath,
  safeEntryName,
  crc32,
  snapshotDir,
  writeZip,
  zipBufferSync,
  writeCompanyFile,
  buildBackupArchive,
  renameWithRetry,
  readCentralDirectory,
  readCompanyManifest,
  companyFileHoldsBooks,
  readArchiveHead,
  isSealedManifest,
  isCompanyFile,
  extractCompanyFile,
  verifySealedCompanyFile,
  extractBackupArchive,
  unsealArchiveSync,
  sealedBackupAsCompanyFile,
  companyFileBaseName,
};
