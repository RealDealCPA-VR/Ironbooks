/**
 * Regression tests from the payroll / banking review:
 *  1. Pay Liabilities relieves the account the paychecks credited (the Preferences payroll
 *     liabilities account, or a payroll item's own liability account) — not always 2300 — and
 *     the amount-due / by-item balances read those same accounts.
 *  2. A line cleared in an in-progress reconciliation whose entry is voided afterwards no
 *     longer counts toward the cleared balance (the session can't complete on a phantom amount).
 *  3. W-2 Box 12 lists codes in IRS order (AA after W, before DD) and Box 15 uses the work
 *     state (W-4 state, as withholding does) rather than the mailing-address state.
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
import { createEmployee, runPaycheck, updateEmployee } from './payroll';
import { createPayrollItem } from './payrollItems';
import { payPayrollLiabilities, payrollLiabilitiesDue } from './liabilityPayments';
import { payrollLiabilityBalances, w2Data } from './payrollReports';
import { postJournalEntry, voidJournalEntry } from './posting';
import { createBankAccount } from './bankAccounts';
import {
  startReconciliation,
  toggleCleared,
  listClearable,
  completeReconciliation,
  getProgress,
  getReconciliationReport,
} from './reconcile';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review-payroll');
let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};

async function bal(code: string) {
  const [r] = await db.select({ b: accounts.balance }).from(accounts).where(eq(accounts.id, acct[code]));
  return r.b;
}

describe('payroll / banking review regressions', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'rev-pay@test.local', name: 'R', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Rev Pay Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1010', 'Savings', 'asset', 'savings'],
      ['2300', 'Payroll Liabilities', 'liability', 'other_current_liability'],
      ['2310', 'Payroll Taxes Payable', 'liability', 'other_current_liability'],
      ['2320', 'Dental Payable', 'liability', 'other_current_liability'],
      ['4000', 'Sales', 'revenue', 'sales'],
      ['6500', 'Payroll Expense', 'expense', 'payroll'],
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

  it('pay liabilities relieves the preferred payroll liabilities account the paychecks credited', async () => {
    await updateCompany(ctx, { settings: { payrollLiabilityAccountId: acct['2310'] } } as never);
    const emp = await createEmployee(ctx, { firstName: 'A', lastName: 'B', payType: 'salary', payRate: 52000 });
    await runPaycheck(ctx, {
      employeeId: emp.id,
      payDate: new Date('2026-03-06T00:00:00Z'),
      grossPay: '1000.00',
      taxes: [{ kind: 'tax', name: 'Federal Income Tax', amount: '100.00' }],
      employerTaxes: [],
    });
    expect(await bal('2310')).toBe('100.00');
    expect(await payrollLiabilitiesDue(ctx)).toBe('100.00');
    await payPayrollLiabilities(ctx, { amount: '100.00', date: new Date('2026-03-10T00:00:00Z'), paymentAccountId: acct['1000'] });
    expect(await bal('2310')).toBe('0.00');
    expect(await bal('2300')).toBe('0.00');
    expect(await payrollLiabilitiesDue(ctx)).toBe('0.00');
  });

  it('an itemized payment relieves the payroll item\'s own liability account', async () => {
    const dental = await createPayrollItem(ctx, { name: 'Dental', kind: 'deduction', liabilityAccountId: acct['2320'] });
    const emp = await createEmployee(ctx, { firstName: 'C', lastName: 'D', payType: 'salary', payRate: 52000 });
    await runPaycheck(ctx, {
      employeeId: emp.id,
      payDate: new Date('2026-03-06T00:00:00Z'),
      grossPay: '1000.00',
      taxes: [{ kind: 'tax', name: 'Federal Income Tax', amount: '80.00' }],
      deductions: [{ kind: 'deduction', name: 'Dental', amount: '25.00', payrollItemId: dental.id }],
      employerTaxes: [],
    });
    expect(await bal('2320')).toBe('25.00');
    expect(await payrollLiabilitiesDue(ctx)).toBe('105.00');
    await payPayrollLiabilities(ctx, {
      date: new Date('2026-03-12T00:00:00Z'),
      paymentAccountId: acct['1000'],
      items: [
        { name: 'Dental', amount: '25.00' },
        { name: 'Federal Income Tax', amount: '80.00' },
      ],
    });
    expect(await bal('2320')).toBe('0.00');
    expect(await bal('2310')).toBe('0.00');
    expect(await bal('2300')).toBe('0.00');
    const balances = await payrollLiabilityBalances(ctx, { asOf: new Date('2026-03-31T00:00:00Z') });
    const dentalRow = balances.items.find((i) => i.name === 'Dental')!;
    expect(dentalRow.paid).toBe('25.00');
    expect(dentalRow.balance).toBe('0.00');
    expect(balances.balance).toBe('0.00');
  });

  it('a cleared line whose entry is voided mid-reconciliation no longer counts', async () => {
    const ba = await createBankAccount(ctx, { accountId: acct['1010'], bankName: 'Bank', accountNumber: '123456789' });
    const je = await postJournalEntry(ctx, {
      date: new Date('2026-04-02T00:00:00Z'),
      description: 'deposit',
      lines: [
        { accountId: acct['1010'], debit: '250.00' },
        { accountId: acct['4000'], credit: '250.00' },
      ],
    });
    const rec = await startReconciliation(ctx, {
      bankAccountId: ba.id,
      statementDate: new Date('2026-04-30T00:00:00Z'),
      statementBalance: '250.00',
    } as never);
    const lines = await listClearable(ctx, ba.id, new Date('2026-04-30T00:00:00Z'), rec.id);
    const line = lines.find((l) => l.journalEntryId === je.id)!;
    await toggleCleared(ctx, rec.id, line.journalEntryLineId, true);
    expect((await getProgress(ctx, rec.id)).clearedBalance).toBe('250.00');
    await voidJournalEntry(ctx, je.id);
    expect(await bal('1010')).toBe('0.00');
    expect((await getProgress(ctx, rec.id)).clearedBalance).toBe('0.00');
    expect((await getReconciliationReport(ctx, rec.id)).clearedTotal).toBe('0.00');
    // The GL holds 0 but the statement says 250 — must NOT reconcile.
    await expect(completeReconciliation(ctx, rec.id)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('W-2: Box 12 in IRS code order and Box 15 = the W-4 work state', async () => {
    const k401 = await createPayrollItem(ctx, { name: '401(k) Plan', kind: 'deduction', taxTracking: '401k', liabilityAccountId: acct['2300'] });
    const roth = await createPayrollItem(ctx, { name: 'Roth 401(k) Plan', kind: 'deduction', taxTracking: 'roth_401k', liabilityAccountId: acct['2300'] });
    const emp = await createEmployee(ctx, { firstName: 'E', lastName: 'F', payType: 'salary', payRate: 52000 });
    await updateEmployee(ctx, emp.id, { w4: { filingStatus: 'single', state: 'CA' }, address: { state: 'NY' } });
    await runPaycheck(ctx, {
      employeeId: emp.id,
      payDate: new Date('2025-05-02T00:00:00Z'),
      grossPay: '2000.00',
      taxes: [{ kind: 'tax', name: 'State Withholding (CA)', amount: '40.00', taxTracking: 'state_withholding' }],
      deductions: [
        { kind: 'deduction', name: 'Roth 401(k) Plan', amount: '50.00', payrollItemId: roth.id },
        { kind: 'deduction', name: '401(k) Plan', amount: '100.00', payrollItemId: k401.id },
      ],
      employerTaxes: [{ kind: 'employer_contribution', name: 'Employer Health', amount: '30.00' }],
    });
    const w2 = await w2Data(ctx, { employeeId: emp.id, year: 2025 });
    expect(w2.box12.map((b) => b.code)).toEqual(['D', 'AA', 'DD']);
    expect(w2.state.code).toBe('CA');
    expect(w2.state.withheld).toBe('40.00');
  });
});
