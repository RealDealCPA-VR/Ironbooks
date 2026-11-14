// Will this database folder start? A quick, read-only check of a PGlite (Postgres) data folder,
// or of a snapshot of one about to be saved, without starting Postgres.
//
// Postgres starts by reading global/pg_control, which names the last checkpoint: a record in the
// write-ahead log (pg_wal). When that record is gone, Postgres refuses to start at all
// ("PANIC: could not locate a valid checkpoint record") and PGlite only reports "Aborted()".
// Two Postgres instances writing the same folder leave exactly that behind (one recycles the log
// segment holding the checkpoint the other one then writes into pg_control — lib/db/index.ts keeps
// to one database per folder per process), and so can a power cut: PGlite's file system layer
// does not flush to disk, so Postgres's write ordering does not survive one. A copy of such a
// folder must never replace a good company file or backup (lib/services/companyFileSave.ts,
// lib/services/backup.ts).
//
// The check is deliberately narrow: it answers `ok: false` only when the books certainly cannot
// start — nothing there at all, a database missing PG_VERSION or its control file, or a control
// file naming a checkpoint (or a redo point) that is not where it should be in the log. Anything
// it does not recognise (no database at all yet, another control file layout) answers
// `ok: null` (unknown), and callers then carry on as before.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** pg_control layouts this check understands (PG 13 … 18: the fields read here did not move). */
const KNOWN_CONTROL_VERSIONS = new Set([1300, 1700, 1800]);
const XLOG_BLCKSZ = 8192;
const RM_XLOG_ID = 0;
const XLOG_CHECKPOINT_SHUTDOWN = 0x00;
const XLOG_CHECKPOINT_ONLINE = 0x10;
const WAL_NAME = /^[0-9A-F]{24}$/;
/** Top-level names that only a database folder has. */
const DB_TOP = new Set(['PG_VERSION', 'base', 'global', 'pg_wal']);

function hex8(n) {
  return n.toString(16).toUpperCase().padStart(8, '0');
}

function lsnText(lsn) {
  return `${(lsn >> 32n).toString(16).toUpperCase()}/${(lsn & 0xffffffffn).toString(16).toUpperCase()}`;
}

/**
 * The core, over a reader: `read(name)` returns a file's bytes (or null), `walNames()` the names
 * of the files in pg_wal, and `topNames()` the names at the top of the folder.
 */
function checkWith(read, walNames, topNames) {
  const top = topNames();
  // Nothing at all (a folder that vanished, an empty snapshot): never books to save or restore.
  if (!top.length) return { ok: false, reason: 'there is nothing in it' };
  // Files of a company that has no database yet (a brand-new company file): not this check's to judge.
  if (!top.some((n) => DB_TOP.has(n))) return { ok: null, reason: 'no database' };
  if (!top.includes('PG_VERSION')) return { ok: false, reason: 'its database is incomplete (PG_VERSION is missing)' };
  const control = read('global/pg_control');
  if (!control) return { ok: false, reason: 'its database is incomplete (its control file is missing)' };
  if (control.length < 56) return { ok: false, reason: 'its control file is cut short' };
  const version = control.readUInt32LE(8);
  if (!KNOWN_CONTROL_VERSIONS.has(version)) return { ok: null, reason: `control file version ${version}` };
  // ControlFileData: system_identifier u64 @0, pg_control_version u32 @8, catalog_version_no u32
  // @12, state u32 @16, time i64 @24, checkPoint u64 @32, checkPointCopy.redo u64 @40,
  // checkPointCopy.ThisTimeLineID u32 @48.
  const checkpoint = control.readBigUInt64LE(32);
  const redo = control.readBigUInt64LE(40);
  const timeline = control.readUInt32LE(48);
  if (checkpoint === 0n || timeline === 0) return { ok: false, reason: 'its control file names no checkpoint' };

  const segments = walNames().filter((n) => WAL_NAME.test(n));
  if (!segments.length) return { ok: false, reason: 'its write-ahead log is missing' };
  const sample = read(`pg_wal/${segments[0]}`);
  const segSize = sample ? sample.length : 0;
  // A power of two between 1 MB and 1 GB (initdb --wal-segsize).
  if (!segSize || segSize & (segSize - 1) || segSize < 1 << 20 || segSize > 1 << 30) {
    return { ok: null, reason: 'unexpected log segment size' };
  }
  const seg = BigInt(segSize);
  const perId = 0x100000000n / seg;

  /** The page of the log holding `lsn`, checked to really be that place in the log. */
  const pageAt = (lsn, what) => {
    const segNo = lsn / seg;
    const name = `${hex8(timeline)}${hex8(Number(segNo / perId))}${hex8(Number(segNo % perId))}`;
    const where = lsnText(lsn);
    const wal = segments.includes(name) ? read(`pg_wal/${name}`) : null;
    if (!wal) return { problem: `the log segment holding ${what} (${where}) is missing` };
    if (wal.length !== segSize) return { problem: `the log segment holding ${what} (${where}) is cut short` };
    const offset = Number(lsn % seg);
    const inPage = offset % XLOG_BLCKSZ;
    const pageStart = offset - inPage;
    // XLogPageHeaderData: xlp_magic u16 @0, xlp_info u16 @2, xlp_tli u32 @4, xlp_pageaddr u64 @8.
    const magic = wal.readUInt16LE(pageStart);
    const pageAddr = wal.readBigUInt64LE(pageStart + 8);
    if ((magic & 0xff00) !== 0xd100 || pageAddr !== lsn - BigInt(inPage)) {
      return { problem: `its write-ahead log no longer holds ${what} (${where})` };
    }
    return { wal, offset, inPage, where };
  };

  const at = pageAt(checkpoint, 'its last checkpoint');
  if (at.problem) return { ok: false, reason: at.problem };
  // XLogRecord: xl_tot_len u32 @0, xl_xid u32 @4, xl_prev u64 @8, xl_info u8 @16, xl_rmid u8 @17.
  // Only checked when the record header lies on this page (a header may continue on the next).
  if (at.inPage <= XLOG_BLCKSZ - 24) {
    const info = at.wal.readUInt8(at.offset + 16) & 0xf0;
    const rmid = at.wal.readUInt8(at.offset + 17);
    if (rmid !== RM_XLOG_ID || (info !== XLOG_CHECKPOINT_ONLINE && info !== XLOG_CHECKPOINT_SHUTDOWN)) {
      return { ok: false, reason: `the record at its last checkpoint (${at.where}) is not a checkpoint` };
    }
  }
  // Crash recovery replays the log from the checkpoint's redo point, which can lie in an earlier
  // segment: that one must still be there too.
  if (redo !== 0n && redo !== checkpoint) {
    if (redo > checkpoint) return { ok: false, reason: 'its control file names a redo point after its checkpoint' };
    const r = pageAt(redo, 'the redo point of its last checkpoint');
    if (r.problem) return { ok: false, reason: r.problem };
  }
  return { ok: true, reason: null };
}

/** Check a data folder on disk. */
function checkDataDir(dir) {
  const read = (name) => {
    try {
      return fs.readFileSync(path.join(dir, name));
    } catch {
      return null;
    }
  };
  const walNames = () => {
    try {
      return fs.readdirSync(path.join(dir, 'pg_wal'));
    } catch {
      return [];
    }
  };
  const topNames = () => {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  };
  return checkWith(read, walNames, topNames);
}

/**
 * Check a snapshot of a data folder (electron/companyFileFormat.js snapshotDir entries:
 * { name, data } with '/' separators; an entry without `data` is read from its `file`).
 */
function checkSnapshot(entries) {
  const byName = new Map();
  for (const e of entries || []) if (e && typeof e.name === 'string' && !e.dir) byName.set(e.name, e);
  const read = (name) => {
    const e = byName.get(name);
    if (!e) return null;
    if (Buffer.isBuffer(e.data)) return e.data;
    if (e.file) {
      try {
        return fs.readFileSync(e.file);
      } catch {
        return null;
      }
    }
    return null;
  };
  const walNames = () =>
    [...byName.keys()].filter((n) => n.startsWith('pg_wal/') && !n.slice(7).includes('/')).map((n) => n.slice(7));
  const topNames = () => [...new Set((entries || []).filter((e) => e && typeof e.name === 'string').map((e) => e.name.split('/')[0]).filter(Boolean))];
  return checkWith(read, walNames, topNames);
}

module.exports = { checkDataDir, checkSnapshot };
