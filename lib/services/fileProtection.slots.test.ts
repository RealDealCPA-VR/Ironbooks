/**
 * The company file's key slots stay in sync with every way a password (or challenge answer, or
 * the recovery key) changes (filecrypto, lib/services/fileProtection.ts). Each check saves the
 * file and tries the secret on the slots of the company file ON DISK — what any other computer
 * with a fresh install would see:
 *   user added · Admin set-password · own password change · reset with the challenge answer ·
 *   challenge question changed · user renamed · user deactivated (dropped at the next save) ·
 *   sign-in that creates a missing slot (also a teammate's remote sign-in) · recovery key
 *   regenerated · the recovery key setting an Admin's new password.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

import { getDb, type DB } from '@/lib/db';
import { fileKeySlots, users } from '@/lib/db/schema';
import { fullAccess } from '@/lib/permissions/model';
import { POST as signupPOST } from '@/app/api/auth/signup/route';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { POST as challengePOST } from '@/app/api/auth/challenge/route';
import { POST as requestResetPOST } from '@/app/api/auth/request-reset/route';
import { POST as resetPOST } from '@/app/api/auth/reset/route';
import { POST as recoverPOST } from '@/app/api/auth/recover/route';
import { POST as recoveryKeyPOST } from '@/app/api/file-protection/recovery-key/route';
import { GET as protectionGET } from '@/app/api/file-protection/route';
import { addUser, resetUserPassword, updateUser } from './users';
import { changeOwnPassword } from './passwordPolicy';
import { saveCompanyFile } from './companyFileSave';
import { protectionStatus } from './fileProtection';
import {
  apiRequest,
  fileOpensWith,
  newCompanyFile,
  openOn,
  quit,
  resetLimiters,
  signedInAs,
} from './fileProtection.fixture';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-slots-'));
const FILE = path.join(ROOT, 'share', 'Slot Sync Co.ironbooks');
let db: DB;
let companyId = '';
let admin = '';
let recoveryKey = '';

const ctxOf = (userId: string) => ({ db, companyId, userId, access: fullAccess(), role: 'owner' as const });
async function opens(kind: 'password' | 'challenge' | 'recovery', secret: string, login: string | null = null) {
  expect((await saveCompanyFile({ force: true })).encrypted).toBe(true);
  return fileOpensWith(FILE, kind, secret, login);
}

beforeAll(async () => {
  await newCompanyFile(FILE, 'Slot Sync Co');
  await openOn(FILE, path.join(ROOT, 'pc'), 'launch-slots');
  const res = await signupPOST(
    apiRequest('POST', '/api/auth/signup', { name: 'Ada Admin', email: 'ada', password: 'Ada-Pass-0001', companyName: 'Slot Sync Co', challengeQuestion: 'Name of your first pet', challengeAnswer: 'Rex the brown dog' }),
  );
  expect(res.status).toBe(201);
  const body = await res.json();
  companyId = body.companyId;
  admin = body.id;
  recoveryKey = body.recoveryKey;
  db = await getDb();
}, 180_000);

afterAll(async () => {
  await quit();
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

beforeEach(() => resetLimiters());

describe('key slots follow every password change', () => {
  it('the Admin from /signup: password, challenge answer and recovery key all open the file', async () => {
    expect(await opens('password', 'Ada-Pass-0001', 'ada')).toBe(true);
    expect(await opens('challenge', 'rex the brown dog', 'ada')).toBe(true);
    expect(await fileOpensWith(FILE, 'recovery', recoveryKey.replace(/-/g, ''))).toBe(true);
    expect(await fileOpensWith(FILE, 'password', 'wrong', 'ada')).toBe(false);
  }, 60_000);

  let bob = '';
  it('a user added with a password gets a slot', async () => {
    bob = (await addUser(ctxOf(admin), { name: 'Bob Clerk', login: 'bob', password: 'Bob-Pass-0001', roleKeys: ['ar_clerk'] })).userId;
    expect(await opens('password', 'Bob-Pass-0001', 'bob')).toBe(true);
  }, 60_000);

  it('an Admin setting the password re-makes the slot (the old password stops opening the file)', async () => {
    await resetUserPassword(ctxOf(admin), bob, 'Bob-Pass-0002');
    expect(await opens('password', 'Bob-Pass-0002', 'bob')).toBe(true);
    expect(await fileOpensWith(FILE, 'password', 'Bob-Pass-0001', 'bob')).toBe(false);
  }, 60_000);

  it('changing your own password', async () => {
    await changeOwnPassword(db, bob, { currentPassword: 'Bob-Pass-0002', newPassword: 'Bob-Pass-0003' });
    expect(await opens('password', 'Bob-Pass-0003', 'bob')).toBe(true);
    expect(await fileOpensWith(FILE, 'password', 'Bob-Pass-0002', 'bob')).toBe(false);
  }, 60_000);

  it('setting and changing the challenge question', async () => {
    signedInAs(bob);
    const first = await challengePOST(apiRequest('POST', '/api/auth/challenge', { currentPassword: 'Bob-Pass-0003', question: 'Name of your first pet', answer: 'Fido the beagle' }));
    expect(first.status).toBe(200);
    expect(await opens('challenge', 'fido the beagle', 'bob')).toBe(true);
    signedInAs(bob);
    const second = await challengePOST(apiRequest('POST', '/api/auth/challenge', { currentPassword: 'Bob-Pass-0003', question: 'Street you grew up on', answer: 'Toledo Avenue East' }));
    expect(second.status).toBe(200);
    expect(await opens('challenge', 'toledo avenue east', 'bob')).toBe(true);
    expect(await fileOpensWith(FILE, 'challenge', 'fido the beagle', 'bob')).toBe(false);
  }, 60_000);

  it('"I forgot my password": the challenge answer, then a new password that opens the file', async () => {
    const asked = await requestResetPOST(apiRequest('POST', '/api/auth/request-reset', { email: 'bob', challengeAnswer: 'Toledo Avenue East' }));
    const { token } = await asked.json();
    expect(token).toBeTruthy();
    const done = await resetPOST(apiRequest('POST', '/api/auth/reset', { token, password: 'Bob-Pass-0004' }));
    expect(done.status).toBe(200);
    expect(await opens('password', 'Bob-Pass-0004', 'bob')).toBe(true);
    expect(await fileOpensWith(FILE, 'password', 'Bob-Pass-0003', 'bob')).toBe(false);
  }, 60_000);

  it('a renamed user keeps opening the file under the new user name', async () => {
    await updateUser(ctxOf(admin), bob, { login: 'bob.clerk' });
    expect(await opens('password', 'Bob-Pass-0004', 'bob.clerk')).toBe(true);
    expect(await fileOpensWith(FILE, 'password', 'Bob-Pass-0004', 'bob')).toBe(false);
  }, 60_000);

  it('a deactivated user is dropped at the next save (and comes back when reactivated)', async () => {
    await updateUser(ctxOf(admin), bob, { isActive: false });
    expect(await opens('password', 'Bob-Pass-0004', 'bob.clerk')).toBe(false);
    expect(await fileOpensWith(FILE, 'challenge', 'toledo avenue east', 'bob.clerk')).toBe(false);
    await updateUser(ctxOf(admin), bob, { isActive: true });
    expect(await opens('password', 'Bob-Pass-0004', 'bob.clerk')).toBe(true);
  }, 60_000);

  it('a user with no slot yet is listed, and gets one the first time they sign in (also from another computer)', async () => {
    // Carol existed before the file was protected: no slot.
    const carol = (await addUser(ctxOf(admin), { name: 'Carol Remote', login: 'carol', password: 'Carol-Pass-001', roleKeys: ['ar_clerk'] })).userId;
    await db.delete(fileKeySlots).where(and(eq(fileKeySlots.userId, carol), eq(fileKeySlots.kind, 'password')));
    const st = await protectionStatus({ db, userId: admin });
    expect(st.users?.find((u) => u.login === 'carol')?.canOpen).toBe(false);
    signedInAs(admin);
    const listed = await (await protectionGET()).json();
    expect(listed.users.find((u: { login: string }) => u.login === 'carol').canOpen).toBe(false);
    expect(await opens('password', 'Carol-Pass-001', 'carol')).toBe(false);

    // She signs in to the hosted file from her own computer: her slot is made.
    const res = await loginPOST(apiRequest('POST', '/api/auth/login', { email: 'carol', password: 'Carol-Pass-001' }, { remoteAddr: '100.64.0.7' }));
    expect(res.status).toBe(200);
    expect(await opens('password', 'Carol-Pass-001', 'carol')).toBe(true);
    expect((await protectionStatus({ db, userId: admin })).users?.find((u) => u.login === 'carol')?.canOpen).toBe(true);
  }, 60_000);

  it('a slot made with a weaker cost than today is re-wrapped at the next sign-in', async () => {
    const [row] = await db.select().from(fileKeySlots).where(and(eq(fileKeySlots.userId, admin), eq(fileKeySlots.kind, 'password')));
    await db.update(fileKeySlots).set({ slot: { ...row.slot, kdf: { name: 'scrypt', N: 16, r: 8, p: 1 } } }).where(eq(fileKeySlots.id, row.id));
    const res = await loginPOST(apiRequest('POST', '/api/auth/login', { email: 'ada', password: 'Ada-Pass-0001' }));
    expect(res.status).toBe(200);
    const [after] = await db.select().from(fileKeySlots).where(eq(fileKeySlots.id, row.id));
    expect((after.slot as { kdf: { N: number } }).kdf.N).toBeGreaterThan(16);
  }, 60_000);

  it('a new recovery key replaces the old one from the next save', async () => {
    signedInAs(admin);
    const res = await recoveryKeyPOST(apiRequest('POST', '/api/file-protection/recovery-key', { password: 'Ada-Pass-0001' }));
    expect(res.status).toBe(200);
    const fresh = (await res.json()).recoveryKey as string;
    expect(fresh).not.toBe(recoveryKey);
    expect(await opens('recovery', fresh.replace(/-/g, ''))).toBe(true);
    expect(await fileOpensWith(FILE, 'recovery', recoveryKey.replace(/-/g, ''))).toBe(false);
    // A wrong password does not make one.
    signedInAs(admin);
    expect((await recoveryKeyPOST(apiRequest('POST', '/api/file-protection/recovery-key', { password: 'nope' }))).status).toBe(403);
    recoveryKey = fresh;
  }, 60_000);

  it('the recovery key sets a new password for an Admin who lost every password', async () => {
    const res = await recoverPOST(apiRequest('POST', '/api/auth/recover', { recoveryKey: recoveryKey.toLowerCase(), login: 'ada', password: 'Ada-Recovered-9' }));
    expect(res.status).toBe(200);
    expect(await opens('password', 'Ada-Recovered-9', 'ada')).toBe(true);
    expect(await fileOpensWith(FILE, 'password', 'Ada-Pass-0001', 'ada')).toBe(false);
    // A wrong key never does.
    const wrong = await recoverPOST(apiRequest('POST', '/api/auth/recover', { recoveryKey: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF', login: 'ada', password: 'Hijacked-Pass-1' }));
    expect(wrong.status).toBe(403);
    const [u] = await db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, admin));
    const { verifyPassword } = await import('@/lib/auth');
    expect(await verifyPassword('Ada-Recovered-9', u.hash)).toBe(true);
  }, 60_000);
});
