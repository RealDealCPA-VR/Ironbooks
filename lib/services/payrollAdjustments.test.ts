/**
 * Wave-2 payroll: mid-year YTD setup (E3), edit paycheck (E4), adjust liabilities (E5),
 * employer SUI / employee SDI + state wage worksheet (E6), workers comp (E7) and the new
 * reports (E8). Hermetic PGlite company with the default chart of accounts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  accounts,
  bankAccounts,
  journalEntries,
  journalEntryLines,
  paycheckLines,
  reconciliationItems,
  reconciliations,
  users,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { trialBalance } from './reports';
import { createEmployee, editPaycheck, listPaychecks, payStubData, runPaycheck, updateEmployee } from './payroll';
import {
  createLiabilityAdjustment,
  createWorkersCompCode,
  createYtdAdjustment,
  listPayrollAdjustments,
  upsertStateTaxSetting,
  voidPayrollAdjustment,
} from './payrollAdjustments';
import {
  employeeEarningsSummary,
  form941Data,
  payrollItemDetail,
  payrollLiabilityBalances,
  payrollSummary,
  payrollTransactionsByPayee,
  stateWageWorksheet,
  w2Data,
  workersCompSummary,
} from './payrollReports';
import { exportCompanyData } from './backup';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-payroll-adjustments-w2');
let db: DB;
let ctx: ServiceContext;

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

async function entryCount() {
  const rows = await ctx.db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId));
  return rows.length;
}

async function linesOf(paycheckId: string) {
  const rows = await ctx.db.select().from(paycheckLines).where(eq(paycheckLines.paycheckId, paycheckId));
  return Object.fromEntries(rows.map((l) => [`${l.kind}:${l.name}`, l.amount]));
}

describe('payroll adjustments, edit paycheck, state taxes, workers comp', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'w2payroll@test.local', name: 'Owner', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'Wave2 Payroll Co', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // E3 — mid-year YTD setup
  // -------------------------------------------------------------------------
  describe('mid-year YTD amounts (no GL by default)', () => {
    let empId: string;
    let ytdId: string;
    let aprilCheckId: string;

    it('records Q1 history without touching the ledger', async () => {
      const emp = await createEmployee(ctx, { firstName: 'Ann', lastName: 'Early', payType: 'salary', payRate: '400000' });
      empId = emp.id;
      const before = await entryCount();
      const ytd = await createYtdAdjustment(ctx, {
        employeeId: empId,
        date: d('2026-03-31'),
        memo: 'Q1 from old payroll',
        lines: [
          { kind: 'earning', name: 'Salary', amount: '170000.00' },
          { kind: 'tax', name: 'Federal Income Tax', amount: '30000.00' },
          { kind: 'tax', name: 'Social Security', amount: '10540.00' },
          { kind: 'tax', name: 'Medicare', amount: '2465.00' },
          { kind: 'employer_contribution', name: 'Employer Social Security', amount: '10540.00' },
          { kind: 'employer_contribution', name: 'Employer Medicare', amount: '2465.00' },
          { kind: 'employer_contribution', name: 'Federal Unemployment (FUTA)', amount: '42.00' },
        ],
      });
      ytdId = ytd.id;
      expect(ytd.postedEntryId).toBeNull();
      expect(ytd.grossPay).toBe('170000.00');
      expect(ytd.netPay).toBe('126995.00');
      expect(await entryCount()).toBe(before); // GL untouched — the GL import already has it
      expect((await trialBalance(ctx)).balanced).toBe(true);
    });

    it('counts toward the Social Security wage base of later checks', async () => {
      const pc = await runPaycheck(ctx, { employeeId: empId, payDate: d('2026-04-15'), grossPay: '20000.00' });
      aprilCheckId = pc.id;
      const l = await linesOf(pc.id);
      // 2026 base 184,500 − 170,000 YTD = 14,500 taxable → 899.00
      expect(l['tax:Social Security']).toBe('899.00');
      expect(l['employer_contribution:Employer Social Security']).toBe('899.00');
      expect(l['employer_contribution:Federal Unemployment (FUTA)']).toBeUndefined(); // 7,000 base used up
    });

    it('appears on the W-2, the quarterly 941s, pay-stub YTD and payroll reports', async () => {
      const w2 = await w2Data(ctx, { employeeId: empId, year: 2026 });
      expect(w2.wages).toBe('190000.00');
      expect(w2.ssWages).toBe('184500.00'); // capped at the 2026 base
      expect(w2.socialSecurity).toBe('11439.00');
      const q1 = await form941Data(ctx, { quarter: 1, year: 2026 });
      expect(q1.totals.wages).toBe('170000.00');
      expect(q1.totals.employeeSocialSecurity).toBe('10540.00');
      const q2 = await form941Data(ctx, { quarter: 2, year: 2026 });
      expect(q2.totals.wages).toBe('20000.00');
      const stub = await payStubData(ctx, aprilCheckId);
      expect(stub.ytd.gross).toBe('190000.00');
      const summary = await payrollSummary(ctx, { from: d('2026-01-01'), to: d('2026-12-31'), employeeId: empId });
      expect(summary.totals.gross).toBe('190000.00');
    });

    it('is not a paycheck and does not inflate liabilities owed', async () => {
      const list = await listPaychecks(ctx, { employeeId: empId });
      expect(list.map((p) => p.id)).toEqual([aprilCheckId]);
      const liab = await payrollLiabilityBalances(ctx, { asOf: d('2026-12-31') });
      const fit = liab.items.find((i) => i.name === 'Federal Income Tax');
      // Only the April check's withholding is owed; Q1's was settled before the move.
      expect(Number(fit?.accrued)).toBeLessThan(30000);
      const adj = await listPayrollAdjustments(ctx, { employeeId: empId });
      expect(adj).toHaveLength(1);
      expect(adj[0].affectsAccounts).toBe(false);
    });

    it('voiding removes it from the W-2', async () => {
      await voidPayrollAdjustment(ctx, ytdId);
      const w2 = await w2Data(ctx, { employeeId: empId, year: 2026 });
      expect(w2.wages).toBe('20000.00');
    });
  });

  it('a YTD entry that affects accounts posts a balanced entry and voids cleanly', async () => {
    const emp = await createEmployee(ctx, { firstName: 'Bo', lastName: 'Posted', payType: 'hourly', payRate: '20' });
    const ytd = await createYtdAdjustment(ctx, {
      employeeId: emp.id,
      date: d('2026-02-28'),
      affectsAccounts: true,
      lines: [
        { kind: 'earning', name: 'Hourly', amount: '1000.00' },
        { kind: 'tax', name: 'Federal Income Tax', amount: '80.00' },
        { kind: 'tax', name: 'Social Security', amount: '62.00' },
        { kind: 'tax', name: 'Medicare', amount: '14.50' },
        { kind: 'employer_contribution', name: 'Employer Social Security', amount: '62.00' },
      ],
    });
    expect(ytd.postedEntryId).not.toBeNull();
    const lines = await ctx.db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, ytd.postedEntryId!));
    const dr = lines.reduce((s, l) => s + Number(l.debit ?? 0), 0);
    const cr = lines.reduce((s, l) => s + Number(l.credit ?? 0), 0);
    expect(dr).toBeCloseTo(1062, 2);
    expect(cr).toBeCloseTo(1062, 2);
    expect((await trialBalance(ctx)).balanced).toBe(true);
    await voidPayrollAdjustment(ctx, ytd.id);
    const [je] = await ctx.db.select().from(journalEntries).where(eq(journalEntries.id, ytd.postedEntryId!));
    expect(je.status).toBe('void');
  });

  // -------------------------------------------------------------------------
  // E5 — adjust payroll liabilities
  // -------------------------------------------------------------------------
  it('liability adjustments change what is owed (and post when asked) without counting as payments', async () => {
    const emp = await createEmployee(ctx, { firstName: 'Cy', lastName: 'Liab', payType: 'hourly', payRate: '20' });
    const pc = await runPaycheck(ctx, { employeeId: emp.id, payDate: d('2026-06-05'), grossPay: '1000.00' });
    const checkFit = Number((await linesOf(pc.id))['tax:Federal Income Tax'] ?? 0);
    const before = await payrollLiabilityBalances(ctx, { asOf: d('2026-12-31') });
    const fitBefore = Number(before.items.find((i) => i.name === 'Federal Income Tax')?.accrued ?? 0);

    const up = await createLiabilityAdjustment(ctx, {
      employeeId: emp.id,
      date: d('2026-06-30'),
      affectsAccounts: true,
      lines: [{ kind: 'tax', name: 'Federal Income Tax', amount: '25.00' }],
    });
    expect(up.postedEntryId).not.toBeNull();
    await createLiabilityAdjustment(ctx, {
      employeeId: emp.id,
      date: d('2026-06-30'),
      affectsAccounts: true,
      lines: [{ kind: 'tax', name: 'Federal Income Tax', amount: '-10.00' }],
    });
    const after = await payrollLiabilityBalances(ctx, { asOf: d('2026-12-31') });
    const fitAfter = Number(after.items.find((i) => i.name === 'Federal Income Tax')?.accrued ?? 0);
    expect(fitAfter - fitBefore).toBeCloseTo(15, 2);
    expect(after.totalPaid).toBe(before.totalPaid); // the −10 debit is not a payment
    expect((await trialBalance(ctx)).balanced).toBe(true);
    // W-2 Box 2 follows the adjustment (QB behaviour).
    const w2 = await w2Data(ctx, { employeeId: emp.id, year: 2026 });
    expect(Number(w2.federalWithheld)).toBeCloseTo(checkFit + 15, 2);
  });

  // -------------------------------------------------------------------------
  // E4 — edit paycheck
  // -------------------------------------------------------------------------
  describe('edit paycheck', () => {
    it('voids the old entry and posts the corrected one in place', async () => {
      const emp = await createEmployee(ctx, { firstName: 'Di', lastName: 'Edit', payType: 'hourly', payRate: '25' });
      const pc = await runPaycheck(ctx, { employeeId: emp.id, payDate: d('2026-07-10'), grossPay: '1000.00' });
      const edited = await editPaycheck(ctx, pc.id, { payDate: d('2026-07-11'), grossPay: '1200.00' });
      expect(edited.id).toBe(pc.id);
      expect(edited.grossPay).toBe('1200.00');
      expect(edited.postedEntryId).not.toBe(pc.postedEntryId);
      const [oldJe] = await ctx.db.select().from(journalEntries).where(eq(journalEntries.id, pc.postedEntryId!));
      expect(oldJe.status).toBe('void');
      const l = await linesOf(pc.id);
      expect(l['tax:Social Security']).toBe('74.40');
      expect((await trialBalance(ctx)).balanced).toBe(true);
      const list = await listPaychecks(ctx, { employeeId: emp.id });
      expect(list).toHaveLength(1);
      expect(list[0].grossPay).toBe('1200.00');
    });

    it('is refused when the check was cleared in a completed reconciliation', async () => {
      const emp = await createEmployee(ctx, { firstName: 'Ed', lastName: 'Recon', payType: 'hourly', payRate: '25' });
      const pc = await runPaycheck(ctx, { employeeId: emp.id, payDate: d('2026-07-20'), grossPay: '500.00' });
      const [checking] = await ctx.db
        .select()
        .from(accounts)
        .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '1000')));
      const [bank] = await ctx.db
        .insert(bankAccounts)
        .values({ companyId: ctx.companyId, accountId: checking.id, bankName: 'Test Bank', accountNumber: '0001' })
        .returning();
      const [rec] = await ctx.db
        .insert(reconciliations)
        .values({ bankAccountId: bank.id, statementDate: d('2026-07-31'), statementBalance: '0', status: 'completed', createdBy: ctx.userId! })
        .returning();
      const [netLine] = await ctx.db
        .select()
        .from(journalEntryLines)
        .where(and(eq(journalEntryLines.journalEntryId, pc.postedEntryId!), eq(journalEntryLines.accountId, checking.id)));
      await ctx.db.insert(reconciliationItems).values({ reconciliationId: rec.id, journalEntryLineId: netLine.id, isCleared: true });
      await expect(editPaycheck(ctx, pc.id, { payDate: d('2026-07-20'), grossPay: '600.00' })).rejects.toMatchObject({ code: 'CONFLICT' });
      const l = await linesOf(pc.id);
      expect(l['earning:Gross Pay']).toBe('500.00'); // nothing changed
    });
  });

  // -------------------------------------------------------------------------
  // E6 / E7 — SUI, SDI, workers comp + worksheet / summary
  // -------------------------------------------------------------------------
  it('auto-accrues SUI and SDI from the state settings and reports them on the wage worksheet', async () => {
    await upsertStateTaxSetting(ctx, { state: 'CA', year: 2026, suiRate: '0.034', suiWageBase: '7000', sdiRate: '0.012', sdiWageBase: '0', accountNumber: '123-4567-8' });
    const emp = await createEmployee(ctx, { firstName: 'Fay', lastName: 'State', payType: 'salary', payRate: '120000' });
    await updateEmployee(ctx, emp.id, { address: { line1: '1 Main', city: 'Fresno', state: 'CA', zip: '93701' } });
    const c1 = await runPaycheck(ctx, { employeeId: emp.id, payDate: d('2026-08-01'), grossPay: '5000.00' });
    const c2 = await runPaycheck(ctx, { employeeId: emp.id, payDate: d('2026-08-15'), grossPay: '5000.00' });
    const l1 = await linesOf(c1.id);
    const l2 = await linesOf(c2.id);
    expect(l1['employer_contribution:State Unemployment (CA)']).toBe('170.00');
    expect(l1['tax:State Disability (CA)']).toBe('60.00');
    expect(l2['employer_contribution:State Unemployment (CA)']).toBe('68.00'); // only 2,000 left under 7,000
    expect((await trialBalance(ctx)).balanced).toBe(true);

    const ws = await stateWageWorksheet(ctx, { state: 'CA', year: 2026, quarter: 3 });
    const row = ws.employees.find((e) => e.employeeName === 'Fay State')!;
    expect(row.quarterWages).toBe('10000.00');
    expect(row.taxableWages).toBe('7000.00');
    expect(row.excessWages).toBe('3000.00');
    expect(row.suiAccrued).toBe('238.00');
    expect(row.sdiWithheld).toBe('120.00');
    expect(ws.totals.suiCalculated).toBe('238.00');
    expect(ws.accountNumber).toBe('123-4567-8');

    // W-2 Box 17 is the state INCOME tax withheld (the auto-calculated California withholding),
    // never the SDI.
    const w2 = await w2Data(ctx, { employeeId: emp.id, year: 2026 });
    const caWh = Number(l1['tax:State Withholding (CA)']) + Number(l2['tax:State Withholding (CA)']);
    expect(caWh).toBeGreaterThan(0);
    expect(w2.state.withheld).toBe(caWh.toFixed(2));
    expect(w2.state.code).toBe('CA');
  });

  it('accrues workers comp per $100 of wages and summarizes by class code', async () => {
    const code = await createWorkersCompCode(ctx, { code: '8810', description: 'Clerical', ratePer100: '0.35' });
    const emp = await createEmployee(ctx, { firstName: 'Gus', lastName: 'Comp', payType: 'hourly', payRate: '25' });
    await updateEmployee(ctx, emp.id, { workersCompCodeId: code.id });
    const pc = await runPaycheck(ctx, { employeeId: emp.id, payDate: d('2026-09-05'), grossPay: '2000.00' });
    const l = await linesOf(pc.id);
    expect(l['employer_contribution:Workers Compensation (8810)']).toBe('7.00');
    const wc = await workersCompSummary(ctx, { from: d('2026-09-01'), to: d('2026-09-30') });
    expect(wc.rows).toEqual([expect.objectContaining({ code: '8810', wages: '2000.00', premium: '7.00', employees: 1 })]);
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  // -------------------------------------------------------------------------
  // E8 — reports
  // -------------------------------------------------------------------------
  it('Employee Earnings Summary, Payroll Item Detail and Transactions by Payee agree', async () => {
    const range = { from: d('2026-01-01'), to: d('2026-12-31') };
    const ees = await employeeEarningsSummary(ctx, range);
    const detail = await payrollItemDetail(ctx, range);
    const payee = await payrollTransactionsByPayee(ctx, range);
    const summary = await payrollSummary(ctx, range);
    expect(ees.totalGross).toBe(summary.totals.gross);
    expect(payee.totalGross).toBe(summary.totals.gross);
    const earningTotal = detail.groups
      .filter((g) => g.kind === 'earning')
      .reduce((s, g) => s + Number(g.total), 0);
    expect(earningTotal).toBeCloseTo(Number(summary.totals.gross), 2);
    const sections = new Set(ees.rows.map((r) => r.section));
    expect(sections.has('Earnings')).toBe(true);
    expect(sections.has('Taxes withheld')).toBe(true);
    // YTD / liability adjustments show with their own type.
    const types = new Set(payee.payees.flatMap((p) => p.transactions.map((t) => t.type)));
    expect(types.has('Paycheck')).toBe(true);
    expect(types.has('Liability Adjustment')).toBe(true);
  });

  it('a company backup carries the SUI/SDI settings and workers comp codes', async () => {
    const data = await exportCompanyData(db, ctx.companyId);
    expect((data.tables.payrollStateSettings ?? []).map((r) => r.state)).toContain('CA');
    const codes = data.tables.workersCompCodes ?? [];
    expect(codes.map((r) => r.code)).toContain('8810');
    const codeIds = new Set(codes.map((r) => r.id));
    expect((data.tables.employees ?? []).some((e) => codeIds.has(e.workersCompCodeId))).toBe(true);
  });
});
