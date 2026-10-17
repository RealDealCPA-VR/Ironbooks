/**
 * Review round 4: sales tax regressions. Each test isolates its documents in its own month.
 *  A  allocate() splits a negative amount like its positive mirror (agency split of a credit memo)
 *  B  Revenue Summary keeps a credit memo line's Tax flag
 *  C  cash basis: retainage invoices recognize all their tax on the billed base
 *  C2 Revenue Summary: billed retainage is not a sale
 *  D  cash basis: early-payment discounts settle the invoice
 *  E  cash basis: payment-item lines on the invoice settle it (on the invoice date)
 *  F  cash basis: an undone credit application no longer settles the invoice
 *  G  cash basis: a bounced check reverses on the bounce date, the payment month is unchanged
 *  H  Pay Sales Tax debits 2200 (where sales credit the tax), never the agency's own account
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createAccount } from './accounts';
import { createCustomer } from './customers';
import { createItem } from './items';
import { createTaxAgency, createTaxRate } from './salesTax';
import { setComponents } from './combinedTax';
import { createInvoice } from './invoices';
import { createCreditMemo, applyToInvoice, listCreditApplications, unapplyCreditApplication } from './creditMemos';
import { receivePayment, recordBouncedCheck } from './payments';
import { billRetainage } from './retainage';
import { paySalesTax } from './liabilityPayments';
import { salesTaxLiabilityReport, salesTaxRevenueSummary } from './accountant/salesTaxLedger';
import { allocate } from '@/lib/money';

describe('allocate(): a negative total mirrors the positive one', () => {
  const s = (xs: Array<{ toFixed: (n: number) => string }>) => xs.map((x) => x.toFixed(2));
  it('positive totals are unchanged (largest remainder gets the cent)', () => {
    expect(s(allocate('1.00', ['0.75', '0.1875', '0.0625']))).toEqual(['0.75', '0.19', '0.06']);
    expect(s(allocate('100.00', [1, 1, 1]))).toEqual(['33.34', '33.33', '33.33']);
    expect(s(allocate('10.00', [1, 2, 3]))).toEqual(['1.67', '3.33', '5.00']);
    expect(s(allocate('0.05', [0, 0, 0]))).toEqual(['0.02', '0.02', '0.01']);
  });
  it('negative totals are the exact negation, and zero parts are not "-0.00"', () => {
    expect(s(allocate('-1.00', ['0.75', '0.1875', '0.0625']))).toEqual(['-0.75', '-0.19', '-0.06']);
    expect(s(allocate('-100.00', [1, 1, 1]))).toEqual(['-33.34', '-33.33', '-33.33']);
    expect(s(allocate('-10.00', [1, 2, 3]))).toEqual(['-1.67', '-3.33', '-5.00']);
    expect(s(allocate('-0.05', [0, 0, 0]))).toEqual(['-0.02', '-0.02', '-0.01']);
    expect(s(allocate('-0.01', [1, 1000]))).toEqual(['0.00', '-0.01']);
    for (const [t, w] of [['-123.45', [3, 7, 11]], ['-0.07', [1, 1, 1, 1]]] as const) {
      const parts = allocate(t, [...w]);
      expect(parts.reduce((a, p) => a.plus(p), allocate('0', [1])[0]).toFixed(2)).toBe(Number(t).toFixed(2));
      expect(s(parts)).toEqual(s(allocate(t.slice(1), [...w])).map((v) => (v === '0.00' ? v : `-${v}`)));
    }
  });
});

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review4-salestax');
let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
let state: string, county: string, city: string, combined: string;

const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const month = (m: string) => ({ from: new Date(`${m}-01T00:00:00.000Z`), to: new Date(`${m}-28T23:59:59.999Z`) });

async function newCustomer(name: string) {
  return (await createCustomer(ctx, { displayName: name })).id;
}

describe('review4 sales tax', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'r4-stax@test.local', name: 'R4 Tax', passwordHash: 'x' })
      .returning();
    const company = await createCompany(db, { name: 'R4 Sales Tax Co', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    const all = await db.select().from(accounts).where(eq(accounts.companyId, company.id));
    for (const a of all) acct[a.code] = a.id;
    acct['2210'] = (
      await createAccount(ctx, { code: '2210', name: 'State Sales Tax Payable', type: 'liability' as never, subtype: 'other_current_liability' as never })
    ).id;
    state = (await createTaxAgency(ctx, { name: 'State DOR', liabilityAccountId: acct['2210'] })).id;
    county = (await createTaxAgency(ctx, { name: 'County' })).id;
    city = (await createTaxAgency(ctx, { name: 'City' })).id;
    combined = (await createTaxRate(ctx, { name: 'Combined 8%', rate: '0.08' })).id;
    await setComponents(ctx, combined, [
      { name: 'State 6%', agencyId: state, rate: '0.06' },
      { name: 'County 1.5%', agencyId: county, rate: '0.015' },
      { name: 'City 0.5%', agencyId: city, rate: '0.005' },
    ]);
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('A: a credit memo that exactly reverses an invoice leaves every agency at 0.00 (negative penny allocation)', async () => {
    const c = await newCustomer('Reversal Co');
    await createInvoice(ctx, { customerId: c, date: d('2026-01-05'), taxRateId: combined, lines: [{ description: 'Thing', quantity: 1, rate: '12.50' }] });
    await createCreditMemo(ctx, { customerId: c, date: d('2026-01-06'), taxRateId: combined, lines: [{ description: 'Return thing', quantity: 1, rate: '12.50' }] });
    const r = await salesTaxLiabilityReport(ctx, month('2026-01'));
    expect(r.totals.balance).toBe('0.00');
    const bal = Object.fromEntries(r.agencies.map((a) => [a.agencyName, a.balance]));
    expect(bal).toMatchObject({ 'State DOR': '0.00', County: '0.00', City: '0.00' });
  });

  it('B: Revenue Summary: a credit memo’s non-taxable lines are not taxable sales', async () => {
    const c = await newCustomer('Mixed Return Co');
    await createInvoice(ctx, {
      customerId: c, date: d('2026-02-05'), taxRateId: combined,
      lines: [{ description: 'Taxable', quantity: 1, rate: '100' }, { description: 'Labor', quantity: 1, rate: '50', taxable: false }],
    });
    await createCreditMemo(ctx, {
      customerId: c, date: d('2026-02-06'), taxRateId: combined,
      lines: [{ description: 'Taxable', quantity: 1, rate: '100' }, { description: 'Labor', quantity: 1, rate: '50', taxable: false }],
    });
    const s = await salesTaxRevenueSummary(ctx, month('2026-02'));
    expect(s.totals.totalSales).toBe('0.00');
    expect(s.totals.taxCollected).toBe('0.00');
    expect(s.totals.taxableSales).toBe('0.00'); // was -50.00
    expect(s.totals.nonTaxableSales).toBe('0.00'); // was 50.00
  });

  it('C: cash basis: a retainage invoice paid in full (billed base + billed retainage) recognizes all its tax', async () => {
    const c = await newCustomer('Builder Co');
    const inv = await createInvoice(ctx, {
      customerId: c, date: d('2026-03-02'), taxRateId: combined, retainagePercent: 10,
      lines: [{ description: 'Phase 1', quantity: 1, rate: '1000' }],
    });
    expect(inv.taxAmount).toBe('80.00');
    expect(inv.balanceDue).toBe('972.00');
    await receivePayment(ctx, { customerId: c, date: d('2026-03-10'), method: 'check', amount: '972.00', applications: [{ invoiceId: inv.id, amountApplied: '972.00' }] });
    const ret = await billRetainage(ctx, { customerId: c, date: d('2026-03-15') });
    await receivePayment(ctx, { customerId: c, date: d('2026-03-20'), method: 'check', amount: ret.total, applications: [{ invoiceId: ret.id, amountApplied: ret.total }] });
    const cash = await salesTaxLiabilityReport(ctx, { ...month('2026-03'), basis: 'cash' });
    expect(cash.totals.collected).toBe('80.00'); // was 72.00, forever
    // Paying only the billed base already recognizes all the tax (the holdback is a receivable).
    const firstPayment = await salesTaxLiabilityReport(ctx, { from: d('2026-03-01'), to: new Date('2026-03-10T23:59:59.999Z'), basis: 'cash' });
    expect(firstPayment.totals.collected).toBe('80.00');
  });

  it('C2: Revenue Summary: billed retainage (a receivable, 8.00 of it tax) is not a second, non-taxable sale', async () => {
    const sum = await salesTaxRevenueSummary(ctx, month('2026-03'));
    expect(sum.totals.taxableSales).toBe('1000.00');
    expect(sum.totals.totalSales).toBe('1000.00'); // was 1108.00
    const cashSum = await salesTaxRevenueSummary(ctx, { ...month('2026-03'), basis: 'cash' });
    expect(cashSum.totals.totalSales).toBe('1000.00');
    expect(cashSum.totals.taxCollected).toBe('80.00');
  });

  it('D: cash basis: an invoice settled with an early-payment discount recognizes all its tax', async () => {
    const c = await newCustomer('Prompt Payer');
    const inv = await createInvoice(ctx, { customerId: c, date: d('2026-04-02'), taxRateId: combined, lines: [{ description: 'Goods', quantity: 1, rate: '100' }] });
    await receivePayment(ctx, {
      customerId: c, date: d('2026-04-05'), method: 'check', amount: '105.84',
      applications: [{ invoiceId: inv.id, amountApplied: '105.84', discountAmount: '2.16' }],
    });
    const cash = await salesTaxLiabilityReport(ctx, { ...month('2026-04'), basis: 'cash' });
    const accrual = await salesTaxLiabilityReport(ctx, month('2026-04'));
    expect(accrual.totals.collected).toBe('8.00');
    expect(cash.totals.collected).toBe('8.00'); // was 7.84
    const cashSum = await salesTaxRevenueSummary(ctx, { ...month('2026-04'), basis: 'cash' });
    expect(cashSum.totals.taxableSales).toBe('100.00');
  });

  it('E: cash basis: an invoice paid by a payment-item line on the invoice recognizes its tax', async () => {
    const c = await newCustomer('Paid At Counter');
    const pay = await createItem(ctx, { name: 'Payment Rcvd R4', type: 'payment' });
    const inv = await createInvoice(ctx, {
      customerId: c, date: d('2026-05-02'), taxRateId: combined,
      lines: [{ description: 'Goods', quantity: 1, rate: '100' }, { itemId: pay.id, description: 'Paid', quantity: 1, rate: '108' }],
    });
    expect(inv.balanceDue).toBe('0.00');
    const cash = await salesTaxLiabilityReport(ctx, { ...month('2026-05'), basis: 'cash' });
    expect(cash.totals.collected).toBe('8.00'); // was 0.00, forever
    // On the invoice date.
    const day = await salesTaxLiabilityReport(ctx, { from: d('2026-05-02'), to: new Date('2026-05-02T23:59:59.999Z'), basis: 'cash' });
    expect(day.totals.collected).toBe('8.00');
  });

  it('F: cash basis: a credit application that was undone no longer settles the invoice', async () => {
    const c = await newCustomer('Undo Credit Co');
    const inv = await createInvoice(ctx, { customerId: c, date: d('2026-06-02'), taxRateId: combined, lines: [{ description: 'Goods', quantity: 1, rate: '100' }] });
    const cm = await createCreditMemo(ctx, { customerId: c, date: d('2026-06-03'), taxRateId: null, lines: [{ description: 'Goodwill', quantity: 1, rate: '108', taxable: false }] });
    await applyToInvoice(ctx, { creditMemoId: cm.id, invoiceId: inv.id, amount: '108.00', date: d('2026-06-04') });
    const [app] = await listCreditApplications(ctx, { invoiceId: inv.id });
    await unapplyCreditApplication(ctx, app.id);
    const cash = await salesTaxLiabilityReport(ctx, { ...month('2026-06'), basis: 'cash' });
    expect(cash.totals.collected).toBe('0.00'); // was 8.00 (the invoice is unpaid)
    // Applied again in two parts, the second undone: only the live 50.00 settles (8 x 50/108).
    await applyToInvoice(ctx, { creditMemoId: cm.id, invoiceId: inv.id, amount: '50.00', date: d('2026-06-20') });
    await applyToInvoice(ctx, { creditMemoId: cm.id, invoiceId: inv.id, amount: '58.00', date: d('2026-06-21') });
    const apps = await listCreditApplications(ctx, { invoiceId: inv.id });
    await unapplyCreditApplication(ctx, apps.find((a) => a.amount === '58.00')!.id);
    const partial = await salesTaxLiabilityReport(ctx, { ...month('2026-06'), basis: 'cash' });
    expect(partial.totals.collected).toBe('3.70');
    // A credit counts on the memo date (with the memo's own credited tax), never twice.
    await applyToInvoice(ctx, { creditMemoId: cm.id, invoiceId: inv.id, amount: '58.00', date: d('2026-06-22') });
    const memoDay = await salesTaxLiabilityReport(ctx, { from: d('2026-06-03'), to: new Date('2026-06-03T23:59:59.999Z'), basis: 'cash' });
    expect(memoDay.totals.collected).toBe('8.00');
    const full = await salesTaxLiabilityReport(ctx, { ...month('2026-06'), basis: 'cash' });
    expect(full.totals.collected).toBe('8.00');
  });

  it('G: cash basis: a bounced check does not rewrite the period the payment was in', async () => {
    const c = await newCustomer('NSF Co');
    const inv = await createInvoice(ctx, { customerId: c, date: d('2026-07-02'), taxRateId: combined, lines: [{ description: 'Goods', quantity: 1, rate: '100' }] });
    const { payment } = await receivePayment(ctx, {
      customerId: c, date: d('2026-07-05'), method: 'check', amount: '108.00', depositAccountId: acct['1000'],
      applications: [{ invoiceId: inv.id, amountApplied: '108.00' }],
    });
    const julyBefore = await salesTaxLiabilityReport(ctx, { ...month('2026-07'), basis: 'cash' });
    expect(julyBefore.totals.collected).toBe('8.00');
    await recordBouncedCheck(ctx, { paymentId: payment.id, date: d('2026-08-03') });
    const julyAfter = await salesTaxLiabilityReport(ctx, { ...month('2026-07'), basis: 'cash' });
    expect(julyAfter.totals.collected).toBe('8.00'); // was 0.00: a filed month changed
    // The bounce takes the tax back in August.
    const august = await salesTaxLiabilityReport(ctx, { ...month('2026-08'), basis: 'cash' });
    expect(august.totals.collected).toBe('-8.00');
    const augSum = await salesTaxRevenueSummary(ctx, { ...month('2026-08'), basis: 'cash' });
    expect(augSum.totals.taxableSales).toBe('-100.00');
    const julSum = await salesTaxRevenueSummary(ctx, { ...month('2026-07'), basis: 'cash' });
    expect(julSum.totals.taxableSales).toBe('100.00');
  });

  it('H: an agency with its own liability account: its payment debits 2200, where the sales credited the tax', async () => {
    const c = await newCustomer('Agency Acct Co');
    await createInvoice(ctx, { customerId: c, date: d('2026-09-02'), taxRateId: combined, lines: [{ description: 'Goods', quantity: 1, rate: '1000' }] });
    const r = await salesTaxLiabilityReport(ctx, { to: new Date('2026-09-30T23:59:59.999Z') });
    const stateOwed = r.agencies.find((a) => a.agencyId === state)!.balance;
    await paySalesTax(ctx, { amount: stateOwed, date: d('2026-09-20'), paymentAccountId: acct['1000'], agencyId: state });
    const after = await salesTaxLiabilityReport(ctx, { to: new Date('2026-09-30T23:59:59.999Z') });
    expect(after.agencies.find((a) => a.agencyId === state)!.balance).toBe('0.00');
    const [a2210] = await db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '2210')));
    // The state's own liability account is never driven to a debit balance (it was -143.99).
    expect(a2210.balance).toBe('0.00');
    expect(after.tiesToGl).toBe(true);
    const [a2200] = await db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '2200')));
    expect(a2200.balance).toBe(after.totals.balance);
  });
});
