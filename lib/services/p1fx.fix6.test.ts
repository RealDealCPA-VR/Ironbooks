/**
 * P1 round, team FX — fix round 6.
 *
 *  - arAging / arAgingDetail (reportsExtra.ts): whether a foreign invoice was open as of the cutoff
 *    is decided from its as-of FOREIGN open amount (payments count on the date they were applied),
 *    not from payment-date applications. A credit applied later that pays the invoice in full no
 *    longer drops the invoice from a past-dated aging (it was removed twice before).
 *  - apAging / apAgingDetail: the same for foreign vendor credits applied to a bill after the
 *    cutoff — the bill keeps its open amount and the credit keeps its unapplied amount as of the
 *    cutoff (vendor_credit_applications are dated).
 *  - refundPayment (payments.ts) + postPaymentCreditFxPlugs (posting.ts): a refund telescopes the
 *    credit AS OF its own date, and the later-dated steps (applies / unapplies entered earlier) are
 *    re-plugged on their own dates, so GL A/R equals the aging as of every date with no void.
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
import { createVendorCredit, applyToBill, unapplyFromBill } from './vendorCredits';
import { Money } from '@/lib/money';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-fx-fix6');
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

describe('P1 FX — fix round 6: as-of aging around later full applies; backdated refunds', () => {
  let seq = 0;
  let userId: string;
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'p1fx-fix6@test.local', name: 'FX F6', passwordHash: 'x' }).returning();
    userId = u.id;
  });
  beforeEach(async () => {
    seq += 1;
    const [company] = await db.insert(companies).values({ name: `FX F6 Co ${seq}`, ownerId: userId }).returning();
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

  // -------------------------------------------------------------------------
  // A/R aging: a foreign invoice paid in full by a credit applied after the cutoff
  // -------------------------------------------------------------------------

  it('A/R: invoice paid IN FULL by a later apply stays on the as-of aging (summary, detail row, both currencies)', async () => {
    const c = await customer('Full Later');
    const inv = await eurInvoice(c.id, '40.00');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.2345'));
    await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: inv.id, amountApplied: '40.00' }] });
    const want = home('40.00', '1.1111').minus(home('100.00', '1.2345')).toFixed(2); // -79.01
    for (const day of ['2026-07-01', '2026-07-15', '2026-07-31']) {
      expect({ day, ...(await arViews(d(day), 'Full Later')) }).toEqual({ day, ar: want, aging: want, detail: want, summary: want });
    }
    const row = (await arAgingDetail(ctx, d('2026-07-15'))).rows.find((r) => r.docId === inv.id);
    expect(row?.openBalance).toBe('44.44');
    expect(row?.foreignOpenBalance).toBe('40.00');
    // Before the payment: only the invoice.
    expect(await arViews(d('2026-06-15'), 'Full Later')).toEqual({ ar: '44.44', aging: '44.44', detail: '44.44', summary: '44.44' });
    // Today: invoice paid, 60 EUR credit left.
    const now = home('60.00', '1.2345').negated().toFixed(2);
    expect(await bal('1200')).toBe(now);
    expect(await agingTotal()).toBe(now);
    expect((await arAgingDetail(ctx, FAR)).rows.find((r) => r.docId === inv.id)).toBeUndefined();
    await invariants();
  });

  it('A/R: paid at receipt stays closed; paid in full later is open before the apply; unapplied later reopens correctly', async () => {
    const c = await customer('Mixed');
    const atReceipt = await eurInvoice(c.id, '25.00');
    const later = await eurInvoice(c.id, '30.00');
    const partial = await eurInvoice(c.id, '50.00');
    // 25 EUR applied on the payment itself (dated 07-01), the rest is credit.
    const { payment } = await receivePayment(
      ctx,
      eurPay(c.id, '2026-07-01', '120.00', '1.3579', [{ invoiceId: atReceipt.id, amountApplied: '25.00' }]),
    );
    await applyPayment(ctx, {
      paymentId: payment.id,
      applications: [
        { invoiceId: later.id, amountApplied: '30.00' },
        { invoiceId: partial.id, amountApplied: '20.00' },
      ],
    });
    const asOf = d('2026-07-10');
    const ids = (await arAgingDetail(ctx, asOf)).rows.map((r) => r.docId);
    expect(ids).not.toContain(atReceipt.id);
    expect(ids).toContain(later.id);
    expect(ids).toContain(partial.id);
    expect(await arMismatches([d('2026-06-30'), ...JULY, new Date(), FAR])).toEqual([]);
    // Economic figure on 07-10: 30 + 50 open at 1.1111, credit 95 EUR at 1.3579.
    expect(await agingTotal(asOf)).toBe(
      home('30.00', '1.1111').plus(home('50.00', '1.1111')).minus(home('95.00', '1.3579')).toFixed(2),
    );
    // Unapply the full apply: the invoice is open again everywhere, still equal.
    await unapplyFromInvoice(ctx, { paymentId: payment.id, invoiceId: later.id, amount: '30.00' });
    expect(await arMismatches([d('2026-06-30'), ...JULY, new Date(), FAR])).toEqual([]);
    expect((await arAgingDetail(ctx, FAR)).rows.map((r) => r.docId)).toContain(later.id);
    await invariants();
  });

  it('A/R: home-currency control — a home invoice paid in full by a later apply keeps the old behavior', async () => {
    const c = await customer('Home');
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
    await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: inv.id, amountApplied: '40.00' }] });
    for (const day of [d('2026-06-15'), ...JULY, new Date(), FAR]) {
      const v = await arViews(day, 'Home');
      expect({ day: iso(day), ar: v.ar, detail: v.detail, summary: v.summary }).toEqual({
        day: iso(day),
        ar: v.aging,
        detail: v.aging,
        summary: v.aging,
      });
    }
    await invariants();
  });

  // -------------------------------------------------------------------------
  // A/P aging: a foreign vendor credit applied to a bill after the cutoff
  // -------------------------------------------------------------------------

  for (const [label, applied] of [
    ['IN FULL', '40.00'],
    ['partly', '15.00'],
  ] as const) {
    it(`A/P: foreign vendor credit applied ${label} after the cutoff — as-of A/P aging, detail and summary == GL A/P`, async () => {
      const v = await createVendor(ctx, { displayName: `Berlin ${label}`, currency: 'EUR' });
      const bill = await createBill(ctx, {
        vendorId: v.id,
        date: d('2026-06-01'),
        exchangeRate: '1.1111',
        lines: [{ accountId: acct['6300'], amount: '40.00' }],
      } as never);
      const vc = await createVendorCredit(ctx, {
        vendorId: v.id,
        date: d('2026-07-01'),
        exchangeRate: '1.2345',
        lines: [{ accountId: acct['6300'], amount: '100.00' }],
      } as never);
      await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: applied, date: d('2026-08-10') });
      const want = home('40.00', '1.1111').minus(home('100.00', '1.2345')).toFixed(2);
      for (const day of ['2026-07-01', '2026-07-15', '2026-08-09']) {
        expect({ day, ...(await apViews(d(day), v.displayName)) }).toEqual({ day, ap: want, aging: want, detail: want, summary: want });
      }
      // On the application date and after, every view still agrees with the GL.
      for (const day of [d('2026-08-10'), d('2026-08-31'), new Date(), FAR]) {
        const x = await apViews(day, v.displayName);
        expect({ day: iso(day), aging: x.aging, detail: x.detail, summary: x.summary }).toEqual({
          day: iso(day),
          aging: x.ap,
          detail: x.ap,
          summary: x.ap,
        });
      }
      const row = (await apAgingDetail(ctx, d('2026-07-15'))).rows.find((r) => r.docId === bill.id);
      expect(row?.openBalance).toBe('44.44');
      expect(row?.foreignOpenBalance).toBe('40.00');
      // Unapply it later again: still equal on every date.
      await unapplyFromBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: applied, date: d('2026-09-01') });
      for (const day of [d('2026-07-15'), d('2026-08-15'), d('2026-09-01'), FAR]) {
        const x = await apViews(day, v.displayName);
        expect({ day: iso(day), aging: x.aging, detail: x.detail }).toEqual({ day: iso(day), aging: x.ap, detail: x.ap });
      }
      await invariants();
    });
  }

  // -------------------------------------------------------------------------
  // refundPayment: a refund backdated before an apply entered earlier
  // -------------------------------------------------------------------------

  it('refund backdated before earlier-entered applies (reviewer scenario): A/R == aging == economic figure on every July day', async () => {
    const c = await customer('Backdated After Apply');
    const rate = '0.98765432';
    const i1 = await eurInvoice(c.id, '40.00');
    const i2 = await eurInvoice(c.id, '30.00');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '150.00', rate));
    await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: i1.id, amountApplied: '25.88' }] });
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '32.92', date: d('2026-07-02') });
    await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: i2.id, amountApplied: '25.33' }] });
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '5.88', date: d('2026-07-04') });
    const failures = await arMismatches([...JULY, new Date(), FAR]);
    for (const day of JULY) {
      let eur = Money.of('150.00');
      if (day >= d('2026-07-02')) eur = eur.minus(Money.of('32.92'));
      if (day >= d('2026-07-04')) eur = eur.minus(Money.of('5.88'));
      const want = home('40.00', '1.1111').plus(home('30.00', '1.1111')).minus(home(eur, rate)).toFixed(2);
      const ar = await arAsOf(day);
      if (ar !== want) failures.push(`${iso(day)}: A/R ${ar}, expected ${want}`);
    }
    expect(failures).toEqual([]);
    // Any re-telescoping plug is dated on a later step (today), never inside July.
    for (const p of await plugs(payment.id)) expect(p.date.getTime()).toBeGreaterThan(d('2026-07-31').getTime());
    // Today: the credit at exactly round2(unapplied x rate).
    const un = await unappliedOf(payment.id);
    expect(un.toFixed(2)).toBe('59.99'); // 150 - 25.88 - 32.92 - 25.33 - 5.88
    // Invoices carry their booked home less round2(paid x rate) per part-payment (payments rule).
    const invHome = home('40.00', '1.1111').minus(home('25.88', '1.1111')).plus(home('30.00', '1.1111')).minus(home('25.33', '1.1111'));
    expect(await bal('1200')).toBe(invHome.minus(home(un, rate)).toFixed(2));
    await invariants();
    // Voiding the backdated refunds afterwards keeps every date equal; then the payment clears all.
    const refunds = await db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.sourceRef, `refund:${payment.id}`)));
    for (const r of refunds) {
      await voidJournalEntry(ctx, r.id);
      expect(await arMismatches([...JULY, new Date(), FAR])).toEqual([]);
    }
    await voidPayment(ctx, payment.id);
    expect(await plugs(payment.id)).toHaveLength(0);
    expect(await arMismatches([...JULY, new Date(), FAR])).toEqual([]);
    await invariants();
  });

  it('refunds entered in date order with no later step post no plugs (unchanged behavior)', async () => {
    const c = await customer('Ordered');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '0.98765432'));
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '32.92', date: d('2026-07-02') });
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '5.88', date: d('2026-07-04') });
    expect(await plugs(payment.id)).toHaveLength(0);
    expect(await arMismatches([...JULY, FAR])).toEqual([]);
    await invariants();
  });

  it('home-currency control: a backdated refund after an apply posts no plug and keeps A/R == aging', async () => {
    const c = await customer('Home Refund');
    const inv = await createInvoice(ctx, {
      customerId: c.id,
      date: d('2026-06-01'),
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '40.00' }],
    } as never);
    const { payment } = await receivePayment(ctx, {
      customerId: c.id,
      date: d('2026-07-01'),
      method: 'check',
      amount: '150.00',
      depositAccountId: acct['1050'],
      applications: [],
    } as never);
    await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: inv.id, amountApplied: '25.88' }] });
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '32.92', date: d('2026-07-02') });
    expect(await plugs(payment.id)).toHaveLength(0);
    expect(await arMismatches([...JULY, new Date(), FAR])).toEqual([]);
    await invariants();
  });

  for (const [seed, rate] of [
    [5, '0.98765432'],
    [17, '1.23456789'],
    [23, '1.3333'],
    [61, '0.7777777'],
  ] as const) {
    it(`random walk (seed ${seed}, rate ${rate}): backdated refunds interleaved with applies / unapplies / voids — A/R == aging every July day after every step`, async () => {
      const r = rng(seed);
      const c = await customer(`Walk ${seed}`);
      const invs: Array<{ id: string; open: Dec }> = [];
      for (let i = 0; i < 3; i++) {
        const total = (10 + Math.floor(r() * 3000) / 100).toFixed(2);
        const inv = await eurInvoice(c.id, total);
        invs.push({ id: inv.id, open: Money.of(total) });
      }
      const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '200.00', rate));
      const refunds: Array<{ id: string; voided: boolean }> = [];
      const applied = new Map<string, Dec>();
      const log: string[] = [];
      const dates = [...JULY, new Date(), FAR];
      for (let step = 0; step < 12; step++) {
        const un = await unappliedOf(payment.id);
        const k = r();
        if (k < 0.35 && un.greaterThan(0)) {
          // Any July day (2..30): often before applies already entered (dated today).
          const day = d(`2026-07-${String(2 + Math.floor(r() * 29)).padStart(2, '0')}`);
          const amt = Money.round2(Dec.max(Money.of('0.01'), un.times(r() * 0.3)));
          const res = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: amt.toFixed(2), date: day });
          refunds.push({ id: res.entry.id, voided: false });
          log.push(`refund ${amt.toFixed(2)} on ${iso(day).slice(5)}`);
        } else if (k < 0.7 && un.greaterThan(0)) {
          const inv = invs[Math.floor(r() * invs.length)];
          const amt = Money.round2(Dec.min(inv.open, un, Dec.max(Money.of('0.01'), un.times(r() * 0.4))));
          if (amt.greaterThan(0)) {
            await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: inv.id, amountApplied: amt.toFixed(2) }] });
            inv.open = inv.open.minus(amt);
            applied.set(inv.id, (applied.get(inv.id) ?? Money.zero()).plus(amt));
            log.push(`apply ${amt.toFixed(2)}`);
          }
        } else if (k < 0.85 && applied.size > 0) {
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
        expect([`after ${log.join(', ')}`, ...(await arMismatches(dates))]).toEqual([`after ${log.join(', ')}`]);
        expect((await trialBalance(ctx)).balanced).toBe(true);
      }
      await invariants();
      for (const x of refunds.filter((y) => !y.voided)) {
        await voidJournalEntry(ctx, x.id);
        x.voided = true;
        expect(await arMismatches(dates)).toEqual([]);
      }
      await voidPayment(ctx, payment.id);
      expect(await plugs(payment.id)).toHaveLength(0);
      expect(await arMismatches(dates)).toEqual([]);
      await invariants();
    });
  }

  it('foreign subledger as of a date before a later full apply lists both the invoice and the credit', async () => {
    const c = await customer('Subledger');
    const inv = await eurInvoice(c.id, '40.00');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.2345'));
    await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: inv.id, amountApplied: '40.00' }] });
    const items = await foreignOpenReceivables(ctx, d('2026-07-15'));
    const total = items.filter((i) => i.entityId === c.id).reduce((s, i) => s.plus(i.homeOpen), Money.zero());
    expect(total.toFixed(2)).toBe(await arAsOf(d('2026-07-15')));
    await invariants();
  });
});
