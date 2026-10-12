/**
 * Regression tests for the payroll audit fixes:
 *
 *  1. Omitted `taxes` triggers auto-withholding; explicit [] means "no taxes"
 *     (the API route previously coerced undefined → [] which disabled auto-withholding).
 *  2. Employer payroll taxes (employer FICA match + FUTA) are computed, recorded as
 *     employer_contribution paycheck lines, and posted Dr Payroll Tax Expense /
 *     Cr Payroll Liabilities — without touching net pay.
 *  3. form941Data reports the FULL FICA liability (employee + employer shares).
 *  4. W-2 / 941 aggregations and the pay-stub listing exclude paychecks whose GL
 *     posting was voided.
 *  5. W-2 / 941 period ranges are built in UTC, matching how pay dates are stored,
 *     so boundary-day paychecks (Jan 1, Apr 1) classify correctly in any server TZ.
 *  6. The SS wage base and Additional Medicare threshold apply against actual YTD
 *     wages instead of annualizing the current period.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, accounts, paycheckLines } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { voidJournalEntry } from './posting';
import { createEmployee, runPaycheck, listPaychecks } from './payroll';
import { w2Data, form941Data } from './payrollReports';
import { computeWithholding, computeEmployerTaxes } from './payrollTax';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-fixes-payroll');

let ctx: ServiceContext;
let db: DB;

async function linesFor(paycheckId: string) {
  return db
    .select()
    .from(paycheckLines)
    .where(eq(paycheckLines.paycheckId, paycheckId));
}

async function balances(): Promise<Record<string, string>> {
  const rows = await db
    .select({ code: accounts.code, balance: accounts.balance })
    .from(accounts)
    .where(eq(accounts.companyId, ctx.companyId));
  return Object.fromEntries(rows.map((r) => [r.code, r.balance]));
}

describe('payroll audit fixes', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'fixes-payroll@test.local', name: 'Fixes Owner', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'Fixes Payroll Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking',            'asset',     'checking'],
      ['2300', 'Payroll Liabilities', 'liability', 'long_term_liability'],
      ['6500', 'Payroll Expense',     'expense',   'payroll'],
    ];
    for (const [code, name, type, subtype] of defs) {
      await createAccount(ctx, { code, name, type: type as never, subtype });
    }
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. Auto-withholding: omitted taxes auto-compute; explicit [] = no taxes
  // -------------------------------------------------------------------------

  describe('auto-withholding semantics (omitted vs explicit [])', () => {
    it('omitting taxes yields nonzero FIT/SS/Medicare lines', async () => {
      const emp = await createEmployee(ctx, {
        firstName: 'Auto', lastName: 'Withheld', payType: 'salary', payRate: '52000.00',
      });
      const check = await runPaycheck(ctx, {
        employeeId: emp.id,
        payDate: new Date('2025-06-15'),
        grossPay: '2000.00',
        // taxes intentionally omitted → computeWithholding must run
      });
      expect(parseFloat(check.totalTaxes)).toBeGreaterThan(0);

      const lines = await linesFor(check.id);
      const taxNames = lines.filter((l) => l.kind === 'tax').map((l) => l.name);
      expect(taxNames).toContain('Federal Income Tax');
      expect(taxNames).toContain('Social Security');
      expect(taxNames).toContain('Medicare');
    });

    it('explicit empty taxes array is respected (totalTaxes = 0); employer taxes still calculated unless [] too', async () => {
      const emp = await createEmployee(ctx, {
        firstName: 'No', lastName: 'Taxes', payType: 'hourly', payRate: '25.00',
      });
      const check = await runPaycheck(ctx, {
        employeeId: emp.id,
        payDate: new Date('2025-06-30'),
        grossPay: '500.00',
        taxes: [],
      });
      expect(check.totalTaxes).toBe('0.00');
      expect(check.netPay).toBe('500.00');

      const lines = await linesFor(check.id);
      expect(lines.filter((l) => l.kind === 'tax')).toHaveLength(0);
      // Employee taxes typed in, employerTaxes omitted → the employer taxes are still calculated
      // (a paycheck can never silently skip employer FICA / FUTA).
      const employer = lines.filter((l) => l.kind === 'employer_contribution');
      expect(employer.find((l) => l.taxTracking === 'employer_social_security')?.amount).toBe('31.00');
      expect(employer.find((l) => l.taxTracking === 'employer_medicare')?.amount).toBe('7.25');
      expect(employer.find((l) => l.taxTracking === 'futa')?.amount).toBe('3.00');

      // Explicit [] for both → no taxes of either kind.
      const none = await runPaycheck(ctx, {
        employeeId: emp.id,
        payDate: new Date('2025-07-15'),
        grossPay: '500.00',
        taxes: [],
        employerTaxes: [],
      });
      const noneLines = await linesFor(none.id);
      expect(noneLines.filter((l) => l.kind === 'employer_contribution')).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 2 + 3. Employer payroll taxes recorded + reported on the 941
  // -------------------------------------------------------------------------

  describe('employer payroll taxes (FICA match + FUTA)', () => {
    let checkId: string;

    it('auto-computes and records employer_contribution lines without touching net pay', async () => {
      const emp = await createEmployee(ctx, {
        firstName: 'Em', lastName: 'Ployer', payType: 'salary', payRate: '52000.00',
      });

      const before = await balances();
      const check = await runPaycheck(ctx, {
        employeeId: emp.id,
        payDate: new Date('2025-03-14'), // Q1 2025 — isolated from the other 2025 checks (Q2)
        grossPay: '2000.00',
      });
      checkId = check.id;

      const lines = await linesFor(check.id);
      const employer = Object.fromEntries(
        lines.filter((l) => l.kind === 'employer_contribution').map((l) => [l.name, l.amount]),
      );
      expect(employer['Employer Social Security']).toBe('124.00');  // 2000 × 6.2%
      expect(employer['Employer Medicare']).toBe('29.00');          // 2000 × 1.45%
      expect(employer['Federal Unemployment (FUTA)']).toBe('12.00'); // 2000 × 0.6% (within $7k base)

      // Net pay = gross − EMPLOYEE taxes only; employer taxes never reduce it.
      const employeeTaxes = parseFloat(check.totalTaxes);
      expect(parseFloat(check.netPay)).toBeCloseTo(2000 - employeeTaxes, 2);

      // GL: Dr 6500 += gross + employer taxes (no 6510 in this COA → falls back to 6500);
      //     Cr 2300 += employee taxes + employer taxes.
      const after = await balances();
      const d6500 = parseFloat(after['6500']) - parseFloat(before['6500']);
      const d2300 = parseFloat(after['2300']) - parseFloat(before['2300']);
      expect(d6500).toBeCloseTo(2000 + 165, 2);          // 124 + 29 + 12 = 165 employer
      expect(d2300).toBeCloseTo(employeeTaxes + 165, 2);

      const tb = await trialBalance(ctx);
      expect(tb.balanced).toBe(true);
    });

    it('form941Data reports the FULL FICA share (employee + employer), excluding FUTA', async () => {
      const result = await form941Data(ctx, { quarter: 1, year: 2025 });
      expect(result.totals.wages).toBe('2000.00');
      // Line 5a equivalent: taxable SS wages × 12.4% = 124 employee + 124 employer.
      expect(result.totals.socialSecurity).toBe('248.00');
      // Line 5c equivalent: Medicare wages × 2.9% = 29 employee + 29 employer.
      expect(result.totals.medicare).toBe('58.00');
      expect(result.totals.employeeSocialSecurity).toBe('124.00');
      expect(result.totals.employerSocialSecurity).toBe('124.00');
      expect(result.totals.employeeMedicare).toBe('29.00');
      expect(result.totals.employerMedicare).toBe('29.00');
      expect(parseFloat(result.totals.federalWithheld)).toBeGreaterThan(0);
    });

    it('explicit employerTaxes override is respected', async () => {
      const emp = await createEmployee(ctx, {
        firstName: 'Over', lastName: 'Ride', payType: 'salary', payRate: '52000.00',
      });
      const check = await runPaycheck(ctx, {
        employeeId: emp.id,
        payDate: new Date('2021-05-15'), // isolated year
        grossPay: '1000.00',
        taxes: [{ kind: 'tax', name: 'Federal Income Tax', amount: '100.00' }],
        employerTaxes: [
          { kind: 'employer_contribution', name: 'Employer Social Security', amount: '62.00' },
        ],
      });
      const lines = await linesFor(check.id);
      const employer = lines.filter((l) => l.kind === 'employer_contribution');
      expect(employer).toHaveLength(1);
      expect(employer[0].amount).toBe('62.00');

      const tb = await trialBalance(ctx);
      expect(tb.balanced).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Voided paychecks excluded from W-2 / 941 / pay-stub list
  // -------------------------------------------------------------------------

  describe('voided GL postings drop out of W-2/941 aggregations', () => {
    it('w2Data, form941Data and listPaychecks all exclude a voided paycheck', async () => {
      const emp = await createEmployee(ctx, {
        firstName: 'Void', lastName: 'Case', payType: 'salary', payRate: '52000.00',
      });
      const check = await runPaycheck(ctx, {
        employeeId: emp.id,
        payDate: new Date('2023-05-12'), // Q2 2023 — only paycheck in that quarter/year
        grossPay: '3000.00',
      });

      // Before void: everything counts.
      let w2 = await w2Data(ctx, { employeeId: emp.id, year: 2023 });
      expect(w2.wages).toBe('3000.00');
      let f941 = await form941Data(ctx, { quarter: 2, year: 2023 });
      expect(f941.totals.wages).toBe('3000.00');

      // Void the paycheck's journal entry (the GL reversal path).
      await voidJournalEntry(ctx, check.postedEntryId!);

      // After void: W-2, 941, and the pay-stub list all agree with the GL.
      w2 = await w2Data(ctx, { employeeId: emp.id, year: 2023 });
      expect(w2.wages).toBe('0.00');
      expect(w2.federalWithheld).toBe('0.00');
      expect(w2.socialSecurity).toBe('0.00');
      expect(w2.medicare).toBe('0.00');

      f941 = await form941Data(ctx, { quarter: 2, year: 2023 });
      expect(f941.totals.wages).toBe('0.00');
      expect(f941.totals.socialSecurity).toBe('0.00');
      expect(f941.totals.medicare).toBe('0.00');

      const stubs = await listPaychecks(ctx, { employeeId: emp.id });
      expect(stubs.find((p) => p.id === check.id)).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 5. UTC period ranges — boundary-day paychecks
  // -------------------------------------------------------------------------

  describe('UTC period ranges (boundary-day paychecks)', () => {
    it('a Jan-1 paycheck lands in the correct year and an Apr-1 paycheck in Q2', async () => {
      const emp = await createEmployee(ctx, {
        firstName: 'Bound', lastName: 'Ary', payType: 'salary', payRate: '52000.00',
      });

      // Both dates parse to UTC midnight — exactly how POST /api/payroll stores them.
      await runPaycheck(ctx, {
        employeeId: emp.id,
        payDate: new Date('2024-01-01'),
        grossPay: '1000.00',
        taxes: [],
      });
      await runPaycheck(ctx, {
        employeeId: emp.id,
        payDate: new Date('2024-04-01'),
        grossPay: '500.00',
        taxes: [],
      });

      const w2_2024 = await w2Data(ctx, { employeeId: emp.id, year: 2024 });
      expect(w2_2024.wages).toBe('1500.00');
      const w2_2023 = await w2Data(ctx, { employeeId: emp.id, year: 2023 });
      expect(w2_2023.wages).toBe('0.00'); // Jan 1 2024 must NOT bleed into 2023

      const q1 = await form941Data(ctx, { quarter: 1, year: 2024 });
      expect(q1.totals.wages).toBe('1000.00'); // Jan 1 belongs to Q1...
      const q2 = await form941Data(ctx, { quarter: 2, year: 2024 });
      expect(q2.totals.wages).toBe('500.00');  // ...and Apr 1 to Q2, not Q1
      const q4_2023 = await form941Data(ctx, { quarter: 4, year: 2023 });
      expect(q4_2023.totals.wages).toBe('0.00');
    });
  });

  // -------------------------------------------------------------------------
  // 6. YTD-based SS wage base + Additional Medicare
  // -------------------------------------------------------------------------

  describe('YTD-based wage base and Additional Medicare (runPaycheck integration)', () => {
    it('caps SS and triggers Additional Medicare from actual YTD wages across checks', async () => {
      const emp = await createEmployee(ctx, {
        firstName: 'High', lastName: 'Earner', payType: 'salary', payRate: '500000.00',
      });

      // Check 1 — YTD 0: full SS on 160k, FUTA on first 7k only.
      const c1 = await runPaycheck(ctx, {
        employeeId: emp.id,
        payDate: new Date('2024-01-10'), // 2024 tables: SS wage base 168,600
        grossPay: '160000.00',
      });
      const l1 = Object.fromEntries((await linesFor(c1.id)).map((l) => [`${l.kind}:${l.name}`, l.amount]));
      expect(l1['tax:Social Security']).toBe('9920.00');                    // 160000 × 6.2%
      expect(l1['tax:Medicare']).toBe('2320.00');                           // 1.45%, YTD below 200k
      expect(l1['employer_contribution:Employer Social Security']).toBe('9920.00');
      expect(l1['employer_contribution:Federal Unemployment (FUTA)']).toBe('42.00'); // 7000 × 0.6%

      // Check 2 — YTD 160,000: only 8,600 fits under the 168,600 wage base; no FUTA left.
      const c2 = await runPaycheck(ctx, {
        employeeId: emp.id,
        payDate: new Date('2024-02-10'),
        grossPay: '20000.00',
      });
      const lines2 = await linesFor(c2.id);
      const l2 = Object.fromEntries(lines2.map((l) => [`${l.kind}:${l.name}`, l.amount]));
      expect(l2['tax:Social Security']).toBe('533.20');                     // 8600 × 6.2%
      expect(l2['tax:Medicare']).toBe('290.00');                            // YTD 180k still < 200k
      expect(l2['employer_contribution:Employer Social Security']).toBe('533.20');
      expect(lines2.find((l) => /FUTA/.test(l.name))).toBeUndefined();      // FUTA base exhausted

      // Check 3 — YTD 180,000: SS fully exhausted; Additional Medicare on 10k over 200k.
      const c3 = await runPaycheck(ctx, {
        employeeId: emp.id,
        payDate: new Date('2024-03-10'),
        grossPay: '30000.00',
      });
      const lines3 = await linesFor(c3.id);
      const l3 = Object.fromEntries(lines3.map((l) => [`${l.kind}:${l.name}`, l.amount]));
      expect(lines3.find((l) => l.kind === 'tax' && l.name === 'Social Security')).toBeUndefined();
      expect(l3['tax:Medicare']).toBe('525.00');                            // 30000×1.45% + 10000×0.9%
      // Employer Medicare has NO match on the additional 0.9%.
      expect(l3['employer_contribution:Employer Medicare']).toBe('435.00'); // 30000 × 1.45%

      const tb = await trialBalance(ctx);
      expect(tb.balanced).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Pure-function checks (no DB)
  // -------------------------------------------------------------------------

  describe('computeWithholding / computeEmployerTaxes (pure)', () => {
    it('$20k bonus with low YTD withholds the full 6.2% SS and no Additional Medicare', () => {
      const r = computeWithholding({
        grossPerPeriod: 20000, periodsPerYear: 26, filingStatus: 'single', ytdGrossBefore: 30000,
      });
      expect(r.socialSecurity).toBe('1240.00');
      expect(r.medicare).toBe('290.00'); // 1.45% only — annualizing must not trigger the 0.9%
    });

    it('YTD at the wage base → zero SS', () => {
      const r = computeWithholding({
        grossPerPeriod: 5000, periodsPerYear: 26, filingStatus: 'single', ytdGrossBefore: 168600,
      });
      expect(r.socialSecurity).toBe('0.00');
    });

    it('Additional Medicare applies only to the portion above the YTD threshold', () => {
      const r = computeWithholding({
        grossPerPeriod: 30000, periodsPerYear: 26, filingStatus: 'single', ytdGrossBefore: 180000,
      });
      expect(r.medicare).toBe('525.00'); // 30000×1.45% + 10000×0.9%
    });

    it('computeEmployerTaxes: FICA match + FUTA with YTD caps', () => {
      const fresh = computeEmployerTaxes({ grossPerPeriod: 2000, ytdGrossBefore: 0 });
      expect(fresh.socialSecurity).toBe('124.00');
      expect(fresh.medicare).toBe('29.00');
      expect(fresh.futa).toBe('12.00');
      expect(fresh.total).toBe('165.00');

      const partialFuta = computeEmployerTaxes({ grossPerPeriod: 2000, ytdGrossBefore: 6500 });
      expect(partialFuta.futa).toBe('3.00'); // only 500 left under the $7,000 FUTA base

      const overBase = computeEmployerTaxes({ grossPerPeriod: 5000, ytdGrossBefore: 168600 });
      expect(overBase.socialSecurity).toBe('0.00');
      expect(overBase.medicare).toBe('72.50'); // employer Medicare has no wage base
      expect(overBase.futa).toBe('0.00');
    });
  });
});
