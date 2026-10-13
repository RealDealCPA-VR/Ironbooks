/**
 * P1 round, team FX — fix round 5: reports AS OF a past date stay equal to A/R after refunds of a
 * foreign payment's credit are voided, applied and unapplied.
 *
 *  - postRefundVoidFxPlug (posting.ts): the exchange-rounding cent is dated where the credit's
 *    home value actually changed (the surviving later refund / apply), one plug per date, so
 *    A/R as of every date equals round2(unapplied as of that date x rate).
 *  - unappliedCustomerPayments / paymentsUnappliedAsOf (customerCredits.ts): the credit as of a
 *    date is rebuilt in the payment currency (today's + later refunds + later applies - later
 *    unapplies), then converted; foreignOpenReceivables (fxSubledger.ts) uses the same rule and
 *    adds later applies back to the invoice's foreign open amount.
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
import { arAging } from './reportsExtra';
import { verifyIntegrity } from './integrity';
import { foreignOpenReceivables } from './fxSubledger';
import { Money } from '@/lib/money';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-fx-fix5');
let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T12:00:00Z`);
const FAR = d('2099-12-31');
const JULY = Array.from({ length: 31 }, (_, i) => d(`2026-07-${String(i + 1).padStart(2, '0')}`));

async function bal(code: string): Promise<string> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, acct[code]));
  return Money.of(row.balance).toFixed(2);
}
async function arAsOf(asOf: Date): Promise<string> {
  const tb = await trialBalance(ctx, asOf);
  const row = tb.rows.find((r) => r.accountId === acct['1200']);
  return row ? Money.of(row.debit).minus(Money.of(row.credit)).toFixed(2) : '0.00';
}
async function agingTotal(asOf = FAR): Promise<string> {
  return Money.of((await arAging(ctx, asOf)).totals.total).toFixed(2);
}
/** A/R as of each date equals the aging as of that date; returns the mismatches. */
async function asOfMismatches(dates: Date[]): Promise<string[]> {
  const out: string[] = [];
  for (const day of dates) {
    const [ar, aging] = [await arAsOf(day), await agingTotal(day)];
    if (ar !== aging) out.push(`${day.toISOString().slice(0, 10)}: A/R ${ar} vs aging ${aging}`);
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
const home = (eur: string, rate: string) => (Money.of(eur).isZero() ? '0.00' : Money.round2(Money.of(eur).times(Money.of(rate))).toFixed(2));
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

/** Deterministic PRNG (mulberry32). */
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

describe('P1 FX — fix round 5: as-of reports around voided, applied and unapplied foreign credit', () => {
  let seq = 0;
  let userId: string;
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'p1fx-fix5@test.local', name: 'FX F5', passwordHash: 'x' }).returning();
    userId = u.id;
  });
  beforeEach(async () => {
    seq += 1;
    const [company] = await db.insert(companies).values({ name: `FX F5 Co ${seq}`, ownerId: userId }).returning();
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

  it('voided OLDER refund: the cent is dated on the surviving refund; A/R and aging are right as of every July day', async () => {
    const c = await customer('Older');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.2345'));
    const r1 = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-10') });
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-20') });
    await voidJournalEntry(ctx, r1.entry.id);
    const p = await plugs(payment.id);
    expect(p).toHaveLength(1);
    expect(p[0].date.toISOString().slice(0, 10)).toBe('2026-07-20');
    expect(await asOfMismatches(JULY)).toEqual([]);
    for (const day of JULY) {
      const eur = day.getTime() < d('2026-07-20').getTime() ? '100.00' : '66.67';
      expect(`${day.toISOString().slice(0, 10)} ${await arAsOf(day)}`).toBe(`${day.toISOString().slice(0, 10)} ${neg(home(eur, '1.2345'))}`);
    }
    await invariants();
  });

  it('three refunds, void the middle then the oldest: A/R == aging == economic credit as of every July day', async () => {
    const c = await customer('Three');
    const rate = '1.23456789';
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', rate));
    const r1 = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '11.11', date: d('2026-07-05') });
    const r2 = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1020'], amount: '22.23', date: d('2026-07-12') });
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.37', date: d('2026-07-19') });
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '7.77', date: d('2026-07-26') });
    const live = new Map<string, [string, Date]>([
      ['r1', ['11.11', d('2026-07-05')]],
      ['r2', ['22.23', d('2026-07-12')]],
      ['r3', ['33.37', d('2026-07-19')]],
      ['r4', ['7.77', d('2026-07-26')]],
    ]);
    const check = async () => {
      expect(await asOfMismatches(JULY)).toEqual([]);
      for (const day of JULY) {
        let eur = Money.of('100.00');
        for (const [amt, when] of live.values()) if (when.getTime() <= day.getTime()) eur = eur.minus(Money.of(amt));
        expect(`${day.toISOString().slice(0, 10)} ${await arAsOf(day)}`).toBe(`${day.toISOString().slice(0, 10)} ${neg(home(eur.toFixed(2), rate))}`);
      }
      await invariants();
    };
    await check();
    await voidJournalEntry(ctx, r2.entry.id);
    live.delete('r2');
    await check();
    await voidJournalEntry(ctx, r1.entry.id);
    live.delete('r1');
    await check();
  });

  it('refund, apply (today), void the refund, unapply (today): A/R == aging as of July days, today and later', async () => {
    const c = await customer('Apply');
    const rate = '1.2345';
    const inv = await createInvoice(ctx, {
      customerId: c.id,
      date: d('2026-06-01'),
      currency: 'EUR',
      exchangeRate: '1.1111',
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '40.00' }],
    } as never);
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', rate));
    const r1 = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-10') });
    const r2 = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '13.33', date: d('2026-07-20') });
    const dates = [...JULY, new Date(), FAR];
    expect(await asOfMismatches(dates)).toEqual([]);
    await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: inv.id, amountApplied: '25.55' }] });
    expect(await asOfMismatches(dates)).toEqual([]);
    // Before today the credit was not yet applied: the July aging still shows the unapplied credit.
    expect(await arAsOf(d('2026-07-25'))).toBe(Money.of(home('40.00', '1.1111')).minus(Money.of(home('53.34', rate))).toFixed(2));
    await voidJournalEntry(ctx, r1.entry.id);
    expect(await asOfMismatches(dates)).toEqual([]);
    expect(await arAsOf(d('2026-07-15'))).toBe(Money.of(home('40.00', '1.1111')).minus(Money.of(home('100.00', rate))).toFixed(2));
    expect(await arAsOf(d('2026-07-25'))).toBe(Money.of(home('40.00', '1.1111')).minus(Money.of(home('86.67', rate))).toFixed(2));
    await unapplyFromInvoice(ctx, { paymentId: payment.id, invoiceId: inv.id, amount: '10.00' });
    expect(await asOfMismatches(dates)).toEqual([]);
    expect(await unappliedOf(payment.id)).toBe('71.12');
    await invariants();
    await voidJournalEntry(ctx, r2.entry.id);
    expect(await asOfMismatches(dates)).toEqual([]);
    await invariants();
    await voidPayment(ctx, payment.id);
    expect(await plugs(payment.id)).toHaveLength(0);
    expect(await asOfMismatches(dates)).toEqual([]);
    await invariants();
  });

  it('foreign open receivables as of a past date: the credit and the invoice foreign amount before a later refund / apply', async () => {
    const c = await customer('Subledger');
    const inv = await createInvoice(ctx, {
      customerId: c.id,
      date: d('2026-06-01'),
      currency: 'EUR',
      exchangeRate: '1.2',
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '50.00' }],
    } as never);
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.2345'));
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '30.00', date: d('2026-07-10') });
    await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: inv.id, amountApplied: '20.00' }] });
    const at = async (day: Date) => {
      const items = await foreignOpenReceivables(ctx, day);
      const pay = items.find((i) => i.id === payment.id);
      const invItem = items.find((i) => i.id === inv.id);
      return {
        credit: pay ? pay.foreignOpen.toFixed(2) : '0.00',
        creditHome: pay ? pay.homeOpen.toFixed(2) : '0.00',
        invoice: invItem ? invItem.foreignOpen.toFixed(2) : '0.00',
        invoiceHome: invItem ? invItem.homeOpen.toFixed(2) : '0.00',
      };
    };
    expect(await at(d('2026-07-05'))).toEqual({ credit: '-100.00', creditHome: '-123.45', invoice: '50.00', invoiceHome: '60.00' });
    expect(await at(d('2026-07-15'))).toEqual({ credit: '-70.00', creditHome: '-86.42', invoice: '50.00', invoiceHome: '60.00' });
    const now = await at(FAR);
    expect(now.credit).toBe('-50.00');
    expect(now.invoice).toBe('30.00');
    // The foreign subledger ties to A/R as of each of those dates.
    for (const day of [d('2026-07-05'), d('2026-07-15'), FAR]) {
      const v = await at(day);
      expect(Money.of(v.creditHome).plus(Money.of(v.invoiceHome)).toFixed(2)).toBe(await arAsOf(day));
    }
    await invariants();
  });

  it('home-currency payment: as-of aging with a later refund and a voided refund is unchanged (no plugs)', async () => {
    const c = await customer('Home');
    const { payment } = await receivePayment(ctx, {
      customerId: c.id,
      date: d('2026-07-01'),
      method: 'check',
      amount: '100.00',
      depositAccountId: acct['1050'],
      applications: [],
    } as never);
    const r1 = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-10') });
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-20') });
    await voidJournalEntry(ctx, r1.entry.id);
    expect(await plugs(payment.id)).toHaveLength(0);
    expect(await asOfMismatches(JULY)).toEqual([]);
    expect(await arAsOf(d('2026-07-15'))).toBe('-100.00');
    expect(await arAsOf(d('2026-07-25'))).toBe('-66.67');
    await invariants();
  });

  for (const [seed, rate] of [
    [5, '1.2345'],
    [17, '0.98765432'],
    [31, '1.23456789'],
  ] as const) {
    it(`random dated refunds / applies / unapplies / refund voids (seed ${seed}, rate ${rate}): A/R == aging as of every July day after every step`, async () => {
      const r = rng(seed);
      const c = await customer(`Random ${seed}`);
      const invs: Array<{ id: string; open: Dec }> = [];
      for (let i = 0; i < 2; i++) {
        const total = (10 + Math.floor(r() * 3000) / 100).toFixed(2);
        const inv = await createInvoice(ctx, {
          customerId: c.id,
          date: d('2026-06-01'),
          currency: 'EUR',
          exchangeRate: rate,
          lines: [{ accountId: acct['4000'], quantity: 1, rate: total }],
        } as never);
        invs.push({ id: inv.id, open: Money.of(total) });
      }
      const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '150.00', rate));
      const refunds: Array<{ id: string; voided: boolean }> = [];
      const applied = new Map<string, Dec>();
      const log: string[] = [];
      const dates = [...JULY, new Date(), FAR];
      for (let step = 0; step < 10; step++) {
        const un = Money.of(await unappliedOf(payment.id));
        const k = r();
        // Refunds land on random July days (often backdated before earlier-entered refunds).
        const day = d(`2026-07-${String(2 + Math.floor(r() * 27)).padStart(2, '0')}`);
        if (k < 0.4 && un.greaterThan(0)) {
          const amt = Money.round2(Dec.max(Money.of('0.01'), un.times(r() * 0.5)));
          const res = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: amt.toFixed(2), date: day });
          refunds.push({ id: res.entry.id, voided: false });
          log.push(`refund ${amt.toFixed(2)} on ${day.toISOString().slice(5, 10)}`);
        } else if (k < 0.55 && un.greaterThan(0)) {
          const inv = invs[Math.floor(r() * invs.length)];
          const amt = Money.round2(Dec.min(inv.open, un, Dec.max(Money.of('0.01'), un.times(r() * 0.5))));
          if (amt.greaterThan(0)) {
            await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: inv.id, amountApplied: amt.toFixed(2) }] });
            inv.open = inv.open.minus(amt);
            applied.set(inv.id, (applied.get(inv.id) ?? Money.zero()).plus(amt));
            log.push(`apply ${amt.toFixed(2)}`);
          }
        } else if (k < 0.7 && applied.size > 0) {
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
        // Today's A/R always equals today's aging.
        expect(`${await agingTotal()} after ${log.join(', ')}`).toBe(`${await bal('1200')} after ${log.join(', ')}`);
        expect((await trialBalance(ctx)).balanced).toBe(true);
      }
      // Backdated refunds entered out of date order can leave as-of cents only BEFORE the first
      // void; every void re-dates the cents from the voided refund's date on. Void them all: then
      // every as-of date must agree.
      for (const x of refunds.filter((y) => !y.voided)) await voidJournalEntry(ctx, x.id);
      expect([`after ${log.join(', ')}`, ...(await asOfMismatches(dates))]).toEqual([`after ${log.join(', ')}`]);
      await invariants();
    });
  }
});
