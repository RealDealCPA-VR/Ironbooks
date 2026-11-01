/**
 * prefsperms (PARITY K): QuickBooks Enterprise activities end to end — role storage, View
 * Balance on the API answers, the View Permissions reports, and old-style roles stored in a
 * company file before activities (they keep their exact access).
 *
 * Real getServerContext + route handlers against a temp PGlite dir (`next/headers` mocked), like
 * users.retest.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
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

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-prefsperms-permissions');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'prefsperms-permissions-secret';

import { getDb, closeDb, type DB } from '@/lib/db';
import { companyRoles, customers, users } from '@/lib/db/schema';
import { createSessionToken, hashPassword, SESSION_COOKIE } from '@/lib/auth';
import { COMPANY_COOKIE, getServerContext } from '@/lib/context';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { canActivity } from '@/lib/permissions/model';
import { createCompany } from './company';
import { resolveAccess } from './access';
import { ServiceError, type ServiceContext } from './_base';
import { addUser, createRole, listRoles } from './users';
import {
  permissionsReportCsv,
  roleListReport,
  rolePermissionsReport,
  userListReport,
  userPermissionsReport,
} from './permissionReports';
import { runStandardReport } from './reportRegistry';
import { GET as customersGET } from '@/app/api/customers/route';
import { GET as reportGET } from '@/app/api/users/permissions-report/route';

let db: DB;
let companyId: string;
let ownerId: string;

function as(userId: string, method: string, routePath: string) {
  h.headers.clear();
  h.headers.set(ROUTE_PATH_HEADER, routePath);
  h.headers.set(ROUTE_METHOD_HEADER, method);
  h.cookies.clear();
  h.cookies.set(SESSION_COOKIE, createSessionToken(userId));
  h.cookies.set(COMPANY_COOKIE, companyId);
}
async function ctxAs(userId: string, method: string, routePath: string): Promise<ServiceContext> {
  as(userId, method, routePath);
  return getServerContext();
}
async function newUser(email: string, name: string) {
  const [u] = await db.insert(users).values({ email, name, passwordHash: await hashPassword('Passw0rd!x') }).returning();
  return u;
}

describe('QB Enterprise activities in a company file', () => {
  let admin: ServiceContext;
  let clerkId: string;
  let balanceClerkId: string;
  let legacyUserId: string;
  let invoicesRoleId: string;
  let legacyRoleId: string;

  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    ownerId = (await newUser('owner@perm.local', 'Olive Owner')).id;
    companyId = (await createCompany(db, { name: 'Perm Co', ownerId })).id;
    await db.insert(customers).values({ companyId, displayName: 'Acme', balance: '125.50' });
    admin = await ctxAs(ownerId, 'POST', '/api/roles');

    invoicesRoleId = (
      await createRole(admin, {
        name: 'Invoices clerk',
        permissions: {
          'customers.invoices': ['view', 'create', 'modify', 'print'],
          'customers.center': ['view'],
        },
        flags: {},
      })
    ).key;
    const balanceRole = await createRole(admin, {
      name: 'Center with balances',
      permissions: { 'customers.center': ['view', 'view_balance'] },
      flags: {},
    });
    // A custom role stored the OLD way (one grant per area), as every file before activities has.
    const [legacy] = await db
      .insert(companyRoles)
      .values({ companyId, name: 'Old style A/R', description: null, permissions: { customers: ['view', 'create'], users: ['view'] }, flags: {} })
      .returning();
    legacyRoleId = legacy.id;

    clerkId = (await addUser(admin, { name: 'Ivy Invoices', login: 'ivy', password: 'Passw0rd!x1', roleKeys: [invoicesRoleId] })).userId;
    balanceClerkId = (await addUser(admin, { name: 'Bea Balance', login: 'bea', password: 'Passw0rd!x1', roleKeys: [balanceRole.key] })).userId;
    legacyUserId = (await addUser(admin, { name: 'Lou Legacy', login: 'lou', password: 'Passw0rd!x1', roleKeys: [legacyRoleId] })).userId;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('stores a role per activity and lists it with its activity rights', async () => {
    const roles = await listRoles(admin);
    const r = roles.find((x) => x.key === invoicesRoleId)!;
    expect(r.permissions).toEqual({ 'customers.invoices': ['view', 'create', 'modify', 'print'], 'customers.center': ['view'] });
    expect(r.activities['customers.invoices']).toEqual(['view', 'create', 'modify', 'print']);
    expect(r.activities['customers.payments']).toEqual([]);
  });

  it('an old-style role stored in the file gets every activity of its areas, View Balance included', async () => {
    const { access } = await resolveAccess(db, companyId, legacyUserId);
    expect(canActivity(access, 'customers.invoices', 'create')).toBe(true);
    expect(canActivity(access, 'customers.payments', 'create')).toBe(true);
    expect(canActivity(access, 'customers.center', 'view_balance')).toBe(true);
    expect(canActivity(access, 'customers.invoices', 'delete')).toBe(false);
  });

  it('the route map enforces the activity: Invoices yes, Receive Payments no', async () => {
    await expect(ctxAs(clerkId, 'POST', '/api/invoices')).resolves.toBeTruthy();
    await expect(ctxAs(clerkId, 'POST', '/api/payments')).rejects.toThrow(/Receive Payments/);
    await expect(ctxAs(clerkId, 'GET', '/payments')).rejects.toThrow(/permission/);
  });

  it('View Balance: without it the customer list answers balances as hidden', async () => {
    as(clerkId, 'GET', '/api/customers');
    const hidden = (await (await customersGET(new NextRequest('http://127.0.0.1/api/customers'))).json()) as Array<Record<string, unknown>>;
    expect(hidden[0].displayName).toBe('Acme');
    expect(hidden[0].balance).toBeNull();
    expect(hidden[0].balanceHidden).toBe(true);

    as(balanceClerkId, 'GET', '/api/customers');
    const shown = (await (await customersGET(new NextRequest('http://127.0.0.1/api/customers'))).json()) as Array<Record<string, unknown>>;
    expect(shown[0].balance).toBe('125.50');
    expect(shown[0].balanceHidden).toBeUndefined();

    as(legacyUserId, 'GET', '/api/customers');
    const legacy = (await (await customersGET(new NextRequest('http://127.0.0.1/api/customers'))).json()) as Array<Record<string, unknown>>;
    expect(legacy[0].balance).toBe('125.50'); // nobody loses balances on upgrade
  });

  it('role permissions report: side by side, with levels and the Partial rights', async () => {
    const r = await rolePermissionsReport(admin, [invoicesRoleId, 'admin', legacyRoleId]);
    expect(r.columns.map((c) => c.name)).toEqual(['Invoices clerk', 'Admin', 'Old style A/R']);
    const inv = r.rows.find((x) => x.activity === 'customers.invoices')!;
    expect(inv.cells[invoicesRoleId]).toMatchObject({ level: 'Partial', text: 'Create, Modify, Print' });
    expect(inv.cells.admin.level).toBe('Full');
    expect(inv.cells[legacyRoleId]).toMatchObject({ level: 'Partial', text: 'Create' });
    const pay = r.rows.find((x) => x.activity === 'customers.payments')!;
    expect(pay.cells[invoicesRoleId].level).toBe('None');
    expect(r.flags.find((f) => f.key === 'closedPeriod')!.cells.admin).toBe(true);
    await expect(rolePermissionsReport(admin, ['no-such-role'])).rejects.toThrow(ServiceError);
  });

  it('user permissions report, user list and role list', async () => {
    const u = await userPermissionsReport(admin, [clerkId, ownerId]);
    expect(u.columns.find((c) => c.key === clerkId)!.detail).toBe('Invoices clerk');
    const inv = u.rows.find((x) => x.activity === 'customers.invoices')!;
    expect(inv.cells[clerkId].level).toBe('Partial');
    expect(inv.cells[ownerId].level).toBe('Full');

    const list = await userListReport(admin);
    expect(list.map((x) => x.name)).toEqual(expect.arrayContaining(['Ivy Invoices', 'Lou Legacy', 'Olive Owner']));
    expect(list.find((x) => x.userId === ownerId)!.isOwner).toBe(true);

    const roles = await roleListReport(admin);
    expect(roles.find((x) => x.key === invoicesRoleId)).toMatchObject({ type: 'Custom', users: 'Ivy Invoices', userCount: 1 });
    expect(roles.find((x) => x.key === 'admin')!.type).toBe('Built-in');

    const csv = await permissionsReportCsv(admin, 'roles', [invoicesRoleId]);
    expect(csv.csv).toContain('Customers & Receivables,Invoices,"Create, Modify, Print"');
  });

  it('standard reports check their own activity: Company & Financial is not Accountant & Taxes', async () => {
    const plRole = await createRole(admin, {
      name: 'Owner reports',
      permissions: { 'reports_financial.company': ['view', 'print'] },
      flags: {},
    });
    const readerId = (await addUser(admin, { name: 'Rita Reports', login: 'rita', password: 'Passw0rd!x1', roleKeys: [plRole.key] })).userId;
    const reader = await ctxAs(readerId, 'GET', '/api/reports/std/profit-loss');
    await expect(runStandardReport(reader, 'profit-loss', new URLSearchParams())).resolves.toBeTruthy();
    await expect(runStandardReport(reader, 'trial-balance', new URLSearchParams())).rejects.toThrow(/Accountant & Taxes/);
    // A role stored the old way (Reports — Financial: view) keeps every financial report.
    const [old] = await db
      .insert(companyRoles)
      .values({ companyId, name: 'Old reports', description: null, permissions: { reports_financial: ['view'] }, flags: {} })
      .returning();
    const oldId = (await addUser(admin, { name: 'Otto Old', login: 'otto', password: 'Passw0rd!x1', roleKeys: [old.id] })).userId;
    const oldCtx = await ctxAs(oldId, 'GET', '/api/reports/std/trial-balance');
    await expect(runStandardReport(oldCtx, 'trial-balance', new URLSearchParams())).resolves.toBeTruthy();
    await expect(runStandardReport(oldCtx, 'profit-loss', new URLSearchParams())).resolves.toBeTruthy();
  });

  it('the reports need Users & Roles > View Permissions Reports (route and service)', async () => {
    // The old-style role has Users & Roles: view, which covers the reports activity.
    as(legacyUserId, 'GET', '/api/users/permissions-report');
    const ok = await reportGET(new NextRequest('http://127.0.0.1/api/users/permissions-report?kind=role_list'));
    expect(ok.status).toBe(200);
    // …but not Print, so no CSV.
    as(legacyUserId, 'GET', '/api/users/permissions-report');
    const csv = await reportGET(new NextRequest('http://127.0.0.1/api/users/permissions-report?kind=roles&format=csv'));
    expect(csv.status).toBe(403);
    // The invoices clerk has no Users & Roles at all.
    as(clerkId, 'GET', '/api/users/permissions-report');
    const denied = await reportGET(new NextRequest('http://127.0.0.1/api/users/permissions-report?kind=roles'));
    expect(denied.status).toBe(403);
  });
});
