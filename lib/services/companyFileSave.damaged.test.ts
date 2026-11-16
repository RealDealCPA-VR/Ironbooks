/**
 * Books whose ledger was found damaged when they opened (lib/db/index.ts: handle.damage, which
 * getDb refuses for normal work) are never saved over the company file — not by the autosave, not
 * by the save on close. The company file keeps its last good save; the changes stay recorded as
 * unsaved on this computer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { sql } from 'drizzle-orm';
import { closeDb, getDb, openDb } from '@/lib/db';
import { getCompanyFileSaveStatus, resetCompanyFileSaveState, saveCompanyFile } from './companyFileSave';

const require = createRequire(import.meta.url);
const format = require('../../electron/companyFileFormat.js');
const lockMod = require('../../electron/companyLock.js');
const sessionMod = require('../../electron/companySession.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-save-damaged-'));
const SHARE = path.join(ROOT, 'share');
const FILE = path.join(SHARE, 'Damaged Co.ironbooks');
const WORKING = path.join(ROOT, 'Working');
let workDir = '';

beforeAll(async () => {
  fs.mkdirSync(SHARE, { recursive: true });
  const seed = path.join(ROOT, 'seed');
  fs.mkdirSync(seed, { recursive: true });
  fs.writeFileSync(path.join(seed, 'bookkeeper-company.json'), JSON.stringify({ schema: 'bookkeeper-company/v1', name: 'Damaged Co' }));
  await format.writeCompanyFile(FILE, {
    manifest: { formatVersion: 1, fileId: 'fid-dmg', companyName: 'Damaged Co', saveId: 'genesis', savedAt: new Date().toISOString() },
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
  await db.execute(sql`create table if not exists dmg_probe (id int primary key)`);
  expect(await saveCompanyFile({ force: true })).toMatchObject({ outcome: 'saved' });
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

describe('saving books found damaged', () => {
  it('never writes them over the company file, and says so', async () => {
    const db = await getDb();
    await db.execute(sql`insert into dmg_probe values (1)`);
    const good = format.readCompanyManifest(FILE).saveId;
    // The ledger check found damage when the books opened.
    const handle = openDb();
    handle.damage = [{ kind: 'unbalanced-entry', detail: 'Entry 7 does not balance.' } as never];

    await expect(saveCompanyFile({ force: true })).rejects.toMatchObject({ code: 'LEDGER_DAMAGED' });
    await expect(saveCompanyFile({ final: true })).rejects.toMatchObject({ code: 'LEDGER_DAMAGED' });
    expect(format.readCompanyManifest(FILE).saveId).toBe(good);
    expect(getCompanyFileSaveStatus()).toMatchObject({ status: 'error' });
    expect(getCompanyFileSaveStatus().error).toMatch(/not saving them over the company file/);
    // Still recorded as unsaved on this computer.
    expect(sessionMod.readState(workDir).unsavedSince).toBeTruthy();

    // Healthy books (a good backup restored) are saved again.
    handle.damage = null;
    expect(await saveCompanyFile({ force: true })).toMatchObject({ outcome: 'saved' });
    expect(format.readCompanyManifest(FILE).saveId).not.toBe(good);
  }, 120_000);
});
