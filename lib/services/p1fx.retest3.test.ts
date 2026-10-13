/**
 * P1 round, team FX — tester re-test 3: adversarial tests for fix round 3 (429db2f).
 *
 * Fix under test: refundPayment (payments.ts, cross-team) relieves A/R by
 * homeAt(unapplied before) - homeAt(unapplied after) at the payment rate, the same home amount on
 * the bank and A/R lines; a refund from a bank in the payment currency carries the foreign amount.
 *
 * Covered here:
 *  [R] refunds: interleaved with apply / unapply, tiny refunds, odd rates, over-refund, home
 *      currency unchanged, backdated aging between refunds, foreign amount on a EUR bank line,
 *      refund from a bank in a third currency, rollback on refusal, closing date, balance detail
 *  [V] voiding refunds: the newest refund, an older refund, a refund followed by an apply
 *  [H] Home Currency Adjustment after refunds (bank + customer credit)
 *  [I] isolation: another company's bank / payment
 *  [B] backup + restore after refunds
 *  [L] documented legacy limitation (application split across the 0043 upgrade): residue <= 1 cent
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  accounts,
  customers,
  invoices,
  journalEntries,
  journalEntryLines,
  paymentsReceived,
  paymentFxReliefs,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance, balanceSheet } from './reports';
import { postJournalEntry, voidJournalEntry } from './posting';
import { upsertCurrency, setBaseCurrency, setAccountCurrency } from './currencies';
import { createInvoice } from './invoices';
import { receivePayment, applyPayment, unapplyFromInvoice, refundPayment } from './payments';
import { arAging } from './reportsExtra';
import { verifyIntegrity } from './integrity';
import { foreignOpenReceivables } from './fxSubledger';
import { previewHomeCurrencyAdjustment, createHomeCurrencyAdjustment } from './homeCurrencyAdjustment';
import { createCompanyBackup, restoreCompanyBackup } from './backup';
import { setClosingDate } from './company';
import { customerBalanceDetail } from './reportsLists';
import { Money } from '@/lib/money';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-fx-retest3');
let db: DB;
let ctx: ServiceContext;
let ctxB: ServiceContext;
let user: { id: string };
const acct: Record<string, string> = {};
const acctB: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T12:00:00Z`);
const FAR = d('2027-12-31');

async function balOf(id: string): Promise<string> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, id));
  return Money.of(row.balance).toFixed(2);
}
const bal = (code: string, map = acct) => balOf(map[code]);
async function arAsOf(c: ServiceContext, asOf: Date, map = acct): Promise<string> {
  const tb = await trialBalance(c, asOf);
  const row = tb.rows.find((r) => r.accountId === map['1200']);
  return row ? Money.of(row.debit).minus(Money.of(row.credit)).toFixed(2) : '0.00';
}
async function agingTotal(c: ServiceContext, asOf = FAR): Promise<string> {
  return Money.of((await arAging(c, asOf)).totals.total).toFixed(2);
}
async function failedChecks(c: ServiceContext = ctx) {
  return (await verifyIntegrity(c)).checks.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`);
}
async function invariants(c: ServiceContext = ctx, map = acct) {
  expect((await trialBalance(c)).balanced).toBe(true);
  const bs = await balanceSheet(c);
  expect(Money.of(bs.totalAssets).toFixed(2)).toBe(Money.of(bs.totalLiabilities).plus(Money.of(bs.totalEquity)).toFixed(2));
  expect(await agingTotal(c)).toBe(await bal('1200', map));
  expect(await failedChecks(c)).toEqual([]);
}
async function customer(name: string, c: ServiceContext = ctx) {
  const [row] = await db.insert(customers).values({ companyId: c.companyId, displayName: name }).returning();
  return row;
}
async function eurInvoice(customerId: string, date: string, amount: string, rate: string, c: ServiceContext = ctx, map = acct) {
  return createInvoice(c, {
    customerId,
    date: d(date),
    currency: 'EUR',
    exchangeRate: rate,
    lines: [{ accountId: map['4000'], quantity: 1, rate: amount }],
  } as never);
}
function eurPay(
  customerId: string,
  date: string,
  amount: string,
  rate: string,
  applications: Array<{ invoiceId: string; amountApplied: string; discountAmount?: string }>,
  map = acct,
) {
  return {
    customerId,
    date: d(date),
    method: 'check',
    amount,
    currency: 'EUR',
    exchangeRate: rate,
    depositAccountId: map['1050'],
    applications,
  } as never;
}
async function unappliedOf(paymentId: string) {
  const [row] = await db.select().from(paymentsReceived).where(eq(paymentsReceived.id, paymentId));
  return Money.of(row.unapplied).toFixed(2);
}
async function balanceDue(id: string) {
  const [row] = await db.select().from(invoices).where(eq(invoices.id, id));
  return Money.of(row.balanceDue).toFixed(2);
}
async function entryCount(c: ServiceContext = ctx) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(journalEntries)
    .where(eq(journalEntries.companyId, c.companyId));
  return row.n;
}
async function entryLines(entryId: string) {
  return db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, entryId));
}

const DEFS: Array<[string, string, string, string]> = [
  ['1000', 'Checking', 'asset', 'checking'],
  ['1050', 'Undeposited Funds', 'asset', 'checking'],
  ['1020', 'Euro Bank', 'asset', 'checking'],
  ['1030', 'Pound Bank', 'asset', 'checking'],
  ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
  ['1500', 'Equipment', 'asset', 'fixed_assets'],
  ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
  ['2200', 'Sales Tax Payable', 'liability', 'other_current_liability'],
  ['3000', 'Owner Equity', 'equity', 'owners_equity'],
  ['4000', 'Sales', 'revenue', 'sales'],
  ['4100', 'Sales Discounts', 'revenue', 'sales'],
];

async function setupCompany(c: ServiceContext, map: Record<string, string>) {
  for (const [code, name, type, subtype] of DEFS) {
    map[code] = (await createAccount(c, { code, name, type: type as never, subtype })).id;
  }
  await setBaseCurrency(c, { code: 'USD', name: 'US Dollar' });
  await upsertCurrency(c, { code: 'EUR', name: 'Euro', rateToBase: '1.10' });
  await upsertCurrency(c, { code: 'GBP', name: 'Pound', rateToBase: '1.30' });
  await setAccountCurrency(c, map['1020'], 'EUR');
  await setAccountCurrency(c, map['1030'], 'GBP');
  await postJournalEntry(c, {
    date: d('2026-01-01'),
    description: 'Opening',
    lines: [
      { accountId: map['1000'], debit: '100000.00' },
      { accountId: map['3000'], credit: '100000.00' },
    ],
  });
}

describe('P1 FX — re-test 3: refundPayment telescoping (fix round 3)', () => {
  let seq = 0;
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    [user] = await db.insert(users).values({ email: 'p1fx-rt3@test.local', name: 'FX RT3', passwordHash: 'x' }).returning();
  });
  beforeEach(async () => {
    seq += 1;
    const [company] = await db.insert(companies).values({ name: `FX RT3 Co ${seq}`, ownerId: user.id }).returning();
    const [companyB] = await db.insert(companies).values({ name: `FX RT3 Other ${seq}`, ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    ctxB = { db, companyId: companyB.id, userId: user.id };
    await setupCompany(ctx, acct);
  });
  afterAll(async () => {
    await closeDb();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle. */
    }
  });

  // -------------------------------------------------------------------------------------------
  // [R] refunds
  // -------------------------------------------------------------------------------------------

  it('[R] refund / apply / unapply / refund interleaved: A/R == aging after every step, ends at exactly 0', async () => {
    const c = await customer('Interleave');
    const inv = await eurInvoice(c.id, '2026-07-01', '50.00', '1.07');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-02', '100.00', '1.2345', []));
    await invariants();
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '17.77', date: d('2026-07-03') });
    await invariants();
    await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: inv.id, amountApplied: '33.33' }] });
    await invariants();
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '11.11', date: d('2026-07-04') });
    await invariants();
    await unapplyFromInvoice(ctx, { paymentId: payment.id, invoiceId: inv.id, amount: '13.33' });
    await invariants();
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '9.99', date: d('2026-07-05') });
    await invariants();
    // Refund everything still unapplied; finish the invoice with a new payment.
    const rest = await unappliedOf(payment.id);
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: rest, date: d('2026-07-06') });
    expect(await unappliedOf(payment.id)).toBe('0.00');
    await invariants();
    const due = await balanceDue(inv.id);
    await receivePayment(ctx, eurPay(c.id, '2026-07-07', due, '1.19', [{ invoiceId: inv.id, amountApplied: due }]));
    expect(await balanceDue(inv.id)).toBe('0.00');
    expect(await bal('1200')).toBe('0.00');
    await invariants();
  });

  it('[R] ten 0.01 refunds of a 0.10 credit (rate 1.2345): A/R == aging after each and the sum clears A/R', async () => {
    const c = await customer('Tiny');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '0.10', '1.2345', []));
    expect(await bal('1200')).toBe('-0.12');
    let paid = Money.zero();
    for (let i = 0; i < 10; i++) {
      const { entry } = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '0.01', date: d('2026-07-02') });
      const lines = await entryLines(entry.id);
      const bank = lines.find((l) => l.accountId === acct['1000']);
      paid = paid.plus(Money.of(bank?.credit ?? '0'));
      expect(await agingTotal(ctx)).toBe(await bal('1200'));
    }
    expect(paid.toFixed(2)).toBe('0.12');
    expect(await bal('1200')).toBe('0.00');
    await invariants();
  });

  it('[R] 0.01 refund whose home value rounds to 0.00 (rate 0.30): refused cleanly or posted; A/R == aging either way', async () => {
    const c = await customer('Sub-cent');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '0.10', '0.30', []));
    expect(await bal('1200')).toBe('-0.03');
    const before = await entryCount();
    let ok = true;
    try {
      // homeAt(0.10)=0.03, homeAt(0.09)=0.03: the telescoped home value is 0.00
      await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '0.01', date: d('2026-07-02') });
    } catch {
      ok = false;
    }
    if (!ok) {
      expect(await unappliedOf(payment.id)).toBe('0.10');
      expect(await entryCount()).toBe(before);
    } else {
      expect(await unappliedOf(payment.id)).toBe('0.09');
    }
    await invariants();
    // Whatever happened, refunding the remainder clears A/R exactly.
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: await unappliedOf(payment.id), date: d('2026-07-03') });
    expect(await bal('1200')).toBe('0.00');
    await invariants();
  });

  it('[R] odd 8-decimal rate: partial refunds then the remainder clear A/R; total paid == original home credit', async () => {
    const c = await customer('Odd Rate');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '987.65', '1.23456789', []));
    const credit = Money.of(await bal('1200')).negated();
    expect(credit.toFixed(2)).toBe('1219.32'); // 987.65 x 1.23456789 = 1219.3209...
    const bankBefore = Money.of(await bal('1000'));
    for (const amt of ['123.45', '0.03', '400.01', '77.77']) {
      await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: amt, date: d('2026-07-02') });
      // the remaining credit is carried at exactly homeAt(unapplied, rate)
      const rem = Money.of(await unappliedOf(payment.id));
      expect(Money.of(await bal('1200')).negated().toFixed(2)).toBe(Money.round2(rem.times('1.23456789')).toFixed(2));
      await invariants();
    }
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: await unappliedOf(payment.id), date: d('2026-07-03') });
    expect(await bal('1200')).toBe('0.00');
    expect(bankBefore.minus(Money.of(await bal('1000'))).toFixed(2)).toBe(credit.toFixed(2));
    await invariants();
  });

  it('[R] over-refund by one cent, zero refund, non-bank account: refused with no entry posted and nothing changed', async () => {
    const c = await customer('Over');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.2345', []));
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-02') });
    const before = await entryCount();
    await expect(
      refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '66.68', date: d('2026-07-03') }),
    ).rejects.toThrow(/exceeds/);
    await expect(
      refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '0', date: d('2026-07-03') }),
    ).rejects.toThrow();
    await expect(
      refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1500'], amount: '1.00', date: d('2026-07-03') }),
    ).rejects.toThrow(/bank/);
    expect(await entryCount()).toBe(before);
    expect(await unappliedOf(payment.id)).toBe('66.67');
    expect(await bal('1200')).toBe('-82.30');
    await invariants();
  });

  it('[R] home-currency payment: refund is amount x 1, no foreign amount on the bank line (unchanged behaviour)', async () => {
    const c = await customer('Home');
    const { payment } = await receivePayment(ctx, {
      customerId: c.id,
      date: d('2026-07-01'),
      method: 'check',
      amount: '100.00',
      depositAccountId: acct['1050'],
      applications: [],
    } as never);
    const { entry } = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-02') });
    const lines = await entryLines(entry.id);
    const bank = lines.find((l) => l.accountId === acct['1000'])!;
    const ar = lines.find((l) => l.accountId === acct['1200'])!;
    expect(Money.of(bank.credit!).toFixed(2)).toBe('33.33');
    expect(Money.of(ar.debit!).toFixed(2)).toBe('33.33');
    expect(bank.foreignAmount).toBeNull();
    expect(await bal('1200')).toBe('-66.67');
    await invariants();
  });

  it('[R] every refund entry has two lines, balances, and A/R debit == bank credit', async () => {
    const c = await customer('Balanced');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.2345', []));
    for (const [amt, bank] of [['10.01', '1000'], ['20.02', '1020'], ['30.03', '1000']] as const) {
      const { entry } = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct[bank], amount: amt, date: d('2026-07-02') });
      const lines = await entryLines(entry.id);
      expect(lines.length).toBe(2);
      const dr = lines.reduce((s, l) => s.plus(Money.of(l.debit ?? '0')), Money.zero());
      const cr = lines.reduce((s, l) => s.plus(Money.of(l.credit ?? '0')), Money.zero());
      expect(dr.toFixed(2)).toBe(cr.toFixed(2));
      const ar = lines.find((l) => l.accountId === acct['1200'])!;
      const bk = lines.find((l) => l.accountId === acct[bank])!;
      expect(Money.of(ar.debit!).toFixed(2)).toBe(Money.of(bk.credit!).toFixed(2));
    }
    await invariants();
  });

  it('[R] backdated aging AS OF a date between refunds equals the A/R balance as of that date', async () => {
    const c = await customer('Backdated');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.2345', []));
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-10') });
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-20') });
    for (const day of ['2026-07-05', '2026-07-15', '2026-07-25']) {
      expect(await agingTotal(ctx, d(day))).toBe(await arAsOf(ctx, d(day)));
    }
    expect(await arAsOf(ctx, d('2026-07-15'))).toBe('-82.30');
    await invariants();
  });

  it('[R] refunds from the EUR bank: foreign amount + currency on each bank line; the EUR bank carries the telescoped home', async () => {
    const c = await customer('Euro Bank Refund');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.2345', []));
    const r1 = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1020'], amount: '33.33', date: d('2026-07-02') });
    const r2 = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1020'], amount: '33.33', date: d('2026-07-03') });
    let foreign = Money.zero();
    for (const r of [r1, r2]) {
      const bank = (await entryLines(r.entry.id)).find((l) => l.accountId === acct['1020'])!;
      expect(bank.currency).toBe('EUR');
      expect(Money.of(bank.foreignAmount!).abs().toFixed(2)).toBe('33.33');
      foreign = foreign.plus(Money.of(bank.foreignAmount!).abs());
    }
    expect(foreign.toFixed(2)).toBe('66.66');
    expect(await bal('1020')).toBe('-82.29'); // 41.15 + 41.14
    await invariants();
  });

  it('[R] refund from a bank in a THIRD currency (GBP) for a EUR payment: refused cleanly, or never labelled as GBP 33.33', async () => {
    const c = await customer('Pound Refund');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.2345', []));
    const before = await entryCount();
    let entryId: string | null = null;
    try {
      entryId = (await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1030'], amount: '33.33', date: d('2026-07-02') })).entry.id;
    } catch {
      /* refusal is acceptable */
    }
    if (entryId) {
      const bank = (await entryLines(entryId)).find((l) => l.accountId === acct['1030'])!;
      const labelledGbp = bank.currency === 'GBP' && bank.foreignAmount != null && Money.of(bank.foreignAmount).abs().toFixed(2) === '33.33';
      expect(labelledGbp).toBe(false);
    } else {
      expect(await entryCount()).toBe(before);
      expect(await unappliedOf(payment.id)).toBe('100.00');
    }
    await invariants();
  });

  it('[R] refund dated in a closed period is refused; nothing changes', async () => {
    const c = await customer('Closed');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.2345', []));
    await setClosingDate(ctx, { closingDate: '2026-07-31' });
    const before = await entryCount();
    try {
      await expect(
        refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-15') }),
      ).rejects.toThrow();
    } finally {
      await setClosingDate(ctx, { closingDate: null });
    }
    expect(await entryCount()).toBe(before);
    expect(await unappliedOf(payment.id)).toBe('100.00');
    await invariants();
  });

  it('[R] Customer Balance Detail shows the refund of a EUR credit in EUR as well as in home currency', async () => {
    const c = await customer('Detail Refund');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.2345', []));
    const { entry } = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-02') });
    const rep = await customerBalanceDetail(ctx, { asOf: '2027-12-31' } as never);
    const row = rep.rows.find((r) => r.kind === 'data' && r.entryId === entry.id);
    expect(row).toBeTruthy();
    expect(row!.cells.currency).toBe('EUR');
    expect(Money.of(String(row!.cells.foreignAmount)).abs().toFixed(2)).toBe('33.33');
  });

  // -------------------------------------------------------------------------------------------
  // [V] voiding refunds
  // -------------------------------------------------------------------------------------------

  it('[V] voiding the newest refund restores the credit and A/R exactly', async () => {
    const c = await customer('Void Newest');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.2345', []));
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-02') });
    const r2 = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-03') });
    expect(await bal('1200')).toBe('-41.16');
    await voidJournalEntry(ctx, r2.entry.id);
    expect(await unappliedOf(payment.id)).toBe('66.67');
    expect(await bal('1200')).toBe('-82.30');
    await invariants();
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '66.67', date: d('2026-07-04') });
    expect(await bal('1200')).toBe('0.00');
    await invariants();
  });

  it('[V] voiding an OLDER refund (not the newest) keeps A/R == aging, and refunding the rest clears A/R', async () => {
    const c = await customer('Void Older');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.2345', []));
    const r1 = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-02') });
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-03') });
    // r1 posted 41.15, r2 posted 41.14. Voiding r1 puts 33.33 back: the credit is 66.67 = 82.30 home.
    await voidJournalEntry(ctx, r1.entry.id);
    expect(await unappliedOf(payment.id)).toBe('66.67');
    expect(await agingTotal(ctx)).toBe('-82.30');
    expect(await bal('1200')).toBe('-82.30');
    await invariants();
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '66.67', date: d('2026-07-04') });
    expect(await bal('1200')).toBe('0.00');
    await invariants();
  });

  it('[V] refund, then apply credit to an invoice, then void the refund: A/R == aging', async () => {
    const c = await customer('Void After Apply');
    const inv = await eurInvoice(c.id, '2026-07-01', '33.33', '1.2345');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-02', '100.00', '1.2345', []));
    const r1 = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-03') });
    await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: inv.id, amountApplied: '33.33' }] });
    await invariants();
    await voidJournalEntry(ctx, r1.entry.id);
    expect(await unappliedOf(payment.id)).toBe('66.67');
    expect(await bal('1200')).toBe(await agingTotal(ctx));
    await invariants();
  });

  // -------------------------------------------------------------------------------------------
  // [H] Home Currency Adjustment after refunds
  // -------------------------------------------------------------------------------------------

  it('[H] after refunds at the payment rate, an HCA at that same rate has nothing to adjust for the credit or the EUR bank', async () => {
    const c = await customer('HCA Same');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.2345', []));
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1020'], amount: '33.33', date: d('2026-07-02') });
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '22.22', date: d('2026-07-03') });
    const preview = await previewHomeCurrencyAdjustment(ctx, { date: d('2026-07-31'), rates: { EUR: '1.2345', GBP: '1.30' } });
    expect(preview.lines.filter((l) => l.entityId === c.id)).toEqual([]);
    expect(preview.lines.filter((l) => l.accountId === acct['1020'] && l.kind === 'account')).toEqual([]);
  });

  it('[H] HCA at a new rate after a refund revalues the remaining credit; reverses next day; the rest refunds to 0', async () => {
    const c = await customer('HCA New');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.2345', []));
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-02') });
    const preview = await previewHomeCurrencyAdjustment(ctx, { date: d('2026-07-31'), rates: { EUR: '1.30' } });
    const line = preview.lines.find((l) => l.entityId === c.id)!;
    expect(line).toBeTruthy();
    expect(Money.of(line.foreignBalance).abs().toFixed(2)).toBe('66.67');
    expect(Money.of(line.homeBalance).abs().toFixed(2)).toBe('82.30');
    expect(Money.of(line.newHomeBalance).abs().toFixed(2)).toBe('86.67');
    await createHomeCurrencyAdjustment(ctx, { date: d('2026-07-31'), rates: { EUR: '1.30' } });
    expect(await arAsOf(ctx, d('2026-07-31'))).toBe('-86.67');
    expect(await arAsOf(ctx, d('2026-08-02'))).toBe('-82.30');
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '66.67', date: d('2026-08-05') });
    expect(await bal('1200')).toBe('0.00');
    await invariants();
  });

  // -------------------------------------------------------------------------------------------
  // [I] isolation
  // -------------------------------------------------------------------------------------------

  it("[I] another company's bank account or session cannot refund this company's payment", async () => {
    await setupCompany(ctxB, acctB);
    const c = await customer('Isolated');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.2345', []));
    const before = await entryCount();
    const beforeB = await entryCount(ctxB);
    await expect(
      refundPayment(ctx, { paymentId: payment.id, bankAccountId: acctB['1000'], amount: '10.00', date: d('2026-07-02') }),
    ).rejects.toThrow();
    await expect(
      refundPayment(ctxB, { paymentId: payment.id, bankAccountId: acctB['1000'], amount: '10.00', date: d('2026-07-02') }),
    ).rejects.toThrow();
    expect(await entryCount()).toBe(before);
    expect(await entryCount(ctxB)).toBe(beforeB);
    expect(await unappliedOf(payment.id)).toBe('100.00');
    expect(await bal('1000', acctB)).toBe('100000.00');
    await invariants();
    await invariants(ctxB, acctB);
  });

  // -------------------------------------------------------------------------------------------
  // [B] backup + restore
  // -------------------------------------------------------------------------------------------

  it('[B] backup + restore after partial refunds: restored books verify and refunding the rest clears A/R', async () => {
    const c = await customer('Backup Refund');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.2345', []));
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1020'], amount: '33.33', date: d('2026-07-02') });
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-03') });
    const backup = await createCompanyBackup(db, ctx.companyId);
    const restored = await restoreCompanyBackup(db, backup.buffer, { ownerId: user.id, name: `FX RT3 Restored ${seq}` });
    const rctx: ServiceContext = { db, companyId: restored.companyId, userId: user.id };
    const rAcct: Record<string, string> = {};
    for (const a of await db.select().from(accounts).where(eq(accounts.companyId, rctx.companyId))) rAcct[a.code!] = a.id;
    expect(await bal('1200', rAcct)).toBe('-41.16');
    expect(await bal('1020', rAcct)).toBe('-41.15');
    await invariants(rctx, rAcct);
    const [rp] = await db.select().from(paymentsReceived).where(eq(paymentsReceived.companyId, rctx.companyId));
    expect(Money.of(rp.unapplied).toFixed(2)).toBe('33.34');
    await refundPayment(rctx, { paymentId: rp.id, bankAccountId: rAcct['1000'], amount: '33.34', date: d('2026-07-04') });
    expect(await bal('1200', rAcct)).toBe('0.00');
    await invariants(rctx, rAcct);
  });

  // -------------------------------------------------------------------------------------------
  // [L] documented legacy limitation
  // -------------------------------------------------------------------------------------------

  it('[L] application split across the 0043 upgrade: residue <= 1 cent, A/R == aging, and the books still finish at 0', async () => {
    const c = await customer('Legacy Split');
    const inv = await eurInvoice(c.id, '2026-04-01', '100.00', '1.2345');
    // 33.33 x 1.2345 = 41.146 -> 41.15 legacy; drop the record so it looks pre-upgrade.
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-04-02', '50.00', '1.2345', [{ invoiceId: inv.id, amountApplied: '33.33' }]));
    await db.delete(paymentFxReliefs).where(eq(paymentFxReliefs.paymentId, payment.id));
    await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: inv.id, amountApplied: '16.67' }] });
    await unapplyFromInvoice(ctx, { paymentId: payment.id, invoiceId: inv.id, amount: '20.00' });
    const open = (await foreignOpenReceivables(ctx, FAR)).find((x) => x.kind === 'invoice' && x.id === inv.id)!;
    const residue = open.homeOpen.minus(Money.round2(open.foreignOpen.times('1.2345'))).abs();
    expect(residue.lessThanOrEqualTo('0.01')).toBe(true);
    expect(await agingTotal(ctx)).toBe(await bal('1200'));
    const due = await balanceDue(inv.id);
    await receivePayment(ctx, eurPay(c.id, '2026-04-05', due, '1.2345', [{ invoiceId: inv.id, amountApplied: due }]));
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: await unappliedOf(payment.id), date: d('2026-04-06') });
    expect(await balanceDue(inv.id)).toBe('0.00');
    expect(await bal('1200')).toBe('0.00');
    await invariants();
  });
});
