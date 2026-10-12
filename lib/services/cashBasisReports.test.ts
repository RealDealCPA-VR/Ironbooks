/**
 * Integration tests for Cash-Basis P&L reporting.
 *
 * Scenario:
 *  1. Post an invoice (accrual income, AR up) with NO payment.
 *     → Cash-basis income should be 0 because AR increased by the full invoice amount.
 *  2. Post a payment receipt (AR down, Cash up).
 *     → Cash-basis income should now equal the payment amount.
 *
 * Also verifies the trial balance remains balanced after every posting.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { companies, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import { trialBalance } from './reports';
import { profitAndLossCashBasis, accountNetChange } from './cashBasisReports';

// ---------------------------------------------------------------------------
// Unique PGlite directory so this test never collides with another agent's run.
// ---------------------------------------------------------------------------
const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-cash-basis-reports');

let ctx: ServiceContext;
let db: DB;

/** Account IDs keyed by COA code. */
const acct: Record<string, string> = {};

const PERIOD_FROM = new Date('2025-01-01');
const PERIOD_TO = new Date('2025-12-31');

beforeAll(async () => {
  db = await getDb(TEST_DIR);

  const [user] = await db
    .insert(users)
    .values({ email: 'owner@cashbasis.test', name: 'Cash Owner', passwordHash: 'x' })
    .returning();

  const [company] = await db
    .insert(companies)
    .values({ name: 'Cash Basis Co', ownerId: user.id })
    .returning();

  ctx = { db, companyId: company.id, userId: user.id };

  // Seed the minimal COA we need.
  const defs: Array<[string, string, string, string]> = [
    ['1000', 'Checking', 'asset', 'checking'],
    ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
    ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
    ['3000', "Owner's Equity", 'equity', 'owners_equity'],
    ['3900', 'Retained Earnings', 'equity', 'retained_earnings'],
    ['4000', 'Sales Revenue', 'revenue', 'sales'],
    ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
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
// Tests
// ---------------------------------------------------------------------------

describe('profitAndLossCashBasis', () => {
  it('cash-basis income is 0 after posting an invoice with no payment (AR up, cash not received)', async () => {
    // Post the invoice: Dr AR $1,000 / Cr Sales $1,000.
    await postJournalEntry(ctx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2025-03-15'),
      description: 'Invoice #1 — accrual income, no cash received yet',
      lines: [
        { accountId: acct['1200'], debit: '1000.00' },  // AR up
        { accountId: acct['4000'], credit: '1000.00' }, // Revenue
      ],
    });

    // Trial balance must be balanced.
    const tb1 = await trialBalance(ctx);
    expect(tb1.balanced).toBe(true);

    // Cash-basis report for the period.
    const report = await profitAndLossCashBasis(ctx, { from: PERIOD_FROM, to: PERIOD_TO });

    // accrualIncome = $1,000; AR increased by $1,000 → cashIncome = 0.
    expect(report.basis).toBe('cash');
    expect(parseFloat(report.totalIncome)).toBeCloseTo(0, 2);
    expect(parseFloat(report.netIncome)).toBeCloseTo(0, 2);
    // The AR adjustment should equal the invoice amount.
    expect(parseFloat(report.arAdjustment)).toBeCloseTo(1000, 2);
  });

  it('cash-basis income is recognised after posting the payment (AR down, Cash up)', async () => {
    // Post the payment receipt: Dr Checking $1,000 / Cr AR $1,000.
    await postJournalEntry(ctx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2025-04-10'),
      description: 'Payment receipt for Invoice #1 — cash collected',
      lines: [
        { accountId: acct['1000'], debit: '1000.00' },   // Cash up
        { accountId: acct['1200'], credit: '1000.00' },  // AR down
      ],
    });

    // Trial balance must remain balanced.
    const tb2 = await trialBalance(ctx);
    expect(tb2.balanced).toBe(true);

    // Cash-basis report for the same period.
    const report = await profitAndLossCashBasis(ctx, { from: PERIOD_FROM, to: PERIOD_TO });

    // After the payment: net AR change = $1,000 debit − $1,000 credit = 0.
    // cashIncome = accrualIncome ($1,000) − increaseInAR ($0) = $1,000.
    expect(parseFloat(report.totalIncome)).toBeCloseTo(1000, 2);
    expect(parseFloat(report.netIncome)).toBeCloseTo(1000, 2);
    expect(parseFloat(report.arAdjustment)).toBeCloseTo(0, 2);
  });

  it('arAdjustment is positive when AR has a net debit over the period', async () => {
    // Post another invoice that is NOT yet paid.
    await postJournalEntry(ctx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2025-06-01'),
      description: 'Invoice #2 — unpaid',
      lines: [
        { accountId: acct['1200'], debit: '500.00' },
        { accountId: acct['4000'], credit: '500.00' },
      ],
    });

    const report = await profitAndLossCashBasis(ctx, { from: PERIOD_FROM, to: PERIOD_TO });
    // arAdjustment > 0 because this new AR debit outweighs any prior credits in the period.
    expect(parseFloat(report.arAdjustment)).toBeGreaterThan(0);
    // cashIncome < accrualIncome.
    const accrualIncome = report.income.reduce((s, l) => s + parseFloat(l.amount), 0);
    expect(parseFloat(report.totalIncome)).toBeLessThan(accrualIncome);
  });

  it('AP adjustment reduces cash expenses when AP grows (bill posted, not yet paid)', async () => {
    // Post a bill: Dr COGS $300 / Cr AP $300.
    await postJournalEntry(ctx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2025-07-01'),
      description: 'Bill from supplier — accrual expense, not yet paid',
      lines: [
        { accountId: acct['5000'], debit: '300.00' },
        { accountId: acct['2000'], credit: '300.00' },
      ],
    });

    const report = await profitAndLossCashBasis(ctx, { from: PERIOD_FROM, to: PERIOD_TO });
    // AP grew by $300 (credit-net). apAdjustment = increaseInAP = $300.
    // cashExpenses = accrualExpenses ($300) − $300 = $0.
    expect(parseFloat(report.apAdjustment)).toBeCloseTo(300, 2);
    expect(parseFloat(report.totalExpenses)).toBeCloseTo(0, 2);
  });

  it('trial balance is balanced after all test entries', async () => {
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });
});

describe('accountNetChange helper', () => {
  it('returns 0 for a date range with no activity', async () => {
    const result = await accountNetChange(ctx, '1200', new Date('2030-01-01'), new Date('2030-12-31'));
    expect(parseFloat(result)).toBeCloseTo(0, 2);
  });

  it('returns a positive debit-net value for a debit-normal account with net debits', async () => {
    // The AR account (1200) has had net debit activity in the test period.
    const result = await accountNetChange(ctx, '1200', PERIOD_FROM, PERIOD_TO);
    // net = total debits (1000 + 500) − total credits (1000) = 500 net debit.
    expect(parseFloat(result)).toBeCloseTo(500, 2);
  });
});
