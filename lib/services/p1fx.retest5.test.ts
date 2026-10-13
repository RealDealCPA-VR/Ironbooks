/**
 * P1 round, team FX — tester re-test 5: adversarial tests for fix round 5 (c837c8b).
 *
 * Fix under test:
 *  - postRefundVoidFxPlug (posting.ts): the refund-void exchange cent is dated where the credit's
 *    home value changed (one plug per date, walking from the voided refund's date).
 *  - unappliedCustomerPayments / paymentsUnappliedAsOf (customerCredits.ts): the credit as of a
 *    date is rebuilt in the payment currency and converted at the payment rate.
 *  - foreignOpenReceivables (fxSubledger.ts): the same as-of rule; later applies added back to the
 *    invoice's foreign open amount.
 *
 * Covered here:
 *  [A] the reviewer's exact scenario, checked through every as-of report: GL A/R, aging total,
 *      the customer's aging row, A/R Aging Detail, Customer Balance Summary, foreign subledger and
 *      Home Currency Adjustment preview at the payment rate (must be 0)
 *  [O] refunds entered in date order, random applies / unapplies / voids of any refund:
 *      A/R == aging as of EVERY July day (and today) after EVERY step, not only at the end
 *  [B] refunds entered OUT of date order (backdated), no void: A/R == aging as of every day
 *  [M] two payments of one customer with interleaved refunds and voids: plugs stay on their own
 *      payment; per-customer as-of aging == as-of Customer Balance Summary
 *  [V] void the refund, then void the payment: the customer and 6900 are zero as of every day
 *  [K] closing date between the voided refund and the surviving one: plugs only on open dates,
 *      no override needed when the voided refund itself is in the open period
 *  [P] penny refunds (0.01 each) at a rate that rounds every cent, voids of alternate ones
 *  [H] home-currency control with apply / unapply: as-of aging unchanged and no plugs
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import Dec from 'decimal.js';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, accounts, customers, journalEntries, paymentsReceived } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance, balanceSheet } from './reports';
import { postJournalEntry, voidJournalEntry } from './posting';
import { upsertCurrency, setBaseCurrency, setAccountCurrency } from './currencies';
import { createInvoice } from './invoices';
import { receivePayment, voidPayment, applyPayment, unapplyFromInvoice, refundPayment } from './payments';
import { arAging, arAgingDetail } from './reportsExtra';
import { verifyIntegrity } from './integrity';
import { foreignOpenReceivables } from './fxSubledger';
import { previewHomeCurrencyAdjustment } from './homeCurrencyAdjustment';
import { customerBalanceSummary } from './reportsLists';
import { setClosingDate } from './company';
import { Money } from '@/lib/money';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-fx-retest5');
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
async function fxBal(): Promise<string> {
  const [fx] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '6900')));
  return fx ? Money.of(fx.balance).toFixed(2) : '0.00';
}
async function arAsOf(asOf: Date): Promise<string> {
  const tb = await trialBalance(ctx, asOf);
  const row = tb.rows.find((r) => r.accountId === acct['1200']);
  return row ? Money.of(row.debit).minus(Money.of(row.credit)).toFixed(2) : '0.00';
}
async function agingTotal(asOf = FAR): Promise<string> {
  return Money.of((await arAging(ctx, asOf)).totals.total).toFixed(2);
}
async function agingFor(customerId: string, asOf = FAR): Promise<string> {
  const row = (await arAging(ctx, asOf)).rows.find((r) => r.id === customerId);
  return row ? Money.of(row.total).toFixed(2) : '0.00';
}
async function summaryFor(name: string, asOf: Date): Promise<string> {
  const sum = await customerBalanceSummary(ctx, { asOf: iso(asOf) } as never);
  const row = sum.rows.find((x) => x.kind === 'data' && x.cells.label === name);
  return row ? Money.of(String(row.cells.balance)).toFixed(2) : '0.00';
}
async function asOfMismatches(dates: Date[]): Promise<string[]> {
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
  expect((await verifyIntegrity(ctx)).checks.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`)).toEqual([]);
}
async function customer(name: string) {
  const [row] = await db.insert(customers).values({ companyId: ctx.companyId, displayName: name }).returning();
  return row;
}
function eurPay(customerId: string, date: string, amount: string, rate: string) {
  return {
    customerId,
    date: d(date),
    method: 'check',
    amount,
    currency: 'EUR',
    exchangeRate: rate,
    depositAccountId: acct['1050'],
    applications: [],
  } as never;
}
async function unappliedOf(paymentId: string) {
  const [row] = await db.select().from(paymentsReceived).where(eq(paymentsReceived.id, paymentId));
  return Money.of(row.unapplied).toFixed(2);
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
  Money.of(eur).isZero() ? '0.00' : Money.round2(Money.of(eur).times(Money.of(rate))).toFixed(2);
const neg = (v: string) => (Money.of(v).isZero() ? '0.00' : Money.of(v).negated().toFixed(2));

const DEFS: Array<[string, string, string, string]> = [
  ['1000', 'Checking', 'asset', 'checking'],
  ['1050', 'Undeposited Funds', 'asset', 'checking'],
  ['1020', 'Euro Bank', 'asset', 'checking'],
  ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
  ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
  ['2200', 'Sales Tax Payable', 'liability', 'other_current_liability'],
  ['3000', 'Owner Equity', 'equity', 'owners_equity'],
  ['4000', 'Sales', 'revenue', 'sales'],
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

describe('P1 FX — tester re-test 5: as-of reports after refund voids / applies / unapplies', () => {
  let seq = 0;
  let userId: string;
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'p1fx-rt5@test.local', name: 'FX RT5', passwordHash: 'x' }).returning();
    userId = u.id;
  });
  beforeEach(async () => {
    seq += 1;
    const [company] = await db.insert(companies).values({ name: `FX RT5 Co ${seq}`, ownerId: userId }).returning();
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

  it('[A] reviewer scenario: every as-of report agrees with the economic credit on 07-05 / 07-15 / 07-25', async () => {
    const c = await customer('Reviewer');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.2345'));
    const r1 = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-10') });
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-20') });
    await voidJournalEntry(ctx, r1.entry.id);
    const failures: string[] = [];
    for (const [day, eur] of [
      ['2026-06-30', '0.00'],
      ['2026-07-01', '100.00'],
      ['2026-07-05', '100.00'],
      ['2026-07-10', '100.00'],
      ['2026-07-15', '100.00'],
      ['2026-07-19', '100.00'],
      ['2026-07-20', '66.67'],
      ['2026-07-25', '66.67'],
    ] as const) {
      const want = neg(home(eur, '1.2345'));
      const at = d(day);
      const got = {
        ar: await arAsOf(at),
        aging: await agingTotal(at),
        row: await agingFor(c.id, at),
        detail: Money.of((await arAgingDetail(ctx, at)).total).toFixed(2),
        summary: await summaryFor('Reviewer', at),
        subledger: (await foreignOpenReceivables(ctx, at))
          .filter((i) => i.id === payment.id)
          .reduce((s, i) => s.plus(i.homeOpen), Money.zero())
          .toFixed(2),
      };
      for (const [k, v] of Object.entries(got)) if (v !== want) failures.push(`${day} ${k}: ${v}, expected ${want}`);
      if (eur !== '0.00') {
        // Revaluing at the payment's own rate changes nothing.
        const hca = await previewHomeCurrencyAdjustment(ctx, { date: at, rates: { EUR: '1.2345' } });
        if (!Money.of(hca.total).isZero()) failures.push(`${day} HCA at the payment rate: ${hca.total}`);
      }
    }
    expect(failures).toEqual([]);
    await invariants();
  });

  for (const [seed, rate] of [
    [3, '1.2345'],
    [11, '0.98765432'],
    [29, '1.23456789'],
    [47, '1.3333'],
  ] as const) {
    it(`[O] refunds in date order, random applies / unapplies / voids (seed ${seed}, rate ${rate}): A/R == aging as of every July day after every step`, async () => {
      const r = rng(seed);
      const c = await customer(`Ordered ${seed}`);
      const invs: Array<{ id: string; open: Dec }> = [];
      for (let i = 0; i < 2; i++) {
        const total = (10 + Math.floor(r() * 3000) / 100).toFixed(2);
        const inv = await createInvoice(ctx, {
          customerId: c.id,
          date: d('2026-06-01'),
          currency: 'EUR',
          exchangeRate: '1.1111',
          lines: [{ accountId: acct['4000'], quantity: 1, rate: total }],
        } as never);
        invs.push({ id: inv.id, open: Money.of(total) });
      }
      const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '150.00', rate));
      const refunds: Array<{ id: string; voided: boolean }> = [];
      const applied = new Map<string, Dec>();
      const log: string[] = [];
      const dates = [...JULY, new Date(), FAR];
      let nextDay = 2;
      for (let step = 0; step < 9; step++) {
        const un = Money.of(await unappliedOf(payment.id));
        const k = r();
        // Applies / unapplies are dated today, so to keep every refund in date order the refunds
        // come first (steps 0-4) and the applies / unapplies after (steps 5-8); voids any time.
        // A refund backdated before an earlier-entered apply is covered (and failing) in [R].
        if (step < 5 ? k < 0.7 && un.greaterThan(0) && nextDay <= 30 : false) {
          const amt = Money.round2(Dec.max(Money.of('0.01'), un.times(r() * 0.5)));
          const day = d(`2026-07-${String(nextDay).padStart(2, '0')}`);
          nextDay += 1 + Math.floor(r() * 3);
          const res = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: amt.toFixed(2), date: day });
          refunds.push({ id: res.entry.id, voided: false });
          log.push(`refund ${amt.toFixed(2)} on ${iso(day).slice(5)}`);
        } else if (step >= 5 && k < 0.6 && un.greaterThan(0)) {
          const inv = invs[Math.floor(r() * invs.length)];
          // Partial applies only: paying an invoice in full is covered (and failing) in [F].
          const amt = Money.round2(Dec.min(inv.open.minus(Money.of('0.01')), un, Dec.max(Money.of('0.01'), un.times(r() * 0.5))));
          if (amt.greaterThan(0)) {
            await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: inv.id, amountApplied: amt.toFixed(2) }] });
            inv.open = inv.open.minus(amt);
            applied.set(inv.id, (applied.get(inv.id) ?? Money.zero()).plus(amt));
            log.push(`apply ${amt.toFixed(2)}`);
          }
        } else if (step >= 5 && k < 0.75 && applied.size > 0) {
          const [invId, a] = [...applied.entries()][Math.floor(r() * applied.size)];
          const part = r() < 0.5 ? a : Money.round2(Dec.max(Money.of('0.01'), a.times(r())));
          await unapplyFromInvoice(ctx, { paymentId: payment.id, invoiceId: invId, amount: part.toFixed(2) });
          if (a.minus(part).isZero()) applied.delete(invId);
          else applied.set(invId, a.minus(part));
          invs.find((x) => x.id === invId)!.open = invs.find((x) => x.id === invId)!.open.plus(part);
          log.push(`unapply ${part.toFixed(2)}`);
        } else {
          const live = refunds.filter((x) => !x.voided);
          if (live.length) {
            const pick = live[Math.floor(r() * live.length)];
            await voidJournalEntry(ctx, pick.id);
            pick.voided = true;
            log.push(`void refund #${refunds.indexOf(pick)}`);
          }
        }
        expect([`after ${log.join(', ')}`, ...(await asOfMismatches(dates))]).toEqual([`after ${log.join(', ')}`]);
        expect((await trialBalance(ctx)).balanced).toBe(true);
      }
      await invariants();
      // Unwind everything: void the remaining refunds (a refunded payment cannot be voided), with
      // the as-of check after each, then the payment (which voids all of its plugs).
      for (const x of refunds.filter((y) => !y.voided)) {
        await voidJournalEntry(ctx, x.id);
        x.voided = true;
        expect(await asOfMismatches(dates)).toEqual([]);
      }
      await voidPayment(ctx, payment.id);
      expect(await plugs(payment.id)).toHaveLength(0);
      expect(await asOfMismatches(dates)).toEqual([]);
      await invariants();
    });
  }

  it('[F] a foreign credit applied later that pays a foreign invoice IN FULL: as-of aging before the apply still shows invoice and credit', async () => {
    const c = await customer('Full Apply');
    const rate = '1.2345';
    const inv = await createInvoice(ctx, {
      customerId: c.id,
      date: d('2026-06-01'),
      currency: 'EUR',
      exchangeRate: '1.1111',
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '40.00' }],
    } as never);
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', rate));
    await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: inv.id, amountApplied: '40.00' }] });
    // On 07-15 the credit had not been applied yet: invoice 40 EUR @1.1111 open, credit 100 EUR @1.2345.
    const want = Money.of(home('40.00', '1.1111')).minus(Money.of(home('100.00', rate))).toFixed(2);
    const at = d('2026-07-15');
    expect({
      ar: await arAsOf(at),
      aging: await agingTotal(at),
      detail: Money.of((await arAgingDetail(ctx, at)).total).toFixed(2),
      summary: await summaryFor('Full Apply', at),
    }).toEqual({ ar: want, aging: want, detail: want, summary: want });
    // Today (after the apply) the invoice is paid and only the rest of the credit remains.
    expect(await agingTotal()).toBe(await bal('1200'));
    expect(await bal('1200')).toBe(neg(home('60.00', rate)));
    await invariants();
  });

  it('[R] a refund backdated before an apply entered earlier (no void): A/R == aging as of every July day', async () => {
    // The exact sequence the seeded walk (seed 11) found: apply today, refund 07-02, apply today,
    // refund 07-04. Every refund is entered AFTER an apply that is dated later (today).
    const c = await customer('Backdated After Apply');
    const rate = '0.98765432';
    const mk = async (total: string) =>
      createInvoice(ctx, {
        customerId: c.id,
        date: d('2026-06-01'),
        currency: 'EUR',
        exchangeRate: '1.1111',
        lines: [{ accountId: acct['4000'], quantity: 1, rate: total }],
      } as never);
    const i1 = await mk('40.00');
    const i2 = await mk('30.00');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '150.00', rate));
    await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: i1.id, amountApplied: '25.88' }] });
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '32.92', date: d('2026-07-02') });
    await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: i2.id, amountApplied: '25.33' }] });
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '5.88', date: d('2026-07-04') });
    const failures = await asOfMismatches(JULY);
    // Economic A/R as of a July day: both invoices fully open at 1.1111, the credit before any apply.
    for (const day of JULY) {
      let eur = Money.of('150.00');
      if (day.getTime() >= d('2026-07-02').getTime()) eur = eur.minus(Money.of('32.92'));
      if (day.getTime() >= d('2026-07-04').getTime()) eur = eur.minus(Money.of('5.88'));
      const want = Money.of(home('40.00', '1.1111')).plus(Money.of(home('30.00', '1.1111'))).minus(Money.of(home(eur, rate))).toFixed(2);
      const ar = await arAsOf(day);
      if (ar !== want) failures.push(`${iso(day)}: A/R ${ar}, expected ${want}`);
    }
    expect(failures).toEqual([]);
    await invariants();
  });

  it('[B] refunds entered OUT of date order (backdated), no void: A/R == aging as of every July day', async () => {
    const c = await customer('Backdated');
    const rate = '1.2345';
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', rate));
    // Entered: 07-20 first, then 07-10 (backdated), then 07-05 (backdated again).
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-20') });
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-10') });
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '11.11', date: d('2026-07-05') });
    const failures = await asOfMismatches(JULY);
    // Economic credit as of each date: 100 - refunds dated on or before it, at the payment rate.
    for (const day of JULY) {
      let eur = Money.of('100.00');
      for (const [amt, when] of [['33.33', '2026-07-20'], ['33.33', '2026-07-10'], ['11.11', '2026-07-05']] as const) {
        if (d(when).getTime() <= day.getTime()) eur = eur.minus(Money.of(amt));
      }
      const want = neg(home(eur, rate));
      const ar = await arAsOf(day);
      if (ar !== want) failures.push(`${iso(day)}: A/R ${ar}, expected ${want}`);
    }
    expect(failures).toEqual([]);
    await invariants();
  });

  it('[M] two payments of one customer, interleaved refunds and voids: plugs stay per payment; as-of aging row == Customer Balance Summary', async () => {
    const c = await customer('Twin');
    const other = await customer('Bystander');
    const { payment: pa } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.2345'));
    const { payment: pb } = await receivePayment(ctx, eurPay(c.id, '2026-07-03', '80.00', '1.3579'));
    const { payment: px } = await receivePayment(ctx, eurPay(other.id, '2026-07-02', '50.00', '1.1111'));
    const a1 = await refundPayment(ctx, { paymentId: pa.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-06') });
    const b1 = await refundPayment(ctx, { paymentId: pb.id, bankAccountId: acct['1000'], amount: '26.67', date: d('2026-07-08') });
    await refundPayment(ctx, { paymentId: pa.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-12') });
    await refundPayment(ctx, { paymentId: pb.id, bankAccountId: acct['1020'], amount: '26.67', date: d('2026-07-14') });
    await refundPayment(ctx, { paymentId: px.id, bankAccountId: acct['1000'], amount: '16.67', date: d('2026-07-09') });
    const xBefore = await Promise.all(JULY.map((day) => agingFor(other.id, day)));
    await voidJournalEntry(ctx, a1.entry.id);
    await voidJournalEntry(ctx, b1.entry.id);
    expect(await plugs(px.id)).toHaveLength(0);
    for (const p of [...(await plugs(pa.id)), ...(await plugs(pb.id))]) {
      expect(p.date.getTime()).toBeGreaterThanOrEqual(d('2026-07-06').getTime());
    }
    expect(await asOfMismatches(JULY)).toEqual([]);
    const failures: string[] = [];
    for (const [i, day] of JULY.entries()) {
      const eurA = day.getTime() < d('2026-07-01').getTime() ? '0' : day.getTime() < d('2026-07-12').getTime() ? '100.00' : '66.67';
      const eurB = day.getTime() < d('2026-07-03').getTime() ? '0' : day.getTime() < d('2026-07-14').getTime() ? '80.00' : '53.33';
      const want = neg(Money.of(home(eurA, '1.2345')).plus(Money.of(home(eurB, '1.3579'))).toFixed(2));
      const row = await agingFor(c.id, day);
      const summary = await summaryFor('Twin', day);
      if (row !== want) failures.push(`${iso(day)} aging row ${row}, expected ${want}`);
      if (summary !== want) failures.push(`${iso(day)} summary ${summary}, expected ${want}`);
      if ((await agingFor(other.id, day)) !== xBefore[i]) failures.push(`${iso(day)} bystander changed`);
    }
    expect(failures).toEqual([]);
    await invariants();
  });

  it('[V] void the older refund, then void the payment: customer and 6900 are zero as of every July day', async () => {
    const c = await customer('Unwind');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.23456789'));
    const r1 = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '11.11', date: d('2026-07-04') });
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1020'], amount: '22.22', date: d('2026-07-09') });
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-17') });
    await voidJournalEntry(ctx, r1.entry.id);
    expect(await asOfMismatches(JULY)).toEqual([]);
    // A payment with posted refunds may be refused; if so void the refunds first, then the payment.
    try {
      await voidPayment(ctx, payment.id);
    } catch {
      for (const e of await db
        .select()
        .from(journalEntries)
        .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.sourceRef, `refund:${payment.id}`), eq(journalEntries.status, 'posted')))) {
        await voidJournalEntry(ctx, e.id);
      }
      expect(await asOfMismatches(JULY)).toEqual([]);
      await voidPayment(ctx, payment.id);
    }
    expect(await plugs(payment.id)).toHaveLength(0);
    for (const day of [...JULY, FAR]) {
      expect(`${iso(day)} ${await agingFor(c.id, day)}`).toBe(`${iso(day)} 0.00`);
    }
    expect(await asOfMismatches([...JULY, FAR])).toEqual([]);
    await invariants();
  });

  it('[K] closing date 07-15 between a voided open-period refund (07-20) and the surviving one (07-25): no override needed, plugs only on open dates', async () => {
    const c = await customer('Closing');
    const rate = '1.2345';
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', rate));
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-05') });
    const r2 = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-20') });
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '11.11', date: d('2026-07-25') });
    const closedAr = await Promise.all(JULY.slice(0, 15).map((day) => arAsOf(day)));
    await setClosingDate(ctx, { closingDate: '2026-07-15' });
    try {
      await voidJournalEntry(ctx, r2.entry.id);
      for (const p of await plugs(payment.id)) expect(p.date.getTime()).toBeGreaterThan(d('2026-07-15').getTime());
      // Nothing in the closed period moved.
      expect(await Promise.all(JULY.slice(0, 15).map((day) => arAsOf(day)))).toEqual(closedAr);
      expect(await asOfMismatches(JULY)).toEqual([]);
      expect(await arAsOf(d('2026-07-22'))).toBe(neg(home('66.67', rate)));
      expect(await arAsOf(d('2026-07-26'))).toBe(neg(home('55.56', rate)));
    } finally {
      await setClosingDate(ctx, { closingDate: null });
    }
    await invariants();
  });

  it('[P] penny refunds at a cent-rounding rate, alternate ones voided: A/R == aging == economic as of every day', async () => {
    const c = await customer('Pennies');
    const rate = '1.555';
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '1.00', rate));
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '0.01', date: d(`2026-07-${String(2 + i * 3).padStart(2, '0')}`) });
      ids.push(res.entry.id);
    }
    for (let i = 0; i < ids.length; i += 2) await voidJournalEntry(ctx, ids[i]);
    const failures = await asOfMismatches(JULY);
    for (const day of JULY) {
      let eur = Money.of('1.00');
      for (let i = 1; i < 8; i += 2) if (d(`2026-07-${String(2 + i * 3).padStart(2, '0')}`).getTime() <= day.getTime()) eur = eur.minus(Money.of('0.01'));
      const want = neg(home(eur, rate));
      const ar = await arAsOf(day);
      if (ar !== want) failures.push(`${iso(day)}: A/R ${ar}, expected ${want}`);
    }
    expect(failures).toEqual([]);
    expect(await unappliedOf(payment.id)).toBe('0.96');
    await invariants();
  });

  it('[H] home-currency payment with apply / unapply and voided refund: as-of aging matches A/R, no plugs', async () => {
    const c = await customer('HomeCtl');
    const inv = await createInvoice(ctx, {
      customerId: c.id,
      date: d('2026-06-01'),
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '40.00' }],
    } as never);
    const { payment } = await receivePayment(ctx, {
      customerId: c.id,
      date: d('2026-07-01'),
      method: 'check',
      amount: '100.00',
      depositAccountId: acct['1050'],
      applications: [],
    } as never);
    const r1 = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-10') });
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '13.33', date: d('2026-07-20') });
    await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: inv.id, amountApplied: '25.00' }] });
    await voidJournalEntry(ctx, r1.entry.id);
    await unapplyFromInvoice(ctx, { paymentId: payment.id, invoiceId: inv.id, amount: '5.00' });
    expect(await plugs(payment.id)).toHaveLength(0);
    expect(await fxBal()).toBe('0.00');
    expect(await asOfMismatches([...JULY, new Date(), FAR])).toEqual([]);
    expect(await arAsOf(d('2026-07-15'))).toBe('-60.00');
    expect(await arAsOf(d('2026-07-25'))).toBe('-46.67');
    await invariants();
  });
});
