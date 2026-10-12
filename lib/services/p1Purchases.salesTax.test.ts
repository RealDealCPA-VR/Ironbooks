/**
 * P1 purchases — Pay Sales Tax as a check document, cash basis / due-through, liability checks,
 * customer refund checks in the print queue, and the sales_tax vs payroll permission split.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, journalEntries, paymentChecks, taxAgencies, users, vendors } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany, updateCompany } from './company';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { receivePayment } from './payments';
import { createCreditMemo, refundCreditMemo } from './creditMemos';
import { trialBalance } from './reports';
import { createTaxAgency, createTaxRate } from './salesTax';
import { postJournalEntry } from './posting';
import {
  listPaymentChecks,
  payPayrollLiabilities,
  paySalesTax,
  paySalesTaxAgencies,
  paySalesTaxScreen,
  queueCustomerRefundCheck,
  unprintedRefunds,
  voidPaymentCheck,
} from './liabilityPayments';
import { checkPrintData, listPrintQueue, markPrinted } from './printQueue';
import { findDuplicateCheckNumbers, nextCheckNumber } from './checkNumbers';
import { checkDetail, missingChecks } from './reportsExtra';
import {
  lastFilingPeriod,
  salesTaxDueThrough,
  salesTaxLiabilityReport,
  salesTaxRevenueSummary,
} from './accountant/salesTaxLedger';
import { apiRuleFor, pageAreasFor } from '@/lib/permissions/routes';
import { builtinRole, can, unionRoles, type Area } from '@/lib/permissions/model';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-purchases-salestax');
let db: DB;
let userId: string;

const d = (s: string) => new Date(`${s}T12:00:00.000Z`);

async function newCompany(name: string) {
  const company = await createCompany(db, { name, ownerId: userId });
  const ctx: ServiceContext = { db, companyId: company.id, userId };
  const acct: Record<string, string> = {};
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
  return { ctx, acct };
}

async function expectBalanced(ctx: ServiceContext) {
  const tb = await trialBalance(ctx);
  expect(tb.balanced).toBe(true);
}

describe('P1 purchases — sales tax payments', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'p1-salestax@test.local', name: 'P1 Tester', passwordHash: 'x' })
      .returning();
    userId = user.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('Sales Tax Payment check documents', () => {
    let ctx: ServiceContext;
    let acct: Record<string, string>;
    let state: string;
    let county: string;

    beforeAll(async () => {
      ({ ctx, acct } = await newCompany('ST Checks Co'));
      state = (await createTaxAgency(ctx, { name: 'State Revenue' })).id;
      county = (await createTaxAgency(ctx, { name: 'County Tax' })).id;
      const stRate = (await createTaxRate(ctx, { name: 'State 6%', rate: '0.06', agencyId: state })).id;
      const coRate = (await createTaxRate(ctx, { name: 'County 2%', rate: '0.02', agencyId: county })).id;
      const cust = (await createCustomer(ctx, { displayName: 'Taxed Buyer' })).id;
      await createInvoice(ctx, { customerId: cust, date: d('2026-07-10'), taxRateId: stRate, lines: [{ description: 'Sale', quantity: 1, rate: '1000.00' }] });
      await createInvoice(ctx, { customerId: cust, date: d('2026-07-11'), taxRateId: coRate, lines: [{ description: 'Sale', quantity: 1, rate: '1000.00' }] });
    });

    it('pays several agencies at once: one numbered check per agency, payee = agency vendor', async () => {
      const res = await paySalesTaxAgencies(ctx, {
        date: d('2026-10-05'),
        paymentAccountId: acct['1000'],
        payments: [
          { agencyId: state, amount: '60.00' },
          { agencyId: county, amount: '20.00' },
        ],
        checkNumber: '501',
      });
      expect(res.checks).toHaveLength(2);
      expect(res.total).toBe('80.00');
      expect(res.checks.map((c) => c.reference)).toEqual(['501', '502']);
      expect(res.checks.map((c) => c.payeeName)).toEqual(['State Revenue', 'County Tax']);

      // QB tax agencies are vendors: a vendor was created and linked.
      const [ag] = await db.select().from(taxAgencies).where(eq(taxAgencies.id, state));
      expect(ag.vendorId).toBeTruthy();
      const [v] = await db.select().from(vendors).where(eq(vendors.id, ag.vendorId!));
      expect(v.displayName).toBe('State Revenue');

      // Ledger: sourceRef tax_agency:<id>, the check number on the entry (register / check detail).
      const [je] = await db.select().from(journalEntries).where(eq(journalEntries.id, res.checks[0].entryId));
      expect(je.sourceRef).toBe(`tax_agency:${state}`);
      expect(je.reference).toBe('501');

      const rep = await salesTaxLiabilityReport(ctx);
      expect(rep.agencies.find((a) => a.agencyId === state)?.balance).toBe('0.00');
      expect(rep.agencies.find((a) => a.agencyId === county)?.balance).toBe('0.00');
      expect(rep.tiesToGl).toBe(true);
      expect(await nextCheckNumber(ctx, acct['1000'])).toBe('503');
      await expectBalanced(ctx);
    });

    it('sales tax checks show in Check Detail and Missing Checks', async () => {
      const detail = await checkDetail(ctx);
      const rows = detail.rows.filter((r) => r.source === 'payment_check');
      expect(rows.map((r) => r.checkNumber).sort()).toEqual(['501', '502']);
      expect(rows[0].lines[0].detail).toBe('Sales Tax Payment');
      const missing = await missingChecks(ctx, acct['1000']);
      expect(missing.accounts[0]).toMatchObject({ firstNumber: 501, lastNumber: 502, missingCount: 0 });
    });

    it('a used check number is refused unless confirmed', async () => {
      await expect(
        paySalesTaxAgencies(ctx, { date: d('2026-10-06'), paymentAccountId: acct['1000'], payments: [{ agencyId: state, amount: '1.00' }], checkNumber: '501' }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      const dups = await findDuplicateCheckNumbers(ctx, { paymentAccountId: acct['1000'], number: '502' });
      expect(dups.map((x) => x.source)).toEqual(['payment_check']);
    });

    it('pay from must be a bank account (credit card, A/R and expense accounts refused)', async () => {
      for (const code of ['2100', '1200', '6000']) {
        await expect(
          paySalesTaxAgencies(ctx, { date: d('2026-10-06'), paymentAccountId: acct[code], payments: [{ agencyId: state, amount: '1.00' }] }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
      }
      await expect(
        paySalesTax(ctx, { date: d('2026-10-06'), paymentAccountId: acct['2100'], amount: '1.00' }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      await expectBalanced(ctx);
    });

    it('"To be printed" checks wait in Print Checks; printing stamps the number', async () => {
      const res = await paySalesTaxAgencies(ctx, {
        date: d('2026-10-07'),
        paymentAccountId: acct['1000'],
        payments: [{ agencyId: county, amount: '5.00' }],
        toPrint: true,
        memo: 'Q3 extra',
      });
      const check = res.checks[0];
      expect(check.reference).toBeNull();
      const queue = await listPrintQueue(ctx);
      const item = queue.find((q) => q.source === 'payment_check' && q.id === check.id);
      expect(item).toMatchObject({ payee: 'County Tax', amount: '5.00', memo: 'Q3 extra' });

      const data = await checkPrintData(ctx, 'payment_check', check.id);
      expect(data.payee).toBe('County Tax');
      expect(data.voucher[0].amount).toBe('5.00');

      await markPrinted(ctx, { source: 'payment_check', id: check.id, checkNumber: '600' });
      const [row] = await db.select().from(paymentChecks).where(eq(paymentChecks.id, check.id));
      expect(row).toMatchObject({ toPrint: false, reference: '600' });
      const [je] = await db.select().from(journalEntries).where(eq(journalEntries.id, check.entryId));
      expect(je.reference).toBe('600');
      expect((await listPrintQueue(ctx)).some((q) => q.id === check.id)).toBe(false);
    });

    it('voiding a sales tax check makes the tax owed again', async () => {
      const before = await salesTaxLiabilityReport(ctx);
      const res = await paySalesTaxAgencies(ctx, {
        date: d('2026-10-08'),
        paymentAccountId: acct['1000'],
        payments: [{ agencyId: state, amount: '7.00' }],
      });
      const mid = await salesTaxLiabilityReport(ctx);
      expect(mid.agencies.find((a) => a.agencyId === state)?.balance).toBe(
        (Number(before.agencies.find((a) => a.agencyId === state)?.balance) - 7).toFixed(2),
      );
      await voidPaymentCheck(ctx, res.checks[0].id);
      const after = await salesTaxLiabilityReport(ctx);
      expect(after.agencies.find((a) => a.agencyId === state)?.balance).toBe(before.agencies.find((a) => a.agencyId === state)?.balance);
      const list = await listPaymentChecks(ctx, { kind: 'sales_tax' });
      expect(list.find((c) => c.id === res.checks[0].id)?.isVoid).toBe(true);
      // A voided number no longer counts as a duplicate.
      expect(await findDuplicateCheckNumbers(ctx, { paymentAccountId: acct['1000'], number: res.checks[0].reference })).toEqual([]);
      await expectBalanced(ctx);
    });
  });

  describe('cash basis, filing frequency and "due through"', () => {
    it('lastFilingPeriod follows the filing frequency', () => {
      expect(lastFilingPeriod('monthly', '2026-10-12')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
      expect(lastFilingPeriod('quarterly', '2026-10-12')).toEqual({ from: '2026-07-01', to: '2026-09-30' });
      expect(lastFilingPeriod('quarterly', '2026-02-03')).toEqual({ from: '2025-10-01', to: '2025-12-31' });
      expect(lastFilingPeriod('annually', '2026-10-12')).toEqual({ from: '2025-01-01', to: '2025-12-31' });
      expect(lastFilingPeriod('monthly', '2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    });

    it('Pay Sales Tax honours the cash-basis preference: tax owed pro rata as customers pay', async () => {
      const { ctx } = await newCompany('Cash Basis Tax Co');
      const agency = (await createTaxAgency(ctx, { name: 'Cash State' })).id;
      const rate = (await createTaxRate(ctx, { name: 'Cash 10%', rate: '0.10', agencyId: agency })).id;
      const cust = (await createCustomer(ctx, { displayName: 'Slow Payer' })).id;
      const inv = await createInvoice(ctx, {
        customerId: cust,
        date: d('2026-08-05'),
        taxRateId: rate,
        lines: [
          { description: 'Taxable', quantity: 1, rate: '1000.00' },
          { description: 'Labor', quantity: 1, rate: '100.00', taxable: false },
        ],
      });
      // Total 1200 (1000 + 100 + 100 tax). Customer pays half (600) in September.
      await receivePayment(ctx, { customerId: cust, date: d('2026-09-10'), method: 'check', amount: '600.00', applications: [{ invoiceId: inv.id, amountApplied: '600.00' }] });

      const accrual = await paySalesTaxScreen(ctx, { today: d('2026-10-12') });
      expect(accrual.basis).toBe('accrual');
      expect(accrual.frequency).toBe('quarterly');
      expect(accrual.dueThrough).toBe('2026-09-30');
      expect(accrual.rows.find((r) => r.agencyId === agency)?.amountDue).toBe('100.00');

      await updateCompany(ctx, { settings: { salesTaxBasis: 'cash', salesTaxFrequency: 'monthly' } as never });
      const cash = await paySalesTaxScreen(ctx, { today: d('2026-10-12') });
      expect(cash.basis).toBe('cash');
      expect(cash.dueThrough).toBe('2026-09-30');
      expect(cash.rows.find((r) => r.agencyId === agency)?.amountDue).toBe('50.00');

      // Through August nothing was paid yet → nothing owed on cash basis.
      const aug = await paySalesTaxScreen(ctx, { dueThrough: '2026-08-31' });
      expect(aug.rows.find((r) => r.agencyId === agency)?.amountDue ?? '0.00').toBe('0.00');

      // Paying the September tax on Oct 15 settles that period: due through Sep 30 drops to 0.
      await paySalesTaxAgencies(ctx, { date: d('2026-10-15'), paymentAccountId: (await db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '1000'))))[0].id, payments: [{ agencyId: agency, amount: '50.00' }] });
      const afterPay = await salesTaxDueThrough(ctx, { dueThrough: '2026-09-30', basis: 'cash' });
      expect(afterPay.rows.find((r) => r.agencyId === agency)).toMatchObject({ owedThrough: '50.00', settledLater: '50.00', amountDue: '0.00' });

      // Revenue summary on cash basis counts half the sales and half the tax for September.
      const rev = await salesTaxRevenueSummary(ctx, { from: d('2026-09-01'), to: new Date('2026-09-30T23:59:59.999Z'), basis: 'cash' });
      expect(rev.basis).toBe('cash');
      expect(rev.totals.taxableSales).toBe('500.00');
      expect(rev.totals.nonTaxableSales).toBe('50.00');
      expect(rev.totals.taxCollected).toBe('50.00');
      const revAccrual = await salesTaxRevenueSummary(ctx, { from: d('2026-08-01'), to: new Date('2026-08-31T23:59:59.999Z') });
      expect(revAccrual.totals.taxableSales).toBe('1000.00');
      expect(revAccrual.totals.taxCollected).toBe('100.00');
      await expectBalanced(ctx);
    });

    it('tax dated after the due-through date is not due yet (accrual)', async () => {
      const { ctx } = await newCompany('Due Through Co');
      const agency = (await createTaxAgency(ctx, { name: 'DT Agency' })).id;
      const rate = (await createTaxRate(ctx, { name: 'DT 5%', rate: '0.05', agencyId: agency })).id;
      const cust = (await createCustomer(ctx, { displayName: 'DT Cust' })).id;
      await createInvoice(ctx, { customerId: cust, date: d('2026-09-20'), taxRateId: rate, lines: [{ description: 'Q3', quantity: 1, rate: '200.00' }] });
      await createInvoice(ctx, { customerId: cust, date: d('2026-10-02'), taxRateId: rate, lines: [{ description: 'Q4', quantity: 1, rate: '400.00' }] });
      const due = await salesTaxDueThrough(ctx, { dueThrough: '2026-09-30' });
      expect(due.rows.find((r) => r.agencyId === agency)?.amountDue).toBe('10.00');
      const all = await salesTaxDueThrough(ctx, { dueThrough: '2026-10-31' });
      expect(all.rows.find((r) => r.agencyId === agency)?.amountDue).toBe('30.00');
    });
  });

  describe('Pay Payroll Liabilities writes a Liability Check', () => {
    it('bank pay-from creates a voidable, printable check; payroll balance restored on void', async () => {
      const { ctx, acct } = await newCompany('Liability Check Co');
      await postJournalEntry(ctx, {
        date: d('2026-09-01'),
        description: 'Accrue payroll tax',
        lines: [
          { accountId: acct['6500'], debit: '300.00' },
          { accountId: acct['2300'], credit: '300.00' },
        ],
      });
      const entry = await payPayrollLiabilities(ctx, {
        date: d('2026-09-15'),
        paymentAccountId: acct['1000'],
        amount: '300.00',
        payeeName: 'United States Treasury',
        toPrint: true,
      });
      const [check] = await listPaymentChecks(ctx, { kind: 'payroll_liability' });
      expect(check).toMatchObject({ payeeName: 'United States Treasury', amount: '300.00', toPrint: true, postedEntryId: entry.id });
      expect((await listPrintQueue(ctx)).some((q) => q.id === check.id)).toBe(true);
      await voidPaymentCheck(ctx, check.id);
      const [je] = await db.select().from(journalEntries).where(eq(journalEntries.id, entry.id));
      expect(je.status).toBe('void');
      expect((await listPrintQueue(ctx)).some((q) => q.id === check.id)).toBe(false);
      await expectBalanced(ctx);
    });
  });

  describe('customer refund checks go through the print queue (D3)', () => {
    it('a credit-memo refund from checking can be queued, printed and numbered', async () => {
      const { ctx, acct } = await newCompany('Refund Check Co');
      const cust = (await createCustomer(ctx, { displayName: 'Refunded Rita' })).id;
      const memo = await createCreditMemo(ctx, { customerId: cust, date: d('2026-09-01'), lines: [{ description: 'Return', quantity: 1, rate: '40.00' }] });
      await refundCreditMemo(ctx, { creditMemoId: memo.id, bankAccountId: acct['1000'], amount: '40.00', date: d('2026-09-02') });
      const refunds = await unprintedRefunds(ctx);
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toMatchObject({ payee: 'Refunded Rita', amount: '40.00', paymentAccountId: acct['1000'] });

      const check = await queueCustomerRefundCheck(ctx, { entryId: refunds[0].entryId });
      expect(check.kind).toBe('customer_refund');
      await expect(queueCustomerRefundCheck(ctx, { entryId: refunds[0].entryId })).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await unprintedRefunds(ctx)).toHaveLength(0);
      const item = (await listPrintQueue(ctx)).find((q) => q.id === check.id);
      expect(item).toMatchObject({ source: 'payment_check', payee: 'Refunded Rita', amount: '40.00' });
      await markPrinted(ctx, { source: 'payment_check', id: check.id, checkNumber: '7001' });
      const [je] = await db.select().from(journalEntries).where(eq(journalEntries.id, refunds[0].entryId));
      expect(je.reference).toBe('7001');
      await expectBalanced(ctx);
    });
  });
});

describe('P1 purchases — Pay Sales Tax permission is sales_tax, not payroll', () => {
  const access = (key: string) => unionRoles([builtinRole(key)!]);
  const allowed = (key: string, path: string, method: string) => {
    const rule = apiRuleFor(path, method);
    if (!rule || typeof rule === 'string') return false;
    return can(access(key), rule.area as Area, rule.action);
  };

  it('Pay Sales Tax routes need the sales tax area', () => {
    expect(apiRuleFor('/api/sales-tax/pay', 'POST')).toEqual({ area: 'sales_tax', action: 'create' });
    expect(apiRuleFor('/api/sales-tax/pay', 'GET')).toEqual({ area: 'sales_tax', action: 'view' });
    expect(apiRuleFor('/api/sales-tax/payments/00000000-0000-0000-0000-000000000000', 'POST')).toEqual({ area: 'sales_tax', action: 'delete' });
    expect(pageAreasFor('/sales-tax')).toEqual(['sales_tax']);
    expect(pageAreasFor('/pay-liabilities')).toEqual(['payroll']);
  });

  it('a bookkeeper can pay sales tax; a payroll-only user cannot', () => {
    expect(allowed('bookkeeper', '/api/sales-tax/pay', 'POST')).toBe(true);
    expect(allowed('bookkeeper', '/api/sales-tax/pay', 'GET')).toBe(true);
    expect(allowed('payroll_processor', '/api/sales-tax/pay', 'POST')).toBe(false);
    expect(allowed('payroll_processor', '/api/sales-tax/pay', 'GET')).toBe(false);
    // Payroll liabilities stay payroll.
    expect(allowed('payroll_processor', '/api/pay-liabilities', 'POST')).toBe(true);
    expect(allowed('bookkeeper', '/api/pay-liabilities', 'POST')).toBe(false);
  });

  it('the payroll Pay Liabilities endpoint no longer pays sales tax', async () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'app/api/pay-liabilities/route.ts'), 'utf8');
    expect(src).not.toMatch(/paySalesTax/);
    expect(src).toMatch(/Sales tax is paid on the Pay Sales Tax page/);
  });
});
