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
