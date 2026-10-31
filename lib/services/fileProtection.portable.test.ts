/**
 * Portable company files (.bkp) and Accountant's Copy transfer files (.ibac) of a protected
 * company file (filecrypto): offered with a password (on by default) that encrypts the whole file
 * and is needed to open it; a protected file's key travels inside, so the company file restored
 * from it is protected again with the same user names and passwords. Without a password the file
 * is plain and never carries the key.
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

import { getDb, type DB } from '@/lib/db';
import { userSessions } from '@/lib/db/schema';
import { fullAccess } from '@/lib/permissions/model';
import { POST as signupPOST } from '@/app/api/auth/signup/route';
import { POST as restorePOST } from '@/app/api/portable/restore/route';
import { POST as openCopyPOST } from '@/app/api/accountant-copy/open/route';
import { saveCompanyFile } from './companyFileSave';
import { createCustomer } from './customers';
import { PORTABLE_KEY_ENTRY, createPortableCompanyFile, unlockPortableBuffer } from './portableFile';
import { createAccountantCopy, cancelAccountantCopy } from './accountantCopy/client';
import { apiRequest, fileCrypto, fileOpensWith, format, keepCookies, newCompanyFile, openOn, quit, resetLimiters } from './fileProtection.fixture';
import AdmZip from 'adm-zip';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-portable-pw-'));
const FILE = path.join(ROOT, 'share', 'Juniper Lane.ironbooks');
const CUSTOMER = 'Quillon Barnaby Imports';
const LAUNCH = 'launch-portable-pw';
let db: DB;
let companyId = '';
let admin = '';
let sessionId = '';
const ctx = () => ({ db, companyId, userId: admin, sessionId, role: 'owner' as const, access: fullAccess() });
const pw = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

beforeAll(async () => {
  await newCompanyFile(FILE, 'Juniper Lane');
  await openOn(FILE, path.join(ROOT, 'pc'), LAUNCH);
  const res = await signupPOST(apiRequest('POST', '/api/auth/signup', { name: 'Jo Admin', email: 'jo', password: 'Juniper-Pass-1', companyName: 'Juniper Lane' }));
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
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('portable and transfer files of a protected company file', () => {
  let sealedBkp: Buffer;

  it('a portable file with a password is encrypted as a whole and carries the file key inside', async () => {
    const { buffer } = await createPortableCompanyFile(ctx(), { password: 'Portable-Pw-2026' });
    sealedBkp = buffer;
    expect(fileCrypto.isPasswordSealed(buffer)).toBe(true);
    expect(buffer.includes(Buffer.from(CUSTOMER))).toBe(false);
    await expect(unlockPortableBuffer(buffer, null)).rejects.toMatchObject({ details: { passwordRequired: true } });
    await expect(unlockPortableBuffer(buffer, 'nope-nope-nope')).rejects.toMatchObject({ details: { wrongPassword: true } });
    const plain = await unlockPortableBuffer(buffer, 'Portable-Pw-2026');
    expect(new AdmZip(plain).getEntry(PORTABLE_KEY_ENTRY)).toBeTruthy();
    await expect(createPortableCompanyFile(ctx(), { password: 'short' })).rejects.toMatchObject({ code: 'VALIDATION' });
  }, 120_000);

  it('without a password it is plain and never carries the key', async () => {
    const { buffer } = await createPortableCompanyFile(ctx());
    expect(fileCrypto.isPasswordSealed(buffer)).toBe(false);
    expect(new AdmZip(buffer).getEntry(PORTABLE_KEY_ENTRY)).toBeNull();
  }, 120_000);

  it('opening it needs the password; the company file restored from it is protected again', async () => {
    resetLimiters();
    const scratch = path.join(ROOT, 'pc', 'restore-1', 'data');
    const target = path.join(ROOT, 'share', 'Juniper Lane restored.ironbooks');
    const url = `/api/portable/restore?target=${encodeURIComponent(scratch)}&packAs=${encodeURIComponent(target)}`;
    const none = await restorePOST(apiRequest('POST', url, new Uint8Array(sealedBkp), { headers: { 'x-bka-internal': LAUNCH } }));
    expect(none.status).toBe(403);
    expect((await none.json()).details).toMatchObject({ passwordRequired: true });
    const wrong = await restorePOST(apiRequest('POST', url, new Uint8Array(sealedBkp), { headers: { 'x-bka-internal': LAUNCH, 'x-ironbooks-password': pw('Wrong-Pass-000') } }));
    expect(wrong.status).toBe(403);
    expect((await wrong.json()).details).toMatchObject({ wrongPassword: true });
    expect(fs.existsSync(target)).toBe(false);

    const ok = await restorePOST(apiRequest('POST', url, new Uint8Array(sealedBkp), { headers: { 'x-bka-internal': LAUNCH, 'x-ironbooks-password': pw('Portable-Pw-2026') } }));
    expect(ok.status).toBe(201);
    const body = await ok.json();
    expect(body).toMatchObject({ protected: true, packed: target });
    const m = format.readCompanyManifest(target);
    expect(format.isSealedManifest(m)).toBe(true);
    expect(fs.readFileSync(target).includes(Buffer.from(CUSTOMER))).toBe(false);
    expect(await fileOpensWith(target, 'password', 'Juniper-Pass-1', 'jo')).toBe(true);
  }, 180_000);

  it("an Accountant's Copy transfer file with a password needs it to open", async () => {
    resetLimiters();
    await expect(createAccountantCopy(ctx(), { dividingDate: '2026-06-30', password: 'short' })).rejects.toMatchObject({ code: 'VALIDATION' });
    const t = await createAccountantCopy(ctx(), { dividingDate: '2026-06-30', password: 'Transfer-Pw-2026' });
    expect(fileCrypto.isPasswordSealed(t.buffer)).toBe(true);
    expect(t.buffer.includes(Buffer.from(CUSTOMER))).toBe(false);
    const ask = await openCopyPOST(apiRequest('POST', '/api/accountant-copy/open?inspect=1', new Uint8Array(t.buffer)));
    expect(ask.status).toBe(403);
    expect((await ask.json()).details).toMatchObject({ passwordRequired: true });
    const ok = await openCopyPOST(apiRequest('POST', '/api/accountant-copy/open?inspect=1', new Uint8Array(t.buffer), { headers: { 'x-ironbooks-password': pw('Transfer-Pw-2026') } }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).companyName).toBe('Juniper Lane');
    await cancelAccountantCopy(ctx());
  }, 180_000);
});
