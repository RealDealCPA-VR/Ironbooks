/**
 * Security work package E1 (SECURITY-PLAN 1.5 rows 1 and 4): paths that travel inside a company
 * file are never looked at on the computer that opens it unless this computer trusts them.
 *
 * The backup history, the condense archive list and the sandbox marker hold absolute paths written
 * on the sender's computer, or by whoever crafted the file. On Windows merely looking at a network
 * path (\\host\share\x: exists / realpath / stat) makes Windows connect to that host and offer it
 * the signed-in person's credentials. These tests put such paths in each place and check that no
 * file-system call ever receives one — during rotation, listing, trimming, preview / restore by id,
 * the backup-folder check, the condense archive list and leaving the sandbox — while this file's
 * own backups (also in a folder chosen here that is a network share) keep working.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DB } from '@/lib/db';
import {
  BACKUP_HISTORY_FILE,
  BACKUP_HISTORY_LIMIT,
  BACKUP_SETTINGS_FILE,
  backupFolder,
  backupPathHere,
  condenseArchiveFolders,
  isOwnBackupFile,
  preOpFolder,
  readBackupHistory,
  readBackupSettings,
  recordBackup,
  saveBackupSettings,
  setMappedDrivesForTests,
  trimHistory,
  type BackupRecord,
} from './backupHistory';
import { listBackupHistory, readBackupVersion, rotateVersions } from './backupSchedule';
import { preOpBackupDir } from './backup';
import { condenseArchiveDir, listCondenseArchives, restoreCondenseArchive } from './condense';
import { SANDBOX_MARKER, SANDBOX_MARKER_SCHEMA, writeSandboxMarker, type SandboxMarker } from './sandboxState';
import { SANDBOX_CONTAINER_MARKER, SANDBOX_SOURCE_RECORD, discardSandbox, getSandboxStatus, realDataDirHere } from './sandbox';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-sec1-paths-'));
const HOST = 'attacker-host';
/** A network share on the attacker's computer, spelled the way this platform spells one. */
const SHARE = process.platform === 'win32' ? `\\\\${HOST}\\drop` : `//${HOST}/drop`;
const onShare = (name: string) => (process.platform === 'win32' ? `${SHARE}\\${name}` : `${SHARE}/${name}`);

const ENV = ['BKA_BACKUP_DIR', 'BKA_DATA_DIR', 'BKA_SANDBOX_ROOT', 'BKA_SANDBOX', 'BKA_COMPANY_FILE', 'BKA_COMPANY_STATE'] as const;
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

afterEach(() => {
  vi.restoreAllMocks();
  setMappedDrivesForTests(null);
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

afterAll(() => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best effort on Windows */
  }
});

/** The error code `fn` throws ('no error' when it returns). */
function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return String((err as { code?: unknown }).code);
  }
  return 'no error';
}

/** Paths that must never reach the file system: anything on the attacker's host. */
const hostile = (p: unknown) => String(p).toLowerCase().includes(HOST);

/**
 * Watch the file-system calls that look at a path. A hostile path is recorded and answered as
 * "not there" without being passed on (so a test of the unfixed code never really connects);
 * everything else goes to the real call.
 */
function watchFs(): string[] {
  const touched: string[] = [];
  const missing = (p: unknown) => {
    touched.push(String(p));
    return Object.assign(new Error(`ENOENT: no such file or directory, '${String(p)}'`), { code: 'ENOENT' });
  };
  const wrap = <K extends 'existsSync' | 'statSync' | 'lstatSync' | 'realpathSync' | 'readFileSync' | 'rmSync' | 'openSync' | 'accessSync' | 'readdirSync' | 'mkdirSync'>(
    name: K,
    onHostile: (p: unknown) => unknown,
  ) => {
    const real = fs[name] as unknown as (...a: unknown[]) => unknown;
    vi.spyOn(fs, name).mockImplementation(((...args: unknown[]) => (hostile(args[0]) ? onHostile(args[0]) : real.apply(fs, args))) as never);
  };
  wrap('existsSync', (p) => {
    touched.push(String(p));
    return false;
  });
  for (const name of ['statSync', 'lstatSync', 'realpathSync', 'readFileSync', 'rmSync', 'openSync', 'accessSync', 'readdirSync', 'mkdirSync'] as const) {
    wrap(name, (p) => {
      throw missing(p);
    });
  }
  return touched;
}

let seq = 0;
/** A fresh company data folder (only its backup history is used) and this computer's backup folder. */
function setup(name: string) {
  const base = path.join(ROOT, `${name}-${++seq}`);
  const data = path.join(base, 'data');
  const here = path.join(base, 'backups-here');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(here, { recursive: true });
  process.env.BKA_BACKUP_DIR = here;
  return { base, data, here };
}

/** A versioned backup made on this computer: a file in `folder` and its history record. */
function version(data: string, folder: string, at: string, name: string, source: BackupRecord['source'] = 'scheduled'): BackupRecord {
  const p = path.join(folder, name);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(p, `bka ${name}`);
  return recordBackup({ at, source, kind: 'full', filename: name, path: p, sizeBytes: fs.statSync(p).size, fingerprint: name }, data);
}

/** Records naming files on the attacker's share, as a crafted (or travelled) history carries them. */
function addHostileRecords(data: string): string[] {
  const history = JSON.parse(fs.readFileSync(path.join(data, BACKUP_HISTORY_FILE), 'utf8'));
  const crafted = [
    { id: 'evil-1', at: '2020-01-01T00:00:00.000Z', source: 'scheduled', kind: 'full', filename: 'auto-backup-evil-1.bka', path: onShare('auto-backup-evil-1.bka'), sizeBytes: 3 },
    { id: 'evil-2', at: '2020-01-02T00:00:00.000Z', source: 'quit', kind: 'full', filename: 'auto-backup-evil-2.bka', path: onShare('auto-backup-evil-2.bka'), sizeBytes: 3 },
    { id: 'evil-3', at: '2020-01-03T00:00:00.000Z', source: 'manual', kind: 'full', filename: 'backup-evil-3.bka', path: onShare('backup-evil-3.bka'), sizeBytes: 3 },
    { id: 'evil-4', at: '2020-01-04T00:00:00.000Z', source: 'pre-op', kind: 'full', filename: 'preop-evil-4.bka', path: onShare('preop-evil-4.bka'), sizeBytes: 3 },
    // Device-path spellings of a network location.
    { id: 'evil-5', at: '2020-01-05T00:00:00.000Z', source: 'scheduled', kind: 'full', filename: 'auto-backup-evil-5.bka', path: `\\\\?\\UNC\\${HOST}\\drop\\auto-backup-evil-5.bka`, sizeBytes: 3 },
    { id: 'evil-6', at: '2020-01-06T00:00:00.000Z', source: 'scheduled', kind: 'full', filename: 'auto-backup-evil-6.bka', path: `//${HOST}/drop/auto-backup-evil-6.bka`, sizeBytes: 3 },
  ];
  fs.writeFileSync(path.join(data, BACKUP_HISTORY_FILE), JSON.stringify({ ...history, records: [...history.records, ...crafted] }));
  return crafted.map((r) => r.id);
}

describe('backup history paths from another computer', () => {
  it('rotation never looks at them, keeps them in the history, and still rotates this computer\'s versions', () => {
    const { data, here } = setup('rotate');
    const mine = [
      version(data, here, '2026-10-03T10:00:00.000Z', 'auto-backup-acme-c.bka'),
      version(data, here, '2026-10-04T10:00:00.000Z', 'auto-backup-acme-d.bka'),
      version(data, here, '2026-10-05T10:00:00.000Z', 'auto-backup-acme-e.bka'),
    ];
    const evil = addHostileRecords(data);
    const touched = watchFs();
    const pruned = rotateVersions(2, data, new Date('2026-10-05T11:00:00.000Z'));
    expect(touched).toEqual([]);
    vi.restoreAllMocks();
    expect(pruned).toBe(1);
    expect(fs.existsSync(mine[0].path!)).toBe(false);
    expect(fs.existsSync(mine[1].path!) && fs.existsSync(mine[2].path!)).toBe(true);
    // Kept as they were: not deleted from the history, not marked pruned, the path untouched.
    const after = new Map(readBackupHistory(data).map((r) => [r.id, r]));
    for (const id of evil) {
      expect(after.get(id)).toBeTruthy();
      expect(after.get(id)?.prunedAt).toBeUndefined();
      expect(hostile(after.get(id)?.path)).toBe(true);
    }
  });

  it('the history list shows them as not available here, without looking at them', () => {
    const { data, here } = setup('list');
    const own = version(data, here, '2026-10-03T10:00:00.000Z', 'auto-backup-acme-c.bka');
    const evil = addHostileRecords(data);
    const touched = watchFs();
    const rows = listBackupHistory(data);
    expect(touched).toEqual([]);
    expect(rows.find((r) => r.id === own.id)?.available).toBe(true);
    for (const id of evil) expect(rows.find((r) => r.id === id)?.available).toBe(false);
  });

  it('trimming a long history never looks at them', () => {
    const { data, here } = setup('trim');
    const own = version(data, here, '2026-10-03T10:00:00.000Z', 'auto-backup-acme-c.bka');
    addHostileRecords(data);
    // Fill the history past its limit with old downloads (no file), so the next write trims it.
    const history = JSON.parse(fs.readFileSync(path.join(data, BACKUP_HISTORY_FILE), 'utf8'));
    const filler = Array.from({ length: BACKUP_HISTORY_LIMIT }, (_, i) => ({
      id: `dl-${i}`,
      at: new Date(Date.UTC(2019, 0, 1) + i * 60_000).toISOString(),
      source: 'manual',
      kind: 'full',
      filename: `download-${i}.bka`,
      path: null,
      sizeBytes: 1,
    }));
    fs.writeFileSync(path.join(data, BACKUP_HISTORY_FILE), JSON.stringify({ ...history, records: [...history.records, ...filler] }));
    const touched = watchFs();
    recordBackup({ source: 'manual', kind: 'full', filename: 'x.bka', path: null, sizeBytes: 1, fingerprint: null }, data);
    // The pure function's own default check (the active company file) never looks at them either.
    process.env.BKA_DATA_DIR = data;
    trimHistory(readBackupHistory(data), 3);
    expect(touched).toEqual([]);
    vi.restoreAllMocks();
    const kept = readBackupHistory(data);
    expect(kept).toHaveLength(BACKUP_HISTORY_LIMIT);
    // This computer's version (its file is on disk here) is never trimmed away.
    expect(kept.some((r) => r.id === own.id)).toBe(true);
  });

  it('preview and restore by id (readBackupVersion) refuse them without looking at them', () => {
    const { data, here } = setup('read');
    version(data, here, '2026-10-03T10:00:00.000Z', 'auto-backup-acme-c.bka');
    const evil = addHostileRecords(data);
    const touched = watchFs();
    for (const id of evil) {
      expect(errorCode(() => readBackupVersion(id, data))).toBe('NOT_FOUND');
    }
    expect(touched).toEqual([]);
  });

  it('a backup folder set in the file is judged without looking at the history\'s other paths', () => {
    const { data } = setup('folder');
    // A local folder that came in with the file, and records that "prove" it was used here.
    const theirs = path.join(ROOT, `their-folder-${seq}`);
    fs.mkdirSync(theirs, { recursive: true });
    fs.writeFileSync(path.join(data, BACKUP_SETTINGS_FILE), JSON.stringify({ schedule: 'daily', everyHours: 24, keep: 3, folder: theirs }));
    fs.writeFileSync(path.join(data, BACKUP_HISTORY_FILE), JSON.stringify({ version: 1, records: [] }));
    addHostileRecords(data);
    // This computer already had its first look (it keeps a list of the folders chosen here).
    fs.writeFileSync(path.join(process.env.BKA_BACKUP_DIR!, '.ironbooks-backup-folders.json'), JSON.stringify({ folders: [] }));
    const touched = watchFs();
    expect(backupFolder(readBackupSettings(data), data)).toBe(path.resolve(process.env.BKA_BACKUP_DIR!));
    expect(touched).toEqual([]);
  });

  it('only a path directly in a trusted folder may be looked at (text only)', () => {
    const folder = path.join(ROOT, 'trusted');
    expect(backupPathHere(path.join(folder, 'auto-backup-x.bka'), [folder])).toBe(path.resolve(folder, 'auto-backup-x.bka'));
    expect(backupPathHere(path.join(folder, 'sub', 'auto-backup-x.bka'), [folder])).toBeNull();
    expect(backupPathHere(path.join(folder, '..', 'auto-backup-x.bka'), [folder])).toBeNull();
    expect(backupPathHere(path.join(folder, 'auto-backup-x.bka:stream'), [folder])).toBeNull();
    expect(backupPathHere('auto-backup-x.bka', [folder])).toBeNull();
    expect(backupPathHere(null, [folder])).toBeNull();
    expect(backupPathHere(onShare('auto-backup-x.bka'), [folder])).toBeNull();
    // A network folder this computer trusts (chosen here) is fine.
    expect(backupPathHere(onShare('auto-backup-x.bka'), [SHARE])).toBe(path.resolve(onShare('auto-backup-x.bka')));
  });
});

describe('readBackupVersion reads only this file\'s own backups on this computer', () => {
  it('refuses a record that names any other file', () => {
    const { data, here } = setup('own');
    const own = version(data, here, '2026-10-03T10:00:00.000Z', 'auto-backup-acme-c.bka');
    const docs = path.join(ROOT, `my-documents-${seq}`);
    fs.mkdirSync(docs, { recursive: true });
    const letter = path.join(docs, 'letter.docx');
    const lookalike = path.join(docs, 'backup-lookalike.bka'); // a backup's name, not in a backup folder
    const resized = path.join(here, 'auto-backup-resized.bka'); // in the folder, but not the recorded size
    for (const f of [letter, lookalike, resized]) fs.writeFileSync(f, 'precious');
    const history = JSON.parse(fs.readFileSync(path.join(data, BACKUP_HISTORY_FILE), 'utf8'));
    const crafted = [
      { id: 'x-letter', at: '2020-01-01T00:00:00Z', source: 'scheduled', kind: 'full', filename: 'letter.docx', path: letter, sizeBytes: 8 },
      { id: 'x-lookalike', at: '2020-01-02T00:00:00Z', source: 'manual', kind: 'full', filename: 'backup-lookalike.bka', path: lookalike, sizeBytes: 8 },
      { id: 'x-resized', at: '2020-01-03T00:00:00Z', source: 'scheduled', kind: 'full', filename: 'auto-backup-resized.bka', path: resized, sizeBytes: 999 },
      { id: 'x-renamed', at: '2020-01-04T00:00:00Z', source: 'scheduled', kind: 'full', filename: 'auto-backup-other.bka', path: own.path, sizeBytes: own.sizeBytes },
    ];
    fs.writeFileSync(path.join(data, BACKUP_HISTORY_FILE), JSON.stringify({ ...history, records: [...history.records, ...crafted] }));
    for (const r of crafted) {
      expect(errorCode(() => readBackupVersion(r.id, data))).toBe('NOT_FOUND');
    }
    expect(listBackupHistory(data).filter((r) => r.id.startsWith('x-') && r.available)).toEqual([]);
    // This file's own version still reads.
    expect(readBackupVersion(own.id, data).toString()).toBe('bka auto-backup-acme-c.bka');
  });

  it('safety copies and condense archive copies the history lists are still available and readable', () => {
    const { data } = setup('kinds');
    // The folders this module works out are the ones backup.ts and condense.ts write to.
    expect(preOpFolder(data)).toBe(preOpBackupDir(data));
    expect(condenseArchiveFolders(data).current).toBe(condenseArchiveDir(data));
    const preop = version(data, preOpFolder(data), '2026-10-03T10:00:00.000Z', 'preop-restore-abcd1234-1760000000000-1.bka', 'pre-op');
    const archive = version(data, condenseArchiveDir(data), '2026-10-04T10:00:00.000Z', 'condense-archive-acme-2026-10-04T10-00-00.bka', 'pre-op');
    // A safety copy's name in the archives folder is not taken for one.
    const misplaced = version(data, condenseArchiveDir(data), '2026-10-05T10:00:00.000Z', 'preop-misplaced.bka', 'pre-op');
    const rows = new Map(listBackupHistory(data).map((r) => [r.id, r]));
    expect(rows.get(preop.id)?.available).toBe(true);
    expect(rows.get(archive.id)?.available).toBe(true);
    expect(rows.get(misplaced.id)?.available).toBe(false);
    expect(readBackupVersion(preop.id, data).length).toBe(preop.sizeBytes);
    expect(readBackupVersion(archive.id, data).length).toBe(archive.sizeBytes);
    // Rotation never deletes either kind (only versions in the backup folders).
    expect(isOwnBackupFile(preop, data)).toBe(false);
    expect(isOwnBackupFile(preop, data, 'read')).toBe(true);
  });
});

describe('a backup folder chosen on this computer that is a network share', () => {
  it('keeps working: its versions are listed, read and rotated; other paths on that share are not touched', () => {
    const { base, data } = setup('office');
    const officeShare = path.join(base, 'office-server', 'Ironbooks Backups');
    // On Windows, make the drive the test folders are on count as a mapped network drive, so the
    // chosen folder is a network folder (as \\server\share would be) and only trusted once chosen.
    if (process.platform === 'win32') setMappedDrivesForTests([path.resolve(base)[0]]);
    saveBackupSettings({ folder: officeShare }, data);
    expect(backupFolder(readBackupSettings(data), data)).toBe(path.resolve(officeShare));
    const versions = [
      version(data, officeShare, '2026-10-03T10:00:00.000Z', 'auto-backup-acme-c.bka'),
      version(data, officeShare, '2026-10-04T10:00:00.000Z', 'auto-backup-acme-d.bka'),
    ];
    // On the same share, but not in a folder chosen here.
    const elsewhere = path.join(base, 'office-server', 'someone-elses');
    fs.mkdirSync(elsewhere, { recursive: true });
    const history = JSON.parse(fs.readFileSync(path.join(data, BACKUP_HISTORY_FILE), 'utf8'));
    history.records.push({ id: 'not-chosen', at: '2020-01-01T00:00:00Z', source: 'scheduled', kind: 'full', filename: 'auto-backup-x.bka', path: path.join(elsewhere, 'auto-backup-x.bka'), sizeBytes: 3 });
    fs.writeFileSync(path.join(elsewhere, 'auto-backup-x.bka'), 'bka');
    fs.writeFileSync(path.join(data, BACKUP_HISTORY_FILE), JSON.stringify(history));

    const looked: string[] = [];
    const realExists = fs.existsSync;
    const realRealpath = fs.realpathSync;
    vi.spyOn(fs, 'existsSync').mockImplementation(((p: fs.PathLike) => {
      looked.push(String(p));
      return realExists(p);
    }) as typeof fs.existsSync);
    vi.spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike) => {
      looked.push(String(p));
      return realRealpath(p);
    }) as typeof fs.realpathSync);
    const rows = new Map(listBackupHistory(data).map((r) => [r.id, r]));
    expect(rows.get(versions[0].id)?.available).toBe(true);
    expect(rows.get('not-chosen')?.available).toBe(false);
    expect(readBackupVersion(versions[1].id, data).toString()).toBe('bka auto-backup-acme-d.bka');
    expect(errorCode(() => readBackupVersion('not-chosen', data))).toBe('NOT_FOUND');
    expect(rotateVersions(1, data)).toBe(1);
    expect(looked.some((p) => p.includes('someone-elses'))).toBe(false);
    vi.restoreAllMocks();
    expect(fs.existsSync(versions[0].path!)).toBe(false);
    expect(fs.existsSync(versions[1].path!)).toBe(true);
    expect(fs.existsSync(path.join(elsewhere, 'auto-backup-x.bka'))).toBe(true);
  });
});

describe('the condense archive list', () => {
  it('finds each copy in this computer\'s archives folder and never looks at the path written in the list', async () => {
    const { data } = setup('condense');
    fs.writeFileSync(path.join(data, '.file-id'), 'file-1');
    const archives = condenseArchiveDir(data);
    fs.mkdirSync(archives, { recursive: true });
    const realCopy = path.join(archives, 'condense-archive-acme-2026-01-01.bka');
    fs.writeFileSync(realCopy, 'archive bytes');
    const entry = (id: string, p: string, filename: string) => ({
      id,
      path: p,
      filename,
      createdAt: '2026-01-01T00:00:00.000Z',
      dataDir: data,
      fileId: 'file-1',
      companyId: 'co-1',
      companyName: 'Acme',
      beforeDate: '2025-01-01',
      entriesCondensed: 1,
      sizeBytes: 13,
    });
    fs.writeFileSync(
      path.join(archives, 'condense-archives.json'),
      JSON.stringify([
        // Written on another computer that reaches the same folder by a network name.
        entry('travelled', onShare('condense-archive-acme-2026-01-01.bka'), 'condense-archive-acme-2026-01-01.bka'),
        // A crafted entry naming only a network file.
        entry('crafted', onShare('payload.bka'), 'payload.bka'),
        entry('crafted-up', onShare('x.bka'), '..'),
      ]),
    );
    const touched = watchFs();
    const listed = new Map(listCondenseArchives(data).map((a) => [a.id, a]));
    await expect(
      restoreCondenseArchive({ db: {} as DB, companyId: 'co-1', userId: 'u-1', role: 'owner' }, 'crafted', data),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(touched).toEqual([]);
    expect(listed.get('travelled')).toMatchObject({ available: true, path: realCopy });
    expect(listed.get('crafted')).toMatchObject({ available: false });
    expect(hostile(listed.get('crafted')?.path)).toBe(false);
    expect(listed.get('crafted-up')).toMatchObject({ available: false });
  });
});

describe('the sandbox marker', () => {
  function sandboxCopy(kind: SandboxMarker['kind'], realDataDir: string) {
    const root = path.join(ROOT, `sandboxes-${++seq}`);
    const dir = path.join(root, 'Acme sandbox 1', 'data');
    fs.mkdirSync(dir, { recursive: true });
    writeSandboxMarker(dir, { schema: SANDBOX_MARKER_SCHEMA, kind, realDataDir, sourceName: 'Acme', createdAt: new Date().toISOString() });
    process.env.BKA_DATA_DIR = dir;
    return { root, dir };
  }
  const ctx = { db: {} as DB, companyId: 'co-1', userId: 'u-1' };

  it('a copy whose marker names a network path: status and leaving never look at it', async () => {
    const { dir } = sandboxCopy('sandbox', onShare('books'));
    const touched = watchFs();
    expect(getSandboxStatus()).toMatchObject({ active: true, kind: 'sandbox', realFileFound: false });
    await expect(discardSandbox(ctx)).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/not made from a company file on this computer/) });
    expect(touched).toEqual([]);
    expect(fs.existsSync(path.join(dir, SANDBOX_MARKER))).toBe(true);
  });

  it('a training file whose marker names a network path: its status never looks at it', () => {
    sandboxCopy('training', onShare('books'));
    const touched = watchFs();
    expect(getSandboxStatus()).toMatchObject({ active: true, kind: 'training', realFileFound: null });
    expect(touched).toEqual([]);
  });

  it('a copy this computer made: the marker must name the file recorded beside it', async () => {
    const real = path.join(ROOT, `real-books-${seq}`);
    const other = path.join(ROOT, `other-books-${seq}`);
    fs.mkdirSync(real, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    const { root, dir } = sandboxCopy('sandbox', other);
    const container = path.dirname(dir);
    fs.writeFileSync(path.join(container, SANDBOX_CONTAINER_MARKER), 'x');
    fs.writeFileSync(path.join(container, SANDBOX_SOURCE_RECORD), JSON.stringify({ realDataDir: real }));
    process.env.BKA_SANDBOX_ROOT = root;
    const marker = { schema: SANDBOX_MARKER_SCHEMA, kind: 'sandbox', realDataDir: other, sourceName: 'Acme', createdAt: '' } as SandboxMarker;
    expect(realDataDirHere(marker, dir)).toBeNull();
    await expect(discardSandbox(ctx)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(realDataDirHere({ ...marker, realDataDir: real }, dir)).toBe(path.resolve(real));
    // The record counts only in this computer's own sandbox folder.
    delete process.env.BKA_SANDBOX_ROOT;
    expect(realDataDirHere(marker, dir)).toBe(path.resolve(other));
  });

  it('a copy made by an earlier version (no record): a local path is taken, a network one never', () => {
    const local = path.join(ROOT, 'legacy-real');
    const marker = (realDataDir: string) => ({ schema: SANDBOX_MARKER_SCHEMA, kind: 'sandbox', realDataDir, sourceName: 'Acme', createdAt: '' }) as SandboxMarker;
    const dir = path.join(ROOT, 'legacy-sandbox', 'data');
    expect(realDataDirHere(marker(local), dir)).toBe(path.resolve(local));
    expect(realDataDirHere(marker(onShare('books')), dir)).toBeNull();
    expect(realDataDirHere(marker('relative/books'), dir)).toBeNull();
  });
});
