/**
 * P1 round, team FX — tester re-test 6 (adversarial tests for fix round 6, 7e0093f).
 *
 * Fix round 6 changed: as-of A/R aging decides a foreign invoice's open state from its as-of
 * foreign open amount; as-of A/P aging backs out foreign vendor-credit applications dated after the
 * cutoff; refundPayment telescopes the credit as of the refund's own date and re-plugs later steps.
 *
 * These tests push on the edges around that change:
 *  [A1] A/P: apply dated BEFORE the cutoff, unapply dated AFTER it (negative later application).
 *  [A2] A/P: an unapply dated before the apply it reverses (dates are user-entered via the API).
 *  [A3] A/P: an apply dated before the vendor credit itself exists.
 *  [A4] A/P: a foreign vendor credit refunded after the cutoff (+ home-currency control).
 *  [A5] A/P: bill partly paid by a bill payment, partly by two credits applied on both sides of
 *       the cutoff — every day in July/August.
 *  [A6] A/P: seeded random walks of forward-dated applies / unapplies over two bills, two credits.
 *  [R1] refund dated the payment date itself, after applies entered earlier.
 *  [R2] backdated refund of the whole remainder: credit clears exactly today; A/R == aging all days.
 *  [R3] refund dated today after an apply made today, then another apply.
 *  [R4] company isolation: the dated plug walk never touches another company.
 *  [C1] a home-currency credit memo applied to a foreign invoice: refused, or aging == GL.
 *  [F2] invoice paid partly at receipt and the rest by a later full apply from another payment.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { and, eq, lte, sql } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import Dec from 'decimal.js';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  accounts,
  customers,
  journalEntries,
  journalEntryLines,
  paymentsReceived,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance, balanceSheet } from './reports';
import { postJournalEntry, voidJournalEntry } from './posting';
import { upsertCurrency, setBaseCurrency, setAccountCurrency } from './currencies';
import { createInvoice } from './invoices';
import { receivePayment, voidPayment, applyPayment, unapplyFromInvoice, refundPayment } from './payments';
import { arAging, arAgingDetail, apAging, apAgingDetail } from './reportsExtra';
import { verifyIntegrity } from './integrity';
import { foreignOpenReceivables } from './fxSubledger';
import { customerBalanceSummary, vendorBalanceSummary } from './reportsLists';
import { createVendor } from './vendors';
import { createBill } from './bills';
import { createVendorCredit, applyToBill, unapplyFromBill, refundVendorCredit } from './vendorCredits';
import { payBills } from './billPayments';
import { createCreditMemo, applyToInvoice } from './creditMemos';
import { Money } from '@/lib/money';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-fx-retest6');
let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T12:00:00Z`);
const FAR = d('2099-12-31');
const iso = (x: Date) => x.toISOString().slice(0, 10);
const JULY = Array.from({ length: 31 }, (_, i) => d(`2026-07-${String(i + 1).padStart(2, '0')}`));

async function bal(code: string): Promise<string> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, acct[code]));
  return Money.of(row.balance).toFixed(2);
}
/** Natural GL balance of an account from posted lines dated on/before `asOf` (A/P: credit +). */
async function balAsOf(code: string, asOf: Date): Promise<string> {
  const [row] = await db
    .select({ d: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`, c: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)` })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(eq(journalEntryLines.accountId, acct[code]), eq(journalEntries.status, 'posted'), lte(journalEntries.date, asOf)));
  const net = Money.of(row.d).minus(Money.of(row.c));
  return (code.startsWith('1') ? net : net.negated()).toFixed(2);
}
const arAsOf = (asOf: Date) => balAsOf('1200', asOf);
const apAsOf = (asOf: Date) => balAsOf('2000', asOf);
async function agingTotal(asOf = FAR): Promise<string> {
  return Money.of((await arAging(ctx, asOf)).totals.total).toFixed(2);
}
async function summaryFor(name: string, asOf: Date, vendor = false): Promise<string> {
  const p = { asOf: iso(asOf) } as never;
  const sum = vendor ? await vendorBalanceSummary(ctx, p) : await customerBalanceSummary(ctx, p);
  const row = sum.rows.find((x) => x.kind === 'data' && x.cells.label === name);
  return row ? Money.of(String(row.cells.balance)).toFixed(2) : '0.00';
}
async function arViews(at: Date, name: string) {
  return {
    ar: await arAsOf(at),
    aging: await agingTotal(at),
    detail: Money.of((await arAgingDetail(ctx, at)).total).toFixed(2),
    summary: await summaryFor(name, at),
  };
}
async function apViews(at: Date, name: string) {
  return {
    ap: await apAsOf(at),
    aging: Money.of((await apAging(ctx, at)).totals.total).toFixed(2),
    detail: Money.of((await apAgingDetail(ctx, at)).total).toFixed(2),
    summary: await summaryFor(name, at, true),
  };
}
async function arMismatches(dates: Date[]): Promise<string[]> {
  const out: string[] = [];
  for (const day of dates) {
    const [ar, aging] = [await arAsOf(day), await agingTotal(day)];
    if (ar !== aging) out.push(`${iso(day)}: A/R ${ar} vs aging ${aging}`);
  }
  return out;
}
async function invariants() {
  expect((await trialBalance(ctx)).balanced).toBe(true);
  const bs = await balanceSheet(ctx);
  expect(Money.of(bs.totalAssets).toFixed(2)).toBe(Money.of(bs.totalLiabilities).plus(Money.of(bs.totalEquity)).toFixed(2));
  expect(await agingTotal()).toBe(await bal('1200'));
  expect(Money.of((await apAging(ctx, FAR)).totals.total).toFixed(2)).toBe(await apAsOf(FAR));
  expect((await verifyIntegrity(ctx)).checks.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`)).toEqual([]);
}
async function customer(name: string) {
  const [row] = await db.insert(customers).values({ companyId: ctx.companyId, displayName: name }).returning();
  return row;
}
function eurPay(customerId: string, date: string, amount: string, rate: string, applications: unknown[] = []) {
  return {
    customerId,
    date: d(date),
    method: 'check',
    amount,
    currency: 'EUR',
    exchangeRate: rate,
    depositAccountId: acct['1050'],
    applications,
  } as never;
}
function eurInvoice(customerId: string, total: string, date = '2026-06-01', rate = '1.1111') {
  return createInvoice(ctx, {
    customerId,
    date: d(date),
    currency: 'EUR',
    exchangeRate: rate,
    lines: [{ accountId: acct['4000'], quantity: 1, rate: total }],
  } as never);
}
async function unappliedOf(paymentId: string) {
  const [row] = await db.select().from(paymentsReceived).where(eq(paymentsReceived.id, paymentId));
  return Money.of(row.unapplied);
}
async function plugs(paymentId: string) {
  return db
    .select()
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.sourceRef, `payment:${paymentId}`),
        eq(journalEntries.status, 'posted'),
      ),
    );
}
const home = (eur: Dec | string, rate: string) =>
  Money.of(eur).isZero() ? Money.zero() : Money.round2(Money.of(eur).times(Money.of(rate)));

const DEFS: Array<[string, string, string, string]> = [
  ['1000', 'Checking', 'asset', 'checking'],
  ['1050', 'Undeposited Funds', 'asset', 'checking'],
  ['1020', 'Euro Bank', 'asset', 'checking'],
  ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
  ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
  ['2200', 'Sales Tax Payable', 'liability', 'other_current_liability'],
  ['3000', 'Owner Equity', 'equity', 'owners_equity'],
  ['4000', 'Sales', 'revenue', 'sales'],
  ['6300', 'Supplies', 'expense', 'operating_expenses'],
];

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('P1 FX — tester re-test 6: as-of A/P around dated vendor-credit steps; backdated refunds', () => {
  let seq = 0;
  let userId: string;
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'p1fx-rt6@test.local', name: 'FX RT6', passwordHash: 'x' }).returning();
    userId = u.id;
  });
  beforeEach(async () => {
    seq += 1;
    const [company] = await db.insert(companies).values({ name: `FX RT6 Co ${seq}`, ownerId: userId }).returning();
    ctx = { db, companyId: company.id, userId };
    for (const [code, name, type, subtype] of DEFS) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    }
    await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.10' });
    await setAccountCurrency(ctx, acct['1020'], 'EUR');
    await postJournalEntry(ctx, {
      date: d('2026-01-01'),
      description: 'Opening',
      lines: [
        { accountId: acct['1000'], debit: '100000.00' },
        { accountId: acct['3000'], credit: '100000.00' },
      ],
    });
  });
  afterAll(async () => {
    await closeDb();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle. */
    }
  });

  const AUG = Array.from({ length: 31 }, (_, i) => d(`2026-08-${String(i + 1).padStart(2, '0')}`));
  const EVERY = () => [d('2026-06-15'), ...JULY, ...AUG, d('2026-09-15'), new Date(), FAR];

  /** Every view of A/P that must equal GL A/P as of each date. */
  async function apMismatches(dates: Date[], vendorName: string): Promise<string[]> {
    const out: string[] = [];
    for (const day of dates) {
      const v = await apViews(day, vendorName);
      if (v.aging !== v.ap || v.detail !== v.ap || v.summary !== v.ap) {
        out.push(`${iso(day)}: A/P ${v.ap} aging ${v.aging} detail ${v.detail} summary ${v.summary}`);
      }
    }
    return out;
  }
  async function eurVendor(name: string) {
    return createVendor(ctx, { displayName: name, currency: 'EUR' });
  }
  function eurBill(vendorId: string, amount: string, date = '2026-06-01', rate = '1.1111') {
    return createBill(ctx, {
      vendorId,
      date: d(date),
      exchangeRate: rate,
      lines: [{ accountId: acct['6300'], amount }],
    } as never);
  }
  function eurCredit(vendorId: string, amount: string, date = '2026-07-01', rate = '1.2345') {
    return createVendorCredit(ctx, {
      vendorId,
      date: d(date),
      exchangeRate: rate,
      lines: [{ accountId: acct['6300'], amount }],
    } as never);
  }
  /** Either the service refuses the step (with a message about the date), or every view agrees with the GL on every date. */
  async function refusedOrConsistent(step: () => Promise<unknown>, vendorName: string) {
    let refused = false;
    try {
      await step();
    } catch (e) {
      refused = true;
      expect(String((e as Error).message)).toMatch(/date|before|after/i);
    }
    if (!refused) expect(await apMismatches(EVERY(), vendorName)).toEqual([]);
    await invariants();
    return refused;
  }

  // -------------------------------------------------------------------------
  // A/P edges
  // -------------------------------------------------------------------------

  it('[A1] A/P: apply dated before the cutoff, unapply dated after it — every view == GL A/P on every day', async () => {
    const v = await eurVendor('A1 Vendor');
    const bill = await eurBill(v.id, '40.00');
    const vc = await eurCredit(v.id, '100.00');
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '15.00', date: d('2026-07-10') });
    await unapplyFromBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '15.00', date: d('2026-08-10') });
    expect(await apMismatches(EVERY(), v.displayName)).toEqual([]);
    // Between the two: the bill is open 25 EUR, the credit holds 85 EUR.
    const row = (await apAgingDetail(ctx, d('2026-07-20'))).rows.find((r) => r.docId === bill.id);
    expect(row?.foreignOpenBalance).toBe('25.00');
    const want = home('40.00', '1.1111')
      .minus(home('15.00', '1.1111'))
      .minus(home('100.00', '1.2345').minus(home('15.00', '1.2345')))
      .toFixed(2);
    expect(await apAsOf(d('2026-07-20'))).toBe(want);
    // Re-apply in full later and partly unapply even later.
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-08-20') });
    await unapplyFromBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '12.34', date: d('2026-08-25') });
    expect(await apMismatches(EVERY(), v.displayName)).toEqual([]);
    await invariants();
  });

  it('[A2] A/P: an unapply dated BEFORE the apply it reverses is refused, or keeps every view == GL', async () => {
    const v = await eurVendor('A2 Vendor');
    const bill = await eurBill(v.id, '40.00');
    const vc = await eurCredit(v.id, '100.00');
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-08-10') });
    await refusedOrConsistent(
      () => unapplyFromBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-07-20') }),
      v.displayName,
    );
  });

  it('[A3] A/P: applying a vendor credit on a date before the credit exists is refused, or keeps every view == GL', async () => {
    const v = await eurVendor('A3 Vendor');
    const bill = await eurBill(v.id, '40.00');
    const vc = await eurCredit(v.id, '100.00', '2026-07-20');
    await refusedOrConsistent(
      () => applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-07-05') }),
      v.displayName,
    );
  });

  it('[A4] A/P: a foreign vendor credit refunded after the cutoff still counts in full on the as-of aging', async () => {
    const v = await eurVendor('A4 Vendor');
    await eurBill(v.id, '40.00');
    const vc = await eurCredit(v.id, '100.00');
    await refundVendorCredit(ctx, {
      vendorCreditId: vc.id,
      bankAccountId: acct['1020'],
      amount: '30.00',
      date: d('2026-08-10'),
      exchangeRate: '1.20',
    });
    // On 07-15 nothing was refunded yet: bill 44.44, credit 123.45.
    expect(await apAsOf(d('2026-07-15'))).toBe(home('40.00', '1.1111').minus(home('100.00', '1.2345')).toFixed(2));
    expect(await apMismatches(EVERY(), v.displayName)).toEqual([]);
    await invariants();
  });

  it('[A4-home] control: a home-currency vendor credit refunded after the cutoff — as-of A/P aging == GL A/P', async () => {
    const v = await createVendor(ctx, { displayName: 'A4 Home Vendor' });
    await createBill(ctx, { vendorId: v.id, date: d('2026-06-01'), lines: [{ accountId: acct['6300'], amount: '40.00' }] } as never);
    const vc = await createVendorCredit(ctx, {
      vendorId: v.id,
      date: d('2026-07-01'),
      lines: [{ accountId: acct['6300'], amount: '100.00' }],
    } as never);
    await refundVendorCredit(ctx, { vendorCreditId: vc.id, bankAccountId: acct['1000'], amount: '30.00', date: d('2026-08-10') });
    expect(await apAsOf(d('2026-07-15'))).toBe('-60.00');
    expect(await apMismatches(EVERY(), v.displayName)).toEqual([]);
    await invariants();
  });

  it('[A5] A/P: bill payment + credit applied before the cutoff + credit applied after it — every day == GL', async () => {
    const v = await eurVendor('A5 Vendor');
    const bill = await eurBill(v.id, '100.00', '2026-06-01', '1.0987');
    await payBills(ctx, {
      vendorId: v.id,
      date: d('2026-07-05'),
      method: 'check',
      paymentAccountId: acct['1000'],
      exchangeRate: '1.1234',
      applications: [{ billId: bill.id, amountApplied: '33.33' }],
    } as never);
    const vc1 = await eurCredit(v.id, '20.00', '2026-07-01', '1.2345');
    const vc2 = await eurCredit(v.id, '80.00', '2026-07-03', '0.98765');
    await applyToBill(ctx, { vendorCreditId: vc1.id, billId: bill.id, amount: '20.00', date: d('2026-07-08') });
    await applyToBill(ctx, { vendorCreditId: vc2.id, billId: bill.id, amount: '46.67', date: d('2026-08-12') });
    expect((await apAgingDetail(ctx, FAR)).rows.find((r) => r.docId === bill.id)).toBeUndefined();
    expect(await apMismatches(EVERY(), v.displayName)).toEqual([]);
    // 07-20: bill open 100 - 33.33 - 20 = 46.67 EUR; vc2 still holds all 80 EUR.
    const rows = (await apAgingDetail(ctx, d('2026-07-20'))).rows;
    expect(rows.find((r) => r.docId === bill.id)?.foreignOpenBalance).toBe('46.67');
    expect(rows.find((r) => r.docId === vc2.id)?.openBalance).toBe(home('80.00', '0.98765').negated().toFixed(2));
    await invariants();
  });

  for (const seed of [3, 11, 29]) {
    it(`[A6] A/P random walk (seed ${seed}): forward-dated applies / unapplies, two bills, two credits — every view == GL`, async () => {
      const r = rng(seed);
      const v = await eurVendor(`A6 Vendor ${seed}`);
      const billsList = [await eurBill(v.id, '61.17', '2026-06-01', '1.1111'), await eurBill(v.id, '38.29', '2026-06-20', '1.0503')];
      const credits = [await eurCredit(v.id, '45.55', '2026-07-01', '1.2345'), await eurCredit(v.id, '70.01', '2026-07-02', '0.9137')];
      const billOpen = new Map(billsList.map((b, i) => [b.id, Money.of(i === 0 ? '61.17' : '38.29')]));
      const creditOpen = new Map(credits.map((c, i) => [c.id, Money.of(i === 0 ? '45.55' : '70.01')]));
      const applied = new Map<string, Dec>(); // `${credit}|${bill}` -> amount
      let day = 3;
      const log: string[] = [];
      for (let step = 0; step < 10; step++) {
        day += 1 + Math.floor(r() * 4);
        const when = new Date(d('2026-07-01').getTime() + (day - 1) * 86400000);
        const c = credits[Math.floor(r() * 2)];
        const b = billsList[Math.floor(r() * 2)];
        const key = `${c.id}|${b.id}`;
        const prev = applied.get(key) ?? Money.zero();
        if (r() < 0.65 || prev.isZero()) {
          const max = Dec.min(creditOpen.get(c.id)!, billOpen.get(b.id)!);
          if (!max.greaterThan(0)) continue;
          const amt = r() < 0.3 ? max : Money.round2(Dec.max(Money.of('0.01'), max.times(r())));
          await applyToBill(ctx, { vendorCreditId: c.id, billId: b.id, amount: amt.toFixed(2), date: when });
          applied.set(key, prev.plus(amt));
          creditOpen.set(c.id, creditOpen.get(c.id)!.minus(amt));
          billOpen.set(b.id, billOpen.get(b.id)!.minus(amt));
          log.push(`apply ${amt.toFixed(2)} on ${iso(when).slice(5)}`);
        } else {
          const amt = r() < 0.5 ? prev : Money.round2(Dec.max(Money.of('0.01'), prev.times(r())));
          await unapplyFromBill(ctx, { vendorCreditId: c.id, billId: b.id, amount: amt.toFixed(2), date: when });
          applied.set(key, prev.minus(amt));
          creditOpen.set(c.id, creditOpen.get(c.id)!.plus(amt));
          billOpen.set(b.id, billOpen.get(b.id)!.plus(amt));
          log.push(`unapply ${amt.toFixed(2)} on ${iso(when).slice(5)}`);
        }
      }
      const dates = [d('2026-06-25'), ...JULY, ...AUG, d('2026-09-30'), new Date(), FAR];
      expect([log.join(', '), ...(await apMismatches(dates, v.displayName))]).toEqual([log.join(', ')]);
      await invariants();
    });
  }

  // -------------------------------------------------------------------------
  // refundPayment edges
  // -------------------------------------------------------------------------

  it('[R1] refund dated the payment date itself, after earlier-entered applies: A/R == expected on every July day', async () => {
    const c = await customer('R1');
    const rate = '1.23456789';
    const i1 = await eurInvoice(c.id, '37.77');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '90.00', rate));
    await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: i1.id, amountApplied: '13.13' }] });
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '21.21', date: d('2026-07-01') });
    await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: i1.id, amountApplied: '7.07' }] });
    const fails = await arMismatches([...JULY, new Date(), FAR]);
    const want = home('37.77', '1.1111').minus(home(Money.of('90.00').minus(Money.of('21.21')), rate)).toFixed(2);
    for (const day of JULY) {
      const ar = await arAsOf(day);
      if (ar !== want) fails.push(`${iso(day)}: A/R ${ar}, expected ${want}`);
    }
    expect(fails).toEqual([]);
    // Today: invoice 17.57 EUR open, credit 48.59 EUR.
    expect(await bal('1200')).toBe(home('17.57', '1.1111').minus(home('48.59', rate)).toFixed(2));
    await invariants();
  });

  it('[R2] a backdated refund of the whole remainder clears the credit exactly; A/R == aging on every day', async () => {
    const c = await customer('R2');
    const rate = '0.98765432';
    const inv = await eurInvoice(c.id, '70.00');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', rate));
    await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: inv.id, amountApplied: '33.33' }] });
    await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: inv.id, amountApplied: '11.11' }] });
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '55.56', date: d('2026-07-03') });
    expect((await unappliedOf(payment.id)).toFixed(2)).toBe('0.00');
    // Today: no credit left, A/R is exactly the invoice's home open.
    expect(await bal('1200')).toBe(home('70.00', '1.1111').minus(home('44.44', '1.1111')).toFixed(2));
    expect(await arMismatches([d('2026-06-30'), ...JULY, new Date(), FAR])).toEqual([]);
    // On 07-10 the credit was 100 - 55.56 = 44.44 EUR (the applies are dated today).
    expect(await arAsOf(d('2026-07-10'))).toBe(home('70.00', '1.1111').minus(home('44.44', rate)).toFixed(2));
    // Unapply everything: the credit is back to 44.44 EUR and still exact.
    await unapplyFromInvoice(ctx, { paymentId: payment.id, invoiceId: inv.id, amount: '44.44' });
    expect(await bal('1200')).toBe(home('70.00', '1.1111').minus(home('44.44', rate)).toFixed(2));
    expect(await arMismatches([...JULY, new Date(), FAR])).toEqual([]);
    await invariants();
  });

  it('[R3] refund dated today after an apply made today, then another apply: A/R == aging, exact today', async () => {
    const c = await customer('R3');
    const rate = '1.3333';
    const inv = await eurInvoice(c.id, '50.00');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '80.00', rate));
    await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: inv.id, amountApplied: '20.01' }] });
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '9.99', date: today });
    await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: inv.id, amountApplied: '3.03' }] });
    const un = await unappliedOf(payment.id);
    expect(un.toFixed(2)).toBe('46.97');
    expect(await bal('1200')).toBe(home('26.96', '1.1111').minus(home(un, rate)).toFixed(2));
    expect(await arMismatches([...JULY, today, new Date(), FAR])).toEqual([]);
    await invariants();
  });

  it('[R4] isolation: a backdated refund re-plugs only its own company; another company cannot refund it', async () => {
    const run = async (name: string) => {
      const c = await customer(name);
      const i1 = await eurInvoice(c.id, '40.00');
      const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '150.00', '0.98765432'));
      await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: i1.id, amountApplied: '25.88' }] });
      return payment;
    };
    const p1 = await run('Iso A');
    const ctxA = ctx;
    const acctA = { ...acct };
    const arA = await bal('1200');
    const plugsA = (await plugs(p1.id)).length;
    // A second company with the same shape.
    const [company] = await db.insert(companies).values({ name: 'FX RT6 Iso B', ownerId: userId }).returning();
    ctx = { db, companyId: company.id, userId };
    for (const [code, name, type, subtype] of DEFS) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    }
    await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.10' });
    const p2 = await run('Iso B');
    await refundPayment(ctx, { paymentId: p2.id, bankAccountId: acct['1000'], amount: '32.92', date: d('2026-07-02') });
    expect(await arMismatches([...JULY, FAR])).toEqual([]);
    // Company A untouched, and it cannot refund company B's payment.
    ctx = ctxA;
    Object.assign(acct, acctA);
    expect(await bal('1200')).toBe(arA);
    expect((await plugs(p1.id)).length).toBe(plugsA);
    await expect(
      refundPayment(ctx, { paymentId: p2.id, bankAccountId: acct['1000'], amount: '1.00', date: d('2026-07-02') }),
    ).rejects.toThrow();
    expect(await bal('1200')).toBe(arA);
    expect(await arMismatches([...JULY, FAR])).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // A/R aging edges
  // -------------------------------------------------------------------------

  it('[C1] a home-currency credit memo applied to a foreign invoice is refused, or aging == GL A/R', async () => {
    const c = await customer('C1');
    const inv = await eurInvoice(c.id, '40.00');
    const memo = await createCreditMemo(ctx, {
      customerId: c.id,
      date: d('2026-07-01'),
      lines: [{ accountId: acct['4000'], quantity: 1, rate: 10 }],
    } as never);
    let refused = false;
    try {
      await applyToInvoice(ctx, { creditMemoId: memo.id, invoiceId: inv.id, amount: '10.00' });
    } catch {
      refused = true;
    }
    if (!refused) expect(await arMismatches([d('2026-07-15'), new Date(), FAR])).toEqual([]);
    await invariants();
  });

  it('[F2] invoice paid partly at receipt and the rest by a later full apply of another payment — every day == GL', async () => {
    const c = await customer('F2');
    const inv = await eurInvoice(c.id, '60.00');
    await receivePayment(ctx, eurPay(c.id, '2026-07-01', '25.00', '1.2345', [{ invoiceId: inv.id, amountApplied: '25.00' }]));
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-05', '50.00', '0.9999'));
    await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: inv.id, amountApplied: '35.00' }] });
    expect(await arMismatches([d('2026-06-30'), ...JULY, new Date(), FAR])).toEqual([]);
    const at = d('2026-07-10');
    const row = (await arAgingDetail(ctx, at)).rows.find((r) => r.docId === inv.id);
    expect(row?.foreignOpenBalance).toBe('35.00');
    expect(row?.openBalance).toBe(home('60.00', '1.1111').minus(home('25.00', '1.1111')).toFixed(2));
    const ar = await arAsOf(at);
    expect(await arViews(at, 'F2')).toEqual({ ar, aging: ar, detail: ar, summary: ar });
    expect((await arAgingDetail(ctx, FAR)).rows.find((r) => r.docId === inv.id)).toBeUndefined();
    await invariants();
  });
});
