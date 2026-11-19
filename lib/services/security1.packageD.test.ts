/**
 * Security plan, smaller items of package D:
 *
 *  - Sandbox source record: a sandbox made by an earlier version has no record of where it came
 *    from, so leaving it for a real company file on a network or mapped drive was refused. The
 *    desktop shell knows (config.sandbox) and now tells the server it started on that very copy
 *    (BKA_SANDBOX_DIR + BKA_SANDBOX_REAL_DIR): that record is this computer's word for it. Without
 *    one, a network path is still never taken on a marker's word.
 *  - Key slots in the database: a sign-in tried every matching slot stored there, with no limit
 *    (each costs up to seconds of scrypt) — a crafted file can drop the index that keeps one per
 *    kind and user. Now at most fileCrypto.MAX_SLOT_TRIES, like the company file's own slot list
 *    (batch 1).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { sql } from 'drizzle-orm';

process.env.BKA_TEST_FAST_KDF = '1';

import { closeDb, getDb, type DB } from '@/lib/db';
import { fileKeySlots, fileProtection, users } from '@/lib/db/schema';
import { setMappedDrivesForTests } from './backupHistory';
import { SANDBOX_MARKER_SCHEMA, type SandboxMarker } from './sandboxState';
import { realDataDirHere } from './sandbox';
import { forgetFileKeys, loadKeyFromChallenge, loadKeyFromPassword } from './fileProtection';

const require = createRequire(import.meta.url);
const fileCrypto = require('../../electron/fileCrypto.js');
const nodeCrypto = require('node:crypto') as typeof import('node:crypto');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-sec1-pkgd-'));
const ENV = ['BKA_SANDBOX_DIR', 'BKA_SANDBOX_REAL_DIR', 'BKA_SANDBOX_ROOT'] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

afterEach(() => {
  setMappedDrivesForTests(null);
  vi.restoreAllMocks();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

afterAll(() => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* Windows may still hold a handle */
  }
});

describe("the shell's sandbox record", () => {
  // A real company file on a network drive: \\server\share on every platform, plus a mapped drive on Windows.
  const onShare = process.platform === 'win32' ? '\\\\office-nas\\books\\Acme.ironbooks\\data' : '//office-nas/books/Acme.ironbooks/data';
  const mapped = process.platform === 'win32' ? 'Z:\\Books\\Acme.ironbooks\\data' : null;
  const sandboxDir = path.join(ROOT, 'old-version-sandbox', 'data');
  const marker = (realDataDir: string) => ({ schema: SANDBOX_MARKER_SCHEMA, kind: 'sandbox', realDataDir, sourceName: 'Acme', createdAt: '' }) as SandboxMarker;

  it('a network path with the record for this copy: taken (the shell made the copy from it)', () => {
    if (mapped) setMappedDrivesForTests(['Z']);
    for (const real of [onShare, ...(mapped ? [mapped] : [])]) {
      process.env.BKA_SANDBOX_DIR = sandboxDir;
      process.env.BKA_SANDBOX_REAL_DIR = real;
      expect(realDataDirHere(marker(real), sandboxDir), real).toBe(path.resolve(real));
      // The marker must name exactly the recorded file.
      expect(realDataDirHere(marker(path.join(ROOT, 'elsewhere')), sandboxDir)).toBeNull();
    }
  });

  it('no record, or a record for another copy: a network path is never taken', () => {
    if (mapped) setMappedDrivesForTests(['Z']);
    for (const real of [onShare, ...(mapped ? [mapped] : [])]) {
      delete process.env.BKA_SANDBOX_DIR;
      delete process.env.BKA_SANDBOX_REAL_DIR;
      expect(realDataDirHere(marker(real), sandboxDir), real).toBeNull();
      process.env.BKA_SANDBOX_DIR = path.join(ROOT, 'another-sandbox', 'data');
      process.env.BKA_SANDBOX_REAL_DIR = real;
      expect(realDataDirHere(marker(real), sandboxDir), real).toBeNull();
      // Half a record, or a relative one, is no record.
      process.env.BKA_SANDBOX_DIR = sandboxDir;
      delete process.env.BKA_SANDBOX_REAL_DIR;
      expect(realDataDirHere(marker(real), sandboxDir)).toBeNull();
      process.env.BKA_SANDBOX_REAL_DIR = 'relative/books';
      expect(realDataDirHere(marker(real), sandboxDir)).toBeNull();
    }
    // A local real file without a record: as before (taken).
    const local = path.join(ROOT, 'local-real');
    expect(realDataDirHere(marker(local), sandboxDir)).toBe(path.resolve(local));
  });
});

describe('key slots tried from the database', () => {
  const DIR = path.join(ROOT, 'slots-db');
  let db: DB;
  let userId: string;
  const PASSWORD = 'Right-Password-1';

  beforeAll(async () => {
    db = await getDb(DIR);
    const [u] = await db.insert(users).values({ email: 'slots@test.local', name: 'Slots', passwordHash: 'x' }).returning();
    userId = u.id;
    const key = fileCrypto.generateFileKey();
    await db.insert(fileProtection).values({ id: 1, keyCheck: fileCrypto.keyCheckOf(key), lookupSalt: 'salt' });
    // Hundreds of slots under one user: only a crafted database holds them (it dropped the index
    // that keeps one per kind and user), the real one last.
    const junk = await fileCrypto.makeSlot({ kind: 'password', secret: 'not-it-0000', fileKey: fileCrypto.generateFileKey(), tag: 't' });
    const junkChallenge = await fileCrypto.makeSlot({ kind: 'challenge', secret: 'not it at all', fileKey: fileCrypto.generateFileKey(), tag: 't', question: 'q' });
    await db.execute(sql`DROP INDEX IF EXISTS "file_key_slots_user_kind_idx"`);
    const rows = [];
    for (let i = 0; i < 300; i++) rows.push({ kind: 'password' as const, userId, slot: junk });
    for (let i = 0; i < 300; i++) rows.push({ kind: 'challenge' as const, userId, slot: junkChallenge });
    await db.insert(fileKeySlots).values(rows);
    await db.insert(fileKeySlots).values({ kind: 'password', userId, slot: await fileCrypto.makeSlot({ kind: 'password', secret: PASSWORD, fileKey: key, tag: 't' }) });
  }, 120_000);

  afterAll(async () => {
    forgetFileKeys();
    await closeDb(DIR).catch(() => undefined);
  });

  it(`a sign-in tries at most ${fileCrypto.MAX_SLOT_TRIES} slots per kind and user`, async () => {
    // Each slot tried is one scrypt run (the cost a crafted file multiplies).
    const tried = vi.spyOn(nodeCrypto, 'scrypt');
    expect(await loadKeyFromPassword(db, DIR, userId, 'wrong-password')).toBe(false);
    expect(tried.mock.calls.length).toBeGreaterThan(0);
    expect(tried.mock.calls.length).toBeLessThanOrEqual(fileCrypto.MAX_SLOT_TRIES);
    tried.mockClear();
    expect(await loadKeyFromChallenge(db, DIR, userId, 'some answer here')).toBe(false);
    expect(tried.mock.calls.length).toBeGreaterThan(0);
    expect(tried.mock.calls.length).toBeLessThanOrEqual(fileCrypto.MAX_SLOT_TRIES);
    expect(fileCrypto.MAX_SLOT_TRIES).toBe(4);
  }, 120_000);
});
