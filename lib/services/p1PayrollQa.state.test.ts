/**
 * Independent QA (tester) for the P1 state income tax withholding engine and its use on
 * paychecks, edited / voided paychecks, overrides and pay runs.
 *
 * Engine numbers are checked by hand from each state's published formula (flat-rate states and
 * simple bracket states only — figures the doer flagged as unverified are not asserted here).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, employees, journalEntryLines, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createAccount } from './accounts';
import {
  createEmployee,
  createPayRun,
  editPaycheck,
  previewPaycheck,
  runPaycheck,
  updateEmployee,
  voidPaycheck,
} from './payroll';
import { ensureDefaultPayrollItems, listPayrollItems, updatePayrollItem } from './payrollItems';
import { trialBalance } from './reports';
import { calculateStateWithholding, normalizeStateW4, statePerPeriod } from './statePayrollTax';
import { Money } from '@/lib/money';

// ---------------------------------------------------------------------------
// Pure engine
// ---------------------------------------------------------------------------

const calc = (state: string, wages: string, stateW4: Record<string, unknown> = {}, year = 2025, periods = 26, extra: Partial<Parameters<typeof calculateStateWithholding>[0]> = {}) =>
  calculateStateWithholding({ state, year, wagesPerPeriod: wages, periodsPerYear: periods, stateW4, ...extra });

describe('state withholding engine — hand-checked figures', () => {
  it('flat-rate states (2025)', () => {
    // MI: (52,000 − 2 × 5,800) × 4.25% / 26 = 66.04
    expect(calc('MI', '2000.00', { allowances: 2 }).amount).toBe('66.04');
    // KY: (52,000 − 3,270) × 4% / 26 = 74.97
    expect(calc('KY', '2000.00').amount).toBe('74.97');
    // GA single: (52,000 − 12,000) × 5.19% / 26 = 79.85
    expect(calc('GA', '2000.00', { filingStatus: 'single' }).amount).toBe('79.85');
    // CO with no DR 0004: 4.4% of wages, and a note says no allowance was subtracted.
    const co = calc('CO', '2000.00');
    expect(co.amount).toBe('88.00');
    expect(co.notes.join(' ')).toMatch(/DR 0004/);
    // AZ with no A-4: 2.0% of gross.
    expect(calc('AZ', '2000.00').amount).toBe('40.00');
    // PA: 3.07%, no allowances; rounding to the penny.
    expect(calc('PA', '1234.57').amount).toBe('37.90');
  });

  it('bracket / exemption states (2025)', () => {
    // VA: 52,000 − 8,500 − 930 = 42,570 → 60 + 60 + 600 + 1,470.275 = 2,190.275 / 26 = 84.24
    expect(calc('VA', '2000.00', { allowances: 1 }).amount).toBe('84.24');
    // MA: FICA deduction capped at $2,000: (52,000 − 4,400 − 2,000) × 5% / 26 = 87.69
    expect(calc('MA', '2000.00', { allowances: 1 }, 2025, 26, { ficaTaxPerPeriod: '153.00' }).amount).toBe('87.69');
    // NJ married with no table chosen → table B: 51,000 → 300 + 600 + 24.50 = 924.50 / 26 = 35.56
    expect(calc('NJ', '2000.00', { filingStatus: 'married', allowances: 1 }).amount).toBe('35.56');
  });

  it('extra withholding is added on top; exempt and no-tax states withhold nothing', () => {
    expect(calc('PA', '2000.00', { extraWithholding: '10.00' }).amount).toBe('71.40');
    expect(calc('IL', '2000.00', { exempt: true })).toMatchObject({ amount: '0.00', method: 'exempt' });
    expect(calc('TX', '2000.00', { exempt: true, extraWithholding: '25' })).toMatchObject({ amount: '0.00', method: 'none' });
  });

  it('a year before the first table also says which table it used', () => {
    const r = calc('IL', '2000.00', {}, 2024);
    expect(r.tableYear).toBe(2025);
    expect(r.notes.join(' ')).toMatch(/2024/);
  });

  it('never guesses for an unmodelled state; percent beats amount; extra alone is honoured', () => {
    expect(calc('OR', '2000.00')).toMatchObject({ amount: '0.00', method: 'not_set_up' });
    expect(calc('OR', '2000.00', { fallbackPercent: '5', fallbackAmount: '30' })).toMatchObject({ amount: '100.00', method: 'employee_percent' });
    expect(calc('OR', '2000.00', { fallbackAmount: '30', extraWithholding: '5' })).toMatchObject({ amount: '35.00', method: 'employee_amount' });
    expect(calc('OR', '2000.00', { extraWithholding: '5' }).amount).toBe('5.00');
    // A percent that produces fractions of a cent rounds to the penny.
    expect(calc('WI', '1000.01', { fallbackPercent: '3.3333' }).amount).toBe('33.33');
  });

  it('rejects bad inputs', () => {
    expect(() => calc('ZZ', '100')).toThrow();
    expect(() => calc('IL', '100', {}, 2025, 0)).toThrow();
    expect(() => calc('AZ', '100', { rate: '4' })).toThrow();
    // Lower-case state codes work in the calculator helper.
    expect(statePerPeriod({ grossPerPeriod: '2000', periodsPerYear: 26, state: 'pa', year: 2025 }).stateTax).toBe('61.40');
  });

  it('normalizeStateW4 refuses malformed certificates', () => {
    expect(() => normalizeStateW4({ allowances: '2.5' })).toThrow();
    expect(() => normalizeStateW4({ allowances: 100 })).toThrow();
    expect(() => normalizeStateW4({ extraWithholding: '-5' })).toThrow();
    expect(() => normalizeStateW4({ extraWithholding: '25.001' })).toThrow();
    expect(() => normalizeStateW4({ fallbackPercent: '101' })).toThrow();
    expect(() => normalizeStateW4({ rate: 'abc' })).toThrow();
    expect(() => normalizeStateW4({ njTable: 'C' })).toThrow();
    expect(() => normalizeStateW4({ filingStatus: 'widow' })).toThrow();
    expect(() => normalizeStateW4([1, 2])).toThrow();
    expect(normalizeStateW4({ rate: '3.50', allowances: '2', exempt: false })).toEqual({ rate: '3.5', allowances: 2 });
    expect(normalizeStateW4({ allowances: '', extraWithholding: '' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Paychecks, edits, voids, overrides, pay runs
// ---------------------------------------------------------------------------

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-payroll-qa-state');
let db: DB;
let userId: string;
let ctx: ServiceContext;
let stateLiabId: string;
let stateItemId: string;
const d = (s: string) => new Date(`${s}T00:00:00Z`);

async function newEmp(c: ServiceContext, first: string, state: string, w4: Record<string, unknown> = {}) {
  const e = await createEmployee(c, { firstName: first, lastName: 'Qa', payType: 'salary', payRate: '52000' });
  await updateEmployee(c, e.id, { address: { line1: '1 Main', city: 'Town', state, zip: '00000' }, w4: { formYear: 2020, filingStatus: 'single', ...w4 } });
  return e.id;
}

async function balanceOf(c: ServiceContext, accountId: string) {
  const [a] = await c.db.select().from(accounts).where(eq(accounts.id, accountId));
  return Money.of(a.balance).abs().toFixed(2);
}

describe('state withholding on paychecks — tester QA', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'p1stateqa@test.local', name: 'Owner', passwordHash: 'x' }).returning();
    userId = u.id;
    const c = await createCompany(db, { name: 'State QA Co', ownerId: userId });
    ctx = { db, companyId: c.id, userId };
    await ensureDefaultPayrollItems(ctx);
    stateLiabId = (await createAccount(ctx, { code: '2316', name: 'State WH Payable', type: 'liability', subtype: 'other_current_liability' })).id;
    const st = (await listPayrollItems(ctx)).find((i) => i.taxTracking === 'state_withholding')!;
    stateItemId = st.id;
    await updatePayrollItem(ctx, st.id, { liabilityAccountId: stateLiabId });
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('edit paycheck recalculates state withholding; void reverses it; the ledger stays balanced', async () => {
    const id = await newEmp(ctx, 'Edna', 'IL');
    const pc = await runPaycheck(ctx, { employeeId: id, payDate: d('2025-04-04'), grossPay: '2000.00', periodsPerYear: 26 });
    expect(pc.lines.find((l) => l.taxTracking === 'state_withholding')?.amount).toBe('99.00'); // 2,000 × 4.95%
    expect(await balanceOf(ctx, stateLiabId)).toBe('99.00');

    const edited = await editPaycheck(ctx, pc.id, { payDate: d('2025-04-04'), grossPay: '3000.00', periodsPerYear: 26 });
    expect(edited.lines.find((l) => l.taxTracking === 'state_withholding')?.amount).toBe('148.50');
    expect(await balanceOf(ctx, stateLiabId)).toBe('148.50');
    // Net pay = gross − every employee tax (incl. state) − deductions.
    const taxes = edited.lines.filter((l) => l.kind === 'tax').reduce((s, l) => s.plus(l.amount), Money.zero());
    expect(Money.of(edited.netPay).toFixed(2)).toBe(Money.of(edited.grossPay).minus(taxes).toFixed(2));

    await voidPaycheck(ctx, pc.id);
    expect(await balanceOf(ctx, stateLiabId)).toBe('0.00');
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('a typed-over State Withholding amount wins (and 0 removes the line)', async () => {
    const id = await newEmp(ctx, 'Otto', 'PA');
    const pv = await previewPaycheck(ctx, {
      employeeId: id, payDate: d('2025-04-04'), grossPay: '2000.00', periodsPerYear: 26,
      taxOverrides: [{ payrollItemId: stateItemId, amount: '12.34' }],
    });
    const lines = pv.lines.filter((l) => l.taxTracking === 'state_withholding');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ name: 'State Withholding (PA)', amount: '12.34' });
    const zero = await previewPaycheck(ctx, {
      employeeId: id, payDate: d('2025-04-04'), grossPay: '2000.00', periodsPerYear: 26,
      taxOverrides: [{ payrollItemId: stateItemId, amount: '0' }],
    });
    expect(zero.lines.some((l) => l.taxTracking === 'state_withholding')).toBe(false);
  });

  it('exempt employees get no line and a plain note', async () => {
    const id = await newEmp(ctx, 'Exa', 'IL', { stateW4: { exempt: true } });
    const pv = await previewPaycheck(ctx, { employeeId: id, payDate: d('2025-04-04'), grossPay: '2000.00', periodsPerYear: 26 });
    expect(pv.lines.some((l) => l.taxTracking === 'state_withholding')).toBe(false);
    expect(pv.notes.join(' ')).toMatch(/exempt from Illinois/);
  });

  it('pay run across states: modelled, no-tax and not-set-up states; liability equals the lines; notes reach the result', async () => {
    const before = Money.of(await balanceOf(ctx, stateLiabId));
    const il = await newEmp(ctx, 'Ivy', 'IL');
    const tx = await newEmp(ctx, 'Tia', 'TX');
    const or = await newEmp(ctx, 'Ora', 'OR');
    const run = await createPayRun(ctx, {
      payDate: d('2025-05-30'), periodsPerYear: 12,
      employees: [{ employeeId: il }, { employeeId: tx }, { employeeId: or }],
    });
    expect(run.results.every((r) => r.ok)).toBe(true);
    const orRes = run.results.find((r) => r.employeeId === or)!;
    expect((orRes.notes ?? []).join(' ')).toMatch(/Oregon income tax is not calculated/);
    // Monthly salary 52,000 / 12 = 4,333.33 → IL 4.95% × 12 periods annualized / 12 = 214.50
    const ilPv = await previewPaycheck(ctx, { employeeId: il, payDate: d('2025-06-30'), grossPay: '4333.33', periodsPerYear: 12 });
    expect(ilPv.lines.find((l) => l.taxTracking === 'state_withholding')?.amount).toBe('214.50');
    const posted = await ctx.db
      .select({ credit: journalEntryLines.credit })
      .from(journalEntryLines)
      .where(and(eq(journalEntryLines.accountId, stateLiabId)));
    expect(posted.length).toBeGreaterThan(0);
    expect(Money.of(await balanceOf(ctx, stateLiabId)).minus(before).toFixed(2)).toBe('214.50');
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('a company with no State Withholding payroll item still posts the withholding (to Payroll Liabilities) and balances', async () => {
    const c = await createCompany(db, { name: 'No Items Co', ownerId: userId });
    const nctx: ServiceContext = { db, companyId: c.id, userId };
    const id = await newEmp(nctx, 'Nell', 'IL');
    const pc = await runPaycheck(nctx, { employeeId: id, payDate: d('2025-04-04'), grossPay: '2000.00', periodsPerYear: 26 });
    const st = pc.lines.find((l) => l.taxTracking === 'state_withholding');
    expect(st?.amount).toBe('99.00');
    const taxes = pc.lines.filter((l) => l.kind === 'tax').reduce((s, l) => s.plus(l.amount), Money.zero());
    expect(Money.of(pc.netPay).toFixed(2)).toBe(Money.of('2000').minus(taxes).toFixed(2));
    expect((await trialBalance(nctx)).balanced).toBe(true);
    // Never posts into another company's State Withholding account.
    const leaked = await db.select().from(journalEntryLines).where(and(eq(journalEntryLines.journalEntryId, pc.postedEntryId!), eq(journalEntryLines.accountId, stateLiabId)));
    expect(leaked).toHaveLength(0);
  });

  it('a rejected state W-4 leaves the stored W-4 untouched', async () => {
    const id = await newEmp(ctx, 'Vera', 'AZ', { stateW4: { rate: '3' } });
    await expect(updateEmployee(ctx, id, { w4: { formYear: 2020, filingStatus: 'single', stateW4: { rate: '9' } } })).rejects.toMatchObject({ code: 'VALIDATION' });
    const [row] = await db.select().from(employees).where(eq(employees.id, id));
    expect((row.w4 as Record<string, unknown>).stateW4).toEqual({ rate: '3' });
    // Clearing the state W-4 (null) removes it.
    await updateEmployee(ctx, id, { w4: { formYear: 2020, filingStatus: 'single', stateW4: null } });
    const [row2] = await db.select().from(employees).where(eq(employees.id, id));
    expect('stateW4' in (row2.w4 as Record<string, unknown>)).toBe(false);
  });
});
