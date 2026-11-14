/**
 * What a crafted or raced company file must never be able to do (security review, 2026-11):
 *
 *  1. Its backup history / settings (which travel inside every .ironbooks file) must never make
 *     this computer delete files that are not this file's own backups here, nor send backups to a
 *     folder (a network share) that was not chosen on this computer.
 *  3. A small file must never unpack into gigabytes (declared sizes are capped, inflating stops at
 *     the declared size).
 *  4. A full restore whose safety backup cannot be made keeps the books it replaced.
 *  5. Two processes taking over the same stale folder lock: only one gets it.
 *  6. A save that lost the lock, or that someone else's save overtook, while it was being written
 *     never replaces the company file.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { sql } from 'drizzle-orm';
import AdmZip from 'adm-zip';
import { PGlite } from '@electric-sql/pglite';

const require = createRequire(import.meta.url);
const lockMod = require('../../electron/companyLock.js');
const sessionMod = require('../../electron/companySession.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-security-'));

import fmt from '@/electron/companyFileFormat';
import { closeDb, getDb } from '@/lib/db';
import { CompanyFileInUseError, LOCK_FILE, acquireDirLock, dirLockTestHooks, releaseDirLock } from '@/lib/db/dirLock';
import { makeStartableFolder } from '@/lib/db/damage.fixture';
import { BACKUP_HISTORY_FILE, BACKUP_SETTINGS_FILE, backupFolder, readBackupHistory, readBackupSettings, saveBackupSettings } from './backupHistory';
import { rotateVersions, runVersionedBackup } from './backupSchedule';
import { createBackup, restoreBackup, validateBackupZip } from './backup';
import { getCompanyFileSaveStatus, resetCompanyFileSaveState, saveCompanyFile } from './companyFileSave';

afterAll(() => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best effort on Windows */
  }
});

function withBackupDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.BKA_BACKUP_DIR;
  process.env.BKA_BACKUP_DIR = dir;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.BKA_BACKUP_DIR;
    else process.env.BKA_BACKUP_DIR = prev;
  });
}

describe('1. backup history and settings that came in with a company file', () => {
  it('rotation deletes only this file\'s own backups in this computer\'s backup folders, never other files', async () => {
    const data = path.join(ROOT, 'crafted-history');
    await makeStartableFolder(data);
    const backups = path.join(ROOT, 'crafted-backups');
    await withBackupDir(backups, async () => {
      // Two real versions (the older one is due for rotation with keep = 1).
      const first = await runVersionedBackup('scheduled', { dataDir: data, companyName: 'Crafted Co', force: true, now: new Date('2026-01-01T10:00:00Z') });
      const second = await runVersionedBackup('scheduled', { dataDir: data, companyName: 'Crafted Co', force: true, now: new Date('2026-01-02T10:00:00Z') });
      expect(first.status).toBe('created');
      expect(second.status).toBe('created');
      // Files of the person's that a crafted history names (older, so they would be rotated first).
      const victims = path.join(ROOT, 'my-documents');
      fs.mkdirSync(victims, { recursive: true });
      const letter = path.join(victims, 'letter.docx');
      const lookalike = path.join(victims, 'backup-lookalike.bka'); // a backup name, but not in a backup folder
      const renamed = path.join(backups, 'auto-backup-other-company-2025.bka'); // in the folder, name differs from its record
      for (const f of [letter, lookalike, renamed]) fs.writeFileSync(f, 'precious');
      const history = JSON.parse(fs.readFileSync(path.join(data, BACKUP_HISTORY_FILE), 'utf8'));
      const crafted = [
        { id: 'x1', at: '2020-01-01T00:00:00Z', source: 'scheduled', kind: 'full', filename: 'letter.docx', path: letter },
        { id: 'x2', at: '2020-01-02T00:00:00Z', source: 'scheduled', kind: 'full', filename: 'backup-lookalike.bka', path: lookalike },
        { id: 'x3', at: '2020-01-03T00:00:00Z', source: 'scheduled', kind: 'full', filename: 'auto-backup-crafted.bka', path: renamed },
      ];
      fs.writeFileSync(path.join(data, BACKUP_HISTORY_FILE), JSON.stringify({ ...history, records: [...history.records, ...crafted] }));

      rotateVersions(1, data);
      for (const f of [letter, lookalike, renamed]) expect(fs.readFileSync(f, 'utf8')).toBe('precious');
      // The real rotation still happens: the older version is gone, the newer one kept.
      if (first.status === 'created' && second.status === 'created') {
        expect(fs.existsSync(first.record.path!)).toBe(false);
        expect(fs.existsSync(second.record.path!)).toBe(true);
      }
      // The crafted records were not "pruned" either: they are simply not this file's backups here.
      expect(readBackupHistory(data).filter((r) => r.id.startsWith('x') && r.prunedAt)).toEqual([]);
    });
  }, 120_000);

  it('a backup folder set in the file (a network share) is not used until it is chosen on this computer', async () => {
    const data = path.join(ROOT, 'crafted-folder');
    await makeStartableFolder(data);
    const backups = path.join(ROOT, 'this-computer');
    const share = process.platform === 'win32' ? '\\\\attacker-host\\drop' : '//attacker-host/drop';
    fs.writeFileSync(path.join(data, BACKUP_SETTINGS_FILE), JSON.stringify({ schedule: 'daily', everyHours: 24, keep: 3, folder: share }));
    await withBackupDir(backups, async () => {
      const mkdir = vi.spyOn(fs, 'mkdirSync');
      try {
        expect(backupFolder(readBackupSettings(data), data)).toBe(path.resolve(backups));
        const r = await runVersionedBackup('scheduled', { dataDir: data, companyName: 'Crafted Co', force: true });
        expect(r.status).toBe('created');
        if (r.status === 'created') {
          expect(path.dirname(r.record.path!)).toBe(path.resolve(backups));
          expect(r.record.note).toMatch(/chosen on another computer/);
        }
        // Nothing even tried to create the share (which makes Windows offer it the person's credentials).
        expect(mkdir.mock.calls.some(([p]) => String(p).includes('attacker-host'))).toBe(false);
      } finally {
        mkdir.mockRestore();
      }

      // A local folder that existed before this check counted as chosen here once, at upgrade;
      // later files cannot do that. A folder chosen here (Back Up settings) is used.
      const chosen = path.join(ROOT, 'chosen-here');
      saveBackupSettings({ folder: chosen }, data);
      expect(backupFolder(readBackupSettings(data), data)).toBe(path.resolve(chosen));
      const other = path.join(ROOT, 'set-by-another-file');
      fs.mkdirSync(other, { recursive: true });
      fs.writeFileSync(path.join(data, BACKUP_SETTINGS_FILE), JSON.stringify({ schedule: 'daily', everyHours: 24, keep: 3, folder: other }));
      expect(backupFolder(readBackupSettings(data), data)).toBe(path.resolve(backups));
    });
  }, 120_000);
});

/** Patch the declared uncompressed size of the zip entry `name` (local and central headers). */
function patchDeclaredSize(buf: Buffer, name: string, size: number): Buffer {
  const out = Buffer.from(buf);
  const nameBuf = Buffer.from(name, 'utf8');
  let patched = 0;
  for (let i = out.indexOf(nameBuf); i !== -1; i = out.indexOf(nameBuf, i + 1)) {
    if (i >= 30 && out.readUInt32LE(i - 30) === 0x04034b50) {
      out.writeUInt32LE(size, i - 30 + 22);
      patched++;
    } else if (i >= 46 && out.readUInt32LE(i - 46) === 0x02014b50) {
      out.writeUInt32LE(size, i - 46 + 24);
      patched++;
    }
  }
  expect(patched).toBeGreaterThanOrEqual(2);
  return out;
}

describe('3. a small file that would unpack into gigabytes', () => {
  const big = Buffer.alloc(32 * 1024 * 1024); // 32 MB of zeros: deflates to a few kilobytes

  it('stops inflating at the declared size, and refuses sizes no company file has, before unpacking anything', async () => {
    const file = path.join(ROOT, 'bomb.ironbooks');
    await fmt.writeCompanyFile(file, {
      manifest: { formatVersion: 1, fileId: 'bomb', companyName: 'Bomb', saveId: 's', savedAt: new Date().toISOString() },
      entries: [{ name: 'base/1/1259', data: big }],
    });
    expect(fs.statSync(file).size).toBeLessThan(1024 * 1024);
    // Claims 4 KB, inflates to 32 MB: inflating stops at 4 KB.
    fs.writeFileSync(file, patchDeclaredSize(fs.readFileSync(file), 'base/1/1259', 4096));
    await expect(fmt.extractCompanyFile(file, path.join(ROOT, 'bomb-out-1'))).rejects.toThrow(/larger than any company file can be/);
    // Claims 3 GB: refused before anything is inflated or written.
    fs.writeFileSync(file, patchDeclaredSize(fs.readFileSync(file), 'base/1/1259', 3 * 1024 * 1024 * 1024));
    await expect(fmt.extractCompanyFile(file, path.join(ROOT, 'bomb-out-2'))).rejects.toThrow(/larger than any company file can be/);
    expect(fs.existsSync(path.join(ROOT, 'bomb-out-2', 'base'))).toBe(false);
  }, 60_000);

  it('caps the total a file unpacks to', async () => {
    const file = path.join(ROOT, 'many.ironbooks');
    await fmt.writeCompanyFile(file, {
      manifest: { formatVersion: 1, fileId: 'many', companyName: 'Many', saveId: 's', savedAt: new Date().toISOString() },
      entries: [1, 2, 3].map((i) => ({ name: `base/1/${i}`, data: Buffer.alloc(1024 * 1024) })),
    });
    process.env.BKA_MAX_UNPACKED_BYTES = String(2 * 1024 * 1024);
    try {
      await expect(fmt.extractCompanyFile(file, path.join(ROOT, 'many-out'))).rejects.toThrow(/larger than any company file can be/);
    } finally {
      delete process.env.BKA_MAX_UNPACKED_BYTES;
    }
  }, 60_000);

  it('a plain backup archive claiming more than a company file can hold is refused', () => {
    const zip = new AdmZip();
    zip.addFile('PG_VERSION', Buffer.from('17\n'));
    zip.addFile('base/1/1259', big);
    const crafted = patchDeclaredSize(zip.toBuffer(), 'base/1/1259', 3 * 1024 * 1024 * 1024);
    expect(() => validateBackupZip(crafted)).toThrow(/more than any company file can hold/);
  });
});

describe('4. a full restore whose safety backup cannot be made', () => {
  it('keeps the books it replaced and says where', async () => {
    const parent = path.join(ROOT, 'restore-parent');
    const dir = path.join(parent, 'books');
    fs.mkdirSync(parent, { recursive: true });
    const db = await getDb(dir);
    await db.execute(sql`create table restore_probe (id int primary key)`);
    await db.execute(sql`insert into restore_probe values (1)`);
    await closeDb(dir);
    const { buffer } = createBackup('Restore Co', dir);
    const again = await getDb(dir);
    await again.execute(sql`insert into restore_probe values (2)`); // only in the books being replaced
    await closeDb(dir);
    // The safety backup cannot be written: its folder's name is taken by a file.
    fs.writeFileSync(path.join(parent, 'pre-op-backups'), 'not a folder');

    const result = await restoreBackup(buffer, dir);
    expect(result.restored).toBe(true);
    expect((result.notices ?? []).join(' ')).toMatch(/could not make its usual safety backup .* so it kept them instead/);
    const kept = fs.readdirSync(parent).filter((n) => n.startsWith('books before restore '));
    expect(kept).toHaveLength(1);
    const pg = new PGlite(path.join(parent, kept[0]));
    expect((await pg.query<{ id: number }>('select id from restore_probe order by id')).rows.map((r) => r.id)).toEqual([1, 2]);
    await pg.close();
    const restored = await getDb(dir);
    expect(((await restored.execute(sql`select id from restore_probe order by id`)).rows as Array<{ id: number }>).map((r) => r.id)).toEqual([1]);
    await closeDb(dir);
  }, 180_000);
});

describe('5. two processes taking over the same stale folder lock', () => {
  it('only one gets it: a fresh lock created meanwhile is never removed', () => {
    const dir = path.join(ROOT, 'lock-race');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, LOCK_FILE);
    // A lock left by a process of this computer that no longer runs.
    fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345, hostname: os.hostname(), startedAt: 'x', heartbeatAt: 'x' }));
    // The other process: judged it stale too and took it over a moment earlier.
    const theirs = JSON.stringify({ pid: process.ppid, hostname: os.hostname(), startedAt: 'y', heartbeatAt: 'y' });
    dirLockTestHooks.afterStaleCheck = () => {
      fs.rmSync(file);
      fs.writeFileSync(file, theirs, { flag: 'wx' });
    };
    try {
      expect(() => acquireDirLock(dir)).toThrow(CompanyFileInUseError);
    } finally {
      dirLockTestHooks.afterStaleCheck = undefined;
    }
    expect(fs.readFileSync(file, 'utf8')).toBe(theirs);
    expect(fs.readdirSync(dir).filter((n) => n.includes('takeover'))).toEqual([]);
    releaseDirLock(dir); // never held: no-op
    expect(fs.readFileSync(file, 'utf8')).toBe(theirs);
  });
});

describe('6. a save overtaken while it was being written', () => {
  const SHARE = path.join(ROOT, 'share');
  const FILE = path.join(SHARE, 'Race Co.ironbooks');
  let lock: { token: string; dir: string } | null = null;

  beforeAll(async () => {
    fs.mkdirSync(SHARE, { recursive: true });
    const seed = path.join(ROOT, 'race-seed');
    fs.mkdirSync(seed, { recursive: true });
    fs.writeFileSync(path.join(seed, 'bookkeeper-company.json'), JSON.stringify({ schema: 'bookkeeper-company/v1', name: 'Race Co' }));
    await fmt.writeCompanyFile(FILE, {
      manifest: { formatVersion: 1, fileId: 'fid-race', companyName: 'Race Co', saveId: 'genesis', savedAt: new Date().toISOString() },
      entries: fmt.snapshotDir(seed),
    });
    lock = lockMod.acquire(FILE, { appUser: 'Mary' }).lock;
    const prep = await sessionMod.prepareWorkingCopy(FILE, { root: path.join(ROOT, 'RaceWorking') });
    process.env.BKA_DATA_DIR = prep.dataDir;
    process.env.BKA_COMPANY_FILE = FILE;
    process.env.BKA_COMPANY_STATE = path.join(prep.workDir, 'state.json');
    process.env.BKA_COMPANY_LOCK = lock!.dir;
    process.env.BKA_COMPANY_LOCK_TOKEN = lock!.token;
    resetCompanyFileSaveState();
    const db = await getDb();
    await db.execute(sql`create table race_probe (id int primary key)`);
    expect(await saveCompanyFile({ force: true })).toMatchObject({ outcome: 'saved' });
  }, 120_000);

  afterAll(async () => {
    await closeDb().catch(() => undefined);
    resetCompanyFileSaveState();
    for (const k of ['BKA_COMPANY_FILE', 'BKA_COMPANY_STATE', 'BKA_COMPANY_LOCK', 'BKA_COMPANY_LOCK_TOKEN']) delete process.env[k];
  });

  /** Run one save while `during` happens just as it is written (before it replaces the file). */
  async function saveWhile(during: (write: typeof fmt.writeCompanyFile) => void | Promise<void>) {
    const real = fmt.writeCompanyFile;
    const spy = vi.spyOn(fmt, 'writeCompanyFile').mockImplementation(async (target: string, opts: Parameters<typeof real>[1]) => {
      await during(real);
      return real(target, opts);
    });
    try {
      return await saveCompanyFile({ force: true });
    } finally {
      spy.mockRestore();
    }
  }

  it('someone else saved the file meanwhile: their save stays, this one goes to a copy next', async () => {
    const db = await getDb();
    await db.execute(sql`insert into race_probe values (1)`);
    const theirs = 'saved-by-someone-else';
    await expect(
      saveWhile(async (write) => {
        // Another computer's save lands while this one is still being written.
        const other = path.join(ROOT, 'their-save');
        fs.rmSync(other, { recursive: true, force: true });
        await fmt.extractCompanyFile(FILE, other);
        await write(FILE, { manifest: { ...fmt.readCompanyManifest(FILE), saveId: theirs }, entries: fmt.snapshotDir(other) });
      }),
    ).rejects.toMatchObject({ code: 'SAVED_ELSEWHERE' });
    expect(fmt.readCompanyManifest(FILE).saveId).toBe(theirs);
    expect(getCompanyFileSaveStatus().error).toMatch(/Someone else saved the company file/);
    // The next save notices the other save and keeps this work apart (never over theirs).
    const next = await saveCompanyFile({ force: true });
    expect(next.outcome).toBe('conflict');
    expect(fmt.readCompanyManifest(FILE).saveId).toBe(theirs);
  }, 120_000);

  it('the lock was taken over meanwhile, or its record vanished: nothing replaces the company file', async () => {
    for (const scenario of ['taken-over', 'vanished'] as const) {
      const before = fmt.readCompanyManifest(FILE).saveId;
      const ownerFile = path.join(lock!.dir, 'owner.json');
      const original = fs.readFileSync(ownerFile, 'utf8');
      await expect(
        saveWhile(() => {
          if (scenario === 'taken-over') fs.writeFileSync(ownerFile, JSON.stringify({ ...JSON.parse(original), token: 'someone-else', computer: 'FRONT-DESK' }));
          else fs.rmSync(ownerFile);
        }),
      ).rejects.toMatchObject({ code: 'LOCK_LOST' });
      expect(fmt.readCompanyManifest(FILE).saveId).toBe(before);
      expect(getCompanyFileSaveStatus().status).toBe('lost');
      fs.writeFileSync(ownerFile, original);
      resetCompanyFileSaveState();
    }
  }, 120_000);
});
