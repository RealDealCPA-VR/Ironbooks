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

const deflateRaw = promisify(zlib.deflateRaw);
const inflateRaw = promisify(zlib.inflateRaw);

const COMPANY_FILE_EXT = '.ironbooks';
const COMPANY_MANIFEST_ENTRY = 'ironbooks-company.json';
/** Same name and shape as lib/services/backup.ts BACKUP_MANIFEST_ENTRY. */
const BACKUP_MANIFEST_ENTRY = 'bookkeeper-manifest.json';
const COMPANY_FILE_SCHEMA = 'ironbooks-company-file/v1';
/** Bump when a company file written by this version can't be read by older ones. */
const COMPANY_FILE_FORMAT_VERSION = 1;

/**
 * Paths in the working folder that never go into the company file: the working copy's own open
 * lock and clock probes (lib/db/dirLock.ts), this computer's session-signing key (lib/auth.ts —
 * every computer makes its own), a sandbox marker, PostgreSQL's per-run scratch files, and
 * leftovers of an earlier save.
 */
function isExcludedPath(rel) {
  const p = rel.replace(/\\/g, '/');
  const base = p.split('/').pop() || '';
  if (p === 'ironbooks.lock' || p === '.auth-secret' || p === '.ironbooks-sandbox.json' || p === 'postmaster.pid') {
    return true;
  }
  if (base.startsWith('.ironbooks-clock-')) return true;
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
  if (!entry.store && raw.length > 64 && !STORE_EXT.test(name)) {
    const z = await deflateRaw(raw, { level: 6 });
    if (z.length < raw.length) {
      method = 8;
      compressed = z;
    }
  }
  if (cache) cache.set(name, { key, method, compressed });
  return { name, nameBuf, method, crc, size: raw.length, compressed, mtimeMs: entry.mtimeMs };
}

/**
 * Write `entries` as a zip archive to `filePath` (created/truncated). The manifest entries should
 * come first. Uses ZIP64 records only when the archive needs them (over 4 GB or 65,535 entries).
 */
/**
 * @param {string} filePath
 * @param {Array<Record<string, any>>} entries
 * @param {{ cache?: Map<string, any> }} [opts]
 */
async function writeZip(filePath, entries, { cache } = {}) {
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
  try {
    const seen = new Set();
    for (const raw of entries) {
      const e = await prepareEntry(raw, cache);
      if (!e) continue;
      if (seen.has(e.name)) continue;
      seen.add(e.name);
      const { time, date } = dosDateTime(e.mtimeMs);
      const localOffset = offset;
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
      await write(Buffer.concat([lh, e.nameBuf, localExtra]));
      if (e.compressed.length) await write(e.compressed);
      central.push({ ...e, time, date, localOffset });
    }

    const cdStart = offset;
    for (const e of central) {
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
      await write(Buffer.concat([ch, e.nameBuf, extra]));
    }
    const cdSize = offset - cdStart;
    const needZip64 = central.length > 0xfffe || cdStart >= UINT32_MAX || cdSize >= UINT32_MAX;
    if (needZip64) {
      const z64Start = offset;
      const rec = Buffer.alloc(56);
      rec.writeUInt32LE(0x06064b50, 0);
      rec.writeBigUInt64LE(44n, 4);
      rec.writeUInt16LE(45, 12);
      rec.writeUInt16LE(45, 14);
      rec.writeUInt32LE(0, 16);
      rec.writeUInt32LE(0, 20);
      rec.writeBigUInt64LE(BigInt(central.length), 24);
      rec.writeBigUInt64LE(BigInt(central.length), 32);
      rec.writeBigUInt64LE(BigInt(cdSize), 40);
      rec.writeBigUInt64LE(BigInt(cdStart), 48);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0);
      loc.writeUInt32LE(0, 4);
      loc.writeBigUInt64LE(BigInt(z64Start), 8);
      loc.writeUInt32LE(1, 16);
      await write(Buffer.concat([rec, loc]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(needZip64 ? 0xffff : central.length, 8);
    end.writeUInt16LE(needZip64 ? 0xffff : central.length, 10);
    end.writeUInt32LE(needZip64 ? UINT32_MAX : cdSize, 12);
    end.writeUInt32LE(needZip64 ? UINT32_MAX : cdStart, 16);
    end.writeUInt16LE(0, 20);
    await write(end);
    await fh.sync();
    return { bytes: offset, entries: central.length };
  } finally {
    await fh.close();
  }
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
 * Write a whole company file atomically: build it as `<file>.saving-<random>` in the same folder
 * (same disk / share, so the rename cannot copy), flush it to disk, then rename it over the
 * company file. A failure at any point leaves the previous company file untouched and the
 * temporary file removed.
 *
 * `manifest` is the company manifest (object); `entries` the snapshot (snapshotDir).
 *
 * @param {string} filePath
 * @param {{ manifest: Record<string, unknown>, backupManifest?: Record<string, unknown> | null, entries: Array<Record<string, any>>, cache?: Map<string, any> }} opts
 */
async function writeCompanyFile(filePath, { manifest, backupManifest, entries, cache }) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.saving-${crypto.randomBytes(4).toString('hex')}`);
  const head = [
    { name: COMPANY_MANIFEST_ENTRY, data: Buffer.from(JSON.stringify({ schema: COMPANY_FILE_SCHEMA, ...manifest }, null, 2), 'utf8'), store: true },
  ];
  if (backupManifest) {
    head.push({ name: BACKUP_MANIFEST_ENTRY, data: Buffer.from(JSON.stringify(backupManifest, null, 2), 'utf8'), store: true });
  }
  try {
    const result = await writeZip(tmp, [...head, ...entries.filter((e) => e.name !== COMPANY_MANIFEST_ENTRY && e.name !== BACKUP_MANIFEST_ENTRY)], { cache });
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

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

class NotACompanyFileError extends Error {
  constructor(detail) {
    super(`This is not an Ironbooks company file (${detail}).`);
    this.name = 'NotACompanyFileError';
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

async function inflateBytes(bytes, e) {
  let data;
  if (e.method === 0) data = bytes;
  else if (e.method === 8) data = await inflateRaw(bytes);
  else throw new NotACompanyFileError(`unsupported compression in ${e.name}`);
  if (data.length !== e.size || crc32(data) !== e.crc) {
    throw new NotACompanyFileError(`${e.name} failed its checksum — the file is damaged`);
  }
  return data;
}

function parseManifest(data) {
  try {
    const m = JSON.parse(data.toString('utf8'));
    return m && typeof m === 'object' && m.schema === COMPANY_FILE_SCHEMA ? m : null;
  } catch {
    return null;
  }
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
    const head = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    if (n >= 30 && head.readUInt32LE(0) === 0x04034b50) {
      const method = head.readUInt16LE(8);
      const csize = head.readUInt32LE(18);
      const nameLen = head.readUInt16LE(26);
      const extraLen = head.readUInt16LE(28);
      const name = head.toString('utf8', 30, 30 + nameLen);
      const start = 30 + nameLen + extraLen;
      if (name === COMPANY_MANIFEST_ENTRY && method === 0 && start + csize <= n) {
        return parseManifest(head.subarray(start, start + csize));
      }
    }
    // Not where we put it: look it up in the directory (positioned reads: any file size).
    const reader = syncFileReader(fd, fs.fstatSync(fd).size);
    const e = readDirectorySync(reader).find((x) => x.name === COMPANY_MANIFEST_ENTRY);
    if (!e || e.method !== 0) return null;
    const header = reader.read(e.offset, 30);
    const start = entryDataStart(header, e, reader.size);
    const data = reader.read(start, e.csize);
    return crc32(data) === e.crc ? parseManifest(data) : null;
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

/**
 * Write the planned entries into `root` (which must not exist or be empty), one entry at a time,
 * each checked against its CRC before it is written. If anything fails — a damaged entry, a full
 * disk — everything written is removed again, so a damaged file never leaves a half-extracted
 * folder behind.
 */
async function extractInto(reader, files, root, notEmptyMessage) {
  const existed = fs.existsSync(root);
  fs.mkdirSync(root, { recursive: true });
  if (fs.readdirSync(root).length) throw new Error(`${notEmptyMessage}: ${root}`);
  try {
    for (const f of files) {
      if (f.name.endsWith('/')) {
        fs.mkdirSync(f.target, { recursive: true });
        continue;
      }
      const data = await inflateBytes(await readEntryBytes(reader, f.e), f.e);
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

/**
 * Extract a company file into `destDir` (which must not exist or be empty). Every entry is
 * checked against its CRC, names are confined to `destDir`, and on any problem nothing is left
 * behind (a damaged file never leaves a half-extracted working copy). Returns the manifest.
 */
async function extractCompanyFile(filePath, destDir) {
  const reader = await openFileReader(filePath);
  try {
    const list = await readDirectory(reader);
    const manifestEntry = list.find((e) => e.name === COMPANY_MANIFEST_ENTRY);
    if (!manifestEntry) throw new NotACompanyFileError('no company manifest');
    const manifest = parseManifest(await inflateBytes(await readEntryBytes(reader, manifestEntry), manifestEntry));
    if (!manifest) throw new NotACompanyFileError('unreadable company manifest');
    if (Number(manifest.formatVersion) > COMPANY_FILE_FORMAT_VERSION) {
      const err = new Error(
        'This company file was saved by a newer version of Ironbooks. Update Ironbooks (Help > Check for Updates) to open it.',
      );
      err.code = 'NEWER_FORMAT';
      throw err;
    }
    const root = path.resolve(destDir);
    await extractInto(reader, extractionPlan(list, root), root, 'The working folder is not empty');
    return manifest;
  } finally {
    await reader.close();
  }
}

/**
 * Extract a full backup (.bka: the database folder plus bookkeeper-manifest.json, the format of
 * lib/services/backup.ts createBackup) into `destDir`, to restore it as a NEW company file
 * (QuickBooks: Open or Restore Company > Restore a backup copy). Same checks as
 * extractCompanyFile (CRCs, confined names, nothing left behind on a problem). `knownSchemaAt`
 * (the newest database migration this app ships): a backup made with a newer layout is refused.
 * Returns { companyName, createdAt }.
 */
async function extractBackupArchive(filePath, destDir, { knownSchemaAt } = {}) {
  const reader = await openFileReader(filePath);
  try {
    const list = await readDirectory(reader);
    const manifestEntry = list.find((e) => e.name === BACKUP_MANIFEST_ENTRY);
    let manifest = null;
    if (manifestEntry) {
      try {
        manifest = JSON.parse((await inflateBytes(await readEntryBytes(reader, manifestEntry), manifestEntry)).toString('utf8'));
      } catch {
        throw new NotACompanyFileError('the backup information in it is unreadable');
      }
      if (!manifest || manifest.app !== 'bookkeeper-ai') throw new NotACompanyFileError('it is not an Ironbooks backup');
      const newerLayout =
        Number.isFinite(knownSchemaAt) && typeof manifest.dbSchemaAt === 'number' && manifest.dbSchemaAt > knownSchemaAt;
      if (typeof manifest.formatVersion !== 'number' || manifest.formatVersion > 1 || newerLayout) {
        const err = new Error('This backup was made by a newer version of Ironbooks. Update Ironbooks (Help > Check for Updates) to restore it.');
        err.code = 'NEWER_FORMAT';
        throw err;
      }
      if (manifest.kind === 'company') {
        const err = new Error(
          'This is a backup of one company, not of a whole company file. Open (or create) a company file, then use File > Back Up and Restore > Restore Company.',
        );
        err.code = 'COMPANY_BACKUP';
        throw err;
      }
    } else if (!list.some((e) => e.name === 'PG_VERSION')) {
      throw new NotACompanyFileError('it does not hold a company');
    }
    const root = path.resolve(destDir);
    await extractInto(reader, extractionPlan(list, root), root, 'The folder is not empty');
    return { companyName: (manifest && manifest.companyName) || null, createdAt: (manifest && manifest.createdAt) || null };
  } finally {
    await reader.close();
  }
}

/** "ABC Company.ironbooks" -> "ABC Company". */
function companyFileBaseName(filePath) {
  return path.basename(filePath).replace(/\.(ironbooks|bookkeeper)$/i, '');
}

module.exports = {
  COMPANY_FILE_EXT,
  COMPANY_MANIFEST_ENTRY,
  BACKUP_MANIFEST_ENTRY,
  COMPANY_FILE_SCHEMA,
  COMPANY_FILE_FORMAT_VERSION,
  NotACompanyFileError,
  isExcludedPath,
  safeEntryName,
  crc32,
  snapshotDir,
  writeZip,
  writeCompanyFile,
  renameWithRetry,
  readCentralDirectory,
  readCompanyManifest,
  isCompanyFile,
  extractCompanyFile,
  extractBackupArchive,
  companyFileBaseName,
};
