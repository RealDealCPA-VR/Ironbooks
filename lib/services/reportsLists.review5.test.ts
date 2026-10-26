/**
 * Review round 5 — Purchases reports (QB Reports > Purchases), Bills & Applied Payments and
 * Unbilled Costs by Job.
 *
 *  - Purchases by Item / by Vendor Summary and Purchases by Item Detail count every purchase of
 *    an item like QuickBooks: bills, checks and credit-card charges with item lines (Items tab),
 *    and vendor credits (returns) as negatives — and always in HOME currency (a EUR bill line of
 *    300.00 at 1.10 is 330.00, never 300 "dollars" added to dollar amounts).
 *  - Bills & Applied Payments: the TOTAL is the sum of the rows (bills less payments AND credits).
 *  - Unbilled Costs by Job shows a foreign bill's billable line in home currency.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, users, vendors } from '@/lib/db/schema';
import type { StdReport } from '@/lib/reports/types';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { setBaseCurrency, upsertCurrency } from './currencies';
import { createVendor } from './vendors';
import { createCustomer } from './customers';
import { createItem } from './items';
import { createBill } from './bills';
import { payBills } from './billPayments';
import { createExpense } from './expenses';
import { applyToBill, createVendorCredit } from './vendorCredits';
import { runStandardReport } from './reportRegistry';
import { GL_LIMITS } from './reportEngine';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-purchases');
let db: DB;
let ctx: ServiceContext;
const A: Record<string, string> = {};
const S: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const range = { from: '2026-01-01', to: '2026-12-31' };
const cell = (r: StdReport, label: string, col: string) => r.rows.find((x) => x.cells.label === label)?.cells[col];

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'r5-purch@test.local', name: 'R5 Purchases', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Purchases Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) A[a.code] = a.id;
  await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
  await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.10' });
  S.local = (await createVendor(ctx, { displayName: 'Local Supply' } as never)).id;
  S.euro = (await createVendor(ctx, { displayName: 'Euro Parts' } as never)).id;
  await db.update(vendors).set({ currency: 'EUR' }).where(eq(vendors.id, S.euro));
  S.cust = (await createCustomer(ctx, { displayName: 'Job Customer' } as never)).id;
  S.part = (await createItem(ctx, { name: 'Part', type: 'non_inventory', purchaseCost: 10, expenseAccountId: A['6300'] } as never)).id;

  const homeBill = await createBill(ctx, {
    vendorId: S.local,
    billNumber: 'L-1',
    date: d('2026-02-01'),
    lines: [{ itemId: S.part, quantity: 2, unitCost: 10 }],
  } as never);
  S.homeBill = homeBill.id;
  await createBill(ctx, {
    vendorId: S.euro,
    billNumber: 'E-1',
    date: d('2026-02-02'),
    currency: 'EUR',
    exchangeRate: '1.10',
    lines: [
      { itemId: S.part, quantity: 3, unitCost: 100 },
      { accountId: A['6300'], amount: '50.00', customerId: S.cust },
    ],
  } as never);
  await createExpense(ctx, {
    vendorId: S.local,
    date: d('2026-02-03'),
    method: 'check',
    paymentAccountId: A['1000'],
    lines: [{ itemId: S.part, quantity: 1, unitCost: 15 }],
  });
  const credit = await createVendorCredit(ctx, {
    vendorId: S.local,
    date: d('2026-02-04'),
    lines: [{ itemId: S.part, quantity: 1, unitCost: 10 }],
  });
  S.credit = credit.id;
  // Pay part of the home bill and apply the credit to it.
  await applyToBill(ctx, { vendorCreditId: credit.id, billId: homeBill.id, amount: '10.00' });
  await payBills(ctx, { vendorId: S.local, date: d('2026-02-10'), method: 'check', paymentAccountId: A['1000'], applications: [{ billId: homeBill.id, amountApplied: '5.00' }] } as never);
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Purchases reports', () => {
  it('Purchases by Item Summary: bills, checks and returns, in home currency', async () => {
    const r = await runStandardReport(ctx, 'purchases-by-item-summary', range);
    // 2 x 10 (bill) + 3 x 100 EUR at 1.10 (bill) + 1 x 15 (check) - 1 x 10 (vendor credit)
    expect(cell(r, 'Part', 'amount')).toBe('355.00');
    expect(cell(r, 'Part', 'qty')).toBe('5.0000');
    expect(cell(r, 'TOTAL', 'amount')).toBe('355.00');
  });

  it('Purchases by Vendor Summary: each vendor in home currency', async () => {
    const r = await runStandardReport(ctx, 'purchases-by-vendor-summary', range);
    expect(cell(r, 'Local Supply', 'amount')).toBe('25.00');
    expect(cell(r, 'Euro Parts', 'amount')).toBe('330.00');
    expect(cell(r, 'TOTAL', 'amount')).toBe('355.00');
  });

  it('Purchases by Item Detail lists the check and the credit, with home amounts', async () => {
    const r = await runStandardReport(ctx, 'purchases-by-item-detail', range);
    const types = r.rows.filter((x) => x.kind === 'data').map((x) => `${x.cells.type} ${x.cells.amount}`);
    expect(types).toEqual(expect.arrayContaining(['Bill 20.00', 'Bill 330.00', 'Check 15.00', 'Credit -10.00']));
    expect(r.rows.find((x) => x.kind === 'grand')?.cells.amount).toBe('355.00');
  });
});

describe('Bills & Applied Payments', () => {
  it('the TOTAL is bills less payments and credits (the sum of the rows)', async () => {
    const r = await runStandardReport(ctx, 'bills-applied-payments', { ...range, vendorId: S.local });
    const sum = r.rows.filter((x) => x.kind === 'data').reduce((s, x) => s + Number(x.cells.amount ?? 0), 0);
    expect(sum.toFixed(2)).toBe('5.00'); // 20 - 5 paid - 10 credited
    expect(r.rows.find((x) => x.kind === 'grand')?.cells.amount).toBe('5.00');
  });
});

describe('Unbilled Costs by Job', () => {
  it('a foreign bill line is shown in home currency', async () => {
    const r = await runStandardReport(ctx, 'unbilled-costs-by-job', {});
    expect(r.rows.find((x) => x.kind === 'grand')?.cells.amount).toBe('55.00'); // 50 EUR x 1.10
  });
});

describe('balance summaries on a large file', () => {
  it('Vendor Balance Summary and the contact list add up every A/P line, not the first N', async () => {
    const cap = GL_LIMITS.maxLines;
    GL_LIMITS.maxLines = 2; // stands in for the 50,000-line read on a big company file
    try {
      const r = await runStandardReport(ctx, 'vendor-balance-summary', { asOf: '2026-12-31' });
      expect(cell(r, 'Local Supply', 'balance')).toBe('5.00'); // 20 billed - 10 credit - 5 paid
      expect(cell(r, 'Euro Parts', 'balance')).toBe('385.00'); // 350 EUR at 1.10
      expect(cell(r, 'TOTAL', 'balance')).toBe('390.00');
      expect(r.truncated).toBeFalsy();
      const list = await runStandardReport(ctx, 'vendor-contact-list', {});
      expect(cell(list, 'Local Supply', 'balance')).toBe('5.00');
      expect(cell(list, 'Euro Parts', 'balance')).toBe('385.00');
    } finally {
      GL_LIMITS.maxLines = cap;
    }
  });
});

describe('a capped report says so', () => {
  it('Expenses by Vendor Summary that hit the line cap carries a note on the page', async () => {
    const cap = GL_LIMITS.maxLines;
    GL_LIMITS.maxLines = 2;
    try {
      const r = await runStandardReport(ctx, 'expenses-by-vendor-summary', range);
      expect(r.truncated).toBe(true);
      expect((r.notes ?? []).join(' ')).toMatch(/narrow/i);
    } finally {
      GL_LIMITS.maxLines = cap;
    }
  });
});

describe('Balance Sheet Detail with a name filter', () => {
  it("does not mix every name's beginning balance into one vendor's transactions", async () => {
    // Euro Parts' bill is dated Feb 2: before the range, so it is part of the A/P beginning balance.
    const r = await runStandardReport(ctx, 'balance-sheet-detail', { from: '2026-02-03', to: '2026-12-31', vendorId: S.local });
    const apGroup = r.rows.find((x) => x.kind === 'section' && x.cells.label === 'Accounts Payable');
    const apRows = r.rows.filter((x) => x.parentId === apGroup?.id);
    // No beginning balance carrying the other vendor's (or Local Supply's own earlier) A/P.
    expect(apRows.some((x) => x.cells.label === 'Beginning balance')).toBe(false);
    // Only Local Supply's A/P lines in the range: the credit (-10) and the payment (-5).
    const total = r.rows.find((x) => x.id === `${apGroup?.id}:total`);
    expect(total?.cells.amount).toBe('-15.00');
    expect((r.notes ?? []).join(' ')).toMatch(/Beginning balances are left out/);
  });
});

describe('Unpaid Bills Detail', () => {
  it('a named General Journal A/P line is a General Journal item that opens its entry; Num shows the number only', async () => {
    const { postJournalEntry } = await import('./posting');
    const je = await postJournalEntry(ctx, {
      date: d('2026-03-01'),
      description: 'Opening A/P',
      lines: [
        { accountId: A['6300'], debit: '40.00' },
        { accountId: A['2000'], credit: '40.00', entityType: 'vendor', entityId: S.local },
      ],
    });
    const r = await runStandardReport(ctx, 'unpaid-bills-detail', { asOf: '2026-12-31', vendorId: S.local });
    const rows = r.rows.filter((x) => x.kind === 'data');
    const gj = rows.find((x) => x.cells.type === 'General Journal');
    expect(gj, JSON.stringify(rows.map((x) => x.cells))).toBeTruthy();
    expect(gj!.entryId).toBe(je.id);
    expect(gj!.cells.open).toBe('40.00');
    const bill = rows.find((x) => x.cells.type === 'Bill');
    expect(bill?.cells.num).toBe('L-1');
  });
});

describe('Profit & Loss by Job', () => {
  it('costs billed to a customer:job (bill / check lines) sit in that job column, and explain to it', async () => {
    const { drilldownCell } = await import('./reportDrilldown');
    const job = (await createCustomer(ctx, { displayName: 'Kitchen Job' } as never)).id;
    await createBill(ctx, {
      vendorId: S.local,
      billNumber: 'JOB-1',
      date: d('2026-04-01'),
      lines: [
        { accountId: A['6300'], amount: '70.00', customerId: job },
        { accountId: A['6300'], amount: '30.00' },
      ],
    } as never);
    await createExpense(ctx, {
      vendorId: S.local,
      date: d('2026-04-02'),
      method: 'check',
      paymentAccountId: A['1000'],
      lines: [{ accountId: A['6400'], amount: '25.00', customerId: job }],
    });
    const params = { from: '2026-04-01', to: '2026-04-30' };
    const r = await runStandardReport(ctx, 'profit-loss-by-job', params);
    const col = r.columns.find((c) => c.header === 'Kitchen Job');
    expect(col, JSON.stringify(r.columns)).toBeTruthy();
    const none = r.columns.find((c) => c.header === 'No customer:job')!;
    const supplies = r.rows.find((x) => x.id.endsWith(`:a:${A['6300']}`))!;
    expect(supplies.cells[col!.key]).toBe('70.00');
    expect(supplies.cells[none.key]).toBe('30.00');
    const rent = r.rows.find((x) => x.id.endsWith(`:a:${A['6400']}`))!;
    expect(rent.cells[col!.key]).toBe('25.00');
    const x = await drilldownCell(ctx, 'profit-loss-by-job', params, supplies.id, col!.key);
    expect(x.total).toBe('70.00');
    expect(x.ties).toBe(true);
    const net = await drilldownCell(ctx, 'profit-loss-by-job', params, 'pl:net', col!.key);
    expect(net.ties).toBe(true);
  });
});
