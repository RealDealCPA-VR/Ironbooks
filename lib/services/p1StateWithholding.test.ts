/**
 * P1 state income tax withholding on real paychecks and pay runs: the year-keyed engine is
 * applied automatically, posts to the State Withholding payroll item's liability account, lands
 * on W-2 Boxes 15-17 and the state wage worksheet, and never guesses for a state the app does
 * not model.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, journalEntryLines, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createAccount } from './accounts';
import { createEmployee, createPayRun, previewPaycheck, runPaycheck, updateEmployee } from './payroll';
import { ensureDefaultPayrollItems, listPayrollItems, updatePayrollItem } from './payrollItems';
import { stateWageWorksheet, w2Data } from './payrollReports';
import { trialBalance } from './reports';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-state-wh');
let db: DB;
let ctx: ServiceContext;
let stateLiabId: string;
const d = (s: string) => new Date(`${s}T00:00:00Z`);

async function newEmp(first: string, state: string, w4: Record<string, unknown> = {}) {
  const e = await createEmployee(ctx, { firstName: first, lastName: 'Worker', payType: 'salary', payRate: '52000' });
  await updateEmployee(ctx, e.id, { address: { line1: '1 Main', city: 'Town', state, zip: '00000' }, w4: { formYear: 2020, filingStatus: 'single', ...w4 } });
  return e.id;
}

describe('P1 state withholding on paychecks and pay runs', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'p1state@test.local', name: 'Owner', passwordHash: 'x' }).returning();
    const c = await createCompany(db, { name: 'State Co', ownerId: u.id });
    ctx = { db, companyId: c.id, userId: u.id };
    await ensureDefaultPayrollItems(ctx);
    // A dedicated State Withholding liability account on the State Withholding item.
    stateLiabId = (await createAccount(ctx, { code: '2315', name: 'State Withholding Payable', type: 'liability', subtype: 'other_current_liability' })).id;
    const items = await listPayrollItems(ctx);
    const st = items.find((i) => i.taxTracking === 'state_withholding')!;
    await updatePayrollItem(ctx, st.id, { liabilityAccountId: stateLiabId });
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('auto-calculates Pennsylvania withholding, posts it to the State Withholding liability, and notes local EIT', async () => {
    const pat = await newEmp('Pat', 'PA');
    const pc = await runPaycheck(ctx, { employeeId: pat, payDate: d('2025-03-07'), grossPay: '2000.00', periodsPerYear: 26 });
    const st = pc.lines.find((l) => l.taxTracking === 'state_withholding')!;
    expect(st).toMatchObject({ name: 'State Withholding (PA)', amount: '61.40' });
    expect(st.payrollItemId).toBeTruthy();
    expect(pc.notes.join(' ')).toMatch(/earned income tax/);
    const credits = await ctx.db
      .select({ credit: journalEntryLines.credit })
      .from(journalEntryLines)
      .where(and(eq(journalEntryLines.journalEntryId, pc.postedEntryId!), eq(journalEntryLines.accountId, stateLiabId)));
    expect(credits.map((c) => c.credit)).toEqual(['61.40']);
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('never guesses for a state the app does not model; uses the employee-entered percent', async () => {
    const ollie = await newEmp('Ollie', 'OR');
    const pv = await previewPaycheck(ctx, { employeeId: ollie, payDate: d('2025-03-07'), grossPay: '2000.00', periodsPerYear: 26 });
    expect(pv.lines.some((l) => l.taxTracking === 'state_withholding')).toBe(false);
    expect(pv.notes.join(' ')).toMatch(/Oregon income tax is not calculated/);
    await updateEmployee(ctx, ollie, { w4: { formYear: 2020, filingStatus: 'single', stateW4: { fallbackPercent: '5' } } });
    const pv2 = await previewPaycheck(ctx, { employeeId: ollie, payDate: d('2025-03-07'), grossPay: '2000.00', periodsPerYear: 26 });
    expect(pv2.lines.find((l) => l.taxTracking === 'state_withholding')?.amount).toBe('100.00');
  });

  it('pay runs apply the state withholding; W-2 Boxes 15-17 and the state wage worksheet report it', async () => {
    const ian = await newEmp('Ian', 'IL', { stateW4: { allowances: 1 } });
    const pat = (await previewPaycheck(ctx, { employeeId: ian, payDate: d('2025-03-21'), grossPay: '2000.00', periodsPerYear: 26 })).lines
      .find((l) => l.taxTracking === 'state_withholding');
    expect(pat?.amount).toBe('93.57');
    const run = await createPayRun(ctx, { payDate: d('2025-03-21'), periodsPerYear: 26, employees: [{ employeeId: ian }] });
    expect(run.results[0].ok).toBe(true);
    const w2 = await w2Data(ctx, { employeeId: ian, year: 2025 });
    expect(w2.state).toEqual({ code: 'IL', wages: '2000.00', withheld: '93.57' });
    const ws = await stateWageWorksheet(ctx, { state: 'IL', year: 2025, quarter: 1 });
    expect(ws.totals.stateWithheld).toBe('93.57');
  });

  it('validates the state W-4 and keeps it normalized', async () => {
    const az = await newEmp('Ari', 'AZ');
    await expect(updateEmployee(ctx, az, { w4: { stateW4: { rate: '4' } } })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateEmployee(ctx, az, { w4: { stateW4: { allowances: -1 } } })).rejects.toMatchObject({ code: 'VALIDATION' });
    const saved = await updateEmployee(ctx, az, { w4: { formYear: 2020, filingStatus: 'single', stateW4: { rate: '3.5', allowances: '', extraWithholding: '' } } });
    expect((saved.w4 as Record<string, unknown>).stateW4).toEqual({ rate: '3.5' });
    const pv = await previewPaycheck(ctx, { employeeId: az, payDate: d('2025-03-07'), grossPay: '2000.00', periodsPerYear: 26 });
    expect(pv.lines.find((l) => l.taxTracking === 'state_withholding')?.amount).toBe('70.00');
  });

  it('a pay date after the last table year warns instead of silently using old tables', async () => {
    const ken = await newEmp('Ken', 'KY');
    const pv = await previewPaycheck(ctx, { employeeId: ken, payDate: d('2027-01-15'), grossPay: '2000.00', periodsPerYear: 26 });
    const text = pv.notes.join(' ');
    expect(text).toMatch(/Federal withholding tables for 2027/);
    expect(text).toMatch(/Kentucky withholding tables for 2027 are not in this version; the 2026 figures were used/);
  });

  it('a no-tax state adds nothing', async () => {
    const tex = await newEmp('Tex', 'TX');
    const pv = await previewPaycheck(ctx, { employeeId: tex, payDate: d('2025-03-07'), grossPay: '2000.00', periodsPerYear: 26 });
    expect(pv.lines.some((l) => l.taxTracking === 'state_withholding')).toBe(false);
    const accts = await ctx.db.select().from(accounts).where(eq(accounts.id, stateLiabId));
    expect(accts).toHaveLength(1);
  });
});
