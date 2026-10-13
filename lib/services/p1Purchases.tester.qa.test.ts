/**
 * P1 purchases — independent adversarial QA (tester round).
 *
 * Probes every purchases-team P1 item beyond the doer's own tests:
 *   1. Pay Sales Tax permission split (sales_tax vs payroll) incl. void routes.
 *   2. Cash basis / filing frequency: penny-exact pro-rata allocation over several partial
 *      payments, voided customer payments, applied credit memos, report consistency across periods.
 *   3. Sales tax payment checks: rollback on failure, closing date, multi-company isolation,
 *      checks voided outside the check (Batch Void), rounding, overpayment.
 *   4. Check paper modes: settings persistence and upgraded databases.
 *   5. Vendor credits: A/P control == aging == vendor balance through apply / refund / refund void,
 *      inventory returns vs the stock subledger, rollback, closing date, isolation, validation.
 *   6. Inventory adjustments: Adjustment Account default (created once, rolled back on failure),
 *      cross-company dimensions, UI / API wiring.
 *   + migration 0042 replay on an upgraded database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  accounts,
  checkPrintSettings,
  items,
  journalEntries,
  journalEntryLines,
  paymentChecks,
  taxAgencies,
  users,
  vendorCreditLines,
  vendorCredits,
  vendors,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany, setClosingDate, updateCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createInvoice } from './invoices';
import { receivePayment, voidPayment } from './payments';
import { applyToInvoice, createCreditMemo, getCreditMemo, refundCreditMemo } from './creditMemos';
import { createBill } from './bills';
import { createItem } from './items';
import { createClass } from './dimensions';
import { createJob } from './jobs';
import { createAccount } from './accounts';
import { trialBalance, balanceSheet } from './reports';
import { verifyIntegrity } from './integrity';
import { apAging, arAging } from './reportsExtra';
import { createTaxAgency, createTaxRate } from './salesTax';
import { postJournalEntry, voidJournalEntry } from './posting';
import { adjustInventory } from './inventory';
import { receiveStock } from './fifo';
import { adjustQuantityAtSite } from './inventorySiteOps';
import {
  listPaymentChecks,
  payPayrollLiabilities,
  paySalesTaxAgencies,
  paySalesTaxScreen,
  queueCustomerRefundCheck,
  unprintedRefunds,
  voidPaymentCheck,
} from './liabilityPayments';
import { checkPrintData, getCheckPrintSettings, listPrintQueue, markPrinted, saveCheckPrintSettings } from './printQueue';
import { salesTaxDueThrough, salesTaxLiabilityReport, salesTaxRevenueSummary, lastFilingPeriod } from './accountant/salesTaxLedger';
import {
  applyToBill,
  createVendorCredit,
  getVendorCredit,
  refundVendorCredit,
  unapplyFromBill,
  updateVendorCredit,
  voidVendorCredit,
} from './vendorCredits';
import { createVendorCreditSchema } from '@/lib/validation/vendorCredits';
import { apiRuleFor, pageAreasFor } from '@/lib/permissions/routes';
import { builtinRole, can, unionRoles, type Area } from '@/lib/permissions/model';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-purchases-tester-qa');
const ROOT = process.cwd();
let db: DB;
let userId: string;
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const endOf = (s: string) => new Date(`${s}T23:59:59.999Z`);

async function newCompany(name: string) {
  const company = await createCompany(db, { name, ownerId: userId });
  const ctx: ServiceContext = { db, companyId: company.id, userId };
  const acct: Record<string, string> = {};
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
  return { ctx, acct };
}

/** Debit-minus-credit of posted lines on an account. */
async function balanceOf(ctx: ServiceContext, accountId: string): Promise<string> {
  const rows = await db
    .select({ debit: journalEntryLines.debit, credit: journalEntryLines.credit })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.status, 'posted'), eq(journalEntryLines.accountId, accountId)));
  const cents = rows.reduce((s, r) => s + Math.round(Number(r.debit ?? 0) * 100) - Math.round(Number(r.credit ?? 0) * 100), 0);
  return (cents / 100).toFixed(2);
}

async function itemRow(id: string) {
  const [row] = await db.select().from(items).where(eq(items.id, id));
  return row;
}

/** TB balanced, balance sheet balanced, integrity checks all pass. */
async function expectBooksSound(ctx: ServiceContext) {
  const tb = await trialBalance(ctx);
  expect(tb.balanced).toBe(true);
  const bs = await balanceSheet(ctx);
  expect(bs.balanced).toBe(true);
  const integrity = await verifyIntegrity(ctx);
  expect(integrity.checks.filter((c) => !c.ok)).toEqual([]);
}

/** A/P control account (credit balance) == A/P aging total == sum of vendor rows. */
async function expectApTies(ctx: ServiceContext, acct: Record<string, string>, vendorId?: string, vendorTotal?: string) {
  const control = (-Number(await balanceOf(ctx, acct['2000']))).toFixed(2);
  const aging = await apAging(ctx);
  expect(Number(aging.totals.total).toFixed(2)).toBe(control);
  const sumRows = aging.rows.reduce((s, r) => s + Math.round(Number(r.total) * 100), 0) / 100;
  expect(sumRows.toFixed(2)).toBe(control);
  if (vendorId && vendorTotal !== undefined) {
    const row = aging.rows.find((r) => r.id === vendorId);
    expect(Number(row?.total ?? 0).toFixed(2)).toBe(vendorTotal);
  }
}

async function expectArTies(ctx: ServiceContext, acct: Record<string, string>) {
  const control = Number(await balanceOf(ctx, acct['1200'])).toFixed(2);
  const aging = await arAging(ctx);
  expect(Number(aging.totals.total).toFixed(2)).toBe(control);
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db
    .insert(users)
    .values({ email: 'p1-purchases-tester@test.local', name: 'P1 Tester QA', passwordHash: 'x' })
    .returning();
  userId = user.id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// =================================================================================================
// 1. Permissions
// =================================================================================================
describe('Pay Sales Tax permission split (adversarial)', () => {
  const access = (key: string) => unionRoles([builtinRole(key)!]);
  const allowed = (key: string, p: string, method: string) => {
    const rule = apiRuleFor(p, method);
    if (!rule || typeof rule === 'string') return false;
    return can(access(key), rule.area as Area, rule.action);
  };
  const ID = '00000000-0000-0000-0000-000000000001';

  it('a payroll-only user can neither see, pay nor void sales tax checks', () => {
    expect(allowed('payroll_processor', '/api/sales-tax/payments', 'GET')).toBe(false);
    expect(allowed('payroll_processor', `/api/sales-tax/payments/${ID}`, 'GET')).toBe(false);
    expect(allowed('payroll_processor', `/api/sales-tax/payments/${ID}`, 'POST')).toBe(false);
    expect(allowed('payroll_processor', '/api/accountant/sales-tax/liability', 'GET')).toBe(false);
    expect(allowed('payroll_processor', '/api/accountant/sales-tax/revenue-summary', 'GET')).toBe(false);
  });

  it('a bookkeeper (sales tax, no payroll) cannot void payroll liability checks', () => {
    // Voiding is a delete-level action (bookkeepers have NO_DELETE everywhere); admins can.
    expect(allowed('admin', `/api/sales-tax/payments/${ID}`, 'POST')).toBe(true);
    expect(allowed('bookkeeper', '/api/sales-tax/pay', 'POST')).toBe(true);
    expect(allowed('bookkeeper', `/api/pay-liabilities/checks/${ID}`, 'POST')).toBe(false);
    expect(allowed('payroll_processor', `/api/pay-liabilities/checks/${ID}`, 'POST')).toBe(true);
    expect(allowed('bookkeeper', '/api/pay-liabilities/by-item', 'POST')).toBe(false);
  });

  it('each void route only voids its own kind of check (no cross-area void through the other route)', () => {
    const st = fs.readFileSync(path.join(ROOT, 'app/api/sales-tax/payments/[id]/route.ts'), 'utf8');
    expect(st).toMatch(/kind !== 'sales_tax'/);
    const pl = fs.readFileSync(path.join(ROOT, 'app/api/pay-liabilities/checks/[id]/route.ts'), 'utf8');
    expect(pl).toMatch(/kind !== 'payroll_liability'/);
    // The by-item payroll endpoint must not post to sales tax either.
    const byItem = fs.readFileSync(path.join(ROOT, 'app/api/pay-liabilities/by-item/route.ts'), 'utf8');
    expect(byItem).not.toMatch(/paySalesTax/);
  });

  it('the Pay Sales Tax page is gated by sales_tax and listed in the nav under the same area', () => {
    expect(pageAreasFor('/sales-tax')).toEqual(['sales_tax']);
    for (const p of ['/api/sales-tax/pay', '/api/sales-tax/payments', '/api/print-queue/refunds', '/api/vendor-credits/[id]/pdf']) {
      expect(apiRuleFor(p.replace('[id]', ID), 'GET')).toBeTruthy();
    }
  });
});

// =================================================================================================
// 2. Cash basis / due-through
// =================================================================================================
describe('sales tax cash basis — penny-exact and consistent', () => {
  let ctx: ServiceContext;
  let acct: Record<string, string>;
  let agency: string;
  let rate: string;
  let cust: string;
  let invId: string;
  let sepPaymentId: string;

  beforeAll(async () => {
    ({ ctx, acct } = await newCompany('Cash Pennies Co'));
    await updateCompany(ctx, { settings: { salesTaxBasis: 'cash', salesTaxFrequency: 'monthly' } as never });
    agency = (await createTaxAgency(ctx, { name: 'Penny State' })).id;
    rate = (await createTaxRate(ctx, { name: 'Penny 7%', rate: '0.07', agencyId: agency })).id;
    cust = (await createCustomer(ctx, { displayName: 'Installment Ivan' })).id;
    // 10.00 taxable + 0.70 tax = 10.70, paid 3.56 / 3.57 / 3.57.
    const inv = await createInvoice(ctx, { customerId: cust, date: d('2026-07-05'), taxRateId: rate, lines: [{ description: 'Gadget', quantity: 1, rate: '10.00' }] });
    invId = inv.id;
    expect(inv.total).toBe('10.70');
    await receivePayment(ctx, { customerId: cust, date: d('2026-07-10'), method: 'check', amount: '3.56', applications: [{ invoiceId: invId, amountApplied: '3.56' }] });
    await receivePayment(ctx, { customerId: cust, date: d('2026-08-10'), method: 'check', amount: '3.57', applications: [{ invoiceId: invId, amountApplied: '3.57' }] });
    const sep = await receivePayment(ctx, { customerId: cust, date: d('2026-09-10'), method: 'check', amount: '3.57', applications: [{ invoiceId: invId, amountApplied: '3.57' }] });
    sepPaymentId = sep.payment.id;
  });

  it('owed through each month-end is the cumulative pro-rata share, ending at exactly the invoice tax', async () => {
    const owed = async (day: string) =>
      (await salesTaxDueThrough(ctx, { dueThrough: day, basis: 'cash' })).rows.find((r) => r.agencyId === agency)?.owedThrough ?? '0.00';
    expect(await owed('2026-06-30')).toBe('0.00');
    expect(await owed('2026-07-31')).toBe('0.23'); // 0.70 x 3.56 / 10.70 = 0.2329
    expect(await owed('2026-08-31')).toBe('0.47'); // 0.70 x 7.13 / 10.70 = 0.4664
    expect(await owed('2026-09-30')).toBe('0.70');
    // Accrual: everything is owed from the invoice date.
    const acc = await salesTaxDueThrough(ctx, { dueThrough: '2026-07-31', basis: 'accrual' });
    expect(acc.rows.find((r) => r.agencyId === agency)?.owedThrough).toBe('0.70');
  });

  it('Revenue Summary (cash): the monthly figures add up to the quarter — no penny drift in sales or tax', async () => {
    const months = [
      ['2026-07-01', '2026-07-31'],
      ['2026-08-01', '2026-08-31'],
      ['2026-09-01', '2026-09-30'],
    ];
    let taxable = 0;
    let tax = 0;
    let total = 0;
    for (const [from, to] of months) {
      const r = await salesTaxRevenueSummary(ctx, { from: d(from), to: endOf(to), basis: 'cash' });
      taxable += Math.round(Number(r.totals.taxableSales) * 100);
      tax += Math.round(Number(r.totals.taxCollected) * 100);
      total += Math.round(Number(r.totals.totalSales) * 100);
    }
    const q = await salesTaxRevenueSummary(ctx, { from: d('2026-07-01'), to: endOf('2026-09-30'), basis: 'cash' });
    expect(q.totals.taxableSales).toBe('10.00');
    expect(q.totals.taxCollected).toBe('0.70');
    expect((tax / 100).toFixed(2)).toBe('0.70');
    // The tax column uses cumulative allocation; the sales columns must not drift either.
    expect((taxable / 100).toFixed(2)).toBe(q.totals.taxableSales);
    expect((total / 100).toFixed(2)).toBe(q.totals.totalSales);
  });

  it('voiding a customer payment takes its tax back out of what is owed (cash basis)', async () => {
    await voidPayment(ctx, sepPaymentId);
    const due = await salesTaxDueThrough(ctx, { dueThrough: '2026-09-30', basis: 'cash' });
    expect(due.rows.find((r) => r.agencyId === agency)?.owedThrough).toBe('0.47');
    const rev = await salesTaxRevenueSummary(ctx, { from: d('2026-09-01'), to: endOf('2026-09-30'), basis: 'cash' });
    expect(rev.totals.taxCollected).toBe('0.00');
    expect(rev.totals.taxableSales).toBe('0.00');
    await expectArTies(ctx, acct);
    await expectBooksSound(ctx);
  });

  it('a credit memo applied to an invoice: cash basis nets to zero until the rest is paid', async () => {
    const { ctx: c2, acct: a2 } = await newCompany('Cash Memo Co');
    const ag = (await createTaxAgency(c2, { name: 'Memo Agency' })).id;
    const rt = (await createTaxRate(c2, { name: 'Memo 10%', rate: '0.10', agencyId: ag })).id;
    const cu = (await createCustomer(c2, { displayName: 'Memo Mary' })).id;
    const inv = await createInvoice(c2, { customerId: cu, date: d('2026-07-01'), taxRateId: rt, lines: [{ description: 'Job', quantity: 1, rate: '100.00' }] });
    const memo = await createCreditMemo(c2, { customerId: cu, date: d('2026-07-02'), taxRateId: rt, lines: [{ description: 'Discount', quantity: 1, rate: '50.00' }] });
    expect(memo.total).toBe('55.00');
    await applyToInvoice(c2, { creditMemoId: memo.id, invoiceId: inv.id, amount: '55.00' });
    const owed = async (basis: 'cash' | 'accrual') =>
      (await salesTaxDueThrough(c2, { dueThrough: '2026-07-31', basis })).rows.find((r) => r.agencyId === ag)?.owedThrough ?? '0.00';
    expect(await owed('accrual')).toBe('5.00');
    expect(await owed('cash')).toBe('0.00');
    await receivePayment(c2, { customerId: cu, date: d('2026-07-20'), method: 'check', amount: '55.00', applications: [{ invoiceId: inv.id, amountApplied: '55.00' }] });
    expect(await owed('cash')).toBe('5.00');
    expect(await owed('accrual')).toBe('5.00');
    await expectArTies(c2, a2);
    await expectBooksSound(c2);
  });

  it('an impossible "due through" date (Feb 30) is a validation error or falls back — never a crash', async () => {
    let res: Awaited<ReturnType<typeof paySalesTaxScreen>> | null = null;
    try {
      res = await paySalesTaxScreen(ctx, { dueThrough: '2026-02-30' });
    } catch (err) {
      expect(err).toMatchObject({ code: 'VALIDATION' });
    }
    if (res) expect(res.dueThrough).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    if (res) expect(Number.isNaN(new Date(res.dueThrough).getTime())).toBe(false);
  });

  it('lastFilingPeriod handles month/quarter/year boundaries and leap years', () => {
    expect(lastFilingPeriod('monthly', '2028-03-15')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(lastFilingPeriod('monthly', '2026-03-01')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(lastFilingPeriod('quarterly', '2026-04-01')).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    expect(lastFilingPeriod('quarterly', '2026-12-31')).toEqual({ from: '2026-07-01', to: '2026-09-30' });
    expect(lastFilingPeriod('annually', '2026-01-01')).toEqual({ from: '2025-01-01', to: '2025-12-31' });
  });
});

// =================================================================================================
// 3. Sales tax payment checks
// =================================================================================================
describe('Sales Tax Payment checks — adversarial', () => {
  let ctx: ServiceContext;
  let acct: Record<string, string>;
  let agA: string;
  let agB: string;

  beforeAll(async () => {
    ({ ctx, acct } = await newCompany('ST Adversary Co'));
    agA = (await createTaxAgency(ctx, { name: 'Alpha Tax Board' })).id;
    agB = (await createTaxAgency(ctx, { name: 'Beta Revenue' })).id;
    const rA = (await createTaxRate(ctx, { name: 'A 5%', rate: '0.05', agencyId: agA })).id;
    const rB = (await createTaxRate(ctx, { name: 'B 3%', rate: '0.03', agencyId: agB })).id;
    const cu = (await createCustomer(ctx, { displayName: 'Taxed Tom' })).id;
    await createInvoice(ctx, { customerId: cu, date: d('2026-07-10'), taxRateId: rA, lines: [{ description: 'x', quantity: 1, rate: '1000.00' }] });
    await createInvoice(ctx, { customerId: cu, date: d('2026-07-11'), taxRateId: rB, lines: [{ description: 'y', quantity: 1, rate: '1000.00' }] });
    // Occupy check number 902 with a payroll liability check (no vendor created).
    await postJournalEntry(ctx, { date: d('2026-07-01'), description: 'Accrue', lines: [{ accountId: acct['6500'], debit: '50.00' }, { accountId: acct['2300'], credit: '50.00' }] });
    await payPayrollLiabilities(ctx, { date: d('2026-07-15'), paymentAccountId: acct['1000'], amount: '50.00', payeeName: 'IRS', checkNumber: '902' });
  });

  it('a multi-agency run that fails on the 2nd check posts nothing (no entries, no checks)', async () => {
    const entriesBefore = (await db.select().from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))).length;
    const checksBefore = (await db.select().from(paymentChecks).where(eq(paymentChecks.companyId, ctx.companyId))).length;
    await expect(
      paySalesTaxAgencies(ctx, {
        date: d('2026-08-05'),
        paymentAccountId: acct['1000'],
        payments: [
          { agencyId: agA, amount: '50.00' },
          { agencyId: agB, amount: '30.00' },
        ],
        checkNumber: '901', // 2nd check would be 902 — already used
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await db.select().from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))).length).toBe(entriesBefore);
    expect((await db.select().from(paymentChecks).where(eq(paymentChecks.companyId, ctx.companyId))).length).toBe(checksBefore);
    const rep = await salesTaxLiabilityReport(ctx);
    expect(rep.agencies.find((a) => a.agencyId === agA)?.balance).toBe('50.00');
    await expectBooksSound(ctx);
  });

  it('a failed payment run leaves no side effects: no agency vendors created or linked', async () => {
    // Same failing run as above already happened; nothing about it should persist.
    const ags = await db.select().from(taxAgencies).where(eq(taxAgencies.companyId, ctx.companyId));
    expect(ags.map((a) => a.vendorId)).toEqual([null, null]);
    const vs = await db.select().from(vendors).where(eq(vendors.companyId, ctx.companyId));
    expect(vs.map((v) => v.displayName)).not.toContain('Alpha Tax Board');
  });

  it('rounds sub-cent input once: the check amount equals the ledger amount', async () => {
    const res = await paySalesTaxAgencies(ctx, { date: d('2026-08-06'), paymentAccountId: acct['1000'], payments: [{ agencyId: agA, amount: '10.005' }] });
    const c = res.checks[0];
    const lines = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, c.entryId));
    const bank = lines.find((l) => l.accountId === acct['1000'])!;
    expect(Number(bank.credit).toFixed(2)).toBe(Number(c.amount).toFixed(2));
    expect(res.total).toBe(Number(c.amount).toFixed(2));
    await voidPaymentCheck(ctx, c.id);
  });

  it('an amount that rounds to 0.00 is refused as a validation error (no zero check)', async () => {
    const before = (await db.select().from(paymentChecks).where(eq(paymentChecks.companyId, ctx.companyId))).length;
    await expect(
      paySalesTaxAgencies(ctx, { date: d('2026-08-06'), paymentAccountId: acct['1000'], payments: [{ agencyId: agA, amount: '0.004' }] }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await db.select().from(paymentChecks).where(eq(paymentChecks.companyId, ctx.companyId))).length).toBe(before);
  });

  it('overpaying an agency leaves a credit with it; ledger still ties; void restores', async () => {
    const res = await paySalesTaxAgencies(ctx, { date: d('2026-08-07'), paymentAccountId: acct['1000'], payments: [{ agencyId: agB, amount: '45.00' }] });
    const rep = await salesTaxLiabilityReport(ctx);
    expect(rep.agencies.find((a) => a.agencyId === agB)?.balance).toBe('-15.00');
    expect(rep.tiesToGl).toBe(true);
    await voidPaymentCheck(ctx, res.checks[0].id);
    expect((await salesTaxLiabilityReport(ctx)).agencies.find((a) => a.agencyId === agB)?.balance).toBe('30.00');
    // Voiding twice is harmless.
    await voidPaymentCheck(ctx, res.checks[0].id);
    expect((await salesTaxLiabilityReport(ctx)).agencies.find((a) => a.agencyId === agB)?.balance).toBe('30.00');
    await expectBooksSound(ctx);
  });

  it('a check whose entry was voided outside the check (Batch Void) cannot be printed', async () => {
    const res = await paySalesTaxAgencies(ctx, { date: d('2026-08-08'), paymentAccountId: acct['1000'], payments: [{ agencyId: agA, amount: '5.00' }], toPrint: true });
    const c = res.checks[0];
    await voidJournalEntry(ctx, c.entryId);
    expect((await listPrintQueue(ctx)).some((q) => q.id === c.id)).toBe(false);
    expect((await listPaymentChecks(ctx, { kind: 'sales_tax' })).find((x) => x.id === c.id)?.isVoid).toBe(true);
    await expect(markPrinted(ctx, { source: 'payment_check', id: c.id, checkNumber: '950' })).rejects.toMatchObject({ code: 'CONFLICT' });
    // Voiding the check afterwards is fine and does not double-reverse.
    await voidPaymentCheck(ctx, c.id);
    expect((await salesTaxLiabilityReport(ctx)).agencies.find((a) => a.agencyId === agA)?.balance).toBe('50.00');
    await expectBooksSound(ctx);
  });

  it('respects the closing date for both paying and voiding', async () => {
    const { ctx: c2, acct: a2 } = await newCompany('ST Closed Co');
    const ag = (await createTaxAgency(c2, { name: 'Closed Agency' })).id;
    await setClosingDate(c2, { closingDate: '2026-06-30' });
    const before = (await db.select().from(paymentChecks).where(eq(paymentChecks.companyId, c2.companyId))).length;
    await expect(
      paySalesTaxAgencies(c2, { date: d('2026-06-15'), paymentAccountId: a2['1000'], payments: [{ agencyId: ag, amount: '10.00' }] }),
    ).rejects.toBeTruthy();
    expect((await db.select().from(paymentChecks).where(eq(paymentChecks.companyId, c2.companyId))).length).toBe(before);

    const res = await paySalesTaxAgencies(c2, { date: d('2026-07-05'), paymentAccountId: a2['1000'], payments: [{ agencyId: ag, amount: '10.00' }] });
    await setClosingDate(c2, { closingDate: '2026-07-31' });
    await expect(voidPaymentCheck(c2, res.checks[0].id)).rejects.toBeTruthy();
    const [row] = await db.select().from(paymentChecks).where(eq(paymentChecks.id, res.checks[0].id));
    expect(row.voidedAt).toBeNull();
    const [je] = await db.select().from(journalEntries).where(eq(journalEntries.id, res.checks[0].entryId));
    expect(je.status).toBe('posted');
    await expectBooksSound(c2);
  });

  it('multi-company isolation: another company\'s agency, bank, or check is invisible', async () => {
    const { ctx: other, acct: oAcct } = await newCompany('ST Other Co');
    const oAg = (await createTaxAgency(other, { name: 'Other Agency' })).id;
    const oRes = await paySalesTaxAgencies(other, { date: d('2026-08-01'), paymentAccountId: oAcct['1000'], payments: [{ agencyId: oAg, amount: '3.00' }], toPrint: true });
    const oCheck = oRes.checks[0];

    await expect(paySalesTaxAgencies(ctx, { date: d('2026-08-09'), paymentAccountId: acct['1000'], payments: [{ agencyId: oAg, amount: '1.00' }] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(paySalesTaxAgencies(ctx, { date: d('2026-08-09'), paymentAccountId: oAcct['1000'], payments: [{ agencyId: agA, amount: '1.00' }] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(voidPaymentCheck(ctx, oCheck.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(markPrinted(ctx, { source: 'payment_check', id: oCheck.id, checkNumber: '1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(checkPrintData(ctx, 'payment_check', oCheck.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await listPaymentChecks(ctx)).some((c) => c.id === oCheck.id)).toBe(false);
    expect((await listPrintQueue(ctx)).some((q) => q.id === oCheck.id)).toBe(false);
    const [still] = await db.select().from(paymentChecks).where(eq(paymentChecks.id, oCheck.id));
    expect(still).toMatchObject({ toPrint: true, voidedAt: null });
  });

  it('a payroll liability check with a used number rolls back the whole payment', async () => {
    const before = await balanceOf(ctx, acct['2300']);
    const entries = (await db.select().from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))).length;
    await expect(
      payPayrollLiabilities(ctx, { date: d('2026-08-10'), paymentAccountId: acct['1000'], items: [{ name: 'Federal', amount: '1.00' }], checkNumber: '902' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await balanceOf(ctx, acct['2300'])).toBe(before);
    expect((await db.select().from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))).length).toBe(entries);
  });
});

// =================================================================================================
// 3b. Customer refund checks (D3)
// =================================================================================================
describe('customer refund checks — void gives the credit back; A/R ties', () => {
  it('voiding a queued refund check restores the credit memo and keeps A/R == aging', async () => {
    const { ctx, acct } = await newCompany('Refund Void Co');
    const cu = (await createCustomer(ctx, { displayName: 'Refund Ruth' })).id;
    const memo = await createCreditMemo(ctx, { customerId: cu, date: d('2026-09-01'), lines: [{ description: 'Return', quantity: 1, rate: '40.00' }] });
    await refundCreditMemo(ctx, { creditMemoId: memo.id, bankAccountId: acct['1000'], amount: '25.00', date: d('2026-09-02') });
    const [r] = await unprintedRefunds(ctx);
    expect(r.amount).toBe('25.00');
    const check = await queueCustomerRefundCheck(ctx, { entryId: r.entryId });
    await voidPaymentCheck(ctx, check.id);
    const after = await getCreditMemo(ctx, memo.id);
    expect(after.unapplied).toBe('40.00');
    expect(after.refundedAmount).toBe('0.00');
    expect((await listPrintQueue(ctx)).some((q) => q.id === check.id)).toBe(false);
    // A voided refund cannot be queued again.
    await expect(queueCustomerRefundCheck(ctx, { entryId: r.entryId })).rejects.toBeTruthy();
    await expectArTies(ctx, acct);
    await expectBooksSound(ctx);
  });

  it('vendor-credit refunds (money in) are never offered as refund checks; cross-company entry refused', async () => {
    const { ctx, acct } = await newCompany('Refund VC Co');
    const v = (await createVendor(ctx, { displayName: 'Refunding Vendor' })).id;
    const vc = await createVendorCredit(ctx, { vendorId: v, date: d('2026-09-01'), lines: [{ accountId: acct['6300'], amount: '20.00' }] });
    const { entry } = await refundVendorCredit(ctx, { vendorCreditId: vc.id, bankAccountId: acct['1000'], amount: '20.00', date: d('2026-09-02') });
    expect(await unprintedRefunds(ctx)).toEqual([]);
    await expect(queueCustomerRefundCheck(ctx, { entryId: entry.id })).rejects.toMatchObject({ code: 'VALIDATION' });
    const { ctx: other } = await newCompany('Refund VC Other');
    await expect(queueCustomerRefundCheck(other, { entryId: entry.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// =================================================================================================
// 4. Check paper settings
// =================================================================================================
describe('check paper (stock) settings', () => {
  it('defaults to pre-printed; saving without stock keeps the saved stock; junk is refused', async () => {
    const { ctx } = await newCompany('Check Stock Co');
    expect((await getCheckPrintSettings(ctx)).stock).toBe('preprinted');
    await saveCheckPrintSettings(ctx, { style: 'voucher', stock: 'blank', offsetX: '0.1', offsetY: '-0.05' });
    expect(await getCheckPrintSettings(ctx)).toMatchObject({ stock: 'blank', offsetX: '0.10', offsetY: '-0.05' });
    await saveCheckPrintSettings(ctx, { style: 'wallet', offsetX: '0', offsetY: '0' });
    expect(await getCheckPrintSettings(ctx)).toMatchObject({ style: 'wallet', stock: 'blank' });
    await expect(saveCheckPrintSettings(ctx, { style: 'voucher', stock: 'glossy', offsetX: '0', offsetY: '0' })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await getCheckPrintSettings(ctx)).stock).toBe('blank');
  });
});

// =================================================================================================
// 5. Vendor credits
// =================================================================================================
describe('vendor credits — A/P invariants, inventory, rollback, isolation', () => {
  let ctx: ServiceContext;
  let acct: Record<string, string>;
  let vendorId: string;
  let widget: string;

  beforeAll(async () => {
    ({ ctx, acct } = await newCompany('VC Adversary Co'));
    vendorId = (await createVendor(ctx, { displayName: 'Adversary Supply' })).id;
    widget = (await createItem(ctx, { name: 'Sprocket', type: 'inventory', assetAccountId: acct['1300'], incomeAccountId: acct['4000'], purchaseCost: '10' })).id;
    await adjustInventory(ctx, { itemId: widget, quantityChange: '10', unitCost: '10', date: d('2026-02-01') });
  });

  it('bill + credit + partial apply + partial refund + refund void: A/P control == aging == vendor balance at every step', async () => {
    const bill = await createBill(ctx, { vendorId, date: d('2026-03-01'), lines: [{ accountId: acct['6300'], amount: '500.00' }] });
    const vc = await createVendorCredit(ctx, { vendorId, date: d('2026-03-02'), refNumber: 'CM-77', lines: [{ accountId: acct['6300'], amount: '200.00' }] });
    await expectApTies(ctx, acct, vendorId, '300.00');
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '150.00' });
    await expectApTies(ctx, acct, vendorId, '300.00');
    const { entry } = await refundVendorCredit(ctx, { vendorCreditId: vc.id, bankAccountId: acct['1000'], amount: '50.00', date: d('2026-03-05') });
    await expectApTies(ctx, acct, vendorId, '350.00');
    await voidJournalEntry(ctx, entry.id);
    const restored = await getVendorCredit(ctx, vc.id);
    expect(restored).toMatchObject({ unapplied: '50.00', refundedAmount: '0.00', status: 'partial' });
    await expectApTies(ctx, acct, vendorId, '300.00');
    // Voiding the refund entry again must not restore the credit twice.
    await voidJournalEntry(ctx, entry.id).catch(() => undefined);
    const again = await getVendorCredit(ctx, vc.id);
    expect(again.unapplied).toBe('50.00');
    // Still applied → cannot void; unapply then void.
    await expect(voidVendorCredit(ctx, vc.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await unapplyFromBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '150.00' });
    expect((await getVendorCredit(ctx, vc.id)).status).toBe('open');
    await voidVendorCredit(ctx, vc.id);
    await expectApTies(ctx, acct, vendorId, '500.00');
    await expectBooksSound(ctx);
  });

  it('Ref. No. is the journal reference; a ledger-neutral edit keeps the entry and retitles it', async () => {
    const vc = await createVendorCredit(ctx, { vendorId, date: d('2026-03-10'), refNumber: ' RA-1 ', lines: [{ accountId: acct['6300'], amount: '12.00', description: 'a' }] });
    expect(vc.refNumber).toBe('RA-1');
    const [je] = await db.select().from(journalEntries).where(eq(journalEntries.id, vc.postedEntryId!));
    expect(je.reference).toBe('RA-1');
    const upd = await updateVendorCredit(ctx, vc.id, { vendorId, date: d('2026-03-10'), refNumber: 'RA-2', memo: 'changed', lines: [{ accountId: acct['6300'], amount: '12.00', description: 'b' }] });
    expect(upd.postedEntryId).toBe(vc.postedEntryId);
    const [je2] = await db.select().from(journalEntries).where(eq(journalEntries.id, vc.postedEntryId!));
    expect(je2.reference).toBe('RA-2');
    expect(je2.status).toBe('posted');
  });

  it('inventory return, later purchase at a new cost, then void: inventory GL == qty x average cost', async () => {
    const vc = await createVendorCredit(ctx, { vendorId, date: d('2026-04-01'), lines: [{ itemId: widget, quantity: '4', amount: '44.00' }] });
    expect(await balanceOf(ctx, acct['1300'])).toBe('60.00');
    // Return price difference (44 credited vs 40 cost) went to COGS.
    expect(await balanceOf(ctx, acct['5000'])).toBe('-4.00');
    await adjustInventory(ctx, { itemId: widget, quantityChange: '6', unitCost: '20', date: d('2026-04-02') });
    expect(await balanceOf(ctx, acct['1300'])).toBe('180.00');
    await voidVendorCredit(ctx, vc.id);
    const it = await itemRow(widget);
    expect(Number(it.quantityOnHand)).toBe(16);
    expect(await balanceOf(ctx, acct['1300'])).toBe('220.00');
    expect((Number(it.quantityOnHand) * Number(it.averageCost)).toFixed(2)).toBe('220.00');
    expect(await balanceOf(ctx, acct['5000'])).toBe('0.00');
    await expectApTies(ctx, acct);
    await expectBooksSound(ctx);
  });

  it('an edit that would return more than on hand fails and changes nothing (stock, entry, lines)', async () => {
    const vc = await createVendorCredit(ctx, { vendorId, date: d('2026-04-05'), lines: [{ itemId: widget, quantity: '2', amount: '27.50' }] });
    const before = await itemRow(widget);
    const glBefore = await balanceOf(ctx, acct['1300']);
    const onHandAfterRestore = Number(before.quantityOnHand) + 2;
    await expect(
      updateVendorCredit(ctx, vc.id, { vendorId, date: d('2026-04-05'), lines: [{ itemId: widget, quantity: String(onHandAfterRestore + 1), amount: '999.00' }] }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const after = await itemRow(widget);
    expect(after.quantityOnHand).toBe(before.quantityOnHand);
    expect(after.averageCost).toBe(before.averageCost);
    expect(await balanceOf(ctx, acct['1300'])).toBe(glBefore);
    const full = await getVendorCredit(ctx, vc.id);
    expect(full.postedEntryId).toBe(vc.postedEntryId);
    expect(full.lines).toHaveLength(1);
    expect(full.lines[0].quantity).toBe('2.0000');
    await voidVendorCredit(ctx, vc.id);
    await expectBooksSound(ctx);
  });

  it('class flows to every journal line of an item return (inventory + COGS difference); job fills the customer', async () => {
    const cls = (await createClass(ctx, { name: 'Returns Dept' })).id;
    const cu = (await createCustomer(ctx, { displayName: 'Job Jill' })).id;
    const job = (await createJob(ctx, { customerId: cu, name: 'Deck' })).id;
    const vc = await createVendorCredit(ctx, { vendorId, date: d('2026-04-06'), lines: [{ itemId: widget, quantity: '1', amount: '30.00', classId: cls, jobId: job }] });
    const lines = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, vc.postedEntryId!));
    const nonAp = lines.filter((l) => l.accountId !== acct['2000']);
    expect(nonAp.length).toBeGreaterThanOrEqual(2);
    for (const l of nonAp) expect(l.classId).toBe(cls);
    const [vcl] = await db.select().from(vendorCreditLines).where(eq(vendorCreditLines.vendorCreditId, vc.id));
    expect(vcl).toMatchObject({ classId: cls, jobId: job, customerId: cu });
    // A job of another customer is refused.
    const cu2 = (await createCustomer(ctx, { displayName: 'Other Owen' })).id;
    await expect(
      createVendorCredit(ctx, { vendorId, date: d('2026-04-06'), lines: [{ accountId: acct['6300'], amount: '1.00', customerId: cu2, jobId: job }] }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await voidVendorCredit(ctx, vc.id);
  });

  it('closing date: a credit dated in a closed period is refused and relieves no stock', async () => {
    const { ctx: c2, acct: a2 } = await newCompany('VC Closed Co');
    const v = (await createVendor(c2, { displayName: 'Closed Vendor' })).id;
    const itm = (await createItem(c2, { name: 'Closed Gear', type: 'inventory', assetAccountId: a2['1300'], incomeAccountId: a2['4000'] })).id;
    await adjustInventory(c2, { itemId: itm, quantityChange: '5', unitCost: '4', date: d('2026-01-02') });
    await setClosingDate(c2, { closingDate: '2026-01-31' });
    await expect(createVendorCredit(c2, { vendorId: v, date: d('2026-01-20'), lines: [{ itemId: itm, quantity: '2', amount: '8.00' }] })).rejects.toBeTruthy();
    expect((await itemRow(itm)).quantityOnHand).toBe('5.0000');
    expect((await db.select().from(vendorCredits).where(eq(vendorCredits.companyId, c2.companyId))).length).toBe(0);
    // A credit created in an open period cannot be voided once the period closes.
    const vc = await createVendorCredit(c2, { vendorId: v, date: d('2026-02-10'), lines: [{ itemId: itm, quantity: '1', amount: '4.00' }] });
    await setClosingDate(c2, { closingDate: '2026-02-28' });
    await expect(voidVendorCredit(c2, vc.id)).rejects.toBeTruthy();
    expect((await itemRow(itm)).quantityOnHand).toBe('4.0000');
    expect((await getVendorCredit(c2, vc.id)).status).toBe('open');
    await expectBooksSound(c2);
  });

  it('multi-company: another company\'s vendor, item, account, class, customer or job is refused', async () => {
    const { ctx: o, acct: oa } = await newCompany('VC Other Co');
    const oVendor = (await createVendor(o, { displayName: 'Other Vendor' })).id;
    const oItem = (await createItem(o, { name: 'Other Item', type: 'inventory', assetAccountId: oa['1300'], incomeAccountId: oa['4000'] })).id;
    const oClass = (await createClass(o, { name: 'Other Class' })).id;
    const oCust = (await createCustomer(o, { displayName: 'Other Cust' })).id;
    const oJob = (await createJob(o, { customerId: oCust, name: 'Other Job' })).id;
    const base = { vendorId, date: d('2026-04-10') };
    const ok = { accountId: acct['6300'], amount: '1.00' };
    await expect(createVendorCredit(ctx, { ...base, vendorId: oVendor, lines: [ok] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(createVendorCredit(ctx, { ...base, lines: [{ itemId: oItem, quantity: '1', amount: '1.00' }] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(createVendorCredit(ctx, { ...base, lines: [{ accountId: oa['6300'], amount: '1.00' }] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(createVendorCredit(ctx, { ...base, lines: [{ ...ok, classId: oClass }] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(createVendorCredit(ctx, { ...base, lines: [{ ...ok, customerId: oCust }] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(createVendorCredit(ctx, { ...base, lines: [{ ...ok, jobId: oJob }] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // A/P itself can never be a line account.
    await expect(createVendorCredit(ctx, { ...base, lines: [{ accountId: acct['2000'], amount: '1.00' }] })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('API schema: Items-tab and Expenses-tab lines, Ref. No. length', () => {
    const ok = createVendorCreditSchema.safeParse({
      vendorId: '00000000-0000-4000-8000-000000000001',
      date: '2026-04-01',
      refNumber: 'CM-1',
      lines: [
        { itemId: '00000000-0000-4000-8000-000000000002', quantity: '2', unitCost: '3.50' },
        { accountId: '00000000-0000-4000-8000-000000000003', amount: '4.00' },
      ],
    });
    expect(ok.success).toBe(true);
    const bad = (line: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      createVendorCreditSchema.safeParse({ vendorId: '00000000-0000-4000-8000-000000000001', date: '2026-04-01', lines: [line], ...extra }).success;
    expect(bad({ accountId: '00000000-0000-4000-8000-000000000003' })).toBe(false); // no amount
    expect(bad({ itemId: '00000000-0000-4000-8000-000000000002', amount: '4.00' })).toBe(false); // no quantity
    expect(bad({ itemId: '00000000-0000-4000-8000-000000000002', quantity: '1' })).toBe(false); // no cost/amount
    expect(bad({ amount: '4.00' })).toBe(false); // neither account nor item
    expect(bad({ accountId: '00000000-0000-4000-8000-000000000003', amount: '4.00' }, { refNumber: 'x'.repeat(51) })).toBe(false);
  });
});

// =================================================================================================
// 6. Inventory adjustments
// =================================================================================================
describe('inventory adjustment account — adversarial', () => {
  const adjAccounts = async (ctx: ServiceContext) =>
    (await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId))).filter((a) => a.name === 'Inventory Adjustments');

  it('an adjustment refused by the closing date creates nothing (no default account, no stock)', async () => {
    const { ctx, acct } = await newCompany('Adj Closed Co');
    const itm = (await createItem(ctx, { name: 'Locked Nut', type: 'inventory', assetAccountId: acct['1300'], incomeAccountId: acct['4000'] })).id;
    await setClosingDate(ctx, { closingDate: '2026-03-31' });
    await expect(adjustInventory(ctx, { itemId: itm, quantityChange: '3', unitCost: '2', date: d('2026-03-15') })).rejects.toBeTruthy();
    expect(await adjAccounts(ctx)).toHaveLength(0);
    expect(Number((await itemRow(itm)).quantityOnHand ?? 0)).toBe(0);
    await expect(receiveStock(ctx, { itemId: itm, quantity: '3', unitCost: '2', date: d('2026-03-15') })).rejects.toBeTruthy();
    expect(await adjAccounts(ctx)).toHaveLength(0);
    await expectBooksSound(ctx);
  });

  it('the default account is created once (next free code after 5950) and reused by both costing paths', async () => {
    const { ctx, acct } = await newCompany('Adj Once Co');
    await createAccount(ctx, { code: '5950', name: 'Freight Absorbed', type: 'expense' });
    const avg = (await createItem(ctx, { name: 'Avg Part', type: 'inventory', assetAccountId: acct['1300'], incomeAccountId: acct['4000'] })).id;
    const fifo = (await createItem(ctx, { name: 'Fifo Part', type: 'inventory', assetAccountId: acct['1300'], incomeAccountId: acct['4000'] })).id;
    await adjustInventory(ctx, { itemId: avg, quantityChange: '2', unitCost: '5', date: d('2026-05-01') });
    await receiveStock(ctx, { itemId: fifo, quantity: '3', unitCost: '4', date: d('2026-05-01') });
    await adjustQuantityAtSite(ctx, { itemId: avg, quantityChange: '-1', date: d('2026-05-02') });
    await adjustQuantityAtSite(ctx, { itemId: fifo, quantityChange: '-1', date: d('2026-05-02') });
    const adj = await adjAccounts(ctx);
    expect(adj).toHaveLength(1);
    expect(adj[0].code).toBe('5951');
    // Offsets: -10 -12 (adds) +5 +4 (removals)
    expect(await balanceOf(ctx, adj[0].id)).toBe('-13.00');
    expect(await balanceOf(ctx, acct['1300'])).toBe('13.00');
    expect(await balanceOf(ctx, acct['3000'])).toBe('0.00');
    expect(await balanceOf(ctx, acct['5000'])).toBe('0.00');
    await expectBooksSound(ctx);
  });

  it('a user\'s own "Inventory Adjustments" expense account is reused, not duplicated', async () => {
    const { ctx, acct } = await newCompany('Adj Existing Co');
    const mine = await createAccount(ctx, { code: '6999', name: 'Inventory Adjustments', type: 'expense' });
    const itm = (await createItem(ctx, { name: 'Reuse Part', type: 'inventory', assetAccountId: acct['1300'], incomeAccountId: acct['4000'] })).id;
    await adjustInventory(ctx, { itemId: itm, quantityChange: '1', unitCost: '7', date: d('2026-05-03') });
    expect((await adjAccounts(ctx)).map((a) => a.id)).toEqual([mine.id]);
    expect(await balanceOf(ctx, mine.id)).toBe('-7.00');
  });

  it('cross-company adjustment account / class / customer / job are refused and post nothing', async () => {
    const { ctx, acct } = await newCompany('Adj Iso Co');
    const { ctx: o, acct: oa } = await newCompany('Adj Iso Other');
    const oClass = (await createClass(o, { name: 'Iso Class' })).id;
    const oCust = (await createCustomer(o, { displayName: 'Iso Cust' })).id;
    const oJob = (await createJob(o, { customerId: oCust, name: 'Iso Job' })).id;
    const itm = (await createItem(ctx, { name: 'Iso Part', type: 'inventory', assetAccountId: acct['1300'], incomeAccountId: acct['4000'] })).id;
    const base = { itemId: itm, quantityChange: '1', unitCost: '1', date: d('2026-05-04') };
    for (const extra of [{ adjustmentAccountId: oa['6300'] }, { classId: oClass }, { customerId: oCust }, { jobId: oJob }]) {
      await expect(adjustInventory(ctx, { ...base, ...extra })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(receiveStock(ctx, { itemId: itm, quantity: '1', unitCost: '1', date: d('2026-05-04'), ...extra })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    expect(Number((await itemRow(itm)).quantityOnHand ?? 0)).toBe(0);
    expect(await balanceOf(ctx, acct['1300'])).toBe('0.00');
    // Job of another customer (same company).
    const c1 = (await createCustomer(ctx, { displayName: 'C1' })).id;
    const c2 = (await createCustomer(ctx, { displayName: 'C2' })).id;
    const j2 = (await createJob(ctx, { customerId: c2, name: 'J2' })).id;
    await expect(adjustInventory(ctx, { ...base, customerId: c1, jobId: j2 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expectBooksSound(ctx);
  });

  it('UI / API wiring: blank fields fall back to the server default; forms send the fields', () => {
    // (TSX cannot be imported in this vitest setup — check the payload helper's source.)
    const comp = fs.readFileSync(path.join(ROOT, 'components/InventoryAdjustmentFields.tsx'), 'utf8');
    for (const k of ['adjustmentAccountId', 'classId', 'customerId', 'jobId']) {
      expect(comp).toContain(`${k}: v.${k} || null`);
    }
    for (const f of ['app/api/inventory/route.ts', 'app/api/fifo/route.ts']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      for (const k of ['adjustmentAccountId', 'classId', 'customerId', 'jobId']) expect(src).toContain(k);
    }
    const fifoPage = fs.readFileSync(path.join(ROOT, 'app/fifo/page.tsx'), 'utf8');
    expect(fifoPage).toMatch(/adjustmentPayload\(receiveAdj\)/);
    expect(fifoPage).not.toMatch(/Owner's Equity/);
    const sites = fs.readFileSync(path.join(ROOT, 'app/inventory-sites/page.tsx'), 'utf8');
    expect(sites).toMatch(/InventoryAdjustmentFields/);
  });
});

// =================================================================================================
// 7. Migration 0042 on an upgraded database
// =================================================================================================
describe('migration 0042_p1_purchases', () => {
  const file = () => fs.readFileSync(path.join(ROOT, 'drizzle', '0042_p1_purchases.sql'), 'utf8');
  const replay = async () => {
    for (const stmt of file().split('--> statement-breakpoint')) {
      if (stmt.trim()) await db.execute(sql.raw(stmt));
    }
  };

  it('is registered once in the journal with idx 42', () => {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'drizzle', 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string }> };
    const mine = j.entries.filter((e) => e.tag === '0042_p1_purchases');
    expect(mine).toEqual([expect.objectContaining({ idx: 42 })]);
  });

  it('replays cleanly over existing data and back-fills pre-printed stock on old settings rows', async () => {
    const { ctx, acct } = await newCompany('Migration Co');
    const ag = (await createTaxAgency(ctx, { name: 'Mig Agency' })).id;
    await saveCheckPrintSettings(ctx, { style: 'standard', stock: 'blank', offsetX: '0', offsetY: '0' });
    await paySalesTaxAgencies(ctx, { date: d('2026-08-01'), paymentAccountId: acct['1000'], payments: [{ agencyId: ag, amount: '1.00' }] });
    const count = async () => (await db.select().from(paymentChecks)).length;
    const n = await count();
    await replay();
    await replay();
    expect(await count()).toBe(n);
    expect((await getCheckPrintSettings(ctx)).stock).toBe('blank');

    // Simulate a database from before 0042 for the column-only parts: an old settings row and
    // an old vendor credit without the new columns.
    await db.execute(sql.raw('ALTER TABLE "check_print_settings" DROP COLUMN "stock"'));
    await db.execute(sql.raw('ALTER TABLE "vendor_credits" DROP COLUMN "ref_number"'));
    await replay();
    const [row] = await db.select().from(checkPrintSettings).where(eq(checkPrintSettings.companyId, ctx.companyId));
    expect(row.stock).toBe('preprinted');
    const v = (await createVendor(ctx, { displayName: 'Mig Vendor' })).id;
    const vc = await createVendorCredit(ctx, { vendorId: v, date: d('2026-08-02'), refNumber: 'M-1', lines: [{ accountId: acct['6300'], amount: '1.00' }] });
    expect(vc.refNumber).toBe('M-1');
    await expectBooksSound(ctx);
  });
});
