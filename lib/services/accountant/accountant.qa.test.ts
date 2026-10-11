/**
 * Independent QA (tester) for the wave2 accountant package — adversarial tests written against
 * the gap list, not against the implementation:
 *   D7/H12 sales-tax liability per agency (exact component split, cash basis incl. credit-memo
 *   settlement), D8 adjustments (closing date, sub-ledger accounts, malformed input), I2 fix
 *   sales tax (cross-company, void, bad kinds), I3 reclassify (atomicity, closed periods,
 *   cross-company, class-only, audit), I4 write-off (atomic, closing date, partial balances,
 *   A/R control), I5 batch enter (malformed rows, negative / sub-cent JE amounts, cc credits,
 *   bank account type, row mode), I6 batch void (dedupe, cross-company, document entries,
 *   closed periods, draft delete audit), I8 WTB (ending == trial balance), I10 list changes
 *   (non-list / foreign audit ids, unmark), I13 client data review (voided credits, vendor
 *   credits), J11 closing-date exception (rollback, voids, no false positives), J12 voided/deleted.
 * Every mutating scenario re-checks that the trial balance balances.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  accounts,
  auditLogs,
  creditMemos,
  invoiceLines,
  invoices,
  journalEntries,
  journalEntryLines,
  users,
  vendorCredits,
} from '@/lib/db/schema';
import type { ServiceContext } from '../_base';
import { createCompany, setClosingDate } from '../company';
import { createAccount, updateAccount } from '../accounts';
import { createCustomer } from '../customers';
import { createVendor } from '../vendors';
import { createClass } from '../dimensions';
import { createInvoice, voidInvoice } from '../invoices';
import { createExpense, voidExpense } from '../expenses';
import { applyToInvoice, createCreditMemo, voidCreditMemo } from '../creditMemos';
import { receivePayment } from '../payments';
import { createBill } from '../bills';
import { createVendorCredit } from '../vendorCredits';
import { createManualEntry } from '../journal';
import { postJournalEntry } from '../posting';
import { trialBalance } from '../reports';
import { createTaxAgency, createTaxRate } from '../salesTax';
import { setComponents } from '../combinedTax';
import { paySalesTax } from '../liabilityPayments';
import { emptyPermissionSet, type EffectiveAccess } from '@/lib/permissions/model';
import { salesTaxGlBalance, salesTaxLiabilityReport } from './salesTaxLedger';
import { createSalesTaxAdjustment, linkSalesTaxLine } from './salesTaxTools';
import { listReclassifyLines, reclassifyLines } from './reclassify';
import { writeOffInvoices } from './writeOff';
import { batchEnterTransactions } from './batchEnter';
import { normalizeAmount, normalizeDate, parseBatchPaste } from './batchEnterParse';
import { batchVoidTransactions, listBatchTransactions } from './batchVoid';
import { postAdjustingEntry, saveWtbNote, workingTrialBalance } from './workingTrialBalance';
import { listListChanges, markListChangesReviewed } from './listChanges';
import { autoApplyCustomerCredit, autoApplyVendorCredit, setReviewTaskStatus } from './clientDataReview';
import { closingDateExceptionReport, voidedDeletedTransactions } from './auditReports';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-accountant-qa');
let db: DB;
let ctx: ServiceContext;
let other: ServiceContext; // a second company in the same file (tenant isolation)
const acct: Record<string, string> = {};
const otherAcct: Record<string, string> = {};
let state: string, county: string, city: string;
let combined: string, county5: string;

const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const eod = (s: string) => new Date(`${s}T23:59:59.999Z`);
const cents = (v: string | number) => Math.round(Number(v) * 100);

async function expectBalanced(c: ServiceContext = ctx) {
  const tb = await trialBalance(c);
  expect(tb.balanced).toBe(true);
  expect(tb.totalDebit).toBe(tb.totalCredit);
  return tb;
}

async function balanceOf(id: string): Promise<string> {
  const [a] = await db.select({ b: accounts.balance }).from(accounts).where(eq(accounts.id, id));
  return a.b;
}

async function withClosingDate<T>(date: string, fn: () => Promise<T>): Promise<T> {
  await setClosingDate(ctx, { closingDate: date, password: 'qa-close' });
  try {
    return await fn();
  } finally {
    await setClosingDate(ctx, { closingDate: null });
  }
}

async function auditCount(entityType: string): Promise<number> {
  const rows = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityType, entityType)));
  return rows.length;
}

describe('wave2 accountant — independent QA', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'acct-qa@test.local', name: 'QA Tester', passwordHash: 'x' })
      .returning();
    const company = await createCompany(db, { name: 'QA Accountant Co', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
    acct['6800'] = (
      await createAccount(ctx, { code: '6800', name: 'Bad Debt', type: 'expense' as never, subtype: 'operating_expenses' })
    ).id;
    acct['4950'] = (
      await createAccount(ctx, { code: '4950', name: 'Sales Tax Discounts', type: 'revenue' as never, subtype: 'other_income' })
    ).id;

    const company2 = await createCompany(db, { name: 'QA Other Co', ownerId: user.id });
    other = { db, companyId: company2.id, userId: user.id };
    for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company2.id))) otherAcct[a.code] = a.id;

    state = (await createTaxAgency(ctx, { name: 'QA State Revenue' })).id;
    county = (await createTaxAgency(ctx, { name: 'QA County' })).id;
    city = (await createTaxAgency(ctx, { name: 'QA City' })).id;
    combined = (await createTaxRate(ctx, { name: 'QA Combined 8%', rate: '0.08' })).id;
    await setComponents(ctx, combined, [
      { name: 'State 6%', agencyId: state, rate: '0.06' },
      { name: 'County 1.5%', agencyId: county, rate: '0.015' },
      { name: 'City 0.5%', agencyId: city, rate: '0.005' },
    ]);
    county5 = (await createTaxRate(ctx, { name: 'QA County 5%', rate: '0.05', agencyId: county })).id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ======================================================================= D7 / H12
  describe('D7 sales tax liability per agency', () => {
    it('splits combined-rate and per-line tax to each agency to the penny', async () => {
      const cust = (await createCustomer(ctx, { displayName: 'Exact Split Customer' })).id;
      await createInvoice(ctx, {
        customerId: cust,
        date: d('2026-01-05'),
        taxRateId: combined,
        lines: [
          { description: 'County-special item', quantity: 1, rate: '100', taxRateId: county5 },
          { description: 'Normal item', quantity: 1, rate: '100' },
          { description: 'Exempt labor', quantity: 1, rate: '40', taxable: false },
        ],
      });
      const r = await salesTaxLiabilityReport(ctx, { from: d('2026-01-01'), to: eod('2026-01-31') });
      const by = (id: string) => r.agencies.find((a) => a.agencyId === id)!;
      expect(by(state).collected).toBe('6.00');
      expect(by(county).collected).toBe('6.50'); // 5.00 per-line + 1.50 combined component
      expect(by(city).collected).toBe('0.50');
      expect(r.totals.collected).toBe('13.00');
      expect(r.tiesToGl).toBe(true);
      expect(r.agencies.some((a) => a.agencyId === null)).toBe(false);
      await expectBalanced();
    });

    it('a voided invoice after a Pay Sales Tax payment leaves the agency overpaid, GL-tied', async () => {
      const cust = (await createCustomer(ctx, { displayName: 'Void After Pay' })).id;
      const inv = await createInvoice(ctx, {
        customerId: cust,
        date: d('2026-02-03'),
        taxRateId: county5,
        lines: [{ description: 'Will be voided', quantity: 1, rate: '200' }],
      }); // county tax 10.00
      const before = await salesTaxLiabilityReport(ctx, { to: eod('2026-02-28') });
      const countyBefore = before.agencies.find((a) => a.agencyId === county)!.balance;
      await paySalesTax(ctx, { amount: '10.00', date: d('2026-02-10'), paymentAccountId: acct['1000'], agencyId: county });
      await voidInvoice(ctx, inv.id);
      const after = await salesTaxLiabilityReport(ctx, { to: eod('2026-02-28') });
      expect(cents(after.agencies.find((a) => a.agencyId === county)!.balance)).toBe(cents(countyBefore) - 2000);
      expect(after.totals.balance).toBe(await salesTaxGlBalance(ctx, eod('2026-02-28')));
      await expectBalanced();
    });

    it('cash basis: an invoice settled entirely by a credit memo nets to zero tax', async () => {
      // QB cash basis treats a credit applied to an invoice like a payment. The invoice tax and
      // the memo's credited tax must offset — otherwise the agency shows a negative liability.
      const cust = (await createCustomer(ctx, { displayName: 'Cash Basis Credit' })).id;
      const inv = await createInvoice(ctx, {
        customerId: cust,
        date: d('2026-03-02'),
        taxRateId: county5,
        lines: [{ description: 'Returned goods', quantity: 1, rate: '100' }],
      }); // 100 + 5.00 tax
      const memo = await createCreditMemo(ctx, {
        customerId: cust,
        date: d('2026-03-05'),
        taxRateId: county5,
        lines: [{ description: 'Return', quantity: 1, rate: '100' }],
      }); // 100 + 5.00 tax credited
      await applyToInvoice(ctx, { creditMemoId: memo.id, invoiceId: inv.id, amount: '105.00' });
      const [i] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
      expect(i.balanceDue).toBe('0.00');

      const range = { from: d('2026-03-01'), to: eod('2026-03-31') };
      const accrual = await salesTaxLiabilityReport(ctx, range);
      const ca = accrual.agencies.find((a) => a.agencyId === county)!;
      expect(cents(ca.collected) + cents(ca.credited)).toBe(0);

      const cash = await salesTaxLiabilityReport(ctx, { ...range, basis: 'cash' });
      const cc = cash.agencies.find((a) => a.agencyId === county)!;
      expect(cents(cc.collected) + cents(cc.credited)).toBe(0);
    });

    it('cash basis: a voided customer payment un-recognizes the tax', async () => {
      const cust = (await createCustomer(ctx, { displayName: 'Cash Basis Void Pay' })).id;
      const inv = await createInvoice(ctx, {
        customerId: cust,
        date: d('2026-04-02'),
        taxRateId: county5,
        lines: [{ description: 'Cash item', quantity: 1, rate: '100' }],
      });
      const pay = await receivePayment(ctx, {
        customerId: cust,
        date: d('2026-04-03'),
        method: 'check',
        amount: '105.00',
        depositAccountId: acct['1000'],
        applications: [{ invoiceId: inv.id, amountApplied: '105.00' }],
      });
      const range = { from: d('2026-04-01'), to: eod('2026-04-30'), basis: 'cash' as const };
      expect((await salesTaxLiabilityReport(ctx, range)).agencies.find((a) => a.agencyId === county)!.collected).toBe('5.00');
      const { voidPayment } = await import('../payments');
      await voidPayment(ctx, pay.payment.id);
      expect((await salesTaxLiabilityReport(ctx, range)).agencies.find((a) => a.agencyId === county)!.collected).toBe('0.00');
      await expectBalanced();
    });
  });

  // ======================================================================= D8
  describe('D8 sales tax adjustment', () => {
    const base = () => ({
      date: d('2026-05-10'),
      agencyId: county,
      amount: '1.00',
      direction: 'reduce' as const,
      adjustmentAccountId: acct['4950'],
      reason: 'rounding' as const,
    });

    it('rejects malformed amounts, directions, reasons and unknown agencies', async () => {
      await expect(createSalesTaxAdjustment(ctx, { ...base(), amount: 'abc' })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(createSalesTaxAdjustment(ctx, { ...base(), amount: '-5' })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(createSalesTaxAdjustment(ctx, { ...base(), amount: '0.004' })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(createSalesTaxAdjustment(ctx, { ...base(), direction: 'sideways' as never })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(createSalesTaxAdjustment(ctx, { ...base(), reason: 'bribe' as never })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(
        createSalesTaxAdjustment(ctx, { ...base(), agencyId: '00000000-0000-4000-8000-000000000000' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      // Another company's account cannot be the offset.
      await expect(
        createSalesTaxAdjustment(ctx, { ...base(), adjustmentAccountId: otherAcct['4900'] }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('refuses sub-ledger control accounts (A/R, A/P) as the offset account', async () => {
      // Dr/Cr A/R or A/P without a customer/vendor document breaks sub-ledger == control account.
      await expect(createSalesTaxAdjustment(ctx, { ...base(), adjustmentAccountId: acct['1200'] })).rejects.toMatchObject({
        code: 'VALIDATION',
      });
      await expect(createSalesTaxAdjustment(ctx, { ...base(), adjustmentAccountId: acct['2000'] })).rejects.toMatchObject({
        code: 'VALIDATION',
      });
    });

    it('moves the agency balance by exactly the amount and respects the closing date', async () => {
      const before = await salesTaxLiabilityReport(ctx);
      const b0 = before.agencies.find((a) => a.agencyId === city)!.balance;
      await createSalesTaxAdjustment(ctx, { ...base(), agencyId: city, amount: '2.35', direction: 'increase', reason: 'penalty', adjustmentAccountId: acct['6700'] });
      const after = await salesTaxLiabilityReport(ctx);
      expect(cents(after.agencies.find((a) => a.agencyId === city)!.balance)).toBe(cents(b0) + 235);
      expect(after.tiesToGl).toBe(true);

      const n = await auditCount('sales_tax_adjustment');
      await withClosingDate('2026-05-31', async () => {
        await expect(createSalesTaxAdjustment(ctx, { ...base(), date: d('2026-05-15') })).rejects.toMatchObject({
          code: 'PERIOD_CLOSED',
        });
      });
      expect(await auditCount('sales_tax_adjustment')).toBe(n); // nothing half-written
      await expectBalanced();
    });
  });

  // ======================================================================= I2
  describe('I2 fix incorrectly recorded sales tax', () => {
    it('refuses bad kinds, non-liability lines, void entries and other companies’ lines', async () => {
      const je = await createManualEntry(ctx, {
        date: d('2026-05-20'),
        description: 'Paid tax straight from checking',
        lines: [
          { accountId: acct['2200'], debit: '3.00' },
          { accountId: acct['1000'], credit: '3.00' },
        ],
      });
      const lines = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, je.id));
      const taxLine = lines.find((l) => l.accountId === acct['2200'])!;
      const bankLine = lines.find((l) => l.accountId === acct['1000'])!;
      await expect(linkSalesTaxLine(ctx, { lineId: taxLine.id, agencyId: county, kind: 'bogus' as never })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(linkSalesTaxLine(ctx, { lineId: bankLine.id, agencyId: county, kind: 'payment' })).rejects.toMatchObject({ code: 'VALIDATION' });

      const foreign = await createManualEntry(other, {
        date: d('2026-05-20'),
        description: 'Other company tax',
        lines: [
          { accountId: otherAcct['2200'], debit: '1.00' },
          { accountId: otherAcct['1000'], credit: '1.00' },
        ],
      });
      const [fl] = await db
        .select()
        .from(journalEntryLines)
        .where(and(eq(journalEntryLines.journalEntryId, foreign.id), eq(journalEntryLines.accountId, otherAcct['2200'])));
      await expect(linkSalesTaxLine(ctx, { lineId: fl.id, agencyId: county, kind: 'payment' })).rejects.toMatchObject({ code: 'NOT_FOUND' });

      const { voidJournalEntry } = await import('../posting');
      await voidJournalEntry(ctx, je.id);
      await expect(linkSalesTaxLine(ctx, { lineId: taxLine.id, agencyId: county, kind: 'payment' })).rejects.toMatchObject({ code: 'CONFLICT' });
      const r = await salesTaxLiabilityReport(ctx);
      expect(r.tiesToGl).toBe(true);
      await expectBalanced();
    });
  });

  // ======================================================================= I3
  describe('I3 reclassify', () => {
    it('is atomic across entries: one closed-period line blocks the whole batch', async () => {
      const vendor = (await createVendor(ctx, { displayName: 'Reclass Vendor' })).id;
      const jan = await createExpense(ctx, { vendorId: vendor, date: d('2026-01-10'), method: 'check', paymentAccountId: acct['1000'], lines: [{ accountId: acct['6000'], amount: '10.00' }] });
      const mar = await createExpense(ctx, { vendorId: vendor, date: d('2026-03-10'), method: 'check', paymentAccountId: acct['1000'], lines: [{ accountId: acct['6000'], amount: '20.00' }] });
      const { lines } = await listReclassifyLines(ctx, { accountId: acct['6000'] });
      const ids = lines.filter((l) => l.sourceRef === `expense:${jan.id}` || l.sourceRef === `expense:${mar.id}`).map((l) => l.lineId);
      expect(ids).toHaveLength(2);
      const b6000 = await balanceOf(acct['6000']);
      await withClosingDate('2026-01-31', async () => {
        await expect(reclassifyLines(ctx, { lineIds: ids, newAccountId: acct['6100'] })).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
      });
      expect(await balanceOf(acct['6000'])).toBe(b6000);
      const after = await db.select().from(journalEntryLines).where(eq(journalEntryLines.accountId, acct['6100']));
      expect(after.filter((l) => ids.includes(l.id))).toHaveLength(0);
      await expectBalanced();
    });

    it("refuses another company's lines and leaves everything unchanged", async () => {
      const foreign = await createManualEntry(other, {
        date: d('2026-03-01'),
        description: 'Other co expense',
        lines: [
          { accountId: otherAcct['6000'], debit: '5.00' },
          { accountId: otherAcct['1000'], credit: '5.00' },
        ],
      });
      const [fl] = await db
        .select()
        .from(journalEntryLines)
        .where(and(eq(journalEntryLines.journalEntryId, foreign.id), eq(journalEntryLines.accountId, otherAcct['6000'])));
      await expect(reclassifyLines(ctx, { lineIds: [fl.id], newAccountId: acct['6100'] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      // Cross-company target account.
      const { lines } = await listReclassifyLines(ctx, { accountId: acct['6000'] });
      await expect(reclassifyLines(ctx, { lineIds: [lines[0].lineId], newAccountId: otherAcct['6100'] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const [still] = await db.select().from(journalEntryLines).where(eq(journalEntryLines.id, fl.id));
      expect(still.accountId).toBe(otherAcct['6000']);
      await expectBalanced(other);
    });

    it('rejects empty selections, no-op requests, inactive and control targets', async () => {
      const { lines } = await listReclassifyLines(ctx, { accountId: acct['6000'] });
      const id = lines[0].lineId;
      await expect(reclassifyLines(ctx, { lineIds: [] })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(reclassifyLines(ctx, { lineIds: [id] })).rejects.toMatchObject({ code: 'VALIDATION' });
      const inactive = await createAccount(ctx, { code: '6950', name: 'Retired Expense', type: 'expense' as never, subtype: 'operating_expenses' });
      await updateAccount(ctx, inactive.id, { isActive: false } as never);
      await expect(reclassifyLines(ctx, { lineIds: [id], newAccountId: inactive.id })).rejects.toMatchObject({ code: 'VALIDATION' });
      for (const code of ['1050', '1200', '2000', '2100', '2200', '2300', '1300']) {
        await expect(reclassifyLines(ctx, { lineIds: [id], newAccountId: acct[code] })).rejects.toMatchObject({ code: 'VALIDATION' });
      }
    });

    it('class-only change works on posted lines, keeps every amount and is audited', async () => {
      const cls = await createClass(ctx, { name: 'QA West' });
      const { lines } = await listReclassifyLines(ctx, { accountId: acct['6000'] });
      const target = lines[0];
      const tbBefore = await trialBalance(ctx);
      const auditsBefore = await db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityType, 'journal_entry'), eq(auditLogs.entityId, target.entryId)));
      const res = await reclassifyLines(ctx, { lineIds: [target.lineId], newClassId: cls.id });
      expect(res.linesChanged).toBe(1);
      const [l] = await db.select().from(journalEntryLines).where(eq(journalEntryLines.id, target.lineId));
      expect(l.classId).toBe(cls.id);
      expect(l.accountId).toBe(acct['6000']);
      expect(l.debit).toBe(target.debit);
      const tbAfter = await trialBalance(ctx);
      expect(tbAfter.rows).toEqual(tbBefore.rows);
      const auditsAfter = await db
        .select({ id: auditLogs.id, oldValues: auditLogs.oldValues })
        .from(auditLogs)
        .where(and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityType, 'journal_entry'), eq(auditLogs.entityId, target.entryId)));
      expect(auditsAfter.length).toBe(auditsBefore.length + 1);
    });

    it('moving an invoice income line re-points the invoice line too and keeps A/R untouched', async () => {
      const cust = (await createCustomer(ctx, { displayName: 'Reclass Invoice Cust' })).id;
      const inv = await createInvoice(ctx, { customerId: cust, date: d('2026-03-15'), lines: [{ description: 'Consulting', quantity: 1, rate: '321.00' }] });
      const ar = await balanceOf(acct['1200']);
      const { lines } = await listReclassifyLines(ctx, { accountId: acct['4000'], from: d('2026-03-15'), to: eod('2026-03-15') });
      const mine = lines.filter((l) => l.sourceRef === `invoice:${inv.id}`);
      expect(mine).toHaveLength(1);
      const res = await reclassifyLines(ctx, { lineIds: [mine[0].lineId], newAccountId: acct['4100'] });
      expect(res.documentsUpdated).toBe(1);
      const [il] = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
      expect(il.accountId).toBe(acct['4100']);
      expect(await balanceOf(acct['1200'])).toBe(ar);
      await expectBalanced();
    });
  });

  // ======================================================================= I4
  describe('I4 write off invoices', () => {
    it('is all-or-nothing when one selected invoice is already settled', async () => {
      const cust = (await createCustomer(ctx, { displayName: 'Write-off Atomic' })).id;
      const open = await createInvoice(ctx, { customerId: cust, date: d('2026-02-01'), lines: [{ description: 'Open', quantity: 1, rate: '50' }] });
      const paid = await createInvoice(ctx, { customerId: cust, date: d('2026-02-01'), lines: [{ description: 'Paid', quantity: 1, rate: '20' }] });
      await receivePayment(ctx, { customerId: cust, date: d('2026-02-02'), method: 'cash', amount: '20', applications: [{ invoiceId: paid.id, amountApplied: '20' }] });
      const memosBefore = await db.select().from(creditMemos).where(eq(creditMemos.customerId, cust));
      await expect(
        writeOffInvoices(ctx, { invoiceIds: [open.id, paid.id], date: d('2026-06-01'), badDebtAccountId: acct['6800'] }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      const [o] = await db.select().from(invoices).where(eq(invoices.id, open.id));
      expect(o.balanceDue).toBe('50.00');
      const memosAfter = await db.select().from(creditMemos).where(eq(creditMemos.customerId, cust));
      expect(memosAfter.length).toBe(memosBefore.length);
      await expectBalanced();
    });

    it('respects the closing date, the invoice date and rejects other companies’ invoices', async () => {
      const cust = (await createCustomer(ctx, { displayName: 'Write-off Guards' })).id;
      const inv = await createInvoice(ctx, { customerId: cust, date: d('2026-02-01'), lines: [{ description: 'Old', quantity: 1, rate: '75' }] });
      await withClosingDate('2026-06-30', async () => {
        await expect(
          writeOffInvoices(ctx, { invoiceIds: [inv.id], date: d('2026-06-15'), badDebtAccountId: acct['6800'] }),
        ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
      });
      await expect(
        writeOffInvoices(ctx, { invoiceIds: [inv.id], date: d('2026-01-15'), badDebtAccountId: acct['6800'] }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(
        writeOffInvoices(ctx, { invoiceIds: [inv.id], date: new Date('nope'), badDebtAccountId: acct['6800'] }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      const oc = (await createCustomer(other, { displayName: 'Foreign Cust' })).id;
      const foreign = await createInvoice(other, { customerId: oc, date: d('2026-02-01'), lines: [{ description: 'x', quantity: 1, rate: '9' }] });
      await expect(
        writeOffInvoices(ctx, { invoiceIds: [foreign.id], date: d('2026-07-01'), badDebtAccountId: acct['6800'] }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        writeOffInvoices(ctx, { invoiceIds: [inv.id], date: d('2026-07-01'), badDebtAccountId: otherAcct['6300'] }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const [i] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
      expect(i.balanceDue).toBe('75.00');
    });

    it('writes off only the remaining balance of a taxed, partially paid invoice; A/R drops by exactly that', async () => {
      const cust = (await createCustomer(ctx, { displayName: 'Write-off Partial' })).id;
      const inv = await createInvoice(ctx, {
        customerId: cust,
        date: d('2026-02-01'),
        taxRateId: combined,
        lines: [{ description: 'Taxed', quantity: 1, rate: '123.45' }],
      }); // tax 9.88 → total 133.33
      await receivePayment(ctx, { customerId: cust, date: d('2026-02-05'), method: 'check', amount: '33.33', depositAccountId: acct['1000'], applications: [{ invoiceId: inv.id, amountApplied: '33.33' }] });
      const ar0 = await balanceOf(acct['1200']);
      const tax0 = await salesTaxGlBalance(ctx);
      const res = await writeOffInvoices(ctx, { invoiceIds: [inv.id, inv.id], date: d('2026-07-01'), badDebtAccountId: acct['6800'] });
      expect(res.results).toHaveLength(1); // duplicate id deduped
      expect(res.total).toBe('100.00');
      expect(cents(await balanceOf(acct['1200']))).toBe(cents(ar0) - 10000);
      expect(await salesTaxGlBalance(ctx)).toBe(tax0); // write-off never touches tax owed
      const [m] = await db.select().from(creditMemos).where(eq(creditMemos.id, res.results[0].creditMemoId));
      expect(m.unapplied).toBe('0.00');
      expect(m.total).toBe('100.00');
      await expectBalanced();
    });
  });

  // ======================================================================= I5
  describe('I5 batch enter', () => {
    it('parser edge cases', () => {
      expect(normalizeAmount('12.50-')).toBe('-12.50');
      expect(normalizeAmount('1.2.3')).toBeNull();
      expect(normalizeAmount('')).toBeNull();
      expect(normalizeAmount('  $ 1,000 ')).toBe('1000');
      expect(normalizeAmount('--5')).toBeNull();
      expect(normalizeDate('45000')).toBe('2023-03-15');
      expect(normalizeDate('2/29/2027')).toBeNull();
      expect(normalizeDate('13/01/2026')).toBeNull();
      expect(normalizeDate('2026-1-5')).toBe('2026-01-05');
      const rows = parseBatchPaste('3/1/2026,101,"Smith, John",6300,"$1,200.00",note\n\n', 'check');
      expect(rows).toEqual([{ date: '3/1/2026', ref: '101', name: 'Smith, John', account: '6300', amount: '$1,200.00', memo: 'note' }]);
    });

    it('rejects whole-batch input errors', async () => {
      await expect(batchEnterTransactions(ctx, { type: 'nope' as never, rows: [{ date: '', account: '' }] })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(batchEnterTransactions(ctx, { type: 'check', rows: [] })).rejects.toMatchObject({ code: 'VALIDATION' });
      const many = Array.from({ length: 1001 }, () => ({ date: '2026-03-01', account: '6300', amount: '1' }));
      await expect(batchEnterTransactions(ctx, { type: 'check', bankAccountId: acct['1000'], rows: many })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(
        batchEnterTransactions(ctx, { type: 'check', bankAccountId: otherAcct['1000'], rows: [{ date: '2026-03-01', name: 'x', account: '6300', amount: '1' }] }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('a check "paid from" a non-bank account is refused', async () => {
      const tb0 = await trialBalance(ctx);
      const res = await batchEnterTransactions(ctx, {
        type: 'check',
        bankAccountId: acct['6400'], // Rent — an expense account is not a bank account
        rows: [{ date: '2026-03-03', name: 'Landlord', account: '6300', amount: '10.00' }],
      });
      expect(res.saved).toBe(0);
      expect(res.failed).toBe(1);
      const tb1 = await trialBalance(ctx);
      expect(tb1.rows).toEqual(tb0.rows);
    });

    it('journal entries with negative or both-sided amounts are refused; sub-cent amounts never unbalance', async () => {
      const tb0 = await trialBalance(ctx);
      const neg = await batchEnterTransactions(ctx, {
        type: 'journal',
        rows: [
          { date: '2026-03-04', ref: 'N1', account: '6300', debit: '(50)' },
          { date: '2026-03-04', ref: 'N1', account: '1000', credit: '(50)' },
        ],
      });
      expect(neg.saved).toBe(0);
      expect(neg.rolledBack).toBe(true);
      const both = await batchEnterTransactions(ctx, {
        type: 'journal',
        rows: [
          { date: '2026-03-04', ref: 'B1', account: '6300', debit: '10', credit: '10' },
          { date: '2026-03-04', ref: 'B1', account: '1000', debit: '5' },
          { date: '2026-03-04', ref: 'B1', account: '2000', credit: '5' },
        ],
      });
      expect(both.saved).toBe(0);
      expect((await trialBalance(ctx)).rows).toEqual(tb0.rows);

      const sub = await batchEnterTransactions(ctx, {
        type: 'journal',
        rows: [
          { date: '2026-03-04', ref: 'S1', account: '6300', debit: '10.004' },
          { date: '2026-03-04', ref: 'S1', account: '6600', debit: '10.004' },
          { date: '2026-03-04', ref: 'S1', account: '1000', credit: '20.008' },
        ],
      });
      if (sub.saved > 0) {
        const id = sub.results[0].id!;
        const ls = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, id));
        const dr = ls.reduce((s, l) => s + cents(l.debit ?? 0), 0);
        const cr = ls.reduce((s, l) => s + cents(l.credit ?? 0), 0);
        expect(dr).toBe(cr);
      }
      await expectBalanced();
    });

    it('credit card credits reduce the expense and the card balance; row mode saves the good rows', async () => {
      const exp0 = await balanceOf(acct['6300']);
      const cc0 = await balanceOf(acct['2100']);
      const res = await batchEnterTransactions(ctx, {
        type: 'cc_credit',
        bankAccountId: acct['2100'],
        mode: 'row',
        rows: [
          { date: '2026-03-06', name: 'Office Depot Refund', account: '6300', amount: '25.00' },
          { date: '2026-03-06', name: 'Bad Row', account: '6300', amount: '0' },
          { date: '2026-03-06', name: 'No account', account: '', amount: '5' },
        ],
      });
      expect(res.saved).toBe(1);
      expect(res.failed).toBe(2);
      expect(res.rolledBack).toBe(false);
      expect(cents(await balanceOf(acct['6300']))).toBe(cents(exp0) - 2500);
      // Paying back the card balance: a credit lowers what is owed on the card.
      expect(Math.abs(cents(await balanceOf(acct['2100'])) - cents(cc0))).toBe(2500);
      await expectBalanced();
    });

    it('row mode: a closed-period row fails alone and is reported', async () => {
      await withClosingDate('2026-01-31', async () => {
        const res = await batchEnterTransactions(ctx, {
          type: 'bill',
          mode: 'row',
          rows: [
            { date: '2026-01-15', name: 'Reclass Vendor', account: '6300', amount: '9.00' },
            { date: '2026-03-15', name: 'Reclass Vendor', account: '6300', amount: '8.00' },
          ],
        });
        expect(res.saved).toBe(1);
        expect(res.results[0].ok).toBe(false);
        expect(res.results[0].errors.join(' ')).toMatch(/closed/i);
        expect(res.results[1].ok).toBe(true);
      });
      await expectBalanced();
    });
  });

  // ======================================================================= I6
  describe('I6 batch void', () => {
    it('dedupes keys, refuses foreign / unknown / document-owned entries and closed periods', async () => {
      const cust = (await createCustomer(ctx, { displayName: 'Batch Void Cust' })).id;
      const inv = await createInvoice(ctx, { customerId: cust, date: d('2026-03-20'), lines: [{ description: 'x', quantity: 1, rate: '15' }] });
      const old = await createInvoice(ctx, { customerId: cust, date: d('2026-01-20'), lines: [{ description: 'old', quantity: 1, rate: '16' }] });
      const [invEntry] = await db.select().from(journalEntries).where(eq(journalEntries.sourceRef, `invoice:${inv.id}`));
      const oc = (await createCustomer(other, { displayName: 'Foreign Void Cust' })).id;
      const foreign = await createInvoice(other, { customerId: oc, date: d('2026-03-20'), lines: [{ description: 'f', quantity: 1, rate: '1' }] });

      const res = await withClosingDate('2026-01-31', () =>
        batchVoidTransactions(ctx, [
          `invoice:${inv.id}`,
          `invoice:${inv.id}`,
          `invoice:${foreign.id}`,
          `journal:${invEntry.id}`,
          `bogus:${inv.id}`,
          `invoice:${old.id}`,
        ]),
      );
      expect(res.results).toHaveLength(5);
      expect(res.results.find((r) => r.key === `invoice:${inv.id}`)!.ok).toBe(true);
      expect(res.results.find((r) => r.key === `invoice:${foreign.id}`)!.ok).toBe(false);
      expect(res.results.find((r) => r.key === `bogus:${inv.id}`)!.ok).toBe(false);
      expect(res.results.find((r) => r.key === `invoice:${old.id}`)!.ok).toBe(false);
      const [f] = await db.select().from(invoices).where(eq(invoices.id, foreign.id));
      expect(f.status).not.toBe('void');
      const [o] = await db.select().from(invoices).where(eq(invoices.id, old.id));
      expect(o.status).not.toBe('void');
      await expectBalanced();
      await expectBalanced(other);
    });

    it('listing has one row per transaction (no duplicate selection keys)', async () => {
      const list = await listBatchTransactions(ctx, { limit: 2000 });
      const keys = list.map((r) => r.key);
      expect(new Set(keys).size).toBe(keys.length);
      expect(list.some((r) => r.entryId && r.docId === r.entryId && r.type !== 'journal')).toBe(false);
    });

    it('a draft journal entry is deleted with an audit row that shows in the Voided/Deleted report', async () => {
      const draft = await postJournalEntry(ctx, {
        date: d('2026-03-22'),
        description: 'QA draft to delete',
        sourceRef: 'manual',
        status: 'draft',
        lines: [
          { accountId: acct['6300'], debit: '4.00' },
          { accountId: acct['1000'], credit: '4.00' },
        ],
      });
      const tb0 = await trialBalance(ctx);
      const res = await batchVoidTransactions(ctx, [`journal:${draft.id}`]);
      expect(res.results[0]).toMatchObject({ ok: true, action: 'delete' });
      expect(await db.select().from(journalEntries).where(eq(journalEntries.id, draft.id))).toHaveLength(0);
      expect((await trialBalance(ctx)).rows).toEqual(tb0.rows);
      const rep = await voidedDeletedTransactions(ctx, { detail: true });
      const row = rep.rows.find((r) => r.entityId === draft.id);
      expect(row).toMatchObject({ action: 'delete', typeLabel: 'Journal Entry' });
      expect(row!.amount).toBe('4.00');
      expect(await auditCount('batch_void')).toBeGreaterThan(0);
    });
  });

  // ======================================================================= I8
  describe('I8 working trial balance', () => {
    it('ending column equals the trial balance per account; voided adjustments are excluded', async () => {
      const adj = await postAdjustingEntry(ctx, {
        date: d('2026-06-30'),
        description: 'QA accrual',
        lines: [
          { accountId: acct['6600'], debit: '12.34' },
          { accountId: acct['2000'], credit: '12.34' },
        ],
      });
      const range = { from: d('2026-06-01'), to: eod('2026-06-30') };
      const w = await workingTrialBalance(ctx, range);
      expect(w.balanced).toBe(true);
      const tb = await trialBalance(ctx, eod('2026-06-30'));
      for (const r of tb.rows) {
        const row = w.rows.find((x) => x.accountId === r.accountId)!;
        expect(row, r.code).toBeDefined();
        expect(cents(row.ending), r.code).toBe(cents(r.debit) - cents(r.credit));
      }
      expect(w.rows.find((r) => r.accountId === acct['6600'])!.adjustments).toBe('12.34');
      const { voidJournalEntry } = await import('../posting');
      await voidJournalEntry(ctx, adj.id);
      const w2 = await workingTrialBalance(ctx, range);
      expect(w2.rows.find((r) => r.accountId === acct['6600'])?.adjustments ?? '0.00').toBe('0.00');
      expect(w2.balanced).toBe(true);
    });

    it('validates period, notes and accounts', async () => {
      await expect(workingTrialBalance(ctx, { from: d('2026-07-01'), to: d('2026-06-01') })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(saveWtbNote(ctx, { accountId: acct['6600'], periodEnd: '06/30/2026', note: 'x' })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(saveWtbNote(ctx, { accountId: acct['6600'], periodEnd: '2026-06-30', workpaperRef: 'x'.repeat(101) })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(saveWtbNote(ctx, { accountId: otherAcct['6600'], periodEnd: '2026-06-30', note: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      // Upsert: saving twice keeps one note.
      await saveWtbNote(ctx, { accountId: acct['6600'], periodEnd: '2026-06-30', workpaperRef: 'A-1' });
      await saveWtbNote(ctx, { accountId: acct['6600'], periodEnd: '2026-06-30', workpaperRef: 'A-2', note: 'second' });
      const w = await workingTrialBalance(ctx, { from: d('2026-06-01'), to: eod('2026-06-30') });
      expect(w.rows.filter((r) => r.accountId === acct['6600'])).toHaveLength(1);
      expect(w.rows.find((r) => r.accountId === acct['6600'])).toMatchObject({ workpaperRef: 'A-2', note: 'second' });
    });
  });

  // ======================================================================= I10
  describe('I10 review list changes', () => {
    it('ignores non-list and foreign audit ids; unmarking restores the change', async () => {
      const since = new Date(Date.now() - 2 * 86_400_000);
      await updateAccount(ctx, acct['6800'], { name: 'Bad Debt (QA)' });
      const r = await listListChanges(ctx, { since });
      const change = r.rows.find((x) => x.entityType === 'account' && x.entityId === acct['6800'])!;
      expect(change.changedFields).toContain('name');
      const [invAudit] = await db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityType, 'invoice')))
        .limit(1);
      await updateAccount(other, otherAcct['6300'], { name: 'Other Supplies' });
      const [foreignAudit] = await db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(and(eq(auditLogs.companyId, other.companyId), eq(auditLogs.entityType, 'account')))
        .limit(1);
      expect((await markListChangesReviewed(ctx, { auditLogIds: [invAudit.id, foreignAudit.id], reviewed: true })).updated).toBe(0);
      expect((await markListChangesReviewed(ctx, { auditLogIds: [change.auditLogId], reviewed: true })).updated).toBe(1);
      expect((await markListChangesReviewed(ctx, { auditLogIds: [change.auditLogId], reviewed: true })).updated).toBe(0); // idempotent
      expect((await listListChanges(ctx, { since })).rows.some((x) => x.auditLogId === change.auditLogId)).toBe(false);
      expect((await markListChangesReviewed(ctx, { auditLogIds: [change.auditLogId], reviewed: false })).updated).toBe(1);
      expect((await listListChanges(ctx, { since })).rows.some((x) => x.auditLogId === change.auditLogId)).toBe(true);
      // The other company's change never leaks into this company's list.
      expect((await listListChanges(ctx, { since })).rows.some((x) => x.auditLogId === foreignAudit.id)).toBe(false);
      await expect(listListChanges(ctx, { entityType: 'invoice' })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(markListChangesReviewed(ctx, { auditLogIds: [], reviewed: true })).rejects.toMatchObject({ code: 'VALIDATION' });
    });
  });

  // ======================================================================= I13
  describe('I13 client data review fixes', () => {
    it('refuses to apply a voided credit memo', async () => {
      const cust = (await createCustomer(ctx, { displayName: 'CDR Void Memo' })).id;
      await createInvoice(ctx, { customerId: cust, date: d('2026-04-01'), lines: [{ description: 'x', quantity: 1, rate: '50' }] });
      const memo = await createCreditMemo(ctx, { customerId: cust, date: d('2026-04-02'), lines: [{ description: 'c', quantity: 1, rate: '20', taxable: false }] });
      await voidCreditMemo(ctx, memo.id);
      const ar0 = await balanceOf(acct['1200']);
      await expect(autoApplyCustomerCredit(ctx, { refType: 'credit_memo', refId: memo.id })).rejects.toBeTruthy();
      expect(await balanceOf(acct['1200'])).toBe(ar0);
      await expectBalanced();
    });

    it('applies a bill credit across the oldest bills; A/P control equals open bills minus credits', async () => {
      const vendor = (await createVendor(ctx, { displayName: 'CDR Credit Vendor' })).id;
      const b1 = await createBill(ctx, { vendorId: vendor, date: d('2026-04-01'), lines: [{ accountId: acct['6300'], amount: '30.00' }] });
      const b2 = await createBill(ctx, { vendorId: vendor, date: d('2026-04-05'), lines: [{ accountId: acct['6300'], amount: '50.00' }] });
      const vc = await createVendorCredit(ctx, { vendorId: vendor, date: d('2026-04-10'), lines: [{ accountId: acct['6300'], amount: '45.00' }] });
      const ap0 = await balanceOf(acct['2000']);
      const res = await autoApplyVendorCredit(ctx, { refId: vc.id });
      expect(res).toEqual({ applied: '45.00', bills: 2 });
      const { bills: billsT } = await import('@/lib/db/schema');
      const [r1] = await db.select().from(billsT).where(eq(billsT.id, b1.id));
      const [r2] = await db.select().from(billsT).where(eq(billsT.id, b2.id));
      expect(r1.balanceDue).toBe('0.00');
      expect(r2.balanceDue).toBe('35.00');
      const [c] = await db.select().from(vendorCredits).where(eq(vendorCredits.id, vc.id));
      expect(c.unapplied).toBe('0.00');
      expect(await balanceOf(acct['2000'])).toBe(ap0); // applying moves no money
      await expect(autoApplyVendorCredit(ctx, { refId: vc.id })).rejects.toMatchObject({ code: 'CONFLICT' });
      await expectBalanced();
    });

    it('rejects unknown review tasks and statuses', async () => {
      await expect(setReviewTaskStatus(ctx, { taskKey: 'drop_tables', status: 'completed' })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(setReviewTaskStatus(ctx, { taskKey: 'item_setup', status: 'done' as never })).rejects.toMatchObject({ code: 'VALIDATION' });
    });
  });

  // ======================================================================= J11 / J12
  describe('J11 closing date exceptions', () => {
    it('records overrides for posts and voids, never for failed posts or normal dates', async () => {
      await withClosingDate('2026-02-28', async () => {
        const n0 = await auditCount('closing_date_exception');
        // Failing post (unknown account) under override → rolled back, no exception row.
        await expect(
          postJournalEntry({ ...ctx, closingDateOverride: true }, {
            date: d('2026-02-10'),
            description: 'Will fail',
            lines: [
              { accountId: acct['6300'], debit: '1.00' },
              { accountId: '00000000-0000-4000-8000-000000000000', credit: '1.00' },
            ],
          }),
        ).rejects.toBeTruthy();
        expect(await auditCount('closing_date_exception')).toBe(n0);
        // Override used but the date is open → not an exception.
        await createManualEntry({ ...ctx, closingDateOverride: true }, {
          date: d('2026-03-10'),
          description: 'Open-period post with password',
          lines: [
            { accountId: acct['6300'], debit: '1.00' },
            { accountId: acct['1000'], credit: '1.00' },
          ],
        });
        expect(await auditCount('closing_date_exception')).toBe(n0);
        // Void of a closed-period document with the password → recorded as 'void'.
        const vendor = (await createVendor(ctx, { displayName: 'Closed Period Vendor' })).id;
        const exp = await createExpense({ ...ctx, closingDateOverride: true }, {
          vendorId: vendor,
          date: d('2026-02-12'),
          method: 'check',
          paymentAccountId: acct['1000'],
          lines: [{ accountId: acct['6300'], amount: '7.00' }],
        });
        await expect(voidExpense(ctx, exp.id)).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
        await voidExpense({ ...ctx, closingDateOverride: true }, exp.id);
        const rep = await closingDateExceptionReport(ctx);
        const [entry] = await db.select().from(journalEntries).where(eq(journalEntries.sourceRef, `expense:${exp.id}`));
        const ops = rep.rows.filter((r) => r.entryId === entry.id).map((r) => r.operation).sort();
        expect(ops).toEqual(['post', 'void']);
        expect(rep.rows.every((r) => r.closingDate === '2026-02-28')).toBe(true);
      });
      await expectBalanced();
    });
  });

  describe('J12 voided/deleted report', () => {
    it('lists a voided bill with number, amount and vendor; date range excludes it', async () => {
      const vendor = (await createVendor(ctx, { displayName: 'Voided Bill Vendor' })).id;
      const bill = await createBill(ctx, { vendorId: vendor, billNumber: 'VB-1', date: d('2026-03-01'), lines: [{ accountId: acct['6300'], amount: '61.50' }] });
      const res = await batchVoidTransactions(ctx, [`bill:${bill.id}`]);
      expect(res.succeeded).toBe(1);
      const rep = await voidedDeletedTransactions(ctx);
      expect(rep.rows.find((r) => r.entityId === bill.id)).toMatchObject({ action: 'void', typeLabel: 'Bill', amount: '61.50', name: 'Voided Bill Vendor', number: 'VB-1' });
      const past = await voidedDeletedTransactions(ctx, { to: new Date('2000-01-01T00:00:00Z') });
      expect(past.rows.some((r) => r.entityId === bill.id)).toBe(false);
      await expectBalanced();
    });
  });

  // ======================================================================= permissions (service level)
  describe('cross-area permission escalation through the accountant tools', () => {
    const accountingOnly = (): EffectiveAccess => {
      const permissions = emptyPermissionSet();
      permissions.accounting = ['view', 'create', 'modify', 'delete', 'print'];
      return { roleKeys: ['qa-accounting-only'], permissions, flags: { sensitivePayroll: false, fullAccountNumbers: false, closedPeriod: false }, isAdmin: false };
    };

    it('a role with Sensitive Accounting but no Customers rights cannot create invoices via Batch Enter', async () => {
      const limited: ServiceContext = { ...ctx, access: accountingOnly() };
      const before = await db.select().from(invoices).where(eq(invoices.companyId, ctx.companyId));
      const res = await batchEnterTransactions(limited, {
        type: 'invoice',
        rows: [{ date: '2026-03-09', name: 'Exact Split Customer', account: '4100', amount: '10' }],
      }).catch((e: { code?: string }) => ({ saved: 0, code: e.code }));
      expect(res.saved).toBe(0);
      const after = await db.select().from(invoices).where(eq(invoices.companyId, ctx.companyId));
      expect(after.length).toBe(before.length);
    });

    it('a role with Sensitive Accounting but no Customers rights cannot void invoices via Batch Void', async () => {
      const cust = (await createCustomer(ctx, { displayName: 'Escalation Cust' })).id;
      const inv = await createInvoice(ctx, { customerId: cust, date: d('2026-03-25'), lines: [{ description: 'keep', quantity: 1, rate: '5' }] });
      const limited: ServiceContext = { ...ctx, access: accountingOnly() };
      await batchVoidTransactions(limited, [`invoice:${inv.id}`]).catch(() => null);
      const [i] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
      expect(i.status).not.toBe('void');
    });
  });
});
