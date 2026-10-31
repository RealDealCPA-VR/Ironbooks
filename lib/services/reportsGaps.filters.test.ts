/**
 * Report gaps round — H6: Profit & Loss and Balance Sheet filters beyond Class (QB Filters:
 * Customer:Job, Name, Item, Account, Transaction Type, Amount, Memo, Number), the Item filter on
 * every detail report, and QuickZoom / "explain this amount" lists exactly the filtered lines.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import { CATALOG_BY_KEY } from '@/lib/reports/catalog';
import type { StdReport } from '@/lib/reports/types';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createItem } from './items';
import { createInvoice } from './invoices';
import { createExpense } from './expenses';
import { createBill } from './bills';
import { receivePayment } from './payments';
import { runStandardReport } from './reportRegistry';
import { drilldownCell } from './reportDrilldown';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reports-gaps-filters');
let db: DB;
let ctx: ServiceContext;
const A: Record<string, string> = {};
const S: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const range = { from: '2026-03-01', to: '2026-03-31' };

/** The row of the account with this code. */
const rowOf = (r: StdReport, code: string) => r.rows.find((x) => x.kind === 'data' && x.id.endsWith(`:a:${A[code]}`));
/** The amount on the row of the account with this code, in column `col`. */
function amountOf(r: StdReport, code: string, col = 'total'): string | null {
  const row = rowOf(r, code);
  return row ? String(row.cells[col] ?? '') : null;
}
const net = (r: StdReport) => String(r.rows.find((x) => x.id === 'pl:net')?.cells.total ?? '');

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'filters@test.local', name: 'Filters', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Filter Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) A[a.code] = a.id;
  S.a = (await createCustomer(ctx, { displayName: 'Alpha' } as never)).id;
  S.b = (await createCustomer(ctx, { displayName: 'Bravo' } as never)).id;
  S.v = (await createVendor(ctx, { displayName: 'Supplies Co' } as never)).id;
  S.consult = (await createItem(ctx, { name: 'Consulting', type: 'service', salesPrice: 100, incomeAccountId: A['4000'] } as never)).id;
  S.widget = (await createItem(ctx, { name: 'Widget', type: 'service', salesPrice: 100, incomeAccountId: A['4000'] } as never)).id;
  // Alpha: one invoice, one income line of 300 made of Consulting 200 + Widget 100.
  S.invA = (await createInvoice(ctx, {
    customerId: S.a,
    date: d('2026-03-05'),
    dueDate: d('2026-04-04'),
    lines: [
      { itemId: S.consult, quantity: 2, rate: '100.00', taxable: false },
      { itemId: S.widget, quantity: 1, rate: '100.00', taxable: false },
    ],
  } as never)).id;
  // Bravo: Consulting 50.
  await createInvoice(ctx, { customerId: S.b, date: d('2026-03-06'), dueDate: d('2026-04-05'), lines: [{ itemId: S.consult, quantity: 1, rate: '50.00', taxable: false }] } as never);
  // A bill: 70 costed to Alpha's job, 30 overhead.
  await createBill(ctx, {
    vendorId: S.v,
    date: d('2026-03-07'),
    lines: [
      { accountId: A['6300'], amount: '70.00', customerId: S.a },
      { accountId: A['6300'], amount: '30.00' },
    ],
  } as never);
  // A check for fuel.
  await createExpense(ctx, {
    vendorId: S.v,
    date: d('2026-03-08'),
    method: 'check',
    reference: '1001',
    paymentAccountId: A['1000'],
    lines: [{ accountId: A['6600'], amount: '25.00', description: 'fuel for the van' }],
  } as never);
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Profit & Loss filters (H6)', () => {
  it('the catalog offers the QuickBooks filters on Profit & Loss and Balance Sheet', () => {
    for (const k of ['profit-loss', 'profit-loss-prev-year', 'profit-loss-by-month', 'profit-loss-percent', 'balance-sheet', 'balance-sheet-prev-year', 'balance-sheet-summary', 'balance-sheet-by-period']) {
      for (const c of ['class', 'customer', 'vendor', 'item', 'account', 'txnType', 'amount', 'memo', 'number'] as const) {
        expect(CATALOG_BY_KEY[k].controls, `${k} ${c}`).toContain(c);
      }
    }
    expect(CATALOG_BY_KEY['profit-loss-detail'].controls).toContain('item');
  });

  it('unfiltered totals are unchanged', async () => {
    const r = await runStandardReport(ctx, 'profit-loss', range);
    expect(amountOf(r, '4000')).toBe('350.00');
    expect(amountOf(r, '6300')).toBe('100.00');
    expect(net(r)).toBe('225.00');
    expect(r.subtitle).not.toContain('Filtered');
  });

  it('Customer:Job: the customer’s income and the costs job-costed to it', async () => {
    const r = await runStandardReport(ctx, 'profit-loss', { ...range, customerId: S.a });
    expect(amountOf(r, '4000')).toBe('300.00');
    expect(amountOf(r, '6300')).toBe('70.00');
    expect(amountOf(r, '6600')).toBeNull();
    expect(net(r)).toBe('230.00');
    expect(r.subtitle).toContain('Filtered');
    expect(r.notes?.join(' ')).toMatch(/Filtered/);
    // QuickZoom keeps the filter.
    const row = rowOf(r, '6300')!;
    expect(row.href).toContain(`customerJobId=${S.a}`);
  });

  it('Item: the item’s share of each document line (a 300 income line = 200 Consulting + 100 Widget)', async () => {
    const w = await runStandardReport(ctx, 'profit-loss', { ...range, itemId: S.widget });
    expect(amountOf(w, '4000')).toBe('100.00');
    expect(net(w)).toBe('100.00');
    const c = await runStandardReport(ctx, 'profit-loss', { ...range, itemId: S.consult });
    expect(amountOf(c, '4000')).toBe('250.00');
    expect(amountOf(c, '6300')).toBeNull();
  });

  it('Amount, Memo, Transaction Type and Account', async () => {
    const big = await runStandardReport(ctx, 'profit-loss', { ...range, amountMin: '60' });
    expect(amountOf(big, '4000')).toBe('300.00');
    expect(amountOf(big, '6300')).toBe('70.00');
    expect(amountOf(big, '6600')).toBeNull();
    const fuel = await runStandardReport(ctx, 'profit-loss', { ...range, memo: 'fuel' });
    expect(amountOf(fuel, '6600')).toBe('25.00');
    expect(amountOf(fuel, '4000')).toBeNull();
    const billsOnly = await runStandardReport(ctx, 'profit-loss', { ...range, txnType: 'bill' });
    expect(amountOf(billsOnly, '6300')).toBe('100.00');
    expect(amountOf(billsOnly, '4000')).toBeNull();
    const acct = await runStandardReport(ctx, 'profit-loss', { ...range, accountId: A['6300'] });
    expect(amountOf(acct, '6300')).toBe('100.00');
    expect(amountOf(acct, '4000')).toBeNull();
  });

  it('works with month columns and the previous-year comparison', async () => {
    const m = await runStandardReport(ctx, 'profit-loss-by-month', { ...range, itemId: S.widget });
    const row = rowOf(m, '4000')!;
    expect(row.cells.total).toBe('100.00');
    const prev = await runStandardReport(ctx, 'profit-loss-prev-year', { ...range, customerId: S.b });
    const p4000 = rowOf(prev, '4000')!;
    expect(p4000.cells.cur).toBe('50.00');
    expect(p4000.cells.prev).toBe('0.00');
  });

  it('"explain this amount" lists exactly the filtered lines', async () => {
    const p = { ...range, itemId: S.widget, basis: 'accrual' };
    const r = await runStandardReport(ctx, 'profit-loss', p);
    const row = rowOf(r, '4000')!;
    const res = await drilldownCell(ctx, 'profit-loss', p, row.id, 'total');
    expect(res.total).toBe('100.00');
    const cust = { ...range, customerId: S.a, basis: 'accrual' };
    const r2 = await runStandardReport(ctx, 'profit-loss', cust);
    const exp = rowOf(r2, '6300')!;
    expect((await drilldownCell(ctx, 'profit-loss', cust, exp.id, 'total')).total).toBe('70.00');
  });

  it('the Item filter works on the cash basis (a paid share keeps its item split)', async () => {
    // Nothing is paid in March: the cash-basis P&L for the item is empty.
    const r = await runStandardReport(ctx, 'profit-loss', { ...range, itemId: S.widget, basis: 'cash' });
    expect(amountOf(r, '4000')).toBeNull();
    // Half of Alpha's invoice paid in April: half of each item's income is recognized.
    await receivePayment(ctx, {
      customerId: S.a,
      date: d('2026-04-02'),
      amount: '150.00',
      method: 'check',
      depositAccountId: A['1000'],
      applications: [{ invoiceId: S.invA, amountApplied: '150.00' }],
    } as never);
    const april = { from: '2026-03-01', to: '2026-04-30', basis: 'cash' };
    expect(amountOf(await runStandardReport(ctx, 'profit-loss', { ...april, itemId: S.widget }), '4000')).toBe('50.00');
    expect(amountOf(await runStandardReport(ctx, 'profit-loss', { ...april, itemId: S.consult }), '4000')).toBe('100.00');
    expect(amountOf(await runStandardReport(ctx, 'profit-loss', april), '4000')).toBe('150.00');
  });
});

describe('Balance Sheet filters (H6)', () => {
  it('a Customer:Job balance sheet adds up only that customer’s lines (and says it need not balance)', async () => {
    const r = await runStandardReport(ctx, 'balance-sheet', { asOf: '2026-03-31', customerId: S.a });
    expect(amountOf(r, '1200')).toBe('300.00');
    expect(amountOf(r, '1000')).toBeNull();
    const ni = r.rows.find((x) => x.id === 'bs:ni')!;
    expect(ni.cells.total).toBe('230.00');
    expect(r.subtitle).toContain('Filtered');
    expect(r.balanced).toBeUndefined();
    expect(r.notes?.join(' ')).toMatch(/need not balance/);
  });

  it('an Account filter shows that account’s balance', async () => {
    const r = await runStandardReport(ctx, 'balance-sheet', { asOf: '2026-03-31', accountId: A['1000'] });
    expect(amountOf(r, '1000')).toBe('-25.00');
    expect(amountOf(r, '1200')).toBeNull();
  });
});

describe('Item filter on detail reports', () => {
  it('Transaction Detail by Account lists the item’s share of each line', async () => {
    const r = await runStandardReport(ctx, 'transaction-detail-by-account', { ...range, itemId: S.widget });
    const lines = r.rows.filter((x) => x.kind === 'data' && x.entryId);
    expect(lines).toHaveLength(1);
    expect(Object.values(lines[0].cells)).toContain('100.00');
  });
});
