/**
 * Sales-tax liability engine (D7/D8/I2/H12) — the liability report must tie EXACTLY to the
 * sales-tax GL after a long mix of documents: invoices (header rate, per-line rate, combined
 * rates, non-taxable lines, foreign currency, edits, voids), sales receipts (incl. a void),
 * credit memos, Pay Sales Tax payments, sales tax adjustments and a payment recorded by journal
 * entry that is then fixed with "Fix Incorrectly Recorded Sales Tax".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import type { ServiceContext } from '../_base';
import { createCompany } from '../company';
import { createAccount } from '../accounts';
import { createCustomer } from '../customers';
import { createTaxAgency, createTaxRate } from '../salesTax';
import { setComponents } from '../combinedTax';
import { createInvoice, updateInvoice, voidInvoice } from '../invoices';
import { createSalesReceipt, voidSalesReceipt } from '../salesReceipts';
import { createCreditMemo } from '../creditMemos';
import { receivePayment } from '../payments';
import { paySalesTax, salesTaxLiabilityByAgency } from '../liabilityPayments';
import { createManualEntry } from '../journal';
import { trialBalance } from '../reports';
import {
  salesTaxActivity,
  salesTaxGlBalance,
  salesTaxLiabilityReport,
  salesTaxRevenueSummary,
} from './salesTaxLedger';
import {
  createSalesTaxAdjustment,
  findMisrecordedSalesTax,
  linkSalesTaxLine,
  reclassifySalesTaxPayment,
  unlinkSalesTaxLine,
} from './salesTaxTools';
import { createExpense } from '../expenses';
import { createVendor } from '../vendors';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-accountant-salestax');
let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
let state: string, county: string, city: string;
let combined: string, county5: string, cityOnly: string;
let customerId: string;

const d = (s: string) => new Date(`${s}T12:00:00.000Z`);

async function glOfTaxAccounts(): Promise<string> {
  // Σ cached balances of 2200 + 2210 (trigger-maintained) — independent of the engine's query.
  const rows = await db
    .select({ code: accounts.code, balance: accounts.balance })
    .from(accounts)
    .where(eq(accounts.companyId, ctx.companyId));
  const v = rows
    .filter((r) => r.code === '2200' || r.code === '2210')
    .reduce((s, r) => s + Math.round(Number(r.balance) * 100), 0);
  return (v / 100).toFixed(2);
}

async function expectTies(to?: Date) {
  const report = await salesTaxLiabilityReport(ctx, { to });
  const gl = await salesTaxGlBalance(ctx, to);
  expect(report.totals.balance).toBe(gl);
  expect(report.tiesToGl).toBe(true);
  // Per-agency balances add up to the total.
  const sum = report.agencies.reduce((s, a) => s + Math.round(Number(a.balance) * 100), 0);
  expect((sum / 100).toFixed(2)).toBe(report.totals.balance);
  return report;
}

describe('sales tax liability engine ties to the GL', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'acct-stax@test.local', name: 'Tax Tester', passwordHash: 'x' })
      .returning();
    const company = await createCompany(db, { name: 'Sales Tax Engine Co', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    const all = await db.select().from(accounts).where(eq(accounts.companyId, company.id));
    for (const a of all) acct[a.code] = a.id;
    acct['2210'] = (
      await createAccount(ctx, { code: '2210', name: 'State Sales Tax Payable', type: 'liability' as never, subtype: 'long_term_liability' })
    ).id;
    acct['4950'] = (
      await createAccount(ctx, { code: '4950', name: 'Sales Tax Discounts', type: 'revenue' as never, subtype: 'other_income' })
    ).id;
    acct['6750'] = (
      await createAccount(ctx, { code: '6750', name: 'Sales Tax Penalties', type: 'expense' as never, subtype: 'taxes' })
    ).id;

    state = (await createTaxAgency(ctx, { name: 'State Dept of Revenue', liabilityAccountId: acct['2210'] })).id;
    county = (await createTaxAgency(ctx, { name: 'County Tax Office' })).id;
    city = (await createTaxAgency(ctx, { name: 'City Treasurer' })).id;

    combined = (await createTaxRate(ctx, { name: 'Combined 8%', rate: '0.08' })).id;
    await setComponents(ctx, combined, [
      { name: 'State 6%', agencyId: state, rate: '0.06' },
      { name: 'County 1.5%', agencyId: county, rate: '0.015' },
      { name: 'City 0.5%', agencyId: city, rate: '0.005' },
    ]);
    county5 = (await createTaxRate(ctx, { name: 'County special 5%', rate: '0.05', agencyId: county })).id;
    cityOnly = (await createTaxRate(ctx, { name: 'City 2.25%', rate: '0.0225', agencyId: city })).id;
    customerId = (await createCustomer(ctx, { displayName: 'Taxable Customer' })).id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('starts empty and tied', async () => {
    const r = await expectTies();
    expect(r.totals.balance).toBe('0.00');
  });

  it('a mixed history of documents ties to the GL at every step', async () => {
    // 1. Header combined rate with a non-taxable line.
    const inv1 = await createInvoice(ctx, {
      customerId,
      date: d('2026-01-05'),
      taxRateId: combined,
      lines: [
        { description: 'Widgets', quantity: 3, rate: '33.33' },
        { description: 'Labor (exempt)', quantity: 1, rate: '50', taxable: false },
      ],
    });
    await expectTies();
    // 2. Per-line rates (county special + city only) on one invoice, plus a header-rate line.
    await createInvoice(ctx, {
      customerId,
      date: d('2026-01-10'),
      taxRateId: combined,
      lines: [
        { description: 'Special', quantity: 1, rate: '199.99', taxRateId: county5 },
        { description: 'City item', quantity: 2, rate: '10.05', taxRateId: cityOnly },
        { description: 'Normal', quantity: 1, rate: '10.01' },
      ],
    });
    await expectTies();
    // 3. Foreign-currency invoice (penny allocation in base currency).
    await createInvoice(ctx, {
      customerId,
      date: d('2026-01-12'),
      taxRateId: combined,
      currency: 'EUR',
      exchangeRate: '1.13',
      lines: [{ description: 'Export', quantity: 7, rate: '13.37' }],
    });
    await expectTies();
    // 4. Sales receipt with a header rate and a per-line rate.
    await createSalesReceipt(ctx, {
      customerId,
      date: d('2026-01-15'),
      taxRateId: combined,
      lines: [
        { description: 'Counter sale', quantity: 1, rate: '45.45' },
        { description: 'County item', quantity: 1, rate: '20', taxRateId: county5 },
      ],
    });
    // 5. A receipt that gets voided — must drop out entirely.
    const sr2 = await createSalesReceipt(ctx, {
      customerId,
      date: d('2026-01-16'),
      taxRateId: combined,
      lines: [{ description: 'Oops', quantity: 1, rate: '99.99' }],
    });
    await voidSalesReceipt(ctx, sr2.id);
    // 6. Credit memo returning tax.
    await createCreditMemo(ctx, {
      customerId,
      date: d('2026-01-20'),
      taxRateId: combined,
      lines: [{ description: 'Return', quantity: 1, rate: '33.33' }],
    });
    await expectTies();
    // 7. Edit invoice 1 (void + repost) and void another invoice.
    await updateInvoice(ctx, inv1.id, {
      customerId,
      date: d('2026-01-05'),
      taxRateId: combined,
      lines: [{ description: 'Widgets (corrected)', quantity: 4, rate: '33.33' }],
    });
    const inv5 = await createInvoice(ctx, {
      customerId,
      date: d('2026-01-25'),
      taxRateId: county5,
      lines: [{ description: 'Will be voided', quantity: 1, rate: '500' }],
    });
    await voidInvoice(ctx, inv5.id);
    await expectTies();

    // 8. Pay the state part of January, adjust county (early-payment discount), city penalty.
    const before = await salesTaxLiabilityReport(ctx, { to: d('2026-01-31') });
    const stateRow = before.agencies.find((a) => a.agencyId === state)!;
    expect(Number(stateRow.balance)).toBeGreaterThan(0);
    await paySalesTax(ctx, {
      amount: stateRow.balance,
      date: d('2026-02-10'),
      paymentAccountId: acct['1000'],
      agencyId: state,
    });
    await createSalesTaxAdjustment(ctx, {
      date: d('2026-02-10'),
      agencyId: county,
      amount: '0.37',
      direction: 'reduce',
      adjustmentAccountId: acct['4950'],
      reason: 'discount',
    });
    await createSalesTaxAdjustment(ctx, {
      date: d('2026-02-11'),
      agencyId: city,
      amount: '5.00',
      direction: 'increase',
      adjustmentAccountId: acct['6750'],
      reason: 'penalty',
    });
    const after = await expectTies();
    expect(after.agencies.find((a) => a.agencyId === state)!.balance).toBe('0.00');

    // The engine total equals the trigger-maintained account balances too.
    expect(after.totals.balance).toBe(await glOfTaxAccounts());
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);

    // Every attributed row belongs to a real agency (nothing unassigned).
    const activity = await salesTaxActivity(ctx);
    expect(activity.filter((a) => a.agencyId === null)).toHaveLength(0);
  });

  it('as-of dates tie to the GL as of that date, and ranges roll forward', async () => {
    await expectTies(new Date('2026-01-12T23:59:59.999Z'));
    await expectTies(new Date('2026-01-31T23:59:59.999Z'));
    const feb = await salesTaxLiabilityReport(ctx, { from: new Date('2026-02-01T00:00:00Z'), to: new Date('2026-02-28T23:59:59.999Z') });
    const jan = await salesTaxLiabilityReport(ctx, { to: new Date('2026-01-31T23:59:59.999Z') });
    expect(feb.totals.openingBalance).toBe(jan.totals.balance);
    // Feb = opening + adjustments − payments
    const expected = Number(feb.totals.openingBalance) + Number(feb.totals.adjustments) - Number(feb.totals.paid);
    expect(Number(feb.totals.balance)).toBeCloseTo(expected, 2);
  });

  it('Pay Sales Tax grid (salesTaxLiabilityByAgency) is the same engine', async () => {
    const grid = await salesTaxLiabilityByAgency(ctx);
    expect(grid.tiesToGl).toBe(true);
    expect(grid.totalBalance).toBe(grid.glBalance);
  });

  it('credit memos and void documents are reflected (credited is negative, void excluded)', async () => {
    const r = await salesTaxLiabilityReport(ctx, { from: d('2026-01-01'), to: new Date('2026-01-31T23:59:59.999Z') });
    expect(Number(r.totals.credited)).toBeLessThan(0);
    // 33.33 × 8% = 2.67 credited back in total
    expect(r.totals.credited).toBe('-2.67');
  });

  it('a tax payment made by journal entry is found, linked to the agency, and unlinked', async () => {
    const je = await createManualEntry(ctx, {
      date: d('2026-03-01'),
      description: 'Paid county tax from checking',
      lines: [
        { accountId: acct['2200'], debit: '10.00' },
        { accountId: acct['1000'], credit: '10.00' },
      ],
    });
    let issues = await findMisrecordedSalesTax(ctx);
    const issue = issues.find((i) => i.entryId === je.id)!;
    expect(issue.issue).toBe('liability_unattributed');
    expect(issue.amount).toBe('10.00');
    const r1 = await salesTaxLiabilityReport(ctx);
    expect(r1.totals.unattributed).toBe('-10.00');
    expect(r1.tiesToGl).toBe(true);

    await linkSalesTaxLine(ctx, { lineId: issue.lineId, agencyId: county, kind: 'payment' });
    issues = await findMisrecordedSalesTax(ctx);
    expect(issues.find((i) => i.entryId === je.id)).toBeUndefined();
    const r2 = await salesTaxLiabilityReport(ctx);
    expect(r2.totals.unattributed).toBe('0.00');
    expect(r2.tiesToGl).toBe(true);
    expect(r2.totals.balance).toBe(r1.totals.balance); // attribution never changes the total

    await unlinkSalesTaxLine(ctx, issue.lineId);
    const r3 = await salesTaxLiabilityReport(ctx);
    expect(r3.totals.unattributed).toBe('-10.00');
    await linkSalesTaxLine(ctx, { lineId: issue.lineId, agencyId: county, kind: 'payment' });
  });

  it('a check to the agency coded to an expense is found and moved to sales tax', async () => {
    const vendor = await createVendor(ctx, { displayName: 'City Treasurer' });
    await createExpense(ctx, {
      vendorId: vendor.id,
      date: d('2026-03-05'),
      method: 'check',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6700'], amount: '4.00', description: 'sales tax' }],
    });
    const issues = await findMisrecordedSalesTax(ctx);
    const issue = issues.find((i) => i.issue === 'expense_payment')!;
    expect(issue).toBeDefined();
    expect(issue.suggestedAgencyId).toBe(city);
    const before = await salesTaxLiabilityReport(ctx);
    await reclassifySalesTaxPayment(ctx, { lineId: issue.lineId, agencyId: city });
    const after = await salesTaxLiabilityReport(ctx);
    expect(Number(after.totals.balance)).toBeCloseTo(Number(before.totals.balance) - 4, 2);
    expect(after.tiesToGl).toBe(true);
    // Not offered twice.
    expect((await findMisrecordedSalesTax(ctx)).some((i) => i.lineId === issue.lineId)).toBe(false);
    await expect(reclassifySalesTaxPayment(ctx, { lineId: issue.lineId, agencyId: city })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('adjustment validation: positive amount, non-liability offset account', async () => {
    await expect(
      createSalesTaxAdjustment(ctx, { date: d('2026-03-10'), agencyId: county, amount: '0', direction: 'reduce', adjustmentAccountId: acct['4950'], reason: 'rounding' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      createSalesTaxAdjustment(ctx, { date: d('2026-03-10'), agencyId: county, amount: '1', direction: 'reduce', adjustmentAccountId: acct['2200'], reason: 'rounding' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('cash basis recognizes invoice tax only when paid', async () => {
    const inv = await createInvoice(ctx, {
      customerId,
      date: d('2026-04-01'),
      taxRateId: county5,
      lines: [{ description: 'Cash basis', quantity: 1, rate: '200' }],
    }); // tax 10.00, total 210.00
    const range = { from: d('2026-04-01'), to: new Date('2026-04-30T23:59:59.999Z') };
    const before = await salesTaxLiabilityReport(ctx, { ...range, basis: 'cash' });
    expect(before.agencies.find((a) => a.agencyId === county)!.collected).toBe('0.00');
    await receivePayment(ctx, {
      customerId,
      date: d('2026-04-15'),
      method: 'check',
      amount: '105.00',
      applications: [{ invoiceId: inv.id, amountApplied: '105.00' }],
    });
    const after = await salesTaxLiabilityReport(ctx, { ...range, basis: 'cash' });
    expect(after.agencies.find((a) => a.agencyId === county)!.collected).toBe('5.00');
    const accrual = await salesTaxLiabilityReport(ctx, range);
    expect(accrual.agencies.find((a) => a.agencyId === county)!.collected).toBe('10.00');
  });

  it('revenue summary splits taxable / non-taxable sales and agrees on tax', async () => {
    const sum = await salesTaxRevenueSummary(ctx, { from: d('2026-01-01'), to: new Date('2026-12-31T23:59:59.999Z') });
    const comb = sum.rows.find((r) => r.taxRateId === combined)!;
    expect(Number(comb.taxableSales)).toBeGreaterThan(0);
    const liab = await salesTaxLiabilityReport(ctx, { from: d('2026-01-01'), to: new Date('2026-12-31T23:59:59.999Z') });
    const net = Number(liab.totals.collected) + Number(liab.totals.credited);
    expect(Number(sum.totals.taxCollected)).toBeCloseTo(net, 2);
    // total = taxable + non-taxable on every row
    for (const r of sum.rows) {
      expect(Number(r.totalSales)).toBeCloseTo(Number(r.taxableSales) + Number(r.nonTaxableSales), 2);
    }
  });

  it('closing check: the account balances and the engine still agree', async () => {
    const r = await expectTies();
    expect(r.totals.balance).toBe(await glOfTaxAccounts());
    const [cnt] = await db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '2200')));
    expect(cnt).toBeDefined();
  });
});
