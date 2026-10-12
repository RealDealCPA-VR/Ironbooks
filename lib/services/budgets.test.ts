/**
 * Integration tests for the budgets service.
 *
 * Uses a throwaway PGlite data directory so it never touches production data.
 * Seeds the minimum schema objects (user, company, accounts) then exercises:
 *  - createBudget / listBudgets
 *  - setBudgetLine (upsert)
 *  - getBudget with lines
 *  - budgetVsActual with real actuals posted via journal entries
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, companies, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { ServiceError } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import {
  createBudget,
  listBudgets,
  getBudget,
  setBudgetLine,
  budgetVsActual,
} from './budgets';

// Unique dir so parallel test runs never clash.
const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-budgets-svc-7f4a2e');
let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};

describe('Budgets service', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'budget-owner@test.local', name: 'Budget Owner', passwordHash: 'x' })
      .returning();

    const [company] = await db
      .insert(companies)
      .values({ name: 'Budget Test Co', ownerId: user.id })
      .returning();

    ctx = { db, companyId: company.id, userId: user.id };

    // Seed accounts: cash (asset), AR (asset), revenue, and expense.
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Cash', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['4000', 'Services Revenue', 'revenue', 'sales'],
      ['5000', 'Rent Expense', 'expense', 'operating_expenses'],
      ['5100', 'Office Supplies', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // createBudget / listBudgets
  // ---------------------------------------------------------------------------

  it('creates a budget and it appears in listBudgets', async () => {
    const budget = await createBudget(ctx, { name: 'FY2025 Annual', fiscalYear: 2025 });
    expect(budget.id).toBeTruthy();
    expect(budget.name).toBe('FY2025 Annual');
    expect(budget.fiscalYear).toBe(2025);

    const list = await listBudgets(ctx);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.some((b) => b.id === budget.id)).toBe(true);
  });

  it('rejects invalid budget input', async () => {
    await expect(createBudget(ctx, { name: '', fiscalYear: 2025 })).rejects.toBeInstanceOf(ServiceError);
    await expect(createBudget(ctx, { name: 'Bad Year', fiscalYear: 1999 })).rejects.toBeInstanceOf(ServiceError);
    await expect(createBudget(ctx, { name: 'Bad Year', fiscalYear: 2101 })).rejects.toBeInstanceOf(ServiceError);
  });

  // ---------------------------------------------------------------------------
  // setBudgetLine / getBudget with lines
  // ---------------------------------------------------------------------------

  it('sets budget lines and retrieves them via getBudget', async () => {
    const budget = await createBudget(ctx, { name: 'FY2025 Monthly Detail', fiscalYear: 2025 });

    // Set revenue budget: $10,000 for month 1, $12,000 for month 2.
    await setBudgetLine(ctx, {
      budgetId: budget.id,
      accountId: acct['4000'],
      month: 1,
      amount: '10000.00',
    });
    await setBudgetLine(ctx, {
      budgetId: budget.id,
      accountId: acct['4000'],
      month: 2,
      amount: '12000.00',
    });

    // Set expense budget: $1,200 for month 1.
    await setBudgetLine(ctx, {
      budgetId: budget.id,
      accountId: acct['5000'],
      month: 1,
      amount: '1200.00',
    });

    const full = await getBudget(ctx, budget.id);
    expect(full.lines.length).toBe(3);

    const revLines = full.lines.filter((l) => l.accountId === acct['4000']);
    expect(revLines).toHaveLength(2);
    expect(revLines.map((l) => l.amount).sort()).toEqual(['10000.00', '12000.00'].sort());

    const expLines = full.lines.filter((l) => l.accountId === acct['5000']);
    expect(expLines).toHaveLength(1);
    expect(expLines[0].amount).toBe('1200.00');
  });

  it('upserts a budget line (updates existing month)', async () => {
    const budget = await createBudget(ctx, { name: 'FY2025 Upsert Test', fiscalYear: 2025 });

    await setBudgetLine(ctx, {
      budgetId: budget.id,
      accountId: acct['5100'],
      month: 3,
      amount: '500.00',
    });

    // Now update the same line.
    await setBudgetLine(ctx, {
      budgetId: budget.id,
      accountId: acct['5100'],
      month: 3,
      amount: '750.00',
    });

    const full = await getBudget(ctx, budget.id);
    const lines = full.lines.filter((l) => l.accountId === acct['5100'] && l.month === 3);
    expect(lines).toHaveLength(1); // not duplicated
    expect(lines[0].amount).toBe('750.00');
  });

  it('rejects setBudgetLine with invalid month', async () => {
    const budget = await createBudget(ctx, { name: 'FY2025 Bad Month', fiscalYear: 2025 });
    await expect(
      setBudgetLine(ctx, { budgetId: budget.id, accountId: acct['5000'], month: 0, amount: '100.00' }),
    ).rejects.toBeInstanceOf(ServiceError);
    await expect(
      setBudgetLine(ctx, { budgetId: budget.id, accountId: acct['5000'], month: 13, amount: '100.00' }),
    ).rejects.toBeInstanceOf(ServiceError);
  });

  // ---------------------------------------------------------------------------
  // budgetVsActual — with real GL postings
  // ---------------------------------------------------------------------------

  it('budgetVsActual returns correct variance after posting actuals', async () => {
    const budget = await createBudget(ctx, { name: 'FY2025 vs Actual', fiscalYear: 2025 });

    // Budget: $15,000 revenue, $2,000 rent.
    await setBudgetLine(ctx, {
      budgetId: budget.id,
      accountId: acct['4000'],
      month: 1,
      amount: '15000.00',
    });
    await setBudgetLine(ctx, {
      budgetId: budget.id,
      accountId: acct['5000'],
      month: 1,
      amount: '2000.00',
    });

    // Post actual journal entries for FY2025.
    // Revenue: $18,000 credit to revenue, debit AR.
    await postJournalEntry(ctx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2025-03-15'),
      description: 'Service invoice',
      lines: [
        { accountId: acct['1200'], debit: '18000.00' },
        { accountId: acct['4000'], credit: '18000.00' },
      ],
    });

    // Rent expense: $1,800 debit to rent, credit cash.
    await postJournalEntry(ctx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2025-03-01'),
      description: 'March rent',
      lines: [
        { accountId: acct['5000'], debit: '1800.00' },
        { accountId: acct['1000'], credit: '1800.00' },
      ],
    });

    const report = await budgetVsActual(ctx, budget.id);

    expect(report.budgetName).toBe('FY2025 vs Actual');
    expect(report.fiscalYear).toBe(2025);

    const revRow = report.rows.find((r) => r.accountId === acct['4000']);
    expect(revRow).toBeDefined();
    expect(revRow!.budget).toBe('15000.00');
    // Actual revenue = 18000 (credit-normal, so amount is positive from P&L)
    expect(revRow!.actual).toBe('18000.00');
    // Variance = actual - budget = 18000 - 15000 = 3000 (favorable: over target income)
    expect(revRow!.variance).toBe('3000.00');
    expect(revRow!.accountType).toBe('revenue');
    expect(revRow!.favorable).toBe(true);

    const rentRow = report.rows.find((r) => r.accountId === acct['5000']);
    expect(rentRow).toBeDefined();
    expect(rentRow!.budget).toBe('2000.00');
    // Actual rent = 1800 (debit-normal expense)
    expect(rentRow!.actual).toBe('1800.00');
    // Variance = 1800 - 2000 = -200 (under budget on expenses → favorable)
    expect(rentRow!.variance).toBe('-200.00');
    expect(rentRow!.accountType).toBe('expense');
    expect(rentRow!.favorable).toBe(true);

    // Sectioned totals — income and expenses are no longer mixed into one sum.
    expect(report.income.budget).toBe('15000.00');
    expect(report.income.actual).toBe('18000.00');
    expect(report.income.variance).toBe('3000.00');
    expect(report.expense.budget).toBe('2000.00');
    expect(report.expense.actual).toBe('1800.00');
    expect(report.expense.variance).toBe('-200.00');

    // Net bottom line (income - expense); legacy total fields carry the same.
    expect(report.netBudget).toBe('13000.00');
    expect(report.netActual).toBe('16200.00');
    expect(report.netVariance).toBe('3200.00');
    expect(report.totalBudget).toBe('13000.00');
    expect(report.totalActual).toBe('16200.00');
    expect(report.totalVariance).toBe('3200.00');
  });

  it('budgetVsActual returns empty rows for a budget with no lines', async () => {
    const budget = await createBudget(ctx, { name: 'FY2025 Empty', fiscalYear: 2025 });
    const report = await budgetVsActual(ctx, budget.id);
    expect(report.rows).toHaveLength(0);
    expect(report.totalBudget).toBe('0.00');
  });

  it('budgetVsActual throws NOT_FOUND for unknown budget', async () => {
    await expect(
      budgetVsActual(ctx, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('getBudget throws NOT_FOUND for unknown id', async () => {
    await expect(
      getBudget(ctx, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
