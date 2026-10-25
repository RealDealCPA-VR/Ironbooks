/**
 * The single-file company file (electron/companyFileFormat.js): a standard zip whose first entry
 * is the manifest, written atomically, read back with every checksum verified, and safe against
 * hostile entry names. The round trip runs a real embedded database: a snapshot taken while it
 * is open (and mid-transaction) opens again with every committed row and none of the rest.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import AdmZip from 'adm-zip';
import { PGlite } from '@electric-sql/pglite';

const require = createRequire(import.meta.url);
const format = require('../electron/companyFileFormat.js');

let root: string;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-format-'));
});
afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* windows: best effort */
  }
});

const manifest = (extra: Record<string, unknown> = {}) => ({
  formatVersion: 1,
  fileId: 'f-1',
  companyName: 'Acme Plumbing',
  saveId: 's-1',
  savedAt: new Date().toISOString(),
  ...extra,
});

describe('company file archive', () => {
  it('writes a standard zip with the manifest first and reads it back from the head', async () => {
    const src = path.join(root, 'src1');
    fs.mkdirSync(path.join(src, 'base', '1'), { recursive: true });
    fs.mkdirSync(path.join(src, 'pg_tblspc'), { recursive: true }); // empty dir must survive
    fs.writeFileSync(path.join(src, 'PG_VERSION'), '17\n');
    fs.writeFileSync(path.join(src, 'base', '1', '1259'), Buffer.alloc(8192 * 3, 7));
    fs.writeFileSync(path.join(src, 'ironbooks.lock'), '{}'); // never travels
    fs.writeFileSync(path.join(src, '.auth-secret'), 'secret'); // never travels
    const file = path.join(root, 'Acme Plumbing.ironbooks');
    await format.writeCompanyFile(file, {
      manifest: manifest(),
      backupManifest: { app: 'bookkeeper-ai', formatVersion: 1, kind: 'full', companyName: 'Acme Plumbing', createdAt: 'x' },
      entries: format.snapshotDir(src),
    });

    // Any zip tool can read it (here adm-zip, which the backup restore uses).
    const zip = new AdmZip(file);
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names[0]).toBe('ironbooks-company.json');
    expect(names).toContain('bookkeeper-manifest.json');
    expect(names).toContain('pg_tblspc/');
    expect(names).not.toContain('ironbooks.lock');
    expect(names).not.toContain('.auth-secret');
    expect(zip.readFile('base/1/1259')?.equals(Buffer.alloc(8192 * 3, 7))).toBe(true);

    expect(format.readCompanyManifest(file)).toMatchObject({ companyName: 'Acme Plumbing', saveId: 's-1' });
    expect(format.isCompanyFile(file)).toBe(true);
    expect(format.isCompanyFile(src)).toBe(false); // a folder is not a single file

    const dest = path.join(root, 'out1');
    const m = await format.extractCompanyFile(file, dest);
    expect(m.fileId).toBe('f-1');
    expect(fs.readFileSync(path.join(dest, 'PG_VERSION'), 'utf8')).toBe('17\n');
    expect(fs.statSync(path.join(dest, 'pg_tblspc')).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(dest, 'bookkeeper-manifest.json'))).toBe(false);
  });

  it('replaces the file atomically and leaves no temporary file behind', async () => {
    const src = path.join(root, 'src2');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'PG_VERSION'), '17\n');
    const file = path.join(root, 'Atomic.ironbooks');
    await format.writeCompanyFile(file, { manifest: manifest({ saveId: 'a' }), entries: format.snapshotDir(src) });
    await format.writeCompanyFile(file, { manifest: manifest({ saveId: 'b' }), entries: format.snapshotDir(src) });
    expect(format.readCompanyManifest(file).saveId).toBe('b');
    expect(fs.readdirSync(root).filter((n) => n.includes('.saving-'))).toEqual([]);
  });

  it('a failed write keeps the previous company file', async () => {
    const src = path.join(root, 'src3');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'PG_VERSION'), '17\n');
    const file = path.join(root, 'Keep.ironbooks');
    await format.writeCompanyFile(file, { manifest: manifest({ saveId: 'first' }), entries: format.snapshotDir(src) });
    await expect(
      format.writeCompanyFile(file, { manifest: manifest({ saveId: 'second' }), entries: [{ name: '../evil', data: Buffer.from('x') }] }),
    ).rejects.toThrow(/Unsafe name/);
    expect(format.readCompanyManifest(file).saveId).toBe('first');
    expect(fs.readdirSync(root).filter((n) => n.includes('.saving-'))).toEqual([]);
  });

  it('refuses hostile entry names and damaged data when extracting', async () => {
    // Hand-made zip with a traversal name next to a good manifest.
    const zip = new AdmZip();
    zip.addFile('ironbooks-company.json', Buffer.from(JSON.stringify({ schema: format.COMPANY_FILE_SCHEMA, ...manifest() })));
    zip.addFile('PG_VERSION', Buffer.from('17\n'));
    const evil = path.join(root, 'Evil.ironbooks');
    const buf = zip.toBuffer();
    // Rename "PG_VERSION" to "../escape12" in both headers (same length keeps offsets valid).
    const patched = Buffer.from(buf.toString('latin1').split('PG_VERSION').join('../escape1'), 'latin1');
    fs.writeFileSync(evil, patched);
    const dest = path.join(root, 'out-evil');
    await format.extractCompanyFile(evil, dest).catch(() => undefined);
    expect(fs.existsSync(path.join(root, 'escape1'))).toBe(false);

    expect(format.safeEntryName('../x')).toBeNull();
    expect(format.safeEntryName('C:/x')).toBeNull();
    expect(format.safeEntryName('/etc/passwd')).toBeNull();
    expect(format.safeEntryName('a/../../b')).toBeNull();
    expect(format.safeEntryName('base/1/2')).toBe('base/1/2');

    // Flip a byte of a stored entry: the CRC check refuses the file and writes nothing.
    const src = path.join(root, 'src4');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'photo.jpg'), Buffer.alloc(5000, 1)); // stored (already compressed type)
    const file = path.join(root, 'Damaged.ironbooks');
    await format.writeCompanyFile(file, { manifest: manifest(), entries: format.snapshotDir(src) });
    const bytes = fs.readFileSync(file);
    const at = bytes.indexOf(Buffer.alloc(64, 1));
    bytes[at + 10] = 2;
    fs.writeFileSync(file, bytes);
    const dest2 = path.join(root, 'out-damaged');
    await expect(format.extractCompanyFile(file, dest2)).rejects.toThrow(/checksum|damaged/);
    expect(fs.existsSync(path.join(dest2, 'photo.jpg'))).toBe(false);
  });

  it('is not fooled by a file that is not a company file', async () => {
    const txt = path.join(root, 'notes.ironbooks');
    fs.writeFileSync(txt, 'hello');
    expect(format.readCompanyManifest(txt)).toBeNull();
    await expect(format.extractCompanyFile(txt, path.join(root, 'out-txt'))).rejects.toThrow(/not an Ironbooks company file/);
  });

  it('refuses a file saved by a newer format version', async () => {
    const src = path.join(root, 'src5');
    fs.mkdirSync(src, { recursive: true });
    const file = path.join(root, 'Future.ironbooks');
    await format.writeCompanyFile(file, { manifest: manifest({ formatVersion: 99 }), entries: format.snapshotDir(src) });
    await expect(format.extractCompanyFile(file, path.join(root, 'out-future'))).rejects.toThrow(/newer version/);
  });

  it('reuses compressed bytes of unchanged files between saves', async () => {
    const src = path.join(root, 'src6');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'big'), Buffer.alloc(200_000, 3));
    const cache = new Map();
    const file = path.join(root, 'Cache.ironbooks');
    await format.writeCompanyFile(file, { manifest: manifest(), entries: format.snapshotDir(src), cache });
    const first = (cache.get('big') as { compressed: Buffer }).compressed;
    await format.writeCompanyFile(file, { manifest: manifest(), entries: format.snapshotDir(src), cache });
    expect((cache.get('big') as { compressed: Buffer }).compressed).toBe(first);
    expect(zlib.inflateRawSync(first).length).toBe(200_000);
  });

  it('round-trips a live database, keeping committed rows and dropping an open transaction', async () => {
    const dir = path.join(root, 'livedb');
    const pg = new PGlite(dir);
    await pg.exec('create table t (id int primary key, note text); insert into t values (1, $$one$$), (2, $$two$$);');
    await pg.exec('checkpoint');
    await pg.exec('insert into t values (3, $$after checkpoint$$)'); // only in the WAL so far
    // An open transaction at snapshot time: must not appear in the copy.
    await pg.exec('begin');
    await pg.exec('insert into t values (4, $$uncommitted$$)');
    const entries = format.snapshotDir(dir);
    await pg.exec('rollback');
    await pg.close();

    const file = path.join(root, 'Live.ironbooks');
    await format.writeCompanyFile(file, { manifest: manifest(), entries });
    const out = path.join(root, 'livedb-copy');
    await format.extractCompanyFile(file, out);
    const copy = new PGlite(out);
    const rows = (await copy.query<{ id: number }>('select id from t order by id')).rows.map((r) => r.id);
    await copy.close();
    expect(rows).toEqual([1, 2, 3]);
  });
});

describe('restoring a backup (.bka) as a new company file', () => {
  const bka = (manifest: Record<string, unknown> | null, files: Record<string, string>) => {
    const zip = new AdmZip();
    if (manifest) zip.addFile('bookkeeper-manifest.json', Buffer.from(JSON.stringify(manifest)));
    for (const [name, data] of Object.entries(files)) zip.addFile(name, Buffer.from(data));
    const file = path.join(root, `b-${Math.random().toString(36).slice(2)}.bka`);
    zip.writeZip(file);
    return file;
  };

  it('extracts a full backup and reports its company name', async () => {
    const file = bka({ app: 'bookkeeper-ai', formatVersion: 1, kind: 'full', companyName: 'Acme' }, { PG_VERSION: '17\n', 'base/1/2': 'rows' });
    const dest = path.join(root, 'bka-out');
    const info = await format.extractBackupArchive(file, dest);
    expect(info.companyName).toBe('Acme');
    expect(fs.readFileSync(path.join(dest, 'base', '1', '2'), 'utf8')).toBe('rows');
    expect(fs.existsSync(path.join(dest, 'bookkeeper-manifest.json'))).toBe(false);
  });

  it('accepts a pre-manifest backup that is a bare database folder', async () => {
    const file = bka(null, { PG_VERSION: '17\n' });
    await expect(format.extractBackupArchive(file, path.join(root, 'bka-legacy'))).resolves.toMatchObject({ companyName: null });
  });

  it('refuses one-company backups, newer formats and archives that are not backups', async () => {
    const one = bka({ app: 'bookkeeper-ai', formatVersion: 1, kind: 'company' }, { 'company-data.json': '{}' });
    await expect(format.extractBackupArchive(one, path.join(root, 'bka-1'))).rejects.toThrow(/one company/);
    const newer = bka({ app: 'bookkeeper-ai', formatVersion: 9, kind: 'full' }, { PG_VERSION: '17\n' });
    await expect(format.extractBackupArchive(newer, path.join(root, 'bka-2'))).rejects.toThrow(/newer version/);
    const other = bka(null, { 'readme.txt': 'hi' });
    await expect(format.extractBackupArchive(other, path.join(root, 'bka-3'))).rejects.toThrow(/not an Ironbooks company file/);
  });
});
