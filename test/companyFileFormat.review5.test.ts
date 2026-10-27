/**
 * Review round 5 — the single company file format (electron/companyFileFormat.js).
 *
 * A company file with many scanned receipts can grow past 2 GB. Saving writes it fine (ZIP64 is
 * supported), so opening it must work too: the file is read entry by entry, never as one buffer
 * (Node refuses to read a file over 2 GiB in one go — the file could be saved but never opened
 * again). The same goes for restoring a large backup as a new company file.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const format = require('../electron/companyFileFormat.js');

let root: string;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-format5-'));
});
afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const GAP = 2 ** 31 + 4096; // just over 2 GiB

/**
 * Rewrite a small zip so its central directory sits more than 2 GiB further on: every entry keeps
 * its offset, the space between is unused (a valid zip — readers follow the directory). Cheap to
 * make: the gap is never written, only skipped.
 */
function inflateToHugeFile(small: string, huge: string) {
  const buf = fs.readFileSync(small);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdStart = buf.readUInt32LE(eocd + 16);
  const entries = buf.subarray(0, cdStart);
  const cd = buf.subarray(cdStart, cdStart + cdSize);
  const end = Buffer.from(buf.subarray(eocd, eocd + 22));
  const newCdStart = cdStart + GAP;
  end.writeUInt32LE(newCdStart, 16);
  const fd = fs.openSync(huge, 'w');
  try {
    fs.writeSync(fd, entries, 0, entries.length, 0);
    fs.writeSync(fd, cd, 0, cd.length, newCdStart);
    fs.writeSync(fd, end, 0, end.length, newCdStart + cd.length);
  } finally {
    fs.closeSync(fd);
  }
  expect(fs.statSync(huge).size).toBeGreaterThan(2 ** 31);
}

describe('company files over 2 GB', () => {
  it('open (extract) like any other company file', async () => {
    const src = path.join(root, 'src');
    fs.mkdirSync(path.join(src, 'base', '1'), { recursive: true });
    fs.mkdirSync(path.join(src, 'attachments'), { recursive: true });
    fs.writeFileSync(path.join(src, 'PG_VERSION'), '17\n');
    fs.writeFileSync(path.join(src, 'base', '1', '1259'), Buffer.alloc(100_000, 7));
    fs.writeFileSync(path.join(src, 'attachments', 'receipt.pdf'), Buffer.from('%PDF-1.4 receipt'));
    const small = path.join(root, 'Small.ironbooks');
    await format.writeCompanyFile(small, {
      manifest: { formatVersion: 1, fileId: 'big', companyName: 'Big Receipts Co', saveId: 's1', savedAt: 'x' },
      entries: format.snapshotDir(src),
    });
    const huge = path.join(root, 'Big Receipts Co.ironbooks');
    inflateToHugeFile(small, huge);
    try {
      expect(format.readCompanyManifest(huge)).toMatchObject({ companyName: 'Big Receipts Co' });
      const out = path.join(root, 'opened');
      const m = await format.extractCompanyFile(huge, out);
      expect(m.companyName).toBe('Big Receipts Co');
      expect(fs.readFileSync(path.join(out, 'PG_VERSION'), 'utf8')).toBe('17\n');
      expect(fs.readFileSync(path.join(out, 'base', '1', '1259')).equals(Buffer.alloc(100_000, 7))).toBe(true);
      expect(fs.readFileSync(path.join(out, 'attachments', 'receipt.pdf'), 'utf8')).toBe('%PDF-1.4 receipt');

      // The same file restored as a backup (it is a valid full backup too).
      const restored = path.join(root, 'restored');
      await format.extractBackupArchive(huge, restored);
      expect(fs.readFileSync(path.join(restored, 'PG_VERSION'), 'utf8')).toBe('17\n');
    } finally {
      fs.rmSync(huge, { force: true });
    }
  }, 120_000);

  it('a damaged entry still leaves nothing half-extracted behind', async () => {
    const src = path.join(root, 'src2');
    fs.mkdirSync(path.join(src, 'base'), { recursive: true });
    fs.writeFileSync(path.join(src, 'PG_VERSION'), '17\n');
    fs.writeFileSync(path.join(src, 'base', 'aaa'), Buffer.alloc(5000, 1));
    fs.writeFileSync(path.join(src, 'base', 'zzz'), Buffer.from('the last file in the archive, damaged below'));
    const file = path.join(root, 'Damaged.ironbooks');
    await format.writeCompanyFile(file, {
      manifest: { formatVersion: 1, fileId: 'd', companyName: 'Damaged', saveId: 's1', savedAt: 'x' },
      entries: format.snapshotDir(src),
    });
    const buf = fs.readFileSync(file);
    const at = buf.indexOf(Buffer.from('damaged below'));
    expect(at).toBeGreaterThan(0);
    buf[at] ^= 0xff; // flip a byte of the stored data: its checksum no longer matches
    fs.writeFileSync(file, buf);
    const out = path.join(root, 'damaged-out');
    await expect(format.extractCompanyFile(file, out)).rejects.toThrow(/damaged/);
    expect(fs.existsSync(out) ? fs.readdirSync(out) : []).toEqual([]);
  });
});

describe('restoring a backup made by a newer Ironbooks as a new company file', () => {
  it('is refused before anything is extracted', async () => {
    const src = path.join(root, 'bka-src');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'PG_VERSION'), '17\n');
    const bka = path.join(root, 'newer.bka');
    await format.writeZip(bka, [
      { name: 'bookkeeper-manifest.json', data: Buffer.from(JSON.stringify({ app: 'bookkeeper-ai', formatVersion: 1, kind: 'full', dbSchemaAt: 2_000_000_000_000 })) },
      ...format.snapshotDir(src),
    ]);
    const out = path.join(root, 'newer-out');
    await expect(format.extractBackupArchive(bka, out, { knownSchemaAt: 1_781_400_062_000 })).rejects.toMatchObject({ code: 'NEWER_FORMAT' });
    expect(fs.existsSync(out)).toBe(false);
    // Same backup, this version knows its layout: restored.
    await format.extractBackupArchive(bka, out, { knownSchemaAt: 2_000_000_000_000 });
    expect(fs.readFileSync(path.join(out, 'PG_VERSION'), 'utf8')).toBe('17\n');
  });
});

describe('a save cut short by a crash or power cut', () => {
  it('leaves a temporary copy that the next save clears away (not one per crash, forever, on the server)', async () => {
    const src = path.join(root, 'leftover-src');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'PG_VERSION'), '17\n');
    const file = path.join(root, 'Leftovers.ironbooks');
    const manifest = { formatVersion: 1, fileId: 'l', companyName: 'Leftovers', saveId: 's1', savedAt: 'x' };
    await format.writeCompanyFile(file, { manifest, entries: format.snapshotDir(src) });
    const old = path.join(root, '.Leftovers.ironbooks.saving-0badf00d');
    fs.writeFileSync(old, Buffer.alloc(1000));
    const longAgo = new Date(Date.now() - 2 * 60 * 60_000);
    fs.utimesSync(old, longAgo, longAgo);
    const recent = path.join(root, '.Leftovers.ironbooks.saving-1234abcd'); // possibly a save in progress
    fs.writeFileSync(recent, Buffer.alloc(10));
    const otherFile = path.join(root, '.Other.ironbooks.saving-0badf00d');
    fs.writeFileSync(otherFile, Buffer.alloc(10));
    fs.utimesSync(otherFile, longAgo, longAgo);

    await format.writeCompanyFile(file, { manifest: { ...manifest, saveId: 's2' }, entries: format.snapshotDir(src) });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(otherFile)).toBe(true); // another company file's: not ours to clear
    expect(format.readCompanyManifest(file).saveId).toBe('s2');
  });
});
