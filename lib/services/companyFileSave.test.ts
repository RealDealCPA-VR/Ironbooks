/**
 * Saving the open single-file company file (lib/services/companyFileSave.ts) against a real,
 * migrated company database: a save produces a file that opens with the same books; autosave
 * waits for a quiet moment; a computer that lost the lock never writes; a company file saved by
 * someone else meanwhile is never overwritten (the changes go to a separate copy); closing saves
 * and keeps the database closed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';

const require = createRequire(import.meta.url);
const format = require('../../electron/companyFileFormat.js');
const lockMod = require('../../electron/companyLock.js');
const sessionMod = require('../../electron/companySession.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-save-'));
const SHARE = path.join(ROOT, 'share');
const FILE = path.join(SHARE, 'Acme Plumbing.ironbooks');
const WORKING = path.join(ROOT, 'Working');
fs.mkdirSync(SHARE, { recursive: true });

// A brand-new company file, opened into a working copy like the desktop shell does.
const seedDir = path.join(ROOT, 'seed');
fs.mkdirSync(seedDir, { recursive: true });
fs.writeFileSync(path.join(seedDir, 'bookkeeper-company.json'), JSON.stringify({ schema: 'bookkeeper-company/v1', name: 'Acme Plumbing' }));

let workDir = '';
let lock: { token: string; dir: string; companyFile: string } | null = null;

import { getDb, closeDb, isDbOpen } from '@/lib/db';
import { sql } from 'drizzle-orm';
import {
  autosaveTick,
  closeCompanyFile,
  getCompanyFileSaveStatus,
  resetCompanyFileSaveState,
  saveCompanyFile,
  saveCopyAs,
  SAVE_AFTER_QUIET_MS,
} from './companyFileSave';

function appendLogRecord(dataDir: string, seq: number) {
  fs.appendFileSync(path.join(dataDir, 'transactions.bktlg'), JSON.stringify({ seq, hash: `h${seq}` }) + '\n');
}

beforeAll(async () => {
  await format.writeCompanyFile(FILE, {
    manifest: { formatVersion: 1, fileId: 'fid-1', companyName: 'Acme Plumbing', saveId: 'genesis', savedAt: new Date().toISOString() },
    entries: format.snapshotDir(seedDir),
  });
  const res = lockMod.acquire(FILE, { appUser: 'Mary' });
  lock = res.lock;
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

describe('saving the company file', () => {
  it('saves the working copy into the company file, which opens with the same books', async () => {
    const db = await getDb();
    await db.execute(sql`insert into save_probe values (1, 'first invoice')`);
    const r = await saveCompanyFile({ force: true });
    expect(r).toMatchObject({ saved: true, outcome: 'saved', path: FILE });
    expect(await rowsIn(FILE)).toEqual([1]);
    const m = format.readCompanyManifest(FILE);
    expect(m).toMatchObject({ companyName: 'Acme Plumbing', fileId: 'fid-1', previousSaveId: 'genesis', savedBy: { appUser: 'Mary' } });
    // The working copy now starts from that save (crash recovery bookkeeping).
    expect(sessionMod.readState(workDir)).toMatchObject({ base: { saveId: m.saveId }, unsavedSince: null });
    expect(getCompanyFileSaveStatus()).toMatchObject({ singleFile: true, status: 'saved', path: FILE });
  }, 120_000);

  it('autosave waits for a quiet moment after the books change, then saves', async () => {
    const db = await getDb();
    await db.execute(sql`insert into save_probe values (2, 'second')`);
    appendLogRecord(process.env.BKA_DATA_DIR!, 1); // the books changed (transaction log head moved)
    const t0 = Date.now();
    expect(await autosaveTick(t0)).toBe('waiting');
    expect(getCompanyFileSaveStatus().status).toBe('unsaved');
    expect(sessionMod.readState(workDir).unsavedSince).toBeTruthy(); // a crash now would be recovered
    // (A save that just finished holds the next one back for a moment: 4x its duration.)
    expect(await autosaveTick(t0 + SAVE_AFTER_QUIET_MS + 20_000)).toBe('saved');
    expect(await rowsIn(FILE)).toEqual([1, 2]);
    expect(await autosaveTick(t0 + SAVE_AFTER_QUIET_MS + 60_000)).toBe('idle');
  }, 120_000);

  it('Save Copy As writes an independent company file', async () => {
    const copy = path.join(SHARE, 'Acme copy for the accountant.ironbooks');
    await saveCopyAs(copy);
    const m = format.readCompanyManifest(copy);
    expect(m.fileId).not.toBe('fid-1');
    expect(await rowsIn(copy)).toEqual([1, 2]);
    await expect(saveCopyAs(path.join(SHARE, 'not-a-company.txt'))).rejects.toThrow(/must end in \.ironbooks/);
  }, 120_000);

  it('never overwrites a company file someone else saved meanwhile', async () => {
    // Someone else's save (their own copy of the books) lands in the file.
    const before = format.readCompanyManifest(FILE);
    const theirs = path.join(ROOT, 'theirs');
    fs.mkdirSync(theirs, { recursive: true });
    fs.writeFileSync(path.join(theirs, 'PG_VERSION'), '17\n');
    await format.writeCompanyFile(FILE, {
      manifest: { ...before, saveId: 'someone-else', previousSaveId: before.saveId },
      entries: format.snapshotDir(theirs),
    });
    const db = await getDb();
    await db.execute(sql`insert into save_probe values (3, 'third')`);
    const r = await saveCompanyFile({ force: true });
    expect(r.outcome).toBe('conflict');
    expect(format.readCompanyManifest(FILE).saveId).toBe('someone-else');
    expect(r.path).toMatch(/unsaved changes from/);
    expect(await rowsIn(r.path!)).toEqual([1, 2, 3]);
    expect(getCompanyFileSaveStatus()).toMatchObject({ status: 'error', conflictCopy: r.path });
    // Put things back for the next tests: this working copy now continues from their save.
    sessionMod.writeState(workDir, { base: { saveId: 'someone-else' }, unsavedSince: null });
    resetCompanyFileSaveState();
  }, 120_000);

  it('a computer that lost the lock stops saving', async () => {
    const res = await saveCompanyFile({ force: true });
    expect(res.outcome).toBe('saved');
    // Another workstation took the file over (this one was asleep past the stale time).
    fs.writeFileSync(path.join(lock!.dir, 'owner.json'), JSON.stringify({ token: 'other', computer: 'BACK-OFFICE', appUser: 'Bob' }));
    const savedId = format.readCompanyManifest(FILE).saveId;
    await expect(saveCompanyFile({ force: true })).rejects.toThrow(/Bob on BACK-OFFICE/);
    expect(format.readCompanyManifest(FILE).saveId).toBe(savedId);
    expect(getCompanyFileSaveStatus().status).toBe('lost');
    expect(await autosaveTick()).toBe('idle');
    // Back to us.
    fs.writeFileSync(path.join(lock!.dir, 'owner.json'), JSON.stringify({ token: lock!.token, computer: os.hostname() }));
    resetCompanyFileSaveState();
  }, 120_000);

  it('work done before the save logic first looks is still saved (books and housekeeping)', async () => {
    // Books: the file's own record of its transaction-log head says what is saved.
    const db = await getDb();
    resetCompanyFileSaveState();
    await db.execute(sql`insert into save_probe values (10, 'entered before anyone asked')`);
    appendLogRecord(process.env.BKA_DATA_DIR!, 2);
    const t = Date.now() + 60_000;
    expect(await autosaveTick(t)).toBe('waiting'); // noticed: unsaved
    expect(await autosaveTick(t + 10_000)).toBe('saved'); // the next checks save it
    expect(await rowsIn(FILE)).toContain(10);
    // Housekeeping only (no transaction-log record): the database's position at open says it changed.
    resetCompanyFileSaveState();
    await db.execute(sql`insert into save_probe values (11, 'no log record')`);
    const r = await saveCompanyFile();
    expect(r.outcome).toBe('saved');
    expect(await rowsIn(FILE)).toContain(11);
    resetCompanyFileSaveState();
  }, 120_000);

  it('never saves a sandbox copy the server switched to into the real company file', async () => {
    const realDir = process.env.BKA_DATA_DIR!;
    const practice = path.join(ROOT, 'practice-copy');
    fs.mkdirSync(practice, { recursive: true });
    fs.writeFileSync(path.join(practice, 'PRACTICE_ONLY'), 'x');
    process.env.BKA_DATA_DIR = practice; // what "Try it on a copy" does (switchActiveDataDir)
    try {
      const r = await saveCompanyFile({ force: true });
      expect(r.outcome).toBe('saved');
      const names = format.readCentralDirectory(fs.readFileSync(FILE)).map((e: { name: string }) => e.name);
      expect(names).not.toContain('PRACTICE_ONLY');
      expect(names).toContain('PG_VERSION');
      expect(await rowsIn(FILE)).toContain(1);
    } finally {
      process.env.BKA_DATA_DIR = realDir;
    }
  }, 120_000);

  it('closing saves everything and keeps the database closed', async () => {
    const db = await getDb();
    await db.execute(sql`insert into save_probe values (4, 'last one')`);
    const r = await closeCompanyFile();
    expect(r.saved).toBe(true);
    expect(isDbOpen()).toBe(false);
    expect(await rowsIn(FILE)).toEqual([1, 2, 3, 4, 10, 11]);
    expect(sessionMod.readState(workDir)).toMatchObject({ unsavedSince: null, closedCleanly: true });
  }, 120_000);
});
