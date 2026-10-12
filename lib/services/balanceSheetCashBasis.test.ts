/**
 * Integration tests for the cash-basis Balance Sheet (QuickBooks per-transaction conversion).
 *
 *  1. Empty ledger — both sheets balanced and zero.
 *  2. Unpaid invoice — its income is out of earnings AND out of A/R; the sheet still balances.
 *  3. Partial payment — the paid share moves into earnings; A/R keeps only the unpaid share
 *     of the invoice's balance-sheet lines (none here).
 *  4. Unpaid bill — its expense is out of earnings and out of A/P.
 *  5. Journal entries on A/R / A/P are not converted (QB reports them the same on both bases).
 *  6. asOf limits the sheet; prior-year earnings and current-year net income split like accrual.
 *
 * Each test asserts Assets = Liabilities + Equity and that cash earnings == cash net income.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, invoices, users } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createInvoice } from './invoices';
import { receivePayment } from './payments';
import { createBill } from './bills';
import { postJournalEntry } from './posting';
import { balanceSheet } from './reports';
import { balanceSheetCashBasis } from './balanceSheetCashBasis';
import { profitAndLossCashBasis } from './cashBasisReports';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-bs-cash-basis');

let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};
let customer: string;
let vendor: string;
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db
    .insert(users)
    .values({ email: 'owner@bscashbasis.test', name: 'BS Cash Owner', passwordHash: 'x' })
    .returning();
  const company = await createCompany(db, { name: 'BS Cash Basis Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[r.code] = r.id;
  customer = (await createCustomer(ctx, { displayName: 'Cash Customer' })).id;
  vendor = (await createVendor(ctx, { displayName: 'Cash Vendor' })).id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

async function firstInvoice() {
  const [row] = await db.select().from(invoices).where(eq(invoices.companyId, ctx.companyId));
  return row;
}

const amt = (lines: { accountId: string; amount: string }[], id: string) =>
  lines.find((l) => l.accountId === id)?.amount ?? '0.00';

async function expectConsistent(asOf?: Date) {
  const cash = await balanceSheetCashBasis(ctx, asOf);
  expect(cash.balanced).toBe(true);
  expect(cash.totals.totalAssets).toBe(cash.totals.totalLiabilitiesAndEquity);
  expect(Money.add(cash.priorYearsEarnings, cash.currentYearNetIncome).toFixed(2)).toBe(cash.retainedEarnings);
  const pl = await profitAndLossCashBasis(ctx, asOf ? { to: asOf } : undefined);
  expect(cash.retainedEarnings).toBe(pl.netIncome);
  return cash;
}

describe('balanceSheetCashBasis', () => {
  it('empty ledger — balanced with zero totals', async () => {
    const cash = await expectConsistent();
    expect(cash.basis).toBe('cash');
    expect(cash.totals.totalAssets).toBe('0.00');
    expect(cash.adjustments.arAdjustment).toBe('0.00');
    expect(cash.adjustments.apAdjustment).toBe('0.00');
  });

  it('unpaid invoice: income is out of earnings and out of A/R; still balanced', async () => {
    await createInvoice(ctx, {
      customerId: customer,
      date: d('2025-03-15'),
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '1000.00', taxable: false }],
    });
    const accrual = await balanceSheet(ctx);
    expect(amt(accrual.assets, acct['1200'])).toBe('1000.00');
    const cash = await expectConsistent();
    expect(amt(cash.assets, acct['1200'])).toBe('0.00');
    expect(cash.adjustments.arAdjustment).toBe('1000.00');
    expect(cash.adjustments.equityAdjustment).toBe('1000.00');
    expect(cash.retainedEarnings).toBe('0.00');
    expect(cash.accrualRetainedEarnings).toBe('1000.00');
  });

  it('partial payment moves the paid share into earnings', async () => {
    const open = await firstInvoice();
    await receivePayment(ctx, {
      customerId: customer,
      date: d('2025-04-01'),
      amount: '400.00',
      method: 'check',
      depositAccountId: acct['1000'],
      applications: [{ invoiceId: open.id, amountApplied: '400.00' }],
    });
    const cash = await expectConsistent();
    expect(amt(cash.assets, acct['1000'])).toBe('400.00');
    expect(amt(cash.assets, acct['1200'])).toBe('0.00');
    expect(cash.adjustments.arAdjustment).toBe('600.00');
    expect(cash.retainedEarnings).toBe('400.00');
  });

  it('unpaid bill: expense is out of earnings and out of A/P', async () => {
    await createBill(ctx, { vendorId: vendor, date: d('2025-05-01'), lines: [{ accountId: acct['6000'], amount: '300.00' }] });
    const accrual = await balanceSheet(ctx);
    expect(amt(accrual.liabilities, acct['2000'])).toBe('300.00');
    const cash = await expectConsistent();
    expect(amt(cash.liabilities, acct['2000'])).toBe('0.00');
    expect(cash.adjustments.apAdjustment).toBe('300.00');
    expect(cash.retainedEarnings).toBe('400.00');
  });

  it('journal entries on A/R are reported the same on both bases', async () => {
    await postJournalEntry(ctx, {
      date: d('2025-05-10'),
      description: 'Accrued fee',
      lines: [
        { accountId: acct['1200'], debit: '50.00', entityType: 'customer', entityId: customer },
        { accountId: acct['4000'], credit: '50.00' },
      ],
    });
    const cash = await expectConsistent();
    expect(amt(cash.assets, acct['1200'])).toBe('50.00');
    expect(cash.retainedEarnings).toBe('450.00');
  });

  it('asOf limits the sheet; earnings split into prior years and current year', async () => {
    const before = await expectConsistent(d('2025-02-01'));
    expect(before.totals.totalAssets).toBe('0.00');
    expect(before.asOf).toBeDefined();
    await receivePayment(ctx, {
      customerId: customer,
      date: d('2026-01-10'),
      amount: '600.00',
      method: 'check',
      depositAccountId: acct['1000'],
      applications: [
        { invoiceId: (await firstInvoice()).id, amountApplied: '600.00' },
      ],
    });
    const now = await expectConsistent(new Date('2026-06-30T23:59:59.999Z'));
    expect(now.priorYearsEarnings).toBe('450.00');
    expect(now.currentYearNetIncome).toBe('600.00');
  });
});
