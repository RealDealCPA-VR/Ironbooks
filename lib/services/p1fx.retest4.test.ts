/**
 * P1 round, team FX — tester re-test 4: adversarial tests for fix round 4 (d36d192).
 *
 * Fix under test:
 *  - restoreRefundedCustomerCredit / postRefundVoidFxPlug (posting.ts): voiding a refund of a
 *    foreign payment's credit posts the cent-level difference between the reversed refund and the
 *    change in the credit's home value to A/R against Exchange Gain/Loss (sourceRef payment:<id>).
 *  - foreignAmountsByEntry (fxSubledger.ts): refund:<paymentId> rows show currency + amount.
 *
 * Covered here:
 *  [P] seeded random interleavings of refund / apply / unapply / void-refund at awkward rates:
 *      A/R == aging and TB balanced after every step; unwinding everything clears A/R and 6900
 *  [A] backdated aging AS OF dates around a voided older refund equals A/R as of that date
 *  [S] Customer Balance Summary / Detail: the plug is named to the customer, no "(no name)" row,
 *      per-customer balance equals the customer's aging row
 *  [B] EUR bank: voiding an older refund paid from the EUR bank restores its foreign balance exactly
 *  [C] closing date: void of a refund in a closed period is refused with nothing changed; with the
 *      closing-date password it succeeds and keeps A/R == aging
 *  [E] editing the payment after a refund-void plug: the plug does not survive as an orphan
 *  [D] the void is idempotent (a second void posts no second plug); balance detail after voids
 *  [I] isolation: two companies, plugs stay in their own company
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, accounts, customers, journalEntries, journalEntryLines, paymentsReceived } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance, balanceSheet } from './reports';
import { postJournalEntry, voidJournalEntry } from './posting';
import { upsertCurrency, setBaseCurrency, setAccountCurrency } from './currencies';
import { createInvoice } from './invoices';
import { receivePayment, voidPayment, updatePayment, applyPayment, unapplyFromInvoice, refundPayment } from './payments';
import { arAging } from './reportsExtra';
import { verifyIntegrity } from './integrity';
import { setClosingDate } from './company';
import { customerBalanceDetail, customerBalanceSummary } from './reportsLists';
import { Money } from '@/lib/money';
import Dec from 'decimal.js';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-fx-retest4');
let db: DB;
let ctx: ServiceContext;
let userId: string;
const acct: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T12:00:00Z`);
const FAR = d('2027-12-31');

async function balOf(id: string): Promise<string> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, id));
  return Money.of(row.balance).toFixed(2);
}
const bal = (code: string) => balOf(acct[code]);
async function fxBal(c: ServiceContext = ctx): Promise<string> {
  const [fx] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.companyId, c.companyId), eq(accounts.code, '6900')));
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
  const rep = await arAging(ctx, asOf);
  const row = rep.rows.find((r) => r.id === customerId);
  return row ? Money.of(row.total).toFixed(2) : '0.00';
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
async function postedPlugs(paymentId: string) {
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
/** Foreign (EUR) balance of an account from its posted lines' signed foreign amounts. */
async function foreignBal(accountId: string): Promise<string> {
  const [r] = await db
    .select({
      v: sql<string>`COALESCE(SUM(CASE WHEN CAST(COALESCE(${journalEntryLines.debit}, '0') AS NUMERIC) > 0 THEN ABS(CAST(${journalEntryLines.foreignAmount} AS NUMERIC)) ELSE -ABS(CAST(${journalEntryLines.foreignAmount} AS NUMERIC)) END), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(journalEntryLines.accountId, accountId),
        eq(journalEntries.status, 'posted'),
        sql`${journalEntryLines.foreignAmount} IS NOT NULL`,
      ),
    );
  return Money.of(r.v).toFixed(2);
}

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

async function newCompany(name: string): Promise<ServiceContext> {
  const [company] = await db.insert(companies).values({ name, ownerId: userId }).returning();
  const c: ServiceContext = { db, companyId: company.id, userId };
  for (const [code, n, type, subtype] of DEFS) {
    acct[code] = (await createAccount(c, { code, name: n, type: type as never, subtype })).id;
  }
  await setBaseCurrency(c, { code: 'USD', name: 'US Dollar' });
  await upsertCurrency(c, { code: 'EUR', name: 'Euro', rateToBase: '1.10' });
  await setAccountCurrency(c, acct['1020'], 'EUR');
  await postJournalEntry(c, {
    date: d('2026-01-01'),
    description: 'Opening',
    lines: [
      { accountId: acct['1000'], debit: '100000.00' },
      { accountId: acct['3000'], credit: '100000.00' },
    ],
  });
  return c;
}

describe('P1 FX — tester re-test 4 (refund voids keep A/R == aging)', () => {
  let seq = 0;
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'p1fx-rt4@test.local', name: 'FX RT4', passwordHash: 'x' }).returning();
    userId = u.id;
  });
  beforeEach(async () => {
    seq += 1;
    ctx = await newCompany(`FX RT4 Co ${seq}`);
  });
  afterAll(async () => {
    await closeDb();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle. */
    }
  });

  for (const [seed, rate] of [
    [11, '1.2345'],
    [29, '1.23456789'],
    [47, '0.98765432'],
    [83, '1.005'],
  ] as const) {
    it(`[P] random refund/apply/unapply/void-refund interleaving (seed ${seed}, rate ${rate}): A/R == aging every step; unwinding clears A/R and 6900`, async () => {
      const r = rng(seed);
      const c = await customer(`Random ${seed}`);
      const invs: Array<{ id: string; open: Decimal; total: Decimal }> = [];
      for (let i = 0; i < 3; i++) {
        const total = (7 + Math.floor(r() * 4000) / 100).toFixed(2);
        const inv = await createInvoice(ctx, {
          customerId: c.id,
          date: d('2026-06-01'),
          currency: 'EUR',
          exchangeRate: rate,
          lines: [{ accountId: acct['4000'], quantity: 1, rate: total }],
        } as never);
        invs.push({ id: inv.id, open: Money.of(total), total: Money.of(total) });
      }
      const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '200.00', rate));
      const refunds: Array<{ id: string; voided: boolean }> = [];
      const applied = new Map<string, Decimal>();
      let day = 2;
      const log: string[] = [];
      for (let step = 0; step < 18; step++) {
        const un = Money.of(await unappliedOf(payment.id));
        const k = r();
        const date = d(`2026-07-${String(Math.min(day++, 28)).padStart(2, '0')}`);
        if (k < 0.35 && un.greaterThan(0)) {
          const amt = Money.round2(Dec.max(Money.of('0.01'), un.times(r() * 0.6)));
          const res = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: r() < 0.5 ? acct['1000'] : acct['1020'], amount: amt.toFixed(2), date });
          refunds.push({ id: res.entry.id, voided: false });
          log.push(`refund ${amt.toFixed(2)}`);
        } else if (k < 0.55 && un.greaterThan(0)) {
          const inv = invs[Math.floor(r() * invs.length)];
          const amt = Money.round2(Dec.min(inv.open, un, Dec.max(Money.of('0.01'), un.times(r()))));
          if (amt.greaterThan(0)) {
            await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: inv.id, amountApplied: amt.toFixed(2) }] });
            inv.open = inv.open.minus(amt);
            applied.set(inv.id, (applied.get(inv.id) ?? Money.zero()).plus(amt));
            log.push(`apply ${amt.toFixed(2)}`);
          }
        } else if (k < 0.75 && applied.size > 0) {
          const [invId, a] = [...applied.entries()][Math.floor(r() * applied.size)];
          const part = r() < 0.5 ? a : Money.round2(Dec.max(Money.of('0.01'), a.times(r())));
          await unapplyFromInvoice(ctx, { paymentId: payment.id, invoiceId: invId, amount: part.toFixed(2) });
          const left = a.minus(part);
          if (left.isZero()) applied.delete(invId);
          else applied.set(invId, left);
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
        expect(`${await agingTotal()} after ${log.join(', ')}`).toBe(`${await bal('1200')} after ${log.join(', ')}`);
        expect((await trialBalance(ctx)).balanced).toBe(true);
      }
      await invariants();
      // Unwind: void every remaining refund, unapply everything, refund the whole credit.
      for (const x of refunds.filter((y) => !y.voided)) {
        await voidJournalEntry(ctx, x.id);
        expect(await agingTotal()).toBe(await bal('1200'));
      }
      for (const [invId] of applied) {
        await unapplyFromInvoice(ctx, { paymentId: payment.id, invoiceId: invId });
        expect(await agingTotal()).toBe(await bal('1200'));
      }
      expect(await unappliedOf(payment.id)).toBe('200.00');
      // Invoices are fully open again: A/R == sum of invoice home anchors minus the full credit.
      const invHome = invs.reduce((s, i) => s.plus(Money.round2(i.total.times(Money.of(rate)))), Money.zero());
      const credit = Money.round2(Money.of('200.00').times(Money.of(rate)));
      expect(await bal('1200')).toBe(invHome.minus(credit).toFixed(2));
      await invariants();
      // Voiding the payment voids every plug: A/R back to the invoices, 6900 back to 0.
      await voidPayment(ctx, payment.id);
      expect(await postedPlugs(payment.id)).toHaveLength(0);
      expect(await bal('1200')).toBe(invHome.toFixed(2));
      expect(await fxBal()).toBe('0.00');
      await invariants();
    });
  }

  it('[A] backdated aging AS OF dates around a voided OLDER refund equals A/R as of that date', async () => {
    const c = await customer('Backdated Void');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.2345'));
    const r1 = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-10') });
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-20') });
    await voidJournalEntry(ctx, r1.entry.id);
    const failures: string[] = [];
    for (const day of ['2026-07-05', '2026-07-10', '2026-07-15', '2026-07-25']) {
      const aging = await agingTotal(d(day));
      const ar = await arAsOf(d(day));
      if (aging !== ar) failures.push(`${day}: aging ${aging} vs A/R ${ar}`);
    }
    // With r1 voided the customer held 100 EUR = 123.45 (home) from 07-01 until the surviving
    // refund on 07-20; both the A/R balance and the aging as of any day before 07-20 must say so.
    for (const day of ['2026-07-05', '2026-07-15']) {
      const ar = await arAsOf(d(day));
      const aging = await agingTotal(d(day));
      if (ar !== '-123.45') failures.push(`${day}: A/R ${ar}, expected -123.45`);
      if (aging !== '-123.45') failures.push(`${day}: aging ${aging}, expected -123.45`);
    }
    expect(failures).toEqual([]);
    await invariants();
  });

  it('[S] Customer Balance Summary / Detail: the refund-void plug is named to the customer; balance == aging row', async () => {
    const c = await customer('Summary');
    const other = await customer('Other');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.2345'));
    await receivePayment(ctx, eurPay(other.id, '2026-07-01', '10.00', '1.2345'));
    const r1 = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-02') });
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-03') });
    await voidJournalEntry(ctx, r1.entry.id);
    expect(await postedPlugs(payment.id)).toHaveLength(1);
    const sum = await customerBalanceSummary(ctx, { asOf: '2027-12-31' } as never);
    const labels = sum.rows.filter((x) => x.kind === 'data').map((x) => String(x.cells.label));
    expect(labels).not.toContain('(no name)');
    const row = sum.rows.find((x) => x.kind === 'data' && x.cells.label === 'Summary')!;
    expect(Money.of(String(row.cells.balance)).toFixed(2)).toBe(await agingFor(c.id));
    expect(Money.of(String(row.cells.balance)).toFixed(2)).toBe('-82.30');
    // Detail: the plug row sits under the customer; no data row lacks a name group.
    const det = await customerBalanceDetail(ctx, { asOf: '2027-12-31', customerId: c.id } as never);
    const plug = (await postedPlugs(payment.id))[0];
    expect(det.rows.some((x) => x.kind === 'data' && x.entryId === plug.id)).toBe(true);
    // The voided refund does not show; the surviving refund shows EUR 33.33.
    expect(det.rows.some((x) => x.kind === 'data' && x.entryId === r1.entry.id)).toBe(false);
    await invariants();
  });

  it('[B] EUR bank: voiding an older refund paid from the EUR bank restores its foreign balance exactly', async () => {
    const c = await customer('Euro Bank Void');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.2345'));
    const r1 = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1020'], amount: '33.33', date: d('2026-07-02') });
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1020'], amount: '33.33', date: d('2026-07-03') });
    expect(await foreignBal(acct['1020'])).toBe('-66.66');
    expect(await bal('1020')).toBe('-82.29');
    await voidJournalEntry(ctx, r1.entry.id);
    // Only the surviving refund remains on the bank, in both currencies; the plug never touches the bank.
    expect(await foreignBal(acct['1020'])).toBe('-33.33');
    expect(await bal('1020')).toBe('-41.14');
    for (const p of await postedPlugs(payment.id)) {
      const lines = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, p.id));
      expect(lines.some((l) => l.accountId === acct['1020'] || l.accountId === acct['1000'])).toBe(false);
    }
    await invariants();
  });

  it('[C] closing date: voiding a refund in a closed period is refused with nothing changed; the password allows it and A/R == aging', async () => {
    const c = await customer('Closed');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.2345'));
    const r1 = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-02') });
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-03') });
    const arBefore = await bal('1200');
    await setClosingDate(ctx, { closingDate: '2026-07-31' });
    try {
      await expect(voidJournalEntry(ctx, r1.entry.id)).rejects.toThrow();
      expect(await unappliedOf(payment.id)).toBe('33.34');
      expect(await postedPlugs(payment.id)).toHaveLength(0);
      expect(await bal('1200')).toBe(arBefore);
      const [e] = await db.select().from(journalEntries).where(eq(journalEntries.id, r1.entry.id));
      expect(e.status).toBe('posted');
      await voidJournalEntry({ ...ctx, closingDateOverride: true }, r1.entry.id);
      expect(await unappliedOf(payment.id)).toBe('66.67');
      expect(await postedPlugs(payment.id)).toHaveLength(1);
      expect(await bal('1200')).toBe('-82.30');
    } finally {
      await setClosingDate(ctx, { closingDate: null });
    }
    await invariants();
  });

  it('[D] voiding the same refund twice posts one plug only; A/R == aging', async () => {
    const c = await customer('Twice');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.2345'));
    const r1 = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-02') });
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-03') });
    await voidJournalEntry(ctx, r1.entry.id);
    await voidJournalEntry(ctx, r1.entry.id);
    expect(await postedPlugs(payment.id)).toHaveLength(1);
    expect(await unappliedOf(payment.id)).toBe('66.67');
    expect(await bal('1200')).toBe('-82.30');
    await invariants();
  });

  it('[E] editing the payment (amount + rate) after a refund-void plug: no orphan plug, A/R == aging, 6900 consistent', async () => {
    const c = await customer('Edit');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.2345'));
    const r1 = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-02') });
    const r2 = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-03') });
    await voidJournalEntry(ctx, r1.entry.id);
    await voidJournalEntry(ctx, r2.entry.id);
    expect((await postedPlugs(payment.id)).length).toBeGreaterThan(0);
    await updatePayment(ctx, payment.id, eurPay(c.id, '2026-07-01', '90.00', '1.3000'));
    // 90 EUR at 1.30 = 117.00 credit; no plug from the old rate may linger.
    expect(await unappliedOf(payment.id)).toBe('90.00');
    expect(await bal('1200')).toBe('-117.00');
    expect(await fxBal()).toBe('0.00');
    await invariants();
    // And the edited payment's credit can still be refunded to exactly 0.
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '90.00', date: d('2026-07-05') });
    expect(await bal('1200')).toBe('0.00');
    await invariants();
  });

  it('[I] isolation: a refund-void plug in one company never touches another company', async () => {
    const c = await customer('Iso A');
    const ctxA = ctx;
    const acctA = { ...acct };
    const { payment } = await receivePayment(ctxA, eurPay(c.id, '2026-07-01', '100.00', '1.2345'));
    const r1 = await refundPayment(ctxA, { paymentId: payment.id, bankAccountId: acctA['1000'], amount: '33.33', date: d('2026-07-02') });
    await refundPayment(ctxA, { paymentId: payment.id, bankAccountId: acctA['1000'], amount: '33.33', date: d('2026-07-03') });
    const ctxB = await newCompany(`FX RT4 Iso B ${seq}`);
    const acctB = { ...acct };
    Object.assign(acct, acctA);
    const bBefore = await balOf(acctB['1200']);
    await voidJournalEntry(ctxA, r1.entry.id);
    expect(await balOf(acctB['1200'])).toBe(bBefore);
    expect(await fxBal(ctxB)).toBe('0.00');
    const plugs = await postedPlugs(payment.id);
    expect(plugs).toHaveLength(1);
    expect(plugs[0].companyId).toBe(ctxA.companyId);
    // Company B cannot void company A's refund.
    await expect(voidJournalEntry(ctxB, r1.entry.id)).rejects.toThrow();
    ctx = ctxA;
    await invariants();
  });
});

type Decimal = Dec;
