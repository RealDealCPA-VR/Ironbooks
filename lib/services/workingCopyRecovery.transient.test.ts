/**
 * A working copy that fails to START for a passing reason (an antivirus scan holding a file, a
 * moment without memory) is not damaged, and its unsaved work must never be thrown away for it
 * (lib/services/workingCopyRecovery.ts): the start is tried again after a short pause and the
 * books are used as they are. Only when the second start fails too is the copy treated as damaged.
 *
 * PGlite is made to fail the next N starts here, the way a start that hits a busy file does
 * ("Aborted()"), without anything wrong with the folder itself.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { sql } from 'drizzle-orm';

const failStarts = vi.hoisted(() => ({ left: 0, seen: 0 }));
vi.mock('@electric-sql/pglite', async (importOriginal) => {
  const real = await importOriginal<typeof import('@electric-sql/pglite')>();
  const RealPGlite = real.PGlite as unknown as new (...args: unknown[]) => object;
  // Called with `new`: a real PGlite, or (while failures are asked for) one that never starts.
  function PGlite(...args: unknown[]) {
    if (failStarts.left > 0) {
      failStarts.left--;
      failStarts.seen++;
      const err = new Error('Aborted(). Build with -sASSERTIONS for more info.');
      const fake = Object.create(RealPGlite.prototype);
      const failed = Promise.reject(err);
      failed.catch(() => undefined);
      Object.defineProperty(fake, 'waitReady', { value: failed });
      fake.close = async () => undefined;
      return fake;
    }
    return new RealPGlite(...args);
  }
  PGlite.prototype = RealPGlite.prototype;
  return { ...real, PGlite };
});

process.env.BKA_RECOVERY_RETRY_MS = '50';

const require = createRequire(import.meta.url);
const format = require('../../electron/companyFileFormat.js');
const sessionMod = require('../../electron/companySession.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-recover-transient-'));
const FILE = path.join(ROOT, 'share', 'Acme Plumbing.ironbooks');
fs.mkdirSync(path.dirname(FILE), { recursive: true });

import { closeDb, getDb } from '@/lib/db';
import { resetCompanyFileSaveState, saveCompanyFile } from './companyFileSave';
import { recoveryNotice, resetRecoveryState } from './workingCopyRecovery';

let workDir = '';

async function open() {
  const prep = await sessionMod.prepareWorkingCopy(FILE, { root: path.join(ROOT, 'Working') });
  workDir = prep.workDir;
  process.env.BKA_DATA_DIR = prep.dataDir;
  process.env.BKA_COMPANY_FILE = FILE;
  process.env.BKA_COMPANY_STATE = path.join(workDir, 'state.json');
  resetCompanyFileSaveState();
  resetRecoveryState();
  return prep;
}

async function rows(): Promise<number[]> {
  const db = await getDb();
  return ((await db.execute(sql`select id from transient_probe order by id`)).rows as Array<{ id: number }>).map((r) => r.id);
}

const damagedCopies = () => fs.readdirSync(workDir).filter((n) => n.startsWith(sessionMod.DAMAGED_PREFIX));

beforeAll(async () => {
  const seed = path.join(ROOT, 'seed');
  fs.mkdirSync(seed, { recursive: true });
  fs.writeFileSync(path.join(seed, 'bookkeeper-company.json'), JSON.stringify({ schema: 'bookkeeper-company/v1', name: 'Acme Plumbing' }));
  await format.writeCompanyFile(FILE, {
    manifest: { formatVersion: 1, fileId: 'fid-transient', companyName: 'Acme Plumbing', saveId: 'genesis', savedAt: new Date().toISOString() },
    entries: format.snapshotDir(seed),
  });
  await open();
  const db = await getDb();
  await db.execute(sql`create table transient_probe (id int primary key)`);
  await db.execute(sql`insert into transient_probe values (1)`);
  expect(await saveCompanyFile({ force: true })).toMatchObject({ outcome: 'saved' });
  await db.execute(sql`insert into transient_probe values (2)`); // unsaved
  await closeDb(); // the app stops; the folder is fine
}, 180_000);

afterAll(async () => {
  await closeDb().catch(() => undefined);
  resetCompanyFileSaveState();
  resetRecoveryState();
  for (const k of ['BKA_COMPANY_FILE', 'BKA_COMPANY_STATE']) delete process.env[k];
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best effort on Windows */
  }
});

describe('a working copy that fails to start without being damaged', () => {
  it('is started again and used as it is: unsaved work kept, nothing replaced or set aside', async () => {
    await open();
    failStarts.left = 1;
    failStarts.seen = 0;
    expect(await rows()).toEqual([1, 2]);
    expect(failStarts.seen).toBe(1);
    expect(recoveryNotice()).toBeNull();
    expect(damagedCopies()).toEqual([]);
    await closeDb();
  }, 120_000);

  it('is only treated as damaged when the second start fails too', async () => {
    await open();
    failStarts.left = 2;
    failStarts.seen = 0;
    expect(await rows()).toEqual([1]); // reopened from the last save
    expect(failStarts.seen).toBe(2);
    expect(recoveryNotice()).toMatchObject({ changesLost: true });
    expect(damagedCopies()).toHaveLength(1);
    await closeDb();
  }, 120_000);
});
