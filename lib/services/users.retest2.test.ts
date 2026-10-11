/**
 * Re-test round 2 (tester): verifies the fixes for the round-1 failures under neighbouring
 * inputs and probes what sits right next to them:
 *  - per-company export masking: vendor tax IDs, audit-trail before/after JSON, role union
 *    (one flag but not the other), the manifest's `redacted` marker, Admin still gets full data
 *  - restore of a REDACTED export never stores a masked placeholder as a real SSN / TIN
 *  - target-company re-check: unknown / malformed ?companyId=, restore without 'delete'
 *  - requireFileAdmin: positive path (Admin of every company), Admin everywhere but deactivated
 *    in one, Admin in A + Full Access in B, auto-backup with a user session, restore body never
 *    read before the gate
 *  - masked-value writes on create: vendor (bullet form, API status) and bank account number
 *
 * Same hermetic pattern as users.retest.test.ts (real getServerContext + route handlers against
 * a temp PGlite dir, `next/headers` mocked).
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

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-team-users-retest2');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'team-users-retest2-secret';

import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, bankAccounts, employees, users, vendors } from '@/lib/db/schema';
import { createSessionToken, hashPassword, SESSION_COOKIE, UNLOCK_COOKIE } from '@/lib/auth';
import { COMPANY_COOKIE, getServerContext } from '@/lib/context';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { createCompany } from './company';
import { createBankAccount } from './bankAccounts';
import { createEmployee, updateEmployee } from './payroll';
import { createVendor, updateVendor } from './vendors';
import { createCompanyBackup, restoreCompanyBackup } from './backup';
import { ServiceError, type ServiceContext } from './_base';
import { addUser, updateUser } from './users';
import { getFileLockStatus, removeFilePassword } from './fileLock';
import { GET as companyBackupGET, POST as companyBackupPOST } from '@/app/api/backup/company/route';
import { GET as fullBackupGET, POST as fullBackupPOST } from '@/app/api/backup/route';
import { POST as autoBackupPOST } from '@/app/api/dashboard/auto-backup/route';
import { POST as fileLockPOST } from '@/app/api/file-lock/route';
import { POST as vendorsPOST } from '@/app/api/vendors/route';

let db: DB;
let companyA: string;
let ownerA: string;

const SSN = '123-45-6789';
const ACCT = '998877665544';
const TIN_OLD = '98-7654321';
const TIN_NEW = '11-2233445';

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
function req(url: string, init?: { method?: string; body?: string | Buffer; json?: boolean }) {
  return new NextRequest(`http://127.0.0.1${url}`, {
    method: init?.method ?? 'GET',
    headers: init?.json ? { 'content-type': 'application/json' } : undefined,
    body: init?.body as BodyInit | undefined,
  });
}
async function newUser(email: string, name: string, password: string) {
  const [u] = await db
    .insert(users)
    .values({ email, name, passwordHash: await hashPassword(password) })
    .returning();
  return u;
}
async function zipOf(res: Response) {
  const buf = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(buf);
  const text = zip
    .getEntries()
    .filter((e) => !e.isDirectory)
    .map((e) => zip.readAsText(e))
    .join('\n');
  const manifestEntry = zip.getEntry('bookkeeper-manifest.json');
  const manifest = manifestEntry ? JSON.parse(zip.readAsText(manifestEntry)) : null;
  return { buf, text, manifest };
}

describe('Users & Roles — re-test round 2', () => {
  let adminA: ServiceContext;
  let vendorId: string;

  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const owner = await newUser('olivia@a.local', 'Olivia A', 'ownerApass1');
    ownerA = owner.id;
    companyA = (await createCompany(db, { name: 'Alpha Co', ownerId: ownerA })).id;
    adminA = await ctxAs(ownerA, 'POST', '/api/users');

    // Sensitive data in company A: bank account number, employee SSN, vendor TIN changed once
    // (so the audit trail holds the old AND new TIN in its before/after JSON).
    const trusted = { db, companyId: companyA, userId: ownerA };
    const [gl] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.companyId, companyA), eq(accounts.type, 'asset')))
      .limit(1);
    await createBankAccount(trusted, { accountId: gl.id, bankName: 'Retest2 Bank', accountNumber: ACCT });
    const emp = await createEmployee(trusted, { firstName: 'Sam', lastName: 'Secret', payType: 'hourly', payRate: '20' });
    await updateEmployee(trusted, emp.id, { ssn: SSN });
    const v = await createVendor(trusted, { displayName: 'Tin Vendor LLC', taxId: TIN_OLD });
    vendorId = v.id;
    await updateVendor(trusted, vendorId, { taxId: TIN_NEW });
  });

  afterAll(async () => {
    try {
      if ((await getFileLockStatus(db)).enabled) await removeFilePassword(db, 'fileAdminPw99');
    } catch {
      /* best effort */
    }
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Runs FIRST, while every company in the file is owned by Olivia.
  describe('file-wide operations: positive path for the file Admin', () => {
    let aux: string;

    beforeAll(async () => {
      aux = (await createCompany(db, { name: 'Alpha Two', ownerId: ownerA, seedCoa: false })).id;
    });

    it('an Admin of EVERY company in the file can download the whole-file backup', async () => {
      as(ownerA, 'GET', '/api/backup');
      const res = await fullBackupGET(req('/api/backup'));
      expect(res.status).toBe(200);
      const { buf } = await zipOf(res);
      expect(buf.byteLength).toBeGreaterThan(0);
    });

    it('an Admin of EVERY company in the file can set (and then remove) the file password', async () => {
      as(ownerA, 'POST', '/api/file-lock');
      const res = await fileLockPOST(
        req('/api/file-lock', { method: 'POST', json: true, body: JSON.stringify({ action: 'set', password: 'fileAdminPw99' }) }),
      );
      const enabled = (await getFileLockStatus(db)).enabled;
      if (enabled) await removeFilePassword(db, 'fileAdminPw99');
      expect(res.status).toBe(200);
      expect(enabled).toBe(true);
    });

    it('the same Admin is refused once DEACTIVATED in one company of the file', async () => {
      // A second Admin in Alpha Two lets us deactivate Olivia there without tripping last-admin.
      const adminAux = await ctxAs(ownerA, 'POST', '/api/users', aux);
      const zed = await addUser(adminAux, { name: 'Zed', login: 'zed', password: 'zedpass123', roleKeys: ['admin'] });
      const zedCtx = await ctxAs(zed.userId, 'POST', '/api/users', aux);
      await updateUser(zedCtx, ownerA, { isActive: false });

      as(ownerA, 'GET', '/api/backup');
      const res = await fullBackupGET(req('/api/backup'));
      expect(res.status, 'deactivated in Alpha Two but still downloaded every company').toBe(403);

      as(ownerA, 'POST', '/api/file-lock');
      const lock = await fileLockPOST(
        req('/api/file-lock', { method: 'POST', json: true, body: JSON.stringify({ action: 'set', password: 'fileAdminPw99' }) }),
      );
      if ((await getFileLockStatus(db)).enabled) await removeFilePassword(db, 'fileAdminPw99');
      expect(lock.status).toBe(403);

      await updateUser(zedCtx, ownerA, { isActive: true });
    });

    it('Admin in A but only Full Access (not Admin) in another company → whole-file backup and auto-backup refused', async () => {
      const adminAux = await ctxAs(ownerA, 'POST', '/api/users', aux);
      const fay = await addUser(adminA, { name: 'Fay', login: 'fay', password: 'faypass123', roleKeys: ['admin'] });
      await addUser(adminAux, { name: 'Fay', login: 'fay', roleKeys: ['full_access'] });

      as(fay.userId, 'GET', '/api/backup');
      expect((await fullBackupGET(req('/api/backup'))).status).toBe(403);

      as(fay.userId, 'POST', '/api/dashboard/auto-backup');
      const auto = await autoBackupPOST(req('/api/dashboard/auto-backup', { method: 'POST' }));
      expect(auto.status, 'auto-backup hands a user session the same whole-file archive').toBe(403);
    });

    it('whole-file RESTORE by a non-file-Admin is refused before the body is even parsed', async () => {
      const fa = await addUser(adminA, { name: 'Finn', login: 'finn', password: 'finnpass123', roleKeys: ['full_access'] });
      as(fa.userId, 'POST', '/api/backup');
      const res = await fullBackupPOST(req('/api/backup', { method: 'POST', body: Buffer.from('not a zip') }));
      expect(res.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  describe('per-company export masking (fix verification + neighbours)', () => {
    it('External Accountant: no full SSN, account number, or vendor TIN anywhere — including audit-trail JSON', async () => {
      const ext = await addUser(adminA, { name: 'Ezra', login: 'ezra', password: 'ezrapass123', roleKeys: ['external_accountant'] });
      as(ext.userId, 'GET', '/api/backup/company');
      const res = await companyBackupGET(req('/api/backup/company'));
      expect(res.status).toBe(200);
      const { text, manifest } = await zipOf(res);
      expect(text).toContain('Tin Vendor LLC');
      expect(text).not.toContain(SSN);
      expect(text).not.toContain(ACCT);
      expect(text, 'current vendor TIN leaked').not.toContain(TIN_NEW);
      expect(text, 'old vendor TIN leaked via audit before/after values').not.toContain(TIN_OLD);
      expect(manifest?.redacted).toBe(true);
    });

    it('role union: SSN flag without the account-number flag → SSNs/TINs full, account numbers masked', async () => {
      const pu = await addUser(adminA, {
        name: 'Pia',
        login: 'pia',
        password: 'piapass123',
        roleKeys: ['external_accountant', 'payroll_processor'],
      });
      as(pu.userId, 'GET', '/api/backup/company');
      const res = await companyBackupGET(req('/api/backup/company'));
      expect(res.status).toBe(200);
      const { text, manifest } = await zipOf(res);
      expect(text).toContain(SSN);
      expect(text).toContain(TIN_NEW);
      expect(text).not.toContain(ACCT);
      expect(text).toContain('6789'); // masked form keeps the last 4 of SSN; account keeps 5544
      expect(text).toContain('5544');
      expect(manifest?.redacted).toBe(true);
    });

    it('the Admin still gets an unredacted export (no redacted marker)', async () => {
      as(ownerA, 'GET', '/api/backup/company');
      const res = await companyBackupGET(req('/api/backup/company'));
      expect(res.status).toBe(200);
      const { text, manifest } = await zipOf(res);
      expect(text).toContain(SSN);
      expect(text).toContain(ACCT);
      expect(text).toContain(TIN_NEW);
      expect(manifest?.redacted).toBeUndefined();
    });

    it('restoring a REDACTED export never stores a masked value as a real SSN / TIN', async () => {
      // A fresh company with no Users & Roles history (see the next test for why), exported with
      // the access of a role that has neither sensitive flag.
      const coId = (await createCompany(db, { name: 'Redact Co', ownerId: ownerA })).id;
      const trusted = { db, companyId: coId, userId: ownerA };
      const [gl] = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.companyId, coId), eq(accounts.type, 'asset')))
        .limit(1);
      await createBankAccount(trusted, { accountId: gl.id, bankName: 'Redact Bank', accountNumber: ACCT });
      const rae = await createEmployee(trusted, { firstName: 'Rae', lastName: 'Dact', payType: 'hourly', payRate: '20' });
      await updateEmployee(trusted, rae.id, { ssn: SSN });
      await createVendor(trusted, { displayName: 'Tin Vendor LLC', taxId: TIN_NEW });

      const { buffer: buf } = await createCompanyBackup(db, coId, {
        access: { flags: { sensitivePayroll: false, fullAccountNumbers: false, closedPeriod: false } },
      });
      const zipText = new AdmZip(buf).getEntries().map((e) => e.getData().toString('utf8')).join('\n');
      expect(zipText).not.toContain(SSN);
      expect(zipText).not.toContain(TIN_NEW);

      const restored = await restoreCompanyBackup(db, buf, { ownerId: ownerA, name: 'Alpha Redacted Restore' });
      const [emp] = await db.select().from(employees).where(eq(employees.companyId, restored.companyId));
      const [ven] = await db
        .select()
        .from(vendors)
        .where(and(eq(vendors.companyId, restored.companyId), eq(vendors.displayName, 'Tin Vendor LLC')));
      const [ba] = await db.select().from(bankAccounts).where(eq(bankAccounts.companyId, restored.companyId));
      expect(emp.ssn).toBeNull();
      expect(ven.taxId).toBeNull();
      expect(ba.accountNumber).not.toBe(ACCT);
    });

    it('an Admin per-company backup of a company whose Users & Roles were edited can be restored', async () => {
      // Every addUser / updateUser / createRole writes an audit row whose entityId is a user id or
      // a company_roles id — neither is part of the per-company export.
      const coId = (await createCompany(db, { name: 'Staffed Co', ownerId: ownerA, seedCoa: false })).id;
      const adminS = await ctxAs(ownerA, 'POST', '/api/users', coId);
      await addUser(adminS, { name: 'Stan', login: 'stan', password: 'stanpass123', roleKeys: ['bookkeeper'] });

      as(ownerA, 'GET', '/api/backup/company', coId);
      const res = await companyBackupGET(req(`/api/backup/company?companyId=${coId}`));
      expect(res.status).toBe(200);
      const { buf } = await zipOf(res);
      await expect(
        restoreCompanyBackup(db, buf, { ownerId: ownerA, name: 'Staffed Restore' }),
        'backup of any company that ever used Users & Roles cannot be restored',
      ).resolves.toMatchObject({ name: 'Staffed Restore' });
    });

    it('a malformed or unknown ?companyId= is refused with 4xx, never 500 and never data', async () => {
      const ext = await addUser(adminA, { name: 'Uma', login: 'uma', password: 'umapass123', roleKeys: ['admin'] });
      as(ext.userId, 'GET', '/api/backup/company');
      const unknown = await companyBackupGET(
        req('/api/backup/company?companyId=00000000-0000-4000-8000-000000000000'),
      );
      expect(unknown.status).toBe(403);
      as(ext.userId, 'GET', '/api/backup/company');
      const malformed = await companyBackupGET(req("/api/backup/company?companyId=x'%20OR%201=1--"));
      expect(malformed.status, 'malformed companyId crashed the export route').toBeGreaterThanOrEqual(400);
      expect(malformed.status, 'malformed companyId crashed the export route').toBeLessThan(500);
    });

    it('per-company RESTORE is refused for roles without File Utilities delete (External Accountant, View-Only)', async () => {
      for (const roleKey of ['external_accountant', 'view_only']) {
        const u = await addUser(adminA, {
          name: `R ${roleKey}`,
          login: `r-${roleKey}`,
          password: 'restorepass1',
          roleKeys: [roleKey],
        });
        as(u.userId, 'POST', '/api/backup/company');
        const res = await companyBackupPOST(
          req('/api/backup/company', { method: 'POST', body: Buffer.from('not a zip') }),
        );
        expect(res.status, `${roleKey} reached the restore body`).toBe(403);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('masked placeholders on create', () => {
    it.each([
      ['asterisk form', '***-**-6789'],
      ['bullet form', '•••••6789'],
      ['bare asterisks', '*********'],
    ])('createVendor rejects a masked tax ID (%s) with VALIDATION', async (_l, taxId) => {
      const ap = await addUser(adminA, { name: `Ap ${_l}`, login: `ap-${_l.replace(/\s/g, '')}`, password: 'appass1234', roleKeys: ['ap_clerk'] });
      const ctx = await ctxAs(ap.userId, 'POST', '/api/vendors');
      await expect(createVendor(ctx, { displayName: `Masked ${_l}`, taxId })).rejects.toMatchObject({
        code: 'VALIDATION',
      });
      const rows = await db
        .select()
        .from(vendors)
        .where(and(eq(vendors.companyId, companyA), eq(vendors.displayName, `Masked ${_l}`)));
      expect(rows).toHaveLength(0);
    });

    it('createVendor still accepts a real TIN, an empty TIN, and no TIN', async () => {
      const ctx = await ctxAs(ownerA, 'POST', '/api/vendors');
      const a = await createVendor(ctx, { displayName: 'Real TIN Co', taxId: '12-3456789' });
      const b = await createVendor(ctx, { displayName: 'No TIN Co' });
      expect(a.id).toBeTruthy();
      expect(b.id).toBeTruthy();
      const [row] = await db.select().from(vendors).where(eq(vendors.id, a.id));
      expect(row.taxId).toBe('12-3456789');
    });

    it('POST /api/vendors with a masked tax ID answers 400 (not 500) and stores nothing', async () => {
      as(ownerA, 'POST', '/api/vendors');
      const res = await vendorsPOST(
        req('/api/vendors', {
          method: 'POST',
          json: true,
          body: JSON.stringify({ displayName: 'Api Masked LLC', taxId: '***-**-1111' }),
        }),
      );
      expect(res.status).toBe(400);
      const rows = await db.select().from(vendors).where(eq(vendors.displayName, 'Api Masked LLC'));
      expect(rows).toHaveLength(0);
    });

    it('a Banking clerk (no full-account-number flag) cannot store a masked placeholder as a bank account number', async () => {
      const bk = await addUser(adminA, { name: 'Bea', login: 'bea', password: 'beapass123', roleKeys: ['banking'] });
      const ctx = await ctxAs(bk.userId, 'POST', '/api/bank-accounts');
      const [gl] = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.companyId, companyA), eq(accounts.type, 'asset')))
        .limit(1);
      try {
        await createBankAccount(ctx, { accountId: gl.id, bankName: 'Masked Copy Bank', accountNumber: '••••5544' });
      } catch (err) {
        expect((err as ServiceError).code).toBe('VALIDATION');
        return;
      }
      const [row] = await db
        .select()
        .from(bankAccounts)
        .where(and(eq(bankAccounts.companyId, companyA), eq(bankAccounts.bankName, 'Masked Copy Bank')));
      expect(row.accountNumber, 'masked placeholder persisted as the real account number').not.toMatch(/[*•]/);
    });
  });
});
