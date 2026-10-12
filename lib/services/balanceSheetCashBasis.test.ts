/**
 * Integration tests for the cash-basis Balance Sheet.
 *
 * Scenario:
 *  1. Start with an empty ledger — both accrual and cash-basis sheets should be empty/balanced.
 *  2. Post an unpaid invoice (Dr AR / Cr Revenue).
 *     Accrual BS: AR appears in assets, retained earnings increases (revenue side).
 *     Cash-basis BS: AR is removed from assets AND equity is reduced by arRemoved, sheet balanced.
 *  3. Post a partial payment (Dr Cash / Cr AR).
 *     Cash-basis AR removal shrinks; equity adjustment also shrinks.
 *  4. Post an unpaid bill (Dr Expense / Cr AP).
 *     Accrual BS: AP appears in liabilities.
 *     Cash-basis BS: AP also removed; equityAdjustment = arRemoved − apRemoved.
 *
 * Each test asserts the accounting equation: Assets = Liabilities + Equity.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { companies, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import { balanceSheet } from './reports';
import { balanceSheetCashBasis } from './balanceSheetCashBasis';

// ---------------------------------------------------------------------------
// Unique PGlite directory — never collides with another agent's run.
// ---------------------------------------------------------------------------
const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-bs-cash-basis');

let ctx: ServiceContext;
let db: DB;

/** Account IDs keyed by COA code. */
const acct: Record<string, string> = {};

beforeAll(async () => {
  db = await getDb(TEST_DIR);

  const [user] = await db
    .insert(users)
    .values({ email: 'owner@bscashbasis.test', name: 'BS Cash Owner', passwordHash: 'x' })
    .returning();

  const [company] = await db
    .insert(companies)
    .values({ name: 'BS Cash Basis Co', ownerId: user.id })
    .returning();

  ctx = { db, companyId: company.id, userId: user.id };

  // Minimal COA for the tests.
  const defs: Array<[string, string, string, string]> = [
    ['1000', 'Checking',            'asset',     'checking'],
    ['1200', 'Accounts Receivable', 'asset',     'accounts_receivable'],
    ['2000', 'Accounts Payable',    'liability', 'accounts_payable'],
    ['3000', "Owner's Equity",      'equity',    'owners_equity'],
    ['3900', 'Retained Earnings',   'equity',    'retained_earnings'],
    ['4000', 'Sales Revenue',       'revenue',   'sales'],
    ['5000', 'Operating Expenses',  'expense',   'operating_expenses'],
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
// Helpers
// ---------------------------------------------------------------------------

function totalLiabilitiesAndEquity(report: Awaited<ReturnType<typeof balanceSheetCashBasis>>) {
  return parseFloat(report.totals.totalLiabilities) + parseFloat(report.totals.totalEquity);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('balanceSheetCashBasis', () => {
  it('empty ledger — both accrual and cash-basis sheets are balanced with zero totals', async () => {
    const accrual = await balanceSheet(ctx);
    expect(accrual.balanced).toBe(true);

    const cash = await balanceSheetCashBasis(ctx);
    expect(cash.basis).toBe('cash');
    expect(cash.balanced).toBe(true);
    expect(parseFloat(cash.totals.totalAssets)).toBeCloseTo(0, 2);
    expect(parseFloat(cash.adjustments.arRemoved)).toBeCloseTo(0, 2);
    expect(parseFloat(cash.adjustments.apRemoved)).toBeCloseTo(0, 2);
  });

  it('unpaid invoice: accrual has AR + equity; cash-basis removes AR and reduces equity, still balanced', async () => {
    // Dr AR $1,000 / Cr Sales $1,000
    await postJournalEntry(ctx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2025-03-15'),
      description: 'Invoice #1 — unpaid',
      lines: [
        { accountId: acct['1200'], debit: '1000.00' },  // AR up
        { accountId: acct['4000'], credit: '1000.00' }, // Revenue
      ],
    });

    // ---- Accrual sheet ----
    const accrual = await balanceSheet(ctx);
    expect(accrual.balanced).toBe(true);
    // AR should appear in accrual assets.
    const arLine = accrual.assets.find((l) => l.code === '1200');
    expect(arLine).toBeDefined();
    expect(parseFloat(arLine!.amount)).toBeCloseTo(1000, 2);
    // Accrual equity includes retained earnings from the revenue.
    expect(parseFloat(accrual.retainedEarnings)).toBeCloseTo(1000, 2);

    // ---- Cash-basis sheet ----
    const cash = await balanceSheetCashBasis(ctx);
    expect(cash.basis).toBe('cash');

    // AR must NOT appear in cash-basis assets.
    const cashArLine = cash.assets.find((l) => l.code === '1200');
    expect(cashArLine).toBeUndefined();

    // AR removed should equal $1,000.
    expect(parseFloat(cash.adjustments.arRemoved)).toBeCloseTo(1000, 2);
    expect(cash.adjustments.removedArLines).toHaveLength(1);

    // No AP was posted, so AP removal is zero.
    expect(parseFloat(cash.adjustments.apRemoved)).toBeCloseTo(0, 2);

    // equityAdjustment = arRemoved − apRemoved = $1,000.
    expect(parseFloat(cash.adjustments.equityAdjustment)).toBeCloseTo(1000, 2);

    // Cash-basis equity should be accrual equity minus $1,000.
    const expectedEquity = parseFloat(accrual.totalEquity) - 1000;
    expect(parseFloat(cash.totals.totalEquity)).toBeCloseTo(expectedEquity, 2);

    // Sheet must still balance.
    expect(cash.balanced).toBe(true);
    expect(parseFloat(cash.totals.totalAssets)).toBeCloseTo(totalLiabilitiesAndEquity(cash), 2);
  });

  it('partial payment reduces AR removal and equity adjustment proportionally', async () => {
    // Dr Checking $400 / Cr AR $400  (partial payment)
    await postJournalEntry(ctx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2025-04-01'),
      description: 'Partial payment on Invoice #1',
      lines: [
        { accountId: acct['1000'], debit: '400.00' },   // Cash up
        { accountId: acct['1200'], credit: '400.00' },  // AR down
      ],
    });

    const cash = await balanceSheetCashBasis(ctx);

    // AR balance remaining = $600.
    expect(parseFloat(cash.adjustments.arRemoved)).toBeCloseTo(600, 2);
    expect(parseFloat(cash.adjustments.equityAdjustment)).toBeCloseTo(600, 2);

    // Cash (1000) should now appear in assets.
    const checkingLine = cash.assets.find((l) => l.code === '1000');
    expect(checkingLine).toBeDefined();
    expect(parseFloat(checkingLine!.amount)).toBeCloseTo(400, 2);

    // Sheet must balance.
    expect(cash.balanced).toBe(true);
    expect(parseFloat(cash.totals.totalAssets)).toBeCloseTo(totalLiabilitiesAndEquity(cash), 2);
  });

  it('unpaid bill: AP is removed from liabilities and offsets the equity adjustment', async () => {
    // Dr Expenses $300 / Cr AP $300
    await postJournalEntry(ctx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2025-05-01'),
      description: 'Bill #1 — unpaid',
      lines: [
        { accountId: acct['5000'], debit: '300.00' },   // Expense
        { accountId: acct['2000'], credit: '300.00' },  // AP up
      ],
    });

    // ---- Accrual sheet ----
    const accrual = await balanceSheet(ctx);
    expect(accrual.balanced).toBe(true);
    const apLine = accrual.liabilities.find((l) => l.code === '2000');
    expect(apLine).toBeDefined();
    expect(parseFloat(apLine!.amount)).toBeCloseTo(300, 2);

    // ---- Cash-basis sheet ----
    const cash = await balanceSheetCashBasis(ctx);

    // AP must NOT appear in cash-basis liabilities.
    const cashApLine = cash.liabilities.find((l) => l.code === '2000');
    expect(cashApLine).toBeUndefined();
    expect(parseFloat(cash.adjustments.apRemoved)).toBeCloseTo(300, 2);
    expect(cash.adjustments.removedApLines).toHaveLength(1);

    // equityAdjustment = arRemoved($600) − apRemoved($300) = $300.
    expect(parseFloat(cash.adjustments.equityAdjustment)).toBeCloseTo(300, 2);

    // Cash-basis equity = accrual equity − $300 equity adjustment.
    const expectedEquity = parseFloat(accrual.totalEquity) - 300;
    expect(parseFloat(cash.totals.totalEquity)).toBeCloseTo(expectedEquity, 2);

    // Sheet must balance.
    expect(cash.balanced).toBe(true);
    expect(parseFloat(cash.totals.totalAssets)).toBeCloseTo(totalLiabilitiesAndEquity(cash), 2);
  });

  it('asOf date is forwarded and limits the report to that point in time', async () => {
    // As of 2025-02-01 (before any entries) everything should be zero.
    const cash = await balanceSheetCashBasis(ctx, new Date('2025-02-01'));
    expect(cash.balanced).toBe(true);
    expect(parseFloat(cash.totals.totalAssets)).toBeCloseTo(0, 2);
    expect(cash.asOf).toBeDefined();
  });
});
