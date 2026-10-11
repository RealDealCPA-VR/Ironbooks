/**
 * Adversarial QA tests for Users & Roles (team users, tester pass).
 *
 * Same hermetic pattern as users.test.ts: real getServerContext + route handlers against a
 * temp PGlite file with `next/headers` mocked. These target bypasses and edge cases the doer's
 * suite does not cover: cross-company account takeover through shared logins, company-file
 * management routes that skip the central context (file lock, demoted/deactivated creator),
 * full bank account numbers in reconciliation responses, route-map vs. legacy-role
 * inconsistencies (closing date), backups leaking the session signing secret, malformed login
 * bodies, /api/auth/me permissions, and cross-company custom-role isolation.
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
  }),
  headers: async () => new Headers([...h.headers.entries()]),
}));

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-team-users-adv');
const BACKUP_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-team-users-adv-backup');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'team-users-adv-secret';

import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, companies, users } from '@/lib/db/schema';
import { createSessionToken, hashPassword, verifyPassword, SESSION_COOKIE, UNLOCK_COOKIE } from '@/lib/auth';
import { COMPANY_COOKIE, getServerContext } from '@/lib/context';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER, apiRuleFor, PAGE_AREAS, pageAreasFor } from '@/lib/permissions/routes';
import { createCompany, setClosingDate } from './company';
import { createBankAccount } from './bankAccounts';
import { createBackup } from './backup';
import { ServiceError, type ServiceContext } from './_base';
import { activeAdminIds, addUser, createRole, deleteRole, resetUserPassword, updateRole, updateUser } from './users';
import { setFilePassword, removeFilePassword } from './fileLock';
import { GET as companiesGET, POST as companiesPOST } from '@/app/api/companies/route';
import { PATCH as companyPATCH } from '@/app/api/companies/[id]/route';
import { GET as reconInfoGET } from '@/app/api/reconciliations/info/route';
import { GET as bankAccountsGET } from '@/app/api/bank-accounts/route';
import { GET as meGET } from '@/app/api/auth/me/route';
import { POST as loginPOST } from '@/app/api/auth/login/route';

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

describe('Users & Roles — adversarial', () => {
  let adminA: ServiceContext;

  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const owner = await newUser('olivia@a.local', 'Olivia A', 'ownerApass1');
    ownerA = owner.id;
    const co = await createCompany(db, { name: 'Alpha Co', ownerId: ownerA }); // seeds the CoA
    companyA = co.id;
    adminA = await ctxAs(ownerA, 'POST', '/api/users');
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  describe('cross-company isolation inside one company file', () => {
    let bobId: string;
    let companyB: string;

    beforeAll(async () => {
      const bob = await newUser('bob@b.local', 'Bob B', 'bobBpass123');
      bobId = bob.id;
      companyB = (await createCompany(db, { name: 'Bravo Co', ownerId: bobId, seedCoa: false })).id;
    });

    it("an Admin of company A cannot reset the password of company B's Admin by attaching their login", async () => {
      // Attaching an existing login needs no password (by design) …
      const attached = await addUser(adminA, { name: 'Bob', login: 'bob@b.local', roleKeys: ['view_only'] });
      expect(attached.userId).toBe(bobId);
      // … but resetting it changes Bob's ONE password, which also unlocks his Admin seat in B.
      let threw = false;
      try {
        await resetUserPassword(adminA, bobId, 'pwnedByA123');
      } catch (err) {
        threw = true;
        expect((err as ServiceError).code).toBe('FORBIDDEN');
      }
      const [row] = await db.select().from(users).where(eq(users.id, bobId));
      expect(await verifyPassword('bobBpass123', row.passwordHash), 'Bob (Admin of B) password was overwritten by A').toBe(true);
      expect(threw).toBe(true);
    });

    it("an Admin of company A cannot rename the shared login of company B's Admin", async () => {
      await expect(updateUser(adminA, bobId, { login: 'bob-hijacked' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const [row] = await db.select().from(users).where(eq(users.id, bobId));
      expect(row.email).toBe('bob@b.local');
    });

    it("custom roles of company B can't be assigned, edited or deleted from company A", async () => {
      const bobCtx = await ctxAs(bobId, 'POST', '/api/roles', companyB);
      expect(bobCtx.companyId).toBe(companyB);
      const roleB = await createRole(bobCtx, { name: 'B Only', permissions: { banking: ['full'] }, flags: {} });
      const u = await addUser(adminA, { name: 'Ula', login: 'ula', password: 'ulapass123', roleKeys: ['sales'] });
      await expect(updateUser(adminA, u.userId, { roleKeys: [roleB.key] })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(updateRole(adminA, roleB.key, { name: 'Stolen' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(deleteRole(adminA, roleB.key)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('a session whose company cookie names a company the user is not in never lands in it', async () => {
      const u = await addUser(adminA, { name: 'Nia', login: 'nia', password: 'niapass123', roleKeys: ['admin'] });
      const ctx = await ctxAs(u.userId, 'GET', '/api/users', companyB);
      expect(ctx.companyId).toBe(companyA);
    });
  });

  // -------------------------------------------------------------------------
  describe('company-file management routes (outside getServerContext)', () => {
    it('a creator demoted to View-Only can no longer rename the company', async () => {
      const co = await createCompany(db, { name: 'Charlie Co', ownerId: ownerA, seedCoa: false });
      const adminC = await ctxAs(ownerA, 'POST', '/api/users', co.id);
      expect(adminC.companyId).toBe(co.id);
      const other = await addUser(adminC, { name: 'Cal', login: 'cal', password: 'calpass123', roleKeys: ['admin'] });
      const calCtx = await ctxAs(other.userId, 'PATCH', `/api/users/${ownerA}`, co.id);
      await updateUser(calCtx, ownerA, { roleKeys: ['view_only'] });

      as(ownerA, 'PATCH', `/api/companies/${co.id}`, co.id);
      const res = await companyPATCH(req(`/api/companies/${co.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Renamed by viewer' }) }), {
        params: Promise.resolve({ id: co.id }),
      });
      expect(res.status, 'view-only creator renamed the company').toBe(403);
      const [row] = await db.select().from(companies).where(eq(companies.id, co.id));
      expect(row.name).toBe('Charlie Co');
    });

    it('a DEACTIVATED Admin can no longer rename the company', async () => {
      const co = await createCompany(db, { name: 'Delta Co', ownerId: ownerA, seedCoa: false });
      const adminD = await ctxAs(ownerA, 'POST', '/api/users', co.id);
      const dee = await addUser(adminD, { name: 'Dee', login: 'dee', password: 'deepass123', roleKeys: ['admin'] });
      await updateUser(adminD, dee.userId, { isActive: false });

      as(dee.userId, 'PATCH', `/api/companies/${co.id}`, co.id);
      const res = await companyPATCH(req(`/api/companies/${co.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Renamed by deactivated' }) }), {
        params: Promise.resolve({ id: co.id }),
      });
      expect(res.status, 'deactivated admin renamed the company').toBe(403);
    });

    it('a user deactivated everywhere cannot create a new company in the file with their old session', async () => {
      const zed = await addUser(adminA, { name: 'Zed', login: 'zed', password: 'zedpass123', roleKeys: ['bookkeeper'] });
      await updateUser(adminA, zed.userId, { isActive: false });
      as(zed.userId, 'POST', '/api/companies');
      const res = await companiesPOST(req('/api/companies', { method: 'POST', body: JSON.stringify({ name: 'Zed Inc' }) }));
      expect(res.status, 'deactivated user created (and became Admin of) a new company').toBeGreaterThanOrEqual(400);
    });

    it('the company-file password also gates /api/companies (list, rename)', async () => {
      await setFilePassword(db, 'filepass99');
      try {
        h.cookies.delete(UNLOCK_COOKIE);
        as(ownerA, 'GET', '/api/companies');
        const list = await companiesGET(req('/api/companies'));
        expect(list.status, 'company list served while the file is locked').toBe(403);

        as(ownerA, 'PATCH', `/api/companies/${companyA}`);
        const res = await companyPATCH(req(`/api/companies/${companyA}`, { method: 'PATCH', body: JSON.stringify({ name: 'Renamed while locked' }) }), {
          params: Promise.resolve({ id: companyA }),
        });
        expect(res.status, 'company renamed while the file is locked').toBe(403);
      } finally {
        await removeFilePassword(db, 'filepass99');
        await db.update(companies).set({ name: 'Alpha Co' }).where(eq(companies.id, companyA));
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('full bank account numbers', () => {
    let bankAccountId: string;
    let bankerId: string;

    beforeAll(async () => {
      const [gl] = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.companyId, companyA), eq(accounts.type, 'asset')))
        .limit(1);
      const ba = await createBankAccount({ db, companyId: companyA, userId: ownerA }, {
        accountId: gl.id,
        bankName: 'First Test Bank',
        accountNumber: '000123456789',
      });
      bankAccountId = ba.id;
      const banker = await addUser(adminA, { name: 'Ben Banker', login: 'ben', password: 'benpass123', roleKeys: ['banking'] });
      bankerId = banker.userId;
    });

    it('bank-accounts route masks the number for the Banking role (no flag)', async () => {
      as(bankerId, 'GET', '/api/bank-accounts');
      const res = await bankAccountsGET();
      expect(res.status).toBe(200);
      expect(JSON.stringify(await res.json())).not.toContain('000123456789');
    });

    it('reconciliation info route also masks it (same data, different route)', async () => {
      as(bankerId, 'GET', '/api/reconciliations/info');
      const res = await reconInfoGET(req(`/api/reconciliations/info?bankAccountId=${bankAccountId}`));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(JSON.stringify(body), 'full account number leaked by /api/reconciliations/info').not.toContain('000123456789');
    });

    it('an Admin (flag) still sees the full number', async () => {
      as(ownerA, 'GET', '/api/bank-accounts');
      const res = await bankAccountsGET();
      expect(JSON.stringify(await res.json())).toContain('000123456789');
    });
  });

  // -------------------------------------------------------------------------
  describe('route map vs. service-level checks', () => {
    it('the Accountant role (closing: full) can actually set the closing date', async () => {
      const acc = await addUser(adminA, { name: 'Ann Accountant', login: 'ann', password: 'annpass123', roleKeys: ['accountant'] });
      const ctx = await ctxAs(acc.userId, 'PATCH', '/api/company/closing-date'); // route map allows it
      expect(ctx.access?.permissions.closing).toContain('modify');
      const res = await setClosingDate(ctx, { closingDate: '2024-12-31' });
      expect(res.closingDate).toBe('2024-12-31');
    });

    it('roles without the closing area are refused by the route map', async () => {
      const bk = await addUser(adminA, { name: 'Bo', login: 'bo', password: 'bopass1234', roleKeys: ['bookkeeper'] });
      await expect(ctxAs(bk.userId, 'PATCH', '/api/company/closing-date')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('HEAD follows GET, OPTIONS and unknown methods are denied, trailing slash normalizes', () => {
      expect(apiRuleFor('/api/users', 'HEAD')).toEqual(apiRuleFor('/api/users', 'GET'));
      expect(apiRuleFor('/api/users', 'OPTIONS')).toBeNull();
      expect(apiRuleFor('/api/users', 'TRACE')).toBeNull();
      expect(apiRuleFor('/api/users/', 'GET')).toEqual({ area: 'users', action: 'view' });
      expect(apiRuleFor('/api/users/x/y/z', 'GET')).toBeNull();
      expect(apiRuleFor('/api/customers/../users', 'GET')).toBeNull();
    });

    it('every report page maps to the same area as its report API (no fallback to "any report")', () => {
      const reportsDir = path.resolve(process.cwd(), 'app', 'reports');
      const problems: string[] = [];
      for (const e of fs.readdirSync(reportsDir, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith('_')) continue;
        const page = `/reports/${e.name}`;
        if (!(page in PAGE_AREAS)) problems.push(`${page}: not in PAGE_AREAS (falls back to any report area)`);
        const rule = apiRuleFor(`/api/reports/${e.name}`, 'GET');
        if (rule && typeof rule === 'object') {
          const areas = pageAreasFor(page) ?? [];
          if (!areas.includes(rule.area)) problems.push(`${page}: page ${areas.join('|')} vs API ${rule.area}`);
        }
      }
      expect(problems).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe('backups (File Utilities) and the session signing secret', () => {
    it('roles with File Utilities but not Users & Roles may download a backup …', async () => {
      const ext = await addUser(adminA, { name: 'Eve External', login: 'eve', password: 'evepass123', roleKeys: ['external_accountant'] });
      const ctx = await ctxAs(ext.userId, 'GET', '/api/backup');
      expect(ctx.access?.isAdmin).toBe(false);
      expect(ctx.access?.permissions.users).toEqual([]);
    });

    it('… so the backup must not contain the .auth-secret used to sign Admin sessions', () => {
      fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      fs.writeFileSync(path.join(BACKUP_DIR, '.auth-secret'), 'super-secret-hmac-key');
      fs.writeFileSync(path.join(BACKUP_DIR, 'PG_VERSION'), '16');
      const { buffer } = createBackup('Alpha', BACKUP_DIR);
      const names = new AdmZip(buffer).getEntries().map((e) => e.entryName);
      expect(names).toContain('PG_VERSION');
      expect(names, 'backup ships the session signing secret → forge an Admin session').not.toContain('.auth-secret');
    });
  });

  // -------------------------------------------------------------------------
  describe('auth routes', () => {
    it('/api/auth/me returns the effective permissions of the session user', async () => {
      const u = await addUser(adminA, { name: 'Ari', login: 'ari', password: 'aripass123', roleKeys: ['ar_clerk', 'inventory'] });
      as(u.userId, 'GET', '/api/auth/me');
      const res = await meGET();
      const me = await res.json();
      expect(me.id).toBe(u.userId);
      expect(me.isAdmin).toBe(false);
      expect(me.roleKeys.sort()).toEqual(['ar_clerk', 'inventory']);
      expect(me.permissions.customers).toContain('delete');
      expect(me.permissions.inventory).toContain('delete');
      expect(me.permissions.vendors).toEqual(['view']); // from Inventory
      expect(me.permissions.users).toEqual([]);
      expect(me.flags.sensitivePayroll).toBe(false);

      await updateUser(adminA, u.userId, { isActive: false });
      as(u.userId, 'GET', '/api/auth/me');
      const me2 = await (await meGET()).json();
      expect(me2.permissions).toBeNull();
      expect(me2.isAdmin).toBe(false);
    });

    it('/api/auth/me without a session is null', async () => {
      as(null, 'GET', '/api/auth/me');
      expect(await (await meGET()).json()).toBeNull();
    });

    it('login rejects malformed bodies with 400, not a 500', async () => {
      as(null, 'POST', '/api/auth/login');
      const r1 = await loginPOST(req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 123, password: 'x' }) }));
      expect(r1.status).toBe(400);
      const r2 = await loginPOST(req('/api/auth/login', { method: 'POST', body: '{not json' }));
      expect(r2.status).toBe(400);
    });

    it('a token forged for another user id with the wrong secret is rejected', async () => {
      const body = Buffer.from(JSON.stringify({ userId: ownerA, kind: 'user', exp: Date.now() + 1e6 })).toString('base64url');
      h.headers.clear();
      h.headers.set(ROUTE_PATH_HEADER, '/api/users');
      h.headers.set(ROUTE_METHOD_HEADER, 'GET');
      h.cookies.clear();
      h.cookies.set(SESSION_COOKIE, `${body}.AAAA`);
      await expect(getServerContext()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  // -------------------------------------------------------------------------
  describe('role editor edge cases', () => {
    it('drops unknown areas/actions and stores the expanded form', async () => {
      const role = await createRole(adminA, {
        name: 'Weird',
        permissions: { customers: ['full'], banking: ['fly' as never], nope: ['view'] } as never,
        flags: { sensitivePayroll: 'yes' as never },
      });
      expect(role.permissions).toEqual({ customers: ['view', 'create', 'modify', 'delete', 'print'] });
      expect(role.flags.sensitivePayroll).toBe(true);
      expect(role.flags.closedPeriod).toBe(false);
    });

    it('rejects blank role names and duplicate names differing only by case/whitespace', async () => {
      await expect(createRole(adminA, { name: '   ', permissions: {}, flags: {} })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(createRole(adminA, { name: '  weird ', permissions: {}, flags: {} })).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('an Admin clone is not an Admin (cannot satisfy the last-admin rule)', async () => {
      const clone = await createRole(adminA, { cloneFrom: 'admin', name: 'Admin Clone' });
      const u = await addUser(adminA, { name: 'Cleo', login: 'cleo', password: 'cleopass12', roleKeys: [clone.key] });
      expect(u.isAdmin).toBe(false);
      expect(await activeAdminIds(adminA)).not.toContain(u.userId);
    });

    it('a non-Admin user manager cannot widen the role they themselves hold', async () => {
      const mgrRole = await createRole(adminA, { name: 'Mgr', permissions: { users: ['full'] }, flags: {} });
      const mgr = await addUser(adminA, { name: 'Max', login: 'max', password: 'maxpass123', roleKeys: [mgrRole.key] });
      const mctx = await ctxAs(mgr.userId, 'PATCH', `/api/roles/${mgrRole.key}`);
      await expect(
        updateRole(mctx, mgrRole.key, { permissions: { users: ['full'], accounting: ['full'] } }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(updateRole(mctx, mgrRole.key, { flags: { sensitivePayroll: true } })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(updateUser(mctx, mgr.userId, { roleKeys: [mgrRole.key, 'bookkeeper'] })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      // Cannot clone Admin either.
      await expect(createRole(mctx, { cloneFrom: 'admin', name: 'Mine' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('assigning zero roles is refused (would silently fall back to legacy role)', async () => {
      const u = await addUser(adminA, { name: 'Ivy', login: 'ivy', password: 'ivypass123', roleKeys: ['sales'] });
      await expect(updateUser(adminA, u.userId, { roleKeys: [] })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(addUser(adminA, { name: 'Ned', login: 'ned', password: 'nedpass123', roleKeys: [] })).rejects.toMatchObject({
        code: 'VALIDATION',
      });
    });

    it('a failed add (bad password) leaves no orphan user row', async () => {
      await expect(addUser(adminA, { name: 'Shorty', login: 'shorty', password: 'short', roleKeys: ['sales'] })).rejects.toMatchObject({
        code: 'VALIDATION',
      });
      expect(await db.select().from(users).where(eq(users.email, 'shorty'))).toEqual([]);
    });
  });
});
