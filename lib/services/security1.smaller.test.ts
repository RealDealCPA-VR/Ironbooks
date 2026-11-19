/**
 * Security review 2.9 (smaller items):
 *  a. resetting your OWN password in Users & Roles needs the current one (the change-password rule);
 *  b. Other Names and the payroll state settings answer account numbers masked ("••••6789") for
 *     roles without "view full account numbers", and a masked number sent back keeps the real one;
 *  c. deleting a memorized report group that has schedules needs Scheduled Reports: delete;
 *  d. letter recipients come without balances for a role without View Balance;
 *  e. applying a General Journal credit never probes another company's journal line.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, journalEntryLines, payrollStateSettings, users } from '@/lib/db/schema';
import { hashPassword, verifyPassword } from '@/lib/auth';
import { builtinRole, unionRoles, type EffectiveAccess, type PermissionGrant } from '@/lib/permissions/model';
import type { ServiceContext } from './_base';
import { resolveAccess } from './access';
import { createCompany } from './company';
import { addUser, OWN_PASSWORD_RESET_MESSAGE, resetUserPassword } from './users';
import { createEntry, listEntries, updateEntry } from './lists/simpleLists';
import { listStateTaxSettings, upsertStateTaxSetting } from './payrollAdjustments';
import { createMemorizedGroup, createReportSchedule, deleteMemorizedGroup } from './memorizedReports';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createInvoice } from './invoices';
import { listRecipients } from './letters';
import { createManualEntry } from './journal';
import { applyJournalCredit } from './journalApplications';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-security1-smaller');
let db: DB;
let companyId: string;
let ownerId: string;
let admin: ServiceContext;

const role = (key: string): EffectiveAccess => unionRoles([builtinRole(key)!]);
const custom = (permissions: PermissionGrant): EffectiveAccess =>
  unionRoles([{ key: 'custom', name: 'Custom', description: '', builtin: false, permissions, flags: {} }]);
const as = (access: EffectiveAccess, userId = ownerId): ServiceContext => ({ db, companyId, userId, access, role: 'accountant' });

function resetLimiter() {
  (globalThis as unknown as { __bkaLoginLimiter?: unknown }).__bkaLoginLimiter = undefined;
}

describe('smaller security items (security 2.9)', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [u] = await db
      .insert(users)
      .values({ email: 'owner@sm.local', name: 'Owner', passwordHash: await hashPassword('ownerpass1') })
      .returning();
    ownerId = u.id;
    companyId = (await createCompany(db, { name: 'Smaller Co', ownerId })).id;
    admin = { db, companyId, userId: ownerId, access: (await resolveAccess(db, companyId, ownerId)).access, role: 'owner' };
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  beforeEach(() => resetLimiter());

  describe('a. your own password needs the current one', () => {
    it('a signed-in person cannot reset their own password without it', async () => {
      await expect(resetUserPassword(admin, ownerId, 'takeover123')).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: OWN_PASSWORD_RESET_MESSAGE,
      });
      await expect(resetUserPassword(admin, ownerId, 'takeover123', { currentPassword: 'wrong-one' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'The current password is not correct.',
      });
      const [row] = await db.select().from(users).where(eq(users.id, ownerId));
      expect(await verifyPassword('ownerpass1', row.passwordHash)).toBe(true);
      await resetUserPassword(admin, ownerId, 'ownerpass2', { currentPassword: 'ownerpass1' });
      const [after] = await db.select().from(users).where(eq(users.id, ownerId));
      expect(await verifyPassword('ownerpass2', after.passwordHash)).toBe(true);
    });

    it("an Admin still resets SOMEONE ELSE's password without it", async () => {
      const clerk = await addUser(admin, { name: 'Clerk', login: 'clerk@sm.local', password: 'clerkpass1', roleKeys: ['bookkeeper'] });
      await resetUserPassword(admin, clerk.userId, 'clerkpass2');
      const [row] = await db.select().from(users).where(eq(users.id, clerk.userId));
      expect(await verifyPassword('clerkpass2', row.passwordHash)).toBe(true);
    });
  });

  describe('b. account numbers are masked', () => {
    it('Other Names: masked for a Bookkeeper, full for the Admin; a masked number sent back keeps the real one', async () => {
      const created = await createEntry(admin, 'other-names', { name: 'Landlord LLC', accountNumber: '000123456789' });
      const bk = as(role('bookkeeper'));
      const listed = (await listEntries(bk, 'other-names')).find((r) => r.id === created.id)!;
      expect(listed.accountNumber).toBe('••••6789');
      expect((await listEntries(admin, 'other-names')).find((r) => r.id === created.id)!.accountNumber).toBe('000123456789');
      // The Bookkeeper's form sends the masked value back with a phone change.
      const updated = await updateEntry(bk, 'other-names', created.id as string, { phone: '555-0100', accountNumber: '••••6789' });
      expect(updated.accountNumber).toBe('••••6789');
      expect((await listEntries(admin, 'other-names')).find((r) => r.id === created.id)!.accountNumber).toBe('000123456789');
      await expect(createEntry(bk, 'other-names', { name: 'Copy LLC', accountNumber: '••••6789' })).rejects.toMatchObject({ code: 'VALIDATION' });
    });

    it('payroll state settings: masked for an Accountant; a masked number sent back keeps the real one', async () => {
      await upsertStateTaxSetting(admin, { state: 'NY', year: 2026, suiRate: '0.02', suiWageBase: '12000', accountNumber: '987654321' });
      const acc = as(role('accountant'));
      const [row] = await listStateTaxSettings(acc);
      expect(row.accountNumber).toBe('••••4321');
      expect((await listStateTaxSettings(admin))[0].accountNumber).toBe('987654321');
      const saved = await upsertStateTaxSetting(acc, { state: 'NY', year: 2026, suiRate: '0.025', suiWageBase: '12000', accountNumber: '••••4321' });
      expect(saved.accountNumber).toBe('••••4321');
      const [stored] = await db.select().from(payrollStateSettings).where(eq(payrollStateSettings.companyId, companyId));
      expect(stored.accountNumber).toBe('987654321');
      expect(stored.suiRate).toBe('0.025000');
    });
  });

  describe('c. deleting a scheduled group needs the schedule right', () => {
    it('a Bookkeeper may delete a group without schedules, not one with them', async () => {
      const bk = as(role('bookkeeper'));
      const plain = await createMemorizedGroup(admin, { name: 'Month end' });
      const scheduled = await createMemorizedGroup(admin, { name: 'Weekly pack' });
      await createReportSchedule(admin, { name: 'Weekly pack', groupId: scheduled.id, frequency: 'weekly' });
      await expect(deleteMemorizedGroup(bk, scheduled.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(deleteMemorizedGroup(bk, plain.id)).resolves.toEqual({ deleted: true });
      await expect(deleteMemorizedGroup(admin, scheduled.id)).resolves.toEqual({ deleted: true });
    });
  });

  describe('d. letters respect View Balance', () => {
    it('recipients come without balances, and balance filters are refused, without View Balance', async () => {
      const cust = await createCustomer(admin, { displayName: 'Owes Money Inc' } as never);
      const [income] = await db.select().from(accounts).where(and(eq(accounts.companyId, companyId), eq(accounts.code, '4000')));
      await createInvoice(admin, {
        customerId: cust.id,
        date: new Date('2026-01-05T12:00:00Z'),
        dueDate: new Date('2026-01-20T12:00:00Z'),
        taxRateId: null,
        lines: [{ accountId: income.id, description: 'Work', quantity: 1, rate: '250.00', taxable: false }],
      } as never);
      const noBalance = as(custom({ 'customers.center': ['view', 'print'] }));
      const r = (await listRecipients(noBalance, { type: 'customer' })).find((x) => x.id === cust.id)!;
      expect(r).toMatchObject({ balance: null, overdueBalance: null, invoiceList: null, balanceHidden: true });
      await expect(listRecipients(noBalance, { type: 'customer', minBalance: '100' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(listRecipients(noBalance, { type: 'customer', overdueDays: 30 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      // With View Balance (every built-in role that sees customers) nothing changes.
      const full = (await listRecipients(as(role('bookkeeper')), { type: 'customer' })).find((x) => x.id === cust.id)!;
      expect(full.balance).toBe('250.00');
    });
  });

  describe("e. another company's journal line is never probed", () => {
    it("A/R and A/P lines of another company give the same not-found answer", async () => {
      const [other] = await db.insert(users).values({ email: 'other@sm.local', name: 'Other', passwordHash: 'x' }).returning();
      const otherCompany = (await createCompany(db, { name: 'Other Co', ownerId: other.id })).id;
      const otherCtx: ServiceContext = { db, companyId: otherCompany, userId: other.id };
      const codes = Object.fromEntries(
        (await db.select().from(accounts).where(eq(accounts.companyId, otherCompany))).map((a) => [a.code, a.id]),
      );
      const cust = await createCustomer(otherCtx, { displayName: 'Their Customer' } as never);
      const vend = await createVendor(otherCtx, { displayName: 'Their Vendor' } as never);
      const je = await createManualEntry(otherCtx, {
        date: new Date('2026-02-01T12:00:00Z'),
        description: 'Other books',
        lines: [
          { accountId: codes['1200'], debit: '100.00', entityType: 'customer', entityId: cust.id },
          { accountId: codes['2000'], credit: '100.00', entityType: 'vendor', entityId: vend.id },
        ],
      } as never);
      const lines = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, je.id));
      const arLine = lines.find((l) => l.accountId === codes['1200'])!.id;
      const apLine = lines.find((l) => l.accountId === codes['2000'])!.id;
      const tryApply = (lineId: string) =>
        applyJournalCredit(admin, { journalLineId: lineId, chargeLineId: lineId, amount: '1.00' }, { side: 'ap' }).then(
          () => 'applied',
          (e: { code?: string; message?: string }) => `${e.code}: ${e.message}`,
        );
      const ar = await tryApply(arLine);
      const ap = await tryApply(apLine);
      expect(ar).toMatch(/^NOT_FOUND/);
      expect(ap).toBe(ar);
    });
  });
});
