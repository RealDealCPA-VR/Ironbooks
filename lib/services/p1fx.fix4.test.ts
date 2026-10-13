/**
 * P1 round, team FX — doer fix round 4.
 *  - Voiding a refund of a foreign payment's credit (any refund, not only the newest, and after
 *    applies / unapplies) keeps A/R equal to the aging: restoreRefundedCustomerCredit posts the
 *    cent-level difference between the reversed refund and the change in the credit's home value
 *    to A/R against Exchange Gain/Loss (sourceRef payment:<id>, voided with the payment).
 *  - Customer Balance Detail shows the refund row of a foreign credit in its currency.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
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
import { customerBalanceDetail } from './reportsLists';
import { Money } from '@/lib/money';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-fx-fix4');
let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T12:00:00Z`);
const FAR = d('2027-12-31');

async function bal(code: string): Promise<string> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, acct[code]));
  return Money.of(row.balance).toFixed(2);
}
async function agingTotal(asOf = FAR): Promise<string> {
  return Money.of((await arAging(ctx, asOf)).totals.total).toFixed(2);
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
function homePay(customerId: string, date: string, amount: string) {
  return {
    customerId,
    date: d(date),
    method: 'check',
    amount,
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

describe('P1 FX — fix round 4: voiding foreign refunds, refund rows in balance detail', () => {
  let seq = 0;
  let userId: string;
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'p1fx-fix4@test.local', name: 'FX F4', passwordHash: 'x' }).returning();
    userId = u.id;
  });
  beforeEach(async () => {
    seq += 1;
    const [company] = await db.insert(companies).values({ name: `FX F4 Co ${seq}`, ownerId: userId }).returning();
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

  it('voiding an older refund posts a 1-cent A/R plug so A/R == aging; the remainder still clears A/R', async () => {
    const c = await customer('Older');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.2345'));
    const r1 = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-02') });
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-03') });
    const checkingBefore = await bal('1000');
    await voidJournalEntry(ctx, r1.entry.id);
    expect(await unappliedOf(payment.id)).toBe('66.67');
    expect(await bal('1200')).toBe('-82.30');
    // The bank gets back exactly what the voided refund paid out.
    expect(Money.of(await bal('1000')).minus(Money.of(checkingBefore)).toFixed(2)).toBe('41.15');
    const p = await plugs(payment.id);
    expect(p).toHaveLength(1);
    // Fix round 5: the cent belongs to the surviving later refund (07-03), not the voided one's date.
    expect(p[0].date.toISOString().slice(0, 10)).toBe('2026-07-03');
    await invariants();
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '66.67', date: d('2026-07-04') });
    expect(await bal('1200')).toBe('0.00');
    await invariants();
  });

  it('voiding the newest refund posts no plug', async () => {
    const c = await customer('Newest');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.2345'));
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-02') });
    const r2 = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-03') });
    await voidJournalEntry(ctx, r2.entry.id);
    expect(await plugs(payment.id)).toHaveLength(0);
    expect(await bal('1200')).toBe('-82.30');
    await invariants();
  });

  it('every void order of three refunds keeps A/R == aging and ends with the full credit restored', async () => {
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    for (const order of orders) {
      const c = await customer(`Order ${order.join('')}`);
      const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.23456789'));
      const refunds = [];
      for (let i = 0; i < 3; i++) {
        refunds.push(
          await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d(`2026-07-0${i + 2}`) }),
        );
      }
      for (const i of order) {
        await voidJournalEntry(ctx, refunds[i].entry.id);
        expect(await agingTotal()).toBe(await bal('1200'));
      }
      expect(await unappliedOf(payment.id)).toBe('100.00');
      await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '100.00', date: d('2026-07-09') });
      expect(await unappliedOf(payment.id)).toBe('0.00');
      expect(await bal('1200')).toBe('0.00');
    }
    await invariants();
  });

  it('refund, apply, void the refund, then unapply: A/R == aging', async () => {
    const c = await customer('Apply');
    const inv = await createInvoice(ctx, {
      customerId: c.id,
      date: d('2026-07-01'),
      currency: 'EUR',
      exchangeRate: '1.2345',
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '33.33' }],
    } as never);
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-02', '100.00', '1.2345'));
    const r1 = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-03') });
    await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: inv.id, amountApplied: '33.33' }] });
    await voidJournalEntry(ctx, r1.entry.id);
    expect(await unappliedOf(payment.id)).toBe('66.67');
    await invariants();
    await unapplyFromInvoice(ctx, { paymentId: payment.id, invoiceId: inv.id } as never);
    await invariants();
  });

  it('voiding the payment afterwards also voids the refund-void plug: A/R and Exchange Gain/Loss back to 0', async () => {
    const c = await customer('Void Payment');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.2345'));
    const r1 = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-02') });
    const r2 = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-03') });
    await voidJournalEntry(ctx, r1.entry.id);
    await voidJournalEntry(ctx, r2.entry.id);
    expect((await plugs(payment.id)).length).toBeGreaterThan(0);
    await voidPayment(ctx, payment.id);
    expect(await plugs(payment.id)).toHaveLength(0);
    expect(await bal('1200')).toBe('0.00');
    const [fx] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '6900')));
    expect(Money.of(fx.balance).toFixed(2)).toBe('0.00');
    await invariants();
  });

  it('home-currency payment: voiding an older refund posts no plug (unchanged behaviour)', async () => {
    const c = await customer('Home');
    const { payment } = await receivePayment(ctx, homePay(c.id, '2026-07-01', '100.00'));
    const r1 = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-02') });
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-03') });
    await voidJournalEntry(ctx, r1.entry.id);
    expect(await plugs(payment.id)).toHaveLength(0);
    expect(await bal('1200')).toBe('-66.67');
    await invariants();
  });

  it('Customer Balance Detail: refund rows of a EUR credit show EUR and the refunded amount; home refunds show none', async () => {
    const c = await customer('Detail');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.2345'));
    const a = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '33.33', date: d('2026-07-02') });
    const b = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1020'], amount: '10.00', date: d('2026-07-03') });
    const h = await customer('Detail Home');
    const { payment: hp } = await receivePayment(ctx, homePay(h.id, '2026-07-01', '50.00'));
    const hr = await refundPayment(ctx, { paymentId: hp.id, bankAccountId: acct['1000'], amount: '20.00', date: d('2026-07-02') });
    const rep = await customerBalanceDetail(ctx, { asOf: '2027-12-31' } as never);
    const row = (id: string) => rep.rows.find((r) => r.kind === 'data' && r.entryId === id)!;
    expect(row(a.entry.id).cells.currency).toBe('EUR');
    expect(Money.of(String(row(a.entry.id).cells.foreignAmount)).toFixed(2)).toBe('33.33');
    expect(row(b.entry.id).cells.currency).toBe('EUR');
    expect(Money.of(String(row(b.entry.id).cells.foreignAmount)).toFixed(2)).toBe('10.00');
    expect(row(hr.entry.id).cells.currency ?? '').toBe('');
  });
});
