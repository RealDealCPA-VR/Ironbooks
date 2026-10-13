/**
 * P1 round, team FX — doer fix round 3: refundPayment uses the same telescoping home value as
 * apply / unapply (homeAt(unapplied before) - homeAt(unapplied after)), so partial refunds of a
 * foreign credit keep A/R equal to the aging and a refund of the remainder clears it exactly.
 * Cross-team edit: lib/services/payments.ts (payments team).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, accounts, customers, invoices, journalEntries, paymentFxReliefs } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance, balanceSheet } from './reports';
import { postJournalEntry } from './posting';
import { upsertCurrency, setBaseCurrency, setAccountCurrency } from './currencies';
import { journalEntryLines } from '@/lib/db/schema';
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

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-fx-fix3');
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
  ['1020', 'Euro Bank', 'asset', 'checking'],
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
  await setAccountCurrency(c, map['1020'], 'EUR');
  await postJournalEntry(c, {
    date: d('2026-01-01'),
    description: 'Opening',
    lines: [
      { accountId: map['1000'], debit: '100000.00' },
      { accountId: map['3000'], credit: '100000.00' },
    ],
  });
}

describe('P1 FX — fix round 3: refundPayment telescopes the credit home value', () => {
  let user: { id: string };
  let seq = 0;
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    [user] = await db.insert(users).values({ email: 'p1fx-fix3@test.local', name: 'FX FIX3', passwordHash: 'x' }).returning();
  });
  beforeEach(async () => {
    seq += 1;
    const [company] = await db.insert(companies).values({ name: `FX FIX3 Co ${seq}`, ownerId: user.id }).returning();
    const [companyB] = await db.insert(companies).values({ name: `FX FIX3 Other ${seq}`, ownerId: user.id }).returning();
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

  it('three partial refunds (33.33 + 33.33 + 33.34) keep A/R == aging after each and clear A/R exactly', async () => {
    const c = await customer('Refund Thrice');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.2345', []));
    expect(await bal('1200')).toBe('-123.45');
    const bankBefore = Money.of(await bal('1000'));
    const expected = ['-82.30', '-41.16', '0.00']; // homeAt(66.67)=82.30, homeAt(33.34)=41.16
    const amounts = ['33.33', '33.33', '33.34'];
    for (let i = 0; i < 3; i++) {
      await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: amounts[i], date: d(`2026-07-0${i + 2}`) });
      expect(await bal('1200')).toBe(expected[i]);
      await invariants();
    }
    // The bank paid out exactly the credit's home value, no more, no less.
    expect(bankBefore.minus(Money.of(await bal('1000'))).toFixed(2)).toBe('123.45');
  });

  it('one refund of the whole remaining credit after a partial apply clears A/R exactly', async () => {
    const c = await customer('Refund Rest');
    const inv = await eurInvoice(c.id, '2026-07-10', '33.33', '1.07');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-11', '100.00', '1.2345', []));
    await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: inv.id, amountApplied: '33.33' }] });
    await invariants();
    await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '66.67', date: d('2026-07-12') });
    expect(await bal('1200')).toBe('0.00');
    await invariants();
  });

  it('a refund paid from a bank in the payment currency records the foreign amount on the bank line', async () => {
    const c = await customer('Euro Refund');
    const { payment } = await receivePayment(ctx, eurPay(c.id, '2026-07-01', '100.00', '1.2345', []));
    const { entry } = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1020'], amount: '33.33', date: d('2026-07-02') });
    const lines = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, entry.id));
    const bankLine = lines.find((l) => l.accountId === acct['1020'])!;
    expect(Money.of(bankLine.credit).toFixed(2)).toBe('41.15'); // 123.45 - homeAt(66.67)=82.30
    expect(Money.of(bankLine.foreignAmount!).toFixed(2)).toBe('33.33');
    expect(bankLine.currency).toBe('EUR');
    await invariants();
  });
});
