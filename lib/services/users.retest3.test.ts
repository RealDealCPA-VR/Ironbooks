/**
 * Re-test round 3 (tester): verifies the round-2 fixes under neighbouring inputs.
 *  - per-company backup → restore after EVERY kind of Users & Roles change (add, rename, role
 *    change, deactivate/reactivate, password reset, role create/edit/delete, closing date,
 *    company prefs), through the real route handlers; restoring the same file twice; the
 *    restoring user really is the Admin of the copy; books still balance; a broken archive
 *    rolls back completely; a tampered custom role cannot crash Users & Roles in the copy
 *  - malformed ids everywhere next to the fixed ?companyId=: uppercase valid UUID, braces,
 *    huge strings, malformed active-company cookie, /api/companies/select, /api/roles/[id],
 *    /api/users/[id]
 *  - masked bank account numbers through the API as a Banking clerk (no row written)
 *
 * Same hermetic pattern as users.retest2.test.ts (real getServerContext + route handlers against
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

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-team-users-retest3');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'team-users-retest3-secret';

import { getDb, closeDb, type DB } from '@/lib/db';
import {
  accounts, auditLogs, bankAccounts, companies, companyRoles, userCompanies, users,
} from '@/lib/db/schema';
import { createSessionToken, hashPassword, SESSION_COOKIE } from '@/lib/auth';
import { COMPANY_COOKIE, getServerContext } from '@/lib/context';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { createCompany, setClosingDate, updateCompany } from './company';
import { postJournalEntry } from './posting';
import { trialBalance } from './reports';
import { createBankAccount } from './bankAccounts';
import { restoreCompanyBackup, createCompanyBackup } from './backup';
import { resolveAccess } from './access';
import type { ServiceContext } from './_base';
import {
  activeAdminIds, addUser, createRole, deleteRole, listRoles, resetUserPassword, updateRole,
  updateUser,
} from './users';
import { GET as companyBackupGET, POST as companyBackupPOST } from '@/app/api/backup/company/route';
import { GET as bankAccountsGET, POST as bankAccountsPOST } from '@/app/api/bank-accounts/route';
import { POST as companiesSelectPOST } from '@/app/api/companies/select/route';
import { GET as rolesGET } from '@/app/api/roles/route';
import {
  DELETE as roleDELETE, GET as roleGET, PATCH as rolePATCH,
} from '@/app/api/roles/[id]/route';
import { GET as userGET, PATCH as userPATCH } from '@/app/api/users/[id]/route';

let db: DB;
let companyA: string;
let ownerA: string;

const ACCT = '440011223344';

function as(userId: string | null, method: string, routePath: string, companyId: string | null = companyA) {
  h.headers.clear();
  h.headers.set(ROUTE_PATH_HEADER, routePath);
  h.headers.set(ROUTE_METHOD_HEADER, method);
  h.cookies.clear();
  if (userId) {
    h.cookies.set(SESSION_COOKIE, createSessionToken(userId));
    if (companyId !== null) h.cookies.set(COMPANY_COOKIE, companyId);
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
const params = (id: string) => ({ params: Promise.resolve({ id }) });
async function newUser(email: string, name: string, password: string) {
  const [u] = await db
    .insert(users)
    .values({ email, name, passwordHash: await hashPassword(password) })
    .returning();
  return u;
}
async function companyCount() {
  return (await db.select({ id: companies.id }).from(companies)).length;
}

describe('Users & Roles — re-test round 3', () => {
  let adminA: ServiceContext;
  let glBank: string;
  let glEquity: string;
  let keptRoleId: string;
  let deletedRoleId: string;
  let stanId: string;
  let backupBuf: Buffer;

  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const owner = await newUser('olga@a3.local', 'Olga A', 'ownerApass1');
    ownerA = owner.id;
    companyA = (await createCompany(db, { name: 'Gamma Co', ownerId: ownerA })).id;
    adminA = await ctxAs(ownerA, 'POST', '/api/users');

    const trusted = { db, companyId: companyA, userId: ownerA };
    const accts = await db.select().from(accounts).where(eq(accounts.companyId, companyA));
    glBank = accts.find((a) => a.type === 'asset')!.id;
    glEquity = accts.find((a) => a.type === 'equity')!.id;
    await createBankAccount(trusted, { accountId: glBank, bankName: 'Gamma Bank', accountNumber: ACCT });
    // Some posted activity so the restored copy's trial balance has something to balance.
    await postJournalEntry(trusted, {
      date: new Date('2026-01-15'),
      description: 'Owner contribution',
      lines: [
        { accountId: glBank, debit: '1234.56', credit: '0' },
        { accountId: glEquity, debit: '0', credit: '1234.56' },
      ],
    });
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  describe('per-company backup/restore after every kind of Users & Roles change', () => {
    beforeAll(async () => {
      const kept = await createRole(adminA, { cloneFrom: 'ar_clerk', name: 'Collections' });
      keptRoleId = kept.key;
      await updateRole(adminA, keptRoleId, { description: 'Edited once' });
      const doomed = await createRole(adminA, { cloneFrom: 'bookkeeper', name: 'Temp Role' });
      deletedRoleId = doomed.key;
      await deleteRole(adminA, deletedRoleId); // audit points at a row that no longer exists

      const stan = await addUser(adminA, {
        name: 'Stan', login: 'stan-r3', password: 'stanpass123', roleKeys: ['bookkeeper'],
      });
      stanId = stan.userId;
      await updateUser(adminA, stanId, { name: 'Stanley', roleKeys: ['bookkeeper', keptRoleId] });
      await updateUser(adminA, stanId, { isActive: false });
      await updateUser(adminA, stanId, { isActive: true });
      await resetUserPassword(adminA, stanId, 'newstanpass456');
      await setClosingDate(adminA, { closingDate: '2025-12-31' });
      await updateCompany(adminA, { name: 'Gamma Co' });

      as(ownerA, 'GET', '/api/backup/company');
      const res = await companyBackupGET(req(`/api/backup/company?companyId=${companyA}`));
      expect(res.status).toBe(200);
      backupBuf = Buffer.from(await res.arrayBuffer());
    });

    it('the Admin can restore it through POST /api/backup/company (201)', async () => {
      as(ownerA, 'POST', '/api/backup/company');
      const res = await companyBackupPOST(
        req('/api/backup/company?name=Gamma%20Copy%201', { method: 'POST', body: backupBuf }),
      );
      const body = await res.json();
      expect(res.status, JSON.stringify(body)).toBe(201);
      const newId = body.companyId as string;

      // Roles: the kept custom role travelled, the deleted one did not.
      const roles = await db.select().from(companyRoles).where(eq(companyRoles.companyId, newId));
      expect(roles.map((r) => r.name).sort()).toEqual(['Collections']);
      expect(roles[0].description).toBe('Edited once');
      expect(roles[0].id).not.toBe(keptRoleId);

      // Audit trail: never points at the source company; the deleted role's id is kept verbatim.
      const logs = await db.select().from(auditLogs).where(eq(auditLogs.companyId, newId));
      expect(logs.length).toBeGreaterThan(5);
      expect(logs.map((l) => l.entityId)).not.toContain(companyA);
      expect(logs.map((l) => l.entityId)).toContain(deletedRoleId);
      // Every restored audit row is attributed to the restoring user (users are not exported).
      expect(new Set(logs.map((l) => l.userId))).toEqual(new Set([ownerA]));
    });

    it('the restoring user is the sole, active Admin of the copy; source members do not come along', async () => {
      const [copy] = await db.select().from(companies).where(eq(companies.name, 'Gamma Copy 1'));
      expect(copy).toBeTruthy();
      const members = await db.select().from(userCompanies).where(eq(userCompanies.companyId, copy.id));
      expect(members.map((m) => m.userId)).toEqual([ownerA]);
      const r = await resolveAccess(db, copy.id, ownerA);
      expect(r.member && r.active).toBe(true);
      expect(r.access.permissions.users).toEqual(expect.arrayContaining(['view', 'create', 'modify', 'delete']));
      expect(await activeAdminIds({ db, companyId: copy.id, userId: ownerA })).toEqual([ownerA]);
      const stanInCopy = await resolveAccess(db, copy.id, stanId);
      expect(stanInCopy.member).toBe(false);
    });

    it('the copy still balances to the cent and keeps the closing date', async () => {
      const [copy] = await db.select().from(companies).where(eq(companies.name, 'Gamma Copy 1'));
      const tb = await trialBalance({ db, companyId: copy.id, userId: ownerA });
      expect(tb.balanced).toBe(true);
      expect(tb.totalDebit).toBe(tb.totalCredit);
      expect(tb.totalDebit).toBe('1234.56');
      const settings = copy.settings as Record<string, unknown> | null;
      expect(JSON.stringify(settings ?? {})).toContain('2025-12-31');
    });

    it('restoring the SAME file twice works and the two copies share no role rows', async () => {
      const a = await restoreCompanyBackup(db, backupBuf, { ownerId: ownerA, name: 'Gamma Copy 2' });
      const b = await restoreCompanyBackup(db, backupBuf, { ownerId: ownerA, name: 'Gamma Copy 3' });
      expect(a.companyId).not.toBe(b.companyId);
      const ra = await db.select().from(companyRoles).where(eq(companyRoles.companyId, a.companyId));
      const rb = await db.select().from(companyRoles).where(eq(companyRoles.companyId, b.companyId));
      expect(ra).toHaveLength(1);
      expect(rb).toHaveLength(1);
      expect(ra[0].id).not.toBe(rb[0].id);
    });

    it('the Admin of the copy can manage its restored custom role (edit, assign, delete)', async () => {
      const [copy] = await db.select().from(companies).where(eq(companies.name, 'Gamma Copy 1'));
      const adminCopy = await ctxAs(ownerA, 'POST', '/api/users', copy.id);
      const [role] = await db.select().from(companyRoles).where(eq(companyRoles.companyId, copy.id));
      const listed = await listRoles(adminCopy);
      expect(listed.find((r) => r.key === role.id)?.name).toBe('Collections');
      await updateRole(adminCopy, role.id, { name: 'Collections 2' });
      const u = await addUser(adminCopy, {
        name: 'Copy Clerk', login: 'copy-clerk-r3', password: 'copyclerk123', roleKeys: [role.id],
      });
      expect(u.roleKeys).toContain(role.id);
    });

    it('a broken archive rolls back completely (no half-restored company left behind)', async () => {
      const zip = new AdmZip(backupBuf);
      const entry = zip.getEntries().find((e) => e.entryName !== 'bookkeeper-manifest.json')!;
      const data = JSON.parse(zip.readAsText(entry));
      // Valid until the very last table: an auditLogs row with a NULL (NOT NULL) action.
      data.tables.auditLogs.push({ ...data.tables.auditLogs[0], id: '00000000-0000-4000-8000-000000000001', action: null });
      zip.updateFile(entry.entryName, Buffer.from(JSON.stringify(data), 'utf8'));
      const before = await companyCount();
      const rolesBefore = (await db.select().from(companyRoles)).length;
      await expect(
        restoreCompanyBackup(db, zip.toBuffer(), { ownerId: ownerA, name: 'Gamma Broken' }),
      ).rejects.toBeTruthy();
      expect(await companyCount()).toBe(before);
      expect((await db.select().from(companyRoles)).length).toBe(rolesBefore);
    });

    it('a tampered custom role in an archive cannot break Users & Roles in the restored copy', async () => {
      const zip = new AdmZip(backupBuf);
      const entry = zip.getEntries().find((e) => e.entryName !== 'bookkeeper-manifest.json')!;
      const data = JSON.parse(zip.readAsText(entry));
      data.tables.companyRoles[0].permissions = { not_an_area: ['explode'], banking: 'full' };
      data.tables.companyRoles[0].flags = { sensitivePayroll: 'yes please' };
      zip.updateFile(entry.entryName, Buffer.from(JSON.stringify(data), 'utf8'));

      let restoredId: string | null = null;
      try {
        restoredId = (await restoreCompanyBackup(db, zip.toBuffer(), { ownerId: ownerA, name: 'Gamma Tampered' }))
          .companyId;
      } catch (e) {
        // Refusing the archive is fine — but only as a clean VALIDATION, not a crash.
        expect((e as { code?: string }).code).toBe('VALIDATION');
      }
      if (restoredId) {
        as(ownerA, 'GET', '/api/roles', restoredId);
        const res = await rolesGET();
        expect(res.status, 'Users & Roles page of the restored copy crashed').toBe(200);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('malformed / odd ids around the ?companyId= fix', () => {
    it('an UPPERCASE form of a valid company id still exports that company (200)', async () => {
      as(ownerA, 'GET', '/api/backup/company');
      const res = await companyBackupGET(req(`/api/backup/company?companyId=${companyA.toUpperCase()}`));
      expect(res.status).toBe(200);
    });

    it.each([
      ['empty', ''],
      ['braces', '{00000000-0000-4000-8000-000000000000}'],
      ['huge', 'a'.repeat(20000)],
      ['unicode', '%E2%80%A2%E2%80%A2%E2%80%A2'],
      ['null byte', '%00'],
    ])('?companyId= %s → 4xx, never 500', async (_label, value) => {
      as(ownerA, 'GET', '/api/backup/company');
      const res = await companyBackupGET(req(`/api/backup/company?companyId=${value}`));
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });

    it('a malformed active-company cookie never yields a 500 (falls back to a real membership or 4xx)', async () => {
      as(ownerA, 'GET', '/api/bank-accounts', "not-a-uuid' OR 1=1--");
      const res = await bankAccountsGET();
      expect(res.status, 'malformed bka_company cookie crashed getServerContext').not.toBe(500);
    });

    it('POST /api/companies/select with a malformed companyId → 4xx, never 500', async () => {
      as(ownerA, 'POST', '/api/companies/select');
      let status: number;
      try {
        const res = await companiesSelectPOST(
          req('/api/companies/select', { method: 'POST', json: true, body: JSON.stringify({ companyId: 'garbage' }) }),
        );
        status = res.status;
      } catch {
        status = 500; // unhandled throw in a route handler = 500 to the client
      }
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
    });

    it('GET/PATCH/DELETE /api/roles/<malformed id> → 4xx, never 500', async () => {
      as(ownerA, 'GET', '/api/roles/[id]');
      expect((await roleGET(req('/api/roles/garbage'), params('garbage'))).status).toBe(404);
      as(ownerA, 'PATCH', '/api/roles/[id]');
      const patch = await rolePATCH(
        req('/api/roles/garbage', { method: 'PATCH', json: true, body: JSON.stringify({ name: 'X' }) }),
        params('garbage'),
      );
      expect.soft(patch.status, 'PATCH /api/roles/garbage').toBeLessThan(500);
      expect(patch.status).toBeGreaterThanOrEqual(400);
      as(ownerA, 'DELETE', '/api/roles/[id]');
      const del = await roleDELETE(req('/api/roles/garbage', { method: 'DELETE' }), params('garbage'));
      expect.soft(del.status, 'DELETE /api/roles/garbage').toBeLessThan(500);
      expect(del.status).toBeGreaterThanOrEqual(400);
    });

    it('GET/PATCH /api/users/<malformed id> → 4xx, never 500', async () => {
      as(ownerA, 'GET', '/api/users/[id]');
      expect((await userGET(req('/api/users/garbage'), params('garbage'))).status).toBe(404);
      as(ownerA, 'PATCH', '/api/users/[id]');
      const patch = await userPATCH(
        req('/api/users/garbage', { method: 'PATCH', json: true, body: JSON.stringify({ isActive: false }) }),
        params('garbage'),
      );
      expect(patch.status).toBeGreaterThanOrEqual(400);
      expect(patch.status).toBeLessThan(500);
      as(ownerA, 'PATCH', '/api/users/[id]');
      const legacy = await userPATCH(
        req('/api/users/garbage', { method: 'PATCH', json: true, body: JSON.stringify({ role: 'viewer' }) }),
        params('garbage'),
      );
      expect(legacy.status, 'legacy role PATCH on a malformed user id').toBeGreaterThanOrEqual(400);
      expect(legacy.status).toBeLessThan(500);
    });
  });

  // -------------------------------------------------------------------------
  describe('masked bank account numbers through the API', () => {
    let clerkId: string;

    beforeAll(async () => {
      const clerk = await addUser(adminA, {
        name: 'Bea Banker', login: 'bea-r3', password: 'beapass1234', roleKeys: ['banking'],
      });
      clerkId = clerk.userId;
    });

    it('the Banking clerk sees the existing number masked (precondition)', async () => {
      as(clerkId, 'GET', '/api/bank-accounts');
      const res = await bankAccountsGET();
      expect(res.status).toBe(200);
      const rows = (await res.json()) as { accountNumber: string }[];
      expect(rows.some((r) => r.accountNumber === `••••${ACCT.slice(-4)}`)).toBe(true);
      expect(JSON.stringify(rows)).not.toContain(ACCT);
    });

    it.each(['••••3344', '***3344', '12••34', ' ••••3344 '])(
      'POST /api/bank-accounts with masked %j → 400 and no row written',
      async (masked) => {
        const before = (await db.select().from(bankAccounts).where(eq(bankAccounts.companyId, companyA))).length;
        as(clerkId, 'POST', '/api/bank-accounts');
        const res = await bankAccountsPOST(
          req('/api/bank-accounts', {
            method: 'POST', json: true,
            body: JSON.stringify({ accountId: glBank, bankName: 'Copy Bank', accountNumber: masked }),
          }),
        );
        expect(res.status).toBe(400);
        const after = (await db.select().from(bankAccounts).where(eq(bankAccounts.companyId, companyA))).length;
        expect(after).toBe(before);
      },
    );

    it('the clerk can still create one with a real number, and it is masked back to them', async () => {
      as(clerkId, 'POST', '/api/bank-accounts');
      const res = await bankAccountsPOST(
        req('/api/bank-accounts', {
          method: 'POST', json: true,
          body: JSON.stringify({ accountId: glBank, bankName: 'Real Bank', accountNumber: '777766665555' }),
        }),
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.accountNumber).toBe('••••5555');
      const [row] = await db
        .select()
        .from(bankAccounts)
        .where(and(eq(bankAccounts.companyId, companyA), eq(bankAccounts.bankName, 'Real Bank')));
      expect(row.accountNumber).toBe('777766665555');
    });

    it('a malformed GL account id on POST /api/bank-accounts → 4xx, never 500', async () => {
      as(clerkId, 'POST', '/api/bank-accounts');
      const res = await bankAccountsPOST(
        req('/api/bank-accounts', {
          method: 'POST', json: true,
          body: JSON.stringify({ accountId: 'nope', bankName: 'B', accountNumber: '123456789' }),
        }),
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });

    it('a per-company export by a role WITHOUT the account-number flag never contains the full number', async () => {
      const exporter = await createRole(adminA, {
        name: 'Exporter R3',
        permissions: { file_utilities: ['view', 'create'] },
        flags: { sensitivePayroll: false, fullAccountNumbers: false, closedPeriod: false },
      });
      const ex = await addUser(adminA, {
        name: 'Exa', login: 'exa-r3', password: 'exapass1234', roleKeys: [exporter.key],
      });
      as(ex.userId, 'GET', '/api/backup/company');
      const res = await companyBackupGET(req('/api/backup/company'));
      expect(res.status).toBe(200);
      const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
      const text = zip.getEntries().map((e) => zip.readAsText(e)).join('\n');
      expect(text).not.toContain(ACCT);
      expect(text).not.toContain('777766665555');
      // And the trusted (no access) export still has it — masking is per caller, not destructive.
      const full = await createCompanyBackup(db, companyA);
      const z2 = new AdmZip(full.buffer);
      expect(z2.getEntries().map((e) => z2.readAsText(e)).join('\n')).toContain(ACCT);
    });
  });
});
