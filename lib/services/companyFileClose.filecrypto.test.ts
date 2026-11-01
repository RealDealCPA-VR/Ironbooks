/**
 * Closing the single company file (lib/services/companyFileSave.ts closeCompanyFile) when a
 * commit lands while the final save is still writing the file (review round 5 leftover, P2):
 * multi-user clients and the open window keep writing during the final save, which can take
 * seconds over the network. Such a commit used to be only in the working copy, while the close
 * answered "saved" with nothing unsaved — so the next workstation opened the file without it and
 * was never warned. Now the close saves once more after the database is closed (nothing can
 * write any more), so the company file holds every commit.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '@/lib/db';

/** Runs once, inside the final save, after its snapshot was taken (the "late" commit). */
const lateCommit = vi.hoisted(() => ({ run: null as null | (() => Promise<void>) }));
vi.mock('@/electron/companyFileFormat', async (importOriginal) => {
  const mod = (await importOriginal()) as { default: Record<string, unknown> } & Record<string, unknown>;
  const real = (mod.default ?? mod) as { writeCompanyFile: (...a: unknown[]) => Promise<unknown> };
  const wrapped = {
    ...real,
    writeCompanyFile: async (...args: unknown[]) => {
      const fn = lateCommit.run;
      lateCommit.run = null;
      if (fn) await fn();
      return real.writeCompanyFile(...args);
    },
  };
  return { ...wrapped, default: wrapped };
});

import { closeCompanyFile, getCompanyFileSaveStatus, resetCompanyFileSaveState, saveCompanyFile } from './companyFileSave';

const require = createRequire(import.meta.url);
const format = require('../../electron/companyFileFormat.js');
const lockMod = require('../../electron/companyLock.js');
const sessionMod = require('../../electron/companySession.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-close-'));
const SHARE = path.join(ROOT, 'share');
const FILE = path.join(SHARE, 'Late Commit Co.ironbooks');
const WORKING = path.join(ROOT, 'Working');
fs.mkdirSync(SHARE, { recursive: true });
let workDir = '';

async function rowsIn(file: string): Promise<number[]> {
  const out = path.join(ROOT, `open-${Date.now()}`);
  await format.extractCompanyFile(file, out);
  const pg = new PGlite(out);
  try {
    return (await pg.query<{ id: number }>('select id from close_probe order by id')).rows.map((r) => r.id);
  } finally {
    await pg.close();
  }
}

beforeAll(async () => {
  const seed = path.join(ROOT, 'seed');
  fs.mkdirSync(seed, { recursive: true });
  fs.writeFileSync(path.join(seed, 'bookkeeper-company.json'), JSON.stringify({ schema: 'bookkeeper-company/v1', name: 'Late Commit Co' }));
  await format.writeCompanyFile(FILE, {
    manifest: { formatVersion: 2, fileId: 'fid-close', companyName: 'Late Commit Co', saveId: 'genesis', savedAt: new Date().toISOString() },
    entries: format.snapshotDir(seed),
  });
  const lock = lockMod.acquire(FILE, { appUser: 'Mary' }).lock;
  const prep = await sessionMod.prepareWorkingCopy(FILE, { root: WORKING });
  workDir = prep.workDir;
  process.env.BKA_DATA_DIR = prep.dataDir;
  process.env.BKA_COMPANY_FILE = FILE;
  process.env.BKA_COMPANY_STATE = path.join(workDir, 'state.json');
  process.env.BKA_COMPANY_LOCK = lock.dir;
  process.env.BKA_COMPANY_LOCK_TOKEN = lock.token;
  resetCompanyFileSaveState();
  const db = await getDb();
  await db.execute(sql`create table if not exists close_probe (id int primary key)`);
  await db.execute(sql`insert into close_probe values (1)`);
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

describe('closing the company file', () => {
  it('a commit that lands while the final save is writing still reaches the company file', async () => {
    const db = await getDb();
    await db.execute(sql`insert into close_probe values (2)`);
    // While the final save writes the file (its snapshot already taken), someone commits row 3.
    lateCommit.run = async () => {
      await db.execute(sql`insert into close_probe values (3)`);
    };
    const result = await closeCompanyFile();
    expect(lateCommit.run).toBeNull(); // the hook ran inside the final save
    expect(result.outcome).toBe('saved');
    // The company file has every commit, and nothing is left behind as unsaved.
    expect(await rowsIn(FILE)).toEqual([1, 2, 3]);
    expect(getCompanyFileSaveStatus()).toMatchObject({ status: 'saved', unsavedSince: null });
    const st = sessionMod.readState(workDir);
    expect(st.unsavedSince ?? null).toBeNull();
    expect(st.closedCleanly).toBe(true);
    expect(st.base.saveId).toBe(format.readCompanyManifest(FILE).saveId);
  }, 180_000);
});
