/**
 * Independent QA (tester, re-test round 1) for the Form 941 line 13 fix (a6e970a): semiweekly
 * deposits are attributed to the quarter of the payday they pay; monthly filers keep the
 * 16th-to-15th window.
 *
 * Adversarial cases:
 *  - conservation: over a full year of biweekly paydays (deposits crossing every quarter
 *    boundary), every deposit lands in exactly ONE quarter, and line 13 = line 12 each quarter;
 *  - voided paychecks and paychecks without any Form 941 tax never attract a deposit;
 *  - another company's paydays never move this company's deposits (isolation);
 *  - boundaries: same-day deposit, exactly 14 days after payday, 15 days (fallback window);
 *  - monthly filers are unaffected by paydays (window only);
 *  - API: schedule=semiweekly reaches the deposit attribution;
 *  - an off-cycle check between a payday and its on-time deposit (real production bug: the
 *    date-only match moves the deposit to the off-cycle check's quarter).
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
import { createEmployee, runPaycheck, voidPaycheck } from './payroll';
import { payPayrollLiabilities } from './liabilityPayments';
import { form941Data } from './payrollReports';
import { trialBalance } from './reports';
import { Money } from '@/lib/money';

let routeCtx: ServiceContext;
vi.mock('@/lib/context', () => ({
  getServerContext: vi.fn(async () => routeCtx),
}));
import { GET as get941 } from '@/app/api/payroll/941/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-payroll-qa-deposits');
let db: DB;
let userId: string;
const d = (s: string) => new Date(`${s}T00:00:00Z`);
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

type Co = { ctx: ServiceContext; bank: string; emp: string };

async function newCompany(name: string): Promise<Co> {
  const [company] = await db.insert(companies).values({ name, ownerId: userId }).returning();
  const ctx: ServiceContext = { db, companyId: company.id, userId };
  await updateCompany(ctx, { settings: { legalName: `${name} LLC`, ein: '12-3456789', addressLine1: '1 Main', city: 'Austin', state: 'TX', zip: '78701' } });
  const acct: Record<string, string> = {};
  for (const [code, nm, type, subtype] of [
    ['1000', 'Checking', 'asset', 'checking'],
    ['2300', 'Payroll Liabilities', 'liability', 'other_current_liability'],
    ['6500', 'Payroll Expense', 'expense', 'payroll'],
  ] as const) {
    acct[code] = (await createAccount(ctx, { code, name: nm, type: type as never, subtype })).id;
  }
  const e = await createEmployee(ctx, { firstName: 'Pat', lastName: name.split(' ')[0], payType: 'salary', payRate: '50000' });
  return { ctx, bank: acct['1000'], emp: e.id };
}

// $10,000 check: 941 tax = 1000 + 620*2 + 145*2 = 2530.
const TAX = '2530.00';
const LIAB: Array<[string, string]> = [['Federal Income Tax', '1000.00'], ['Social Security', '1240.00'], ['Medicare', '290.00']];

function check(co: Co, day: string, gross = '10000.00') {
  return runPaycheck(co.ctx, {
    employeeId: co.emp, payDate: d(day), periodStart: d(day), periodEnd: d(day), grossPay: gross,
    taxes: [
      { kind: 'tax', name: 'Federal Income Tax', amount: '1000.00' },
      { kind: 'tax', name: 'Social Security', amount: '620.00' },
      { kind: 'tax', name: 'Medicare', amount: '145.00' },
    ],
    employerTaxes: [
      { kind: 'employer_contribution', name: 'Employer Social Security', amount: '620.00' },
      { kind: 'employer_contribution', name: 'Employer Medicare', amount: '145.00' },
    ],
  });
}

function pay(co: Co, date: string, items: Array<[string, string]> = LIAB) {
  return payPayrollLiabilities(co.ctx, { date: d(date), paymentAccountId: co.bank, items: items.map(([name, amount]) => ({ name, amount })) });
}

const semi = (co: Co, quarter: 1 | 2 | 3 | 4, year: number) => form941Data(co.ctx, { quarter, year, depositSchedule: 'semiweekly' });

describe('P1 payroll 941 line 13 deposit attribution — tester re-test', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'p1depqa@test.local', name: 'Owner', passwordHash: 'x' }).returning();
    userId = u.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('conservation: a full year of biweekly paydays — each deposit counts in exactly one quarter and line 13 = line 12', async () => {
    const co = await newCompany('Biweekly Co');
    // Fridays every 14 days from Dec 20, 2024 to Jan 2, 2026; each deposited the next Wednesday (+5).
    const paydays: number[] = [];
    for (let t = d('2024-12-20').getTime(); t <= d('2026-01-02').getTime(); t += 14 * DAY) paydays.push(t);
    const depositDates: string[] = [];
    for (const p of paydays) {
      await check(co, iso(p));
      const dep = iso(p + 5 * DAY);
      await pay(co, dep);
      depositDates.push(dep);
    }
    // Sanity: some deposits cross quarter boundaries.
    const crosses = paydays.filter((p) => {
      const a = new Date(p), b = new Date(p + 5 * DAY);
      return Math.floor(a.getUTCMonth() / 3) !== Math.floor(b.getUTCMonth() / 3) || a.getUTCFullYear() !== b.getUTCFullYear();
    });
    expect(crosses.length).toBeGreaterThan(0);

    const quarters: Array<[1 | 2 | 3 | 4, number]> = [[4, 2024], [1, 2025], [2, 2025], [3, 2025], [4, 2025], [1, 2026]];
    const seen = new Map<string, number>();
    let total = Money.zero();
    for (const [q, y] of quarters) {
      const f = await semi(co, q, y);
      expect(f.lines.line13, `Q${q} ${y}`).toBe(f.lines.line12);
      expect(f.lines.line14).toBe('0.00');
      expect(f.lines.line15).toBe('0.00');
      for (const x of f.deposits) {
        const k = `${x.entryId}:${x.item}`;
        seen.set(k, (seen.get(k) ?? 0) + 1);
      }
      total = total.plus(f.lines.line13);
    }
    // Every deposit line counted once and only once.
    expect(seen.size).toBe(depositDates.length * 3);
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
    expect(total.toFixed(2)).toBe(Money.of(TAX).times(paydays.length).toFixed(2));
    expect((await trialBalance(co.ctx)).balanced).toBe(true);
  });

  it('a voided paycheck between a payday and its deposit does not pull the deposit into its quarter', async () => {
    const co = await newCompany('Voided Check Co');
    await check(co, '2024-12-27');
    const v = await check(co, '2025-01-02');
    await voidPaycheck(co.ctx, v.id);
    await pay(co, '2025-01-03'); // for Dec 27
    const q4 = await semi(co, 4, 2024);
    expect(q4.lines.line13).toBe(TAX);
    const q1 = await semi(co, 1, 2025);
    expect(q1.lines.line12).toBe('0.00');
    expect(q1.lines.line13).toBe('0.00');
  });

  it('a paycheck with no Form 941 tax (e.g. a reimbursement-only check) is not a payday for matching', async () => {
    const co = await newCompany('No Tax Check Co');
    await check(co, '2024-12-27');
    await runPaycheck(co.ctx, { employeeId: co.emp, payDate: d('2025-01-02'), grossPay: '100.00', taxes: [], employerTaxes: [] });
    await pay(co, '2025-01-03');
    expect((await semi(co, 4, 2024)).lines.line13).toBe(TAX);
    expect((await semi(co, 1, 2025)).lines.line13).toBe('0.00');
  });

  it("isolation: another company's payday never moves this company's deposit", async () => {
    const a = await newCompany('Iso A Co');
    const b = await newCompany('Iso B Co');
    await check(a, '2024-12-27');
    await check(b, '2025-01-02'); // would pull A's Jan 3 deposit into Q1 if it leaked
    await pay(a, '2025-01-03');
    expect((await semi(a, 4, 2024)).lines.line13).toBe(TAX);
    expect((await semi(a, 1, 2025)).lines.line13).toBe('0.00');
    // B's own form sees none of A's deposits.
    const bq1 = await semi(b, 1, 2025);
    expect(bq1.lines.line13).toBe('0.00');
    expect(bq1.lines.line14).toBe(TAX);
  });

  it('boundaries: same-day deposit, exactly 14 days, 15 days (falls back to the monthly window)', async () => {
    const co = await newCompany('Boundary Co');
    await check(co, '2025-03-31');
    await pay(co, '2025-03-31', [['Federal Income Tax', '100.00']]); // same day → Q1
    await pay(co, '2025-04-14', [['Federal Income Tax', '200.00']]); // 14 days → Q1
    await pay(co, '2025-04-15', [['Federal Income Tax', '300.00']]); // 15 days → monthly window, Apr 15 is Q1's last day
    await pay(co, '2025-04-16', [['Federal Income Tax', '400.00']]); // 16 days → monthly window → Q2
    const q1 = await semi(co, 1, 2025);
    expect(q1.deposits.map((x) => x.amount).sort()).toEqual(['100.00', '200.00', '300.00']);
    expect(q1.lines.line13).toBe('600.00');
    const q2 = await semi(co, 2, 2025);
    expect(q2.lines.line13).toBe('400.00');
  });

  it('monthly filers ignore paydays: a Jan 8 deposit for a Jan 3 payday is still counted in Q4 (window)', async () => {
    const co = await newCompany('Monthly Window Co');
    await check(co, '2025-01-03');
    await pay(co, '2025-01-08');
    expect((await form941Data(co.ctx, { quarter: 4, year: 2024 })).lines.line13).toBe(TAX);
    expect((await form941Data(co.ctx, { quarter: 1, year: 2025, depositSchedule: 'monthly' })).lines.line13).toBe('0.00');
    // The same data as a semiweekly filer puts it in Q1.
    expect((await semi(co, 1, 2025)).lines.line13).toBe(TAX);
    expect((await semi(co, 4, 2024)).lines.line13).toBe('0.00');
  });

  it('API: schedule=semiweekly reaches the deposit attribution', async () => {
    const co = await newCompany('Api Semi Co');
    await check(co, '2025-01-03');
    await pay(co, '2025-01-08');
    routeCtx = co.ctx;
    const req = (q: string) => new NextRequest(`http://localhost/api/payroll/941?${q}`);
    const s = await (await get941(req('quarter=1&year=2025&schedule=semiweekly&format=json'))).json();
    expect(s.lines.line13).toBe(TAX);
    expect(s.lines.line14).toBe('0.00');
    const m = await (await get941(req('quarter=1&year=2025&format=json'))).json();
    expect(m.lines.line13).toBe('0.00');
  });

  // PRODUCTION BUG (date-only matching, acknowledged as not done in the fix report): an off-cycle
  // check (bonus) paid on Apr 1 sits between the Mar 27 payday and its on-time Apr 1 deposit, so
  // the Mar 27 deposit is attributed to the Apr 1 payday (Q2). Q1 then shows a balance due that
  // is not owed and Q2 an overpayment. QuickBooks ties the payment to the liability it pays.
  it('an off-cycle check between a payday and its on-time deposit does not move that deposit to the next quarter', async () => {
    const co = await newCompany('Off Cycle Co');
    await check(co, '2026-03-27'); // regular Friday payday (Q1 2026)
    await check(co, '2026-04-01'); // off-cycle bonus check (Q2 2026)
    await pay(co, '2026-04-01'); // pays the Mar 27 liability (due Wed Apr 1)
    await pay(co, '2026-04-03'); // pays the Apr 1 liability (due Fri Apr 3)
    const q1 = await semi(co, 1, 2026);
    expect(q1.lines.line12).toBe(TAX);
    expect(q1.lines.line13).toBe(TAX);
    expect(q1.lines.line14).toBe('0.00');
    const q2 = await semi(co, 2, 2026);
    expect(q2.lines.line13).toBe(TAX);
    expect(q2.lines.line15).toBe('0.00');
  });
  it('one deposit paying paydays in two quarters is split between them, oldest payday first', async () => {
    const co = await newCompany('Split Deposit Co');
    await check(co, '2026-03-27'); // Q1
    await check(co, '2026-04-01'); // Q2
    // One catch-up deposit for both paydays, as three item lines of 5060 total.
    await pay(co, '2026-04-03', [['Federal Income Tax', '2000.00'], ['Social Security', '2480.00'], ['Medicare', '580.00']]);
    const q1 = await semi(co, 1, 2026);
    expect(q1.lines.line13).toBe(TAX);
    expect(q1.lines.line14).toBe('0.00');
    const q2 = await semi(co, 2, 2026);
    expect(q2.lines.line13).toBe(TAX);
    expect(q2.lines.line15).toBe('0.00');
  });

  it('a deposit larger than the unpaid lookback liability counts the excess by the monthly window', async () => {
    const co = await newCompany('Overpay Co');
    await check(co, '2026-03-27');
    await pay(co, '2026-04-01', [['Federal Income Tax', '1100.00'], ['Social Security', '1240.00'], ['Medicare', '290.00']]);
    const q1 = await semi(co, 1, 2026);
    // 2530 pays the Mar 27 payday; the 100 excess is dated Apr 1 (monthly window: Q1).
    expect(q1.lines.line13).toBe('2630.00');
    expect(q1.lines.line15).toBe('100.00');
    const q2 = await semi(co, 2, 2026);
    expect(q2.lines.line13).toBe('0.00');
  });
});
