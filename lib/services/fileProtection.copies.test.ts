/**
 * Every copy of the books of a protected company file is protected the same way (filecrypto):
 *   Save Copy As · backups (.bka) · a backup of another protected file needs that file's user
 *   name + password or recovery key · "Try it on a copy" and the training file kept from it ·
 *   closing the real file while the sandbox runs keeps its working copy (the sandbox comes back to it).
 * Each copy is checked on disk: encrypted (no customer name in its bytes), and opened only by the
 * file's own secrets.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';

vi.mock('next/headers', () => {
  const g = globalThis as typeof globalThis & { __fpJar?: { cookies: Map<string, string>; headers: Map<string, string> } };
  const j = (g.__fpJar ??= { cookies: new Map(), headers: new Map() });
  return {
    cookies: async () => ({ get: (n: string) => (j.cookies.has(n) ? { name: n, value: j.cookies.get(n)! } : undefined) }),
    headers: async () => new Headers([...j.headers.entries()]),
  };
});

process.env.BKA_TEST_FAST_KDF = '1';
delete process.env.BKA_AUTH_SECRET;
process.env.BKA_OFFLINE = '1';

import { getDb, resolveDataDir, type DB } from '@/lib/db';
import { userSessions } from '@/lib/db/schema';
import { fullAccess } from '@/lib/permissions/model';
import { POST as signupPOST } from '@/app/api/auth/signup/route';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { closeCompanyFile, saveCompanyFile, saveCopyAs } from './companyFileSave';
import { createBackup, openBackupBuffer, restoreBackup } from './backup';
import { createCustomer } from './customers';
import { fileKeyFor } from './fileProtection';
import { keepSandboxAsTraining, readSandboxMarker, startSandbox } from './sandbox';
import { apiRequest, fileCrypto, fileOpensWith, format, keepCookies, newCompanyFile, openOn, quit, resetLimiters, sessionMod } from './fileProtection.fixture';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-copies-'));
const SHARE = path.join(ROOT, 'share');
const FILE = path.join(SHARE, 'Copper Kettle.ironbooks');
const PC = path.join(ROOT, 'pc');
const CUSTOMER = 'Xanthippe Wolstencroft Ltd';
let db: DB;
let companyId = '';
let admin = '';
let sessionId = '';
let realWork = '';

const ctx = () => ({ db, companyId, userId: admin, sessionId, role: 'owner' as const, access: fullAccess() });

function plainTextIn(file: string, needle: string): boolean {
  return fs.readFileSync(file).includes(Buffer.from(needle));
}

beforeAll(async () => {
  process.env.BKA_SANDBOX_ROOT = path.join(PC, 'sandboxes');
  await newCompanyFile(FILE, 'Copper Kettle');
  realWork = (await openOn(FILE, PC, 'launch-copies')).workDir;
  process.env.BKA_REAL_COMPANY_FILE = FILE;
  const res = await signupPOST(
    apiRequest('POST', '/api/auth/signup', { name: 'Cleo Admin', email: 'cleo', password: 'Kettle-Pass-01', companyName: 'Copper Kettle', challengeQuestion: 'Name of your first pet', challengeAnswer: 'Pip' }),
  );
  expect(res.status).toBe(201);
  keepCookies(res);
  const body = await res.json();
  companyId = body.companyId;
  admin = body.id;
  db = await getDb();
  [{ id: sessionId }] = await db.select({ id: userSessions.id }).from(userSessions).where(eq(userSessions.userId, admin));
  await createCustomer({ db, companyId, userId: admin }, { displayName: CUSTOMER } as Parameters<typeof createCustomer>[1]);
  expect((await saveCompanyFile({ force: true })).encrypted).toBe(true);
}, 180_000);

afterAll(async () => {
  await quit();
  delete process.env.BKA_REAL_COMPANY_FILE;
  delete process.env.BKA_SANDBOX_ROOT;
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('every copy of a protected company file is protected the same way', () => {
  it('Save Copy As writes an encrypted copy that opens with the same user name and password', async () => {
    const target = path.join(SHARE, 'Copper Kettle copy.ironbooks');
    const r = await saveCopyAs(target);
    expect(r.encrypted).toBe(true);
    expect(format.isSealedManifest(format.readCompanyManifest(target))).toBe(true);
    expect(plainTextIn(target, CUSTOMER)).toBe(false);
    expect(await fileOpensWith(target, 'password', 'Kettle-Pass-01', 'cleo')).toBe(true);
    expect(await fileOpensWith(target, 'password', 'wrong-pass', 'cleo')).toBe(false);
  }, 60_000);

  it('a backup is encrypted, and restores into its own file without a question', async () => {
    const { buffer, encrypted } = createBackup('Copper Kettle');
    expect(encrypted).toBe(true);
    expect(buffer.includes(Buffer.from(CUSTOMER))).toBe(false);
    const head = format.readArchiveHead(buffer);
    expect(format.isSealedManifest(head.manifest)).toBe(true);
    const r = await restoreBackup(buffer);
    expect(r).toBeTruthy();
    db = await getDb();
    // Still protected, still saved encrypted.
    expect((await saveCompanyFile({ force: true })).encrypted).toBe(true);
    expect(await fileOpensWith(FILE, 'password', 'Kettle-Pass-01', 'cleo')).toBe(true);
  }, 120_000);

  it("a backup sealed with another file's key opens only with that file's user name + password or recovery key", async () => {
    const otherKey = fileCrypto.generateFileKey();
    const lookupSalt = fileCrypto.newLookupSalt();
    const tag = fileCrypto.lookupTag(lookupSalt, 'otto');
    const recovery = fileCrypto.generateRecoveryKey();
    const slots = [
      await fileCrypto.makeSlot({ kind: 'password', secret: 'Otto-Pass-77', fileKey: otherKey, tag }),
      await fileCrypto.makeSlot({ kind: 'recovery', secret: fileCrypto.normalizeRecoveryKey(recovery), fileKey: otherKey }),
    ];
    const entries = format.snapshotDir(resolveDataDir()).filter((e: { name: string }) => !['.auth-secret', '.file-id', '.ironbooks-protected'].includes(e.name));
    const buffer = format.buildBackupArchive({
      backupManifest: { app: 'bookkeeper-ai', formatVersion: 2, kind: 'full', companyName: 'Other Co', createdAt: new Date().toISOString() },
      entries,
      protection: { fileKey: otherKey, keyCheck: fileCrypto.keyCheckOf(otherKey), lookupSalt, slots },
    });
    await expect(openBackupBuffer(buffer)).rejects.toMatchObject({ code: 'FORBIDDEN', details: { credentialsRequired: true } });
    await expect(openBackupBuffer(buffer, { credentials: { login: 'otto', password: 'nope' } })).rejects.toMatchObject({
      details: { wrongCredentials: true },
    });
    const byPassword = await openBackupBuffer(buffer, { credentials: { login: 'otto', password: 'Otto-Pass-77' } });
    expect(byPassword.key?.equals(otherKey)).toBe(true);
    const byRecovery = await openBackupBuffer(buffer, { credentials: { recoveryKey: recovery.toLowerCase() } });
    expect(byRecovery.key?.equals(otherKey)).toBe(true);
  }, 120_000);

  it('the sandbox copy shares the file key, and the training file kept from it is one encrypted company file', async () => {
    resetLimiters();
    const realKey = fileKeyFor();
    expect(realKey).not.toBeNull();
    const started = await startSandbox(ctx());
    expect(fileKeyFor(started.dir)?.equals(realKey!)).toBe(true);
    db = await getDb();
    const kept = await keepSandboxAsTraining({ ...ctx(), db }, 'Kettle Practice');
    expect(kept.warning).toBeUndefined();
    const training = kept.trainingDir!;
    expect(fs.statSync(training).isFile()).toBe(true); // a single file, not a folder of plain-text books
    const m = format.readCompanyManifest(training);
    expect(format.isSealedManifest(m)).toBe(true);
    expect(m.training).toBe(true);
    expect(m.fileId).not.toBe(format.readCompanyManifest(FILE).fileId);
    expect(plainTextIn(training, CUSTOMER)).toBe(false);
    expect(await fileOpensWith(training, 'password', 'Kettle-Pass-01', 'cleo')).toBe(true);
    db = await getDb();
  }, 180_000);

  it('the training file opens on its own with one sign-in, and is a training file again', async () => {
    const training = path.join(SHARE, 'Kettle Practice.ironbooks');
    // Quitting while a sandbox runs (the shell relaunches into the copy): the real file is saved
    // and its working copy stays, since leaving the sandbox comes back to it.
    await startSandbox(ctx());
    const closed = await closeCompanyFile();
    expect(closed.workingCopyRemoved).toBeUndefined();
    expect(fs.existsSync(path.join(sessionMod.dataDirOf(realWork), 'PG_VERSION'))).toBe(true);
    await quit();
    const opened = await openOn(training, path.join(ROOT, 'pc-2'), 'launch-training');
    expect(opened.sealed).toBe('extract');
    const res = await loginPOST(apiRequest('POST', '/api/auth/login', { email: 'cleo', password: 'Kettle-Pass-01' }));
    expect(res.status).toBe(200);
    expect(readSandboxMarker()?.kind).toBe('training');
    // Its saves stay protected and keep saying it is a training file.
    const saved = await saveCompanyFile({ force: true });
    expect(saved.encrypted).toBe(true);
    expect(format.readCompanyManifest(training).training).toBe(true);
    await closeCompanyFile();
    await quit();
    expect(fs.existsSync(sessionMod.dataDirOf(opened.workDir))).toBe(false);
  }, 180_000);
});
