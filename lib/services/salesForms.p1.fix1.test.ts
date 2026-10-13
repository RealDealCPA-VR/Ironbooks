/**
 * p1/salesforms fix round 1 — regressions for the reviewer/tester findings:
 *  - A/R and A/P aging as of a date ignore credits (credit memos / vendor credits) dated after it,
 *    and stay tied to the control account in the general ledger as of that date;
 *  - a credit dated before the cutoff but applied after it still ties;
 *  - editing / clearing only a customer's shipping address keeps the ship-to list in sync.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq, lte, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, customers, vendors, journalEntries, journalEntryLines, accounts } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { createInvoice } from './invoices';
import { createCreditMemo, applyToInvoice } from './creditMemos';
import { createBill } from './bills';
import { createVendorCredit, applyToBill, unapplyFromBill } from './vendorCredits';
import { createCustomer, updateCustomer, getCustomer } from './customers';
import { arAging, arAgingDetail, apAging, apAgingDetail } from './reportsExtra';
import { trialBalance } from './reports';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-salesforms-fix1');
let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
const D = (s: string) => new Date(`${s}T00:00:00.000Z`);

const ACCOUNTS: Array<[string, string, string, string]> = [
  ['1000', 'Checking', 'asset', 'checking'],
  ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
  ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
  ['2200', 'Sales Tax Payable', 'liability', 'other_current_liability'],
  ['3000', "Owner's Equity", 'equity', 'owners_equity'],
  ['4000', 'Sales Income', 'revenue', 'sales'],
  ['6000', 'Supplies', 'expense', 'operating_expenses'],
];

/** Debit-minus-credit on an account as of a date, from posted journal lines. */
async function glAsOf(code: string, asOf: Date) {
  const [row] = await db
    .select({
      net: sql<string>`COALESCE(SUM(CAST(COALESCE(${journalEntryLines.debit}, '0') AS NUMERIC) - CAST(COALESCE(${journalEntryLines.credit}, '0') AS NUMERIC)), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
    .innerJoin(accounts, eq(accounts.id, journalEntryLines.accountId))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        eq(accounts.code, code),
        eq(accounts.companyId, ctx.companyId),
        lte(journalEntries.date, asOf),
      ),
    );
  return Money.of(row?.net ?? '0');
}

describe('p1/salesforms fix round 1', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'sf-fix1@t.local', name: 'Fix', passwordHash: 'x' }).returning();
    const [c] = await db.insert(companies).values({ name: 'SF Fix1 Co', ownerId: u.id }).returning();
    ctx = { db, companyId: c.id, userId: u.id };
    for (const [code, n, type, subtype] of ACCOUNTS) {
      acct[code] = (await createAccount(ctx, { code, name: n, type: type as never, subtype })).id;
    }
  });
  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('A/R aging: a credit memo dated after the cutoff does not reduce it; one dated before but applied after still ties', async () => {
    const cust = (await db.insert(customers).values({ companyId: ctx.companyId, displayName: 'Aging Cust' }).returning())[0].id;
    const line = (rate: number) => ({ description: 'Work', quantity: 1, rate, accountId: acct['4000'] });
    const inv = await createInvoice(ctx, { customerId: cust, date: D('2026-06-01'), dueDate: D('2026-06-30'), taxRateId: null, lines: [line(500)] });
    // Dated after the cutoff.
    const late = await createCreditMemo(ctx, { customerId: cust, date: D('2026-07-10'), taxRateId: null, lines: [line(80)] });
    await applyToInvoice(ctx, { creditMemoId: late.id, invoiceId: inv.id, amount: '80.00', date: D('2026-07-10') });
    // Dated before the cutoff, applied after it.
    const early = await createCreditMemo(ctx, { customerId: cust, date: D('2026-06-15'), taxRateId: null, lines: [line(20)] });
    await applyToInvoice(ctx, { creditMemoId: early.id, invoiceId: inv.id, amount: '20.00', date: D('2026-07-12') });

    const cutoff = D('2026-06-30');
    const gl = (await glAsOf('1200', cutoff)).toFixed(2);
    expect(gl).toBe('480.00');
    const sum = (await arAging(ctx, cutoff)).rows.find((r) => r.id === cust)!;
    expect(sum.total).toBe(gl);
    const detail = (await arAgingDetail(ctx, cutoff)).rows.filter((r) => r.entityId === cust);
    const detailTotal = detail.reduce((s, r) => s.plus(Money.of(r.openBalance)), Money.zero()).toFixed(2);
    expect(detailTotal).toBe(gl);

    // Today both credits are in.
    const now = D('2026-07-31');
    expect((await arAging(ctx, now)).rows.find((r) => r.id === cust)!.total).toBe('400.00');
    expect((await glAsOf('1200', now)).toFixed(2)).toBe('400.00');
  });

  it('A/P aging mirrors it: a vendor credit dated after the cutoff does not reduce the bill as of the cutoff', async () => {
    const vendorId = (await db.insert(vendors).values({ companyId: ctx.companyId, displayName: 'Aging Vendor' }).returning())[0].id;
    const bill = await createBill(ctx, { vendorId, date: D('2026-06-01'), dueDate: D('2026-06-30'), lines: [{ accountId: acct['6000'], amount: '300.00' }] });
    const late = await createVendorCredit(ctx, { vendorId, date: D('2026-07-05'), lines: [{ accountId: acct['6000'], amount: '50.00' }] });
    await applyToBill(ctx, { vendorCreditId: late.id, billId: bill.id, amount: '50.00' });
    // Apply, undo, re-apply part: net 30 more from a second late credit.
    const late2 = await createVendorCredit(ctx, { vendorId, date: D('2026-07-06'), lines: [{ accountId: acct['6000'], amount: '40.00' }] });
    await applyToBill(ctx, { vendorCreditId: late2.id, billId: bill.id, amount: '40.00' });
    await unapplyFromBill(ctx, { vendorCreditId: late2.id, billId: bill.id, amount: '10.00' } as never);
    const early = await createVendorCredit(ctx, { vendorId, date: D('2026-06-20'), lines: [{ accountId: acct['6000'], amount: '25.00' }] });
    await applyToBill(ctx, { vendorCreditId: early.id, billId: bill.id, amount: '25.00' });

    const cutoff = D('2026-06-30');
    const gl = (await glAsOf('2000', cutoff)).negated().toFixed(2); // credit-normal
    expect(gl).toBe('275.00');
    expect((await apAging(ctx, cutoff)).rows.find((r) => r.id === vendorId)!.total).toBe(gl);
    const detail = (await apAgingDetail(ctx, cutoff)).rows.filter((r) => r.entityId === vendorId);
    expect(detail.reduce((s, r) => s.plus(Money.of(r.openBalance)), Money.zero()).toFixed(2)).toBe(gl);

    const now = D('2026-07-31');
    const glNow = (await glAsOf('2000', now)).negated().toFixed(2);
    // 300 - 50 - 25 - (40 credit, 30 applied, 10 left open) = 185 net A/P
    expect(glNow).toBe('185.00');
    expect((await apAging(ctx, now)).rows.find((r) => r.id === vendorId)!.total).toBe(glNow);
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('editing only the shipping address updates the default ship-to and keeps the other ship-tos; clearing it drops that entry', async () => {
    const c = await createCustomer(ctx, {
      displayName: 'Ship Sync',
      shipToAddresses: [
        { name: 'Main', line1: '1 Main St', isDefault: true },
        { name: 'Yard', line1: '9 Yard Rd' },
      ],
    });
    const edited = await updateCustomer(ctx, c.id, { shippingAddress: { line1: '2 New Ave', city: 'Town' } });
    expect(edited.shippingAddress).toEqual({ line1: '2 New Ave', city: 'Town' });
    const list = (await getCustomer(ctx, c.id)).shipToAddresses as Array<Record<string, unknown>>;
    expect(list).toEqual([
      { name: 'Main', line1: '2 New Ave', city: 'Town', isDefault: true },
      { name: 'Yard', line1: '9 Yard Rd', isDefault: false },
    ]);

    const cleared = await updateCustomer(ctx, c.id, { shippingAddress: null });
    expect(cleared.shippingAddress).toEqual({ line1: '9 Yard Rd' });
    expect(cleared.shipToAddresses).toEqual([{ name: 'Yard', line1: '9 Yard Rd', isDefault: true }]);

    const none = await createCustomer(ctx, { displayName: 'No Ship' });
    const added = await updateCustomer(ctx, none.id, { shippingAddress: { line1: '5 First St' } });
    expect(added.shipToAddresses).toEqual([{ name: 'Ship To 1', line1: '5 First St', isDefault: true }]);
  });
});
