/**
 * Regression tests for the reports fix package:
 *  - Year-end close no longer wipes closed-year P&L (P&L, P&L by class, budget vs actual).
 *  - Year-end close honors the company's configured fiscalYearEnd (settings, MM-DD).
 *  - Cash flow is classification-driven, ties to the cash accounts, and excludes
 *    closing entries (no net-income double count in financing).
 *  - A/R and A/P aging reconstruct balances as of the cutoff (payments after the
 *    cutoff ignored, documents after the cutoff excluded, unapplied credits netted).
 *  - General Ledger carries a beginning balance when a 'from' date is set and
 *    includes deactivated accounts with history.
 *  - Budget vs Actual: income/expense sectioned totals, favorability, balance-sheet
 *    lines skipped; by-class report includes unbudgeted actuals.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  accounts,
  billPaymentApplications,
  billPayments,
  bills,
  budgetLines,
  classes,
  companies,
  creditMemos,
  customers,
  invoices,
  paymentApplications,
  paymentsReceived,
  users,
  vendors,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import { balanceSheet, profitAndLoss, trialBalance } from './reports';
import { fiscalYearWindow, yearEndClose } from './fiscalClose';
import { generalLedger } from './journal';
import { apAging, arAging, cashFlow } from './reportsExtra';
import { budgetVsActual, createBudget, setBudgetLine } from './budgets';
import { budgetVsActualByClass, profitAndLossByClass } from './classReports';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-fixes-reports');
let db: DB;

async function makeCompany(
  slug: string,
  settings?: { fiscalYearEnd?: string },
): Promise<ServiceContext> {
  const [u] = await db
    .insert(users)
    .values({ email: `${slug}@fixes-reports.test.local`, name: slug, passwordHash: 'x' })
    .returning();
  const [c] = await db
    .insert(companies)
    .values({ name: `${slug} Co`, ownerId: u.id, settings: settings ?? null })
    .returning();
  return { db, companyId: c.id, userId: u.id };
}

type AcctMap = Record<string, string>;

async function seedAccounts(
  ctx: ServiceContext,
  defs: Array<[string, string, string, string]>,
): Promise<AcctMap> {
  const map: AcctMap = {};
  for (const [code, name, type, subtype] of defs) {
    const row = await createAccount(ctx, { code, name, type: type as never, subtype });
    map[code] = row.id;
  }
  return map;
}

beforeAll(async () => {
  db = await getDb(TEST_DIR);
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Year-end close: P&L history preserved + fiscal year end honored
// ---------------------------------------------------------------------------

describe('year-end close vs P&L reports', () => {
  let ctx: ServiceContext;
  let acct: AcctMap;
  let classId: string;

  beforeAll(async () => {
    ctx = await makeCompany('close-pl');
    acct = await seedAccounts(ctx, [
      ['1000', 'Checking', 'asset', 'checking'],
      ['3900', 'Retained Earnings', 'equity', 'retained_earnings'],
      ['4000', 'Sales', 'revenue', 'sales'],
      ['6000', 'Operating Expenses', 'expense', 'operating_expenses'],
    ]);
    const [cls] = await db
      .insert(classes)
      .values({ companyId: ctx.companyId, name: 'East' })
      .returning();
    classId = cls.id;

    await postJournalEntry(ctx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2024-04-01'),
      description: 'Revenue',
      lines: [
        { accountId: acct['1000'], debit: '8000.00' },
        { accountId: acct['4000'], credit: '8000.00', classId },
      ],
    });
    await postJournalEntry(ctx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2024-08-01'),
      description: 'Expense',
      lines: [
        { accountId: acct['6000'], debit: '3000.00' },
        { accountId: acct['1000'], credit: '3000.00' },
      ],
    });
  });

  it('closing the year does not zero the closed-year P&L', async () => {
    const result = await yearEndClose(ctx, { fiscalYear: 2024 });
    expect(result.netIncome).toBe('5000.00');

    const pl = await profitAndLoss(ctx, {
      from: new Date('2024-01-01T00:00:00.000Z'),
      to: new Date('2024-12-31T23:59:59.999Z'),
    });
    expect(pl.totalIncome).toBe('8000.00');
    expect(pl.totalExpenses).toBe('3000.00');
    expect(pl.netIncome).toBe('5000.00');
  });

  it('P&L by class is also unaffected by the closing entry', async () => {
    const byClass = await profitAndLossByClass(ctx, {
      from: new Date('2024-01-01T00:00:00.000Z'),
      to: new Date('2024-12-31T23:59:59.999Z'),
    });
    expect(byClass.netByClass[classId]).toBe('8000.00');
  });

  it('trial balance and balance sheet stay correct (no RE double count)', async () => {
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
    const reRow = tb.rows.find((r) => r.code === '3900');
    expect(reRow?.credit).toBe('5000.00');

    const bs = await balanceSheet(ctx);
    expect(bs.balanced).toBe(true);
    // Closing entry zeroed revenue/expense, so virtual RE is 0 and the real
    // Retained Earnings row carries the 5000 — not both.
    expect(bs.retainedEarnings).toBe('0.00');
    expect(bs.totalEquity).toBe('5000.00');
  });

  it('budget vs actual actuals are unchanged after the close', async () => {
    const budget = await createBudget(ctx, { name: 'FY2024', fiscalYear: 2024 });
    await setBudgetLine(ctx, {
      budgetId: budget.id,
      accountId: acct['4000'],
      month: 1,
      amount: '7000.00',
    });
    const report = await budgetVsActual(ctx, budget.id);
    const revRow = report.rows.find((r) => r.accountId === acct['4000']);
    expect(revRow?.actual).toBe('8000.00');
  });
});

describe('year-end close fiscal year end setting', () => {
  it('fiscalYearWindow defaults to the calendar year and clamps Feb 29', () => {
    const cal = fiscalYearWindow(2024, undefined);
    expect(cal.yearStart.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(cal.yearEnd.toISOString()).toBe('2025-01-01T00:00:00.000Z');
    expect(cal.closingDate.toISOString()).toBe('2024-12-31T23:59:59.000Z');

    const feb = fiscalYearWindow(2025, '02-29');
    expect(feb.closingDate.toISOString()).toBe('2025-02-28T23:59:59.000Z');
    expect(feb.yearEnd.toISOString()).toBe('2025-03-01T00:00:00.000Z');
  });

  it('uses the configured 06-30 year end for the close window and entry date', async () => {
    const ctx = await makeCompany('close-fye', { fiscalYearEnd: '06-30' });
    const acct = await seedAccounts(ctx, [
      ['1000', 'Checking', 'asset', 'checking'],
      ['3900', 'Retained Earnings', 'equity', 'retained_earnings'],
      ['4000', 'Sales', 'revenue', 'sales'],
    ]);

    // Inside FY2026 (2025-07-01 .. 2026-06-30).
    await postJournalEntry(ctx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2025-07-15'),
      description: 'In FY2026',
      lines: [
        { accountId: acct['1000'], debit: '1000.00' },
        { accountId: acct['4000'], credit: '1000.00' },
      ],
    });
    // After FY2026 — must be excluded.
    await postJournalEntry(ctx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2026-07-01'),
      description: 'In FY2027',
      lines: [
        { accountId: acct['1000'], debit: '999.00' },
        { accountId: acct['4000'], credit: '999.00' },
      ],
    });

    const result = await yearEndClose(ctx, { fiscalYear: 2026 });
    expect(result.totalRevenue).toBe('1000.00');
    expect(result.netIncome).toBe('1000.00');
    // Closing entry dated at the configured fiscal year end, not Dec 31.
    expect(result.entry.date.toISOString().slice(0, 10)).toBe('2026-06-30');
  });
});

// ---------------------------------------------------------------------------
// Cash flow ties to cash
// ---------------------------------------------------------------------------

describe('cash flow statement', () => {
  let ctx: ServiceContext;
  let acct: AcctMap;

  beforeAll(async () => {
    ctx = await makeCompany('cash-flow');
    acct = await seedAccounts(ctx, [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['1300', 'Inventory', 'asset', 'inventory'],
      ['1500', 'Fixed Assets', 'asset', 'fixed_assets'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['2100', 'Credit Card', 'liability', 'credit_card'],
      ['2700', 'Bank Loan', 'liability', 'long_term_liability'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['3900', 'Retained Earnings', 'equity', 'retained_earnings'],
      ['4000', 'Sales', 'revenue', 'sales'],
      ['6000', 'Operating Expenses', 'expense', 'operating_expenses'],
    ]);

    const post = (date: string, description: string, lines: { accountId: string; debit?: string; credit?: string }[]) =>
      postJournalEntry(ctx, { date: new Date(date), description, lines, allowUnnamedControl: true });

    await post('2024-02-01', 'Invoice', [
      { accountId: acct['1200'], debit: '1000.00' },
      { accountId: acct['4000'], credit: '1000.00' },
    ]);
    await post('2024-03-01', 'Receipt', [
      { accountId: acct['1000'], debit: '400.00' },
      { accountId: acct['1200'], credit: '400.00' },
    ]);
    await post('2024-04-01', 'Bill', [
      { accountId: acct['6000'], debit: '300.00' },
      { accountId: acct['2000'], credit: '300.00' },
    ]);
    await post('2024-05-01', 'CC expense', [
      { accountId: acct['6000'], debit: '100.00' },
      { accountId: acct['2100'], credit: '100.00' },
    ]);
    await post('2024-06-01', 'Loan draw', [
      { accountId: acct['1000'], debit: '5000.00' },
      { accountId: acct['2700'], credit: '5000.00' },
    ]);
    await post('2024-07-01', 'Buy equipment', [
      { accountId: acct['1500'], debit: '2000.00' },
      { accountId: acct['1000'], credit: '2000.00' },
    ]);
    await post('2024-08-01', 'Owner contribution', [
      { accountId: acct['1000'], debit: '1000.00' },
      { accountId: acct['3000'], credit: '1000.00' },
    ]);

    // Year-end close must NOT echo net income into financing.
    await yearEndClose(ctx, { fiscalYear: 2024 });
  });

  it('netCashChange equals the measured cash-account movement', async () => {
    const report = await cashFlow(ctx, {
      from: new Date('2024-01-01T00:00:00.000Z'),
      to: new Date('2024-12-31T23:59:59.999Z'),
    });

    expect(report.operating.netIncome).toBe('600.00'); // 1000 - 400
    expect(report.operating.changeInAR).toBe('-600.00'); // AR grew 600 → use of cash
    expect(report.operating.changeInAP).toBe('300.00');
    // Credit card is bucketed as an "other" operating liability change.
    const cc = report.operating.otherChanges.find((l) => l.accountId === acct['2100']);
    expect(cc?.amount).toBe('100.00');
    expect(report.operating.total).toBe('400.00');

    const fa = report.investing.lines.find((l) => l.accountId === acct['1500']);
    expect(fa?.amount).toBe('-2000.00');
    expect(report.investing.total).toBe('-2000.00');

    // Loan + owner contribution; the RE closing entry is excluded.
    expect(report.financing.total).toBe('6000.00');
    const loan = report.financing.lines.find((l) => l.accountId === acct['2700']);
    expect(loan?.amount).toBe('5000.00');
    expect(report.financing.lines.find((l) => l.accountId === acct['3900'])).toBeUndefined();

    expect(report.netCashChange).toBe('4400.00');
    expect(report.cashAccountsChange).toBe('4400.00'); // ties to cash by construction
  });
});

// ---------------------------------------------------------------------------
// A/R & A/P aging as of a past date
// ---------------------------------------------------------------------------

describe('aging as-of reconstruction', () => {
  let ctx: ServiceContext;
  let customerId: string;
  let vendorId: string;

  beforeAll(async () => {
    ctx = await makeCompany('aging');
    const [cust] = await db
      .insert(customers)
      .values({ companyId: ctx.companyId, displayName: 'Acme Customer' })
      .returning();
    customerId = cust.id;
    const [vend] = await db
      .insert(vendors)
      .values({ companyId: ctx.companyId, displayName: 'Acme Vendor' })
      .returning();
    vendorId = vend.id;

    // Invoice A: open at 2024-02-15, paid 2024-03-01.
    const [invA] = await db
      .insert(invoices)
      .values({
        companyId: ctx.companyId,
        customerId,
        invoiceNumber: 1,
        date: new Date('2024-01-01'),
        dueDate: new Date('2024-01-31'),
        total: '500.00',
        amountPaid: '500.00',
        balanceDue: '0.00',
        status: 'paid',
      })
      .returning();
    const [pay] = await db
      .insert(paymentsReceived)
      .values({
        companyId: ctx.companyId,
        customerId,
        date: new Date('2024-03-01'),
        amount: '500.00',
      })
      .returning();
    await db.insert(paymentApplications).values({
      paymentId: pay.id,
      invoiceId: invA.id,
      amountApplied: '500.00',
    });

    // Invoice B: dated after the cutoff — must be excluded from the backdated run.
    await db.insert(invoices).values({
      companyId: ctx.companyId,
      customerId,
      invoiceNumber: 2,
      date: new Date('2024-06-01'),
      total: '200.00',
      balanceDue: '200.00',
      status: 'open',
    });

    // Unapplied credit memo — nets receivables down.
    await db.insert(creditMemos).values({
      companyId: ctx.companyId,
      customerId,
      memoNumber: 1,
      date: new Date('2024-01-10'),
      total: '50.00',
      unapplied: '50.00',
      status: 'open',
    });

    // Bill A: open at 2024-02-15, paid 2024-03-01.
    const [billA] = await db
      .insert(bills)
      .values({
        companyId: ctx.companyId,
        vendorId,
        date: new Date('2024-01-01'),
        dueDate: new Date('2024-01-31'),
        total: '300.00',
        amountPaid: '300.00',
        balanceDue: '0.00',
        status: 'paid',
      })
      .returning();
    const [bp] = await db
      .insert(billPayments)
      .values({
        companyId: ctx.companyId,
        vendorId,
        date: new Date('2024-03-01'),
        amount: '300.00',
      })
      .returning();
    await db.insert(billPaymentApplications).values({
      billPaymentId: bp.id,
      billId: billA.id,
      amountApplied: '300.00',
    });

    // Bill B: dated after the cutoff.
    await db.insert(bills).values({
      companyId: ctx.companyId,
      vendorId,
      date: new Date('2024-06-01'),
      total: '100.00',
      balanceDue: '100.00',
      status: 'open',
    });
  });

  it('A/R aging as of a past date ignores later payments and later invoices', async () => {
    const report = await arAging(ctx, new Date('2024-02-15'));
    const row = report.rows.find((r) => r.id === customerId);
    expect(row).toBeDefined();
    // Invoice A was unpaid as of Feb 15 and 15 days past its Jan 31 due date.
    expect(row!.days1_30).toBe('500.00');
    // Invoice B (dated June) excluded; credit memo nets -50 in current.
    expect(row!.current).toBe('-50.00');
    expect(row!.total).toBe('450.00');
    expect(report.totals.total).toBe('450.00');
  });

  it('A/R aging today reflects the payment (invoice A gone, invoice B open)', async () => {
    const report = await arAging(ctx);
    const row = report.rows.find((r) => r.id === customerId);
    expect(row).toBeDefined();
    // 200 open invoice minus 50 unapplied credit memo.
    expect(row!.total).toBe('150.00');
  });

  it('A/P aging as of a past date mirrors the A/R behavior', async () => {
    const report = await apAging(ctx, new Date('2024-02-15'));
    const row = report.rows.find((r) => r.id === vendorId);
    expect(row).toBeDefined();
    expect(row!.days1_30).toBe('300.00');
    expect(row!.total).toBe('300.00');

    const today = await apAging(ctx);
    const todayRow = today.rows.find((r) => r.id === vendorId);
    expect(todayRow!.total).toBe('100.00'); // only bill B remains
  });
});

// ---------------------------------------------------------------------------
// General Ledger: beginning balance + deactivated accounts
// ---------------------------------------------------------------------------

describe('general ledger', () => {
  let ctx: ServiceContext;
  let acct: AcctMap;

  beforeAll(async () => {
    ctx = await makeCompany('gl');
    acct = await seedAccounts(ctx, [
      ['1000', 'Checking', 'asset', 'checking'],
      ['4000', 'Sales', 'revenue', 'sales'],
    ]);
    await postJournalEntry(ctx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2024-01-10'),
      description: 'Early sale',
      lines: [
        { accountId: acct['1000'], debit: '100.00' },
        { accountId: acct['4000'], credit: '100.00' },
      ],
    });
    await postJournalEntry(ctx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2024-05-10'),
      description: 'Later sale',
      lines: [
        { accountId: acct['1000'], debit: '50.00' },
        { accountId: acct['4000'], credit: '50.00' },
      ],
    });
  });

  it('seeds the running balance with the pre-from opening balance', async () => {
    const [gl] = await generalLedger(ctx, {
      accountId: acct['1000'],
      from: new Date('2024-03-01'),
    });
    expect(gl.openingBalance).toBe('100.00');
    expect(gl.lines).toHaveLength(1);
    expect(gl.lines[0].runningBalance).toBe('150.00');
    expect(gl.closingBalance).toBe('150.00');
  });

  it('reports a zero opening balance when no from filter is set', async () => {
    const [gl] = await generalLedger(ctx, { accountId: acct['1000'] });
    expect(gl.openingBalance).toBe('0.00');
    expect(gl.closingBalance).toBe('150.00');
  });

  it('includes deactivated accounts with history so the GL ties to the journal', async () => {
    await db
      .update(accounts)
      .set({ isActive: false })
      .where(eq(accounts.id, acct['4000']));

    // All-accounts report still carries the deactivated account's lines.
    const all = await generalLedger(ctx);
    const sales = all.find((r) => r.accountId === acct['4000']);
    expect(sales).toBeDefined();
    expect(sales!.isActive).toBe(false);
    expect(sales!.lines).toHaveLength(2);
    expect(sales!.closingBalance).toBe('150.00');

    // Direct request no longer throws NOT_FOUND for a deactivated account.
    const [direct] = await generalLedger(ctx, { accountId: acct['4000'] });
    expect(direct.closingBalance).toBe('150.00');

    // An inactive account with no activity stays out of the all-accounts view.
    const idle = await createAccount(ctx, {
      code: '9999',
      name: 'Idle',
      type: 'expense',
      subtype: 'operating_expenses',
    });
    await db.update(accounts).set({ isActive: false }).where(eq(accounts.id, idle.id));
    const all2 = await generalLedger(ctx);
    expect(all2.find((r) => r.accountId === idle.id)).toBeUndefined();

    // Restore for any later assertions.
    await db.update(accounts).set({ isActive: true }).where(eq(accounts.id, acct['4000']));
  });
});

// ---------------------------------------------------------------------------
// Budget vs Actual semantics + by-class unbudgeted actuals
// ---------------------------------------------------------------------------

describe('budget vs actual', () => {
  let ctx: ServiceContext;
  let acct: AcctMap;
  let classId: string;
  let budgetId: string;

  beforeAll(async () => {
    ctx = await makeCompany('budget');
    acct = await seedAccounts(ctx, [
      ['1000', 'Checking', 'asset', 'checking'],
      ['4000', 'Sales', 'revenue', 'sales'],
      ['6000', 'Operating Expenses', 'expense', 'operating_expenses'],
    ]);
    const [cls] = await db
      .insert(classes)
      .values({ companyId: ctx.companyId, name: 'West' })
      .returning();
    classId = cls.id;

    // Actuals: 150 revenue (classed), 40 expense (unclassified, unbudgeted).
    await postJournalEntry(ctx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2024-02-01'),
      description: 'Sale',
      lines: [
        { accountId: acct['1000'], debit: '150.00' },
        { accountId: acct['4000'], credit: '150.00', classId },
      ],
    });
    await postJournalEntry(ctx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2024-03-01'),
      description: 'Supplies',
      lines: [
        { accountId: acct['6000'], debit: '40.00' },
        { accountId: acct['1000'], credit: '40.00' },
      ],
    });

    const budget = await createBudget(ctx, { name: 'FY2024', fiscalYear: 2024 });
    budgetId = budget.id;
    await setBudgetLine(ctx, {
      budgetId,
      accountId: acct['4000'],
      month: 1,
      amount: '120.00',
    });
    // Legacy balance-sheet budget line (predates validation) — inserted directly.
    await db.insert(budgetLines).values({
      budgetId,
      accountId: acct['1000'],
      month: 1,
      amount: '999.00',
    });
  });

  it('setBudgetLine rejects balance-sheet accounts', async () => {
    await expect(
      setBudgetLine(ctx, { budgetId, accountId: acct['1000'], month: 2, amount: '10.00' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('sections income vs expense, orients favorability, and skips balance-sheet lines', async () => {
    const report = await budgetVsActual(ctx, budgetId);

    // The legacy cash budget line is skipped, not compared to zero.
    expect(report.rows.find((r) => r.accountId === acct['1000'])).toBeUndefined();

    const revRow = report.rows.find((r) => r.accountId === acct['4000']);
    expect(revRow).toBeDefined();
    expect(revRow!.accountType).toBe('revenue');
    expect(revRow!.budget).toBe('120.00');
    expect(revRow!.actual).toBe('150.00');
    expect(revRow!.variance).toBe('30.00');
    expect(revRow!.favorable).toBe(true); // over-target income is favorable

    expect(report.income.budget).toBe('120.00');
    expect(report.income.actual).toBe('150.00');
    // Net bottom line: no expense budget lines, so net == income section here.
    expect(report.netBudget).toBe('120.00');
    expect(report.netActual).toBe('150.00');
    expect(report.netVariance).toBe('30.00');
  });

  it('over-budget expense reads as unfavorable', async () => {
    await setBudgetLine(ctx, {
      budgetId,
      accountId: acct['6000'],
      month: 1,
      amount: '30.00',
    });
    const report = await budgetVsActual(ctx, budgetId);
    const expRow = report.rows.find((r) => r.accountId === acct['6000']);
    expect(expRow!.actual).toBe('40.00');
    expect(expRow!.variance).toBe('10.00'); // raw signed variance
    expect(expRow!.favorable).toBe(false); // over-budget expense is unfavorable
    expect(report.expense.budget).toBe('30.00');
    expect(report.expense.actual).toBe('40.00');
    expect(report.netBudget).toBe('90.00'); // 120 - 30
    expect(report.netActual).toBe('110.00'); // 150 - 40
  });

  it('by-class report includes actuals with no matching budget line', async () => {
    const report = await budgetVsActualByClass(ctx, budgetId);

    // Budgeted (unclassified) revenue line appears with zero actuals (the actual
    // activity was classed).
    const budgetedRow = report.rows.find(
      (r) => r.accountId === acct['4000'] && r.classId === '__unclassified__',
    );
    expect(budgetedRow).toBeDefined();
    expect(budgetedRow!.budget).toBe('120.00');
    expect(budgetedRow!.actual).toBe('0.00');

    // Actual-only (account, class) pairs are no longer dropped.
    const classedRevenue = report.rows.find(
      (r) => r.accountId === acct['4000'] && r.classId === classId,
    );
    expect(classedRevenue).toBeDefined();
    expect(classedRevenue!.budget).toBe('0.00');
    expect(classedRevenue!.actual).toBe('150.00');
    expect(classedRevenue!.className).toBe('West');

    const unbudgetedExpense = report.rows.find((r) => r.accountId === acct['6000']);
    expect(unbudgetedExpense).toBeDefined();
    expect(unbudgetedExpense!.actual).toBe('40.00');

    // Legacy balance-sheet budget line skipped here too.
    expect(report.rows.find((r) => r.accountId === acct['1000'])).toBeUndefined();

    // Sectioned totals capture ALL actual P&L activity.
    expect(report.income.actual).toBe('150.00');
    expect(report.expense.actual).toBe('40.00');
    expect(report.totalActual).toBe('110.00'); // net income - expense
  });
});
