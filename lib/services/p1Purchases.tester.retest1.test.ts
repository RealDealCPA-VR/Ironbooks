/**
 * P1 purchases — tester re-test round 1 (verifies fix commit 332b40a).
 *
 *   A. Cash-basis Sales Tax Revenue Summary: sales are allocated on a running total, so any split
 *      of a period (months, half-months, uneven ranges) adds up exactly to the whole, for taxable,
 *      non-taxable and total sales; payments before/after the range are excluded; fully paid ==
 *      accrual; credit memos applied; accrual is unaffected.
 *   B. paySalesTaxAgencies is atomic: a run that fails anywhere (used check number, unknown 2nd
 *      agency, closing date) leaves no vendors, agency links or audit rows; success links an
 *      existing same-name vendor without duplicates; reruns reuse the vendor.
 *   C. markPaymentCheckPrinted refuses checks whose journal entry was voided outside the check, for
 *      every kind (sales tax, payroll liability, customer refund), and leaves the row untouched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, auditLogs, journalEntries, paymentChecks, taxAgencies, users, vendors } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany, setClosingDate, updateCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createInvoice } from './invoices';
import { receivePayment } from './payments';
import { applyToInvoice, createCreditMemo, refundCreditMemo } from './creditMemos';
import { trialBalance, balanceSheet } from './reports';
import { verifyIntegrity } from './integrity';
import { createTaxAgency, createTaxRate } from './salesTax';
import { postJournalEntry, voidJournalEntry } from './posting';
import {
  listPaymentChecks,
  payPayrollLiabilities,
  paySalesTaxAgencies,
  queueCustomerRefundCheck,
  unprintedRefunds,
  voidPaymentCheck,
} from './liabilityPayments';
import { listPrintQueue, markPrinted } from './printQueue';
import { salesTaxLiabilityReport, salesTaxRevenueSummary } from './accountant/salesTaxLedger';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-purchases-retest1');
let db: DB;
let userId: string;
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const start = (s: string) => new Date(`${s}T00:00:00.000Z`);
const endOf = (s: string) => new Date(`${s}T23:59:59.999Z`);
const cents = (s: string) => Math.round(Number(s) * 100);

async function newCompany(name: string) {
  const company = await createCompany(db, { name, ownerId: userId });
  const ctx: ServiceContext = { db, companyId: company.id, userId };
  const acct: Record<string, string> = {};
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
  return { ctx, acct };
}

async function expectBooksSound(ctx: ServiceContext) {
  expect((await trialBalance(ctx)).balanced).toBe(true);
  expect((await balanceSheet(ctx)).balanced).toBe(true);
  const integrity = await verifyIntegrity(ctx);
  expect(integrity.checks.filter((c) => !c.ok)).toEqual([]);
}

type Totals = { totalSales: string; nonTaxableSales: string; taxableSales: string; taxCollected: string };
const FIELDS = ['totalSales', 'nonTaxableSales', 'taxableSales', 'taxCollected'] as const;

/** Sum the cash-basis summary over consecutive ranges, in cents per field. */
async function sumRanges(ctx: ServiceContext, ranges: Array<[string, string]>) {
  const out: Record<(typeof FIELDS)[number], number> = { totalSales: 0, nonTaxableSales: 0, taxableSales: 0, taxCollected: 0 };
  for (const [from, to] of ranges) {
    const r = await salesTaxRevenueSummary(ctx, { from: start(from), to: endOf(to), basis: 'cash' });
    for (const f of FIELDS) out[f] += cents(r.totals[f]);
  }
  return out;
}

function expectSameTotals(sum: Record<string, number>, whole: Totals) {
  for (const f of FIELDS) expect({ f, v: (sum[f] / 100).toFixed(2) }).toEqual({ f, v: whole[f] });
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db
    .insert(users)
    .values({ email: 'p1-purchases-retest1@test.local', name: 'P1 Retest', passwordHash: 'x' })
    .returning();
  userId = user.id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// =================================================================================================
// A. Cash-basis Revenue Summary — running-total allocation
// =================================================================================================
describe('cash-basis Sales Tax Revenue Summary — periods add up exactly', () => {
  let ctx: ServiceContext;
  let rate: string;
  let cust: string;

  beforeAll(async () => {
    ({ ctx } = await newCompany('Retest Cash Summary Co'));
    await updateCompany(ctx, { settings: { salesTaxBasis: 'cash', salesTaxFrequency: 'monthly' } as never });
    const ag = (await createTaxAgency(ctx, { name: 'Running Total Agency' })).id;
    rate = (await createTaxRate(ctx, { name: 'RT 8.25%', rate: '0.0825', agencyId: ag })).id;
    cust = (await createCustomer(ctx, { displayName: 'Awkward Amounts Inc' })).id;

    // Invoice 1: mixed taxable / non-taxable lines with odd cents, paid in 4 awkward installments.
    const inv1 = await createInvoice(ctx, {
      customerId: cust,
      date: d('2026-07-03'),
      taxRateId: rate,
      lines: [
        { description: 'Widget', quantity: 3, rate: '3.33' },
        { description: 'Gizmo', quantity: 1, rate: '7.77' },
        { description: 'Labor (not taxed)', quantity: 1, rate: '5.55', taxable: false },
      ],
    });
    const pay = async (date: string, amount: string, invoiceId: string) =>
      receivePayment(ctx, { customerId: cust, date: d(date), method: 'check', amount, applications: [{ invoiceId, amountApplied: amount }] });
    const t1 = Number(inv1.total);
    const p1 = (t1 / 3).toFixed(2);
    const p2 = (t1 / 7).toFixed(2);
    const p3 = (t1 / 5).toFixed(2);
    const p4 = (t1 - Number(p1) - Number(p2) - Number(p3)).toFixed(2);
    await pay('2026-07-09', p1, inv1.id);
    await pay('2026-07-22', p2, inv1.id);
    await pay('2026-08-17', p3, inv1.id);
    await pay('2026-09-29', p4, inv1.id);

    // Invoice 2: three equal-ish thirds (the classic penny-drift case).
    const inv2 = await createInvoice(ctx, { customerId: cust, date: d('2026-07-04'), taxRateId: rate, lines: [{ description: 'Thing', quantity: 1, rate: '1.00' }] });
    const t2 = Number(inv2.total); // 1.08
    await pay('2026-07-15', '0.36', inv2.id);
    await pay('2026-08-15', '0.36', inv2.id);
    await pay('2026-09-15', (t2 - 0.72).toFixed(2), inv2.id);

    // Invoice 3: paid in full before the quarter (June) — must not appear in Q3 at all.
    const inv3 = await createInvoice(ctx, { customerId: cust, date: d('2026-06-01'), taxRateId: rate, lines: [{ description: 'Old', quantity: 1, rate: '99.99' }] });
    await pay('2026-06-20', inv3.total, inv3.id);

    // Invoice 4: partly paid in June, rest in August.
    const inv4 = await createInvoice(ctx, { customerId: cust, date: d('2026-06-05'), taxRateId: rate, lines: [{ description: 'Split', quantity: 1, rate: '33.33' }] });
    await pay('2026-06-25', '11.11', inv4.id);
    await pay('2026-08-02', (Number(inv4.total) - 11.11).toFixed(2), inv4.id);

    // Invoice 5: partly paid in September, rest in October (after the quarter).
    const inv5 = await createInvoice(ctx, { customerId: cust, date: d('2026-09-01'), taxRateId: rate, lines: [{ description: 'Late', quantity: 1, rate: '20.01' }] });
    await pay('2026-09-20', '7.77', inv5.id);
    await pay('2026-10-05', (Number(inv5.total) - 7.77).toFixed(2), inv5.id);
  });

  it('months add up to the quarter for total, non-taxable, taxable sales and tax', async () => {
    const q = await salesTaxRevenueSummary(ctx, { from: start('2026-07-01'), to: endOf('2026-09-30'), basis: 'cash' });
    const sum = await sumRanges(ctx, [
      ['2026-07-01', '2026-07-31'],
      ['2026-08-01', '2026-08-31'],
      ['2026-09-01', '2026-09-30'],
    ]);
    expectSameTotals(sum, q.totals);
    expect(Number(q.totals.nonTaxableSales)).toBeGreaterThan(0);
    expect(Number(q.totals.taxableSales)).toBeGreaterThan(0);
  });

  it('uneven splits (half-months, single days) also add up to the quarter', async () => {
    const q = await salesTaxRevenueSummary(ctx, { from: start('2026-07-01'), to: endOf('2026-09-30'), basis: 'cash' });
    const sum = await sumRanges(ctx, [
      ['2026-07-01', '2026-07-09'],
      ['2026-07-10', '2026-07-21'],
      ['2026-07-22', '2026-08-16'],
      ['2026-08-17', '2026-08-17'],
      ['2026-08-18', '2026-09-28'],
      ['2026-09-29', '2026-09-30'],
    ]);
    expectSameTotals(sum, q.totals);
  });

  it('the quarter plus the months around it add up to the all-time total (June + Q3 + Oct)', async () => {
    const all = await salesTaxRevenueSummary(ctx, { from: start('2026-01-01'), to: endOf('2026-12-31'), basis: 'cash' });
    const sum = await sumRanges(ctx, [
      ['2026-01-01', '2026-06-30'],
      ['2026-07-01', '2026-09-30'],
      ['2026-10-01', '2026-12-31'],
    ]);
    expectSameTotals(sum, all.totals);
    // Every invoice is fully paid by year end, so cash == accrual for the year.
    const acc = await salesTaxRevenueSummary(ctx, { from: start('2026-01-01'), to: endOf('2026-12-31'), basis: 'accrual' });
    for (const f of FIELDS) expect({ f, v: all.totals[f] }).toEqual({ f, v: acc.totals[f] });
  });

  it('a range containing no payments shows nothing, even though invoices are open', async () => {
    const r = await salesTaxRevenueSummary(ctx, { from: start('2026-08-18'), to: endOf('2026-09-14'), basis: 'cash' });
    expect(r.totals).toEqual({ totalSales: '0.00', nonTaxableSales: '0.00', taxableSales: '0.00', taxCollected: '0.00' });
  });

  it('per month, tax collected is within a cent per invoice of taxable sales x rate', async () => {
    for (const [from, to] of [
      ['2026-07-01', '2026-07-31'],
      ['2026-08-01', '2026-08-31'],
      ['2026-09-01', '2026-09-30'],
    ]) {
      const r = await salesTaxRevenueSummary(ctx, { from: start(from), to: endOf(to), basis: 'cash' });
      const implied = Math.round(Number(r.totals.taxableSales) * 0.0825 * 100);
      expect(Math.abs(cents(r.totals.taxCollected) - implied)).toBeLessThanOrEqual(5);
    }
  });

  it('accrual basis is unchanged: invoices count in full on their own date', async () => {
    const r = await salesTaxRevenueSummary(ctx, { from: start('2026-09-01'), to: endOf('2026-09-30'), basis: 'accrual' });
    // Only invoice 5 (20.01 taxable) is dated in September.
    expect(r.totals.taxableSales).toBe('20.01');
    expect(r.totals.totalSales).toBe('20.01');
    expect(r.totals.taxCollected).toBe('1.65');
  });

  it('a credit memo applied to an invoice: cash quarter = accrual quarter once fully settled, months add up', async () => {
    const { ctx: c2 } = await newCompany('Retest Memo Summary Co');
    const ag = (await createTaxAgency(c2, { name: 'Memo Summary Agency' })).id;
    const rt = (await createTaxRate(c2, { name: 'MS 10%', rate: '0.10', agencyId: ag })).id;
    const cu = (await createCustomer(c2, { displayName: 'Memo Max' })).id;
    const inv = await createInvoice(c2, { customerId: cu, date: d('2026-07-01'), taxRateId: rt, lines: [{ description: 'Job', quantity: 1, rate: '100.00' }] });
    const memo = await createCreditMemo(c2, { customerId: cu, date: d('2026-07-02'), taxRateId: rt, lines: [{ description: 'Discount', quantity: 1, rate: '33.33' }] });
    await applyToInvoice(c2, { creditMemoId: memo.id, invoiceId: inv.id, amount: memo.total });
    const rest = (Number(inv.total) - Number(memo.total)).toFixed(2);
    await receivePayment(c2, { customerId: cu, date: d('2026-08-20'), method: 'check', amount: '20.00', applications: [{ invoiceId: inv.id, amountApplied: '20.00' }] });
    const last = (Number(rest) - 20).toFixed(2);
    await receivePayment(c2, { customerId: cu, date: d('2026-09-20'), method: 'check', amount: last, applications: [{ invoiceId: inv.id, amountApplied: last }] });

    const q = await salesTaxRevenueSummary(c2, { from: start('2026-07-01'), to: endOf('2026-09-30'), basis: 'cash' });
    const acc = await salesTaxRevenueSummary(c2, { from: start('2026-07-01'), to: endOf('2026-09-30'), basis: 'accrual' });
    for (const f of FIELDS) expect({ f, v: q.totals[f] }).toEqual({ f, v: acc.totals[f] });
    expect(q.totals.taxableSales).toBe('66.67');
    const sum = await sumRanges(c2, [
      ['2026-07-01', '2026-07-31'],
      ['2026-08-01', '2026-08-31'],
      ['2026-09-01', '2026-09-30'],
    ]);
    expectSameTotals(sum, q.totals);
    await expectBooksSound(c2);
  });
});

// =================================================================================================
// B. paySalesTaxAgencies atomicity
// =================================================================================================
describe('Pay Sales Tax run is atomic — no vendors, links or audit rows survive a failure', () => {
  let ctx: ServiceContext;
  let acct: Record<string, string>;
  let agA: string;
  let agB: string;

  const snapshot = async (c: ServiceContext) => ({
    vendors: (await db.select().from(vendors).where(eq(vendors.companyId, c.companyId))).map((v) => v.id).sort(),
    links: (await db.select().from(taxAgencies).where(eq(taxAgencies.companyId, c.companyId))).map((a) => `${a.id}:${a.vendorId}`).sort(),
    audit: (await db.select().from(auditLogs).where(eq(auditLogs.companyId, c.companyId))).length,
    entries: (await db.select().from(journalEntries).where(eq(journalEntries.companyId, c.companyId))).length,
    checks: (await db.select().from(paymentChecks).where(eq(paymentChecks.companyId, c.companyId))).length,
  });

  beforeAll(async () => {
    ({ ctx, acct } = await newCompany('Retest Atomic Co'));
    agA = (await createTaxAgency(ctx, { name: 'Gamma Tax Office' })).id;
    agB = (await createTaxAgency(ctx, { name: 'Delta Revenue Dept' })).id;
    const rA = (await createTaxRate(ctx, { name: 'G 6%', rate: '0.06', agencyId: agA })).id;
    const rB = (await createTaxRate(ctx, { name: 'D 2%', rate: '0.02', agencyId: agB })).id;
    const cu = (await createCustomer(ctx, { displayName: 'Atomic Annie' })).id;
    await createInvoice(ctx, { customerId: cu, date: d('2026-07-10'), taxRateId: rA, lines: [{ description: 'a', quantity: 1, rate: '1000.00' }] });
    await createInvoice(ctx, { customerId: cu, date: d('2026-07-11'), taxRateId: rB, lines: [{ description: 'b', quantity: 1, rate: '1000.00' }] });
    // Occupy check 702 on the bank account.
    await postJournalEntry(ctx, { date: d('2026-07-01'), description: 'Accrue', lines: [{ accountId: acct['6500'], debit: '10.00' }, { accountId: acct['2300'], credit: '10.00' }] });
    await payPayrollLiabilities(ctx, { date: d('2026-07-15'), paymentAccountId: acct['1000'], amount: '10.00', payeeName: 'IRS', checkNumber: '702' });
  });

  it('used check number on the 2nd agency: nothing at all changes (vendors, links, audit, entries, checks)', async () => {
    const before = await snapshot(ctx);
    await expect(
      paySalesTaxAgencies(ctx, {
        date: d('2026-08-05'),
        paymentAccountId: acct['1000'],
        payments: [
          { agencyId: agA, amount: '60.00' },
          { agencyId: agB, amount: '20.00' },
        ],
        checkNumber: '701',
        dueThrough: '2026-07-31',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await snapshot(ctx)).toEqual(before);
  });

  it('an unknown 2nd agency (valid UUID, not in this company) rolls back the 1st agency\'s vendor', async () => {
    const { ctx: other } = await newCompany('Retest Atomic Other');
    const foreign = (await createTaxAgency(other, { name: 'Foreign Agency' })).id;
    const before = await snapshot(ctx);
    const otherBefore = await snapshot(other);
    await expect(
      paySalesTaxAgencies(ctx, {
        date: d('2026-08-05'),
        paymentAccountId: acct['1000'],
        payments: [
          { agencyId: agA, amount: '60.00' },
          { agencyId: foreign, amount: '1.00' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await snapshot(ctx)).toEqual(before);
    expect(await snapshot(other)).toEqual(otherBefore);
  });

  it('a closing-date failure leaves no vendors behind either', async () => {
    const { ctx: c2, acct: a2 } = await newCompany('Retest Atomic Closed');
    const ag = (await createTaxAgency(c2, { name: 'Closed Gate Agency' })).id;
    await setClosingDate(c2, { closingDate: '2026-06-30' });
    const before = await snapshot(c2);
    await expect(
      paySalesTaxAgencies(c2, { date: d('2026-06-10'), paymentAccountId: a2['1000'], payments: [{ agencyId: ag, amount: '5.00' }] }),
    ).rejects.toBeTruthy();
    // The closing-date settings row may write its own audit when set; compare after it.
    expect(await snapshot(c2)).toEqual(before);
  });

  it('success links an existing same-name vendor (case-insensitive) — no duplicate vendor', async () => {
    const existing = await createVendor(ctx, { displayName: 'GAMMA TAX OFFICE' });
    const res = await paySalesTaxAgencies(ctx, {
      date: d('2026-08-06'),
      paymentAccountId: acct['1000'],
      payments: [
        { agencyId: agA, amount: '60.00' },
        { agencyId: agB, amount: '20.00' },
      ],
      checkNumber: '703',
    });
    expect(res.checks.map((c) => c.reference)).toEqual(['703', '704']);
    expect(res.total).toBe('80.00');
    const [a] = await db.select().from(taxAgencies).where(eq(taxAgencies.id, agA));
    expect(a.vendorId).toBe(existing.id);
    expect(res.checks[0].vendorId).toBe(existing.id);
    const vs = await db.select().from(vendors).where(eq(vendors.companyId, ctx.companyId));
    expect(vs.filter((v) => v.displayName.toLowerCase() === 'gamma tax office')).toHaveLength(1);
    expect(vs.filter((v) => v.displayName === 'Delta Revenue Dept')).toHaveLength(1);
    const rep = await salesTaxLiabilityReport(ctx);
    expect(rep.agencies.find((x) => x.agencyId === agA)?.balance).toBe('0.00');
    expect(rep.agencies.find((x) => x.agencyId === agB)?.balance).toBe('0.00');
    expect(rep.tiesToGl).toBe(true);
    await expectBooksSound(ctx);
  });

  it('a later run reuses the linked vendors (no new vendors, no re-link audit)', async () => {
    const vendorsBefore = (await db.select().from(vendors).where(eq(vendors.companyId, ctx.companyId))).length;
    const linkAudits = async () =>
      (await db.select().from(auditLogs).where(and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityType, 'tax_agency')))).length;
    const la = await linkAudits();
    const res = await paySalesTaxAgencies(ctx, { date: d('2026-08-07'), paymentAccountId: acct['1000'], payments: [{ agencyId: agB, amount: '1.00' }], toPrint: true });
    expect((await db.select().from(vendors).where(eq(vendors.companyId, ctx.companyId))).length).toBe(vendorsBefore);
    expect(await linkAudits()).toBe(la);
    await voidPaymentCheck(ctx, res.checks[0].id);
    await expectBooksSound(ctx);
  });
});

// =================================================================================================
// C. Printing a check whose entry was voided elsewhere
// =================================================================================================
describe('a payment check whose journal entry was voided elsewhere cannot be printed (any kind)', () => {
  let ctx: ServiceContext;
  let acct: Record<string, string>;

  beforeAll(async () => {
    ({ ctx, acct } = await newCompany('Retest Print Void Co'));
  });

  async function expectUnprintable(checkId: string, entryId: string) {
    const [beforeRow] = await db.select().from(paymentChecks).where(eq(paymentChecks.id, checkId));
    const [beforeJe] = await db.select().from(journalEntries).where(eq(journalEntries.id, entryId));
    await voidJournalEntry(ctx, entryId);
    expect((await listPrintQueue(ctx)).some((q) => q.id === checkId)).toBe(false);
    expect((await listPaymentChecks(ctx)).find((c) => c.id === checkId)?.isVoid).toBe(true);
    await expect(markPrinted(ctx, { source: 'payment_check', id: checkId, checkNumber: '5001' })).rejects.toMatchObject({ code: 'CONFLICT' });
    // Without an explicit number (auto next number) too.
    await expect(markPrinted(ctx, { source: 'payment_check', id: checkId })).rejects.toMatchObject({ code: 'CONFLICT' });
    const [row] = await db.select().from(paymentChecks).where(eq(paymentChecks.id, checkId));
    expect({ toPrint: row.toPrint, reference: row.reference }).toEqual({ toPrint: beforeRow.toPrint, reference: beforeRow.reference });
    const [je] = await db.select().from(journalEntries).where(eq(journalEntries.id, entryId));
    expect(je.reference).toBe(beforeJe.reference);
    // Number 5001 is still free for a real check.
    await expectBooksSound(ctx);
  }

  it('sales tax payment check', async () => {
    const ag = (await createTaxAgency(ctx, { name: 'Print Void Agency' })).id;
    const res = await paySalesTaxAgencies(ctx, { date: d('2026-08-01'), paymentAccountId: acct['1000'], payments: [{ agencyId: ag, amount: '4.00' }], toPrint: true });
    await expectUnprintable(res.checks[0].id, res.checks[0].entryId);
  });

  it('payroll liability check', async () => {
    await postJournalEntry(ctx, { date: d('2026-08-01'), description: 'Accrue', lines: [{ accountId: acct['6500'], debit: '9.00' }, { accountId: acct['2300'], credit: '9.00' }] });
    const entry = await payPayrollLiabilities(ctx, { date: d('2026-08-02'), paymentAccountId: acct['1000'], amount: '9.00', payeeName: 'State', toPrint: true });
    const [check] = await db.select().from(paymentChecks).where(eq(paymentChecks.postedEntryId, entry.id));
    expect(check.kind).toBe('payroll_liability');
    await expectUnprintable(check.id, entry.id);
  });

  it('customer refund check', async () => {
    const cu = (await createCustomer(ctx, { displayName: 'Refund Rita' })).id;
    const memo = await createCreditMemo(ctx, { customerId: cu, date: d('2026-08-03'), lines: [{ description: 'Return', quantity: 1, rate: '12.00' }] });
    await refundCreditMemo(ctx, { creditMemoId: memo.id, bankAccountId: acct['1000'], amount: '12.00', date: d('2026-08-04') });
    const [r] = await unprintedRefunds(ctx);
    const check = await queueCustomerRefundCheck(ctx, { entryId: r.entryId });
    await expectUnprintable(check.id, r.entryId);
  });

  it('regression: a live queued check still prints once, then is out of the queue', async () => {
    const ag = (await createTaxAgency(ctx, { name: 'Live Print Agency' })).id;
    const res = await paySalesTaxAgencies(ctx, { date: d('2026-08-05'), paymentAccountId: acct['1000'], payments: [{ agencyId: ag, amount: '3.00' }], toPrint: true });
    const c = res.checks[0];
    expect((await listPrintQueue(ctx)).some((q) => q.id === c.id)).toBe(true);
    const printed = await markPrinted(ctx, { source: 'payment_check', id: c.id, checkNumber: '5001' });
    expect(printed).toMatchObject({ toPrint: false, reference: '5001' });
    const [je] = await db.select().from(journalEntries).where(eq(journalEntries.id, c.entryId));
    expect(je.reference).toBe('5001');
    await expect(markPrinted(ctx, { source: 'payment_check', id: c.id, checkNumber: '5002' })).rejects.toMatchObject({ code: 'CONFLICT' });
    // A check voided through Void Check after printing keeps its number and cannot be re-printed.
    await voidPaymentCheck(ctx, c.id);
    await expect(markPrinted(ctx, { source: 'payment_check', id: c.id, checkNumber: '5003' })).rejects.toMatchObject({ code: 'CONFLICT' });
    const [row] = await db.select().from(paymentChecks).where(eq(paymentChecks.id, c.id));
    expect(row.reference).toBe('5001');
    await expectBooksSound(ctx);
  });
});
