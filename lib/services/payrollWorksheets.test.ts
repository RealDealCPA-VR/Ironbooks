/**
 * Integration tests for the payroll worksheets + liability-detail wave:
 *
 *  1. form940Data — annual FUTA worksheet (total payments, $7,000-base excess,
 *     calculated vs accrued FUTA, quarterly liability breakdown, void exclusion).
 *  2. w3Data — W-3 transmittal totals (per-employee SS wage-base cap, state totals,
 *     employer EIN from company settings).
 *  3. w2Data — Boxes 3/5 (SS/Medicare wages with the SS cap), state boxes 15-17,
 *     employer EIN.
 *  4. payPayrollLiabilities by item — per-item 2300 debit lines with item-name memos
 *     + payrollLiabilityBalances per-item paid/balance.
 *  5. Sick/vacation accrual — employees.accruals policy, hours-based accrual for
 *     hourly (from earning-line hours), flat per-paycheck for salary, asOf baseline.
 *  6. PDF smoke — render940Pdf / renderW3Pdf / renderW2Pdf (with new boxes) return
 *     valid PDF bytes.
 *
 * Boot pattern mirrors payrollReports.test.ts: throwaway PGlite dir, seeded
 * accounts + employees, paychecks with EXPLICIT tax lines for determinism.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { updateCompany } from './company';
import { createEmployee, updateEmployee, runPaycheck, voidPaycheck } from './payroll';
import { payPayrollLiabilities } from './liabilityPayments';
import { trialBalance } from './reports';
import {
  form940Data,
  w3Data,
  w2Data,
  payrollLiabilityBalances,
  sickVacationBalances,
  setEmployeeAccrualPolicy,
} from './payrollReports';
import { render940Pdf, renderW3Pdf, renderW2Pdf } from '@/lib/pdf/payrollForms';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-payroll-worksheets');

let ctx: ServiceContext;
let db: DB;
let aliceId: string; // salary, CA state withholding
let bobId: string;   // hourly, 80 hrs/check
let carlId: string;  // salary, single check over the SS wage base

const acct: Record<string, string> = {};

describe('payroll worksheets — 940 / W-3 / W-2 boxes / liabilities by item / accruals', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'worksheets@test.local', name: 'Worksheets Owner', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'Worksheets Test Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    // Employer EIN + address live in companies.settings.
    await updateCompany(ctx, {
      settings: { ein: '12-3456789', address: '1 Main St, Springfield, CA 90001' },
    });

    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking',            'asset',     'checking'],
      ['2300', 'Payroll Liabilities', 'liability', 'long_term_liability'],
      ['6500', 'Payroll Expense',     'expense',   'payroll'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }

    // ── Employees ────────────────────────────────────────────────────────────
    const alice = await createEmployee(ctx, {
      firstName: 'Alice', lastName: 'Smith', payType: 'salary', payRate: '130000.00',
    });
    aliceId = alice.id;
    await updateEmployee(ctx, aliceId, { address: { line1: '2 Oak Ave', state: 'CA' } });

    const bob = await createEmployee(ctx, {
      firstName: 'Bob', lastName: 'Jones', payType: 'hourly', payRate: '25.00',
    });
    bobId = bob.id;

    const carl = await createEmployee(ctx, {
      firstName: 'Carl', lastName: 'Big', payType: 'salary', payRate: '400000.00',
    });
    carlId = carl.id;

    // ── Paychecks (explicit tax lines for deterministic math) ────────────────
    // Alice check 1 — Q1 2024, gross 5,000, full FUTA base still open: FUTA 30.
    await runPaycheck(ctx, {
      employeeId: aliceId,
      payDate: new Date('2024-02-10'),
      grossPay: '5000.00',
      taxes: [
        { kind: 'tax', name: 'Federal Income Tax',     amount: '400.00' },
        { kind: 'tax', name: 'Social Security',        amount: '310.00' },
        { kind: 'tax', name: 'Medicare',               amount: '72.50' },
        { kind: 'tax', name: 'State Income Tax (CA)',  amount: '250.00' },
      ],
      employerTaxes: [
        { kind: 'employer_contribution', name: 'Employer Social Security',    amount: '310.00' },
        { kind: 'employer_contribution', name: 'Employer Medicare',           amount: '72.50' },
        { kind: 'employer_contribution', name: 'Federal Unemployment (FUTA)', amount: '30.00' },
      ],
    });

    // Alice check 2 — Q2 2024, gross 5,000, only 2,000 left under the 7,000 base: FUTA 12.
    await runPaycheck(ctx, {
      employeeId: aliceId,
      payDate: new Date('2024-04-10'),
      grossPay: '5000.00',
      taxes: [
        { kind: 'tax', name: 'Federal Income Tax',     amount: '400.00' },
        { kind: 'tax', name: 'Social Security',        amount: '310.00' },
        { kind: 'tax', name: 'Medicare',               amount: '72.50' },
        { kind: 'tax', name: 'State Income Tax (CA)',  amount: '250.00' },
      ],
      employerTaxes: [
        { kind: 'employer_contribution', name: 'Employer Social Security',    amount: '310.00' },
        { kind: 'employer_contribution', name: 'Employer Medicare',           amount: '72.50' },
        { kind: 'employer_contribution', name: 'Federal Unemployment (FUTA)', amount: '12.00' },
      ],
    });

    // Bob — Q1 2024, hourly: 80 hrs × $25 = 2,000 gross (hours embedded in the
    // earning line name drive the hourly sick/vacation accrual). FUTA 12 (2,000 × 0.6%).
    await runPaycheck(ctx, {
      employeeId: bobId,
      payDate: new Date('2024-03-15'),
      earnings: [{ kind: 'regular', hours: 80, rate: 25 }],
      taxes: [],
      employerTaxes: [
        { kind: 'employer_contribution', name: 'Federal Unemployment (FUTA)', amount: '12.00' },
      ],
    });

    // Carl — Q2 2024, single 200,000 check (over the 168,600 SS wage base; FUTA base
    // exhausted within the check — modeled here with no FUTA line, no taxes).
    await runPaycheck(ctx, {
      employeeId: carlId,
      payDate: new Date('2024-06-01'),
      grossPay: '200000.00',
      taxes: [],
      employerTaxes: [],
    });

    // A voided check must drop out of every worksheet: run + void.
    const voided = await runPaycheck(ctx, {
      employeeId: aliceId,
      payDate: new Date('2024-07-01'),
      grossPay: '1000.00',
      taxes: [{ kind: 'tax', name: 'Federal Income Tax', amount: '100.00' }],
      employerTaxes: [
        { kind: 'employer_contribution', name: 'Federal Unemployment (FUTA)', amount: '6.00' },
      ],
    });
    await voidPaycheck(ctx, voided.id);
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // 1. Form 940
  // ---------------------------------------------------------------------------

  it('form940Data aggregates payments, the $7,000-base excess, and FUTA tax', async () => {
    const data = await form940Data(ctx, { year: 2024 });

    expect(data.company.name).toBe('Worksheets Test Co');
    expect(data.company.ein).toBe('12-3456789');
    expect(data.employeeCount).toBe(3);

    // Line 3: 10,000 (Alice) + 2,000 (Bob) + 200,000 (Carl). Voided 1,000 excluded.
    expect(data.totalPayments).toBe('212000.00');
    expect(data.exemptPayments).toBe('0.00');
    // Line 5: Alice 3,000 over + Carl 193,000 over (Bob under the base).
    expect(data.excessOver7000).toBe('196000.00');
    expect(data.subtotal).toBe('196000.00');
    // Line 7: 212,000 − 196,000.
    expect(data.taxableFutaWages).toBe('16000.00');
    // Line 8: 16,000 × 0.6%.
    expect(data.futaTaxCalculated).toBe('96.00');
    // Accrued FUTA lines: 30 + 12 + 12 (voided 6.00 excluded). Carl accrued none.
    expect(data.futaTaxAccrued).toBe('54.00');
  });

  it('form940Data breaks the FUTA liability down by quarter', async () => {
    const data = await form940Data(ctx, { year: 2024 });
    const byQ = Object.fromEntries(data.quarters.map((q) => [q.quarter, q.futaLiability]));
    expect(byQ[1]).toBe('42.00'); // Alice Feb 30 + Bob Mar 12
    expect(byQ[2]).toBe('12.00'); // Alice Apr 12
    expect(byQ[3]).toBe('0.00');  // voided July check excluded
    // Alice works in California, a 2024 FUTA credit reduction state (0.9%): Schedule A adds
    // 7,000 x 0.9% = 63.00, which the IRS has you report in the 4th quarter.
    expect(byQ[4]).toBe('63.00');
    expect(data.creditReduction.rows).toEqual([{ state: 'CA', wages: '7000.00', rate: '0.009', amount: '63.00' }]);
    expect(data.totalQuarterlyLiability).toBe('117.00');
  });

  it('form940Data returns zeros for a year with no payroll', async () => {
    const data = await form940Data(ctx, { year: 2023 });
    expect(data.totalPayments).toBe('0.00');
    expect(data.futaTaxAccrued).toBe('0.00');
    expect(data.employeeCount).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 2. W-3 transmittal
  // ---------------------------------------------------------------------------

  it('w3Data totals all W-2s with the SS wage base applied per employee', async () => {
    const data = await w3Data(ctx, { year: 2024 });

    expect(data.company.ein).toBe('12-3456789');
    expect(data.company.address).toBe('1 Main St, Springfield, CA 90001');
    expect(data.w2Count).toBe(3);

    expect(data.wages).toBe('212000.00');           // Box 1
    expect(data.federalWithheld).toBe('800.00');    // Box 2 (Alice 400 × 2; voided excluded)
    // Box 3: Alice 10,000 + Bob 2,000 + Carl capped at 168,600.
    expect(data.ssWages).toBe('180600.00');
    expect(data.socialSecurity).toBe('620.00');     // Box 4
    expect(data.medicareWages).toBe('212000.00');   // Box 5 (no cap)
    expect(data.medicare).toBe('145.00');           // Box 6
    // Boxes 16/17: only Alice has state withholding.
    expect(data.stateWages).toBe('10000.00');
    expect(data.stateWithheld).toBe('500.00');
  });

  // ---------------------------------------------------------------------------
  // 3. W-2 Boxes 3/5, state 15-17, EIN
  // ---------------------------------------------------------------------------

  it('w2Data reports Boxes 3/5, state boxes 15-17, and the employer EIN', async () => {
    const data = await w2Data(ctx, { employeeId: aliceId, year: 2024 });

    expect(data.company.ein).toBe('12-3456789');
    expect(data.wages).toBe('10000.00');
    expect(data.federalWithheld).toBe('800.00');
    expect(data.ssWages).toBe('10000.00');       // under the cap → equals Box 1
    expect(data.medicareWages).toBe('10000.00');
    expect(data.socialSecurity).toBe('620.00');
    expect(data.medicare).toBe('145.00');

    expect(data.state.code).toBe('CA');           // from the employee address
    expect(data.state.wages).toBe('10000.00');
    expect(data.state.withheld).toBe('500.00');
  });

  it('w2Data caps Box 3 at the Social Security wage base', async () => {
    const data = await w2Data(ctx, { employeeId: carlId, year: 2024 });
    expect(data.wages).toBe('200000.00');
    expect(data.ssWages).toBe('168600.00');       // capped
    expect(data.medicareWages).toBe('200000.00'); // not capped
    // No state lines, no address state → empty state boxes.
    expect(data.state.code).toBeNull();
    expect(data.state.withheld).toBe('0.00');
    expect(data.state.wages).toBe('0.00');
  });

  // ---------------------------------------------------------------------------
  // 4. Pay liabilities by item
  // ---------------------------------------------------------------------------

  it('payrollLiabilityBalances lists per-item accrued with zero paid before any payment', async () => {
    const balances = await payrollLiabilityBalances(ctx, { asOf: new Date('2024-12-31') });

    const fit = balances.items.find((i) => i.name === 'Federal Income Tax')!;
    expect(fit.accrued).toBe('800.00');
    expect(fit.paid).toBe('0.00');
    expect(fit.balance).toBe('800.00');

    // baseName strips the "(FUTA)" suffix for cross-check grouping.
    const futa = balances.items.find((i) => i.name === 'Federal Unemployment')!;
    expect(futa.kind).toBe('employer_contribution');
    expect(futa.accrued).toBe('54.00');
  });

  it('payPayrollLiabilities with items posts per-item memo lines that reconcile per item', async () => {
    const entry = await payPayrollLiabilities(ctx, {
      date: new Date('2024-05-01'),
      paymentAccountId: acct['1000'],
      items: [
        { name: 'Federal Income Tax', amount: '300.00' },
        { name: 'Social Security',    amount: '100.00' },
      ],
    });
    expect(entry.description).toBe('Pay Payroll Liabilities — 2 items');

    const balances = await payrollLiabilityBalances(ctx, { asOf: new Date('2024-12-31') });

    const fit = balances.items.find((i) => i.name === 'Federal Income Tax')!;
    expect(fit.paid).toBe('300.00');
    expect(fit.balance).toBe('500.00');

    const ss = balances.items.find((i) => i.name === 'Social Security' && i.kind === 'tax')!;
    expect(ss.paid).toBe('100.00');
    expect(ss.balance).toBe('520.00'); // 620 accrued − 100 paid

    // Untouched item keeps a zero paid figure.
    const medicare = balances.items.find((i) => i.name === 'Medicare' && i.kind === 'tax')!;
    expect(medicare.paid).toBe('0.00');

    expect(balances.totalPaid).toBe('400.00');

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('payPayrollLiabilities validates item amounts, names, and the amount/items match', async () => {
    await expect(
      payPayrollLiabilities(ctx, {
        date: new Date('2024-05-02'),
        paymentAccountId: acct['1000'],
        items: [{ name: 'Federal Income Tax', amount: '0' }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    await expect(
      payPayrollLiabilities(ctx, {
        date: new Date('2024-05-02'),
        paymentAccountId: acct['1000'],
        items: [{ name: '   ', amount: '10.00' }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    await expect(
      payPayrollLiabilities(ctx, {
        date: new Date('2024-05-02'),
        paymentAccountId: acct['1000'],
        items: [
          { name: 'Medicare', amount: '10.00' },
          { name: 'Medicare', amount: '5.00' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    // amount, when provided alongside items, must equal the item sum.
    await expect(
      payPayrollLiabilities(ctx, {
        amount: '99.00',
        date: new Date('2024-05-02'),
        paymentAccountId: acct['1000'],
        items: [{ name: 'Medicare', amount: '10.00' }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    // Lump-sum path still requires an amount.
    await expect(
      payPayrollLiabilities(ctx, {
        date: new Date('2024-05-02'),
        paymentAccountId: acct['1000'],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  // ---------------------------------------------------------------------------
  // 5. Sick / vacation accrual
  // ---------------------------------------------------------------------------

  it('accrues hours-based for hourly employees from earning-line hours', async () => {
    const row = await setEmployeeAccrualPolicy(ctx, bobId, {
      sickRateHrsPerHour: 0.05,
      vacRateHrsPerHour: 0.04,
      sickBalance: 10,
      vacBalance: 0,
      asOf: '2024-01-01',
    });

    // One 80-hour check after 2024-01-01.
    expect(row.payType).toBe('hourly');
    expect(row.paychecksCounted).toBe(1);
    expect(row.sick.accrued).toBe('4.00');     // 80 × 0.05
    expect(row.sick.balance).toBe('14.00');    // 10 + 4
    expect(row.vacation.accrued).toBe('3.20'); // 80 × 0.04
    expect(row.vacation.balance).toBe('3.20');
  });

  it('accrues a flat amount per paycheck for salaried employees, honoring asOf', async () => {
    const row = await setEmployeeAccrualPolicy(ctx, aliceId, {
      sickRateHrsPerHour: 2,
      vacRateHrsPerHour: 4,
      sickBalance: 0,
      vacBalance: 5,
      asOf: '2024-03-01',
    });

    // Only the Apr 10 check is after asOf (Feb check baselined; voided July check excluded).
    expect(row.paychecksCounted).toBe(1);
    expect(row.sick.accrued).toBe('2.00');
    expect(row.sick.balance).toBe('2.00');
    expect(row.vacation.accrued).toBe('4.00');
    expect(row.vacation.balance).toBe('9.00');
  });

  it('returns zero balances and hasPolicy=false for employees without a policy', async () => {
    const rows = await sickVacationBalances(ctx);
    const carl = rows.find((r) => r.employeeId === carlId)!;
    expect(carl.hasPolicy).toBe(false);
    expect(carl.sick.balance).toBe('0.00');
    expect(carl.vacation.balance).toBe('0.00');

    // All-employee listing carries the configured ones too.
    const bob = rows.find((r) => r.employeeId === bobId)!;
    expect(bob.sick.balance).toBe('14.00');
  });

  it('validates accrual policy inputs', async () => {
    await expect(
      setEmployeeAccrualPolicy(ctx, bobId, { sickRateHrsPerHour: -1 }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    await expect(
      setEmployeeAccrualPolicy(ctx, bobId, { asOf: 'March 1' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    await expect(
      sickVacationBalances(ctx, { employeeId: '00000000-0000-0000-0000-000000000000' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('clearing the policy resets balances to zero', async () => {
    const row = await setEmployeeAccrualPolicy(ctx, bobId, null);
    expect(row.hasPolicy).toBe(false);
    expect(row.sick.balance).toBe('0.00');
  });

  // ---------------------------------------------------------------------------
  // 6. PDF smoke
  // ---------------------------------------------------------------------------

  it('render940Pdf / renderW3Pdf / renderW2Pdf produce valid PDF bytes', async () => {
    const f940 = await form940Data(ctx, { year: 2024 });
    const w3 = await w3Data(ctx, { year: 2024 });
    const w2 = await w2Data(ctx, { employeeId: aliceId, year: 2024 });

    for (const bytes of [
      await render940Pdf(f940),
      await renderW3Pdf(w3),
      await renderW2Pdf(w2),
    ]) {
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.length).toBeGreaterThan(100);
      expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('%PDF');
    }
  });
});
