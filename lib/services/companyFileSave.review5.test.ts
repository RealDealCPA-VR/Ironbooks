/**
 * Review round 5 — saving the single company file (lib/services/companyFileSave.ts):
 *  - after someone else saved the file, the unsaved changes go to ONE separate copy, and later
 *    work keeps going into that same copy (never a new full copy of the file every few seconds);
 *  - once another computer has taken the file over, changes made here are still recorded as
 *    unsaved in the working copy's state (so the next open keeps them as a separate copy instead
 *    of throwing the working copy away);
 *  - saves asked for while one is running run one after another, never side by side.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { getDb, closeDb } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { autosaveTick, getCompanyFileSaveStatus, resetCompanyFileSaveState, saveCompanyFile } from './companyFileSave';

const require = createRequire(import.meta.url);
const format = require('../../electron/companyFileFormat.js');
const lockMod = require('../../electron/companyLock.js');
const sessionMod = require('../../electron/companySession.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-save5-'));
const SHARE = path.join(ROOT, 'share');
const FILE = path.join(SHARE, 'Beacon Books.ironbooks');
const WORKING = path.join(ROOT, 'Working');
fs.mkdirSync(SHARE, { recursive: true });

let workDir = '';
let lock: { token: string; dir: string; companyFile: string } | null = null;
let logSeq = 0;

function appendLogRecord(dataDir: string) {
  logSeq += 1;
  fs.appendFileSync(path.join(dataDir, 'transactions.bktlg'), JSON.stringify({ seq: logSeq, hash: `h${logSeq}` }) + '\n');
}

const conflictCopies = () => fs.readdirSync(SHARE).filter((n) => /unsaved changes from/.test(n) && n.endsWith('.ironbooks'));

async function rowsIn(file: string): Promise<number[]> {
  const out = fs.mkdtempSync(path.join(ROOT, 'open-'));
  fs.rmSync(out, { recursive: true, force: true });
  await format.extractCompanyFile(file, out);
  const pg = new PGlite(out);
  try {
    return (await pg.query<{ id: number }>('select id from save_probe order by id')).rows.map((r) => r.id);
  } finally {
    await pg.close();
  }
}

/** Someone else's save lands in the company file (their own copy of the books). */
async function someoneElseSaves(saveId: string) {
  const before = format.readCompanyManifest(FILE);
  const theirs = path.join(ROOT, `theirs-${saveId}`);
  fs.mkdirSync(theirs, { recursive: true });
  fs.writeFileSync(path.join(theirs, 'PG_VERSION'), '17\n');
  await format.writeCompanyFile(FILE, {
    manifest: { ...before, saveId, previousSaveId: before.saveId },
    entries: format.snapshotDir(theirs),
  });
}

/** This working copy continues from the file as it is on disk now (clean). */
function adoptFileOnDisk() {
  const m = format.readCompanyManifest(FILE);
  sessionMod.writeState(workDir, { base: { saveId: m.saveId, savedAt: m.savedAt, fingerprint: m.fingerprint ?? null }, unsavedSince: null });
  resetCompanyFileSaveState();
}

beforeAll(async () => {
  const seedDir = path.join(ROOT, 'seed');
  fs.mkdirSync(seedDir, { recursive: true });
  fs.writeFileSync(path.join(seedDir, 'bookkeeper-company.json'), JSON.stringify({ schema: 'bookkeeper-company/v1', name: 'Beacon Books' }));
  await format.writeCompanyFile(FILE, {
    manifest: { formatVersion: 1, fileId: 'fid-5', companyName: 'Beacon Books', saveId: 'genesis', savedAt: new Date().toISOString() },
    entries: format.snapshotDir(seedDir),
  });
  lock = lockMod.acquire(FILE, { appUser: 'Mary' }).lock;
  const prep = await sessionMod.prepareWorkingCopy(FILE, { root: WORKING });
  workDir = prep.workDir;
  process.env.BKA_DATA_DIR = prep.dataDir;
  process.env.BKA_COMPANY_FILE = FILE;
  process.env.BKA_COMPANY_STATE = path.join(workDir, 'state.json');
  process.env.BKA_COMPANY_LOCK = lock!.dir;
  process.env.BKA_COMPANY_LOCK_TOKEN = lock!.token;
  resetCompanyFileSaveState();
  const db = await getDb();
  await db.execute(sql`create table if not exists save_probe (id int primary key, note text)`);
  expect((await saveCompanyFile({ force: true })).outcome).toBe('saved');
}, 120_000);

afterAll(async () => {
  await closeDb().catch(() => undefined);
  resetCompanyFileSaveState();
  for (const k of ['BKA_COMPANY_FILE', 'BKA_COMPANY_STATE', 'BKA_COMPANY_LOCK', 'BKA_COMPANY_LOCK_TOKEN']) delete process.env[k];
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best effort on Windows */
  }
});

describe('after someone else saved the company file', () => {
  it('keeps the unsaved changes in one separate copy instead of writing a new copy on every autosave check', async () => {
    await someoneElseSaves('their-save-1');
    const db = await getDb();
    await db.execute(sql`insert into save_probe values (1, 'entered here')`);
    appendLogRecord(process.env.BKA_DATA_DIR!);

    // Far in the future, so the "a save just finished" throttle never hides a save.
    let t = Date.now() + 60 * 60_000;
    expect(await autosaveTick(t)).toBe('waiting');
    t += 10_000;
    expect(await autosaveTick(t)).toBe('saved');
    expect(conflictCopies()).toHaveLength(1);
    const copy = path.join(SHARE, conflictCopies()[0]);
    expect(await rowsIn(copy)).toEqual([1]);
    expect(format.readCompanyManifest(FILE).saveId).toBe('their-save-1');
    expect(getCompanyFileSaveStatus()).toMatchObject({ status: 'error', conflictCopy: copy });
    // What is in the copy is safe: the working copy no longer counts it as unsaved.
    expect(sessionMod.readState(workDir).unsavedSince).toBeNull();

    // Nothing new: the next checks write nothing.
    for (let i = 0; i < 5; i++) {
      t += 20_000;
      expect(await autosaveTick(t)).toBe('idle');
    }
    expect(conflictCopies()).toHaveLength(1);

    // More work here goes into the same copy.
    await db.execute(sql`insert into save_probe values (2, 'more work here')`);
    appendLogRecord(process.env.BKA_DATA_DIR!);
    t += 20_000;
    expect(await autosaveTick(t)).toBe('waiting');
    t += 10_000;
    expect(await autosaveTick(t)).toBe('saved');
    expect(conflictCopies()).toHaveLength(1);
    expect(await rowsIn(copy)).toEqual([1, 2]);
    expect(format.readCompanyManifest(FILE).saveId).toBe('their-save-1');
  }, 180_000);

  it('starts a new copy when the first one was opened (and changed) somewhere else', async () => {
    const [first] = conflictCopies();
    const copy = path.join(SHARE, first);
    const m = format.readCompanyManifest(copy);
    // Someone opened the copy and saved it: it is their file now.
    const other = path.join(ROOT, 'copy-opened-elsewhere');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'PG_VERSION'), '17\n');
    await format.writeCompanyFile(copy, { manifest: { ...m, saveId: 'edited-elsewhere' }, entries: format.snapshotDir(other) });

    const db = await getDb();
    await db.execute(sql`insert into save_probe values (3, 'third')`);
    appendLogRecord(process.env.BKA_DATA_DIR!);
    const r = await saveCompanyFile({ force: true });
    expect(r.outcome).toBe('conflict');
    expect(r.path).not.toBe(copy);
    expect(format.readCompanyManifest(copy).saveId).toBe('edited-elsewhere');
    expect(await rowsIn(r.path!)).toEqual([1, 2, 3]);
  }, 180_000);
});

describe('after another computer took the file over', () => {
  it('still records changes made here as unsaved (the next open keeps them as a copy)', async () => {
    adoptFileOnDisk();
    expect((await saveCompanyFile({ force: true })).outcome).toBe('saved');
    fs.writeFileSync(path.join(lock!.dir, 'owner.json'), JSON.stringify({ token: 'other', computer: 'BACK-OFFICE', appUser: 'Bob' }));
    try {
      // The person presses Save Now after the warning: refused, nothing unsaved yet.
      await expect(saveCompanyFile({ force: true })).rejects.toThrow(/Bob on BACK-OFFICE/);
      expect(getCompanyFileSaveStatus().status).toBe('lost');
      expect(sessionMod.readState(workDir).unsavedSince).toBeNull();

      // …and keeps working in this window.
      const db = await getDb();
      await db.execute(sql`insert into save_probe values (20, 'after the takeover')`);
      appendLogRecord(process.env.BKA_DATA_DIR!);
      expect(await autosaveTick(Date.now() + 60_000)).toBe('idle'); // never saved into their file
      expect(sessionMod.readState(workDir).unsavedSince).toBeTruthy();
      expect(sessionMod.planOpen({
        companyFile: FILE,
        state: sessionMod.readState(workDir),
        manifest: { saveId: 'their-save-after-takeover' },
        dataExists: true,
      })).toBe('conflict');
    } finally {
      fs.writeFileSync(path.join(lock!.dir, 'owner.json'), JSON.stringify({ token: lock!.token, computer: os.hostname() }));
      adoptFileOnDisk();
    }
  }, 180_000);
});

describe('saves asked for while one is running', () => {
  it('run one after another (each continues from the save before it)', async () => {
    adoptFileOnDisk();
    const db = await getDb();
    await db.execute(sql`insert into save_probe values (30, 'x')`);
    let firstSaveId: string | null = null;
    const a = saveCompanyFile({ force: true });
    void a.then(() => {
      firstSaveId = format.readCompanyManifest(FILE).saveId;
    });
    const b = saveCompanyFile({ force: true });
    const c = saveCompanyFile({ force: true });
    const results = await Promise.all([a, b, c]);
    expect(results.map((r) => r.outcome)).toEqual(['saved', 'saved', 'saved']);
    const m = format.readCompanyManifest(FILE);
    expect(firstSaveId).toBeTruthy();
    // Side by side, the second and third saves would both claim to follow the first.
    expect(m.previousSaveId).not.toBe(firstSaveId);
    expect(sessionMod.readState(workDir).base.saveId).toBe(m.saveId);
  }, 180_000);
});

describe('every save records the database layout it holds', () => {
  it('so an older Ironbooks can refuse the file instead of downgrading it', async () => {
    adoptFileOnDisk();
    expect((await saveCompanyFile({ force: true })).outcome).toBe('saved');
    const journal = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'drizzle', 'meta', '_journal.json'), 'utf8'));
    const newest = Math.max(...journal.entries.map((e: { when: number }) => e.when));
    const m = format.readCompanyManifest(FILE);
    expect(m.dbSchema).toMatchObject({ lastMigrationAt: newest });
    expect(m.dbSchema.migrations).toBe(journal.entries.length);
    expect(sessionMod.savedByNewerVersion(m, newest)).toBe(false);
    expect(sessionMod.savedByNewerVersion(m, newest - 1)).toBe(true);
  }, 120_000);
});
