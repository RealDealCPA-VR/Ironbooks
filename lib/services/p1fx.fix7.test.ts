/**
 * P1 round, team FX — fix round 7 regression tests (after main was merged into p1/fx).
 *
 *  [A3]      a vendor credit can't be applied before it (or the bill) exists, nor unapplied before
 *            it was applied — foreign and home credits, service and API-style dates; Pay Bills
 *            dates the application with its own date.
 *  [A4]      a foreign vendor credit refunded after the cutoff counts in full on the as-of A/P
 *            aging and aging detail (foreign column too), on every day.
 *  [A4-home] the same for a home-currency credit, also with a partial application in between.
 *  [C1]      a home credit memo can't be applied to a EUR invoice (directly or with Receive
 *            Payments); nothing is saved and today's A/R aging equals GL A/R.
 *  [merge]   a EUR vendor's credit with an Items-tab inventory return posts home amounts (stock at
 *            cost, price difference to COGS) and ties to A/P; a memo edit of an applied foreign
 *            credit with a blank rate keeps its saved rate and stays ledger-neutral.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { and, eq, lte, sql } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  accounts,
  invoices,
  journalEntries,
  journalEntryLines,
  users,
  vendorCreditApplications,
  vendorCredits,
  paymentsReceived,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { upsertCurrency, setBaseCurrency, setAccountCurrency } from './currencies';
import { createVendor } from './vendors';
import { createCustomer } from './customers';
import { createBill } from './bills';
import { createItem } from './items';
import { adjustInventory } from './inventory';
import {
  createVendorCredit,
  updateVendorCredit,
  applyToBill,
  unapplyFromBill,
  refundVendorCredit,
} from './vendorCredits';
import { payBillsWithCredits } from './billPayments';
import { createInvoice } from './invoices';
import { createCreditMemo, applyToInvoice } from './creditMemos';
import { receivePayment } from './payments';
import { apAging, apAgingDetail, arAging } from './reportsExtra';
import { Money } from '@/lib/money';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-fx-fix7');
let db: DB;
let userId: string;
let ctx: ServiceContext;
let acct: Record<string, string> = {};
let seq = 0;
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const FAR = d('2099-12-31');
const iso = (x: Date) => x.toISOString().slice(0, 10);
const days = (from: string, to: string) => {
  const out: Date[] = [];
  for (let t = d(from).getTime(); t <= d(to).getTime(); t += 86400000) out.push(new Date(t));
  return out;
};
const home = (amt: string, rate: string) => Money.round2(Money.of(amt).times(Money.of(rate)));

/** GL A/P (credit-positive) from posted lines dated on/before `asOf`. */
async function apAsOf(asOf: Date): Promise<string> {
  const [row] = await db
    .select({ d: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`, c: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)` })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(eq(journalEntryLines.accountId, acct['2000']), eq(journalEntries.status, 'posted'), lte(journalEntries.date, asOf)));
  return Money.of(row.c).minus(Money.of(row.d)).toFixed(2);
}
async function arAsOf(asOf: Date): Promise<string> {
  const [row] = await db
    .select({ d: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`, c: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)` })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(eq(journalEntryLines.accountId, acct['1200']), eq(journalEntries.status, 'posted'), lte(journalEntries.date, asOf)));
  return Money.of(row.d).minus(Money.of(row.c)).toFixed(2);
}
async function apMismatches(dates: Date[]): Promise<string[]> {
  const out: string[] = [];
  for (const day of dates) {
    const ap = await apAsOf(day);
    const aging = Money.of((await apAging(ctx, day)).totals.total).toFixed(2);
    const detail = Money.of((await apAgingDetail(ctx, day)).total).toFixed(2);
    if (aging !== ap || detail !== ap) out.push(`${iso(day)}: A/P ${ap} aging ${aging} detail ${detail}`);
  }
  return out;
}
async function balanced() {
  expect((await trialBalance(ctx)).balanced).toBe(true);
}
async function eurVendor(name: string) {
  return createVendor(ctx, { displayName: name, currency: 'EUR' });
}
function eurBill(vendorId: string, amount: string, date = '2026-06-01', rate = '1.1111') {
  return createBill(ctx, { vendorId, date: d(date), exchangeRate: rate, lines: [{ accountId: acct['6000'], amount }] } as never);
}
function eurCredit(vendorId: string, amount: string, date = '2026-07-01', rate = '1.2345') {
  return createVendorCredit(ctx, { vendorId, date: d(date), exchangeRate: rate, lines: [{ accountId: acct['6000'], amount }] } as never);
}

describe('P1 FX — fix round 7', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'p1fx-fix7@test.local', name: 'FX Fix7', passwordHash: 'x' }).returning();
    userId = u.id;
  });
  beforeEach(async () => {
    seq += 1;
    const company = await createCompany(db, { name: `FX Fix7 Co ${seq}`, ownerId: userId });
    ctx = { db, companyId: company.id, userId };
    acct = {};
    for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) if (a.code) acct[a.code] = a.id;
    await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.10' });
    acct['1020'] = (await createAccount(ctx, { code: '1020', name: 'Euro Bank', type: 'asset' as never, subtype: 'checking' })).id;
    await setAccountCurrency(ctx, acct['1020'], 'EUR');
  });
  afterAll(async () => {
    await closeDb(TEST_DIR);
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle. */
    }
  });

  // ---------------------------------------------------------------------------------------------
  // [A3] date floor on vendor-credit applications
  // ---------------------------------------------------------------------------------------------

  it('[A3] a foreign credit applied before the credit exists is refused in plain words; nothing changes', async () => {
    const v = await eurVendor('A3 Vendor');
    const bill = await eurBill(v.id, '40.00');
    const vc = await eurCredit(v.id, '100.00', '2026-07-20');
    await expect(
      applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-07-05') }),
    ).rejects.toThrow(/can't be applied before it exists.*2026-07-20/);
    const [row] = await db.select().from(vendorCredits).where(eq(vendorCredits.id, vc.id));
    expect(row.unapplied).toBe('100.00');
    expect(await db.select().from(vendorCreditApplications).where(eq(vendorCreditApplications.vendorCreditId, vc.id))).toEqual([]);
    // On the credit's own date it is allowed, and every view equals GL A/P on every day.
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-07-20') });
    expect(await apMismatches([...days('2026-07-01', '2026-07-31'), new Date(), FAR])).toEqual([]);
    await balanced();
  });

  it('[A3] a credit applied before the BILL exists is refused (credit older than the bill)', async () => {
    const v = await eurVendor('A3 Bill Vendor');
    const vc = await eurCredit(v.id, '100.00', '2026-05-01');
    const bill = await eurBill(v.id, '40.00', '2026-06-15');
    await expect(
      applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '10.00', date: d('2026-06-01') }),
    ).rejects.toThrow(/the bill's date \(2026-06-15\)/);
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '10.00', date: d('2026-06-15') });
    expect(await apMismatches([...days('2026-05-01', '2026-06-30'), FAR])).toEqual([]);
  });

  it('[A3] an unapply dated before its apply is refused; on/after the apply it works and ties every day', async () => {
    const v = await eurVendor('A3 Unapply Vendor');
    const bill = await eurBill(v.id, '40.00');
    const vc = await eurCredit(v.id, '100.00');
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-08-10') });
    await expect(
      unapplyFromBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-07-20') }),
    ).rejects.toThrow(/can't be unapplied before it was applied.*2026-08-10/);
    await unapplyFromBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '15.00', date: d('2026-08-10') });
    await unapplyFromBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '25.00', date: d('2026-08-20') });
    expect(await apMismatches([...days('2026-07-01', '2026-08-31'), FAR])).toEqual([]);
    await balanced();
  });

  it('[A3] a home credit with a date before the credit is refused too', async () => {
    const v = await createVendor(ctx, { displayName: 'A3 Home Vendor' });
    const bill = await createBill(ctx, { vendorId: v.id, date: d('2026-06-01'), lines: [{ accountId: acct['6000'], amount: '40.00' }] } as never);
    const vc = await createVendorCredit(ctx, { vendorId: v.id, date: d('2026-07-20'), lines: [{ accountId: acct['6000'], amount: '30.00' }] } as never);
    await expect(
      applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '30.00', date: d('2026-07-01') }),
    ).rejects.toThrow(/before it exists/);
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '30.00' });
    expect(await apMismatches([...days('2026-06-25', '2026-07-31'), FAR])).toEqual([]);
  });

  it('[A3] Pay Bills dates a foreign credit application with the Pay Bills date', async () => {
    const v = await eurVendor('A3 Pay Bills Vendor');
    const bill = await eurBill(v.id, '40.00');
    const vc = await eurCredit(v.id, '10.00');
    await payBillsWithCredits(ctx, {
      vendorId: v.id,
      date: d('2026-07-15'),
      method: 'check',
      paymentAccountId: acct['1020'],
      exchangeRate: '1.15',
      applications: [{ billId: bill.id, amountApplied: '30.00' }],
      vendorCredits: [{ vendorCreditId: vc.id, billId: bill.id, amount: '10.00' }],
    } as never);
    const apps = await db.select().from(vendorCreditApplications).where(eq(vendorCreditApplications.vendorCreditId, vc.id));
    expect(apps.map((a) => iso(a.date))).toEqual(['2026-07-15']);
    expect(await apMismatches([...days('2026-07-01', '2026-07-31'), FAR])).toEqual([]);
    await balanced();
  });

  // ---------------------------------------------------------------------------------------------
  // [A4] refunds dated after the cutoff
  // ---------------------------------------------------------------------------------------------

  it('[A4] a foreign credit refunded after the cutoff counts in full before the refund (aging, detail, foreign column)', async () => {
    const v = await eurVendor('A4 Vendor');
    await eurBill(v.id, '40.00');
    const vc = await eurCredit(v.id, '100.00');
    await refundVendorCredit(ctx, { vendorCreditId: vc.id, bankAccountId: acct['1020'], amount: '30.00', date: d('2026-08-10'), exchangeRate: '1.20' });
    expect(await apAsOf(d('2026-07-15'))).toBe(home('40.00', '1.1111').minus(home('100.00', '1.2345')).toFixed(2));
    const row = (await apAgingDetail(ctx, d('2026-07-15'))).rows.find((r) => r.docId === vc.id)!;
    expect(row.openBalance).toBe(home('100.00', '1.2345').negated().toFixed(2));
    expect(row.currency).toBe('EUR');
    expect(row.foreignOpenBalance).toBe('-100.00');
    const after = (await apAgingDetail(ctx, d('2026-08-15'))).rows.find((r) => r.docId === vc.id)!;
    expect(after.foreignOpenBalance).toBe('-70.00');
    expect(await apMismatches([...days('2026-06-28', '2026-08-15'), new Date(), FAR])).toEqual([]);
    await balanced();
  });

  it('[A4] a foreign credit fully refunded after the cutoff (unapplied 0 today) still shows before the refund', async () => {
    const v = await eurVendor('A4 Full Vendor');
    const vc = await eurCredit(v.id, '50.00');
    await refundVendorCredit(ctx, { vendorCreditId: vc.id, bankAccountId: acct['1000'], amount: '50.00', date: d('2026-08-01'), exchangeRate: '1.30' });
    const before = (await apAgingDetail(ctx, d('2026-07-20'))).rows.find((r) => r.docId === vc.id);
    expect(before?.openBalance).toBe(home('50.00', '1.2345').negated().toFixed(2));
    expect((await apAgingDetail(ctx, d('2026-08-02'))).rows.find((r) => r.docId === vc.id)).toBeUndefined();
    expect(await apMismatches([...days('2026-07-01', '2026-08-05'), FAR])).toEqual([]);
  });

  it('[A4-home] a home credit partly applied, then refunded after the cutoff: aging == GL A/P on every day', async () => {
    const v = await createVendor(ctx, { displayName: 'A4 Home Vendor' });
    const bill = await createBill(ctx, { vendorId: v.id, date: d('2026-06-01'), lines: [{ accountId: acct['6000'], amount: '40.00' }] } as never);
    const vc = await createVendorCredit(ctx, { vendorId: v.id, date: d('2026-07-01'), lines: [{ accountId: acct['6000'], amount: '100.00' }] } as never);
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '25.00' });
    await refundVendorCredit(ctx, { vendorCreditId: vc.id, bankAccountId: acct['1000'], amount: '30.00', date: d('2026-08-10') });
    expect(await apAsOf(d('2026-07-15'))).toBe('-60.00');
    const row = (await apAgingDetail(ctx, d('2026-07-15'))).rows.find((r) => r.docId === vc.id)!;
    expect(row.openBalance).toBe('-75.00'); // 100 - 25 applied (effective 07-01); the refund came later
    expect(row.currency ?? null).toBeNull();
    expect(await apMismatches([...days('2026-06-28', '2026-08-15'), new Date(), FAR])).toEqual([]);
    await balanced();
  });

  // ---------------------------------------------------------------------------------------------
  // [C1] home credit memo on a foreign invoice
  // ---------------------------------------------------------------------------------------------

  it('[C1] a home credit memo is refused on a EUR invoice, directly and with Receive Payments; A/R aging == GL', async () => {
    const c = await createCustomer(ctx, { displayName: 'C1 Customer' } as never);
    const inv = await createInvoice(ctx, {
      customerId: c.id,
      date: d('2026-06-01'),
      currency: 'EUR',
      exchangeRate: '1.1111',
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '40.00' }],
    } as never);
    const memo = await createCreditMemo(ctx, {
      customerId: c.id,
      date: d('2026-06-02'),
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '10.00' }],
    } as never);
    await expect(applyToInvoice(ctx, { creditMemoId: memo.id, invoiceId: inv.id, amount: '10.00' })).rejects.toThrow(/This invoice is in EUR\./);
    await expect(
      receivePayment(ctx, {
        customerId: c.id,
        date: d('2026-06-03'),
        method: 'check',
        amount: '20.00',
        currency: 'EUR',
        exchangeRate: '1.12',
        depositAccountId: acct['1000'],
        applications: [{ invoiceId: inv.id, amountApplied: '20.00' }],
        credits: [{ creditMemoId: memo.id, invoiceId: inv.id, amount: '10.00' }],
      } as never),
    ).rejects.toThrow();
    const [row] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(row.balanceDue).toBe('40.00');
    expect(await db.select().from(paymentsReceived).where(eq(paymentsReceived.companyId, ctx.companyId))).toEqual([]);
    expect(Money.of((await arAging(ctx)).totals.total).toFixed(2)).toBe(await arAsOf(FAR));
    await balanced();
  });

  // ---------------------------------------------------------------------------------------------
  // [merge] foreign credit + Items tab; blank-rate edit keeps the saved rate
  // ---------------------------------------------------------------------------------------------

  it('[merge] a EUR credit returning inventory posts home amounts: stock at cost, price difference to COGS', async () => {
    const v = await eurVendor('Merge Items Vendor');
    const widget = (
      await createItem(ctx, { name: 'Widget', type: 'inventory', assetAccountId: acct['1300'], incomeAccountId: acct['4000'], purchaseCost: '10' } as never)
    ).id;
    await adjustInventory(ctx, { itemId: widget, quantityChange: '10', unitCost: '10', date: d('2026-01-05') } as never);
    const vc = await createVendorCredit(ctx, {
      vendorId: v.id,
      date: d('2026-02-01'),
      exchangeRate: '1.20',
      lines: [
        { itemId: widget, quantity: '3', unitCost: '11' }, // 33.00 EUR = 39.60 home, stock leaves at 30.00
        { accountId: acct['6000'], amount: '5.00' }, // 6.00 home
      ],
    } as never);
    expect(vc.currency).toBe('EUR');
    expect(vc.total).toBe('38.00');
    expect(vc.homeTotal).toBe('45.60');
    const lines = await db
      .select({ accountId: journalEntryLines.accountId, debit: journalEntryLines.debit, credit: journalEntryLines.credit })
      .from(journalEntryLines)
      .where(eq(journalEntryLines.journalEntryId, vc.postedEntryId!));
    const net = (code: string) =>
      lines
        .filter((l) => l.accountId === acct[code])
        .reduce((s, l) => s.plus(Money.of(l.debit ?? 0)).minus(Money.of(l.credit ?? 0)), Money.zero())
        .toFixed(2);
    expect(net('2000')).toBe('45.60');
    expect(net('1300')).toBe('-30.00');
    expect(net('5000')).toBe('-9.60');
    expect(net('6000')).toBe('-6.00');
    expect(await apMismatches([d('2026-01-31'), d('2026-02-01'), FAR])).toEqual([]);
    await balanced();
  });

  it('[merge] a memo edit of an applied EUR credit with a blank rate keeps its saved rate (ledger-neutral)', async () => {
    const v = await eurVendor('Merge Edit Vendor');
    const bill = await eurBill(v.id, '40.00');
    const vc = await eurCredit(v.id, '20.00');
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '20.00', date: d('2026-07-02') });
    // Today's list rate (1.10) differs from the credit's 1.2345; a blank rate must not re-post.
    const edited = await updateVendorCredit(ctx, vc.id, {
      vendorId: v.id,
      date: d('2026-07-01'),
      memo: 'Damaged goods',
      lines: [{ accountId: acct['6000'], amount: '20.00' }],
    } as never);
    expect(edited.memo).toBe('Damaged goods');
    expect(edited.exchangeRate).toBe(vc.exchangeRate);
    expect(edited.postedEntryId).toBe(vc.postedEntryId);
    // A different stated rate is a ledger change, refused while the credit is applied.
    await expect(
      updateVendorCredit(ctx, vc.id, {
        vendorId: v.id,
        date: d('2026-07-01'),
        exchangeRate: '1.30',
        lines: [{ accountId: acct['6000'], amount: '20.00' }],
      } as never),
    ).rejects.toThrow(/Unapply it first/);
    await balanced();
  });
});
