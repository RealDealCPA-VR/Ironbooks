/**
 * Independent QA (tester) — wave-2 after-the-fact payroll, adversarial cases.
 *
 * E1 year-keyed SS wage base · E2 2025/2026 tables + HoH + W-4 steps · E3 mid-year YTD
 * (wage-base limits for SS / FUTA / Additional Medicare / SUI / SDI, W-3 / 940) · E4 edit
 * paycheck (closing date, voided, adjustments, rollback) · E5 liability adjustments
 * (malformed input, closing date, rollback) · E6 SUI/SDI settings validation + idempotent
 * upsert · E7 workers comp rounding / inactive codes / cross-company · tenant isolation.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { auditLogs, journalEntries, paycheckLines, paychecks, payrollStateSettings, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany, setClosingDate } from './company';
import { trialBalance, balanceSheet } from './reports';
import { createEmployee, editPaycheck, runPaycheck, updateEmployee, voidPaycheck } from './payroll';
import {
  assignWorkersCompCode,
  createLiabilityAdjustment,
  createWorkersCompCode,
  createYtdAdjustment,
  upsertStateTaxSetting,
  voidPayrollAdjustment,
} from './payrollAdjustments';
import { form940Data, w2Data, w3Data } from './payrollReports';
import {
  computeEmployerTaxes,
  computeWithholding,
  ssWageBaseFor,
  taxableUnderBase,
} from './payrollTax';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-payroll-wave2-adversarial');
let db: DB;
let ctx: ServiceContext;
let other: ServiceContext;

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

async function linesOf(paycheckId: string) {
  const rows = await ctx.db.select().from(paycheckLines).where(eq(paycheckLines.paycheckId, paycheckId));
  return Object.fromEntries(rows.map((l) => [`${l.kind}:${l.name}`, l.amount]));
}

async function paycheckRowCount(c: ServiceContext) {
  return (await c.db.select({ id: paychecks.id }).from(paychecks).where(eq(paychecks.companyId, c.companyId))).length;
}

async function assertBooksBalanced(c: ServiceContext) {
  const tb = await trialBalance(c);
  expect(tb.balanced).toBe(true);
  const bs = await balanceSheet(c, new Date('2100-01-01T00:00:00Z'));
  expect(bs.balanced).toBe(true);
}

async function emp(first: string, last: string, rate = '100000', payType: 'salary' | 'hourly' = 'salary') {
  return createEmployee(ctx, { firstName: first, lastName: last, payType, payRate: rate });
}

describe('wave-2 payroll — adversarial QA', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'qa-payroll@test.local', name: 'QA', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'QA Payroll Co', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    const [user2] = await db.insert(users).values({ email: 'qa-payroll-2@test.local', name: 'QA2', passwordHash: 'x' }).returning();
    const company2 = await createCompany(db, { name: 'Other Payroll Co', ownerId: user2.id });
    other = { db, companyId: company2.id, userId: user2.id };
  }, 300_000);

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // E1 / E2 — pure tax tables
  // -------------------------------------------------------------------------
  describe('E1/E2 tax tables (pure)', () => {
    it('SS wage base is keyed by year (2023-2026)', () => {
      expect(ssWageBaseFor(2023)).toBe(160200);
      expect(ssWageBaseFor(2024)).toBe(168600);
      expect(ssWageBaseFor(2025)).toBe(176100);
      expect(ssWageBaseFor(2026)).toBe(184500);
    });

    it('employee and employer SS stop exactly at each year\'s base', () => {
      for (const [year, base] of [[2023, 160200], [2025, 176100], [2026, 184500]] as const) {
        const ytd = base - 100; // only $100 left under the base
        const w = computeWithholding({ grossPerPeriod: 5000, periodsPerYear: 26, filingStatus: 'single', ytdGrossBefore: ytd, year });
        expect(w.socialSecurity).toBe('6.20');
        const er = computeEmployerTaxes({ grossPerPeriod: 5000, ytdGrossBefore: ytd, year });
        expect(er.socialSecurity).toBe('6.20');
        const over = computeWithholding({ grossPerPeriod: 5000, periodsPerYear: 26, filingStatus: 'single', ytdGrossBefore: base, year });
        expect(over.socialSecurity).toBe('0.00');
      }
    });

    it('2026 head of household withholding matches a hand computation', () => {
      // 60,000 annual; HoH 2026 std ded 24,150 → 35,850 taxable.
      // 10% × 17,700 = 1,770; 12% × 18,150 = 2,178 → 3,948 / 12 = 329.00
      const w = computeWithholding({ grossPerPeriod: 5000, periodsPerYear: 12, filingStatus: 'head_of_household', year: 2026 });
      expect(w.federalIncomeTax).toBe('329.00');
      expect(w.tableYear).toBe(2026);
    });

    it('2026 single with the W-4 Step 2 box matches a hand computation', () => {
      // 60,000 − 8,050 (half std) = 51,950; half brackets 6,200 / 25,200 / 52,850:
      // 620 + 2,280 + 22% × 26,750 (5,885) = 8,785 / 12 = 732.08
      const w = computeWithholding({
        grossPerPeriod: 5000,
        periodsPerYear: 12,
        filingStatus: 'single',
        year: 2026,
        w4: { formYear: 2026, filingStatus: 'single', step2Checkbox: true },
      });
      expect(w.federalIncomeTax).toBe('732.08');
    });

    it('2025 married filing jointly matches a hand computation', () => {
      // 120,000 − 30,000 = 90,000; 10% × 23,850 = 2,385; 12% × 66,150 = 7,938 → 10,323 / 24 = 430.13
      const w = computeWithholding({ grossPerPeriod: 5000, periodsPerYear: 24, filingStatus: 'married', year: 2025 });
      expect(w.federalIncomeTax).toBe('430.13');
    });

    it('a negative or junk W-4 amount never produces negative withholding', () => {
      const w = computeWithholding({
        grossPerPeriod: 500,
        periodsPerYear: 52,
        filingStatus: 'single',
        year: 2026,
        w4: { formYear: 2026, dependentsAmount: '99999', deductions: 'abc', extraWithholding: '-50' },
      });
      expect(Number(w.federalIncomeTax)).toBeGreaterThanOrEqual(0);
    });

    it('taxableUnderBase never exceeds the base nor goes negative', () => {
      expect(taxableUnderBase('5000', '6000', '7000').toFixed(2)).toBe('1000.00');
      expect(taxableUnderBase('5000', '9000', '7000').toFixed(2)).toBe('0.00');
      expect(taxableUnderBase('5000', '0', '0').toFixed(2)).toBe('5000.00'); // 0 = no cap
    });
  });

  // -------------------------------------------------------------------------
  // E1 end to end in an older year
  // -------------------------------------------------------------------------
  it('E1: a 2023 W-2 caps Box 3 at 160,200 and the paycheck SS stops at it', async () => {
    const e = await emp('Old', 'Year', '200000');
    await runPaycheck(ctx, { employeeId: e.id, payDate: d('2023-03-01'), grossPay: '100000.00' });
    const second = await runPaycheck(ctx, { employeeId: e.id, payDate: d('2023-09-01'), grossPay: '100000.00' });
    const l = await linesOf(second.id);
    expect(l['tax:Social Security']).toBe('3732.40'); // (160,200 − 100,000) × 6.2%
    expect(l['employer_contribution:Employer Social Security']).toBe('3732.40');
    const w2 = await w2Data(ctx, { employeeId: e.id, year: 2023 });
    expect(w2.ssWages).toBe('160200.00');
    expect(w2.socialSecurity).toBe('9932.40');
    // A new year resets the base.
    const jan = await runPaycheck(ctx, { employeeId: e.id, payDate: d('2024-01-05'), grossPay: '1000.00' });
    expect((await linesOf(jan.id))['tax:Social Security']).toBe('62.00');
    await assertBooksBalanced(ctx);
  });

  // -------------------------------------------------------------------------
  // E3 — mid-year YTD and every wage base
  // -------------------------------------------------------------------------
  describe('E3 YTD amounts feed every wage-base limit', () => {
    it('FUTA: 5,000 of history leaves only 2,000 FUTA-taxable', async () => {
      const e = await emp('Futa', 'Ytd', '60000');
      await createYtdAdjustment(ctx, {
        employeeId: e.id,
        date: d('2026-03-31'),
        lines: [{ kind: 'earning', name: 'Salary', amount: '5000.00' }],
      });
      const pc = await runPaycheck(ctx, { employeeId: e.id, payDate: d('2026-04-15'), grossPay: '3000.00' });
      expect((await linesOf(pc.id))['employer_contribution:Federal Unemployment (FUTA)']).toBe('12.00');
    });

    it('Additional Medicare: 195,000 of history → 0.9% only on the 5,000 above 200,000', async () => {
      const e = await emp('Addl', 'Medicare', '500000');
      await createYtdAdjustment(ctx, {
        employeeId: e.id,
        date: d('2026-03-31'),
        lines: [{ kind: 'earning', name: 'Salary', amount: '195000.00' }],
      });
      const pc = await runPaycheck(ctx, { employeeId: e.id, payDate: d('2026-04-15'), grossPay: '10000.00' });
      const l = await linesOf(pc.id);
      expect(l['tax:Medicare']).toBe('190.00'); // 145 + 45
      // SS: 184,500 − 195,000 < 0 → nothing (line may be omitted or zero)
      expect(Number(l['tax:Social Security'] ?? 0)).toBe(0);
    });

    it('SUI and SDI wage bases include YTD history', async () => {
      await upsertStateTaxSetting(ctx, { state: 'NJ', year: 2026, suiRate: '0.03', suiWageBase: '10000', sdiRate: '0.01', sdiWageBase: '12000' });
      const e = await emp('Sui', 'Ytd', '90000');
      await updateEmployee(ctx, e.id, { address: { line1: '1 A St', city: 'Newark', state: 'NJ', zip: '07102' } });
      await createYtdAdjustment(ctx, {
        employeeId: e.id,
        date: d('2026-03-31'),
        lines: [{ kind: 'earning', name: 'Salary', amount: '9000.00' }],
      });
      const pc = await runPaycheck(ctx, { employeeId: e.id, payDate: d('2026-04-15'), grossPay: '5000.00' });
      const l = await linesOf(pc.id);
      expect(l['employer_contribution:State Unemployment (NJ)']).toBe('30.00'); // 1,000 × 3%
      expect(l['tax:State Disability (NJ)']).toBe('30.00'); // 3,000 × 1%
      await assertBooksBalanced(ctx);
    });

    it('a VOIDED non-posting YTD entry stops counting toward the SS base of later checks', async () => {
      const e = await emp('Void', 'Ytd', '400000');
      const ytd = await createYtdAdjustment(ctx, {
        employeeId: e.id,
        date: d('2026-02-28'),
        lines: [{ kind: 'earning', name: 'Salary', amount: '184500.00' }],
      });
      const a = await runPaycheck(ctx, { employeeId: e.id, payDate: d('2026-03-15'), grossPay: '1000.00' });
      expect(Number((await linesOf(a.id))['tax:Social Security'] ?? 0)).toBe(0);
      await voidPayrollAdjustment(ctx, ytd.id);
      const b = await runPaycheck(ctx, { employeeId: e.id, payDate: d('2026-03-31'), grossPay: '1000.00' });
      expect((await linesOf(b.id))['tax:Social Security']).toBe('62.00');
      await expect(voidPayrollAdjustment(ctx, ytd.id)).rejects.toMatchObject({ code: 'VALIDATION' });
    });

    it('W-3 and 940 include YTD history', async () => {
      const e = await emp('Three', 'Forty', '80000');
      const before3 = await w3Data(ctx, { year: 2026 });
      const before940 = await form940Data(ctx, { year: 2026 });
      await createYtdAdjustment(ctx, {
        employeeId: e.id,
        date: d('2026-01-31'),
        lines: [
          { kind: 'earning', name: 'Salary', amount: '4000.00' },
          { kind: 'tax', name: 'Federal Income Tax', amount: '400.00' },
        ],
      });
      const after3 = await w3Data(ctx, { year: 2026 });
      const after940 = await form940Data(ctx, { year: 2026 });
      expect(Number(after3.wages) - Number(before3.wages)).toBeCloseTo(4000, 2);
      expect(Number(after3.federalWithheld) - Number(before3.federalWithheld)).toBeCloseTo(400, 2);
      expect(Number(after940.totalPayments) - Number(before940.totalPayments)).toBeCloseTo(4000, 2);
      expect(Number(after940.taxableFutaWages) - Number(before940.taxableFutaWages)).toBeCloseTo(4000, 2);
    });

    it('rejects malformed YTD input and writes nothing', async () => {
      const e = await emp('Bad', 'Input', '50000');
      const n = await paycheckRowCount(ctx);
      await expect(createYtdAdjustment(ctx, { employeeId: e.id, date: d('2026-03-31'), lines: [] })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(
        createYtdAdjustment(ctx, { employeeId: e.id, date: d('2026-03-31'), lines: [{ kind: 'earning', name: 'Salary', amount: '-1.00' }] }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(
        createYtdAdjustment(ctx, {
          employeeId: e.id,
          date: d('2026-03-31'),
          lines: [
            { kind: 'earning', name: 'Salary', amount: '100.00' },
            { kind: 'tax', name: 'Federal Income Tax', amount: '100.01' },
          ],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION' }); // net would be negative
      await expect(
        createYtdAdjustment(ctx, { employeeId: e.id, date: new Date('nope'), lines: [{ kind: 'earning', name: 'Salary', amount: '1' }] }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(
        createYtdAdjustment(ctx, { employeeId: e.id, date: d('2026-03-31'), lines: [{ kind: 'bogus' as never, name: 'x', amount: '1' }] }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(
        createYtdAdjustment(ctx, { employeeId: e.id, date: d('2026-03-31'), lines: [{ kind: 'earning', name: '  ', amount: '1' }] }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      expect(await paycheckRowCount(ctx)).toBe(n);
    });

    it('rounds sub-cent amounts consistently (gross − taxes − deductions = net, exactly)', async () => {
      const e = await emp('Round', 'Cents', '50000');
      const ytd = await createYtdAdjustment(ctx, {
        employeeId: e.id,
        date: d('2026-03-31'),
        lines: [
          { kind: 'earning', name: 'Salary', amount: '1000.005' },
          { kind: 'earning', name: 'Bonus', amount: '0.004' },
          { kind: 'tax', name: 'Federal Income Tax', amount: '100.335' },
          { kind: 'deduction', name: '401k', amount: '10.115' },
        ],
      });
      const cents = (s: string) => Math.round(Number(s) * 100);
      expect(cents(ytd.grossPay) - cents(ytd.totalTaxes) - cents(ytd.totalDeductions)).toBe(cents(ytd.netPay));
      const lineSum = ytd.lines.filter((l) => l.kind === 'earning').reduce((s, l) => s + cents(l.amount), 0);
      expect(lineSum).toBe(cents(ytd.grossPay));
      for (const l of ytd.lines) expect(l.amount).toMatch(/^-?\d+\.\d{2}$/);
    });

    it('a posting YTD entry into a closed period is refused and leaves NO paycheck row behind', async () => {
      const e = await emp('Closed', 'Ytd', '50000');
      await setClosingDate(ctx, { closingDate: '2026-01-31' });
      try {
        const n = await paycheckRowCount(ctx);
        await expect(
          createYtdAdjustment(ctx, {
            employeeId: e.id,
            date: d('2026-01-15'),
            affectsAccounts: true,
            lines: [{ kind: 'earning', name: 'Salary', amount: '1000.00' }],
          }),
        ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
        expect(await paycheckRowCount(ctx)).toBe(n);
        // and it did not leak into the W-2 either
        const w2 = await w2Data(ctx, { employeeId: e.id, year: 2026 });
        expect(Number(w2.wages)).toBe(0);
      } finally {
        await setClosingDate(ctx, { closingDate: null });
      }
      await assertBooksBalanced(ctx);
    });

    it('cannot create or void adjustments for another company', async () => {
      const e = await emp('Tenant', 'One', '50000');
      await expect(
        createYtdAdjustment(other, { employeeId: e.id, date: d('2026-03-31'), lines: [{ kind: 'earning', name: 'Salary', amount: '1' }] }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const ytd = await createYtdAdjustment(ctx, {
        employeeId: e.id,
        date: d('2026-03-31'),
        lines: [{ kind: 'earning', name: 'Salary', amount: '10.00' }],
      });
      await expect(voidPayrollAdjustment(other, ytd.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('writes an audit row for every YTD create and void', async () => {
      const e = await emp('Audit', 'Ytd', '50000');
      const ytd = await createYtdAdjustment(ctx, {
        employeeId: e.id,
        date: d('2026-03-31'),
        lines: [{ kind: 'earning', name: 'Salary', amount: '10.00' }],
      });
      await voidPayrollAdjustment(ctx, ytd.id);
      const rows = await ctx.db.select().from(auditLogs).where(eq(auditLogs.entityId, ytd.id));
      expect(rows.map((r) => r.action).sort()).toEqual(['create', 'void']);
    });
  });

  // -------------------------------------------------------------------------
  // E4 — edit paycheck
  // -------------------------------------------------------------------------
  describe('E4 edit paycheck guards', () => {
    it('refuses to edit a paycheck dated on/before the closing date and changes nothing', async () => {
      const e = await emp('Edit', 'Closed', '52000');
      const pc = await runPaycheck(ctx, { employeeId: e.id, payDate: d('2026-02-13'), grossPay: '2000.00' });
      await setClosingDate(ctx, { closingDate: '2026-02-28' });
      try {
        await expect(editPaycheck(ctx, pc.id, { payDate: d('2026-03-13'), grossPay: '2500.00' })).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
      } finally {
        await setClosingDate(ctx, { closingDate: null });
      }
      const [row] = await ctx.db.select().from(paychecks).where(eq(paychecks.id, pc.id));
      expect(row.grossPay).toBe('2000.00');
      expect(row.postedEntryId).toBe(pc.postedEntryId);
      const [je] = await ctx.db.select().from(journalEntries).where(eq(journalEntries.id, pc.postedEntryId!));
      expect(je.status).toBe('posted');
      expect((await linesOf(pc.id))['earning:Gross Pay']).toBe('2000.00');
    });

    it('refuses to MOVE a paycheck into a closed period and rolls the void back', async () => {
      const e = await emp('Edit', 'IntoClosed', '52000');
      const pc = await runPaycheck(ctx, { employeeId: e.id, payDate: d('2026-05-15'), grossPay: '2000.00' });
      await setClosingDate(ctx, { closingDate: '2026-04-30' });
      try {
        await expect(editPaycheck(ctx, pc.id, { payDate: d('2026-04-15'), grossPay: '2000.00' })).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
      } finally {
        await setClosingDate(ctx, { closingDate: null });
      }
      const [je] = await ctx.db.select().from(journalEntries).where(eq(journalEntries.id, pc.postedEntryId!));
      expect(je.status).toBe('posted'); // the void inside the failed edit was rolled back
      const [row] = await ctx.db.select().from(paychecks).where(eq(paychecks.id, pc.id));
      expect(row.payDate.toISOString().slice(0, 10)).toBe('2026-05-15');
      await assertBooksBalanced(ctx);
    });

    it('refuses voided paychecks and payroll adjustments', async () => {
      const e = await emp('Edit', 'Voided', '52000');
      const pc = await runPaycheck(ctx, { employeeId: e.id, payDate: d('2026-06-12'), grossPay: '1000.00' });
      await voidPaycheck(ctx, pc.id);
      await expect(editPaycheck(ctx, pc.id, { payDate: d('2026-06-12'), grossPay: '900.00' })).rejects.toMatchObject({ code: 'CONFLICT' });
      const ytd = await createYtdAdjustment(ctx, { employeeId: e.id, date: d('2026-03-31'), lines: [{ kind: 'earning', name: 'Salary', amount: '10.00' }] });
      await expect(editPaycheck(ctx, ytd.id, { payDate: d('2026-03-31'), grossPay: '20.00' })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(editPaycheck(other, pc.id, { payDate: d('2026-06-12'), grossPay: '900.00' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('recomputes SS against YTD EXCLUDING the check itself', async () => {
      const e = await emp('Edit', 'Base', '400000');
      await createYtdAdjustment(ctx, { employeeId: e.id, date: d('2026-01-31'), lines: [{ kind: 'earning', name: 'Salary', amount: '184000.00' }] });
      const pc = await runPaycheck(ctx, { employeeId: e.id, payDate: d('2026-02-15'), grossPay: '400.00' });
      expect((await linesOf(pc.id))['tax:Social Security']).toBe('24.80');
      const edited = await editPaycheck(ctx, pc.id, { payDate: d('2026-02-15'), grossPay: '1000.00' });
      // 500 left under the base (not 100 — the check's own old 400 must not count)
      expect((await linesOf(edited.id))['tax:Social Security']).toBe('31.00');
      await assertBooksBalanced(ctx);
    });

    it('writes an update audit row with old and new values', async () => {
      const e = await emp('Edit', 'Audit', '52000');
      const pc = await runPaycheck(ctx, { employeeId: e.id, payDate: d('2026-07-17'), grossPay: '1000.00' });
      await editPaycheck(ctx, pc.id, { payDate: d('2026-07-17'), grossPay: '1100.00' });
      const rows = await ctx.db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.entityId, pc.id), eq(auditLogs.action, 'update')));
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0].oldValues)).toContain('1000.00');
      expect(JSON.stringify(rows[0].newValues)).toContain('1100.00');
    });
  });

  // -------------------------------------------------------------------------
  // E5 — liability adjustments
  // -------------------------------------------------------------------------
  describe('E5 liability adjustments', () => {
    it('rejects wages, zero amounts and empty input; writes nothing', async () => {
      const e = await emp('Liab', 'Bad', '52000');
      const n = await paycheckRowCount(ctx);
      await expect(
        createLiabilityAdjustment(ctx, { employeeId: e.id, date: d('2026-06-30'), lines: [{ kind: 'earning' as never, name: 'Salary', amount: '10' }] }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(
        createLiabilityAdjustment(ctx, { employeeId: e.id, date: d('2026-06-30'), lines: [{ kind: 'tax', name: 'Federal Income Tax', amount: '0.001' }] }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(createLiabilityAdjustment(ctx, { employeeId: e.id, date: d('2026-06-30'), lines: [] })).rejects.toMatchObject({ code: 'VALIDATION' });
      expect(await paycheckRowCount(ctx)).toBe(n);
    });

    it('a posting adjustment in a closed period is refused with no row left behind', async () => {
      const e = await emp('Liab', 'Closed', '52000');
      await setClosingDate(ctx, { closingDate: '2026-06-30' });
      try {
        const n = await paycheckRowCount(ctx);
        await expect(
          createLiabilityAdjustment(ctx, {
            employeeId: e.id,
            date: d('2026-06-30'),
            affectsAccounts: true,
            lines: [{ kind: 'tax', name: 'Federal Income Tax', amount: '25.00' }],
          }),
        ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
        expect(await paycheckRowCount(ctx)).toBe(n);
      } finally {
        await setClosingDate(ctx, { closingDate: null });
      }
    });

    it('voiding a posted adjustment in a closed period is refused (adjustment stays active)', async () => {
      const e = await emp('Liab', 'VoidClosed', '52000');
      const adj = await createLiabilityAdjustment(ctx, {
        employeeId: e.id,
        date: d('2026-08-31'),
        affectsAccounts: true,
        lines: [{ kind: 'tax', name: 'Federal Income Tax', amount: '25.00' }],
      });
      await setClosingDate(ctx, { closingDate: '2026-08-31' });
      try {
        await expect(voidPayrollAdjustment(ctx, adj.id)).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
      } finally {
        await setClosingDate(ctx, { closingDate: null });
      }
      const [row] = await ctx.db.select().from(paychecks).where(eq(paychecks.id, adj.id));
      expect(row.voidedAt).toBeNull();
      await assertBooksBalanced(ctx);
    });

    it('voiding a real paycheck through the adjustments API is refused', async () => {
      const e = await emp('Liab', 'NotAdj', '52000');
      const pc = await runPaycheck(ctx, { employeeId: e.id, payDate: d('2026-09-11'), grossPay: '1000.00' });
      await expect(voidPayrollAdjustment(ctx, pc.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  // -------------------------------------------------------------------------
  // E6 / E7 — settings validation
  // -------------------------------------------------------------------------
  describe('E6/E7 settings', () => {
    it('validates state settings and upserts idempotently per (state, year)', async () => {
      await expect(upsertStateTaxSetting(ctx, { state: 'C1', year: 2026 })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(upsertStateTaxSetting(ctx, { state: 'CA', year: 1999 })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(upsertStateTaxSetting(ctx, { state: 'CA', year: 2026.5 })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(upsertStateTaxSetting(ctx, { state: 'CA', year: 2026, suiRate: '3.4' })).rejects.toMatchObject({ code: 'VALIDATION' }); // 340%
      await expect(upsertStateTaxSetting(ctx, { state: 'CA', year: 2026, suiRate: '-0.01' })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(upsertStateTaxSetting(ctx, { state: 'CA', year: 2026, suiWageBase: '-1' })).rejects.toMatchObject({ code: 'VALIDATION' });
      await upsertStateTaxSetting(ctx, { state: 'tx', year: 2027, suiRate: '0.027', suiWageBase: '9000' });
      await upsertStateTaxSetting(ctx, { state: 'TX', year: 2027, suiRate: '0.031', suiWageBase: '9000' });
      const rows = await ctx.db
        .select()
        .from(payrollStateSettings)
        .where(and(eq(payrollStateSettings.companyId, ctx.companyId), eq(payrollStateSettings.state, 'TX'), eq(payrollStateSettings.year, 2027)));
      expect(rows).toHaveLength(1);
      expect(rows[0].suiRate).toBe('0.031000');
    });

    it('workers comp: rounding, inactive codes accrue nothing, duplicates and cross-company refused', async () => {
      const code = await createWorkersCompCode(ctx, { code: '5403', description: 'Carpentry', ratePer100: '0.35' });
      await expect(createWorkersCompCode(ctx, { code: ' 5403 ', ratePer100: '1' })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(createWorkersCompCode(ctx, { code: 'X1', ratePer100: '-1' })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(createWorkersCompCode(ctx, { code: '', ratePer100: '1' })).rejects.toMatchObject({ code: 'VALIDATION' });

      const e = await emp('Comp', 'Round', '30', 'hourly');
      await assignWorkersCompCode(ctx, e.id, code.id);
      const pc = await runPaycheck(ctx, { employeeId: e.id, payDate: d('2026-10-02'), grossPay: '333.33' });
      expect((await linesOf(pc.id))['employer_contribution:Workers Compensation (5403)']).toBe('1.17'); // 1.166655
      await assertBooksBalanced(ctx);

      const otherCode = await createWorkersCompCode(other, { code: '9999', ratePer100: '5' });
      await expect(assignWorkersCompCode(ctx, e.id, otherCode.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });

      const { updateWorkersCompCode } = await import('./payrollAdjustments');
      await updateWorkersCompCode(ctx, code.id, { isActive: false });
      const pc2 = await runPaycheck(ctx, { employeeId: e.id, payDate: d('2026-10-09'), grossPay: '333.33' });
      expect((await linesOf(pc2.id))['employer_contribution:Workers Compensation (5403)']).toBeUndefined();
    });
  });
});
