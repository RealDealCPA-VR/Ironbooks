/**
 * Review round 5 — transactions added from the bank feed or an imported statement.
 *
 * Categorizing a downloaded / imported bank line (Bank Feeds "Add", bank rules, the statement
 * PDF / Excel import of v1.4) posts an entry whose source is the bank line. Every report showed
 * those as Type "Other" with no Name — in QuickBooks a withdrawal added from the feed is a Check
 * and a deposit a Deposit, with the payee as the Name — and the Transaction type filter could not
 * find them as checks or deposits.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, bankTransactions, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createBankAccount } from './bankAccounts';
import { categorize } from './bankCategorize';
import { runStandardReport } from './reportRegistry';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-bank-feed-reports');
let db: DB;
let ctx: ServiceContext;
const A: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'r5-feed@test.local', name: 'R5 Feed', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Feed Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) A[a.code] = a.id;
  const ba = await createBankAccount(ctx, { accountId: A['1000'], bankName: 'Main', accountNumber: '000123' } as never);
  const line = async (date: string, amount: string, payee: string | null, description: string) => {
    const [t] = await db
      .insert(bankTransactions)
      .values({ companyId: company.id, bankAccountId: ba.id, date: d(date), amount, payee, description })
      .returning();
    return t.id;
  };
  await categorize(ctx, { bankTransactionId: await line('2026-05-03', '-45.00', null, 'SHELL OIL 1234'), accountId: A['6000'], payee: 'Shell' });
  await categorize(ctx, { bankTransactionId: await line('2026-05-04', '100.00', 'Square', 'SQUARE DEP'), accountId: A['4000'] });
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

const bankLines = (r: { rows: { cells: Record<string, unknown>; entryId?: string | null }[] }) =>
  r.rows.filter((x) => x.entryId && x.cells.account !== undefined);

describe('bank-feed transactions on reports', () => {
  it('a withdrawal is a Check and a deposit a Deposit, with the payee as the Name', async () => {
    const r = await runStandardReport(ctx, 'transaction-detail-by-account', { accountId: A['1000'], from: '2026-05-01', to: '2026-05-31' });
    const rows = r.rows.filter((x) => x.entryId).map((x) => [x.cells.type, x.cells.name, x.cells.amount]);
    expect(rows).toEqual([
      ['Check', 'Shell', '-45.00'],
      ['Deposit', 'Square', '100.00'],
    ]);
  });

  it('the Transaction type filter finds them as checks / deposits, not as Other', async () => {
    const base = { from: '2026-05-01', to: '2026-05-31' };
    const checks = await runStandardReport(ctx, 'transaction-detail-by-account', { ...base, txnType: 'check' });
    expect(checks.rows.filter((x) => x.entryId).map((x) => x.cells.name)).toEqual(['Shell', 'Shell']);
    const deposits = await runStandardReport(ctx, 'transaction-detail-by-account', { ...base, txnType: 'deposit' });
    expect(deposits.rows.filter((x) => x.entryId).map((x) => x.cells.name)).toEqual(['Square', 'Square']);
    const other = await runStandardReport(ctx, 'transaction-detail-by-account', { ...base, txnType: 'other' });
    expect(other.rows.filter((x) => x.entryId)).toHaveLength(0);
  });

  it('Expenses by Vendor Detail groups the check under its payee', async () => {
    const r = await runStandardReport(ctx, 'expenses-by-vendor-detail', { from: '2026-05-01', to: '2026-05-31', basis: 'accrual' });
    expect(r.rows.filter((x) => x.kind === 'section').map((x) => x.cells.label)).toEqual(['Shell']);
    void bankLines;
  });
});

/**
 * The Num column showed internal ids: a paycheck not yet printed carries its id's first eight
 * characters as the entry reference ("3f2a9c1d" — it looks like a check number), and other
 * postings carry codes such as "landed-cost:<id>". QuickBooks shows the check number, or nothing.
 */
describe('Num column never shows internal ids', () => {
  it('an unprinted paycheck has no number; a printed one shows its check number', async () => {
    const { createEmployee, runPaycheck } = await import('./payroll');
    const { markPaycheckPrinted, queuePaychecks } = await import('./printQueue');
    const emp = await createEmployee(ctx, { firstName: 'Pat', lastName: 'Payee', payType: 'salary', payRate: 52000 } as never);
    const unprinted = await runPaycheck(ctx, { employeeId: emp.id, payDate: d('2026-06-05'), grossPay: '500.00', taxes: [], employerTaxes: [] } as never);
    const printed = await runPaycheck(ctx, { employeeId: emp.id, payDate: d('2026-06-06'), grossPay: '600.00', taxes: [], employerTaxes: [] } as never);
    await queuePaychecks(ctx, [printed.id]);
    await markPaycheckPrinted(ctx, { paycheckId: printed.id, checkNumber: '2001' });
    const r = await runStandardReport(ctx, 'transaction-detail-by-account', { accountId: A['1000'], from: '2026-06-01', to: '2026-06-30' });
    const nums = r.rows.filter((x) => x.entryId).map((x) => [x.cells.type, x.cells.num, x.cells.amount]);
    expect(nums).toEqual([
      ['Paycheck', '', '-500.00'],
      ['Paycheck', '2001', '-600.00'],
    ]);
    expect(JSON.stringify(nums)).not.toContain(unprinted.id.slice(0, 8));
  });
});

/**
 * Fix pass 2: a categorized feed line's memo showed in the Num column (bankCategorize writes the
 * memo into the entry's reference). In QuickBooks Num is the check / document number — blank for
 * a feed line, which carries no check number — and the memo stays in the Memo column.
 */
describe('bank-feed lines: the memo is not the Num', () => {
  it('Num is blank and the memo shows under Memo', async () => {
    const { bankAccounts } = await import('@/lib/db/schema');
    const [ba] = await db.select().from(bankAccounts).where(eq(bankAccounts.companyId, ctx.companyId));
    const [t] = await db
      .insert(bankTransactions)
      .values({ companyId: ctx.companyId, bankAccountId: ba.id, date: d('2026-07-02'), amount: '-30.00', payee: 'Shell', description: 'SHELL OIL 9876' })
      .returning();
    await categorize(ctx, { bankTransactionId: t.id, accountId: A['6000'], payee: 'Shell', memo: 'Fuel for truck' });
    const r = await runStandardReport(ctx, 'transaction-detail-by-account', { accountId: A['1000'], from: '2026-07-01', to: '2026-07-31' });
    const rows = r.rows.filter((x) => x.entryId).map((x) => [x.cells.type, x.cells.num, x.cells.memo, x.cells.amount]);
    expect(rows).toEqual([['Check', '', 'Fuel for truck', '-30.00']]);
    const gl = await runStandardReport(ctx, 'general-ledger', { from: '2026-07-01', to: '2026-07-31' });
    const glNums = gl.rows.filter((x) => x.entryId).map((x) => x.cells.num);
    expect(glNums.length).toBeGreaterThan(0);
    expect(glNums.every((n) => n === '')).toBe(true);
  });
});
