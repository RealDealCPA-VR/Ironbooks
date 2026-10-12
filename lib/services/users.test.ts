/**
 * Users & Roles integration tests (team users). Runs the REAL getServerContext against a
 * hermetic PGlite file with `next/headers` mocked, so every check below goes through the same
 * path as a live request: session cookie → active membership → effective permissions → central
 * route map (middleware stamp headers) → ctx.
 *
 * Covers: enforcement per role, role union, deactivation, last-active-Admin protection,
 * privilege-escalation guards, custom/cloned roles, password reset, audit rows, legacy
 * membership migration, closing-date flag, SSN masking through the employees route, and the
 * per-company-file login flow (file password → unlock cookie → login → file-bound session).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq, inArray, sql } from 'drizzle-orm';
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

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-team-users');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'team-users-test-secret';

import { getDb, closeDb, type DB } from '@/lib/db';
import { auditLogs, employees, userCompanies, userRoleAssignments, users } from '@/lib/db/schema';
import {
  createSessionToken,
  hashPassword,
  verifyPassword,
  verifySessionToken,
  SESSION_COOKIE,
  UNLOCK_COOKIE,
} from '@/lib/auth';
import { COMPANY_COOKIE, getServerContext, CLOSING_PASSWORD_HEADER } from '@/lib/context';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { createCompany } from './company';
import { ServiceError, type ServiceContext } from './_base';
import {
  activeAdminIds,
  addUser,
  createRole,
  deleteRole,
  getUser,
  listRoles,
  listUsers,
  resetUserPassword,
  updateRole,
  updateUser,
} from './users';
import { getRole, setMemberRole } from './rbac';
import { resolveAccess } from './access';
import { setFilePassword, removeFilePassword } from './fileLock';
import { GET as employeesGET } from '@/app/api/employees/route';
import { POST as unlockPOST } from '@/app/api/unlock/route';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { POST as signupPOST } from '@/app/api/auth/signup/route';

let db: DB;
let companyId: string;
let ownerId: string;

/** Simulate an incoming request by `userId` for METHOD PATH (middleware stamp + cookies). */
function as(userId: string | null, method: string, routePath: string, extra: Record<string, string> = {}) {
  h.headers.clear();
  h.headers.set(ROUTE_PATH_HEADER, routePath);
  h.headers.set(ROUTE_METHOD_HEADER, method);
  for (const [k, v] of Object.entries(extra)) h.headers.set(k, v);
  const unlock = h.cookies.get(UNLOCK_COOKIE);
  h.cookies.clear();
  if (unlock) h.cookies.set(UNLOCK_COOKIE, unlock);
  if (userId) {
    h.cookies.set(SESSION_COOKIE, createSessionToken(userId));
    h.cookies.set(COMPANY_COOKIE, companyId);
  }
}
async function ctxAs(userId: string, method: string, routePath: string) {
  as(userId, method, routePath);
  return getServerContext();
}
async function expectForbidden(p: Promise<unknown>, message?: RegExp) {
  try {
    await p;
    expect.fail('expected FORBIDDEN');
  } catch (err) {
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('FORBIDDEN');
    if (message) expect((err as ServiceError).message).toMatch(message);
  }
}
function jsonRequest(url: string, body: unknown, method = 'POST') {
  return new NextRequest(`http://127.0.0.1${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('Users & Roles (integration)', () => {
  let admin: ServiceContext; // the company creator, acting through getServerContext
  let clerkId: string;

  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [owner] = await db
      .insert(users)
      .values({ email: 'owner@tu.local', name: 'Olivia Owner', passwordHash: await hashPassword('ownerpass1') })
      .returning();
    ownerId = owner.id;
    const co = await createCompany(db, { name: 'Team Users Co', ownerId, seedCoa: false });
    companyId = co.id;
    admin = await ctxAs(ownerId, 'POST', '/api/users');
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('company creator', () => {
    it('is an Admin through the legacy owner membership (no assignment rows needed)', async () => {
      expect(admin.access?.isAdmin).toBe(true);
      expect(admin.role).toBe('owner');
      expect(await activeAdminIds(admin)).toEqual([ownerId]);
    });

    it('cannot be deactivated or demoted while the only active Admin', async () => {
      await expectForbidden(updateUser(admin, ownerId, { isActive: false }), /last active Admin/);
      await expectForbidden(updateUser(admin, ownerId, { roleKeys: ['bookkeeper'] }), /last active Admin/);
    });
  });

  describe('adding users + enforcement per role', () => {
    it('adds a user with a hashed password and the chosen role', async () => {
      const u = await addUser(admin, {
        name: 'Cara Clerk',
        login: 'Cara',
        password: 'clerkpass1',
        roleKeys: ['ar_clerk'],
      });
      clerkId = u.userId;
      expect(u.login).toBe('cara');
      expect(u.roleKeys).toEqual(['ar_clerk']);
      const [row] = await db.select().from(users).where(eq(users.id, clerkId));
      expect(row.passwordHash).not.toBe('clerkpass1');
      expect(await verifyPassword('clerkpass1', row.passwordHash)).toBe(true);
    });

    it('rejects a duplicate login', async () => {
      await expect(
        addUser(admin, { name: 'Dup', login: 'cara', password: 'whatever12', roleKeys: ['sales'] }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('A/R clerk: allowed customer routes, forbidden elsewhere (central map)', async () => {
      const ok = await ctxAs(clerkId, 'POST', '/api/invoices');
      expect(ok.userId).toBe(clerkId);
      expect(ok.role).toBe('accountant'); // legacy collapse: has write access
      await ctxAs(clerkId, 'GET', '/api/reports/ar-aging');
      await expectForbidden(ctxAs(clerkId, 'POST', '/api/bills'), /Vendors & Payables/);
      await expectForbidden(ctxAs(clerkId, 'GET', '/api/reports/profit-loss'), /Reports — Financial/);
      await expectForbidden(ctxAs(clerkId, 'GET', '/reports/general-ledger'));
      await expectForbidden(ctxAs(clerkId, 'GET', '/api/users'));
      await expectForbidden(ctxAs(clerkId, 'GET', '/api/no-such-route'), /No permission mapping/);
    });

    it('role union: adding A/P clerk opens vendors too', async () => {
      await updateUser(admin, clerkId, { roleKeys: ['ar_clerk', 'ap_clerk'] });
      await ctxAs(clerkId, 'POST', '/api/bills');
      await ctxAs(clerkId, 'POST', '/api/invoices');
      const detail = await getUser(admin, clerkId);
      expect(detail.access.permissions.vendors).toContain('delete');
      expect(detail.access.permissions.customers).toContain('delete');
      expect(detail.access.permissions.accounting).toEqual([]);
    });

    it('View-Only is read-only (route map + legacy viewer guard)', async () => {
      const v = await addUser(admin, { name: 'Vic Viewer', login: 'vic', password: 'viewpass12', roleKeys: ['view_only'] });
      const ctx = await ctxAs(v.userId, 'GET', '/api/invoices');
      expect(ctx.role).toBe('viewer');
      await expectForbidden(ctxAs(v.userId, 'POST', '/api/invoices'));
    });
  });

  describe('deactivate / reactivate', () => {
    it('a deactivated user is locked out; reactivation restores access', async () => {
      await updateUser(admin, clerkId, { isActive: false });
      await expectForbidden(ctxAs(clerkId, 'GET', '/api/invoices'), /deactivated/);
      expect(await getRole({ db, companyId, userId: clerkId })).toBeNull();
      await updateUser(admin, clerkId, { isActive: true });
      await ctxAs(clerkId, 'GET', '/api/invoices');
    });
  });

  describe('last active Admin protection', () => {
    it('allows demoting the creator once another Admin exists, then protects the new last Admin', async () => {
      const second = await addUser(admin, { name: 'Adam Admin', login: 'adam', password: 'adminpass1', roleKeys: ['admin'] });
      expect((await activeAdminIds(admin)).sort()).toEqual([ownerId, second.userId].sort());

      await updateUser(admin, ownerId, { roleKeys: ['full_access'] });
      expect(await activeAdminIds(admin)).toEqual([second.userId]);
      const secondCtx = await ctxAs(second.userId, 'PATCH', `/api/users/${second.userId}`);
      await expectForbidden(updateUser(secondCtx, second.userId, { isActive: false }), /last active Admin/);
      await expectForbidden(updateUser(secondCtx, second.userId, { roleKeys: ['accountant'] }), /last active Admin/);
      // Legacy role API goes through the same guard.
      await expectForbidden(setMemberRole(secondCtx, second.userId, 'viewer'), /last active Admin/);

      // Restore the creator as Admin.
      await updateUser(secondCtx, ownerId, { roleKeys: ['admin'] });
      admin = await ctxAs(ownerId, 'POST', '/api/users');
      expect(admin.access?.isAdmin).toBe(true);
    });

    it('a deactivated Admin does not count', async () => {
      const ids = await activeAdminIds(admin);
      const other = ids.find((i) => i !== ownerId)!;
      await updateUser(admin, other, { isActive: false });
      expect(await activeAdminIds(admin)).toEqual([ownerId]);
      await expectForbidden(updateUser(admin, ownerId, { isActive: false }));
    });
  });

  describe('privilege escalation', () => {
    let mgrCtx: ServiceContext;
    it('a non-Admin user manager cannot grant more than they have', async () => {
      const role = await createRole(admin, {
        name: 'User Manager',
        permissions: { users: ['full'], customers: ['view'] },
        flags: {},
      });
      const mgr = await addUser(admin, { name: 'Mo Manager', login: 'mo', password: 'mgrpass123', roleKeys: [role.key] });
      mgrCtx = await ctxAs(mgr.userId, 'POST', '/api/users');

      await expectForbidden(
        addUser(mgrCtx, { name: 'X', login: 'x1', password: 'xxxxxxxx1', roleKeys: ['admin'] }),
        /Only an Admin/,
      );
      await expectForbidden(
        addUser(mgrCtx, { name: 'X', login: 'x2', password: 'xxxxxxxx1', roleKeys: ['ar_clerk'] }),
        /beyond your own/,
      );
      await expectForbidden(resetUserPassword(mgrCtx, ownerId, 'hijack1234'), /Only an Admin/);
      await expectForbidden(updateUser(mgrCtx, ownerId, { isActive: false }), /Only an Admin/);
      await expectForbidden(
        createRole(mgrCtx, { name: 'Sneaky', permissions: { accounting: ['full'] }, flags: {} }),
        /beyond your own/,
      );
      // Within their own access is fine.
      const ok = await createRole(mgrCtx, { name: 'Looker', permissions: { customers: ['view'] }, flags: {} });
      const u = await addUser(mgrCtx, { name: 'Lou', login: 'lou', password: 'loupass123', roleKeys: [ok.key] });
      expect(u.roles.map((r) => r.name)).toEqual(['Looker']);
    });
  });

  describe('roles', () => {
    it('lists the built-in roles plus custom ones with user counts', async () => {
      const roles = await listRoles(admin);
      expect(roles.find((r) => r.key === 'admin')?.builtin).toBe(true);
      expect(roles.find((r) => r.key === 'admin')?.userCount).toBeGreaterThanOrEqual(1);
      expect(roles.find((r) => r.name === 'User Manager')?.builtin).toBe(false);
    });

    it('clones, edits and deletes a custom role; built-ins are read-only', async () => {
      const clone = await createRole(admin, { cloneFrom: 'bookkeeper', name: 'Senior Bookkeeper' });
      expect(clone.builtin).toBe(false);
      expect(clone.permissions.accounting).toEqual(['view', 'create', 'modify', 'print']);

      const edited = await updateRole(admin, clone.key, {
        permissions: { ...clone.permissions, accounting: ['full'], payroll: ['view'] },
        flags: { closedPeriod: true },
      });
      expect(edited.permissions.accounting).toEqual(['view', 'create', 'modify', 'delete', 'print']);
      expect(edited.flags.closedPeriod).toBe(true);

      await expect(createRole(admin, { cloneFrom: 'sales', name: 'senior bookkeeper' })).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      await expect(createRole(admin, { cloneFrom: 'sales', name: 'Admin' })).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      await expectForbidden(updateRole(admin, 'bookkeeper', { name: 'Hacked' }));
      await expectForbidden(deleteRole(admin, 'admin'));

      const u = await addUser(admin, { name: 'Sam Senior', login: 'sam', password: 'sampass123', roleKeys: [clone.key] });
      const samCtx = await ctxAs(u.userId, 'DELETE', '/api/journal-entries/abc');
      expect(samCtx.userId).toBe(u.userId);
      await expect(deleteRole(admin, clone.key)).rejects.toMatchObject({ code: 'CONFLICT' });
      await updateUser(admin, u.userId, { roleKeys: ['bookkeeper'] });
      await expectForbidden(ctxAs(u.userId, 'DELETE', '/api/journal-entries/abc'));
      await deleteRole(admin, clone.key);
      expect((await listRoles(admin)).some((r) => r.key === clone.key)).toBe(false);
    });

    it('rejects unknown role keys', async () => {
      await expect(updateUser(admin, clerkId, { roleKeys: ['nope'] })).rejects.toMatchObject({ code: 'VALIDATION' });
    });
  });

  describe('password reset + audit', () => {
    it('resets a password and never writes it to the audit trail', async () => {
      await resetUserPassword(admin, clerkId, 'newclerkpw1');
      const [row] = await db.select().from(users).where(eq(users.id, clerkId));
      expect(await verifyPassword('newclerkpw1', row.passwordHash)).toBe(true);

      const audits = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.companyId, companyId), inArray(auditLogs.entityType, ['user', 'role'])));
      expect(audits.length).toBeGreaterThan(8);
      const blob = JSON.stringify(audits.map((a) => [a.oldValues, a.newValues]));
      expect(blob).not.toContain('newclerkpw1');
      expect(blob).not.toContain('clerkpass1');
      expect(blob).not.toMatch(/passwordHash|\$2[aby]\$/);
      expect(audits.some((a) => a.entityType === 'user' && (a.newValues as { isActive?: boolean })?.isActive === false)).toBe(true);
    });
  });

  describe('legacy memberships', () => {
    it('map owner/admin/accountant/viewer to built-in roles (fallback + migration SQL)', async () => {
      const [legacy] = await db
        .insert(users)
        .values({ email: 'legacy@tu.local', name: 'Lee Legacy', passwordHash: 'x' })
        .returning();
      await db.insert(userCompanies).values({ userId: legacy.id, companyId, role: 'accountant' });
      const r = await resolveAccess(db, companyId, legacy.id);
      expect(r.access.roleKeys).toEqual(['accountant']);
      expect(await getRole({ db, companyId, userId: legacy.id })).toBe('accountant');

      // Re-run the 0021 backfill statements: they must produce the same equivalents.
      const sqlText = fs.readFileSync(path.resolve(process.cwd(), 'drizzle', '0021_team_users.sql'), 'utf8');
      for (const stmt of sqlText.split('--> statement-breakpoint')) {
        if (/INSERT INTO "user_role_assignments"/.test(stmt)) await db.execute(sql.raw(stmt));
      }
      const rows = await db
        .select({ roleKey: userRoleAssignments.roleKey })
        .from(userRoleAssignments)
        .where(and(eq(userRoleAssignments.companyId, companyId), eq(userRoleAssignments.userId, legacy.id)));
      expect(rows.map((x) => x.roleKey)).toEqual(['accountant']);

      // Legacy setMemberRole maps to the built-in equivalent and keeps the column in step.
      await setMemberRole(admin, legacy.id, 'viewer');
      expect((await resolveAccess(db, companyId, legacy.id)).access.roleKeys).toEqual(['view_only']);
      expect(await getRole({ db, companyId, userId: legacy.id })).toBe('viewer');
    });
  });

  describe('closing date flag', () => {
    it('the closing-date password only unlocks for roles that may modify closed periods', async () => {
      as(ownerId, 'POST', '/api/journal-entries', { [CLOSING_PASSWORD_HEADER]: 'anything' });
      expect((await getServerContext()).closingDateOverride).toBe(true);
      const bk = await addUser(admin, { name: 'Bea', login: 'bea', password: 'beapass123', roleKeys: ['bookkeeper'] });
      as(bk.userId, 'POST', '/api/journal-entries', { [CLOSING_PASSWORD_HEADER]: 'anything' });
      expect((await getServerContext()).closingDateOverride).toBe(false);
    });
  });

  describe('sensitive payroll data', () => {
    it('employees route shows the full SSN only with the flag', async () => {
      await db.insert(employees).values({
        companyId,
        firstName: 'Erin',
        lastName: 'Employee',
        ssn: '123-45-6789',
      });
      const pp = await addUser(admin, { name: 'Pat', login: 'pat', password: 'patpass123', roleKeys: ['payroll_processor'] });
      const noFlag = await createRole(admin, { cloneFrom: 'payroll_processor', name: 'Payroll (no SSN)' });
      await updateRole(admin, noFlag.key, { flags: { sensitivePayroll: false } });
      const pn = await addUser(admin, { name: 'Pia', login: 'pia', password: 'piapass123', roleKeys: [noFlag.key] });

      const call = async (userId: string) => {
        as(userId, 'GET', '/api/employees');
        const res = await employeesGET(new NextRequest('http://127.0.0.1/api/employees'));
        return { status: res.status, body: await res.json() };
      };
      const full = await call(pp.userId);
      expect(full.status).toBe(200);
      expect(full.body[0].ssn).toBe('123-45-6789');
      const masked = await call(pn.userId);
      expect(masked.status).toBe(200);
      expect(masked.body[0].ssn).toBeUndefined();
      expect(masked.body[0].ssnLast4).toBe('6789');
      expect(JSON.stringify(masked.body)).not.toContain('123-45');
      const denied = await call(clerkId);
      expect(denied.status).toBe(403);
    });
  });

  describe('per-company-file login flow', () => {
    afterAll(async () => {
      await removeFilePassword(db, 'filepass1').catch(() => {});
      h.cookies.delete(UNLOCK_COOKIE);
    });

    it('file password → unlock cookie → login → file-bound session', async () => {
      await setFilePassword(db, 'filepass1');
      h.cookies.delete(UNLOCK_COOKIE);

      // Locked: even a valid session is refused, and login is refused before unlocking.
      await expectForbidden(ctxAs(ownerId, 'GET', '/api/users'), /company file is locked/);
      as(null, 'POST', '/api/auth/login');
      const lockedLogin = await loginPOST(jsonRequest('/api/auth/login', { email: 'cara', password: 'newclerkpw1' }));
      expect(lockedLogin.status).toBe(403);
      expect((await lockedLogin.json()).error).toMatch(/company file is locked/);

      // Wrong then right file password.
      as(null, 'POST', '/api/unlock');
      const bad = await unlockPOST(jsonRequest('/api/unlock', { password: 'nope' }));
      expect(bad.status).toBe(401);
      expect(bad.cookies.get(UNLOCK_COOKIE)).toBeUndefined();
      const good = await unlockPOST(jsonRequest('/api/unlock', { password: 'filepass1' }));
      expect(good.status).toBe(200);
      const unlockToken = good.cookies.get(UNLOCK_COOKIE)?.value;
      expect(unlockToken).toBeTruthy();
      h.cookies.set(UNLOCK_COOKIE, unlockToken!);

      // Login (login name is case-insensitive) issues a session bound to THIS file.
      as(null, 'POST', '/api/auth/login');
      const wrong = await loginPOST(jsonRequest('/api/auth/login', { email: 'CARA', password: 'clerkpass1' }));
      expect(wrong.status).toBe(401);
      const res = await loginPOST(jsonRequest('/api/auth/login', { email: 'CARA', password: 'newclerkpw1' }));
      expect(res.status).toBe(200);
      const session = res.cookies.get(SESSION_COOKIE)?.value;
      // Bound to this file (fid) and to a server-side multi-user session row (sid).
      expect(verifySessionToken(session)).toEqual({ userId: clerkId, sid: expect.any(String) });

      // With the unlock cookie the context resolves.
      const ctx = await ctxAs(clerkId, 'GET', '/api/invoices');
      expect(ctx.userId).toBe(clerkId);
    });

    it('a deactivated user cannot log in', async () => {
      await updateUser(admin, clerkId, { isActive: false });
      as(null, 'POST', '/api/auth/login');
      const res = await loginPOST(jsonRequest('/api/auth/login', { email: 'cara', password: 'newclerkpw1' }));
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/deactivated/);
      await updateUser(admin, clerkId, { isActive: true });
    });

    it('self sign-up is closed once the file has users', async () => {
      as(null, 'POST', '/api/auth/signup');
      const res = await signupPOST(
        jsonRequest('/api/auth/signup', { name: 'Eve', email: 'eve@x.local', password: 'evepass123', companyName: 'Evil' }),
      );
      expect(res.status).toBe(403);
      expect(await db.select().from(users).where(eq(users.email, 'eve@x.local'))).toEqual([]);
    });
  });

  it('lists users with roles (admin view)', async () => {
    const list = await listUsers(admin);
    const owner = list.find((u) => u.userId === ownerId)!;
    expect(owner.isOwner).toBe(true);
    expect(owner.isAdmin).toBe(true);
    expect(list.find((u) => u.login === 'cara')?.roles.map((r) => r.key).sort()).toEqual(['ap_clerk', 'ar_clerk']);
  });
});
