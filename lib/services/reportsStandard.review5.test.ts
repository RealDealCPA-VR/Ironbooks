/**
 * Review round 5 — standard statements (reportsStandard.ts).
 *
 *  - Profit & Loss Detail lists its account groups in statement order (Income, Cost of Goods
 *    Sold, Expense, Other Income, Other Expense) like QuickBooks, whatever the accounts are
 *    numbered: an Other Income account numbered 4950 used to be listed between Income and Cost of
 *    Goods Sold (groups were sorted by account number only, though the code meant to keep the
 *    statement order).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import { runStandardReport } from './reportRegistry';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-reports-standard');
let db: DB;
let ctx: ServiceContext;
const A: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'r5-std@test.local', name: 'R5 Std', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Statements Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) A[a.code] = a.id;
  A.otherIncome = (await createAccount(ctx, { code: '4950', name: 'Interest Income', type: 'revenue', subtype: 'other_income' } as never)).id;
  A.otherExpense = (await createAccount(ctx, { code: '5950', name: 'Penalties', type: 'expense', subtype: 'other_expense' } as never)).id;
  const je = (date: string, debit: string, credit: string, amount: string) =>
    postJournalEntry(ctx, { date: d(date), description: 'test', lines: [{ accountId: debit, debit: amount }, { accountId: credit, credit: amount }] });
  await je('2026-07-05', A['1000'], A['4000'], '100.00');
  await je('2026-07-05', A['1000'], A.otherIncome, '5.00');
  await je('2026-07-05', A['5000'], A['1000'], '40.00');
  await je('2026-07-05', A.otherExpense, A['1000'], '3.00');
  await je('2026-07-06', A['6000'], A['1000'], '20.00');
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Profit & Loss Detail: statement order', () => {
  it('Income, COGS, Expense, then Other Income and Other Expense, whatever the numbers', async () => {
    const r = await runStandardReport(ctx, 'profit-loss-detail', { from: '2026-07-01', to: '2026-07-31' });
    // Account group headings are "pld:g:account:<accountId>".
    const order = r.rows.filter((x) => x.kind === 'section').map((x) => x.id.split(':').pop());
    expect(order).toEqual([A['4000'], A['5000'], A['6000'], A.otherIncome, A.otherExpense]);
    const net = r.rows.find((x) => x.id === 'pld:net');
    expect(net?.cells.amount).toBe('42.00'); // 100 + 5 − 40 − 3 − 20
  });
});

/**
 * Trial Balance as QuickBooks shows it: income and expense accounts carry the FISCAL YEAR TO DATE
 * and every earlier year's net income sits in Retained Earnings (QB closes the books implicitly at
 * each fiscal year end). The report showed every income / expense account's all-time total and
 * Retained Earnings without the earlier years, so a converted multi-year file never matched the
 * QuickBooks trial balance line for line (MIGRATION.md's check), and a TB as of Jan 1 still showed
 * last year's sales.
 */
describe('Trial Balance: fiscal year to date + Retained Earnings (QuickBooks)', () => {
  const T: Record<string, string> = {};
  let tctx: ServiceContext;
  beforeAll(async () => {
    const [user] = await db.insert(users).values({ email: 'r5-tb@test.local', name: 'R5 TB', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'TB Co', ownerId: user.id });
    tctx = { db, companyId: company.id, userId: user.id };
    for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) T[a.code] = a.id;
    const je = (date: string, debit: string, credit: string, amount: string) =>
      postJournalEntry(tctx, { date: d(date), description: 'test', lines: [{ accountId: debit, debit: amount }, { accountId: credit, credit: amount }] });
    await je('2025-03-10', T['1000'], T['4000'], '500.00'); // last year's sales
    await je('2025-04-10', T['6000'], T['1000'], '120.00'); // last year's expense
    await je('2026-02-10', T['1000'], T['4000'], '100.00');
    await je('2026-02-11', T['6000'], T['1000'], '30.00');
  });

  const cell = (r: { rows: { id: string; cells: Record<string, unknown> }[] }, id: string, col: 'debit' | 'credit') =>
    (r.rows.find((x) => x.id === id)?.cells[col] as string | null | undefined) ?? null;

  it('as of a date in 2026: this year on the P&L accounts, 2025 in Retained Earnings', async () => {
    const r = await runStandardReport(tctx, 'trial-balance', { asOf: '2026-07-31', basis: 'accrual' });
    expect(cell(r, `tb:a:${T['4000']}`, 'credit')).toBe('100.00');
    expect(cell(r, `tb:a:${T['6000']}`, 'debit')).toBe('30.00');
    expect(cell(r, `tb:a:${T['3900']}`, 'credit')).toBe('380.00'); // 500 − 120
    expect(cell(r, `tb:a:${T['1000']}`, 'debit')).toBe('450.00');
    expect(cell(r, 'tb:total', 'debit')).toBe('480.00');
    expect(cell(r, 'tb:total', 'credit')).toBe('480.00');
    expect(r.balanced).toBe(true);
  });

  it('as of the last day of 2025 the year is still on the P&L accounts', async () => {
    const r = await runStandardReport(tctx, 'trial-balance', { asOf: '2025-12-31', basis: 'accrual' });
    expect(cell(r, `tb:a:${T['4000']}`, 'credit')).toBe('500.00');
    expect(r.rows.find((x) => x.id === `tb:a:${T['3900']}`)).toBeUndefined();
  });

  it('cash basis and the combined trial balance agree', async () => {
    const cash = await runStandardReport(tctx, 'trial-balance', { asOf: '2026-07-31', basis: 'cash' });
    expect(cell(cash, `tb:a:${T['4000']}`, 'credit')).toBe('100.00');
    expect(cell(cash, `tb:a:${T['3900']}`, 'credit')).toBe('380.00');
    const combined = await runStandardReport(tctx, 'combined-trial-balance', { asOf: '2026-07-31' });
    const row = combined.rows.find((x) => String(x.cells.label) === 'Retained Earnings');
    expect(row?.cells.total_cr).toBe('380.00');
    const sales = combined.rows.find((x) => String(x.cells.label).includes('Sales'));
    expect(sales?.cells.total_cr).toBe('100.00');
  });

  it('the explanations of a trial balance amount add up to it', async () => {
    const { drilldownCell } = await import('./reportDrilldown');
    const re = await drilldownCell(tctx, 'trial-balance', { asOf: '2026-07-31', basis: 'accrual' }, `tb:a:${T['3900']}`, 'credit');
    expect(re.total).toBe('380.00');
    expect(re.ties).toBe(true);
    const sales = await drilldownCell(tctx, 'trial-balance', { asOf: '2026-07-31', basis: 'accrual' }, `tb:a:${T['4000']}`, 'credit');
    expect(sales.total).toBe('100.00');
    expect(sales.ties).toBe(true);
    const total = await drilldownCell(tctx, 'trial-balance', { asOf: '2026-07-31', basis: 'accrual' }, 'tb:total', 'credit');
    expect(total.ties).toBe(true);
  });
});
