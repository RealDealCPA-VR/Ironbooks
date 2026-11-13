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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

import { closeDb, getDb, isDbOpen } from '@/lib/db';
import { damageCheckpoint } from '@/lib/db/damage.fixture';
import { resetCompanyFileSaveState, saveCompanyFile, getCompanyFileSaveStatus } from './companyFileSave';
import { createBackup } from './backup';
import { recoveryNotice, resetRecoveryState, UnstartableBooksError } from './workingCopyRecovery';

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
    expect(getCompanyFileSaveStatus().error).toMatch(/did not save it over your company file/);
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
    expect(notice!.message).toMatch(/Changes made after that save could not be recovered/);
    // The damaged copy is kept on this computer, untouched.
    expect(notice!.keptAt).toBeTruthy();
    expect(path.dirname(notice!.keptAt!)).toBe(workDir);
    expect(fs.existsSync(path.join(notice!.keptAt!, 'PG_VERSION'))).toBe(true);
    // The working copy now starts from that save (crash recovery bookkeeping).
    expect(sessionMod.readState(workDir)).toMatchObject({ base: { saveId: savedId }, unsavedSince: null });
    expect(isDbOpen()).toBe(true);
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
