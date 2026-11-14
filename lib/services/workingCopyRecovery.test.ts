/**
 * The books on this computer will not start after a crash (lib/services/workingCopyRecovery.ts):
 * the working copy of an open company file whose database was left unable to start (the damage two
 * Postgres instances on one folder, or a power cut, leave behind — lib/db/damage.fixture.ts).
 *
 *  - while it is like that, nothing is saved over the company file and no backup is made from it;
 *  - the next open does not lock the person out: the damaged copy is kept aside, the company file
 *    is reopened as last saved, and the person is told in plain words that the changes after that
 *    save were lost;
 *  - saving works again afterwards.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { sql } from 'drizzle-orm';

const require = createRequire(import.meta.url);
const format = require('../../electron/companyFileFormat.js');
const lockMod = require('../../electron/companyLock.js');
const sessionMod = require('../../electron/companySession.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-recover-'));
const SHARE = path.join(ROOT, 'share');
const FILE = path.join(SHARE, 'Acme Plumbing.ironbooks');
const WORKING = path.join(ROOT, 'Working');
fs.mkdirSync(SHARE, { recursive: true });
process.env.BKA_RECOVERY_RETRY_MS = '50';

import fmt from '@/electron/companyFileFormat';
import { closeDb, getDb, getLedgerDamage, isDbOpen } from '@/lib/db';
import { damageCheckpoint } from '@/lib/db/damage.fixture';
import { autosaveTick, resetCompanyFileSaveState, saveCompanyFile, getCompanyFileSaveStatus } from './companyFileSave';
import { createBackup } from './backup';
import { dataDirProblem, recoverUnstartableWorkingCopy, recoveryNotice, resetRecoveryState, UnstartableBooksError } from './workingCopyRecovery';

/** The damaged copies kept in the working folder (electron/companySession.js keepDamagedCopy). */
function damagedCopies(): string[] {
  return fs.readdirSync(workDir).filter((n) => n.startsWith(sessionMod.DAMAGED_PREFIX));
}

/** Leftovers of a recovery that did not finish (never expected). */
function leftovers(): string[] {
  return fs.readdirSync(workDir).filter((n) => /^data\.(recover|damaged)-\d+$/.test(n));
}

let workDir = '';
let lock: { token: string; dir: string } | null = null;

/** What the desktop shell does to open the company file (electron/main.js). */
async function open() {
  lock = lockMod.acquire(FILE, { appUser: 'Mary' }).lock;
  const prep = await sessionMod.prepareWorkingCopy(FILE, { root: WORKING });
  workDir = prep.workDir;
  process.env.BKA_DATA_DIR = prep.dataDir;
  process.env.BKA_COMPANY_FILE = FILE;
  process.env.BKA_COMPANY_STATE = path.join(workDir, 'state.json');
  process.env.BKA_COMPANY_LOCK = lock!.dir;
  process.env.BKA_COMPANY_LOCK_TOKEN = lock!.token;
  resetCompanyFileSaveState();
  return prep;
}

/** The app stops without closing anything (crash, power cut): only the lock is left behind. */
async function crash() {
  // The killed process's database is gone from memory; this one lets go of the folder.
  await closeDb().catch(() => undefined);
  if (lock) lockMod.release(lock);
  lock = null;
  resetCompanyFileSaveState();
}

async function probeRows(): Promise<number[]> {
  const db = await getDb();
  return ((await db.execute(sql`select id from recover_probe order by id`)).rows as Array<{ id: number }>).map((r) => r.id);
}

beforeAll(async () => {
  const seed = path.join(ROOT, 'seed');
  fs.mkdirSync(seed, { recursive: true });
  fs.writeFileSync(path.join(seed, 'bookkeeper-company.json'), JSON.stringify({ schema: 'bookkeeper-company/v1', name: 'Acme Plumbing' }));
  await format.writeCompanyFile(FILE, {
    manifest: { formatVersion: 1, fileId: 'fid-recover', companyName: 'Acme Plumbing', saveId: 'genesis', savedAt: new Date().toISOString() },
    entries: format.snapshotDir(seed),
  });
  await open();
  const db = await getDb();
  await db.execute(sql`create table recover_probe (id int primary key)`);
  await db.execute(sql`insert into recover_probe values (1)`);
  expect(await saveCompanyFile({ force: true })).toMatchObject({ outcome: 'saved' });
}, 180_000);

afterAll(async () => {
  await crash();
  resetRecoveryState();
  for (const k of ['BKA_COMPANY_FILE', 'BKA_COMPANY_STATE', 'BKA_COMPANY_LOCK', 'BKA_COMPANY_LOCK_TOKEN']) delete process.env[k];
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best effort on Windows */
  }
});

describe('a working copy that will not start after a crash', () => {
  let savedId = '';

  it('is never saved over the company file, and no backup is made from it', async () => {
    const db = await getDb();
    await db.execute(sql`insert into recover_probe values (2)`); // after the last save
    fs.appendFileSync(path.join(process.env.BKA_DATA_DIR!, 'transactions.bktlg'), JSON.stringify({ seq: 1, hash: 'h1' }) + '\n');
    savedId = format.readCompanyManifest(FILE).saveId;
    await crash();
    damageCheckpoint(process.env.BKA_DATA_DIR!);

    // Whatever tries to save it (the autosave, the close-time save) is refused, in plain words.
    await expect(saveCompanyFile({ force: true })).rejects.toBeInstanceOf(UnstartableBooksError);
    expect(format.readCompanyManifest(FILE).saveId).toBe(savedId);
    expect(getCompanyFileSaveStatus()).toMatchObject({ status: 'error' });
    expect(getCompanyFileSaveStatus().error).toMatch(/did not save it over your company file, which still holds your last good save/);
    expect(() => createBackup('Acme Plumbing', process.env.BKA_DATA_DIR)).toThrow(UnstartableBooksError);
  }, 60_000);

  it('the next open reopens the company file as last saved, keeps the damaged copy, and says what was lost', async () => {
    const prep = await open();
    expect(prep.plan).toBe('recover'); // the shell reuses the working copy after a crash
    resetRecoveryState();

    expect(await probeRows()).toEqual([1]); // the last save; row 2 was never saved
    const notice = recoveryNotice();
    expect(notice).toMatchObject({ changesLost: true });
    expect(notice!.message).toMatch(/reopened your company file as it was last saved/);
    expect(notice!.message).toMatch(/Anything entered after that save could not be recovered/);
    // The damaged copy is kept on this computer, untouched.
    expect(notice!.keptAt).toBeTruthy();
    expect(path.dirname(notice!.keptAt!)).toBe(workDir);
    expect(fs.existsSync(path.join(notice!.keptAt!, 'PG_VERSION'))).toBe(true);
    // The working copy now starts from that save (crash recovery bookkeeping).
    expect(sessionMod.readState(workDir)).toMatchObject({ base: { saveId: savedId }, unsavedSince: null });
    expect(isDbOpen()).toBe(true);
    expect(damagedCopies()).toHaveLength(1);
    expect(leftovers()).toEqual([]);
  }, 120_000);

  it('saving works again afterwards', async () => {
    const db = await getDb();
    await db.execute(sql`insert into recover_probe values (3)`);
    expect(await saveCompanyFile({ force: true })).toMatchObject({ outcome: 'saved' });
    expect(format.readCompanyManifest(FILE).previousSaveId).toBe(savedId);
    const out = path.join(ROOT, 'check');
    await format.extractCompanyFile(FILE, out);
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = new PGlite(out);
    expect((await pg.query<{ id: number }>('select id from recover_probe order by id')).rows.map((r) => r.id)).toEqual([1, 3]);
    await pg.close();
  }, 120_000);

  it('a save whose files fail the start check while the books run fine checkpoints and saves after all', async () => {
    // The control file on disk names a checkpoint that is not there (what a stale write leaves),
    // while the database itself is open and fine: a checkpoint rewrites the files, then it saves.
    const control = path.join(process.env.BKA_DATA_DIR!, 'global', 'pg_control');
    const buf = fs.readFileSync(control);
    buf.writeBigUInt64LE(BigInt(0x7f000028), 32);
    fs.writeFileSync(control, buf);
    expect(dataDirProblem(process.env.BKA_DATA_DIR!)).toMatch(/missing/);
    expect(await saveCompanyFile({ force: true })).toMatchObject({ outcome: 'saved' });
    expect(dataDirProblem(process.env.BKA_DATA_DIR!)).toBeNull();
    expect(format.readCompanyManifest(FILE).dbSchema).toBeTruthy();
  }, 120_000);

  it('running the recovery again on books that start changes nothing', async () => {
    const dir = process.env.BKA_DATA_DIR!;
    const before = damagedCopies();
    const noticeBefore = recoveryNotice();
    expect(await recoverUnstartableWorkingCopy(dir)).toBe('retry'); // open: never test-started
    await closeDb();
    expect(await recoverUnstartableWorkingCopy(dir)).toBe('retry'); // closed: it starts, so it stays
    expect(damagedCopies()).toEqual(before);
    expect(recoveryNotice()).toBe(noticeBefore);
    expect(await probeRows()).toEqual([1, 3]);
  }, 120_000);

  it('requests that arrive together all wait for ONE recovery and get the reopened books', async () => {
    await crash();
    damageCheckpoint(process.env.BKA_DATA_DIR!);
    await open();
    resetRecoveryState();
    const before = damagedCopies().length;
    const [a, b, damage, c] = await Promise.all([getDb(), getDb(), getLedgerDamage(), getDb()]);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(damage).toBeNull();
    expect(damagedCopies()).toHaveLength(before + 1);
    expect(leftovers()).toEqual([]);
    expect(recoveryNotice()).not.toBeNull();
    expect(await probeRows()).toEqual([1, 3]);
  }, 120_000);

  it('a swap that fails half way puts the working copy back, and nothing is saved while it runs', async () => {
    await crash();
    damageCheckpoint(process.env.BKA_DATA_DIR!);
    await open();
    resetRecoveryState();
    const dir = process.env.BKA_DATA_DIR!;
    const savedBefore = format.readCompanyManifest(FILE).saveId;
    const sizeBefore = fs.statSync(FILE).size;
    const realRename = fmt.renameWithRetry;
    let calls = 0;
    let tickDuringRecovery: string | null = null;
    let goneDuringRecovery = false;
    const spy = vi.spyOn(fmt, 'renameWithRetry').mockImplementation(async (from: string, to: string) => {
      calls++;
      if (calls === 2) {
        // The working copy is out of the way and the last save not in yet: the heartbeat's autosave.
        goneDuringRecovery = !fs.existsSync(dir);
        tickDuringRecovery = await autosaveTick(Date.now() + 10 * 60_000);
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      }
      return realRename(from, to);
    });
    try {
      await expect(getDb()).rejects.toThrow(/a file on this computer was busy/);
    } finally {
      spy.mockRestore();
    }
    expect(goneDuringRecovery).toBe(true);
    expect(tickDuringRecovery).toBe('busy');
    // Back as it was: the damaged books in place (nothing empty), the company file untouched.
    expect(fs.existsSync(path.join(dir, 'PG_VERSION'))).toBe(true);
    expect(dataDirProblem(dir)).toMatch(/missing/);
    expect(leftovers()).toEqual([]);
    expect(format.readCompanyManifest(FILE).saveId).toBe(savedBefore);
    expect(fs.statSync(FILE).size).toBe(sizeBefore);
    // Next time it goes through.
    expect(await probeRows()).toEqual([1, 3]);
  }, 120_000);

  it('restoring a backup whose books do not start is rolled back, never "recovered" into the company file', async () => {
    const AdmZip = (await import('adm-zip')).default;
    const { restoreBackup } = await import('./backup');
    const { PGlite } = await import('@electric-sql/pglite');
    const bad = path.join(ROOT, 'bad-backup');
    const pg = new PGlite(bad);
    await pg.exec('create table recover_probe (id int primary key); insert into recover_probe values (99);');
    await pg.close();
    damageCheckpoint(bad);
    const zip = new AdmZip();
    zip.addLocalFolder(bad);
    resetRecoveryState();

    await expect(restoreBackup(zip.toBuffer())).rejects.toThrow(/could not be opened/);
    expect(recoveryNotice()).toBeNull();
    expect(await probeRows()).toEqual([1, 3]); // the books in use are untouched
  }, 120_000);

  it('a working copy that is gone is never replaced by a new, empty database', async () => {
    await crash();
    const dir = process.env.BKA_DATA_DIR!;
    fs.rmSync(dir, { recursive: true, force: true });
    await expect(getDb()).rejects.toThrow(/copy of your books on this computer is missing/);
    expect(fs.existsSync(path.join(dir, 'PG_VERSION'))).toBe(false);
    // Nothing to save either: an empty snapshot never replaces the company file.
    const savedBefore = format.readCompanyManifest(FILE).saveId;
    await expect(saveCompanyFile({ force: true })).rejects.toBeInstanceOf(UnstartableBooksError);
    expect(format.readCompanyManifest(FILE).saveId).toBe(savedBefore);
    expect(() => createBackup('Acme Plumbing', dir)).toThrow();
  }, 60_000);

  it('unsaved changes in a damaged copy are set aside, never written out as an "(unsaved changes)" file that will not open', async () => {
    await crash();
    await open(); // a fresh working copy from the company file
    await getDb();
    await crash();
    const dir = process.env.BKA_DATA_DIR!;
    // Unsaved changes here, someone else saved the file since, and the copy here is damaged.
    sessionMod.writeState(workDir, { unsavedSince: new Date().toISOString() });
    const other = path.join(ROOT, 'other-save');
    await format.extractCompanyFile(FILE, other);
    await format.writeCompanyFile(FILE, { manifest: { ...format.readCompanyManifest(FILE), saveId: 'saved-elsewhere' }, entries: format.snapshotDir(other) });
    damageCheckpoint(dir);
    await expect(sessionMod.writeWorkingCopyAs(workDir, path.join(ROOT, 'x.ironbooks'))).rejects.toMatchObject({ code: 'DAMAGED' });

    const before = damagedCopies().length;
    const prep = await sessionMod.prepareWorkingCopy(FILE, { root: WORKING, onConflict: async () => true });
    expect(prep.plan).toBe('conflict');
    expect(prep.conflictCopy).toBeNull();
    expect(prep.damagedCopy).toBeTruthy();
    expect(fs.existsSync(path.join(prep.damagedCopy, 'PG_VERSION'))).toBe(true);
    expect(damagedCopies()).toHaveLength(before + 1);
    expect(fs.readdirSync(SHARE).filter((n: string) => /unsaved changes/.test(n))).toEqual([]);
    // The working copy is the company file as saved elsewhere, and it starts.
    expect(dataDirProblem(dir)).toBeNull();
  }, 120_000);

  it('a company file whose last save does not start either is refused in plain words, not "Aborted()"', async () => {
    await crash();
    // Both broken: the working copy, and (written by an older version without the save check) the file.
    const bad = path.join(ROOT, 'bad');
    fs.cpSync(process.env.BKA_DATA_DIR!, bad, { recursive: true });
    damageCheckpoint(bad);
    await format.writeCompanyFile(FILE, {
      manifest: { ...format.readCompanyManifest(FILE), saveId: 'broken-save' },
      entries: format.snapshotDir(bad),
    });
    damageCheckpoint(process.env.BKA_DATA_DIR!);
    await open();
    resetRecoveryState();
    await expect(getDb()).rejects.toThrow(/could not open this company file: its database is damaged .*Open your most recent backup/);
    expect(recoveryNotice()).toBeNull();
    // Nothing was moved or deleted: the working copy is where it was.
    expect(fs.existsSync(path.join(process.env.BKA_DATA_DIR!, 'PG_VERSION'))).toBe(true);
  }, 120_000);
});
