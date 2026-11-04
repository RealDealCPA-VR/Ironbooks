/**
 * prefsperms fix (post-merge review, P1 #1): a role built per ACTIVITY in the role editor must not
 * pass the older AREA-level checks that services and member / self routes still make. Before the
 * fix `can(access, area, action)` was true when ANY activity of the area had the action, so:
 *  - Form Templates: Delete archived the company file; Budgets: Modify renamed it;
 *  - Purchase Orders: Create saved a receipt as a BILL (and any Banking create, e.g. Bank Rules,
 *    saved one as a check);
 *  - Receive Payments without Delete could undo (delete) a payment they had just entered.
 * Roles stored the old way (one grant per area, every built-in role) keep exactly their access.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-prefsperms-activity-checks');
process.env.BKA_DATA_DIR = TEST_DIR;

import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, companies, undoActions, users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { builtinRole, unionRoles, type PermissionGrant, type RoleDefinition } from '@/lib/permissions/model';
import { activitiesOf } from '@/lib/permissions/activities';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { addUser, createRole } from './users';
import { archiveCompany, renameCompany } from '@/app/api/companies/[id]/manage';
import { saveReceipt } from './receipts';
import { performUndo } from './undo';
import { requireEffectivePermission, requirePermission } from './access';
import { canViewRegister } from '@/lib/permissions/registers';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { receivePayment } from './payments';
import { getCalendar } from './calendar';
import { canSeeTodoLink } from './todos';

let db: DB;
let companyId: string;
let ownerId: string;
let owner: ServiceContext;

const role = (permissions: PermissionGrant): RoleDefinition => ({
  key: 'custom',
  name: 'custom',
  description: '',
  builtin: false,
  permissions,
  flags: {},
});

async function userWith(login: string, roleKeys: string[]): Promise<string> {
  return (await addUser(owner, { name: login, login, password: 'Passw0rd!x1', roleKeys })).userId;
}

async function customUser(login: string, permissions: PermissionGrant): Promise<string> {
  const r = await createRole(owner, { name: `Role ${login}`, permissions, flags: {} });
  return userWith(login, [r.key]);
}

const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string }) => e?.code ?? String(e));

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'owner@fix.test', name: 'Owner', passwordHash: 'x' }).returning();
  ownerId = u.id;
  companyId = (await createCompany(db, { name: 'Fix Co', ownerId })).id;
  // A second company, so archiving this one is not refused as "your only company".
  await createCompany(db, { name: 'Other Co', ownerId });
  owner = { db, companyId, userId: ownerId };
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR).catch(() => undefined);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    /* Windows */
  }
});

describe('company file rename / archive need their own activity', () => {
  it('Form Templates: Delete does not archive the company file', async () => {
    const id = await customUser('templates', { 'company.templates': ['view', 'delete'] });
    expect(await code(archiveCompany(db, id, companyId, 'Fix Co'))).toBe('FORBIDDEN');
    const [c] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect((c.settings as { archived?: boolean } | null)?.archived).not.toBe(true);
  });

  it('Budgets: Modify does not rename the company file', async () => {
    const id = await customUser('budgets', { 'company.budgets': ['view', 'modify'] });
    expect(await code(renameCompany(db, id, companyId, 'Hijacked Name'))).toBe('FORBIDDEN');
    const [c] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(c.name).toBe('Fix Co');
  });

  it('the new activity allows it, and the built-in Accountant still renames but cannot archive', async () => {
    const renamer = await customUser('renamer', { 'company.company_file': ['view', 'modify'] });
    expect((await renameCompany(db, renamer, companyId, 'Fix Co Renamed')).name).toBe('Fix Co Renamed');
    const accountant = await userWith('acct', ['accountant']);
    expect((await renameCompany(db, accountant, companyId, 'Fix Co')).name).toBe('Fix Co');
    expect(await code(archiveCompany(db, accountant, companyId, 'Fix Co'))).toBe('FORBIDDEN');
  });
});

describe('saving a receipt needs Enter Bills / Write Checks, not any activity of the area', () => {
  const input = (kind: string) => ({
    version: 1,
    kind,
    date: '2026-01-05',
    total: '10.00',
    accountId: randomUUID(),
    paymentAccountId: randomUUID(),
    vendorId: randomUUID() as string | undefined,
  });

  it('Purchase Orders: Create does not save a receipt as a bill', async () => {
    const ctx: ServiceContext = { ...owner, access: unionRoles([role({ 'vendors.purchase_orders': ['view', 'create'] })]) };
    expect(await code(saveReceipt(ctx, randomUUID(), input('bill')))).toBe('FORBIDDEN');
  });

  it('Bank Rules: Create does not save a receipt as a check or expense', async () => {
    const ctx: ServiceContext = { ...owner, access: unionRoles([role({ 'banking.bank_rules': ['view', 'create'] })]) };
    expect(await code(saveReceipt(ctx, randomUUID(), input('check')))).toBe('FORBIDDEN');
    expect(await code(saveReceipt(ctx, randomUUID(), input('expense')))).toBe('FORBIDDEN');
  });

  it('Enter Bills / Write Checks pass the permission check (the made-up receipt is then not found)', async () => {
    const bills: ServiceContext = { ...owner, access: unionRoles([role({ 'vendors.bills': ['view', 'create'] })]) };
    expect(await code(saveReceipt(bills, randomUUID(), input('bill')))).toBe('NOT_FOUND');
    const checks: ServiceContext = { ...owner, access: unionRoles([role({ 'banking.write_checks': ['view', 'create'] })]) };
    expect(await code(saveReceipt(checks, randomUUID(), input('check')))).toBe('NOT_FOUND');
    // A new vendor typed on the receipt needs Vendor Center: Create as well.
    expect(await code(saveReceipt(bills, randomUUID(), { ...input('bill'), vendorId: undefined, newVendorName: 'New Vendor' }))).toBe('FORBIDDEN');
  });
});

describe('undo needs the right of the inverse action on its own activity', () => {
  it('Receive Payments without Delete cannot undo (delete) a payment, even with Invoices: Full', async () => {
    const access = unionRoles([role({ 'customers.invoices': ['full'], 'customers.payments': ['view', 'create'] })]);
    const ctx: ServiceContext = { ...owner, access };
    const [tok] = await db
      .insert(undoActions)
      .values({
        companyId,
        userId: ownerId,
        entityType: 'payment_received',
        entityId: randomUUID(),
        kind: 'create',
        status: 'armed',
        label: 'customer payment',
        snapshot: {},
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning({ id: undoActions.id });
    expect(await code(performUndo(ctx, tok.id))).toBe('FORBIDDEN');
    // With Receive Payments: Delete the permission check passes (the made-up payment is then missing).
    const withDelete: ServiceContext = { ...owner, access: unionRoles([role({ 'customers.payments': ['view', 'create', 'delete'] })]) };
    expect(await code(performUndo(withDelete, tok.id))).not.toBe('FORBIDDEN');
  });
});

describe('service-level area checks are fail-closed for activity roles', () => {
  it('requirePermission / requireEffectivePermission need the action on every activity of the area', async () => {
    const po: ServiceContext = { ...owner, access: unionRoles([role({ 'vendors.purchase_orders': ['view', 'create'] })]) };
    expect(() => requirePermission(po, 'vendors', 'create')).toThrow(/permission/);
    expect(() => requirePermission(po, 'vendors', 'view')).toThrow(/permission/);
    await expect(requireEffectivePermission(po, 'vendors', 'create')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // ...but the activity itself is fine, and an old-style area grant is exactly as before.
    expect(() => requirePermission(po, 'vendors.purchase_orders', 'create')).not.toThrow();
    const legacy: ServiceContext = { ...owner, access: unionRoles([role({ vendors: ['view', 'create'] })]) };
    expect(() => requirePermission(legacy, 'vendors', 'create')).not.toThrow();
    expect(() => requirePermission(legacy, 'vendors', 'delete')).toThrow(/permission/);
  });
});

describe('view filters check the own activity of a record (fail closed, not any activity of the area)', () => {
  it('calendar: Invoices without Receive Payments shows invoices but not payments; built-in roles unchanged', async () => {
    const acct: Record<string, string> = {};
    for (const a of await db.select().from(accounts).where(eq(accounts.companyId, companyId))) acct[a.code] = a.id;
    const cust = await createCustomer(owner, { displayName: 'Calendar Customer' } as never);
    const inv = await createInvoice(owner, {
      customerId: cust.id,
      date: new Date('2026-02-03T00:00:00.000Z'),
      lines: [{ accountId: acct['4000'], description: 'Work', quantity: 1, rate: '100.00', taxable: false }],
    } as never);
    await receivePayment(owner, {
      customerId: cust.id,
      date: new Date('2026-02-04T00:00:00.000Z'),
      method: 'check',
      amount: '40.00',
      depositAccountId: acct['1000'],
      applications: [{ invoiceId: inv.id, amountApplied: '40.00' }],
    } as never);
    const kinds = async (ctx: ServiceContext) =>
      new Set((await getCalendar(ctx, { from: '2026-02-01', to: '2026-02-28', today: '2026-02-10' })).days.flatMap((d) => d.events.map((e) => e.kind)));

    const invoicesOnly = await kinds({ ...owner, access: unionRoles([role({ 'customers.invoices': ['view', 'create'] })]) });
    expect(invoicesOnly.has('invoice')).toBe(true);
    expect(invoicesOnly.has('payment')).toBe(false);
    const paymentsOnly = await kinds({ ...owner, access: unionRoles([role({ 'customers.payments': ['view'] })]) });
    expect(paymentsOnly.has('payment')).toBe(true);
    expect(paymentsOnly.has('invoice')).toBe(false);
    // Built-in roles: exactly as before (A/R Clerk sees both; Purchasing sees neither).
    const arClerk = await kinds({ ...owner, access: unionRoles([builtinRole('ar_clerk')!]) });
    expect(arClerk.has('invoice') && arClerk.has('payment')).toBe(true);
    const purchasing = await kinds({ ...owner, access: unionRoles([builtinRole('purchasing')!]) });
    expect(purchasing.has('invoice') || purchasing.has('payment')).toBe(false);
  });

  it("to-do links and registers: the linked record's own list / Use Register", async () => {
    const leads: ServiceContext = { ...owner, access: unionRoles([role({ 'customers.leads': ['view'] })]) };
    expect(canSeeTodoLink(leads, 'lead')).toBe(true);
    expect(canSeeTodoLink(leads, 'customer')).toBe(false);
    const register = unionRoles([role({ 'banking.registers': ['view'] })]);
    expect(canViewRegister(register, { type: 'asset', subtype: 'checking' })).toBe(true);
    // An A/R register lists every customer document: it needs the whole Customers area.
    const invoicesOnly = unionRoles([role({ 'customers.invoices': ['full'] })]);
    expect(canViewRegister(invoicesOnly, { type: 'asset', subtype: 'accounts_receivable' })).toBe(false);
    expect(canViewRegister(unionRoles([builtinRole('ar_clerk')!]), { type: 'asset', subtype: 'accounts_receivable' })).toBe(true);
    // Bank Rules alone does not open a bank register.
    expect(canViewRegister(unionRoles([role({ 'banking.bank_rules': ['view'] })]), { type: 'asset', subtype: 'checking' })).toBe(false);
  });
});

describe('roles saved per activity keep a full area when new activities are added (round 2 P2)', () => {
  it('Full on every activity of an area is stored as the area grant', async () => {
    const grant: Record<string, string[]> = {};
    for (const d of activitiesOf('company')) grant[d.key] = ['full'];
    grant['customers.invoices'] = ['view', 'create'];
    const r = await createRole(owner, { name: 'Full company by activity', permissions: grant as PermissionGrant, flags: {} });
    expect(r.permissions).toMatchObject({ company: ['view', 'create', 'modify', 'delete', 'print'], 'customers.invoices': ['view', 'create'] });
    expect(Object.keys(r.permissions).some((k) => k.startsWith('company.'))).toBe(false);
    // One activity short of Full stays per activity.
    const partial = { ...grant, 'company.templates': ['view'] };
    const p = await createRole(owner, { name: 'Almost full company', permissions: partial as PermissionGrant, flags: {} });
    expect((p.permissions as Record<string, unknown>).company).toBeUndefined();
    expect((p.permissions as Record<string, unknown>)['company.templates']).toEqual(['view']);
  });
});
