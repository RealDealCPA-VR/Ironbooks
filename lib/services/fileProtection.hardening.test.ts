/**
 * Post-merge fixes of "the password belongs to the company file" (filecrypto review on main):
 *  - Period Copy of a protected company file works, is encrypted (a password is required), never
 *    carries the file's own key, and the restored copy opens with the same user names, passwords
 *    and recovery key — while its work folder stays beside the working copy and is removed;
 *  - plain-text copies of a protected file are refused (portable file, Accountant's Copy);
 *  - the file key changes when a user is deactivated, a password is reset, or an Admin asks:
 *    nobody still allowed in is locked out, while the removed user, the replaced password and an
 *    OLDER copy of the file (with its old key) open nothing saved afterwards;
 *  - a short challenge answer gets no key slot (it could be guessed offline from a copy);
 *  - a reused working copy checks the file's plain listing against its encrypted contents;
 *  - sandboxes live next to the working copies, and a protected file's leftover sandbox copies
 *    are removed when it is closed cleanly.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { and, eq } from 'drizzle-orm';

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

import { closeDb, getDb, resolveDataDir, type DB } from '@/lib/db';
import { accounts, fileKeySlots, userSessions, users } from '@/lib/db/schema';
import { fullAccess } from '@/lib/permissions/model';
import { hashPassword } from '@/lib/auth';
import { normalizeChallengeAnswer } from '@/lib/challengeQuestions';
import { POST as signupPOST } from '@/app/api/auth/signup/route';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { closeCompanyFile, saveCompanyFile, saveCopyAs } from './companyFileSave';
import { restoreBackup } from './backup';
import fileCryptoEsm from '@/electron/fileCrypto';
import { createCustomer } from './customers';
import { createManualEntry } from './journal';
import { addUser, resetUserPassword, updateUser } from './users';
import { createPeriodCopy } from './periodCopy';
import { restorePortableCompanyFile, unlockPortableBuffer } from './portableFile';
import { createAccountantCopy } from './accountantCopy/client';
import { changeFileKey, fileKeyFor, fileKeyRotationPending, protectionStatus, refreshSlotAtSignIn, requestFileKeyRotation, rotateFileKey, syncChallengeSlot, syncPasswordSlot } from './fileProtection';
import { readSandboxMarker, startSandbox, switchActiveDataDir } from './sandbox';
import { apiRequest, fileCrypto, fileOpensWith, format, keepCookies, newCompanyFile, openOn, quit, resetLimiters, sessionMod } from './fileProtection.fixture';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-fp-hard-'));
const SHARE = path.join(ROOT, 'share');
const FILE = path.join(SHARE, 'Copper Kettle.ironbooks');
const PC = path.join(ROOT, 'pc');
const PC2 = path.join(ROOT, 'pc-2');
const CUSTOMER = 'Xanthippe Wolstencroft Ltd';
const PW = 'Kettle-Pass-01';
let db: DB;
let companyId = '';
let admin = '';
let sessionId = '';
let recoveryKey = '';
let workDir = '';

const ctx = () => ({ db, companyId, userId: admin, sessionId, role: 'owner' as const, access: fullAccess() });

const keyCheckNow = () => fileCrypto.keyCheckOf(fileKeyFor()!);

beforeAll(async () => {
  process.env.BKA_SANDBOX_ROOT = path.join(PC, 'Sandboxes');
  await newCompanyFile(FILE, 'Copper Kettle');
  workDir = (await openOn(FILE, PC, 'launch-hardening')).workDir;
  const res = await signupPOST(
    apiRequest('POST', '/api/auth/signup', { name: 'Cleo Admin', email: 'cleo', password: PW, companyName: 'Copper Kettle', challengeQuestion: 'Name of your first pet', challengeAnswer: 'Pip' }),
  );
  expect(res.status).toBe(201);
  keepCookies(res);
  const body = await res.json();
  companyId = body.companyId;
  admin = body.id;
  recoveryKey = body.recoveryKey;
  expect(recoveryKey).toBeTruthy();
  db = await getDb();
  [{ id: sessionId }] = await db.select({ id: userSessions.id }).from(userSessions).where(eq(userSessions.userId, admin));
  await createCustomer({ db, companyId, userId: admin }, { displayName: CUSTOMER } as Parameters<typeof createCustomer>[1]);
  const acct = Object.fromEntries((await db.select().from(accounts).where(eq(accounts.companyId, companyId))).map((a) => [a.code, a.id]));
  const je = (date: string, amount: string, description: string) => ({
    date: new Date(`${date}T12:00:00.000Z`),
    description,
    lines: [
      { accountId: acct['1000'], debit: amount },
      { accountId: acct['3000'], credit: amount },
    ],
  });
  // Activity before the period (condensed into opening balances) and inside it.
  await createManualEntry(ctx(), je('2025-06-15', '250.00', 'Owner investment before the period') as never);
  await createManualEntry(ctx(), je('2026-02-10', '100.00', 'Owner investment in the period') as never);
  expect((await saveCompanyFile({ force: true })).encrypted).toBe(true);
}, 180_000);

afterAll(async () => {
  await quit();
  delete process.env.BKA_SANDBOX_ROOT;
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('Period Copy of a protected company file', () => {
  it('is refused without a password (a copy of protected books is protected too)', async () => {
    await expect(createPeriodCopy(ctx(), { from: '2026-01-01', to: '2026-12-31' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('works, is encrypted, never carries the file key, and the restored copy opens with the same password and recovery key', async () => {
    const tmpBefore = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('ironbooks-period-copy-')));
    const res = await createPeriodCopy(ctx(), { from: '2026-01-01', to: '2026-12-31', password: 'Period-Pass-123' });
    expect(res.summary.condensed?.entries ?? 0).toBeGreaterThan(0); // the protected copy's Condense step ran
    expect(res.summary.passwordProtected).toBe(true);
    expect(res.summary.protectedLikeOriginal).toBe(true);
    // Encrypted on disk: no customer or company name anywhere in it.
    expect(fileCrypto.isPasswordSealed(res.buffer)).toBe(true);
    expect(res.buffer.includes(Buffer.from(CUSTOMER))).toBe(false);
    expect(res.buffer.includes(Buffer.from('Owner investment'))).toBe(false);
    // Its plain-text work folder was beside the working copy (never the shared temp folder), and is gone.
    expect(fs.readdirSync(workDir).filter((n) => n.startsWith('data.period-copy-'))).toEqual([]);
    expect(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('ironbooks-period-copy-') && !tmpBefore.has(n))).toEqual([]);

    // Opened with its password: it carries the COPY's own key, never this file's.
    await expect(unlockPortableBuffer(res.buffer, 'wrong-password')).rejects.toMatchObject({ details: { wrongPassword: true } });
    const plain = await unlockPortableBuffer(res.buffer, 'Period-Pass-123');
    const carried = JSON.parse(new AdmZip(plain).readAsText('file-key.json'));
    expect(carried.v).toBe(2);
    expect(carried.keyCheck).not.toBe(keyCheckNow());
    expect(Buffer.from(carried.fileKey, 'base64').equals(fileKeyFor()!)).toBe(false);

    // Restored on another computer: protected again, with the copy's key and the same secrets.
    const target = path.join(ROOT, 'auditor', 'Copper Kettle period');
    const restored = await restorePortableCompanyFile(plain, target);
    expect(restored.protected).toBe(true);
    const copyKey = fileKeyFor(target)!;
    expect(fileCrypto.keyCheckOf(copyKey)).toBe(carried.keyCheck);
    const rdb = await getDb(target);
    try {
      const [mine] = await rdb.select().from(fileKeySlots).where(and(eq(fileKeySlots.kind, 'password'), eq(fileKeySlots.userId, admin)));
      expect((await fileCrypto.openSlot(mine.slot, PW))?.equals(copyKey)).toBe(true);
      const [rec] = await rdb.select().from(fileKeySlots).where(eq(fileKeySlots.kind, 'recovery'));
      expect((await fileCrypto.openSlot(rec.slot, fileCrypto.normalizeRecoveryKey(recoveryKey)))?.equals(copyKey)).toBe(true);
      // The copy's slots never open the original file's key.
      expect((await fileCrypto.openSlot(mine.slot, PW))?.equals(fileKeyFor()!)).toBe(false);
    } finally {
      await closeDb(target);
    }
  }, 180_000);

  it("an Accountant's Copy of a protected file is refused without a password", async () => {
    await expect(createAccountantCopy(ctx(), { dividingDate: '2025-12-31', password: null })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('the file key changes when a secret stops opening the file', () => {
  let bob = '';
  let carol = '';
  const oldCopy = path.join(ROOT, 'usb', 'Copper Kettle (old copy).ironbooks');

  it('deactivating a user: at the next save they open nothing new; everyone else still opens the file', async () => {
    bob = (await addUser(ctx(), { name: 'Bob Clerk', login: 'bob', password: 'Bob-Pass-0001', roleKeys: ['ar_clerk'] })).userId;
    carol = (await addUser(ctx(), { name: 'Carol Clerk', login: 'carol', password: 'Carol-Pass-001', roleKeys: ['ar_clerk'] })).userId;
    await saveCompanyFile({ force: true });
    expect(await fileOpensWith(FILE, 'password', 'Bob-Pass-0001', 'bob')).toBe(true);
    // Bob keeps a copy of the file as it is today (a USB stick, an old backup).
    fs.mkdirSync(path.dirname(oldCopy), { recursive: true });
    fs.copyFileSync(FILE, oldCopy);
    const oldKey = fileKeyFor()!;

    await updateUser(ctx(), bob, { isActive: false });
    expect(fileKeyRotationPending()).toBe(true);
    await saveCompanyFile({ force: true });
    expect(fileKeyRotationPending()).toBe(false);
    const newKey = fileKeyFor()!;
    expect(newKey.equals(oldKey)).toBe(false);
    const m = format.readCompanyManifest(FILE);
    expect(m.encryption.keyCheck).toBe(fileCrypto.keyCheckOf(newKey));

    // Bob's password no longer opens the file; Cleo, Carol and the recovery key still do (no re-entry).
    expect(await fileOpensWith(FILE, 'password', 'Bob-Pass-0001', 'bob')).toBe(false);
    expect(await fileOpensWith(FILE, 'password', PW, 'cleo')).toBe(true);
    expect(await fileOpensWith(FILE, 'password', 'Carol-Pass-001', 'carol')).toBe(true);
    expect(await fileOpensWith(FILE, 'recovery', fileCrypto.normalizeRecoveryKey(recoveryKey))).toBe(true);

    // The old copy still opens with Bob's password — to the OLD key, which opens nothing saved since.
    const oldM = format.readCompanyManifest(oldCopy);
    const bobsKey = await fileCrypto.unlockWith(oldM.encryption, { kind: 'password', login: 'bob', secret: 'Bob-Pass-0001' });
    expect(bobsKey?.equals(oldKey)).toBe(true);
    const out = path.join(ROOT, 'bob-tries');
    await expect(format.extractCompanyFile(FILE, out, { fileKey: bobsKey })).rejects.toMatchObject({ code: 'TAMPERED' });
    expect(fs.existsSync(out) ? fs.readdirSync(out) : []).toEqual([]);
  }, 120_000);

  it('an Admin resetting a password: the old password opens nothing new, the new one does', async () => {
    const before = keyCheckNow();
    resetLimiters();
    await resetUserPassword(ctx(), carol, 'Carol-Pass-002');
    await saveCompanyFile({ force: true });
    expect(keyCheckNow()).not.toBe(before);
    expect(await fileOpensWith(FILE, 'password', 'Carol-Pass-001', 'carol')).toBe(false);
    expect(await fileOpensWith(FILE, 'password', 'Carol-Pass-002', 'carol')).toBe(true);
    expect(await fileOpensWith(FILE, 'password', PW, 'cleo')).toBe(true);
  }, 120_000);

  it('Change the File Key (Company > Security): a new key now, nobody locked out, the recovery key kept', async () => {
    const before = keyCheckNow();
    await expect(changeFileKey({ db, userId: admin }, { password: 'wrong' })).rejects.toMatchObject({ details: { wrongPassword: true } });
    const r = await changeFileKey({ db, userId: admin }, { password: PW });
    expect(r).toMatchObject({ rotated: true, recoveryKept: true });
    expect(keyCheckNow()).not.toBe(before);
    await saveCompanyFile({ force: true });
    expect(format.readCompanyManifest(FILE).encryption.keyCheck).toBe(keyCheckNow());
    expect(await fileOpensWith(FILE, 'password', PW, 'cleo')).toBe(true);
    expect(await fileOpensWith(FILE, 'password', 'Carol-Pass-002', 'carol')).toBe(true);
    expect(await fileOpensWith(FILE, 'recovery', fileCrypto.normalizeRecoveryKey(recoveryKey))).toBe(true);
  }, 120_000);
});

describe('round 2: slot writes and key changes', () => {
  it('a slot made while an autosave changes the file key still opens the file (no lockout)', async () => {
    const dana = (await addUser(ctx(), { name: 'Dana Clerk', login: 'dana', password: 'Dana-Pass-0001', roleKeys: ['ar_clerk'] })).userId;
    await db.delete(fileKeySlots).where(eq(fileKeySlots.userId, dana)); // as if she never signed in here
    const realMake = fileCryptoEsm.makeSlot;
    let changedDuring = false;
    // The key changes (an autosave applying a pending rotation) while her slot's scrypt runs.
    const spy = vi.spyOn(fileCryptoEsm, 'makeSlot').mockImplementation(async (o: Parameters<typeof realMake>[0]) => {
      const slot = await realMake(o);
      changedDuring = (await rotateFileKey(db, { force: true })).rotated;
      return slot;
    });
    try {
      const [u] = await db.select().from(users).where(eq(users.id, dana));
      expect(await refreshSlotAtSignIn(db, { id: dana, passwordHash: u.passwordHash! }, 'Dana-Pass-0001')).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(changedDuring).toBe(true);
    await saveCompanyFile({ force: true });
    expect(await fileOpensWith(FILE, 'password', 'Dana-Pass-0001', 'dana')).toBe(true);
    // And the next key change keeps her (her slot is bound to the current key).
    await changeFileKey({ db, userId: admin }, { password: PW });
    await saveCompanyFile({ force: true });
    expect(await fileOpensWith(FILE, 'password', 'Dana-Pass-0001', 'dana')).toBe(true);
  }, 120_000);

  it('a slot made by the first protected build is not dropped by an automatic key change: the change waits until it is re-made', async () => {
    const erin = (await addUser(ctx(), { name: 'Erin Clerk', login: 'erin', password: 'Erin-Pass-0001', roleKeys: ['ar_clerk'] })).userId;
    // Her slot as the first protected build made it (no public key).
    const nodeCrypto = await import('node:crypto');
    const key = fileKeyFor()!;
    const salt = nodeCrypto.randomBytes(16).toString('base64url');
    const kdf = fileCrypto.currentKdf();
    const kek = nodeCrypto.scryptSync('Erin-Pass-0001', Buffer.from(salt, 'base64url'), 32, { N: kdf.N, r: kdf.r, p: kdf.p });
    const nonce = nodeCrypto.randomBytes(12);
    const c = nodeCrypto.createCipheriv('aes-256-gcm', kek, nonce);
    c.setAAD(Buffer.from(`ironbooks-slot/v1\npassword\n${salt}`, 'utf8'));
    const wrapped = Buffer.concat([c.update(key), c.final(), c.getAuthTag()]);
    await db.update(fileKeySlots).set({ slot: { kind: 'password', kdf: { ...kdf }, salt, nonce: nonce.toString('base64url'), wrapped: wrapped.toString('base64url') } }).where(eq(fileKeySlots.userId, erin));
    await saveCompanyFile({ force: true });
    expect(await fileOpensWith(FILE, 'password', 'Erin-Pass-0001', 'erin')).toBe(true);
    const status = await protectionStatus({ db, userId: admin });
    expect(status.users?.find((u) => u.userId === erin)?.oldLayout).toBe(true);

    const before = keyCheckNow();
    requestFileKeyRotation();
    await saveCompanyFile({ force: true });
    expect(keyCheckNow()).toBe(before); // waits
    expect(fileKeyRotationPending()).toBe(true);
    expect(await fileOpensWith(FILE, 'password', 'Erin-Pass-0001', 'erin')).toBe(true);
    // Her next sign-in re-makes the slot; the next save makes the change, and she still opens the file.
    const [u] = await db.select().from(users).where(eq(users.id, erin));
    await refreshSlotAtSignIn(db, { id: erin, passwordHash: u.passwordHash! }, 'Erin-Pass-0001');
    await saveCompanyFile({ force: true });
    expect(keyCheckNow()).not.toBe(before);
    expect(fileKeyRotationPending()).toBe(false);
    expect(await fileOpensWith(FILE, 'password', 'Erin-Pass-0001', 'erin')).toBe(true);
  }, 120_000);
});

describe('challenge answers and the encrypted file', () => {
  it('a short answer (signed up with "Pip") gets no key slot; a phrase of 10+ characters does', async () => {
    const slotsOf = async () => db.select().from(fileKeySlots).where(and(eq(fileKeySlots.kind, 'challenge'), eq(fileKeySlots.userId, admin)));
    expect(await slotsOf()).toHaveLength(0);
    await saveCompanyFile({ force: true });
    expect(await fileOpensWith(FILE, 'challenge', 'pip', 'cleo')).toBe(false);
    const q = 'Name of your first pet';
    await db.update(users).set({ challengeAnswerHash: await hashPassword(normalizeChallengeAnswer('Pip the grey cat')) }).where(eq(users.id, admin));
    expect(await syncChallengeSlot(db, admin, q, 'Pip the grey cat')).toBe(true);
    expect(await slotsOf()).toHaveLength(1);
    await saveCompanyFile({ force: true });
    expect(await fileOpensWith(FILE, 'challenge', 'pip the grey cat', 'cleo')).toBe(true);
    // Changed back to a short one: the slot goes, and the old phrase opens nothing saved afterwards.
    await db.update(users).set({ challengeAnswerHash: await hashPassword(normalizeChallengeAnswer('Rex')) }).where(eq(users.id, admin));
    expect(await syncChallengeSlot(db, admin, q, 'Rex')).toBe(false);
    expect(await slotsOf()).toHaveLength(0);
    await saveCompanyFile({ force: true });
    expect(await fileOpensWith(FILE, 'challenge', 'pip the grey cat', 'cleo')).toBe(false);
    expect(await fileOpensWith(FILE, 'challenge', 'rex', 'cleo')).toBe(false);
    expect(await fileOpensWith(FILE, 'password', PW, 'cleo')).toBe(true);
  }, 120_000);
});

describe('sandboxes: next to the working copies, and a protected file leaves none behind', () => {
  it('the shell keeps sandboxes in %LOCALAPPDATA%\\Ironbooks\\Sandboxes and moves the old roaming ones there', () => {
    const local = path.join(ROOT, 'LocalAppData');
    expect(sessionMod.sandboxRoot({ platform: 'win32', env: { LOCALAPPDATA: local } })).toBe(path.join(local, 'Ironbooks', 'Sandboxes'));
    const roaming = path.join(ROOT, 'Roaming', 'Ironbooks', 'sandboxes');
    for (const n of ['Kettle sandbox 1', 'Kettle sandbox 2 (running)']) {
      fs.mkdirSync(path.join(roaming, n, 'data'), { recursive: true });
      fs.writeFileSync(path.join(roaming, n, '.ironbooks-sandbox-container'), 'x');
    }
    fs.mkdirSync(path.join(roaming, 'not a sandbox'), { recursive: true });
    const newRoot = sessionMod.sandboxRoot({ platform: 'win32', env: { LOCALAPPDATA: local } });
    const moved = sessionMod.moveLegacySandboxes(roaming, newRoot, [path.join(roaming, 'Kettle sandbox 2 (running)', 'data')]);
    expect(moved).toEqual([path.join(newRoot, 'Kettle sandbox 1')]);
    expect(fs.existsSync(path.join(newRoot, 'Kettle sandbox 1', '.ironbooks-sandbox-container'))).toBe(true);
    expect(fs.existsSync(path.join(roaming, 'Kettle sandbox 2 (running)'))).toBe(true);
    expect(fs.existsSync(path.join(roaming, 'not a sandbox'))).toBe(true);
  });

  it('a sandbox copy left over (never discarded) is removed when the protected file is closed cleanly', async () => {
    const realDir = resolveDataDir();
    const started = await startSandbox(ctx());
    expect(readSandboxMarker(started.dir)?.kind).toBe('sandbox');
    expect(started.dir.startsWith(path.join(PC, 'Sandboxes'))).toBe(true);
    // Another file was opened instead of leaving the sandbox: the copy is left over.
    await closeDb(started.dir);
    switchActiveDataDir(realDir);
    db = await getDb();
    const container = path.dirname(started.dir);
    expect(fs.existsSync(container)).toBe(true);
    const closed = await closeCompanyFile();
    expect(closed.workingCopyRemoved).toBe(true);
    expect(fs.existsSync(sessionMod.dataDirOf(workDir))).toBe(false);
    expect(fs.existsSync(container)).toBe(false);
  }, 180_000);
});

describe('a reused working copy checks the plain listing of the file', () => {
  it('a listing changed without the key refuses the sign-in; the untouched file opens', async () => {
    // Opened on another computer (this one's database handle stays held after Close) and signed in.
    await quit();
    expect((await openOn(FILE, PC2, 'launch-hardening-1')).sealed).toBe('extract');
    resetLimiters();
    const first = await loginPOST(apiRequest('POST', '/api/auth/login', { email: 'cleo', password: PW }));
    expect(first.status).toBe(200);
    await saveCompanyFile({ force: true });
    // The app stops without closing (the working copy stays): the next open reuses it ('key').
    await quit();
    const good = fs.readFileSync(FILE);
    const bad = Buffer.from(good);
    const at = bad.indexOf(Buffer.from('"companyName": "Copper Kettle"'));
    expect(at).toBeGreaterThan(0);
    bad.write('"companyName": "Copper Kittle"', at, 'utf8');
    const dir = format.readCentralDirectory(bad);
    const e = dir.find((x: { name: string }) => x.name === 'ironbooks-company.json');
    const start = e.offset + 30 + bad.readUInt16LE(e.offset + 26) + bad.readUInt16LE(e.offset + 28);
    const crc = format.crc32(bad.subarray(start, start + e.csize));
    bad.writeUInt32LE(crc, e.offset + 14);
    bad.writeUInt32LE(crc, bad.lastIndexOf(Buffer.from('ironbooks-company.json')) - 46 + 16);
    fs.writeFileSync(FILE, bad);

    let opened = await openOn(FILE, PC2, 'launch-hardening-2');
    expect(opened.sealed).toBe('key');
    // Nobody has signed in yet: Save Copy As makes no copy (never an empty or plain-text one).
    const early = path.join(SHARE, 'copy before sign-in.ironbooks');
    await expect(saveCopyAs(early)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(fs.existsSync(early)).toBe(false);
    resetLimiters();
    const refused = await loginPOST(apiRequest('POST', '/api/auth/login', { email: 'cleo', password: PW }));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/integrity check/);
    await quit();

    // The listing changed AND its key check edited, so the check can't be done with this key:
    // refused too (only the key used just before an unsaved key change is accepted).
    const bad2 = Buffer.from(bad);
    const m = format.readCompanyManifest(FILE);
    const kc = Buffer.from(`"keyCheck": "${m.encryption.keyCheck}"`);
    const at2 = bad2.indexOf(kc);
    expect(at2).toBeGreaterThan(0);
    const other = fileCrypto.keyCheckOf(fileCrypto.generateFileKey());
    expect(other.length).toBe(m.encryption.keyCheck.length);
    bad2.write(`"keyCheck": "${other}"`, at2, 'utf8');
    const e2 = format.readCentralDirectory(bad2).find((x: { name: string }) => x.name === 'ironbooks-company.json');
    const s2 = e2.offset + 30 + bad2.readUInt16LE(e2.offset + 26) + bad2.readUInt16LE(e2.offset + 28);
    const crc2 = format.crc32(bad2.subarray(s2, s2 + e2.csize));
    bad2.writeUInt32LE(crc2, e2.offset + 14);
    bad2.writeUInt32LE(crc2, bad2.lastIndexOf(Buffer.from('ironbooks-company.json')) - 46 + 16);
    fs.writeFileSync(FILE, bad2);
    opened = await openOn(FILE, PC2, 'launch-hardening-2b');
    expect(opened.sealed).toBe('key');
    resetLimiters();
    const refused2 = await loginPOST(apiRequest('POST', '/api/auth/login', { email: 'cleo', password: PW }));
    expect(refused2.status).toBe(409);
    await quit();

    fs.writeFileSync(FILE, good);
    opened = await openOn(FILE, PC2, 'launch-hardening-3');
    expect(opened.sealed).toBe('key');
    resetLimiters();
    const ok = await loginPOST(apiRequest('POST', '/api/auth/login', { email: 'cleo', password: PW }));
    expect(ok.status).toBe(200);

    // A key change made here but never saved (the app stopped): the company file is still sealed
    // with the previous key — exactly the one the working copy recorded — and opens.
    db = await getDb();
    expect((await rotateFileKey(db, { force: true })).rotated).toBe(true);
    await quit();
    opened = await openOn(FILE, PC2, 'launch-hardening-4');
    expect(opened.sealed).toBe('key');
    resetLimiters();
    const again = await loginPOST(apiRequest('POST', '/api/auth/login', { email: 'cleo', password: PW }));
    expect(again.status).toBe(200);
  }, 180_000);
});

describe('restoring into a protected file whose protection cannot be read', () => {
  it('refuses a backup made without passwords (the restored books could never be saved)', async () => {
    const dir = path.join(ROOT, 'damaged', 'data');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'PG_VERSION'), '17\n');
    fs.writeFileSync(path.join(dir, '.ironbooks-protected'), JSON.stringify({ keyCheck: 'x' }));
    const plainBackup = format.buildBackupArchive({
      backupManifest: { app: 'bookkeeper-ai', formatVersion: 1, kind: 'full', companyName: 'Old Books', createdAt: new Date().toISOString() },
      entries: [{ name: 'PG_VERSION', data: Buffer.from('17\n') }],
    });
    await expect(restoreBackup(plainBackup, dir)).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/protection could not be read/) });
    expect(fs.readdirSync(dir).sort()).toEqual(['.ironbooks-protected', 'PG_VERSION']);
  }, 120_000);
});
