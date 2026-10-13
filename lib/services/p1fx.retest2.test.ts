/**
 * P1 round, team FX — tester re-test round 2 (verifies fix commit 091aeaf: payment_fx_reliefs).
 *
 * Each reviewer issue is pushed past the exact case the fix was written for:
 *  - fxSubledger.ts: A/R == aging after every step of a messy sequence (discounts, edits, voids),
 *    aging AS OF a past date ties to the A/R balance as of that date, Home Currency Adjustment
 *    revalues from the home amount actually on A/R;
 *  - payments.ts postPayment: one payment finishing two partly-paid invoices booked at different
 *    rates; voiding the finishing payment restores the exact earlier state; relief rows follow;
 *  - payments.ts applyPayment / unapplyFromInvoice: one credit spread over two invoices in ONE
 *    call (running credit), unapply all, then void the payment: every FX plug is undone;
 *    refunds of a foreign credit keep the credit's home value consistent with the aging;
 *  - integrity.ts: Verify Data passes on mixed home / foreign books, is NOT vacuous (detects a
 *    one-cent drift in the relief records and in a home invoice), and is isolated per company;
 *  - 0043 section 6 / backup.ts: re-runnable migration, FK declared, company backup + restore
 *    keeps relief records so the restored books still finish the invoice exactly.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, accounts, customers, invoices, journalEntries, journalEntryLines, paymentFxReliefs } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance, balanceSheet } from './reports';
import { postJournalEntry } from './posting';
import { upsertCurrency, setBaseCurrency } from './currencies';
import { createInvoice } from './invoices';
import { receivePayment, voidPayment, applyPayment, unapplyFromInvoice, updatePayment, refundPayment } from './payments';
import { arAging } from './reportsExtra';
import { verifyIntegrity } from './integrity';
import { foreignOpenReceivables } from './fxSubledger';
import { previewHomeCurrencyAdjustment, createHomeCurrencyAdjustment } from './homeCurrencyAdjustment';
import { createCompanyBackup, restoreCompanyBackup } from './backup';
import { MIGRATIONS_FOLDER } from '@/lib/db';
import { foreignKeyGaps } from '@/lib/db/ledgerGuards';
import { Money } from '@/lib/money';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-fx-retest2');
let db: DB;
let ctx: ServiceContext;
let ctxB: ServiceContext;
const acct: Record<string, string> = {};
const acctB: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T12:00:00Z`);
const FAR = d('2027-12-31');

async function balOf(id: string): Promise<string> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, id));
  return Money.of(row.balance).toFixed(2);
}
const bal = (code: string, map = acct) => balOf(map[code]);
/** A/R balance from the GL as of a date (trial balance rows are debit/credit). */
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
async function homeInvoice(customerId: string, date: string, amount: string) {
  return createInvoice(ctx, {
    customerId,
    date: d(date),
    lines: [{ accountId: acct['4000'], quantity: 1, rate: amount }],
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
async function balanceDue(id: string) {
  const [row] = await db.select().from(invoices).where(eq(invoices.id, id));
  return Money.of(row.balanceDue).toFixed(2);
}
async function reliefRows(paymentId: string) {
  return db.select().from(paymentFxReliefs).where(eq(paymentFxReliefs.paymentId, paymentId));
}
async function invoiceHomeOpen(invoiceId: string, c: ServiceContext = ctx): Promise<string | null> {
  const it = (await foreignOpenReceivables(c, FAR)).find((x) => x.kind === 'invoice' && x.id === invoiceId);
  return it ? it.homeOpen.toFixed(2) : null;
}

const DEFS: Array<[string, string, string, string]> = [
  ['1000', 'Checking', 'asset', 'checking'],
  ['1050', 'Undeposited Funds', 'asset', 'checking'],
  ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
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
  await postJournalEntry(c, {
    date: d('2026-01-01'),
    description: 'Opening',
    lines: [
      { accountId: map['1000'], debit: '100000.00' },
      { accountId: map['3000'], credit: '100000.00' },
    ],
  });
}

describe('P1 FX — tester re-test round 2 (relief records)', () => {
  let user: { id: string };
  let seq = 0;
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    db = await getDb(TEST_DIR);
    [user] = await db.insert(users).values({ email: 'p1fx-rt2@test.local', name: 'FX RT2', passwordHash: 'x' }).returning();
  });
  beforeEach(async () => {
    seq += 1;
    const [company] = await db.insert(companies).values({ name: `FX RT2 Co ${seq}`, ownerId: user.id }).returning();
    const [companyB] = await db.insert(companies).values({ name: `FX RT2 Other ${seq}`, ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    ctxB = { db, companyId: companyB.id, userId: user.id };
    await setupCompany(ctx, acct);
    await setupCompany(ctxB, acctB);
  });
  afterAll(async () => {
    await closeDb();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle. */
    }
  });

  // ---------------------------------------------------------------------------------------------
  // Issue 1 — fxSubledger: aging / HCA from the home amount actually on A/R
  // ---------------------------------------------------------------------------------------------

  it('[1] messy sequence (partial + discount, edit, void, re-pay): A/R == aging after EVERY step; ends at 0', async () => {
    const c = await customer('Messy Payer');
    const inv = await eurInvoice(c.id, '2026-02-01', '1000.01', '1.0733');
    expect(await bal('1200')).toBe('1073.31'); // 1000.01 x 1.0733 = 1073.310733
    await invariants();
    const p1 = await receivePayment(ctx, eurPay(c.id, '2026-02-02', '333.33', '1.0811', [{ invoiceId: inv.id, amountApplied: '333.33', discountAmount: '3.33' }]));
    await invariants();
    const p2 = await receivePayment(ctx, eurPay(c.id, '2026-02-03', '111.11', '1.0911', [{ invoiceId: inv.id, amountApplied: '111.11' }]));
    await invariants();
    await updatePayment(ctx, p1.payment.id, eurPay(c.id, '2026-02-02', '222.22', '1.0999', [{ invoiceId: inv.id, amountApplied: '222.22', discountAmount: '1.11' }]));
    await invariants();
    await voidPayment(ctx, p2.payment.id);
    await invariants();
    // The invoice's home open always equals what A/R carries (it is the only A/R item).
    expect(await invoiceHomeOpen(inv.id)).toBe(await bal('1200'));
    const left = Money.of(await balanceDue(inv.id)).toFixed(2);
    expect(left).toBe('776.68');
    await receivePayment(ctx, eurPay(c.id, '2026-02-05', left, '1.1234', [{ invoiceId: inv.id, amountApplied: left }]));
    expect(await balanceDue(inv.id)).toBe('0.00');
    expect(await bal('1200')).toBe('0.00');
    expect(await invoiceHomeOpen(inv.id)).toBeNull();
    await invariants();
  });

  it('[1] aging AS OF a date between partial payments ties to the A/R balance as of that date', async () => {
    const c = await customer('As Of Payer');
    const inv = await eurInvoice(c.id, '2026-03-01', '100', '1.07');
    await receivePayment(ctx, eurPay(c.id, '2026-03-10', '33.33', '1.09', [{ invoiceId: inv.id, amountApplied: '33.33' }]));
    await receivePayment(ctx, eurPay(c.id, '2026-03-20', '33.33', '1.11', [{ invoiceId: inv.id, amountApplied: '33.33' }]));
    await receivePayment(ctx, eurPay(c.id, '2026-03-30', '20.00', '1.12', [{ invoiceId: inv.id, amountApplied: '20.00' }]));
    for (const day of ['2026-03-05', '2026-03-15', '2026-03-25', '2026-04-05']) {
      expect(await agingTotal(ctx, d(day)), `aging as of ${day}`).toBe(await arAsOf(ctx, d(day)));
    }
    // Receive Payments rule (payments team, merged from main): a part-payment relieves A/R at the invoice's booked rate, round2(paid x rate); the payoff relieves whatever is still open.
    expect(await arAsOf(ctx, d('2026-03-25'))).toBe('35.68'); // 107.00 - 35.66 - 35.66
    await invariants();
  });

  it('[1] Home Currency Adjustment revalues from the home amount on A/R, and the invoice still clears to 0', async () => {
    const c = await customer('HCA Payer');
    const inv = await eurInvoice(c.id, '2026-04-01', '100', '1.07');
    for (const day of ['02', '03']) {
      await receivePayment(ctx, eurPay(c.id, `2026-04-${day}`, '33.33', '1.07', [{ invoiceId: inv.id, amountApplied: '33.33' }]));
    }
    expect(await bal('1200')).toBe('35.68'); // 107.00 - 35.66 - 35.66 (part-payments at the booked rate)
    const preview = await previewHomeCurrencyAdjustment(ctx, { date: d('2026-04-30'), rates: { EUR: '1.20' } });
    const line = preview.lines.find((l) => l.entityId === c.id)!;
    expect(line).toBeTruthy();
    expect(Money.of(line.foreignBalance).toFixed(2)).toBe('33.34');
    expect(Money.of(line.homeBalance).toFixed(2)).toBe('35.68'); // what A/R carries
    expect(Money.of(line.newHomeBalance).toFixed(2)).toBe('40.01');
    expect(Money.of(line.adjustment).toFixed(2)).toBe('4.33');
    await createHomeCurrencyAdjustment(ctx, { date: d('2026-04-30'), rates: { EUR: '1.20' } });
    expect(await arAsOf(ctx, d('2026-04-30'))).toBe('40.01');
    expect(await arAsOf(ctx, d('2026-05-02'))).toBe('35.68'); // reversed the next day
    await invariants();
    await receivePayment(ctx, eurPay(c.id, '2026-05-05', '33.34', '1.20', [{ invoiceId: inv.id, amountApplied: '33.34' }]));
    expect(await bal('1200')).toBe('0.00');
    await invariants();
  });

  // ---------------------------------------------------------------------------------------------
  // Issue 2 — postPayment relief: the finishing payment clears exactly what is on A/R
  // ---------------------------------------------------------------------------------------------

  it('[2] one payment finishing two partly-paid invoices at different rates clears A/R; voiding it restores the exact earlier state', async () => {
    const c = await customer('Two Invoice Payer');
    const a = await eurInvoice(c.id, '2026-05-01', '100', '1.07');
    const b = await eurInvoice(c.id, '2026-05-01', '200.01', '1.1333');
    await receivePayment(ctx, eurPay(c.id, '2026-05-02', '33.33', '1.08', [{ invoiceId: a.id, amountApplied: '33.33' }]));
    await receivePayment(ctx, eurPay(c.id, '2026-05-03', '66.67', '1.09', [{ invoiceId: a.id, amountApplied: '33.33' }, { invoiceId: b.id, amountApplied: '33.34' }]));
    await receivePayment(ctx, eurPay(c.id, '2026-05-04', '66.66', '1.10', [{ invoiceId: b.id, amountApplied: '66.66' }]));
    await invariants();
    const before = await bal('1200');
    const homeA = await invoiceHomeOpen(a.id);
    const homeB = await invoiceHomeOpen(b.id);
    expect(Money.of(homeA!).plus(Money.of(homeB!)).toFixed(2)).toBe(before);
    const fin = await receivePayment(ctx, eurPay(c.id, '2026-05-05', '133.35', '1.1111', [{ invoiceId: a.id, amountApplied: '33.34' }, { invoiceId: b.id, amountApplied: '100.01' }]));
    expect(await balanceDue(a.id)).toBe('0.00');
    expect(await balanceDue(b.id)).toBe('0.00');
    expect(await bal('1200')).toBe('0.00');
    // Its relief rows are exactly the home amounts that were open on each invoice.
    const rows = await reliefRows(fin.payment.id);
    expect(rows.length).toBe(2);
    expect(Money.of(rows.find((r) => r.invoiceId === a.id)!.homeAmount).toFixed(2)).toBe(homeA);
    expect(Money.of(rows.find((r) => r.invoiceId === b.id)!.homeAmount).toFixed(2)).toBe(homeB);
    expect(rows.every((r) => r.companyId === ctx.companyId)).toBe(true);
    await invariants();
    await voidPayment(ctx, fin.payment.id);
    expect(await reliefRows(fin.payment.id)).toEqual([]);
    expect(await bal('1200')).toBe(before);
    expect(await invoiceHomeOpen(a.id)).toBe(homeA);
    expect(await invoiceHomeOpen(b.id)).toBe(homeB);
    await invariants();
  });

  it('[2] voiding EVERY payment of a partly-paid invoice brings A/R back to the invoice amount exactly; no relief rows left', async () => {
    const c = await customer('Void All Payer');
    const inv = await eurInvoice(c.id, '2026-05-10', '100', '1.07');
    const ids: string[] = [];
    for (const [i, amt] of ['33.33', '33.33', '33.34'].entries()) {
      ids.push((await receivePayment(ctx, eurPay(c.id, `2026-05-1${i + 1}`, amt, `1.1${i}`, [{ invoiceId: inv.id, amountApplied: amt }]))).payment.id);
    }
    expect(await bal('1200')).toBe('0.00');
    for (const id of [ids[1], ids[0], ids[2]]) {
      await voidPayment(ctx, id);
      await invariants();
    }
    expect(await bal('1200')).toBe('107.00');
    expect(await balanceDue(inv.id)).toBe('100.00');
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(paymentFxReliefs)
      .where(eq(paymentFxReliefs.invoiceId, inv.id));
    expect(n).toBe(0);
  });

  // ---------------------------------------------------------------------------------------------
  // Issue 3 — applyPayment / unapplyFromInvoice: gain/loss = invoice relief - credit used
  // ---------------------------------------------------------------------------------------------

  it('[3] one credit spread over two invoices in ONE applyPayment call, then unapply all, then void: every plug undone', async () => {
    const c = await customer('Spread Payer');
    const a = await eurInvoice(c.id, '2026-06-01', '33.33', '1.07');
    const b = await eurInvoice(c.id, '2026-06-01', '33.34', '1.0999');
    const startAR = await bal('1200');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-06-02', '100.01', '1.2345', []));
    expect(await bal('1200')).toBe(Money.of(startAR).minus(Money.of('123.46')).toFixed(2)); // 100.01 x 1.2345
    await invariants();
    await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: a.id, amountApplied: '33.33' }, { invoiceId: b.id, amountApplied: '33.34' }] });
    // Left: 33.34 EUR unapplied at 1.2345 = 41.16 credit; both invoices cleared.
    expect(await balanceDue(a.id)).toBe('0.00');
    expect(await balanceDue(b.id)).toBe('0.00');
    expect(await bal('1200')).toBe('-41.16');
    await invariants();
    await unapplyFromInvoice(ctx, { paymentId: payment.id, invoiceId: a.id, amount: '33.33' });
    await invariants();
    await unapplyFromInvoice(ctx, { paymentId: payment.id, invoiceId: b.id, amount: '33.34' });
    // Back to the starting state: both invoices open at their booked home, full credit at 1.2345.
    expect(await bal('1200')).toBe(Money.of(startAR).minus(Money.of('123.46')).toFixed(2));
    await invariants();
    await voidPayment(ctx, payment.id);
    expect(await bal('1200')).toBe(startAR);
    expect(await reliefRows(payment.id)).toEqual([]);
    const live = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(sql`${journalEntries.companyId} = ${ctx.companyId} AND ${journalEntries.sourceRef} = ${`payment:${payment.id}`} AND ${journalEntries.status} = 'posted'`);
    expect(live).toEqual([]);
    await invariants();
  });

  it('[3] applying leftover credit at the SAME rate posts no gain/loss and leaves A/R == aging', async () => {
    const c = await customer('Same Rate Payer');
    const inv = await eurInvoice(c.id, '2026-06-10', '100', '1.2345');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-06-11', '100.00', '1.2345', []));
    const entriesBefore = (await db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))).length;
    for (const amt of ['33.33', '33.33', '33.34']) {
      await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: inv.id, amountApplied: amt }] });
      await invariants();
    }
    expect(await bal('1200')).toBe('0.00');
    expect(await agingTotal(ctx)).toBe('0.00');
    // Same rate: part-payments relieve the invoice at round2(paid x rate) while the credit is used
    // at its telescoped home value, so at most a one-cent rounding plug per apply is posted.
    const after = await db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId));
    expect(after.length - entriesBefore).toBeLessThanOrEqual(3);
    const plugLines = await db
      .select({ debit: journalEntryLines.debit, credit: journalEntryLines.credit })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.sourceRef, `payment:${payment.id}`), sql`${journalEntries.description} LIKE 'FX adjustment%'`));
    for (const l of plugLines) expect(Money.of(l.debit ?? 0).plus(Money.of(l.credit ?? 0)).lessThanOrEqualTo('0.01')).toBe(true);
  });

  it('[3] two partial refunds of a foreign credit keep A/R == aging (credit home value telescoped like apply)', async () => {
    const c = await customer('Refund Payer');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.2345', []));
    expect(await bal('1200')).toBe('-123.45');
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-02') });
    await invariants();
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-03') });
    // 33.34 EUR left at 1.2345 = 41.16 (aging); A/R must carry the same.
    expect(await agingTotal(ctx)).toBe('-41.16');
    expect(await bal('1200')).toBe('-41.16');
    await invariants();
  });

  it('[3] refund part of a credit, then apply the rest to finish a foreign invoice: A/R ends at 0', async () => {
    const c = await customer('Refund Then Apply');
    const inv = await eurInvoice(c.id, '2026-07-10', '66.67', '1.07');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-11', '100.00', '1.2345', []));
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-12') });
    await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: inv.id, amountApplied: '66.67' }] });
    expect(await balanceDue(inv.id)).toBe('0.00');
    expect(await bal('1200')).toBe('0.00');
    await invariants();
  });

  // ---------------------------------------------------------------------------------------------
  // Issue 4 — integrity.ts: Verify Data A/R check in home currency, and not vacuous
  // ---------------------------------------------------------------------------------------------

  it('[4] Verify Data passes on mixed books: home + foreign invoices, partial payments, foreign credit, discount', async () => {
    const c = await customer('Mixed Books');
    const h = await homeInvoice(c.id, '2026-08-01', '250.00');
    const f1 = await eurInvoice(c.id, '2026-08-01', '1000', '1.10');
    const f2 = await eurInvoice(c.id, '2026-08-02', '77.77', '1.1717');
    await receivePayment(ctx, {
      customerId: c.id,
      date: d('2026-08-03'),
      method: 'check',
      amount: '100.00',
      depositAccountId: acct['1050'],
      applications: [{ invoiceId: h.id, amountApplied: '100.00' }],
    } as never);
    await receivePayment(ctx, eurPay(c.id, '2026-08-04', '333.33', '1.12', [{ invoiceId: f1.id, amountApplied: '333.33', discountAmount: '10.00' }]));
    await receivePayment(ctx, eurPay(c.id, '2026-08-05', '50.00', '1.13', [{ invoiceId: f2.id, amountApplied: '20.00' }]));
    await invariants();
  });

  it('[4] Verify Data is not vacuous: a one-cent drift in a relief record or a home invoice is reported', async () => {
    const c = await customer('Drift');
    const inv = await eurInvoice(c.id, '2026-08-10', '100', '1.07');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-08-11', '33.33', '1.07', [{ invoiceId: inv.id, amountApplied: '33.33' }]));
    expect(await failedChecks()).toEqual([]);
    const [row] = await reliefRows(payment.id);
    await db.update(paymentFxReliefs).set({ homeAmount: Money.of(row.homeAmount).plus(Money.of('0.01')).toFixed(2) }).where(eq(paymentFxReliefs.id, row.id));
    expect((await failedChecks()).some((x) => /A\/R|receivable/i.test(x))).toBe(true);
    await db.update(paymentFxReliefs).set({ homeAmount: row.homeAmount }).where(eq(paymentFxReliefs.id, row.id));
    expect(await failedChecks()).toEqual([]);
    const h = await homeInvoice(c.id, '2026-08-12', '10.00');
    await db.update(invoices).set({ balanceDue: '10.01' }).where(eq(invoices.id, h.id));
    expect((await failedChecks()).some((x) => /A\/R|receivable/i.test(x))).toBe(true);
  });

  it('[4] isolation: another company\'s foreign invoices and relief rows never enter this company\'s checks or aging', async () => {
    const cB = await customer('Other Co Customer', ctxB);
    const invB = await eurInvoice(cB.id, '2026-08-20', '500', '1.10', ctxB, acctB);
    await receivePayment(ctxB, eurPay(cB.id, '2026-08-21', '123.45', '1.15', [{ invoiceId: invB.id, amountApplied: '123.45' }], acctB));
    expect(await bal('1200')).toBe('0.00');
    expect(await agingTotal(ctx)).toBe('0.00');
    expect(await foreignOpenReceivables(ctx, FAR)).toEqual([]);
    await invariants();
    await invariants(ctxB, acctB);
  });

  // ---------------------------------------------------------------------------------------------
  // Migration / backup — 0043 section 6, backup.ts
  // ---------------------------------------------------------------------------------------------

  it('[mig] 0043 re-runs cleanly with relief rows present; the new foreign keys are declared and live', async () => {
    const c = await customer('Migration Payer');
    const inv = await eurInvoice(c.id, '2026-09-01', '100', '1.07');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-09-02', '33.33', '1.09', [{ invoiceId: inv.id, amountApplied: '33.33' }]));
    const file = fs.readFileSync(path.resolve(process.cwd(), 'drizzle', '0043_p1_fx.sql'), 'utf8');
    for (const stmt of file.split('--> statement-breakpoint')) {
      if (stmt.replace(/--.*$/gm, '').trim()) await db.execute(sql.raw(stmt));
    }
    expect((await reliefRows(payment.id)).length).toBe(1);
    const gaps = await foreignKeyGaps(async <T,>(text: string) => {
      const r = await db.execute(sql.raw(text));
      return ((r as unknown as { rows: T[] }).rows ?? []) as T[];
    }, MIGRATIONS_FOLDER);
    expect(gaps.filter((g) => JSON.stringify(g).includes('payment_fx_reliefs'))).toEqual([]);
    // FK to invoices / payments is enforced: an orphan relief row is refused.
    await expect(
      db.insert(paymentFxReliefs).values({
        companyId: ctx.companyId,
        paymentId: payment.id,
        invoiceId: '00000000-0000-0000-0000-000000000000',
        date: d('2026-09-02'),
        amount: '1.00',
        homeAmount: '1.00',
      }),
    ).rejects.toThrow();
    await invariants();
  });

  it('[backup] company backup + restore keeps relief records: restored books verify and the last payment clears A/R', async () => {
    const c = await customer('Backup Payer');
    const inv = await eurInvoice(c.id, '2026-09-10', '100', '1.07');
    for (const day of ['11', '12']) {
      await receivePayment(ctx, eurPay(c.id, `2026-09-${day}`, '33.33', '1.07', [{ invoiceId: inv.id, amountApplied: '33.33' }]));
    }
    expect(await bal('1200')).toBe('35.68');
    const backup = await createCompanyBackup(db, ctx.companyId);
    const restored = await restoreCompanyBackup(db, backup.buffer, { ownerId: user.id, name: `FX RT2 Restored ${seq}` });
    expect(restored.tableCounts.paymentFxReliefs).toBe(2);
    const rctx: ServiceContext = { db, companyId: restored.companyId, userId: user.id };
    const rmap: Record<string, string> = {};
    for (const a of await db.select().from(accounts).where(eq(accounts.companyId, rctx.companyId))) rmap[a.code!] = a.id;
    expect(await bal('1200', rmap)).toBe('35.68');
    expect(await agingTotal(rctx)).toBe('35.68');
    expect(await failedChecks(rctx)).toEqual([]);
    const [rinv] = await db.select().from(invoices).where(eq(invoices.companyId, rctx.companyId));
    const [rcust] = await db.select().from(customers).where(eq(customers.companyId, rctx.companyId));
    await receivePayment(rctx, eurPay(rcust.id, '2026-09-13', '33.34', '1.15', [{ invoiceId: rinv.id, amountApplied: '33.34' }], rmap));
    expect(await bal('1200', rmap)).toBe('0.00');
    await invariants(rctx, rmap);
    // The original company is untouched.
    expect(await bal('1200')).toBe('35.68');
  });
});
