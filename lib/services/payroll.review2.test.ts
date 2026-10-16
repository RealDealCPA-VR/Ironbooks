/**
 * Regression tests from the round-2 payroll / banking review:
 *  1. Itemized Pay Liabilities relieves the account the paychecks credited, not a same-named
 *     payroll item the paychecks never used.
 *  2. Liability / YTD adjustments that affect accounts post to the Preferences payroll
 *     liabilities account, as paychecks do.
 *  3. A cleared line voided before completion is un-cleared at completion, so the completed
 *     session's report and the discrepancy report don't count it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, accounts } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { updateCompany } from './company';
import { createEmployee, runPaycheck } from './payroll';
import { ensureDefaultPayrollItems } from './payrollItems';
import { payPayrollLiabilities } from './liabilityPayments';
import { createLiabilityAdjustment } from './payrollAdjustments';
import { postJournalEntry, voidJournalEntry } from './posting';
import { createBankAccount } from './bankAccounts';
import {
  startReconciliation,
  toggleCleared,
  listClearable,
  completeReconciliation,
  getReconciliationReport,
  reconciliationDiscrepancies,
} from './reconcile';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review2-payroll');
let db: DB;
let n = 0;

async function newCompany() {
  n += 1;
  const [user] = await db.insert(users).values({ email: `rev2-pay-${n}@test.local`, name: 'R', passwordHash: 'x' }).returning();
  const [company] = await db.insert(companies).values({ name: `Rev2 Pay ${n}`, ownerId: user.id }).returning();
  const ctx: ServiceContext = { db, companyId: company.id, userId: user.id };
  const acct: Record<string, string> = {};
  const defs: Array<[string, string, string, string]> = [
    ['1000', 'Checking', 'asset', 'checking'],
    ['1010', 'Savings', 'asset', 'savings'],
    ['2300', 'Payroll Liabilities', 'liability', 'other_current_liability'],
    ['2310', 'Payroll Taxes Payable', 'liability', 'other_current_liability'],
    ['4000', 'Sales', 'revenue', 'sales'],
    ['6500', 'Payroll Expense', 'expense', 'payroll'],
  ];
  for (const [code, name, type, subtype] of defs) {
    const row = await createAccount(ctx, { code, name, type: type as never, subtype });
    acct[code] = row.id;
  }
  const bal = async (code: string) => {
    const [r] = await db.select({ b: accounts.balance }).from(accounts).where(eq(accounts.id, acct[code]));
    return r.b;
  };
  return { ctx, acct, bal };
}

describe('review round 2 — payroll / banking', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
  });
  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('itemized Pay Liabilities relieves the account the paycheck credited, not a same-named item the paycheck never used', async () => {
    const { ctx, acct, bal } = await newCompany();
    await ensureDefaultPayrollItems(ctx); // seeded "Social Security" item -> 2300
    await updateCompany(ctx, { settings: { payrollLiabilityAccountId: acct['2310'] } } as never);
    const emp = await createEmployee(ctx, { firstName: 'A', lastName: 'B', payType: 'salary', payRate: 52000 });
    await runPaycheck(ctx, {
      employeeId: emp.id,
      payDate: new Date('2026-03-06T00:00:00Z'),
      grossPay: '1000.00',
      taxes: [{ kind: 'tax', name: 'Social Security', amount: '62.00' }], // no payroll item -> Preferences account
      employerTaxes: [],
    });
    expect(await bal('2310')).toBe('62.00');
    await payPayrollLiabilities(ctx, {
      date: new Date('2026-03-10T00:00:00Z'),
      paymentAccountId: acct['1000'],
      items: [{ name: 'Social Security', amount: '62.00' }],
    });
    expect(await bal('2310')).toBe('0.00');
    expect(await bal('2300')).toBe('0.00');
  });

  it('a liability adjustment that affects accounts posts to the Preferences payroll liabilities account (as paychecks do)', async () => {
    const { ctx, acct, bal } = await newCompany();
    await updateCompany(ctx, { settings: { payrollLiabilityAccountId: acct['2310'] } } as never);
    const emp = await createEmployee(ctx, { firstName: 'C', lastName: 'D', payType: 'salary', payRate: 52000 });
    await createLiabilityAdjustment(ctx, {
      employeeId: emp.id,
      date: new Date('2026-03-06T00:00:00Z'),
      lines: [{ kind: 'tax', name: 'Federal Income Tax', amount: '10.00' }],
      affectsAccounts: true,
      offsetAccountId: acct['6500'],
    });
    expect(await bal('2310')).toBe('10.00');
    expect(await bal('2300')).toBe('0.00');
  });

  it('a line voided mid-session does not appear in the completed reconciliation report or the discrepancy report', async () => {
    const { ctx, acct } = await newCompany();
    const ba = await createBankAccount(ctx, { accountId: acct['1010'], bankName: 'Bank', accountNumber: '123456789' });
    const mk = (amt: string) =>
      postJournalEntry(ctx, {
        date: new Date('2026-04-02T00:00:00Z'),
        description: `dep ${amt}`,
        lines: [
          { accountId: acct['1010'], debit: amt },
          { accountId: acct['4000'], credit: amt },
        ],
      });
    const je1 = await mk('250.00');
    const je2 = await mk('100.00');
    const rec = await startReconciliation(ctx, {
      bankAccountId: ba.id,
      statementDate: new Date('2026-04-30T00:00:00Z'),
      statementBalance: '100.00',
    } as never);
    const lines = await listClearable(ctx, ba.id, new Date('2026-04-30T00:00:00Z'), rec.id);
    for (const je of [je1, je2]) {
      await toggleCleared(ctx, rec.id, lines.find((l) => l.journalEntryId === je.id)!.journalEntryLineId, true);
    }
    await voidJournalEntry(ctx, je1.id); // voided BEFORE completion
    await completeReconciliation(ctx, rec.id); // 100 = 100, completes
    const report = await getReconciliationReport(ctx, rec.id);
    expect(report.clearedTotal).toBe('100.00');
    expect(report.difference).toBe('0.00');
    expect(report.discrepancies).toHaveLength(0);
    expect(await reconciliationDiscrepancies(ctx, ba.id)).toHaveLength(0);
  });
});
