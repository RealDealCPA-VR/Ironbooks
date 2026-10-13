/**
 * Independent QA (tester, re-test round 2) for fix round 2 (847b0c6, 3ebe2bd):
 *  - Form 941 line 13 for semiweekly filers now applies each deposit by amount to the unpaid
 *    941 tax of the paydays in its 14-day lookback, oldest first, replaying from 60 days before
 *    the quarter; leftovers use the monthly window.
 *  - State withholding tables not yet confirmed carry a check-the-amount note.
 *
 * Adversarial cases:
 *  - weekly paydays with varying amounts, each deposited on time and in full: every quarter
 *    line 13 = line 12, and every deposit line is counted exactly once (by amount) across the
 *    quarters (the replay start must not shift the allocation between quarters);
 *  - a voided deposit is ignored and the next deposit reflows to the older payday;
 *  - two deposits on the same day (posted newest-payday first) still pay both paydays;
 *  - a deposit made before its payday (prepayment) counts once, by the monthly window;
 *  - state: the note reaches previewPaycheck; nearest-year fallback onto an unconfirmed table
 *    also gets it; exempt employees and confirmed tables do not; every listed table exists.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { updateCompany, createCompany } from './company';
import { createEmployee, previewPaycheck, runPaycheck, updateEmployee } from './payroll';
import { ensureDefaultPayrollItems } from './payrollItems';
import { payPayrollLiabilities } from './liabilityPayments';
import { voidJournalEntry } from './posting';
import { form941Data } from './payrollReports';
import { trialBalance } from './reports';
import { calculateStateWithholding, MODELLED_STATES, UNCONFIRMED_TABLES } from './statePayrollTax';
import { Money } from '@/lib/money';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-payroll-qa-deposits2');
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

const semi = (co: Co, quarter: 1 | 2 | 3 | 4, year: number) => form941Data(co.ctx, { quarter, year, depositSchedule: 'semiweekly' });

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'p1dep2qa@test.local', name: 'Owner', passwordHash: 'x' }).returning();
  userId = u.id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('P1 payroll fix round 2 — tester re-test', () => {
  // PRODUCTION BUG (fails): the semiweekly allocation is replayed from a fixed 60 days before
  // the quarter, so each quarter's computation starts from a different state. Paydays just
  // before the replay start whose deposits fall before it look unpaid, later deposits are
  // applied to them first, and the FIFO allocation shifts. With weekly paydays of varying
  // amounts (overtime, bonuses), Q1 2026 line 13 shows 2,024.00 against 2,530.00 of tax (a
  // false balance due of 506.00) although every payday was deposited in full on time, and
  // the same deposit is counted differently by the Q4 2025 and Q1 2026 forms.

  it('weekly paydays with varying amounts, each deposited on time: line 13 = line 12 every quarter and each deposit counts once', async () => {
    const co = await newCompany('Weekly Vary Co');
    // Fridays every 7 days from Jan 3, 2025 to Jan 2, 2026; deposited the next Wednesday (+5).
    // Amounts vary week to week (including a big bonus week at each quarter end).
    const scale = [10, 4, 13, 7, 2, 11, 6, 9, 3, 12, 5, 8, 30];
    const deposits = new Map<string, string>(); // entryId → amount
    let i = 0;
    for (let t = d('2025-01-03').getTime(); t <= d('2026-01-02').getTime(); t += 7 * DAY, i++) {
      const k = scale[i % scale.length];
      await check(co, iso(t), k);
      const dep = await deposit(co, iso(t + 5 * DAY), k);
      deposits.set(dep.id, parts(k).tax);
    }
    const counted = new Map<string, ReturnType<typeof Money.zero>>();
    for (const [q, y] of [[1, 2025], [2, 2025], [3, 2025], [4, 2025], [1, 2026]] as Array<[1 | 2 | 3 | 4, number]>) {
      const f = await semi(co, q, y);
      expect(f.lines.line13, `Q${q} ${y} line 13 vs line 12`).toBe(f.lines.line12);
      expect(f.lines.line14, `Q${q} ${y} balance due`).toBe('0.00');
      expect(f.lines.line15, `Q${q} ${y} overpayment`).toBe('0.00');
      for (const x of f.deposits) counted.set(x.entryId, (counted.get(x.entryId) ?? Money.zero()).plus(x.amount));
    }
    for (const [id, amt] of deposits) expect(counted.get(id)?.toFixed(2) ?? '0.00', `deposit ${id}`).toBe(Money.of(amt).toFixed(2));
    expect((await trialBalance(co.ctx)).balanced).toBe(true);
  });

  it('a voided deposit is ignored; the next deposit pays the older unpaid payday first', async () => {
    const co = await newCompany('Void Deposit Co');
    await check(co, '2026-03-27');
    await check(co, '2026-04-01');
    const first = await deposit(co, '2026-04-01');
    await voidJournalEntry(co.ctx, first.id);
    await deposit(co, '2026-04-03');
    const q1 = await semi(co, 1, 2026);
    expect(q1.lines.line13).toBe('2530.00');
    expect(q1.lines.line14).toBe('0.00');
    const q2 = await semi(co, 2, 2026);
    expect(q2.lines.line13).toBe('0.00');
    expect(q2.lines.line14).toBe('2530.00');
    expect(q1.deposits.every((x) => x.entryId !== first.id) && q2.deposits.every((x) => x.entryId !== first.id)).toBe(true);
  });

  it('two deposits on the same day for two paydays in different quarters both count, whatever the posting order', async () => {
    const co = await newCompany('Same Day Co');
    await check(co, '2026-03-30', 10); // Q1
    await check(co, '2026-04-01', 4); // Q2 off-cycle
    // Posted newest payday's amount first.
    await deposit(co, '2026-04-03', 4);
    await deposit(co, '2026-04-03', 10);
    const q1 = await semi(co, 1, 2026);
    const q2 = await semi(co, 2, 2026);
    expect(q1.lines.line13).toBe('2530.00');
    expect(q2.lines.line13).toBe('1012.00');
    expect(Money.of(q1.lines.line13).plus(q2.lines.line13).toFixed(2)).toBe('3542.00');
  });

  it('a deposit made before its payday counts exactly once (monthly window by its date)', async () => {
    const co = await newCompany('Prepay Co');
    await check(co, '2026-01-02');
    await deposit(co, '2025-12-30');
    const q4 = await semi(co, 4, 2025);
    const q1 = await semi(co, 1, 2026);
    expect(Money.of(q4.lines.line13).plus(q1.lines.line13).toFixed(2)).toBe('2530.00');
    expect(q4.lines.line13).toBe('2530.00');
  });
});

describe('state withholding figures not yet confirmed — tester re-test', () => {
  const pure = (state: string, year: number, stateW4: Record<string, unknown> = { filingStatus: 'single' }) =>
    calculateStateWithholding({ state, year, wagesPerPeriod: '2000.00', periodsPerYear: 26, stateW4 });
  const unconfirmed = (notes: string[]) => notes.some((n) => /not yet confirmed/.test(n));

  it('every listed table exists in the engine (no stale entries) and gets the note', () => {
    for (const [state, years] of Object.entries(UNCONFIRMED_TABLES)) {
      expect(MODELLED_STATES, state).toContain(state);
      for (const y of years) {
        const r = pure(state, y);
        expect(r.tableYear, `${state} ${y}`).toBe(y);
        expect(r.notes.some((n) => /not in this version/.test(n)), `${state} ${y}`).toBe(false);
        expect(unconfirmed(r.notes), `${state} ${y}`).toBe(true);
      }
    }
  });

  it('the note does not change amounts; confirmed tables and exempt employees get no note', () => {
    // GA 2025 hand-checked figure is unchanged and carries no note.
    const ga25 = pure('GA', 2025);
    expect(ga25.amount).toBe('79.85');
    expect(unconfirmed(ga25.notes)).toBe(false);
    expect(unconfirmed(pure('NY', 2026).notes)).toBe(false);
    // CA has no 2026 table: 2026 uses the unconfirmed 2025 figures, so it carries the note too.
    expect(unconfirmed(pure('CA', 2026).notes)).toBe(true);
    expect(unconfirmed(pure('GA', 2026, { filingStatus: 'single', exempt: true }).notes)).toBe(false);
    expect(unconfirmed(pure('TX', 2025).notes)).toBe(false);
  });

  it('a year past the last table falls back to an unconfirmed table and says both things', () => {
    const r = pure('GA', 2027);
    expect(r.tableYear).toBe(2026);
    expect(r.notes.some((n) => /2027/.test(n))).toBe(true);
    expect(unconfirmed(r.notes)).toBe(true);
  });

  it('the note reaches the paycheck preview', async () => {
    const c = await createCompany(db, { name: 'GA Note Co', ownerId: userId });
    const ctx: ServiceContext = { db, companyId: c.id, userId };
    await ensureDefaultPayrollItems(ctx);
    const e = await createEmployee(ctx, { firstName: 'Gia', lastName: 'Peach', payType: 'salary', payRate: '52000' });
    await updateEmployee(ctx, e.id, {
      address: { line1: '1 Main', city: 'Atlanta', state: 'GA', zip: '30301' },
      w4: { formYear: 2020, filingStatus: 'single', stateW4: { filingStatus: 'single' } },
    });
    const pv26 = await previewPaycheck(ctx, { employeeId: e.id, payDate: d('2026-04-03'), grossPay: '2000.00', periodsPerYear: 26 });
    expect(unconfirmed(pv26.notes)).toBe(true);
    expect(pv26.lines.some((l) => l.taxTracking === 'state_withholding')).toBe(true);
    const pv25 = await previewPaycheck(ctx, { employeeId: e.id, payDate: d('2025-04-04'), grossPay: '2000.00', periodsPerYear: 26 });
    expect(unconfirmed(pv25.notes)).toBe(false);
  });
});
