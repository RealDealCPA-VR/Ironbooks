/**
 * Reopening a protected company file on a computer that still has its working copy (filecrypto):
 *  - RECOVER (the app stopped with unsaved work, the file is unchanged): the server starts sealed
 *    ('key') — the working copy is not used before a sign-in, a wrong password is refused, the
 *    right one unlocks the key from the user's own slot and the unsaved work is saved encrypted;
 *  - CONFLICT (someone else saved the file meanwhile): the sign-in keeps this computer's unsaved
 *    work as a separate company file, protected with the same passwords, and opens the new save.
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

import { getDb, withSealedAccess } from '@/lib/db';
import { customers, users } from '@/lib/db/schema';
import { POST as signupPOST } from '@/app/api/auth/signup/route';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { closeCompanyFile, saveCompanyFile } from './companyFileSave';
import { createCustomer } from './customers';
import { apiRequest, fileOpensWith, format, newCompanyFile, openOn, quit, resetLimiters, sessionMod } from './fileProtection.fixture';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-reopen-'));
const FILE = path.join(ROOT, 'share', 'Birch Hollow.ironbooks');
const PC1 = path.join(ROOT, 'pc-1');
const PC2 = path.join(ROOT, 'pc-2');
let companyId = '';
let admin = '';

async function addCustomer(name: string) {
  const db = await getDb();
  await createCustomer({ db, companyId, userId: admin }, { displayName: name } as Parameters<typeof createCustomer>[1]);
}
async function customerNames(): Promise<string[]> {
  const db = await getDb();
  return (await db.select({ n: customers.displayName }).from(customers)).map((r) => r.n);
}
/** The app stops on this computer with work the company file does not have yet. */
async function crashWithUnsavedWork(workDir: string) {
  sessionMod.writeState(workDir, { unsavedSince: new Date().toISOString(), closedCleanly: false });
  await quit();
}
const login = (password: string) => loginPOST(apiRequest('POST', '/api/auth/login', { email: 'bea', password }));

beforeAll(async () => {
  await newCompanyFile(FILE, 'Birch Hollow');
  await openOn(FILE, PC1, 'launch-1');
  const res = await signupPOST(apiRequest('POST', '/api/auth/signup', { name: 'Bea Admin', email: 'bea', password: 'Birch-Pass-01', companyName: 'Birch Hollow' }));
  expect(res.status).toBe(201);
  const body = await res.json();
  companyId = body.companyId;
  admin = body.id;
  await addCustomer('Saved Customer');
  expect((await saveCompanyFile({ force: true })).encrypted).toBe(true);
}, 180_000);

afterAll(async () => {
  await quit();
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('reopening a protected company file where its working copy still is', () => {
  let pc1Work = '';

  it('recover: sealed until a sign-in, then the unsaved work is saved encrypted', async () => {
    await addCustomer('Unsaved Customer');
    pc1Work = path.dirname(process.env.BKA_COMPANY_STATE!);
    await crashWithUnsavedWork(pc1Work);

    const opened = await openOn(FILE, PC1, 'launch-1b');
    expect(opened.plan).toBe('recover');
    expect(opened.sealed).toBe('key');
    await expect(getDb()).rejects.toThrow(/Authentication required/);
    resetLimiters();
    expect((await login('Wrong-Pass-000')).status).toBe(401);
    const ok = await login('Birch-Pass-01');
    expect(ok.status).toBe(200);
    expect(await customerNames()).toEqual(expect.arrayContaining(['Saved Customer', 'Unsaved Customer']));
    expect((await saveCompanyFile({ force: true })).encrypted).toBe(true);
    expect(await fileOpensWith(FILE, 'password', 'Birch-Pass-01', 'bea')).toBe(true);
  }, 180_000);

  it('the working copy of a sealed reuse is only read inside the sign-in', async () => {
    await addCustomer('Unsaved Again');
    await crashWithUnsavedWork(pc1Work);
    await openOn(FILE, PC1, 'launch-1c');
    // Only the sign-in's own scope may read the users and key slots before the key is known.
    const [u] = await withSealedAccess(async () => (await getDb()).select({ id: users.id }).from(users).where(eq(users.email, 'bea')));
    expect(u.id).toBe(admin);
    await expect(getDb()).rejects.toThrow(/Authentication required/);
    await quit();
  }, 120_000);

  it('conflict: another computer saved meanwhile — the unsaved work is kept as a protected copy', async () => {
    // PC 2 opens the file, adds a customer, saves and closes it.
    const two = await openOn(FILE, PC2, 'launch-2');
    expect(two.sealed).toBe('extract');
    resetLimiters();
    expect((await login('Birch-Pass-01')).status).toBe(200);
    await addCustomer('From PC 2');
    expect((await closeCompanyFile()).workingCopyRemoved).toBe(true);
    await quit();

    // PC 1 still has its unsaved work from before.
    const one = await openOn(FILE, PC1, 'launch-1d');
    expect(one.plan).toBe('conflict');
    expect(one.sealed).toBe('conflict');
    resetLimiters();
    const res = await login('Birch-Pass-01');
    expect(res.status).toBe(200);
    const { conflictCopy } = await res.json();
    expect(conflictCopy).toMatch(/unsaved changes/);
    expect(format.isSealedManifest(format.readCompanyManifest(conflictCopy))).toBe(true);
    expect(fs.readFileSync(conflictCopy).includes(Buffer.from('Unsaved Again'))).toBe(false);
    expect(await fileOpensWith(conflictCopy, 'password', 'Birch-Pass-01', 'bea')).toBe(true);
    // The working copy is the new save now (PC 2's customer is there).
    expect(await customerNames()).toEqual(expect.arrayContaining(['From PC 2']));
    // Reported once.
    resetLimiters();
    expect((await (await login('Birch-Pass-01')).json()).conflictCopy).toBeUndefined();
  }, 240_000);
});
