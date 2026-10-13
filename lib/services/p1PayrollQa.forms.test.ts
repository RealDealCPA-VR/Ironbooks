/**
 * Independent QA (tester) for the P1 payroll forms: Form 941 and Form 940.
 *
 * Adversarial cases the doer's tests do not cover:
 *  - line 1 pay-period rule with checks that do NOT include the 12th, checks without period dates;
 *  - voided paychecks and voided liability payments never reach the forms;
 *  - state withholding / SUI / FUTA payments inside the 941 deposit window are not 941 deposits;
 *  - line 16 months always total line 12; line 12 = line 3 + Social Security + Medicare booked;
 *  - Social Security wage base cap and Additional Medicare (5d) across quarters;
 *  - multi-company isolation (another company's checks and deposits never leak in);
 *  - semiweekly depositors: a deposit made in the first half of the quarter's first month for a
 *    payday IN the quarter belongs to that quarter (and not to the previous one);
 *  - Form 940 credit reduction (CA 2025), FUTA deposits window, SUI payments excluded;
 *  - API wiring of /api/payroll/941 and /api/payroll/940 (JSON, PDF, validation).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { NextRequest } from 'next/server';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { updateCompany } from './company';
import { createEmployee, updateEmployee, runPaycheck, voidPaycheck } from './payroll';
import { payPayrollLiabilities } from './liabilityPayments';
import { voidJournalEntry } from './posting';
import { form940Data, form941Data } from './payrollReports';
import { trialBalance } from './reports';
import { Money } from '@/lib/money';

let routeCtx: ServiceContext;
vi.mock('@/lib/context', () => ({
  getServerContext: vi.fn(async () => routeCtx),
}));
import { GET as get941 } from '@/app/api/payroll/941/route';
import { GET as get940 } from '@/app/api/payroll/940/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-payroll-qa-forms');
let db: DB;
let userId: string;
const d = (s: string) => new Date(`${s}T00:00:00Z`);

async function newCompany(name: string, state = 'TX'): Promise<{ ctx: ServiceContext; acct: Record<string, string> }> {
  const [company] = await db.insert(companies).values({ name, ownerId: userId }).returning();
  const ctx: ServiceContext = { db, companyId: company.id, userId };
  await updateCompany(ctx, { settings: { legalName: `${name} LLC`, ein: '12-3456789', addressLine1: '1 Main', city: 'Austin', state, zip: '78701' } });
  const acct: Record<string, string> = {};
  for (const [code, nm, type, subtype] of [
    ['1000', 'Checking', 'asset', 'checking'],
    ['2300', 'Payroll Liabilities', 'liability', 'other_current_liability'],
    ['6500', 'Payroll Expense', 'expense', 'payroll'],
  ] as const) {
    acct[code] = (await createAccount(ctx, { code, name: nm, type: type as never, subtype })).id;
  }
  return { ctx, acct };
}

async function emp(ctx: ServiceContext, first: string, state: string) {
  const e = await createEmployee(ctx, { firstName: first, lastName: 'Test', payType: 'salary', payRate: '50000' });
  await updateEmployee(ctx, e.id, { address: { line1: '1 St', city: 'Town', state, zip: '00000' } });
  return e.id;
}

const ee = (fit: string, ss: string, med: string) => [
  { kind: 'tax' as const, name: 'Federal Income Tax', amount: fit },
  { kind: 'tax' as const, name: 'Social Security', amount: ss },
  { kind: 'tax' as const, name: 'Medicare', amount: med },
];
const er = (ss: string, med: string, futa: string) => [
  { kind: 'employer_contribution' as const, name: 'Employer Social Security', amount: ss },
  { kind: 'employer_contribution' as const, name: 'Employer Medicare', amount: med },
  { kind: 'employer_contribution' as const, name: 'Federal Unemployment (FUTA)', amount: futa },
];

function pay(ctx: ServiceContext, bank: string, date: string, items: Array<[string, string]>) {
  return payPayrollLiabilities(ctx, { date: d(date), paymentAccountId: bank, items: items.map(([name, amount]) => ({ name, amount })) });
}

// Company A — monthly depositor, three employees, Q1 2025.
let A: { ctx: ServiceContext; acct: Record<string, string> };

describe('P1 payroll forms — tester QA', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'p1formsqa@test.local', name: 'Owner', passwordHash: 'x' }).returning();
    userId = u.id;

    A = await newCompany('Alpha Payroll');
    const { ctx, acct } = A;
    routeCtx = ctx;
    const ann = await emp(ctx, 'Ann', 'CA');
    const bob = await emp(ctx, 'Bob', 'TX');
    const cara = await emp(ctx, 'Cara', 'TX');

    // Ann: Jan 15 (period Jan 1-15) and Mar 14 (period Mar 1-15 — includes March 12).
    await runPaycheck(ctx, {
      employeeId: ann, payDate: d('2025-01-15'), periodStart: d('2025-01-01'), periodEnd: d('2025-01-15'),
      grossPay: '4000.00', taxes: ee('400.00', '248.00', '58.00'), employerTaxes: er('248.00', '58.00', '24.00'),
    });
    await runPaycheck(ctx, {
      employeeId: ann, payDate: d('2025-03-14'), periodStart: d('2025-03-01'), periodEnd: d('2025-03-15'),
      grossPay: '4000.00', taxes: ee('400.00', '248.00', '58.00'), employerTaxes: er('248.00', '58.00', '18.00'),
    });
    // Bob: Mar 31 for the period Mar 16-31 — does NOT include March 12 → not on line 1.
    await runPaycheck(ctx, {
      employeeId: bob, payDate: d('2025-03-31'), periodStart: d('2025-03-16'), periodEnd: d('2025-03-31'),
      grossPay: '3000.00', taxes: ee('300.00', '186.00', '43.50'), employerTaxes: er('186.00', '43.50', '18.00'),
    });
    // Bob: a voided February check must not reach any form.
    const voided = await runPaycheck(ctx, {
      employeeId: bob, payDate: d('2025-02-14'), periodStart: d('2025-02-01'), periodEnd: d('2025-02-14'),
      grossPay: '9999.00', taxes: ee('999.00', '619.94', '144.99'), employerTaxes: er('619.94', '144.99', '0.00'),
    });
    await voidPaycheck(ctx, voided.id);
    // Cara: paid Mar 20 with no pay-period dates → counted on line 1 (paid in the last month).
    await runPaycheck(ctx, {
      employeeId: cara, payDate: d('2025-03-20'),
      grossPay: '1000.00', taxes: ee('0.00', '62.00', '14.50'), employerTaxes: er('62.00', '14.50', '6.00'),
    });

    const bank = acct['1000'];
    // Jan liability (1,012.00) deposited Feb 14.
    await pay(ctx, bank, '2025-02-14', [['Federal Income Tax', '400.00'], ['Social Security', '496.00'], ['Medicare', '116.00']]);
    // Inside the Q1 deposit window but NOT 941 taxes.
    await pay(ctx, bank, '2025-02-20', [['State Withholding', '50.00'], ['State Unemployment (CA)', '20.00'], ['Federal Unemployment (FUTA)', '42.00']]);
    // A prior-year FUTA deposit made in January (not a 2025 Form 940 deposit).
    await pay(ctx, bank, '2025-01-20', [['Federal Unemployment (FUTA)', '5.00']]);
    // A deposit that was voided.
    const bad = await pay(ctx, bank, '2025-03-10', [['Federal Income Tax', '999.00']]);
    await voidJournalEntry(ctx, bad.id);
    // March liability (1,924.00) deposited Apr 15 (last day of the window).
    await pay(ctx, bank, '2025-04-15', [['Federal Income Tax', '700.00'], ['Social Security', '992.00'], ['Medicare', '232.00']]);

    // Company B — must never leak into company A's forms.
    const B = await newCompany('Beta Payroll', 'CA');
    const bEmp = await emp(B.ctx, 'Zed', 'CA');
    await runPaycheck(B.ctx, {
      employeeId: bEmp, payDate: d('2025-03-12'), periodStart: d('2025-03-01'), periodEnd: d('2025-03-15'),
      grossPay: '50000.00', taxes: ee('5000.00', '3100.00', '725.00'), employerTaxes: er('3100.00', '725.00', '42.00'),
    });
    await pay(B.ctx, B.acct['1000'], '2025-03-20', [['Federal Income Tax', '5000.00'], ['Social Security', '6200.00'], ['Medicare', '1450.00'], ['Federal Unemployment (FUTA)', '42.00']]);
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('941: line 1 pay-period rule, voided checks excluded, every line consistent', async () => {
    const f = await form941Data(A.ctx, { quarter: 1, year: 2025 });
    expect(f.company.name).toBe('Alpha Payroll LLC');
    expect(f.company.ein).toBe('12-3456789');
    // Ann (period includes Mar 12) + Cara (no period dates, paid in March). Bob's Mar 16-31 period doesn't count.
    expect(f.lines.line1).toBe(2);
    expect(f.lines.line2).toBe('12000.00');
    expect(f.lines.line3).toBe('1100.00');
    expect(f.lines.line5aWages).toBe('12000.00');
    expect(f.lines.line5aTax).toBe('1488.00');
    expect(f.lines.line5cWages).toBe('12000.00');
    expect(f.lines.line5cTax).toBe('348.00');
    expect(f.lines.line5dWages).toBe('0.00');
    expect(f.lines.line5e).toBe('1836.00');
    expect(f.lines.line7).toBe('0.00');
    expect(f.lines.line12).toBe('2936.00');
    expect(f.lines.line4).toBe(false);
  });

  it('941: line 12 always equals line 16 total and the tax actually booked', async () => {
    const f = await form941Data(A.ctx, { quarter: 1, year: 2025 });
    expect(f.schedule.kind).toBe('monthly');
    expect(f.schedule.months).toEqual(['1012.00', '0.00', '1924.00']);
    expect(f.schedule.total).toBe(f.lines.line12);
    // line 12 = line 3 + all Social Security + Medicare withheld and accrued.
    const booked = Money.of(f.lines.line3)
      .plus(f.totals.socialSecurity)
      .plus(f.totals.medicare);
    expect(booked.toFixed(2)).toBe(f.lines.line12);
    // Semiweekly: Schedule B days total each month and the months total line 12.
    const s = await form941Data(A.ctx, { quarter: 1, year: 2025, depositSchedule: 'semiweekly' });
    expect(s.schedule.kind).toBe('semiweekly');
    for (const m of s.schedule.scheduleB!) {
      const sum = m.days.reduce((acc, x) => acc.plus(x.amount), Money.zero());
      expect(sum.toFixed(2)).toBe(m.total);
    }
    expect(s.schedule.scheduleB!.map((m) => m.days.map((x) => x.day))).toEqual([[15], [], [14, 20, 31]]);
  });

  it('941 line 13: only federal withholding / Social Security / Medicare deposits; voided and state/FUTA payments excluded', async () => {
    const f = await form941Data(A.ctx, { quarter: 1, year: 2025 });
    expect(f.deposits.map((x) => x.item).sort()).toEqual(
      ['Federal Income Tax', 'Federal Income Tax', 'Medicare', 'Medicare', 'Social Security', 'Social Security'],
    );
    expect(f.lines.line13).toBe('2936.00');
    expect(f.lines.line14).toBe('0.00');
    expect(f.lines.line15).toBe('0.00');
    // Q2 has no liability; the Apr 15 deposit belongs to Q1, not Q2.
    const q2 = await form941Data(A.ctx, { quarter: 2, year: 2025 });
    expect(q2.lines.line12).toBe('0.00');
    expect(q2.lines.line13).toBe('0.00');
  });

  it('941: input validation (bad quarter, negative deposits override)', async () => {
    await expect(form941Data(A.ctx, { quarter: 5 as never, year: 2025 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(form941Data(A.ctx, { quarter: 1, year: 2025, depositsOverride: '-1' })).rejects.toMatchObject({ code: 'VALIDATION' });
    const o = await form941Data(A.ctx, { quarter: 1, year: 2025, depositsOverride: '3000' });
    expect(o.depositsOverridden).toBe(true);
    expect(o.deposits).toEqual([]);
    expect(o.lines.line15).toBe('64.00');
  });

  it('941: Social Security wage base cap and Additional Medicare (5d) across quarters', async () => {
    const H = await newCompany('High Earner Co');
    const dee = await emp(H.ctx, 'Dee', 'TX');
    // Q1: $190,000 — SS capped at the 2025 base $176,100 (6.2% = 10,918.20).
    await runPaycheck(H.ctx, {
      employeeId: dee, payDate: d('2025-03-31'), periodStart: d('2025-03-01'), periodEnd: d('2025-03-31'),
      grossPay: '190000.00', taxes: ee('40000.00', '10918.20', '2755.00'), employerTaxes: er('10918.20', '2755.00', '42.00'),
    });
    // Q2: $20,000 — no SS; Medicare 1.45% + 0.9% Additional Medicare on the $10,000 over $200,000.
    await runPaycheck(H.ctx, {
      employeeId: dee, payDate: d('2025-04-30'), periodStart: d('2025-04-01'), periodEnd: d('2025-04-30'),
      grossPay: '20000.00', taxes: ee('4000.00', '0.00', '380.00'), employerTaxes: er('0.00', '290.00', '0.00'),
    });
    const q1 = await form941Data(H.ctx, { quarter: 1, year: 2025 });
    expect(q1.lines.line5aWages).toBe('176100.00');
    expect(q1.lines.line5aTax).toBe('21836.40');
    expect(q1.lines.line5cTax).toBe('5510.00');
    expect(q1.lines.line7).toBe('0.00');
    const q2 = await form941Data(H.ctx, { quarter: 2, year: 2025 });
    expect(q2.lines.line5aWages).toBe('0.00');
    expect(q2.lines.line5cWages).toBe('20000.00');
    expect(q2.lines.line5cTax).toBe('580.00');
    expect(q2.lines.line5dWages).toBe('10000.00');
    expect(q2.lines.line5dTax).toBe('90.00');
    expect(q2.lines.line7).toBe('0.00');
    expect(q2.lines.line12).toBe('4670.00');
    expect(q2.schedule.total).toBe('4670.00');
    expect((await trialBalance(H.ctx)).balanced).toBe(true);
  });

  it('941 line 13 (semiweekly depositor): deposits are attributed to the quarter of the payday they pay', async () => {
    // Semiweekly rule: a Friday payday is deposited by the following Wednesday. A Jan 3 payday is
    // deposited Jan 8 (a Q1 deposit), and the Dec 27 payday on Jan 2 (a Q4 deposit).
    const S = await newCompany('Semi Weekly Co');
    const sam = await emp(S.ctx, 'Sam', 'TX');
    for (const day of ['2024-12-27', '2025-01-03', '2025-03-28']) {
      await runPaycheck(S.ctx, {
        employeeId: sam, payDate: d(day), periodStart: d(day), periodEnd: d(day),
        grossPay: '10000.00', taxes: ee('1000.00', '620.00', '145.00'), employerTaxes: er('620.00', '145.00', '0.00'),
      });
    }
    const liab: Array<[string, string]> = [['Federal Income Tax', '1000.00'], ['Social Security', '1240.00'], ['Medicare', '290.00']];
    await pay(S.ctx, S.acct['1000'], '2025-01-02', liab); // for the Dec 27, 2024 payday (Q4 2024)
    await pay(S.ctx, S.acct['1000'], '2025-01-08', liab); // for the Jan 3, 2025 payday (Q1 2025)
    await pay(S.ctx, S.acct['1000'], '2025-04-02', liab); // for the Mar 28, 2025 payday (Q1 2025)

    const q1 = await form941Data(S.ctx, { quarter: 1, year: 2025, depositSchedule: 'semiweekly' });
    expect(q1.lines.line12).toBe('5060.00');
    expect(q1.lines.line13).toBe('5060.00');
    expect(q1.lines.line14).toBe('0.00');
    const q4 = await form941Data(S.ctx, { quarter: 4, year: 2024, depositSchedule: 'semiweekly' });
    expect(q4.lines.line12).toBe('2530.00');
    expect(q4.lines.line13).toBe('2530.00');
    expect(q4.lines.line15).toBe('0.00');
  });

  it('941 line 13 (semiweekly): a deposit with no recent payday falls back to the monthly window; monthly filers keep the window', async () => {
    const S = await newCompany('Semi Weekly Fallback Co');
    const sam = await emp(S.ctx, 'Sid', 'TX');
    await runPaycheck(S.ctx, {
      employeeId: sam, payDate: d('2025-02-07'), periodStart: d('2025-02-07'), periodEnd: d('2025-02-07'),
      grossPay: '10000.00', taxes: ee('1000.00', '620.00', '145.00'), employerTaxes: er('620.00', '145.00', '0.00'),
    });
    // Feb 12 pays the Feb 7 payday; Jan 10 has no payday in the prior 14 days → monthly window (Q4).
    await pay(S.ctx, S.acct['1000'], '2025-01-10', [['Federal Income Tax', '50.00']]);
    await pay(S.ctx, S.acct['1000'], '2025-02-12', [['Federal Income Tax', '1000.00'], ['Social Security', '1240.00'], ['Medicare', '290.00']]);
    const semi = await form941Data(S.ctx, { quarter: 1, year: 2025, depositSchedule: 'semiweekly' });
    expect(semi.lines.line13).toBe('2530.00');
    expect(semi.deposits.every((x) => x.date === '2025-02-12')).toBe(true);
    const q4 = await form941Data(S.ctx, { quarter: 4, year: 2024, depositSchedule: 'semiweekly' });
    expect(q4.lines.line13).toBe('50.00');
    const monthly = await form941Data(S.ctx, { quarter: 1, year: 2025 });
    expect(monthly.lines.line13).toBe('2530.00');
  });

  it('940: credit reduction for CA (2025 1.2%), exclusions, FUTA deposit window, SUI not a FUTA deposit', async () => {
    const f = await form940Data(A.ctx, { year: 2025 });
    // Voided $9,999 check excluded.
    expect(f.totalPayments).toBe('12000.00');
    expect(f.employeeCount).toBe(3);
    // Ann $8,000 → $1,000 over the base.
    expect(f.excessOver7000).toBe('1000.00');
    expect(f.taxableFutaWages).toBe('11000.00');
    expect(f.futaTaxCalculated).toBe('66.00');
    expect(f.creditReduction.known).toBe(true);
    expect(f.creditReduction.rows).toEqual([{ state: 'CA', wages: '7000.00', rate: '0.012', amount: '84.00' }]);
    expect(f.line12).toBe('150.00');
    expect(f.quarters.map((q) => q.futaLiability)).toEqual(['66.00', '0.00', '0.00', '84.00']);
    expect(f.totalQuarterlyLiability).toBe(f.line12);
    // Only the Feb 20 FUTA payment is a 2025 deposit (the Jan 20 one pays 2024; SUI is not FUTA).
    expect(f.deposits.map((x) => [x.date, x.amount])).toEqual([['2025-02-20', '42.00']]);
    expect(f.line13).toBe('42.00');
    expect(f.line14).toBe('108.00');
    expect(f.warnings).toEqual([]);
    // Company B's CA employee and deposits are not here.
    expect(f.creditReduction.rows.every((r) => r.wages === '7000.00')).toBe(true);
  });

  it('940: an employee without a work state is warned about, not silently dropped', async () => {
    const N = await newCompany('No State Co');
    const e = await createEmployee(N.ctx, { firstName: 'Nia', lastName: 'Nostate', payType: 'salary', payRate: '1' });
    await runPaycheck(N.ctx, {
      employeeId: e.id, payDate: d('2025-05-01'),
      grossPay: '1000.00', taxes: ee('0.00', '62.00', '14.50'), employerTaxes: er('62.00', '14.50', '6.00'),
    });
    const f = await form940Data(N.ctx, { year: 2025 });
    expect(f.warnings.join(' ')).toMatch(/Nia Nostate/);
  });

  it('API: /api/payroll/941 returns JSON / PDF and validates its query', async () => {
    routeCtx = A.ctx;
    const req = (q: string) => new NextRequest(`http://localhost/api/payroll/941?${q}`);
    const ok = await get941(req('quarter=1&year=2025&format=json'));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.lines.line12).toBe('2936.00');
    expect(body.lines.line13).toBe('2936.00');

    const semi = await (await get941(req('quarter=1&year=2025&schedule=semiweekly&deposits=100&format=json'))).json();
    expect(semi.schedule.kind).toBe('semiweekly');
    expect(semi.lines.line13).toBe('100.00');
    expect(semi.lines.line14).toBe('2836.00');

    expect((await get941(req('quarter=5&year=2025'))).status).toBe(400);
    expect((await get941(req('year=2025'))).status).toBe(400);
    expect((await get941(req('quarter=1&year=2025&schedule=weekly'))).status).toBe(400);
    expect((await get941(req('quarter=1&year=2025&deposits=-5'))).status).toBe(400);
    expect((await get941(req('quarter=1&year=2025&deposits=abc'))).status).toBe(400);

    const pdf = await get941(req('quarter=1&year=2025'));
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('Content-Type')).toBe('application/pdf');
    const bytes = new Uint8Array(await pdf.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
  });

  it('API: /api/payroll/940 returns JSON / PDF with the deposits override', async () => {
    routeCtx = A.ctx;
    const req = (q: string) => new NextRequest(`http://localhost/api/payroll/940?${q}`);
    const body = await (await get940(req('year=2025&format=json'))).json();
    expect(body.line12).toBe('150.00');
    const o = await (await get940(req('year=2025&deposits=150&format=json'))).json();
    expect(o.line13).toBe('150.00');
    expect(o.line14).toBe('0.00');
    expect(o.depositsOverridden).toBe(true);
    expect((await get940(req('year=abc'))).status).toBe(400);
    expect((await get940(req('year=2025&deposits=1.234'))).status).toBe(400);
    const pdf = await get940(req('year=2025'));
    expect(pdf.headers.get('Content-Type')).toBe('application/pdf');
  });
});
