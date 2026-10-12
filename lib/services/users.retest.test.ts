/**
 * Re-test round 1 (tester): verifies the doer's fixes for the previously reported failures hold
 * under neighbouring inputs, and probes new bypasses next to them:
 *  - shared logins: attach-with-password, name-only rename, self-service
 *  - closing date for External Accountant / custom roles (requireEffectivePermission)
 *  - getSessionGate on the other 'self' routes (2FA, company select, archive) while locked /
 *    demoted / deactivated
 *  - login body validation + login normalization regression
 *  - masking bypasses through File Utilities (per-company backup JSON) and masked-value writes
 *  - cross-company reach of per-company backup (deactivated / view-only in the target company)
 *  - file-wide operations (whole-dir backup, file password) by an Admin of only one company
 *
 * Same hermetic pattern as users.adversarial.test.ts (real getServerContext + route handlers
 * against a temp PGlite dir, `next/headers` mocked).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import AdmZip from 'adm-zip';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  headers: new Map<string, string>(),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (h.cookies.has(n) ? { name: n, value: h.cookies.get(n)! } : undefined),
    set: () => undefined,
    delete: () => undefined,
  }),
  headers: async () => new Headers([...h.headers.entries()]),
}));

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-team-users-retest');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'team-users-retest-secret';

import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, companies, employees, users, vendors } from '@/lib/db/schema';
import { createSessionToken, hashPassword, verifyPassword, SESSION_COOKIE, UNLOCK_COOKIE } from '@/lib/auth';
import { COMPANY_COOKIE, getServerContext } from '@/lib/context';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { createCompany, setClosingDate } from './company';
import { createBankAccount } from './bankAccounts';
import { createEmployee, updateEmployee } from './payroll';
import { createVendor } from './vendors';
import { ServiceError, type ServiceContext } from './_base';
import { addUser, createRole, updateUser } from './users';
import { setFilePassword, removeFilePassword, getFileLockStatus } from './fileLock';
import { DELETE as companyDELETE } from '@/app/api/companies/[id]/route';
import { POST as selectPOST } from '@/app/api/companies/select/route';
import { POST as twoFaSetupPOST } from '@/app/api/auth/2fa/setup/route';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { GET as companyBackupGET } from '@/app/api/backup/company/route';
import { GET as fullBackupGET } from '@/app/api/backup/route';
import { POST as fileLockPOST } from '@/app/api/file-lock/route';

let db: DB;
let companyA: string;
let ownerA: string;

function as(userId: string | null, method: string, routePath: string, companyId = companyA) {
  h.headers.clear();
  h.headers.set(ROUTE_PATH_HEADER, routePath);
  h.headers.set(ROUTE_METHOD_HEADER, method);
  const unlock = h.cookies.get(UNLOCK_COOKIE);
  h.cookies.clear();
  if (unlock) h.cookies.set(UNLOCK_COOKIE, unlock);
  if (userId) {
    h.cookies.set(SESSION_COOKIE, createSessionToken(userId));
    h.cookies.set(COMPANY_COOKIE, companyId);
  }
}
async function ctxAs(userId: string, method: string, routePath: string, companyId = companyA) {
  as(userId, method, routePath, companyId);
  return getServerContext();
}
function req(url: string, init?: { method?: string; body?: string }) {
  return new NextRequest(`http://127.0.0.1${url}`, {
    method: init?.method ?? 'GET',
    headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init?.body,
  });
}
async function newUser(email: string, name: string, password: string) {
  const [u] = await db
    .insert(users)
    .values({ email, name, passwordHash: await hashPassword(password) })
    .returning();
  return u;
}
async function zipJson(res: Response): Promise<string> {
  const buf = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(buf);
  return zip
    .getEntries()
    .filter((e) => !e.isDirectory)
    .map((e) => zip.readAsText(e))
    .join('\n');
}

describe('Users & Roles — re-test round 1', () => {
  let adminA: ServiceContext;
  let bobId: string;
  let companyB: string;

  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const owner = await newUser('olivia@a.local', 'Olivia A', 'ownerApass1');
    ownerA = owner.id;
    companyA = (await createCompany(db, { name: 'Alpha Co', ownerId: ownerA })).id;
    adminA = await ctxAs(ownerA, 'POST', '/api/users');
    const bob = await newUser('bob@b.local', 'Bob B', 'bobBpass123');
    bobId = bob.id;
    companyB = (await createCompany(db, { name: 'Bravo Co', ownerId: bobId, seedCoa: false })).id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  describe('shared logins (fix verification)', () => {
    it("attaching another company's Admin login WITH a password never changes that password", async () => {
      const attached = await addUser(adminA, {
        name: 'Bob',
        login: '  BOB@B.local ',
        password: 'hijackPass99',
        roleKeys: ['view_only'],
      });
      expect(attached.userId).toBe(bobId);
      const [row] = await db.select().from(users).where(eq(users.id, bobId));
      expect(await verifyPassword('bobBpass123', row.passwordHash)).toBe(true);
      expect(await verifyPassword('hijackPass99', row.passwordHash)).toBe(false);
    });

    it("a name-only change of company B's Admin from company A is refused too", async () => {
      await expect(updateUser(adminA, bobId, { name: 'Bob (owned by A)' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const [row] = await db.select().from(users).where(eq(users.id, bobId));
      expect(row.name).toBe('Bob B');
    });

    it('a no-op rename (same login, different case/whitespace) is not treated as a change', async () => {
      const u = await updateUser(adminA, bobId, { login: ' Bob@B.LOCAL ', name: 'Bob B' });
      expect(u.login).toBe('bob@b.local');
    });

    it('roles can still be changed for the shared user inside company A (company-scoped)', async () => {
      const u = await updateUser(adminA, bobId, { roleKeys: ['reports_only'] });
      expect(u.roles.map((r) => r.key)).toEqual(['reports_only']);
      // … and that never touched Bob's Admin seat in B.
      const bCtx = await ctxAs(bobId, 'GET', '/api/users', companyB);
      expect(bCtx.companyId).toBe(companyB);
      expect(bCtx.access?.isAdmin).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('closing date follows Enterprise roles (fix verification)', () => {
    it('External Accountant (closing: view+modify) can set the closing date', async () => {
      const ext = await addUser(adminA, { name: 'Xena', login: 'xena', password: 'xenapass123', roleKeys: ['external_accountant'] });
      const ctx = await ctxAs(ext.userId, 'PATCH', '/api/company/closing-date');
      const res = await setClosingDate(ctx, { closingDate: '2024-06-30' });
      expect(res.closingDate).toBe('2024-06-30');
    });

    it('a custom role with only Closing Date: modify can set it; one with view only cannot', async () => {
      const closer = await createRole(adminA, { name: 'Closer', permissions: { closing: ['view', 'modify'] }, flags: {} });
      const peeker = await createRole(adminA, { name: 'Closing Peeker', permissions: { closing: ['view'] }, flags: {} });
      const c = await addUser(adminA, { name: 'Cleo', login: 'cleo', password: 'cleopass123', roleKeys: [closer.key] });
      const p = await addUser(adminA, { name: 'Pete', login: 'pete', password: 'petepass123', roleKeys: [peeker.key] });
      const cCtx = await ctxAs(c.userId, 'PATCH', '/api/company/closing-date');
      expect((await setClosingDate(cCtx, { closingDate: '2024-07-31' })).closingDate).toBe('2024-07-31');
      // Service-level check holds even when the route map is bypassed (ctx for another path).
      const pCtx = await ctxAs(p.userId, 'GET', '/api/company');
      await expect(setClosingDate(pCtx, { closingDate: '2099-01-01' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  // -------------------------------------------------------------------------
  describe("getSessionGate on the other 'self' routes", () => {
    it('2FA setup and company select are refused while the file is locked (no unlock cookie)', async () => {
      await setFilePassword(db, 'filepass77');
      try {
        h.cookies.delete(UNLOCK_COOKIE);
        as(ownerA, 'POST', '/api/auth/2fa/setup');
        const setup = await twoFaSetupPOST();
        expect(setup.status, '2FA secret issued while the file is locked').toBe(403);
        const [row] = await db.select().from(users).where(eq(users.id, ownerA));
        expect(row.totpSecret ?? null).toBeNull();

        as(ownerA, 'POST', '/api/companies/select');
        const sel = await selectPOST(req('/api/companies/select', { method: 'POST', body: JSON.stringify({ companyId: companyA }) }));
        expect(sel.status, 'company selected while the file is locked').toBe(403);
      } finally {
        await removeFilePassword(db, 'filepass77');
      }
    });

    it('a creator demoted to View-Only can no longer ARCHIVE the company either', async () => {
      const co = await createCompany(db, { name: 'Echo Co', ownerId: ownerA, seedCoa: false });
      const adminE = await ctxAs(ownerA, 'POST', '/api/users', co.id);
      const other = await addUser(adminE, { name: 'Ed', login: 'ed', password: 'edpass1234', roleKeys: ['admin'] });
      const edCtx = await ctxAs(other.userId, 'PATCH', `/api/users/${ownerA}`, co.id);
      await updateUser(edCtx, ownerA, { roleKeys: ['view_only'] });

      as(ownerA, 'DELETE', `/api/companies/${co.id}`, co.id);
      const res = await companyDELETE(req(`/api/companies/${co.id}?confirm=${encodeURIComponent('Echo Co')}`, { method: 'DELETE' }), {
        params: Promise.resolve({ id: co.id }),
      });
      expect(res.status, 'view-only creator archived the company').toBe(403);
      const [row] = await db.select().from(companies).where(eq(companies.id, co.id));
      expect((row.settings as { archived?: boolean } | null)?.archived ?? false).toBe(false);
    });

    it("a deactivated member cannot select that company even with another company's live session", async () => {
      const co = await createCompany(db, { name: 'Foxtrot Co', ownerId: ownerA, seedCoa: false });
      const adminF = await ctxAs(ownerA, 'POST', '/api/users', co.id);
      const fay = await addUser(adminA, { name: 'Fay', login: 'fay', password: 'faypass123', roleKeys: ['bookkeeper'] });
      await addUser(adminF, { name: 'Fay', login: 'fay', roleKeys: ['bookkeeper'] });
      await updateUser(adminF, fay.userId, { isActive: false });
      as(fay.userId, 'POST', '/api/companies/select');
      const res = await selectPOST(req('/api/companies/select', { method: 'POST', body: JSON.stringify({ companyId: co.id }) }));
      expect(res.status).toBe(403);
      // … but the session still works for her active company.
      const ctx = await ctxAs(fay.userId, 'GET', '/api/customers', co.id);
      expect(ctx.companyId).toBe(companyA);
    });
  });

  // -------------------------------------------------------------------------
  describe('login route (fix verification)', () => {
    async function login(body: string) {
      h.cookies.clear();
      h.headers.clear();
      return loginPOST(req('/api/auth/login', { method: 'POST', body }));
    }

    it.each([
      ['non-string password', JSON.stringify({ email: 'olivia@a.local', password: 12345678 })],
      ['array body', '[]'],
      ['null body', 'null'],
      ['invalid JSON', '{"email":'],
      ['email object', JSON.stringify({ email: { $ne: '' }, password: 'x' })],
      ['oversized email', JSON.stringify({ email: 'a'.repeat(5000), password: 'x' })],
    ])('%s → 400', async (_label, body) => {
      const res = await login(body);
      expect(res.status).toBe(400);
    });

    it('still accepts a login typed with surrounding spaces and upper case', async () => {
      const res = await login(JSON.stringify({ email: '  OLIVIA@A.LOCAL ', password: 'ownerApass1' }));
      expect(res.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  describe('sensitive data through File Utilities and write paths', () => {
    let empId: string;

    beforeAll(async () => {
      const [gl] = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.companyId, companyA), eq(accounts.type, 'asset')))
        .limit(1);
      await createBankAccount({ db, companyId: companyA, userId: ownerA }, {
        accountId: gl.id,
        bankName: 'Retest Bank',
        accountNumber: '998877665544',
      });
      const trusted = { db, companyId: companyA, userId: ownerA };
      const emp = await createEmployee(trusted, { firstName: 'Sam', lastName: 'Secret', payType: 'hourly', payRate: '20' });
      empId = emp.id;
      await updateEmployee(trusted, empId, { ssn: '123-45-6789' });
    });

    it('a per-company backup downloaded by a role WITHOUT the sensitive flags has no full SSN / account number', async () => {
      // External Accountant: file_utilities view/create/print, no sensitivePayroll, no fullAccountNumbers.
      const ext = await addUser(adminA, { name: 'Ezra', login: 'ezra', password: 'ezrapass123', roleKeys: ['external_accountant'] });
      as(ext.userId, 'GET', '/api/backup/company');
      const res = await companyBackupGET(req('/api/backup/company'));
      expect(res.status).toBe(200);
      const text = await zipJson(res);
      expect(text).toContain('Sam'); // it really is the company's data
      expect(text, 'full SSN shipped to a role without "view sensitive payroll data"').not.toContain('123-45-6789');
      expect(text, 'full bank account number shipped to a role without "view full account numbers"').not.toContain('998877665544');
    });

    it('an A/P clerk cannot store a masked placeholder as a vendor tax ID on create', async () => {
      const ap = await addUser(adminA, { name: 'Abe', login: 'abe', password: 'abepass123', roleKeys: ['ap_clerk'] });
      const ctx = await ctxAs(ap.userId, 'POST', '/api/vendors');
      try {
        await createVendor(ctx, { displayName: 'Masked Echo LLC', taxId: '***-**-6789' });
      } catch (err) {
        expect((err as ServiceError).code).toBe('VALIDATION');
        return;
      }
      const [row] = await db
        .select()
        .from(vendors)
        .where(and(eq(vendors.companyId, companyA), eq(vendors.displayName, 'Masked Echo LLC')));
      expect(row.taxId ?? '', 'masked tax ID persisted as the real TIN').not.toMatch(/[*•]/);
    });

    it('an Accountant (no SSN flag) editing an employee never wipes or replaces the stored SSN', async () => {
      const acc = await addUser(adminA, { name: 'Ada', login: 'ada', password: 'adapass123', roleKeys: ['accountant'] });
      const ctx = await ctxAs(acc.userId, 'PATCH', `/api/employees/${empId}`);
      const out = await updateEmployee(ctx, empId, { payRate: '21' });
      expect(JSON.stringify(out)).not.toContain('123-45-6789');
      await expect(updateEmployee(ctx, empId, { ssn: '***-**-6789' })).rejects.toMatchObject({ code: 'VALIDATION' });
      const [row] = await db.select().from(employees).where(eq(employees.id, empId));
      expect(row.ssn).toBe('123-45-6789');
    });
  });

  // -------------------------------------------------------------------------
  describe('cross-company reach of File Utilities', () => {
    it("per-company backup of company B is refused for a user DEACTIVATED in B (active Accountant in A)", async () => {
      const co = await createCompany(db, { name: 'Golf Co', ownerId: ownerA, seedCoa: false });
      const adminG = await ctxAs(ownerA, 'POST', '/api/users', co.id);
      const gus = await addUser(adminA, { name: 'Gus', login: 'gus', password: 'guspass123', roleKeys: ['accountant'] });
      await addUser(adminG, { name: 'Gus', login: 'gus', roleKeys: ['accountant'] });
      await updateUser(adminG, gus.userId, { isActive: false });

      as(gus.userId, 'GET', '/api/backup/company');
      const res = await companyBackupGET(req(`/api/backup/company?companyId=${co.id}`));
      expect(res.status, 'deactivated user exported every row of the company they were removed from').toBe(403);
    });

    it('per-company backup of company B is refused for a View-Only member of B (File Utilities only in A)', async () => {
      const co = await createCompany(db, { name: 'Hotel Co', ownerId: ownerA, seedCoa: false });
      const adminH = await ctxAs(ownerA, 'POST', '/api/users', co.id);
      const hal = await addUser(adminA, { name: 'Hal', login: 'hal', password: 'halpass123', roleKeys: ['accountant'] });
      await addUser(adminH, { name: 'Hal', login: 'hal', roleKeys: ['view_only'] });

      as(hal.userId, 'GET', '/api/backup/company');
      const res = await companyBackupGET(req(`/api/backup/company?companyId=${co.id}`));
      expect(res.status, "View-Only in B exported B's books using A's File Utilities permission").toBe(403);
    });

    it('a whole-file backup (every company in the data dir) is refused to a user who is not in all of them', async () => {
      // Accountant of A only; Bravo Co (Bob's) lives in the same data dir.
      const ivy = await addUser(adminA, { name: 'Ivy', login: 'ivy', password: 'ivypass123', roleKeys: ['accountant'] });
      as(ivy.userId, 'GET', '/api/backup');
      const res = await fullBackupGET(req('/api/backup'));
      expect(res.status, "whole data-dir backup (incl. company B's books) handed to a company-A-only Accountant").toBe(403);
    });

    it("an Admin of company A alone cannot set the FILE password that locks company B's users out", async () => {
      // adminA is not a member of Bravo Co.
      as(ownerA, 'POST', '/api/file-lock');
      const res = await fileLockPOST(req('/api/file-lock', { method: 'POST', body: JSON.stringify({ action: 'set', password: 'lockOutB99' }) }));
      const status = await getFileLockStatus(db);
      if (status.enabled) await removeFilePassword(db, 'lockOutB99');
      expect(res.status, "company A's Admin locked every company in the file").toBe(403);
    });
  });
});
