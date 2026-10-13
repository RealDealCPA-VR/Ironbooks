/**
 * Independent QA (tester, re-test round 3) for fix round 3 (cac9b6a): Form 941 line 13 for
 * semiweekly filers replays the deposit allocation from one fixed origin (checks and deposits
 * loaded from the same point), and paycheck lines are fetched in chunks of 1,000 ids.
 *
 * Adversarial cases:
 *  - conservation over a long history: daily liabilities for three years (more than 1,000
 *    paychecks/adjustments, so the line lookup spans several chunks) paid every 14 days: every
 *    quarter line 13 = line 12, and the sum of line 13 over all quarters = every deposit;
 *  - quarter independence: a quarter's line 13 does not change with the order the forms are run
 *    in, or when later checks/deposits are added, or when much older history (years earlier,
 *    well past any old 60-day window) exists;
 *  - an underpayment far in the past does not leak into a later quarter (14-day lookback);
 *  - another company's checks and deposits never affect the allocation (isolation);
 *  - the trial balance stays balanced.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, paychecks, paycheckLines } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { updateCompany } from './company';
import { createEmployee, runPaycheck } from './payroll';
import { payPayrollLiabilities } from './liabilityPayments';
import { form941Data } from './payrollReports';
import { trialBalance } from './reports';
import { Money } from '@/lib/money';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-payroll-qa-deposits3');
let db: DB;
let userId: string;
const d = (s: string) => new Date(`${s}T00:00:00Z`);
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
type Q = 1 | 2 | 3 | 4;

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

/** A check scaled by k: FIT 100k, SS 62k+62k, Medicare 14.5k+14.5k → 941 tax 253k. */
function parts(k: number) {
  const fit = Money.of(100).times(k).toFixed(2);
  const ss = Money.of(62).times(k).toFixed(2);
  const med = Money.of(14.5).times(k).toFixed(2);
  return { fit, ss, med, gross: Money.of(1000).times(k).toFixed(2), tax: Money.of(253).times(k).toFixed(2) };
}

function check(co: Co, day: string, k = 10) {
  const p = parts(k);
  return runPaycheck(co.ctx, {
    employeeId: co.emp, payDate: d(day), periodStart: d(day), periodEnd: d(day), grossPay: p.gross,
    taxes: [
      { kind: 'tax', name: 'Federal Income Tax', amount: p.fit },
      { kind: 'tax', name: 'Social Security', amount: p.ss },
      { kind: 'tax', name: 'Medicare', amount: p.med },
    ],
    employerTaxes: [
      { kind: 'employer_contribution', name: 'Employer Social Security', amount: p.ss },
      { kind: 'employer_contribution', name: 'Employer Medicare', amount: p.med },
    ],
  });
}

/** Deposit the full 941 tax of a k-scaled check. */
function deposit(co: Co, date: string, k = 10) {
  const p = parts(k);
  return payPayrollLiabilities(co.ctx, {
    date: d(date), paymentAccountId: co.bank,
    items: [
      { name: 'Federal Income Tax', amount: p.fit },
      { name: 'Social Security', amount: Money.of(p.ss).times(2).toFixed(2) },
      { name: 'Medicare', amount: Money.of(p.med).times(2).toFixed(2) },
    ],
  });
}

const semi = (co: Co, quarter: Q, year: number) => form941Data(co.ctx, { quarter, year, depositSchedule: 'semiweekly' });

/** Every quarter from fromYear Q1 through toYear Q4. */
function quarters(fromYear: number, toYear: number): Array<[Q, number]> {
  const out: Array<[Q, number]> = [];
  for (let y = fromYear; y <= toYear; y++) for (const q of [1, 2, 3, 4] as Q[]) out.push([q, y]);
  return out;
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'p1dep3qa@test.local', name: 'Owner', passwordHash: 'x' }).returning();
  userId = u.id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('P1 payroll fix round 3 — fixed-origin semiweekly replay (tester re-test 3)', () => {
  it('more than 1,000 daily liabilities over three years, paid every 14 days: line 13 = line 12 every quarter, every deposit counted once', async () => {
    const co = await newCompany('Long History Co');
    // Daily non-posting liability adjustments (they count on 941 like checks): 10.00 FIT each,
    // 2023-01-01 .. 2025-12-31 (1,096 days, more than one 1,000-id chunk).
    const first = d('2023-01-01').getTime();
    const last = d('2025-12-31').getTime();
    const rows: Array<typeof paychecks.$inferInsert> = [];
    for (let t = first; t <= last; t += DAY) {
      rows.push({ companyId: co.ctx.companyId, employeeId: co.emp, payDate: new Date(t), grossPay: '100.00', totalTaxes: '10.00', entryType: 'liability_adjustment', memo: 'qa daily' });
    }
    expect(rows.length).toBeGreaterThan(1000);
    const inserted: Array<{ id: string }> = [];
    for (let i = 0; i < rows.length; i += 250) {
      inserted.push(...(await db.insert(paychecks).values(rows.slice(i, i + 250)).returning({ id: paychecks.id })));
    }
    for (let i = 0; i < inserted.length; i += 250) {
      await db.insert(paycheckLines).values(
        inserted.slice(i, i + 250).map((p) => ({ paycheckId: p.id, kind: 'tax', name: 'Federal Income Tax', amount: '10.00', taxTracking: 'federal_withholding' })),
      );
    }
    // A deposit every 14 days of the 14 prior days' tax (140.00), the first on 2023-01-15
    // (pays Jan 1-14).
    const deposits = new Map<string, string>();
    for (let t = first + 14 * DAY; t <= last; t += 14 * DAY) {
      const dep = await payPayrollLiabilities(co.ctx, { date: new Date(t), paymentAccountId: co.bank, items: [{ name: 'Federal Income Tax', amount: '140.00' }] });
      deposits.set(dep.id, '140.00');
    }
    // Final top-up: whatever is still unpaid through Dec 31, 2025, deposited Jan 2, 2026.
    const remaining = rows.length - deposits.size * 14;
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(14);
    const topAmt = Money.of(10).times(remaining).toFixed(2);
    const top = await payPayrollLiabilities(co.ctx, { date: d('2026-01-02'), paymentAccountId: co.bank, items: [{ name: 'Federal Income Tax', amount: topAmt }] });
    deposits.set(top.id, topAmt);

    const counted = new Map<string, ReturnType<typeof Money.zero>>();
    let total13 = Money.zero();
    for (const [q, y] of quarters(2023, 2025)) {
      const f = await semi(co, q, y);
      const days = Math.round((Date.UTC(y, q * 3, 1) - Date.UTC(y, (q - 1) * 3, 1)) / DAY);
      expect(f.lines.line12, `Q${q} ${y} line 12`).toBe(Money.of(10).times(days).toFixed(2));
      expect(f.lines.line13, `Q${q} ${y} line 13 vs line 12`).toBe(f.lines.line12);
      expect(f.lines.line14, `Q${q} ${y} balance due`).toBe('0.00');
      total13 = total13.plus(f.lines.line13);
      for (const x of f.deposits) counted.set(x.entryId, (counted.get(x.entryId) ?? Money.zero()).plus(x.amount));
    }
    expect(total13.toFixed(2)).toBe(Money.of(10).times(rows.length).toFixed(2));
    for (const [id, amt] of deposits) expect(counted.get(id)?.toFixed(2) ?? '0.00', `deposit ${id}`).toBe(Money.of(amt).toFixed(2));
    expect((await trialBalance(co.ctx)).balanced).toBe(true);
  }, 300_000);

  it("a quarter's line 13 does not depend on run order, later activity, or much older history", async () => {
    const co = await newCompany('Order Co');
    // Old history years earlier (well before any 60-day window), fully deposited.
    for (const day of ['2023-03-03', '2023-03-17', '2023-03-31']) {
      await check(co, day, 7);
      await deposit(co, iso(d(day).getTime() + 5 * DAY), 7);
    }
    // Weekly varying payroll across the Q4 2025 / Q1 2026 boundary, deposited on time.
    const scale = [3, 11, 5, 17, 2, 9, 30, 4, 8];
    let i = 0;
    for (let t = d('2025-11-07').getTime(); t <= d('2026-02-27').getTime(); t += 7 * DAY, i++) {
      await check(co, iso(t), scale[i % scale.length]);
      await deposit(co, iso(t + 5 * DAY), scale[i % scale.length]);
    }
    const q1First = await semi(co, 1, 2026);
    const q4 = await semi(co, 4, 2025);
    const q1Again = await semi(co, 1, 2026);
    expect(q1Again.lines.line13).toBe(q1First.lines.line13);
    expect(q1First.lines.line13).toBe(q1First.lines.line12);
    expect(q4.lines.line13).toBe(q4.lines.line12);
    const q1of23 = await semi(co, 1, 2023);
    expect(q1of23.lines.line12).toBe(Money.of(parts(7).tax).times(3).toFixed(2));
    expect(q1of23.lines.line13).toBe(q1of23.lines.line12);

    // Later activity (Q2/Q3 2026, including a prepaid deposit and an underpayment) changes
    // nothing for Q4 2025 and Q1 2026.
    await check(co, '2026-04-03', 12);
    await deposit(co, '2026-04-08', 6);
    await deposit(co, '2026-07-20', 5); // before its Jul 24 payday
    await check(co, '2026-07-24', 5);
    const q4After = await semi(co, 4, 2025);
    const q1After = await semi(co, 1, 2026);
    expect(q4After.lines.line13).toBe(q4.lines.line13);
    expect(q1After.lines.line13).toBe(q1First.lines.line13);
    const key = (xs: Array<{ entryId: string; amount: string }>) => xs.map((x) => `${x.entryId}:${x.amount}`).sort();
    expect(key(q1After.deposits)).toEqual(key(q1First.deposits));
    // Q2: underpaid by half.
    const q2 = await semi(co, 2, 2026);
    expect(q2.lines.line13).toBe(parts(6).tax);
    expect(q2.lines.line14).toBe(Money.of(parts(12).tax).minus(parts(6).tax).toFixed(2));
    // Q3: the prepaid deposit counts once, in Q3 (monthly window by its date).
    const q3 = await semi(co, 3, 2026);
    expect(q3.lines.line13).toBe(parts(5).tax);
    expect(q3.lines.line13).toBe(q3.lines.line12);
  }, 180_000);

  it('an old underpayment does not pull later deposits back to the old payday', async () => {
    const co = await newCompany('Old Short Co');
    await check(co, '2025-06-06'); // Q2 2025, never fully deposited
    await deposit(co, '2025-06-11', 4); // partial
    await check(co, '2025-10-03');
    await deposit(co, '2025-10-08');
    await check(co, '2025-10-17');
    await deposit(co, '2025-10-22');
    const q2 = await semi(co, 2, 2025);
    expect(q2.lines.line13).toBe(parts(4).tax);
    expect(q2.lines.line14).toBe(Money.of(parts(10).tax).minus(parts(4).tax).toFixed(2));
    const q4 = await semi(co, 4, 2025);
    expect(q4.lines.line13).toBe(Money.of(parts(10).tax).times(2).toFixed(2));
    expect(q4.lines.line13).toBe(q4.lines.line12);
  }, 60_000);

  it("another company's payroll and deposits never shift this company's allocation", async () => {
    const a = await newCompany('Iso A Co');
    const b = await newCompany('Iso B Co');
    await check(a, '2026-03-27', 10);
    await deposit(a, '2026-04-01', 10);
    const before = await semi(a, 1, 2026);
    expect(before.lines.line13).toBe('2530.00');
    // B: a big unpaid payday right before A's deposit, and a deposit the same day.
    await check(b, '2026-03-25', 40);
    await check(b, '2026-03-31', 3);
    await deposit(b, '2026-04-01', 3);
    const after = await semi(a, 1, 2026);
    expect(after.lines.line13).toBe('2530.00');
    expect(after.deposits.map((x) => x.entryId)).toEqual(before.deposits.map((x) => x.entryId));
    expect((await semi(a, 2, 2026)).lines.line13).toBe('0.00');
    // B's deposit pays its own oldest payday (Mar 25) first; all of it is Q1.
    expect((await semi(b, 1, 2026)).lines.line13).toBe(parts(3).tax);
    expect((await trialBalance(a.ctx)).balanced).toBe(true);
    expect((await trialBalance(b.ctx)).balanced).toBe(true);
  }, 60_000);
});
