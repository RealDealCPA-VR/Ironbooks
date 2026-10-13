/**
 * P1 payroll forms: the full Form 941 (lines 1-16, Schedule B, deposits from Pay Liabilities,
 * fractions-of-cents line 7, employer block from company info) and Form 940 (line 4 exemptions,
 * Schedule A credit reduction by year, deposits and balance due).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { updateCompany } from './company';
import { createEmployee, updateEmployee, runPaycheck } from './payroll';
import { createPayrollItem } from './payrollItems';
import { payPayrollLiabilities } from './liabilityPayments';
import { form940Data, form941Data } from './payrollReports';
import { render940Pdf, render941Pdf } from '@/lib/pdf/payrollForms';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-payroll-forms');
let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe('P1 payroll forms — Form 941 and Form 940', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'p1forms@test.local', name: 'Owner', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Sunny Bakery', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    await updateCompany(ctx, {
      settings: {
        legalName: 'Sunny Bakery LLC',
        ein: '98-7654321',
        addressLine1: '10 Bread St',
        city: 'Austin',
        state: 'TX',
        zip: '78701',
      },
    });
    for (const [code, name, type, subtype] of [
      ['1000', 'Checking', 'asset', 'checking'],
      ['2300', 'Payroll Liabilities', 'liability', 'other_current_liability'],
      ['6500', 'Payroll Expense', 'expense', 'payroll'],
    ] as const) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    }

    const ann = await createEmployee(ctx, { firstName: 'Ann', lastName: 'Baker', payType: 'salary', payRate: '120000' });
    await updateEmployee(ctx, ann.id, { address: { line1: '1 A St', city: 'Austin', state: 'TX', zip: '78701' } });
    const ben = await createEmployee(ctx, { firstName: 'Ben', lastName: 'Cook', payType: 'salary', payRate: '60000' });
    await updateEmployee(ctx, ben.id, { address: { line1: '2 B St', city: 'Fresno', state: 'CA', zip: '93701' } });
    const health = await createPayrollItem(ctx, { name: 'Health (Sec 125)', kind: 'deduction', pretax: true, taxTracking: 'section125', liabilityAccountId: acct['2300'] });

    const er = (ss: string, med: string, futa: string) => [
      { kind: 'employer_contribution' as const, name: 'Employer Social Security', amount: ss },
      { kind: 'employer_contribution' as const, name: 'Employer Medicare', amount: med },
      { kind: 'employer_contribution' as const, name: 'Federal Unemployment (FUTA)', amount: futa },
    ];
    const ee = (fit: string, ss: string, med: string) => [
      { kind: 'tax' as const, name: 'Federal Income Tax', amount: fit },
      { kind: 'tax' as const, name: 'Social Security', amount: ss },
      { kind: 'tax' as const, name: 'Medicare', amount: med },
    ];
    // Ann: Jan 10 (period Jan 1-15) and Mar 14 (period Mar 1-15, includes the 12th).
    await runPaycheck(ctx, {
      employeeId: ann.id, payDate: d('2025-01-10'), periodStart: d('2025-01-01'), periodEnd: d('2025-01-15'),
      grossPay: '10000.00', taxes: ee('1000.00', '620.00', '145.00'), employerTaxes: er('620.00', '145.00', '42.00'),
    });
    await runPaycheck(ctx, {
      employeeId: ann.id, payDate: d('2025-03-14'), periodStart: d('2025-03-01'), periodEnd: d('2025-03-15'),
      // 1 cent of rounding on the employee's Social Security → line 7.
      grossPay: '10000.00', taxes: ee('1000.00', '620.01', '145.00'), employerTaxes: er('620.00', '145.00', '0.00'),
    });
    // Ben: Feb 20 (period Feb 1-15) with a $200 Section 125 deduction (exempt from FICA and FUTA).
    await runPaycheck(ctx, {
      employeeId: ben.id, payDate: d('2025-02-20'), periodStart: d('2025-02-01'), periodEnd: d('2025-02-15'),
      grossPay: '5000.00', taxes: ee('500.00', '297.60', '69.60'), employerTaxes: er('297.60', '69.60', '28.80'),
      deductions: [{ kind: 'deduction', name: 'Health (Sec 125)', amount: '200.00', payrollItemId: health.id }],
    });

    const pay = (date: string, items: Array<[string, string]>) =>
      payPayrollLiabilities(ctx, { date: d(date), paymentAccountId: acct['1000'], items: items.map(([name, amount]) => ({ name, amount })) });
    // A Q4 2024 deposit made in January — belongs to the previous quarter.
    await pay('2025-01-10', [['Federal Income Tax', '99.00']]);
    await pay('2025-02-14', [['Federal Income Tax', '1000.00'], ['Social Security', '1240.00'], ['Medicare', '290.00']]);
    await pay('2025-03-14', [['Federal Income Tax', '500.00'], ['Social Security', '595.20'], ['Medicare', '139.20']]);
    await pay('2025-04-15', [['Federal Income Tax', '1000.00'], ['Social Security', '1240.01'], ['Medicare', '290.00'], ['Federal Unemployment (FUTA)', '42.00']]);
    // Not a 941 deposit (too late for Q1, and a state item).
    await pay('2025-04-30', [['Federal Income Tax', '5.00'], ['State Withholding', '10.00']]);
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('fills every Form 941 line for the quarter', async () => {
    const f = await form941Data(ctx, { quarter: 1, year: 2025 });
    expect(f.company).toEqual({ name: 'Sunny Bakery LLC', tradeName: 'Sunny Bakery', address: '10 Bread St, Austin, TX 78701', ein: '98-7654321' });
    expect(f.lines).toEqual({
      line1: 1, // only Ann was paid for the pay period that includes March 12
      line2: '24800.00',
      line3: '2500.00',
      line4: false,
      line5aWages: '24800.00',
      line5aTax: '3075.20',
      line5bWages: '0.00',
      line5bTax: '0.00',
      line5cWages: '24800.00',
      line5cTax: '719.20',
      line5dWages: '0.00',
      line5dTax: '0.00',
      line5e: '3794.40',
      line5f: '0.00',
      line6: '6294.40',
      line7: '0.01',
      line8: '0.00',
      line9: '0.00',
      line10: '6294.41',
      line11: '0.00',
      line12: '6294.41',
      line13: '6294.41',
      line14: '0.00',
      line15: '0.00',
    });
    expect(f.totals.employeeCount).toBe(2);
    // Deposits: Feb 14, Mar 14 and Apr 15 941 items only.
    expect(f.deposits.map((x) => `${x.date} ${x.item} ${x.amount}`)).toEqual([
      '2025-02-14 Federal Income Tax 1000.00',
      '2025-02-14 Social Security 1240.00',
      '2025-02-14 Medicare 290.00',
      '2025-03-14 Federal Income Tax 500.00',
      '2025-03-14 Social Security 595.20',
      '2025-03-14 Medicare 139.20',
      '2025-04-15 Federal Income Tax 1000.00',
      '2025-04-15 Social Security 1240.01',
      '2025-04-15 Medicare 290.00',
    ]);
    // Line 16 monthly liabilities total line 12.
    expect(f.schedule).toMatchObject({ kind: 'monthly', months: ['2530.00', '1234.40', '2530.01'], total: '6294.41', scheduleB: null });
  });

  it('semiweekly depositors get Schedule B daily liabilities; deposits can be overridden', async () => {
    const f = await form941Data(ctx, { quarter: 1, year: 2025, depositSchedule: 'semiweekly', depositsOverride: '6000' });
    expect(f.schedule.kind).toBe('semiweekly');
    expect(f.schedule.scheduleB).toEqual([
      { month: 1, days: [{ day: 10, amount: '2530.00' }], total: '2530.00' },
      { month: 2, days: [{ day: 20, amount: '1234.40' }], total: '1234.40' },
      { month: 3, days: [{ day: 14, amount: '2530.01' }], total: '2530.01' },
    ]);
    expect(f.lines.line13).toBe('6000.00');
    expect(f.lines.line14).toBe('294.41');
    expect(f.deposits).toEqual([]);
    expect(f.depositsOverridden).toBe(true);
    const pdf = await render941Pdf(f);
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1500);
  });

  it('a small quarter (< $2,500) needs no line 16 schedule; an empty quarter is all zeros', async () => {
    const q2 = await form941Data(ctx, { quarter: 2, year: 2025 });
    expect(q2.lines.line12).toBe('0.00');
    expect(q2.schedule.kind).toBe('under2500');
    // The Apr 15 deposit belongs to Q1, not Q2; Apr 30 is a Q2-window 941 payment.
    expect(q2.lines.line13).toBe('5.00');
    expect(q2.lines.line15).toBe('5.00');
  });

  it('Form 940: exempt payments, credit reduction (Schedule A), deposits and balance due', async () => {
    const f = await form940Data(ctx, { year: 2025 });
    expect(f.totalPayments).toBe('25000.00');
    expect(f.exemptPayments).toBe('200.00');
    expect(f.exemptBreakdown).toMatchObject({ fringeBenefits: '200.00', dependentCare: '0.00' });
    expect(f.excessOver7000).toBe('13000.00'); // Ann 20,000 − 7,000
    expect(f.taxableFutaWages).toBe('11800.00');
    expect(f.futaTaxCalculated).toBe('70.80');
    // Ben works in California, a 2025 credit reduction state (1.2%).
    expect(f.creditReduction).toMatchObject({ known: true, total: '57.60', rows: [{ state: 'CA', wages: '4800.00', rate: '0.012', amount: '57.60' }] });
    expect(f.creditReduction.source).toMatch(/Department of Labor/);
    expect(f.line12).toBe('128.40');
    expect(f.line13).toBe('42.00');
    expect(f.line14).toBe('86.40');
    expect(f.quarters.map((q) => q.futaLiability)).toEqual(['70.80', '0.00', '0.00', '57.60']);
    expect(f.totalQuarterlyLiability).toBe('128.40');
    expect(f.warnings).toEqual([]);
    const pdf = await render940Pdf(f);
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe('%PDF-');
  });

  it('Form 940 warns when the credit reduction list for the year is not known yet', async () => {
    const ann2026 = await createEmployee(ctx, { firstName: 'Cal', lastName: 'Future', payType: 'salary', payRate: '50000' });
    await updateEmployee(ctx, ann2026.id, { address: { line1: '3 C St', state: 'CA' } });
    await runPaycheck(ctx, {
      employeeId: ann2026.id, payDate: d('2026-02-01'), grossPay: '1000.00',
      taxes: [], employerTaxes: [{ kind: 'employer_contribution', name: 'Federal Unemployment (FUTA)', amount: '6.00' }],
    });
    const f = await form940Data(ctx, { year: 2026 });
    expect(f.creditReduction.known).toBe(false);
    expect(f.creditReduction.total).toBe('0.00');
    expect(f.warnings.join(' ')).toMatch(/not published/);
  });
});
