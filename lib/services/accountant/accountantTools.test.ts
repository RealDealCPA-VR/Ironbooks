/**
 * Accountant tools (wave2 accountant): Reclassify (I3), Write Off Invoices (I4), Batch Enter (I5),
 * Batch Void (I6), Working Trial Balance (I8), Review List Changes (I10), Accountant Center (I12),
 * Client Data Review (I13), Closing Date Exceptions (J11) and Voided/Deleted reports (J12).
 * Every mutation must keep the trial balance balanced.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, auditLogs, expenseLines, invoices, journalEntryLines, users } from '@/lib/db/schema';
import type { ServiceContext } from '../_base';
import { createCompany, setClosingDate } from '../company';
import { createAccount, updateAccount } from '../accounts';
import { createCustomer } from '../customers';
import { createVendor } from '../vendors';
import { createClass } from '../dimensions';
import { createInvoice } from '../invoices';
import { createExpense } from '../expenses';
import { createCreditMemo } from '../creditMemos';
import { receivePayment } from '../payments';
import { createManualEntry } from '../journal';
import { createBankAccount } from '../bankAccounts';
import { trialBalance } from '../reports';
import { listReclassifyLines, reclassifyLines } from './reclassify';
import { listWriteOffCandidates, writeOffInvoices } from './writeOff';
import { batchEnterTransactions } from './batchEnter';
import { normalizeAmount, normalizeDate, parseBatchPaste } from './batchEnterParse';
import { batchVoidTransactions, listBatchTransactions } from './batchVoid';
import { postAdjustingEntry, saveWtbNote, workingTrialBalance } from './workingTrialBalance';
import { listListChanges, markListChangesReviewed } from './listChanges';
import { accountantCenterSummary } from './accountantCenter';
import {
  autoApplyCustomerCredit,
  clientDataReview,
  setReviewTaskStatus,
  takeReviewSnapshot,
} from './clientDataReview';
import { closingDateExceptionReport, voidedDeletedTransactions } from './auditReports';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-accountant-tools');
let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
let customerId: string;
let vendorId: string;

const d = (s: string) => new Date(`${s}T12:00:00.000Z`);

async function expectBalanced() {
  const tb = await trialBalance(ctx);
  expect(tb.balanced).toBe(true);
  expect(tb.totalDebit).toBe(tb.totalCredit);
}

describe('accountant tools', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'acct-tools@test.local', name: 'Accountant', passwordHash: 'x' })
      .returning();
    const company = await createCompany(db, { name: 'Accountant Tools Co', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    const all = await db.select().from(accounts).where(eq(accounts.companyId, company.id));
    for (const a of all) acct[a.code] = a.id;
    acct['6800'] = (await createAccount(ctx, { code: '6800', name: 'Bad Debt', type: 'expense' as never, subtype: 'operating_expenses' })).id;
    customerId = (await createCustomer(ctx, { displayName: 'Slow Payer' })).id;
    vendorId = (await createVendor(ctx, { displayName: 'Office Depot' })).id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------- I3 Reclassify
  describe('Reclassify Transactions', () => {
    it('moves selected lines to another account and class in place, keeping the books balanced', async () => {
      const cls = await createClass(ctx, { name: 'East' });
      const exp = await createExpense(ctx, {
        vendorId,
        date: d('2026-02-01'),
        method: 'check',
        paymentAccountId: acct['1000'],
        lines: [{ accountId: acct['6000'], amount: '120.00', description: 'Paper (miscoded)' }],
      });
      const before = await trialBalance(ctx);
      const { lines } = await listReclassifyLines(ctx, { accountId: acct['6000'], from: d('2026-02-01'), to: d('2026-02-28') });
      expect(lines).toHaveLength(1);
      expect(lines[0].sourceType).toBe('Check / Expense');

      const res = await reclassifyLines(ctx, { lineIds: [lines[0].lineId], newAccountId: acct['6300'], newClassId: cls.id });
      expect(res).toMatchObject({ linesChanged: 1, entriesChanged: 1, documentsUpdated: 1 });

      const [line] = await db.select().from(journalEntryLines).where(eq(journalEntryLines.id, lines[0].lineId));
      expect(line.accountId).toBe(acct['6300']);
      expect(line.classId).toBe(cls.id);
      expect(line.debit).toBe('120.00');
      // Source document follows (a later edit re-posts to the new account).
      const [docLine] = await db.select().from(expenseLines).where(eq(expenseLines.expenseId, exp.id));
      expect(docLine.accountId).toBe(acct['6300']);
      // Balances moved via the ledger triggers; totals unchanged.
      const after = await trialBalance(ctx);
      expect(after.totalDebit).toBe(before.totalDebit);
      const [a6300] = await db.select().from(accounts).where(eq(accounts.id, acct['6300']));
      const [a6000] = await db.select().from(accounts).where(eq(accounts.id, acct['6000']));
      expect(a6300.balance).toBe('120.00');
      expect(a6000.balance).toBe('0.00');
      await expectBalanced();
      // Audited.
      const logs = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityType, 'journal_entry'), eq(auditLogs.action, 'update')));
      expect(logs.some((l) => JSON.stringify(l.newValues).includes('reclassify'))).toBe(true);
    });

    it('refuses control accounts (bank / A/R / sales tax) as source or target', async () => {
      const { lines } = await listReclassifyLines(ctx, { accountId: acct['1000'] });
      expect(lines.length).toBeGreaterThan(0);
      await expect(reclassifyLines(ctx, { lineIds: [lines[0].lineId], newAccountId: acct['6300'] })).rejects.toMatchObject({ code: 'VALIDATION' });
      const { lines: exp } = await listReclassifyLines(ctx, { accountId: acct['6300'] });
      await expect(reclassifyLines(ctx, { lineIds: [exp[0].lineId], newAccountId: acct['1200'] })).rejects.toMatchObject({ code: 'VALIDATION' });
    });

    it('respects the closing date and records the override as a closing-date exception', async () => {
      const je = await createManualEntry(ctx, {
        date: d('2026-01-15'),
        description: 'January rent (miscoded)',
        lines: [
          { accountId: acct['6600'], debit: '900.00' },
          { accountId: acct['1000'], credit: '900.00' },
        ],
      });
      await setClosingDate(ctx, { closingDate: '2026-01-31', password: 'close' });
      const { lines } = await listReclassifyLines(ctx, { accountId: acct['6600'] });
      const lineId = lines.find((l) => l.entryId === je.id)!.lineId;
      await expect(reclassifyLines(ctx, { lineIds: [lineId], newAccountId: acct['6400'] })).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
      await reclassifyLines({ ...ctx, closingDateOverride: true }, { lineIds: [lineId], newAccountId: acct['6400'] });
      const report = await closingDateExceptionReport(ctx);
      expect(report.closingDate).toBe('2026-01-31');
      expect(report.rows.some((r) => r.entryId === je.id && r.operation === 'reclassify' && r.source === 'override')).toBe(true);

      // A posting with the override is recorded too; a normal posting after the date is not.
      const backdated = await createManualEntry({ ...ctx, closingDateOverride: true }, {
        date: d('2026-01-20'),
        description: 'Late accrual',
        lines: [
          { accountId: acct['6300'], debit: '15.00' },
          { accountId: acct['2000'], credit: '15.00', entityType: 'vendor', entityId: vendorId },
        ],
      });
      const r2 = await closingDateExceptionReport(ctx);
      expect(r2.rows.some((r) => r.entryId === backdated.id && r.operation === 'post' && r.amount === '15.00')).toBe(true);
      const current = await createManualEntry(ctx, {
        date: d('2026-02-20'),
        description: 'Current',
        lines: [
          { accountId: acct['6300'], debit: '1.00' },
          { accountId: acct['1000'], credit: '1.00' },
        ],
      });
      const r3 = await closingDateExceptionReport(ctx);
      expect(r3.rows.some((r) => r.entryId === current.id)).toBe(false);
      await setClosingDate(ctx, { closingDate: null });
      await expectBalanced();
    });
  });

  // ---------------------------------------------------------------- I4 Write off
  describe('Write Off Invoices', () => {
    it('writes open balances off to bad debt through a credit memo, all or nothing', async () => {
      const inv1 = await createInvoice(ctx, { customerId, date: d('2025-06-01'), dueDate: d('2025-07-01'), lines: [{ description: 'Old work', quantity: 1, rate: '300' }] });
      const inv2 = await createInvoice(ctx, { customerId, date: d('2025-06-15'), dueDate: d('2025-07-15'), lines: [{ description: 'More old work', quantity: 1, rate: '75.50' }] });
      await receivePayment(ctx, { customerId, date: d('2025-08-01'), method: 'check', amount: '100', applications: [{ invoiceId: inv1.id, amountApplied: '100' }] });

      const cands = await listWriteOffCandidates(ctx, { asOf: d('2026-03-01'), minDaysPastDue: 90 });
      expect(cands.map((c) => c.invoiceId).sort()).toEqual([inv1.id, inv2.id].sort());
      expect(cands.find((c) => c.invoiceId === inv1.id)!.balanceDue).toBe('200.00');

      // A non-expense account is refused.
      await expect(writeOffInvoices(ctx, { invoiceIds: [inv1.id], date: d('2026-03-01'), badDebtAccountId: acct['4000'] })).rejects.toMatchObject({ code: 'VALIDATION' });

      const res = await writeOffInvoices(ctx, { invoiceIds: [inv1.id, inv2.id], date: d('2026-03-01'), badDebtAccountId: acct['6800'] });
      expect(res.total).toBe('275.50');
      const rows = await db.select().from(invoices).where(eq(invoices.customerId, customerId));
      for (const r of rows.filter((x) => [inv1.id, inv2.id].includes(x.id))) {
        expect(r.balanceDue).toBe('0.00');
        expect(r.status).toBe('paid');
      }
      const [bad] = await db.select().from(accounts).where(eq(accounts.id, acct['6800']));
      expect(bad.balance).toBe('275.50');
      await expectBalanced();
      // Already written off → nothing left to write off.
      await expect(writeOffInvoices(ctx, { invoiceIds: [inv2.id], date: d('2026-03-02'), badDebtAccountId: acct['6800'] })).rejects.toMatchObject({ code: 'CONFLICT' });
    });
  });

  // ---------------------------------------------------------------- I5 Batch enter
  describe('Batch Enter Transactions', () => {
    it('parses spreadsheet paste, amounts and dates', () => {
      const rows = parseBatchPaste('Date\tRef\tName\tAccount\tAmount\tMemo\n3/5/2026\t1001\tOffice Depot\t6300\t$1,234.50\tToner\n', 'check');
      expect(rows).toEqual([{ date: '3/5/2026', ref: '1001', name: 'Office Depot', account: '6300', amount: '$1,234.50', memo: 'Toner' }]);
      expect(normalizeAmount('(12.50)')).toBe('-12.50');
      expect(normalizeAmount('1,234.5')).toBe('1234.5');
      expect(normalizeAmount('abc')).toBeNull();
      expect(normalizeDate('3/5/2026')).toBe('2026-03-05');
      expect(normalizeDate('2026-02-30')).toBeNull();
      expect(normalizeDate('46000')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("'all' mode is all-or-nothing and reports every bad row", async () => {
      const tbBefore = await trialBalance(ctx);
      const res = await batchEnterTransactions(ctx, {
        type: 'check',
        bankAccountId: acct['1000'],
        mode: 'all',
        rows: [
          { date: '2026-03-05', ref: '2001', name: 'Office Depot', account: '6300', amount: '45.00', memo: 'Paper' },
          { date: '2026-03-06', ref: '2002', name: 'Utility Co', account: 'Nope', amount: '10' },
          { date: 'not a date', name: 'Someone', account: '6600', amount: '5' },
        ],
      });
      expect(res.rolledBack).toBe(true);
      expect(res.saved).toBe(0);
      expect(res.failed).toBe(2);
      expect(res.results[1].errors[0]).toMatch(/account "Nope" was not found/);
      const tbAfter = await trialBalance(ctx);
      expect(tbAfter.totalDebit).toBe(tbBefore.totalDebit);
    });

    it('saves checks, deposits, bills, invoices and journal entries through the normal services', async () => {
      const checks = await batchEnterTransactions(ctx, {
        type: 'check',
        bankAccountId: acct['1000'],
        rows: [
          { date: '2026-03-05', ref: '2001', name: 'Office Depot', account: '6300 · Office Supplies', amount: '45.00', memo: 'Paper' },
          { date: '2026-03-06', ref: '2002', name: 'Walk-in Payee', account: 'Utilities', amount: '$1,010.10' },
        ],
      });
      expect(checks).toMatchObject({ saved: 2, failed: 0, rolledBack: false });

      const deposits = await batchEnterTransactions(ctx, {
        type: 'deposit',
        bankAccountId: acct['1000'],
        rows: [{ date: '2026-03-07', name: 'Owner', account: '3000', amount: '5000' }],
      });
      expect(deposits.saved).toBe(1);

      const bills = await batchEnterTransactions(ctx, {
        type: 'bill',
        rows: [{ date: '2026-03-08', ref: 'B-77', name: 'Office Depot', account: '6300', amount: '99.99', dueDate: '2026-04-07' }],
      });
      expect(bills.saved).toBe(1);

      const invs = await batchEnterTransactions(ctx, {
        type: 'invoice',
        rows: [
          { date: '2026-03-09', name: 'Slow Payer', account: '4100', amount: '250' },
          { date: '2026-03-09', name: 'Unknown Customer', account: '4100', amount: '1' },
        ],
        mode: 'row',
      });
      expect(invs.saved).toBe(1);
      expect(invs.failed).toBe(1);
      expect(invs.results[1].errors[0]).toMatch(/customer "Unknown Customer" was not found/);

      const jes = await batchEnterTransactions(ctx, {
        type: 'journal',
        rows: [
          { date: '2026-03-10', ref: 'J1', account: '6600', debit: '10', memo: 'Accrual' },
          { date: '', ref: '', name: 'Office Depot', account: '2000', credit: '10' },
          { date: '2026-03-11', ref: 'J2', account: '6300', debit: '5' },
          { date: '2026-03-11', ref: 'J2', account: '1000', credit: '4' },
        ],
        mode: 'row',
      });
      expect(jes.saved).toBe(1);
      expect(jes.failed).toBe(1);
      expect(jes.results[1].errors.join(' ')).toMatch(/must be equal/);
      await expectBalanced();
    });

    it("'all' mode rolls back rows that saved when a later row fails in the service (closed period)", async () => {
      await setClosingDate(ctx, { closingDate: '2026-01-31' });
      const tbBefore = await trialBalance(ctx);
      const res = await batchEnterTransactions(ctx, {
        type: 'check',
        bankAccountId: acct['1000'],
        rows: [
          { date: '2026-03-20', name: 'Office Depot', account: '6300', amount: '11.00' },
          { date: '2026-01-20', name: 'Office Depot', account: '6300', amount: '12.00' },
          { date: '2026-03-21', name: 'Office Depot', account: '6300', amount: '13.00' },
        ],
      });
      expect(res.rolledBack).toBe(true);
      expect(res.failed).toBe(1);
      expect(res.results[1].errors[0]).toMatch(/closed/i);
      expect(res.results[2].ok).toBe(true); // validated after the failure (savepoint per row)
      const tbAfter = await trialBalance(ctx);
      expect(tbAfter.totalDebit).toBe(tbBefore.totalDebit);
      await setClosingDate(ctx, { closingDate: null });
    });

    it('validateOnly runs the services but never saves', async () => {
      const tbBefore = await trialBalance(ctx);
      const res = await batchEnterTransactions(ctx, {
        type: 'cc_charge',
        bankAccountId: acct['2100'],
        validateOnly: true,
        rows: [{ date: '2026-03-12', name: 'Office Depot', account: '6300', amount: '12.34' }],
      });
      expect(res.rolledBack).toBe(true);
      expect(res.failed).toBe(0);
      const tbAfter = await trialBalance(ctx);
      expect(tbAfter.totalDebit).toBe(tbBefore.totalDebit);
    });
  });

  // ---------------------------------------------------------------- I6 Batch void
  describe('Batch Delete/Void', () => {
    it('voids row by row and reports dependent-link refusals', async () => {
      const paid = await createInvoice(ctx, { customerId, date: d('2026-03-15'), lines: [{ description: 'Paid', quantity: 1, rate: '40' }] });
      await receivePayment(ctx, { customerId, date: d('2026-03-16'), method: 'cash', amount: '40', applications: [{ invoiceId: paid.id, amountApplied: '40' }] });
      const free = await createInvoice(ctx, { customerId, date: d('2026-03-15'), lines: [{ description: 'Mistake', quantity: 1, rate: '60' }] });
      const list = await listBatchTransactions(ctx, { from: d('2026-03-15'), to: d('2026-03-15'), type: 'invoice' });
      expect(list.map((r) => r.docId).sort()).toEqual([paid.id, free.id].sort());

      const res = await batchVoidTransactions(ctx, [`invoice:${paid.id}`, `invoice:${free.id}`]);
      expect(res.succeeded).toBe(1);
      expect(res.failed).toBe(1);
      expect(res.results.find((r) => r.key === `invoice:${paid.id}`)!.error).toMatch(/payments/i);
      const [f] = await db.select().from(invoices).where(eq(invoices.id, free.id));
      expect(f.status).toBe('void');
      await expectBalanced();

      const voided = await voidedDeletedTransactions(ctx, { detail: true });
      const row = voided.rows.find((r) => r.entityId === free.id)!;
      expect(row).toMatchObject({ action: 'void', typeLabel: 'Invoice', amount: '60.00', name: 'Slow Payer' });
      expect(row.original).toBeDefined();
    });
  });

  // ---------------------------------------------------------------- I8 WTB
  describe('Working Trial Balance', () => {
    it('beginning + transactions + adjustments = ending, columns sum to zero, notes persist', async () => {
      await postAdjustingEntry(ctx, {
        date: d('2026-03-31'),
        description: 'Year-end accrual',
        lines: [
          { accountId: acct['6600'], debit: '33.00' },
          { accountId: acct['2000'], credit: '33.00', entityType: 'vendor', entityId: vendorId },
        ],
      });
      const wtb = await workingTrialBalance(ctx, { from: new Date('2026-03-01T00:00:00Z'), to: new Date('2026-03-31T23:59:59.999Z') });
      expect(wtb.balanced).toBe(true);
      const util = wtb.rows.find((r) => r.accountId === acct['6600'])!;
      expect(util.adjustments).toBe('33.00');
      expect(Number(util.ending)).toBeCloseTo(Number(util.beginning) + Number(util.transactions) + Number(util.adjustments), 2);
      await saveWtbNote(ctx, { accountId: acct['6600'], periodEnd: '2026-03-31', workpaperRef: 'W-12', note: 'Agreed to invoice' });
      const again = await workingTrialBalance(ctx, { from: new Date('2026-03-01T00:00:00Z'), to: new Date('2026-03-31T23:59:59.999Z') });
      expect(again.rows.find((r) => r.accountId === acct['6600'])).toMatchObject({ workpaperRef: 'W-12', note: 'Agreed to invoice' });
      await expectBalanced();
    });
  });

  // ---------------------------------------------------------------- I10 list changes
  describe('Review List Changes', () => {
    it('lists account / customer changes with changed fields and marks them reviewed', async () => {
      // audit_logs.created_at is a timestamp without time zone (DB clock) — use a generous window.
      const since = new Date(Date.now() - 2 * 86_400_000);
      await updateAccount(ctx, acct['6800'], { name: 'Bad Debt Expense' });
      const r1 = await listListChanges(ctx, { since });
      const change = r1.rows.find((r) => r.entityType === 'account' && r.entityId === acct['6800'])!;
      expect(change).toBeDefined();
      expect(change.changedFields).toContain('name');
      expect(r1.unreviewed).toBeGreaterThan(0);
      await markListChangesReviewed(ctx, { auditLogIds: [change.auditLogId], reviewed: true });
      const r2 = await listListChanges(ctx, { since });
      expect(r2.rows.find((r) => r.auditLogId === change.auditLogId)).toBeUndefined();
      const r3 = await listListChanges(ctx, { since, includeReviewed: true });
      expect(r3.rows.find((r) => r.auditLogId === change.auditLogId)!.reviewed).toBe(true);
    });
  });

  // ---------------------------------------------------------------- I13 Client data review + I12 center
  describe('Client Data Review', () => {
    it('finds unapplied customer credits and applies them oldest-first', async () => {
      const inv = await createInvoice(ctx, { customerId, date: d('2026-04-01'), lines: [{ description: 'April', quantity: 1, rate: '80' }] });
      const memo = await createCreditMemo(ctx, { customerId, date: d('2026-04-02'), lines: [{ description: 'Credit', quantity: 1, rate: '30', taxable: false }] });
      const review = await clientDataReview(ctx);
      const task = review.tasks.find((t) => t.key === 'unapplied_customer_credits')!;
      const issue = task.issues.find((i) => i.id === `credit_memo:${memo.id}`)!;
      expect(issue.fix).toMatchObject({ kind: 'apply_customer_credit', refType: 'credit_memo' });
      const res = await autoApplyCustomerCredit(ctx, { refType: 'credit_memo', refId: memo.id });
      expect(res.applied).toBe('30.00');
      const [i2] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
      expect(Number(i2.balanceDue)).toBeLessThanOrEqual(80);
      await expectBalanced();
    });

    it('compares balances with the last review and lists the late entries behind changes', async () => {
      await takeReviewSnapshot(ctx, { asOf: '2026-04-30' });
      let review = await clientDataReview(ctx);
      expect(review.tasks.find((t) => t.key === 'compare_balances')!.issues).toHaveLength(0);
      const late = await createManualEntry(ctx, {
        date: d('2026-04-10'),
        description: 'Backdated after review',
        lines: [
          { accountId: acct['6300'], debit: '7.00' },
          { accountId: acct['1000'], credit: '7.00' },
        ],
      });
      review = await clientDataReview(ctx);
      const cmp = review.tasks.find((t) => t.key === 'compare_balances')!;
      expect(cmp.issues.map((i) => i.id).sort()).toEqual([`acct:${acct['1000']}`, `acct:${acct['6300']}`].sort());
      const prior = review.tasks.find((t) => t.key === 'prior_balances')!;
      expect(prior.issues.some((i) => i.id === `je:${late.id}`)).toBe(true);
      await setReviewTaskStatus(ctx, { taskKey: 'compare_balances', status: 'completed' });
      review = await clientDataReview(ctx);
      expect(review.tasks.find((t) => t.key === 'compare_balances')!.status).toBe('completed');
      expect(review.lastReview?.asOf).toBe('2026-04-30');
    });

    it('flags payroll liabilities paid by check instead of Pay Liabilities', async () => {
      await createExpense(ctx, {
        payeeName: 'IRS',
        date: d('2026-04-20'),
        method: 'check',
        paymentAccountId: acct['1000'],
        lines: [{ accountId: acct['2300'], amount: '250.00' }],
      });
      const review = await clientDataReview(ctx);
      expect(review.tasks.find((t) => t.key === 'payroll_liabilities')!.issues).toHaveLength(1);
    });

    it('Accountant Center summarizes reconciliation status, closing date and reviews', async () => {
      await createBankAccount(ctx, { accountId: acct['1000'], bankName: 'First Bank', accountNumber: '123456789' });
      const s = await accountantCenterSummary(ctx);
      expect(s.reconciliationStatus).toHaveLength(1);
      expect(s.reconciliationStatus[0].lastReconciledDate).toBeNull();
      expect(s.lastReview?.asOf).toBe('2026-04-30');
      expect(typeof s.unreviewedListChanges).toBe('number');
      await expectBalanced();
    });
  });
});
