/**
 * Users & Roles — fix-round regression tests (team users, doer round 1).
 *
 * Complements users.adversarial.test.ts with the edges of each fix:
 *  - shared logins: an Admin of EVERY company the user belongs to (or the user themself) may
 *    still reset / rename; partial Admins may not.
 *  - getSessionGate ('self' routes): deactivated users are refused on 2FA routes too, and an
 *    area-mapped route can't use the gate to skip its area check.
 *  - service-layer masking: vendor tax IDs (list/get, 1099 report, audit trail), employee SSNs,
 *    reconciliation lists; a masked tax ID echoed back never overwrites the real one.
 *  - legacy requireRole('admin') call sites now follow Enterprise roles (custom fields).
 *  - restore keeps the target file's own .auth-secret / .file-id.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  headers: new Map<string, string>(),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (h.cookies.has(n) ? { name: n, value: h.cookies.get(n)! } : undefined),
  }),
  headers: async () => new Headers([...h.headers.entries()]),
}));

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-team-users-fixes');
// Nested so the restore's pre-op backups land in a private sibling dir, not the shared one.
const RESTORE_ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-team-users-fixes-restore');
const RESTORE_DIR = path.join(RESTORE_ROOT, 'data');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'team-users-fixes-secret';

import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, auditLogs, users } from '@/lib/db/schema';
import { createSessionToken, hashPassword, verifyPassword, SESSION_COOKIE } from '@/lib/auth';
import { COMPANY_COOKIE, getServerContext, getSessionGate } from '@/lib/context';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { createCompany } from './company';
import { createBankAccount } from './bankAccounts';
import { createBackup, restoreBackup } from './backup';
import { createVendor, getVendor, listVendors, updateVendor } from './vendors';
import { createEmployee, updateEmployee, listEmployees } from './payroll';
import { listReconciliations, startReconciliation } from './reconcile';
import { getAuditLog } from './auditTrail';
import { setCustomFieldDefinitions } from './customFields';
import type { ServiceContext } from './_base';
import { addUser, resetUserPassword, updateUser } from './users';
import { POST as twoFaSetupPOST } from '@/app/api/auth/2fa/setup/route';

let db: DB;
let companyA: string;
let ownerA: string;

function as(userId: string | null, method: string, routePath: string, companyId = companyA) {
  h.headers.clear();
  h.headers.set(ROUTE_PATH_HEADER, routePath);
  h.headers.set(ROUTE_METHOD_HEADER, method);
  h.cookies.clear();
  if (userId) {
    h.cookies.set(SESSION_COOKIE, createSessionToken(userId));
    h.cookies.set(COMPANY_COOKIE, companyId);
  }
}
async function ctxAs(userId: string, method: string, routePath: string, companyId = companyA) {
  as(userId, method, routePath, companyId);
  return getServerContext();
}
async function newUser(email: string, name: string, password: string) {
  const [u] = await db
    .insert(users)
    .values({ email, name, passwordHash: await hashPassword(password) })
    .returning();
  return u;
}

describe('Users & Roles — fix round', () => {
  let adminA: ServiceContext;

  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    ownerA = (await newUser('owner@fx.local', 'Owner A', 'ownerApass1')).id;
    companyA = (await createCompany(db, { name: 'Fix Co', ownerId: ownerA })).id;
    adminA = await ctxAs(ownerA, 'POST', '/api/users');
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.rmSync(RESTORE_ROOT, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  describe('shared logins across companies of one file', () => {
    it('an Admin of every company the user belongs to may reset and rename', async () => {
      const coB = await createCompany(db, { name: 'Fix B', ownerId: ownerA, seedCoa: false });
      const adminB = await ctxAs(ownerA, 'POST', '/api/users', coB.id);
      const u = await addUser(adminB, { name: 'Pat', login: 'pat', password: 'patpass123', roleKeys: ['sales'] });
      await addUser(adminA, { name: 'Pat', login: 'pat', roleKeys: ['sales'] }); // attach to A
      await resetUserPassword(adminA, u.userId, 'newPatPass1');
      const [row] = await db.select().from(users).where(eq(users.id, u.userId));
      expect(await verifyPassword('newPatPass1', row.passwordHash)).toBe(true);
      await updateUser(adminA, u.userId, { login: 'pat2' });
    });

    it('a deactivated Admin seat in the other company does not count', async () => {
      const carl = await newUser('carl@fx.local', 'Carl', 'carlpass123');
      const coC = await createCompany(db, { name: 'Fix C', ownerId: carl.id, seedCoa: false });
      const carlCtx = await ctxAs(carl.id, 'POST', '/api/users', coC.id);
      // Carl attaches A's owner to C as Admin, then deactivates them there.
      await addUser(carlCtx, { name: 'Owner A', login: 'owner@fx.local', roleKeys: ['admin'] });
      await updateUser(carlCtx, ownerA, { isActive: false });
      await expect(resetUserPassword(adminA, carl.id, 'stolenPass1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      // Attach Carl to A, then A's owner (deactivated in C) still can't reset Carl.
      await addUser(adminA, { name: 'Carl', login: 'carl@fx.local', roleKeys: ['view_only'] });
      await expect(resetUserPassword(adminA, carl.id, 'stolenPass1')).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(updateUser(adminA, carl.id, { name: 'Renamed' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      // Role and active-state changes in A itself are still A's business.
      await updateUser(adminA, carl.id, { roleKeys: ['sales'] });
    });
  });

  // -------------------------------------------------------------------------
  describe('getSessionGate (self routes)', () => {
    it("refuses a user deactivated everywhere on the caller's own 2FA routes", async () => {
      const z = await addUser(adminA, { name: 'Zoe', login: 'zoe', password: 'zoepass123', roleKeys: ['sales'] });
      await updateUser(adminA, z.userId, { isActive: false });
      as(z.userId, 'POST', '/api/auth/2fa/setup');
      const res = await twoFaSetupPOST();
      expect(res.status).toBe(403);
    });

    it('denies an area-mapped or unmapped route that tries to use the gate', async () => {
      as(ownerA, 'GET', '/api/journal-entries');
      await expect(getSessionGate()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      as(ownerA, 'GET', '/api/not-a-route');
      await expect(getSessionGate()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      as(ownerA, 'GET', '/api/companies');
      await expect(getSessionGate()).resolves.toMatchObject({ userId: ownerA });
    });
  });

  // -------------------------------------------------------------------------
  describe('service-layer masking', () => {
    let apCtx: ServiceContext;
    let vendorId: string;

    beforeAll(async () => {
      const ap = await addUser(adminA, { name: 'Ada AP', login: 'ada', password: 'adapass123', roleKeys: ['ap_clerk'] });
      apCtx = await ctxAs(ap.userId, 'GET', '/api/vendors');
      const v = await createVendor(adminA, { displayName: 'Sole Prop', is1099: true, taxId: '123-45-6789' });
      vendorId = v.id;
    });

    it('vendor tax IDs are masked for roles without the sensitive-data flag', async () => {
      expect((await getVendor(apCtx, vendorId)).taxId).toBe('***-**-6789');
      expect(JSON.stringify(await listVendors(apCtx))).not.toContain('123-45-6789');
      expect((await getVendor(adminA, vendorId)).taxId).toBe('123-45-6789');
    });

    it('a masked tax ID echoed back by an edit form never overwrites the real one', async () => {
      const before = await getVendor(apCtx, vendorId);
      await updateVendor(apCtx, vendorId, { notes: 'edited', taxId: before.taxId });
      expect((await getVendor(adminA, vendorId)).taxId).toBe('123-45-6789');
    });

    it('audit-trail snapshots mask tax IDs too', async () => {
      const [log] = await db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(and(eq(auditLogs.companyId, companyA), eq(auditLogs.entityType, 'vendor'), eq(auditLogs.entityId, vendorId)))
        .limit(1);
      const entry = await getAuditLog(apCtx, log.id);
      expect(JSON.stringify(entry)).not.toContain('123-45-6789');
      expect(JSON.stringify(await getAuditLog(adminA, log.id))).toContain('123-45-6789');
    });

    it('employee SSNs leave the payroll service masked without the flag', async () => {
      const e = await createEmployee(adminA, { firstName: 'Sam', lastName: 'Ssn', payType: 'hourly', payRate: 20 });
      await updateEmployee(adminA, e.id, { ssn: '111-22-3333' });
      const bk = await addUser(adminA, { name: 'Bea', login: 'bea', password: 'beapass123', roleKeys: ['accountant'] });
      const accCtx = await ctxAs(bk.userId, 'GET', '/api/employees');
      const list = await listEmployees(accCtx);
      expect(list.find((x) => x.id === e.id)?.ssn).toBe('***-**-3333');
      const pp = await addUser(adminA, { name: 'Pip', login: 'pip', password: 'pippass123', roleKeys: ['payroll_processor'] });
      const ppCtx = await ctxAs(pp.userId, 'GET', '/api/employees');
      expect((await listEmployees(ppCtx)).find((x) => x.id === e.id)?.ssn).toBe('111-22-3333');
    });

    it('reconciliation lists mask the bank account number', async () => {
      const [gl] = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.companyId, companyA), eq(accounts.type, 'asset')))
        .limit(1);
      const ba = await createBankAccount(adminA, { accountId: gl.id, bankName: 'Fix Bank', accountNumber: '998877665544' });
      await startReconciliation(adminA, { bankAccountId: ba.id, statementDate: new Date('2025-01-31'), statementBalance: '0' });
      const banker = await addUser(adminA, { name: 'Bo Bank', login: 'bobank', password: 'bobank1234', roleKeys: ['accountant'] });
      const bctx = await ctxAs(banker.userId, 'GET', '/api/reconciliations');
      expect(JSON.stringify(await listReconciliations(bctx))).not.toContain('998877665544');
      expect(JSON.stringify(await listReconciliations(adminA))).toContain('998877665544');
    });
  });

  // -------------------------------------------------------------------------
  describe('legacy requireRole call sites follow Enterprise roles', () => {
    it('custom-field definitions: Lists modify allowed, View-Only refused', async () => {
      const acc = await addUser(adminA, { name: 'Lia', login: 'lia', password: 'liapass123', roleKeys: ['bookkeeper'] });
      const ctx = await ctxAs(acc.userId, 'PATCH', '/api/custom-fields');
      expect(ctx.access?.permissions.lists).toContain('modify');
      await setCustomFieldDefinitions(ctx, { customer: [{ name: 'Region' }] });
      const vo = await addUser(adminA, { name: 'Vic', login: 'vic', password: 'vicpass123', roleKeys: ['view_only'] });
      // Built without access (legacy-style ctx): the guard resolves the role from the file.
      await expect(
        setCustomFieldDefinitions({ db, companyId: companyA, userId: vo.userId }, { customer: [] }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  // -------------------------------------------------------------------------
  describe('restore keeps the target file identity', () => {
    it("restoring an old backup that carries a secret keeps the target's .auth-secret/.file-id", async () => {
      fs.rmSync(RESTORE_DIR, { recursive: true, force: true });
      // A real (empty) company file: restore now opens and verifies the restored books.
      await getDb(RESTORE_DIR);
      await closeDb(RESTORE_DIR);
      fs.writeFileSync(path.join(RESTORE_DIR, '.auth-secret'), 'target-secret');
      fs.writeFileSync(path.join(RESTORE_DIR, '.file-id'), 'target-file-id');
      // Simulate a legacy archive that still contains another file's secret + id.
      const AdmZip = (await import('adm-zip')).default;
      const legacy = new AdmZip(createBackup('x', RESTORE_DIR).buffer);
      legacy.addFile('.auth-secret', Buffer.from('foreign-secret'));
      legacy.addFile('.file-id', Buffer.from('foreign-id'));
      await restoreBackup(legacy.toBuffer(), RESTORE_DIR);
      expect(fs.readFileSync(path.join(RESTORE_DIR, '.auth-secret'), 'utf8')).toBe('target-secret');
      expect(fs.readFileSync(path.join(RESTORE_DIR, '.file-id'), 'utf8')).toBe('target-file-id');
    });
  });

  it('login route: a request with no body is a 400', async () => {
    const { POST } = await import('@/app/api/auth/login/route');
    as(null, 'POST', '/api/auth/login');
    const res = await POST(new NextRequest('http://127.0.0.1/api/auth/login', { method: 'POST' }));
    expect(res.status).toBe(400);
  });
});
