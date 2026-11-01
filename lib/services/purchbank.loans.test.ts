/**
 * Feature round (team purchbank): Loan Manager to QuickBooks parity (PARITY F1).
 *
 *  - The balance comes from the loan's liability account (QB reads it there), so proceeds or an
 *    opening balance recorded in the account and payments written outside the Loan Manager count.
 *  - A loan already in progress: the next payment number and its due date.
 *  - Balloon payment, the lender's payment amount, exact-days compounding (365 / 360).
 *  - What-if scenarios for a saved loan and for a new one.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, users, vendors } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import { ServiceError, type ServiceContext } from './_base';
import { createCompany } from './company';
import { createAccount } from './accounts';
import { createExpense } from './expenses';
import { createManualEntry } from './journal';
import {
  amortizationSchedule,
  createLoan,
  evaluateLoan,
  getLoan,
  periodicPayment,
  setUpLoanPayment,
  updateLoan,
  whatIfLoan,
  type LoanInput,
} from './loans';
import { loanSchema } from '@/lib/validation/purchases';

let ctx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ctx) }));
import { POST as whatIfPOST } from '@/app/api/loans/[id]/what-if/route';
import { POST as evaluatePOST } from '@/app/api/loans/what-if/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-purchbank-loans');
let db: DB;
let userId: string;
let acct: Record<string, string> = {};
let seq = 0;
let loanAcct: string;
let lenderId: string;
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const ymd = (x: Date | string) => new Date(x).toISOString().slice(0, 10);

async function refusal(p: Promise<unknown>): Promise<ServiceError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, 'expected the call to be refused').toBeInstanceOf(ServiceError);
  return err as ServiceError;
}

const base = (extra: Partial<LoanInput> = {}): LoanInput => ({
  name: 'Truck',
  lenderVendorId: lenderId,
  liabilityAccountId: loanAcct,
  interestAccountId: acct['6300'],
  paymentAccountId: acct['1000'],
  originalAmount: '20000.00',
  annualRate: '6',
  termMonths: 36,
  originDate: d('2026-01-15'),
  firstPaymentDate: d('2026-02-15'),
  ...extra,
});

/** Record the loan in its liability account (proceeds into Checking). */
async function recordInAccount(amount: string, date = '2026-01-15') {
  await createManualEntry(ctx, {
    date: d(date),
    description: 'Loan proceeds',
    lines: [
      { accountId: acct['1000'], debit: amount },
      { accountId: loanAcct, credit: amount },
    ],
  });
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'purchbank-loans@test.local', name: 'PB', passwordHash: 'x' }).returning();
  userId = u.id;
});

beforeEach(async () => {
  seq += 1;
  const company = await createCompany(db, { name: `Purchbank loans ${seq}`, ownerId: userId });
  ctx = { db, companyId: company.id, userId };
  acct = {};
  for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[r.code] = r.id;
  loanAcct = (await createAccount(ctx, { code: '2610', name: 'Truck Loan', type: 'liability' as never, subtype: 'long_term_liability' })).id;
  lenderId = (await db.insert(vendors).values({ companyId: ctx.companyId, displayName: `Lender ${seq}` }).returning())[0].id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* best effort */
  }
});

describe('the balance comes from the liability account', () => {
  it("reads the account: what was recorded there and payments written outside the Loan Manager", async () => {
    // A loan of 20,000.00 of which 15,000.00 is still owed when it is entered in the books.
    await recordInAccount('15000.00');
    const loan = await createLoan(ctx, base());
    let l = await getLoan(ctx, loan.id);
    expect(l.balanceSource).toBe('account');
    expect(l.balance).toBe('15000.00');
    // A check written straight to the loan account (not through the Loan Manager) lowers it too.
    await createExpense(ctx, {
      payeeName: 'Lender',
      date: d('2026-02-20'),
      method: 'check',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: loanAcct, amount: '1000.00' }],
    });
    l = await getLoan(ctx, loan.id);
    expect(l.balance).toBe('14000.00');
    // The next payment's interest is worked out on the balance owed.
    expect(l.next!.interest).toBe('70.00');
    // A Loan Manager payment comes off the account balance.
    const lp = await setUpLoanPayment(ctx, loan.id, { kind: 'check' });
    l = await getLoan(ctx, loan.id);
    expect(l.balance).toBe(Money.of('14000.00').minus(lp.principal).toFixed(2));
  });

  it('nothing recorded in the account yet: the Loan Manager figures, and it says why', async () => {
    const loan = await createLoan(ctx, base());
    const l = await getLoan(ctx, loan.id);
    expect(l.balanceSource).toBe('schedule');
    expect(l.balanceReason).toBe('not_recorded');
    expect(l.balance).toBe('20000.00');
  });

  it('two loans on one account: each keeps its own figures', async () => {
    await recordInAccount('30000.00');
    const a = await createLoan(ctx, base({ name: 'Truck A' }));
    await createLoan(ctx, base({ name: 'Truck B', originalAmount: '10000.00' }));
    const l = await getLoan(ctx, a.id);
    expect(l.balanceSource).toBe('schedule');
    expect(l.balanceReason).toBe('shared');
    expect(l.balance).toBe('20000.00');
  });
});

describe('a loan already in progress', () => {
  it('starts at its next payment number and due date, from the balance in the account', async () => {
    // 12 of 36 payments were made before the loan was added: the account carries what is owed.
    const pay = periodicPayment('20000', '6', 36, 12);
    const original = amortizationSchedule({ balance: '20000', annualRate: '6', paymentsPerYear: 12, totalPayments: 36, nextNumber: 1, firstPaymentDate: d('2026-02-15'), payment: pay });
    const owed = original[11].balance; // after payment 12
    await recordInAccount(owed, '2027-01-10');
    const loan = await createLoan(ctx, base({ nextPaymentNumber: 13, nextPaymentDate: d('2027-02-15') }));
    const l = await getLoan(ctx, loan.id);
    expect(l.balance).toBe(owed);
    expect(l.next!.number).toBe(13);
    expect(ymd(l.next!.date)).toBe('2027-02-15');
    expect(l.schedule).toHaveLength(24);
    expect(l.schedule.at(-1)!.balance).toBe('0.00');
    expect(l.schedule[0].principal).toBe(original[12].principal);
    const lp = await setUpLoanPayment(ctx, loan.id, { kind: 'check' });
    expect(lp.paymentNumber).toBe(13);
    expect(ymd(lp.date)).toBe('2027-02-15');
    expect((await getLoan(ctx, loan.id)).next!.number).toBe(14);
  });

  it('without the account: the balance its schedule had reached', async () => {
    const pay = periodicPayment('20000', '6', 36, 12);
    const original = amortizationSchedule({ balance: '20000', annualRate: '6', paymentsPerYear: 12, totalPayments: 36, nextNumber: 1, firstPaymentDate: d('2026-02-15'), payment: pay });
    const loan = await createLoan(ctx, base({ nextPaymentNumber: 13 }));
    const l = await getLoan(ctx, loan.id);
    expect(l.balance).toBe(original[11].balance);
    expect(ymd(l.next!.date)).toBe('2027-02-15');
  });

  it('refuses a next payment number outside the term, and a change once payments were made', async () => {
    expect((await refusal(createLoan(ctx, base({ nextPaymentNumber: 37 })))).code).toBe('VALIDATION');
    await recordInAccount('20000.00');
    const loan = await createLoan(ctx, base());
    await setUpLoanPayment(ctx, loan.id, { kind: 'check' });
    expect((await refusal(updateLoan(ctx, loan.id, base({ nextPaymentNumber: 5 })))).code).toBe('CONFLICT');
    // An edit that does not send it keeps it.
    const kept = await updateLoan(ctx, loan.id, base({ name: 'Truck (renamed)' }));
    expect(kept.scheduleStartNumber).toBe(1);
  });
});

describe('balloon, payment amount and compounding', () => {
  it('a balloon: the level payment pays down to the balloon, paid with the last payment', async () => {
    await recordInAccount('10000.00');
    const loan = await createLoan(ctx, base({ originalAmount: '10000.00', termMonths: 12, balloonAmount: '5000.00' }));
    const l = await getLoan(ctx, loan.id);
    const r = new Decimal('0.005');
    const disc = r.plus(1).pow(-12);
    const expected = new Decimal('10000').minus(new Decimal('5000').times(disc)).times(r).dividedBy(new Decimal(1).minus(disc));
    expect(l.payment).toBe(expected.toFixed(2));
    expect(l.schedule).toHaveLength(12);
    const before = Money.of(l.schedule[10].balance);
    expect(before.greaterThan(5000) && before.lessThan(5500)).toBe(true);
    expect(Money.of(l.schedule[11].principal).equals(before)).toBe(true);
    expect(l.schedule[11].balance).toBe('0.00');
    expect((await refusal(createLoan(ctx, base({ balloonAmount: '20000.00' })))).code).toBe('VALIDATION');
  });

  it("the lender's payment amount: more principal each month, paid off early", async () => {
    await recordInAccount('20000.00');
    const loan = await createLoan(ctx, base({ paymentAmount: '700.00' }));
    const l = await getLoan(ctx, loan.id);
    expect(l.payment).toBe('700.00');
    expect(l.next!.interest).toBe('100.00');
    expect(l.next!.principal).toBe('600.00');
    expect(l.schedule.length).toBeLessThan(36);
    expect(l.schedule.at(-1)!.balance).toBe('0.00');
    // A payment that does not even cover the interest is refused.
    expect((await refusal(createLoan(ctx, base({ paymentAmount: '90.00' })))).message).toMatch(/does not cover the interest/);
  });

  it('exact-days compounding: interest on the days between payments (365- or 360-day year)', async () => {
    await recordInAccount('20000.00');
    const monthly = await getLoan(ctx, (await createLoan(ctx, base())).id);
    expect(monthly.next!.interest).toBe('100.00');
    // Jan 15 to Feb 15 = 31 days.
    const exact365 = await createLoan(ctx, base({ name: 'Exact 365', compounding: 'exact_days', dayCount: 365, liabilityAccountId: acct['2300'] }));
    const e365 = await getLoan(ctx, exact365.id);
    expect(e365.next!.interest).toBe(new Decimal('20000').times('0.06').times(31).dividedBy(365).toFixed(2));
    const exact360 = await createLoan(ctx, base({ name: 'Exact 360', compounding: 'exact_days', dayCount: 360, liabilityAccountId: acct['2200'] }));
    expect((await getLoan(ctx, exact360.id)).next!.interest).toBe('103.33');
    // Feb 15 to Mar 15 = 28 days for the second payment.
    expect(e365.schedule[1].interest).toBe(Money.of(e365.schedule[0].balance).times('0.06').times(28).dividedBy(365).toFixed(2));
    expect((await refusal(createLoan(ctx, base({ compounding: 'weekly' as never })))).code).toBe('VALIDATION');
    expect((await refusal(createLoan(ctx, base({ compounding: 'exact_days', dayCount: 300 })))).code).toBe('VALIDATION');
  });

  it('the API schema carries the new fields', () => {
    const parsed = loanSchema.safeParse({
      name: 'x',
      liabilityAccountId: loanAcct,
      interestAccountId: acct['6300'],
      originalAmount: '100.00',
      annualRate: '5',
      termMonths: 12,
      originDate: '2026-01-01',
      firstPaymentDate: '2026-02-01',
      balloonAmount: '10.00',
      compounding: 'exact_days',
      dayCount: 360,
      paymentAmount: '9.00',
      nextPaymentNumber: 3,
      nextPaymentDate: '2026-04-01',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toMatchObject({ balloonAmount: '10.00', compounding: 'exact_days', dayCount: 360, paymentAmount: '9.00', nextPaymentNumber: 3 });
    }
  });
});

describe('what-if scenarios', () => {
  it('a saved loan: lower rate, extra principal, a lump sum, another term', async () => {
    await recordInAccount('20000.00');
    const loan = await createLoan(ctx, base());
    const rate = await whatIfLoan(ctx, loan.id, { annualRate: '4' });
    expect(Money.of(rate.interestDifference).isNegative()).toBe(true);
    expect(Money.of(rate.scenario.payment).lessThan(rate.current.payment)).toBe(true);
    const extra = await whatIfLoan(ctx, loan.id, { extraPrincipal: '200.00' });
    expect(extra.paymentsDifference).toBeLessThan(0);
    expect(extra.scenario.schedule.at(-1)!.balance).toBe('0.00');
    const lump = await whatIfLoan(ctx, loan.id, { lumpSum: '5000.00' });
    expect(lump.scenario.balance).toBe('15000.00');
    expect(lump.scenario.totals.payments).toBeLessThan(lump.current.totals.payments);
    const shorter = await whatIfLoan(ctx, loan.id, { termMonths: 24 });
    expect(shorter.scenario.totals.payments).toBe(24);
    expect(Money.of(shorter.scenario.payment).greaterThan(shorter.current.payment)).toBe(true);
    // Nothing was saved.
    expect((await getLoan(ctx, loan.id)).payment).toBe(rate.current.payment);
    expect((await refusal(whatIfLoan(ctx, loan.id, { lumpSum: '-5' }))).code).toBe('VALIDATION');
    // A balloon at the end: smaller payments, the balloon paid with the last one.
    const balloon = await whatIfLoan(ctx, loan.id, { balloonAmount: '5000.00' });
    expect(Money.of(balloon.scenario.payment).lessThan(balloon.current.payment)).toBe(true);
    expect(balloon.scenario.schedule.at(-1)!.balance).toBe('0.00');
    expect(Money.of(balloon.scenario.schedule.at(-1)!.principal).greaterThan(5000)).toBe(true);
    expect((await refusal(whatIfLoan(ctx, loan.id, { balloonAmount: '25000.00' }))).message).toMatch(/less than the balance owed/);
  });

  it('a new loan: payment, total interest and payoff date', () => {
    const r = evaluateLoan({ originalAmount: '20000', annualRate: '6', termMonths: 36, originDate: d('2026-01-15'), firstPaymentDate: d('2026-02-15') });
    expect(r.payment).toBe(periodicPayment('20000', '6', 36, 12).toFixed(2));
    expect(r.totals.payments).toBe(36);
    expect(ymd(r.totals.payoffDate!)).toBe('2029-01-15');
    expect(Money.of(r.totals.principal).toFixed(2)).toBe('20000.00');
  });

  it('routes: POST /api/loans/:id/what-if and /api/loans/what-if', async () => {
    await recordInAccount('20000.00');
    const loan = await createLoan(ctx, base());
    const res = await whatIfPOST(
      new Request(`http://localhost/api/loans/${loan.id}/what-if`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ extraPrincipal: '100.00' }),
      }) as never,
      { params: Promise.resolve({ id: loan.id }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { paymentsDifference: number };
    expect(body.paymentsDifference).toBeLessThan(0);
    const bad = await whatIfPOST(
      new Request(`http://localhost/api/loans/${loan.id}/what-if`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lumpSum: '12abc' }),
      }) as never,
      { params: Promise.resolve({ id: loan.id }) },
    );
    expect(bad.status).toBe(400);
    const ev = await evaluatePOST(
      new Request('http://localhost/api/loans/what-if', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ originalAmount: '10000', annualRate: '5', termMonths: 12, originDate: '2026-01-01', firstPaymentDate: '2026-02-01' }),
      }) as never,
    );
    expect(ev.status).toBe(200);
    expect(((await ev.json()) as { totals: { payments: number } }).totals.payments).toBe(12);
  });
});
