/**
 * Security review 2.1: the closing-date password could be replaced or removed without knowing it,
 * by the very roles it exists to stop (Accountant, External Accountant hold Closing Date: modify).
 *
 * Once a password is set, a caller who is not an Admin must give the current password to move
 * the closing date earlier, clear it, or replace / remove the password. Wrong guesses share the
 * x-closing-password limiter. Moving the date LATER and keeping the password (month-end close)
 * still needs nothing, and an Admin's flow is unchanged.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { NextRequest } from 'next/server';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { hashPassword } from '@/lib/auth';
import type { ServiceContext } from './_base';
import { resolveAccess } from './access';
import { addUser } from './users';
import {
  CLOSING_CURRENT_PASSWORD_NEEDED,
  CLOSING_CURRENT_PASSWORD_WRONG,
  createCompany,
  getClosingDateSettings,
  setClosingDate,
  verifyClosingDatePassword,
} from './company';

let routeCtx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => routeCtx) }));
import { GET as closingGET, PATCH as closingPATCH } from '@/app/api/company/closing-date/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-security1-closing-date');
let db: DB;
let admin: ServiceContext;
let extAcct: ServiceContext;
let accountant: ServiceContext;

async function ctxFor(userId: string, companyId: string): Promise<ServiceContext> {
  // Shaped like getServerContext: the member's effective access, resolved from the file.
  const r = await resolveAccess(db, companyId, userId);
  return { db, companyId, userId, access: r.access, role: r.access.isAdmin ? 'admin' : 'accountant' };
}

function resetLimiter() {
  (globalThis as unknown as { __bkaLoginLimiter?: unknown }).__bkaLoginLimiter = undefined;
}

describe('closing-date password: changing it needs the current one or an Admin (security 2.1)', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [owner] = await db
      .insert(users)
      .values({ email: 'owner@cd.local', name: 'Owner', passwordHash: await hashPassword('ownerpass1') })
      .returning();
    const companyId = (await createCompany(db, { name: 'Closing Co', ownerId: owner.id })).id;
    admin = await ctxFor(owner.id, companyId);
    const ext = await addUser(admin, { name: 'Ext', login: 'ext@cd.local', password: 'extpass123', roleKeys: ['external_accountant'] });
    const acc = await addUser(admin, { name: 'Acc', login: 'acc@cd.local', password: 'accpass123', roleKeys: ['accountant'] });
    extAcct = await ctxFor(ext.userId, companyId);
    accountant = await ctxFor(acc.userId, companyId);
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    resetLimiter();
    // Every case starts from books closed through 2026-03-31 with the password "lock123".
    await setClosingDate(admin, { closingDate: '2026-03-31', password: 'lock123' });
  });

  it('an External Accountant cannot replace or remove the password without the current one', async () => {
    await expect(setClosingDate(extAcct, { closingDate: '2026-03-31', password: 'mine456' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: CLOSING_CURRENT_PASSWORD_NEEDED,
    });
    await expect(setClosingDate(extAcct, { closingDate: '2026-03-31', password: null })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(setClosingDate(extAcct, { closingDate: '2026-03-31', password: '' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // Nothing changed: the old password still opens the closed period.
    expect(await verifyClosingDatePassword(db, admin.companyId, 'lock123')).toBe(true);
    expect(await verifyClosingDatePassword(db, admin.companyId, 'mine456')).toBe(false);
  });

  it('nor reopen closed books by moving the date earlier or clearing it', async () => {
    await expect(setClosingDate(extAcct, { closingDate: '2025-12-31' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(setClosingDate(accountant, { closingDate: null })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await getClosingDateSettings(admin)).toMatchObject({ closingDate: '2026-03-31', hasPassword: true });
  });

  it('a wrong current password is refused; the right one allows the change', async () => {
    await expect(
      setClosingDate(extAcct, { closingDate: '2026-03-31', password: 'mine456', currentPassword: 'guess' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: CLOSING_CURRENT_PASSWORD_WRONG });
    const res = await setClosingDate(extAcct, { closingDate: '2026-03-31', password: 'mine456', currentPassword: 'lock123' });
    expect(res).toMatchObject({ closingDate: '2026-03-31', hasPassword: true, currentPasswordRequired: true });
    expect(await verifyClosingDatePassword(db, admin.companyId, 'mine456')).toBe(true);
    // And with it, the books can be reopened.
    await setClosingDate(accountant, { closingDate: '2025-12-31', currentPassword: 'mine456' });
    expect((await getClosingDateSettings(admin)).closingDate).toBe('2025-12-31');
  });

  it('wrong guesses are rate-limited like the x-closing-password check', async () => {
    for (let i = 0; i < 5; i++) {
      await expect(
        setClosingDate(extAcct, { closingDate: '2025-01-31', currentPassword: `guess-${i}` }),
      ).rejects.toMatchObject({ message: CLOSING_CURRENT_PASSWORD_WRONG });
    }
    // Locked now, even with the right password.
    await expect(
      setClosingDate(extAcct, { closingDate: '2025-01-31', currentPassword: 'lock123' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', details: { rateLimited: true } });
    expect((await getClosingDateSettings(admin)).closingDate).toBe('2026-03-31');
  });

  it('moving the date later and keeping the password needs nothing (month-end close)', async () => {
    const res = await setClosingDate(extAcct, { closingDate: '2026-04-30' });
    expect(res).toMatchObject({ closingDate: '2026-04-30', hasPassword: true });
    expect(await verifyClosingDatePassword(db, admin.companyId, 'lock123')).toBe(true);
  });

  it('without a password set, a non-Admin changes the date and sets one as before', async () => {
    await setClosingDate(admin, { closingDate: null });
    await setClosingDate(extAcct, { closingDate: '2026-01-31' });
    await setClosingDate(extAcct, { closingDate: '2025-12-31', password: 'first1' });
    expect(await getClosingDateSettings(extAcct)).toMatchObject({ closingDate: '2025-12-31', hasPassword: true, currentPasswordRequired: true });
  });

  it('an Admin changes and removes it without the current password (unchanged)', async () => {
    expect(await getClosingDateSettings(admin)).toMatchObject({ currentPasswordRequired: false });
    await setClosingDate(admin, { closingDate: '2025-06-30', password: 'adminNew1' });
    expect(await verifyClosingDatePassword(db, admin.companyId, 'adminNew1')).toBe(true);
    const cleared = await setClosingDate(admin, { closingDate: null });
    expect(cleared).toMatchObject({ closingDate: null, hasPassword: false });
  });

  it('the route passes currentPassword through and tells the dialog when it is needed', async () => {
    routeCtx = extAcct;
    const got = await (await closingGET()).json();
    expect(got).toMatchObject({ closingDate: '2026-03-31', hasPassword: true, currentPasswordRequired: true });
    const patch = (body: unknown) =>
      closingPATCH(new NextRequest('http://127.0.0.1/api/company/closing-date', { method: 'PATCH', body: JSON.stringify(body) }));
    const refused = await patch({ closingDate: '2026-03-31', password: null });
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toBe(CLOSING_CURRENT_PASSWORD_NEEDED);
    const ok = await patch({ closingDate: '2026-03-31', password: null, currentPassword: 'lock123' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ hasPassword: false, currentPasswordRequired: false });
    routeCtx = admin;
    expect(await (await closingGET()).json()).toMatchObject({ currentPasswordRequired: false });
  });
});
