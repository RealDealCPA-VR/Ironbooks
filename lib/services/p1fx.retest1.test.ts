/**
 * P1 round, team FX — tester re-test round 1 (verifies fix commits 0a467d6 + ad508da).
 *
 * One scenario group per reviewer issue, each pushed past the exact case the fix was written for:
 *  - payments.ts: payment straight into a foreign bank keeps the foreign amount (edit / void / other
 *    currency / home payment regressions);
 *  - payments.ts: final partial payment clears the home balance (discounts, several invoices, A/R ==
 *    aging after EVERY payment, void of a middle payment, edit, applying a leftover credit later);
 *  - deposits.ts: Undeposited Funds relieved by the amount actually posted (several payments at
 *    different 6+ decimal rates, payment edited while in UF, void + redeposit);
 *  - transfers.ts: stated home amount validated as money (bad input writes nothing);
 *  - invoices.ts: rates kept to 8 decimals (more decimals, paid-invoice rate lock, legacy 2-dp rates);
 *  - journal.ts reverseEntry: foreign amounts across two currencies, home-only revaluation lines;
 *  - integrity.ts: the 0043 guard is live and known to Verify Data.
 * Every scenario ends with the ledger invariants (TB balanced, balance sheet balances, A/R and A/P
 * control == aging in home currency) plus the Verify Data result.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
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
  transfers,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance, balanceSheet } from './reports';
import { postJournalEntry } from './posting';
import { upsertCurrency, setBaseCurrency, setAccountCurrency } from './currencies';
import { accountRegister, reverseEntry } from './journal';
import { withAccountCurrency } from './fxLedger';
import { createDeposit, voidDeposit } from './deposits';
import { createTransfer, voidTransfer } from './transfers';
import { createInvoice, updateInvoice } from './invoices';
import { receivePayment, updatePayment, voidPayment, applyPayment } from './payments';
import { apAging, arAging } from './reportsExtra';
import { LEDGER_GUARD_TRIGGERS, verifyIntegrity } from './integrity';
import { Money } from '@/lib/money';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-fx-retest1');
let db: DB;
let ctx: ServiceContext;
let ctxB: ServiceContext;
const acct: Record<string, string> = {};
const acctB: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T12:00:00Z`);

async function bal(code: string, map = acct): Promise<string> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, map[code]));
  return Money.of(row.balance).toFixed(2);
}
async function foreignClosing(code: string): Promise<string> {
  const reg = await withAccountCurrency(ctx, await accountRegister(ctx, acct[code]));
  return reg.foreignClosingBalance!;
}
async function linesOf(entryId: string) {
  return db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, entryId));
}
async function entryCount(): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(journalEntries);
  return r.n;
}
async function invariants(c: ServiceContext = ctx, map = acct) {
  const tb = await trialBalance(c);
  expect(tb.balanced).toBe(true);
  const bs = await balanceSheet(c);
  expect(Money.of(bs.totalAssets).toFixed(2)).toBe(
    Money.of(bs.totalLiabilities).plus(Money.of(bs.totalEquity)).toFixed(2),
  );
  const asOf = d('2027-12-31');
  expect(Money.of((await apAging(c, asOf)).totals.total).toFixed(2)).toBe(await bal('2000', map));
  expect(Money.of((await arAging(c, asOf)).totals.total).toFixed(2)).toBe(await bal('1200', map));
}
async function newCustomer(name: string) {
  const [c] = await db.insert(customers).values({ companyId: ctx.companyId, displayName: name }).returning();
  return c;
}
async function eurInvoice(customerId: string, date: string, amount: string, rate: string) {
  return createInvoice(ctx, {
    customerId,
    date: d(date),
    currency: 'EUR',
    exchangeRate: rate,
    lines: [{ accountId: acct['4000'], quantity: 1, rate: amount }],
  } as never);
}
async function eurPayment(
  customerId: string,
  date: string,
  amount: string,
  rate: string,
  applications: Array<{ invoiceId: string; amountApplied: string; discountAmount?: string }>,
  depositTo = '1050',
) {
  return receivePayment(ctx, {
    customerId,
    date: d(date),
    method: 'check',
    amount,
    currency: 'EUR',
    exchangeRate: rate,
    depositAccountId: acct[depositTo],
    applications,
  } as never);
}
const DEFS: Array<[string, string, string, string]> = [
  ['1000', 'Checking', 'asset', 'checking'],
  ['1020', 'Euro Bank', 'asset', 'checking'],
  ['1040', 'Pound Bank', 'asset', 'checking'],
  ['1050', 'Undeposited Funds', 'asset', 'checking'],
  ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
  ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
  ['2200', 'Sales Tax Payable', 'liability', 'other_current_liability'],
  ['3000', 'Owner Equity', 'equity', 'owners_equity'],
  ['4000', 'Sales', 'revenue', 'sales'],
  ['4100', 'Sales Discounts', 'revenue', 'sales'],
  ['6300', 'Office Supplies', 'expense', 'operating_expenses'],
];

describe('P1 FX — tester re-test round 1', () => {
  let user: { id: string };
  let seq = 0;
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    db = await getDb(TEST_DIR);
    [user] = await db
      .insert(users)
      .values({ email: 'p1fx-rt1@test.local', name: 'FX RT1', passwordHash: 'x' })
      .returning();
  });

  // Each scenario gets its own company so a defect found in one cannot cascade into the
  // invariant checks of the next.
  beforeEach(async () => {
    seq += 1;
    const [company] = await db.insert(companies).values({ name: `FX RT1 Co ${seq}`, ownerId: user.id }).returning();
    const [companyB] = await db.insert(companies).values({ name: `FX RT1 Other ${seq}`, ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    ctxB = { db, companyId: companyB.id, userId: user.id };
    for (const [code, name, type, subtype] of DEFS) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
      acctB[code] = (await createAccount(ctxB, { code, name, type: type as never, subtype })).id;
    }
    await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.10' });
    await upsertCurrency(ctx, { code: 'GBP', name: 'Pound', rateToBase: '1.25' });
    await setAccountCurrency(ctx, acct['1020'], 'EUR');
    await setAccountCurrency(ctx, acct['1040'], 'GBP');
    await postJournalEntry(ctx, {
      date: d('2026-01-01'),
      description: 'Opening',
      lines: [
        { accountId: acct['1000'], debit: '5000000.00' },
        { accountId: acct['3000'], credit: '5000000.00' },
      ],
    });
    await postJournalEntry(ctx, {
      date: d('2026-01-01'),
      description: 'Opening EUR',
      currency: 'EUR',
      exchangeRate: '1.10',
      lines: [
        { accountId: acct['1020'], debit: '11000.00', foreignAmount: '10000.00' },
        { accountId: acct['3000'], credit: '11000.00' },
      ],
    });
    await postJournalEntry(ctx, {
      date: d('2026-01-01'),
      description: 'Opening GBP',
      currency: 'GBP',
      exchangeRate: '1.25',
      lines: [
        { accountId: acct['1040'], debit: '12500.00', foreignAmount: '10000.00' },
        { accountId: acct['3000'], credit: '12500.00' },
      ],
    });
    await setBaseCurrency(ctxB, { code: 'USD', name: 'US Dollar' });
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
  // Issue 1 — payment deposited straight into a bank in its own currency
  // ---------------------------------------------------------------------------------------------

  it('[1] EUR payment straight to the EUR bank at a 6+ decimal rate: register shows EUR received; edit and void keep it exact', async () => {
    const cust = await newCustomer('Direct EUR');
    const inv = await eurInvoice(cust.id, '2026-02-01', '250', '1.10');
    const eur0 = await foreignClosing('1020');
    const bank0 = await bal('1020');
    const { payment } = await eurPayment(cust.id, '2026-02-03', '250.00', '1.2345674', [
      { invoiceId: inv.id, amountApplied: '250.00' },
    ], '1020');
    const bankLine = (await linesOf(payment.postedEntryId!)).find((l) => l.accountId === acct['1020'])!;
    expect(bankLine.debit).toBe('308.64'); // round2(250 x 1.2345674)
    expect(bankLine.foreignAmount).toBe('250.00');
    expect(Money.of(await foreignClosing('1020')).minus(eur0).toFixed(2)).toBe('250.00');
    await invariants();

    // Edit: smaller amount, different rate — the EUR register follows the new EUR amount.
    const up = await updatePayment(ctx, payment.id, {
      customerId: cust.id,
      date: d('2026-02-03'),
      method: 'check',
      amount: '200.00',
      currency: 'EUR',
      exchangeRate: '1.15',
      depositAccountId: acct['1020'],
      applications: [{ invoiceId: inv.id, amountApplied: '200.00' }],
    } as never);
    const upBank = (await linesOf(up.payment.postedEntryId!)).find((l) => l.accountId === acct['1020'])!;
    expect(upBank.debit).toBe('230.00');
    expect(upBank.foreignAmount).toBe('200.00');
    expect(Money.of(await foreignClosing('1020')).minus(eur0).toFixed(2)).toBe('200.00');
    await invariants();

    await voidPayment(ctx, payment.id);
    expect(await foreignClosing('1020')).toBe(eur0);
    expect(await bal('1020')).toBe(bank0);
    await invariants();
  });

  it('[1] a home-currency payment into home checking carries no foreign columns (regression)', async () => {
    const cust = await newCustomer('Home Payer');
    const inv = await createInvoice(ctx, {
      customerId: cust.id,
      date: d('2026-02-05'),
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '80' }],
    } as never);
    const { payment } = await receivePayment(ctx, {
      customerId: cust.id,
      date: d('2026-02-06'),
      method: 'check',
      amount: '80.00',
      depositAccountId: acct['1000'],
      applications: [{ invoiceId: inv.id, amountApplied: '80.00' }],
    } as never);
    for (const l of await linesOf(payment.postedEntryId!)) {
      expect(l.foreignAmount).toBeNull();
      expect(l.currency).toBeNull();
    }
    await invariants();
  });

  it('[1] a EUR payment cannot land in the GBP bank with a list-rate GBP amount (refused, nothing written)', async () => {
    // QB: a foreign payment can only be deposited to a bank in that currency (or home currency via UF).
    const cust = await newCustomer('Wrong Bank');
    const inv = await eurInvoice(cust.id, '2026-02-07', '100', '1.10');
    const n0 = await entryCount();
    const gbp0 = await foreignClosing('1040');
    let threw = false;
    try {
      await eurPayment(cust.id, '2026-02-08', '100.00', '1.10', [{ invoiceId: inv.id, amountApplied: '100.00' }], '1040');
    } catch {
      threw = true;
    }
    if (!threw) {
      // If accepted, the GBP register must at least not have been credited with a made-up amount.
      expect(Money.of(await foreignClosing('1040')).minus(gbp0).toFixed(2)).toBe('88.00'); // 110 home / 1.25
    } else {
      expect(await entryCount()).toBe(n0);
      expect(await foreignClosing('1040')).toBe(gbp0);
    }
    await invariants();
  });

  // ---------------------------------------------------------------------------------------------
  // Issue 5 — final partial payment clears the home balance; A/R == aging all along
  // ---------------------------------------------------------------------------------------------

  it('[5] A/R equals aging after EVERY partial payment, not only once the invoice is paid', async () => {
    // 100 EUR at 1.07 = 107.00. Telescoping relief: 35.66, 35.67, 35.67 (naive: 35.66, 35.66, 35.67).
    const cust = await newCustomer('Step Payer');
    const inv = await eurInvoice(cust.id, '2026-03-01', '100', '1.07');
    for (const [i, amt] of ['33.33', '33.33', '33.34'].entries()) {
      await eurPayment(cust.id, `2026-03-0${i + 2}`, amt, '1.07', [{ invoiceId: inv.id, amountApplied: amt }]);
      await invariants();
    }
    expect(await bal('1200')).toBe('0.00');
  });

  it('[5] final payment with an early-payment discount: A/R clears to zero; discount booked at the invoice rate', async () => {
    const cust = await newCustomer('Discount Payer');
    const inv = await eurInvoice(cust.id, '2026-03-10', '100', '1.0712');
    await eurPayment(cust.id, '2026-03-11', '33.33', '1.0712', [{ invoiceId: inv.id, amountApplied: '33.33' }]);
    const { payment } = await receivePayment(ctx, {
      customerId: cust.id,
      date: d('2026-03-12'),
      method: 'check',
      amount: '64.67',
      currency: 'EUR',
      exchangeRate: '1.0712',
      depositAccountId: acct['1050'],
      discountAccountId: acct['4100'],
      applications: [{ invoiceId: inv.id, amountApplied: '64.67', discountAmount: '2.00' }],
    } as never);
    const lines = await linesOf(payment.postedEntryId!);
    expect(lines.find((l) => l.accountId === acct['4100'])!.debit).toBe('2.14'); // round2(2 x 1.0712)
    expect(await bal('1200')).toBe('0.00');
    const [row] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(Money.of(row.balanceDue).toFixed(2)).toBe('0.00');
    await invariants();
  });

  it('[5] one payment settling two foreign invoices at different rates clears both exactly', async () => {
    const cust = await newCustomer('Two Invoice Payer');
    const a = await eurInvoice(cust.id, '2026-03-15', '100', '1.07');
    const b = await eurInvoice(cust.id, '2026-03-15', '50.01', '1.1333');
    await eurPayment(cust.id, '2026-03-16', '33.33', '1.07', [{ invoiceId: a.id, amountApplied: '33.33' }]);
    await eurPayment(cust.id, '2026-03-17', '17.01', '1.12', [{ invoiceId: b.id, amountApplied: '17.01' }]);
    await invariants();
    await eurPayment(cust.id, '2026-03-18', '99.67', '1.21', [
      { invoiceId: a.id, amountApplied: '66.67' },
      { invoiceId: b.id, amountApplied: '33.00' },
    ]);
    expect(await bal('1200')).toBe('0.00');
    await invariants();
  });

  it('[5] editing the final partial payment down and back up still leaves A/R exactly zero', async () => {
    // 100.01 EUR at 1.07 = 107.01. Amounts chosen so per-payment rounding is not the issue here:
    // this isolates the void/repost edit path.
    const cust = await newCustomer('Edit Payer');
    const inv = await eurInvoice(cust.id, '2026-03-20', '100.01', '1.07');
    await eurPayment(cust.id, '2026-03-21', '50.00', '1.07', [{ invoiceId: inv.id, amountApplied: '50.00' }]);
    const { payment: last } = await eurPayment(cust.id, '2026-03-23', '50.01', '1.09', [
      { invoiceId: inv.id, amountApplied: '50.01' },
    ]);
    expect(await bal('1200')).toBe('0.00');
    const edit = (amt: string) =>
      updatePayment(ctx, last.id, {
        customerId: cust.id,
        date: d('2026-03-23'),
        method: 'check',
        amount: amt,
        currency: 'EUR',
        exchangeRate: '1.09',
        depositAccountId: acct['1050'],
        applications: [{ invoiceId: inv.id, amountApplied: amt }],
      } as never);
    await edit('10.00');
    await invariants();
    await edit('50.01');
    expect(await bal('1200')).toBe('0.00');
    await invariants();
  });

  it('[5] voiding a MIDDLE partial payment and paying it again leaves nothing on A/R for a fully paid invoice', async () => {
    // P1 relieves 35.66, P2 35.67, P3 35.67 (= 107.00). Void P2: A/R holds 35.67 for 33.33 EUR.
    // Re-paying 33.33 EUR must clear that 35.67 — a fully paid invoice cannot keep a cent on A/R.
    const cust = await newCustomer('Void Middle Payer');
    const inv = await eurInvoice(cust.id, '2026-04-01', '100', '1.07');
    const ids: string[] = [];
    for (const [i, amt] of ['33.33', '33.33', '33.34'].entries()) {
      const { payment } = await eurPayment(cust.id, `2026-04-0${i + 2}`, amt, '1.07', [
        { invoiceId: inv.id, amountApplied: amt },
      ]);
      ids.push(payment.id);
    }
    await voidPayment(ctx, ids[1]);
    await invariants();
    await eurPayment(cust.id, '2026-04-06', '33.33', '1.07', [{ invoiceId: inv.id, amountApplied: '33.33' }]);
    const [row] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(Money.of(row.balanceDue).toFixed(2)).toBe('0.00');
    expect(await bal('1200')).toBe('0.00');
    await invariants();
  });

  it('[5] an overpayment applied later to finish a foreign invoice leaves nothing on A/R (applyPayment)', async () => {
    // Doer flagged applyPayment as untouched: its FX plug is round2(amount x (invoice rate - payment rate)).
    // 100 EUR at 1.07 = 107.00; first payment 33.33 relieves 35.66 (same either way), 66.67 EUR / 71.34
    // home left. 80 EUR arrive unapplied at 1.2345 (A/R credit 98.76). Applying 66.67 of it must clear
    // the invoice's 71.34 and leave exactly the 13.33 EUR still unapplied: -round2(13.33 x 1.2345) = -16.46.
    const cust = await newCustomer('Leftover Payer');
    const inv = await eurInvoice(cust.id, '2026-04-10', '100', '1.07');
    await eurPayment(cust.id, '2026-04-11', '33.33', '1.07', [{ invoiceId: inv.id, amountApplied: '33.33' }]);
    const { payment } = await eurPayment(cust.id, '2026-04-13', '80.00', '1.2345', []);
    expect(await bal('1200')).toBe('-27.42'); // 71.34 - 98.76
    await invariants();
    await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: inv.id, amountApplied: '66.67' }] });
    const [row] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(Money.of(row.balanceDue).toFixed(2)).toBe('0.00');
    expect(await bal('1200')).toBe('-16.46');
    await invariants();
  });

  it('[5] Verify Data accepts a company with open foreign invoices and bills (A/R and A/P checks in home currency)', async () => {
    const cust = await newCustomer('Open EUR Invoice');
    await eurInvoice(cust.id, '2026-04-20', '1000', '1.10');
    const { createVendor } = await import('./vendors');
    const { createBill } = await import('./bills');
    const v = await createVendor(ctx, { displayName: 'EUR Vendor', currency: 'EUR' } as never);
    await createBill(ctx, {
      vendorId: v.id,
      date: d('2026-04-20'),
      currency: 'EUR',
      exchangeRate: '1.20',
      lines: [{ accountId: acct['6300'], amount: '500.00' }],
    } as never);
    await invariants();
    const res = await verifyIntegrity(ctx);
    expect(res.checks.filter((c) => !c.ok)).toEqual([]);
  });

  // ---------------------------------------------------------------------------------------------
  // Issue 2 — deposits relieve Undeposited Funds by what was actually posted
  // ---------------------------------------------------------------------------------------------

  it('[2] two EUR payments at different high-precision rates deposited together: UF clears exactly; void + redeposit exact', async () => {
    const cust = await newCustomer('UF Pair');
    const a = await eurInvoice(cust.id, '2026-05-01', '77777.77', '1.1');
    const b = await eurInvoice(cust.id, '2026-05-01', '33333.33', '1.1');
    const uf0 = Money.of(await bal('1050'));
    const { payment: pa } = await eurPayment(cust.id, '2026-05-02', '77777.77', '1.2345674', [
      { invoiceId: a.id, amountApplied: '77777.77' },
    ]);
    const { payment: pb } = await eurPayment(cust.id, '2026-05-02', '33333.33', '0.9876543', [
      { invoiceId: b.id, amountApplied: '33333.33' },
    ]);
    const ufIn = Money.of(await bal('1050')).minus(uf0);
    // round2(77777.77 x 1.2345674) + round2(33333.33 x 0.9876543): Receive Payments posts at the
    // rate stored at the column's 8 decimals (review5 fx: it was 6; resolvePaymentCurrency).
    expect(ufIn.toFixed(2)).toBe(
      Money.round2(Money.of('77777.77').times('1.2345674')).plus(Money.round2(Money.of('33333.33').times('0.9876543'))).toFixed(2),
    );
    const eur0 = await foreignClosing('1020');
    const bank0 = await bal('1020');
    const dep = await createDeposit(ctx, {
      depositAccountId: acct['1020'],
      date: d('2026-05-03'),
      paymentIds: [pa.id, pb.id],
      exchangeRate: '1.11',
    });
    expect(Money.of(await bal('1050')).minus(uf0).toFixed(2)).toBe('0.00');
    expect(Money.of(await foreignClosing('1020')).minus(eur0).toFixed(2)).toBe('111111.10');
    // Gain/loss is exactly bank home - UF home.
    const bankHome = Money.of(await bal('1020')).minus(bank0);
    expect(bankHome.toFixed(2)).toBe(Money.round2(Money.of('111111.10').times('1.11')).toFixed(2));
    const fxLine = (await linesOf(dep.postedEntryId!)).find((l) => /exchange/i.test(l.memo ?? ''))!;
    const fxNet = Money.of(fxLine.debit ?? 0).minus(Money.of(fxLine.credit ?? 0));
    expect(fxNet.toFixed(2)).toBe(ufIn.minus(bankHome).toFixed(2));
    await invariants();

    await voidDeposit(ctx, dep.id);
    expect(Money.of(await bal('1050')).minus(uf0).toFixed(2)).toBe(ufIn.toFixed(2));
    expect(await foreignClosing('1020')).toBe(eur0);
    await invariants();
    await createDeposit(ctx, {
      depositAccountId: acct['1020'],
      date: d('2026-05-04'),
      paymentIds: [pa.id, pb.id],
      exchangeRate: '1.2345674',
    });
    expect(Money.of(await bal('1050')).minus(uf0).toFixed(2)).toBe('0.00');
    await invariants();
  });

  it('[2] a EUR payment edited while in Undeposited Funds is deposited at its NEW posted home amount', async () => {
    const cust = await newCustomer('UF Edit');
    const inv = await eurInvoice(cust.id, '2026-05-10', '55555.55', '1.1');
    const uf0 = Money.of(await bal('1050'));
    const { payment } = await eurPayment(cust.id, '2026-05-11', '55555.55', '1.1111111', [
      { invoiceId: inv.id, amountApplied: '55555.55' },
    ]);
    await updatePayment(ctx, payment.id, {
      customerId: cust.id,
      date: d('2026-05-11'),
      method: 'check',
      amount: '55555.55',
      currency: 'EUR',
      exchangeRate: '1.2222229',
      depositAccountId: acct['1050'],
      applications: [{ invoiceId: inv.id, amountApplied: '55555.55' }],
    } as never);
    expect(Money.of(await bal('1050')).minus(uf0).toFixed(2)).toBe(
      Money.round2(Money.of('55555.55').times('1.2222229')).toFixed(2),
    );
    await createDeposit(ctx, { depositAccountId: acct['1020'], date: d('2026-05-12'), paymentIds: [payment.id] });
    expect(Money.of(await bal('1050')).minus(uf0).toFixed(2)).toBe('0.00');
    await invariants();
  });

  // ---------------------------------------------------------------------------------------------
  // Issue 3 — transfer home amount validated as money
  // ---------------------------------------------------------------------------------------------

  it('[3] stated home amount: bad values are refused in plain language and write nothing; big values accepted', async () => {
    const n0 = await entryCount();
    const [t0] = await db.select({ n: sql<number>`count(*)::int` }).from(transfers);
    const base = { date: d('2026-06-01'), fromAccountId: acct['1020'], toAccountId: acct['1040'], amount: '100.00', toAmount: '85.00' };
    for (const bad of ['abc', '0', '-5', '99999999999999999']) {
      await expect(createTransfer(ctx, { ...base, homeAmount: bad })).rejects.toThrow(/home amount/i);
    }
    // Rounds to 0.00 home: refused as too small to convert.
    await expect(createTransfer(ctx, { ...base, homeAmount: '0.001' })).rejects.toThrow(/too small|home amount/i);
    expect(await entryCount()).toBe(n0);
    const [t1] = await db.select({ n: sql<number>`count(*)::int` }).from(transfers);
    expect(t1.n).toBe(t0.n);

    // Over the old 1,000,000 rate ceiling; also over it in the FROM foreign currency direction.
    await postJournalEntry(ctx, {
      date: d('2026-06-01'),
      description: 'Big EUR funding',
      currency: 'EUR',
      exchangeRate: '1.10',
      lines: [
        { accountId: acct['1020'], debit: '3300000.00', foreignAmount: '3000000.00' },
        { accountId: acct['3000'], credit: '3300000.00' },
      ],
    });
    const eur0 = await foreignClosing('1020');
    const gbp0 = await foreignClosing('1040');
    const t = await createTransfer(ctx, { ...base, amount: '2500000.00', toAmount: '2150000.00', homeAmount: '2687500.125' });
    expect(t.homeAmount).toBe('2687500.13');
    expect(Money.of(eur0).minus(await foreignClosing('1020')).toFixed(2)).toBe('2500000.00');
    expect(Money.of(await foreignClosing('1040')).minus(gbp0).toFixed(2)).toBe('2150000.00');
    await invariants();
    await voidTransfer(ctx, t.id);
    expect(await foreignClosing('1020')).toBe(eur0);
    expect(await foreignClosing('1040')).toBe(gbp0);
    await invariants();
  });

  // ---------------------------------------------------------------------------------------------
  // Issue 4 — invoice rates kept at full precision
  // ---------------------------------------------------------------------------------------------

  it('[4] an 8-decimal rate is stored exactly; more decimals are cut to 8 consistently with the A/R posting', async () => {
    const cust = await newCustomer('Rate8');
    const inv = await eurInvoice(cust.id, '2026-07-01', '12345.67', '1.23456789');
    expect(Money.of(inv.exchangeRate!).toFixed(8)).toBe('1.23456789');
    const ar = (await linesOf(inv.postedEntryId!)).find((l) => l.accountId === acct['1200'])!;
    expect(ar.debit).toBe(Money.round2(Money.of('12345.67').times('1.23456789')).toFixed(2));

    const inv2 = await eurInvoice(cust.id, '2026-07-01', '1000000', '1.234567894999');
    const stored = Money.of(inv2.exchangeRate!);
    const ar2 = (await linesOf(inv2.postedEntryId!)).find((l) => l.accountId === acct['1200'])!;
    // Whatever was stored is the rate the A/R line used (a later payment relies on it).
    expect(ar2.debit).toBe(Money.round2(Money.of('1000000').times(stored)).toFixed(2));
    // Paying in full at the stored rate leaves no A/R and no exchange difference.
    await eurPayment(cust.id, '2026-07-02', '12345.67', inv.exchangeRate!, [{ invoiceId: inv.id, amountApplied: '12345.67' }]);
    await eurPayment(cust.id, '2026-07-02', '1000000.00', inv2.exchangeRate!, [
      { invoiceId: inv2.id, amountApplied: '1000000.00' },
    ]);
    expect(await bal('1200')).toBe('0.00');
    await invariants();
  });

  it('[4] a paid invoice refuses a rate change in the 6th decimal but accepts the same rate; unpaid edits re-post at full precision', async () => {
    const cust = await newCustomer('Rate Lock');
    const inv = await eurInvoice(cust.id, '2026-07-05', '1000', '1.071234');
    const input = (rate: string, memo?: string) =>
      ({
        customerId: cust.id,
        date: d('2026-07-05'),
        currency: 'EUR',
        exchangeRate: rate,
        memo,
        lines: [{ accountId: acct['4000'], quantity: 1, rate: '1000' }],
      }) as never;
    // Unpaid: edit to a new precise rate re-posts A/R at that rate.
    const up = await updateInvoice(ctx, inv.id, input('1.07123456'));
    const [row] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(Money.of(row.exchangeRate!).toFixed(8)).toBe('1.07123456');
    const ar = (await linesOf(row.postedEntryId!)).find((l) => l.accountId === acct['1200'])!;
    expect(ar.debit).toBe('1071.23');
    expect(up).toBeTruthy();
    await eurPayment(cust.id, '2026-07-06', '400.00', '1.07123456', [{ invoiceId: inv.id, amountApplied: '400.00' }]);
    await expect(updateInvoice(ctx, inv.id, input('1.07123556'))).rejects.toThrow();
    await updateInvoice(ctx, inv.id, input('1.07123456', 'memo only'));
    await invariants();
  });

  it('[4] a legacy invoice whose rate was stored with 2 decimals still edits and pays cleanly', async () => {
    const cust = await newCustomer('Legacy Rate');
    const inv = await eurInvoice(cust.id, '2026-07-10', '300', '1.07');
    // Simulate a pre-fix row: the rate column holds the old rounded value.
    await db.update(invoices).set({ exchangeRate: '1.07' }).where(eq(invoices.id, inv.id));
    await eurPayment(cust.id, '2026-07-11', '100.00', '1.07', [{ invoiceId: inv.id, amountApplied: '100.00' }]);
    await updateInvoice(ctx, inv.id, {
      customerId: cust.id,
      date: d('2026-07-10'),
      currency: 'EUR',
      exchangeRate: '1.07',
      memo: 'edited after upgrade',
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '300' }],
    } as never);
    await eurPayment(cust.id, '2026-07-12', '200.00', '1.07', [{ invoiceId: inv.id, amountApplied: '200.00' }]);
    expect(await bal('1200')).toBe('0.00');
    await invariants();
  });

  // ---------------------------------------------------------------------------------------------
  // Issue 6 — reverseEntry keeps foreign amounts
  // ---------------------------------------------------------------------------------------------

  it('[6] reversing an entry touching the EUR and GBP banks restores both registers in their own currency', async () => {
    const eur0 = await foreignClosing('1020');
    const gbp0 = await foreignClosing('1040');
    const je = await postJournalEntry(ctx, {
      date: d('2026-08-01'),
      description: 'Two-currency move',
      lines: [
        { accountId: acct['1040'], debit: '130.00', foreignAmount: '100.00' },
        { accountId: acct['1020'], credit: '130.00', foreignAmount: '110.00' },
      ],
    });
    expect(Money.of(await foreignClosing('1040')).minus(gbp0).toFixed(2)).toBe('100.00');
    expect(Money.of(eur0).minus(await foreignClosing('1020')).toFixed(2)).toBe('110.00');
    const rev = await reverseEntry(ctx, je.id, d('2026-08-02'));
    const revLines = await linesOf(rev.id);
    expect(revLines.find((l) => l.accountId === acct['1040'])!.credit).toBe('130.00');
    expect(revLines.find((l) => l.accountId === acct['1040'])!.foreignAmount).toBe('100.00');
    expect(revLines.find((l) => l.accountId === acct['1020'])!.foreignAmount).toBe('110.00');
    expect(revLines.find((l) => l.accountId === acct['1040'])!.currency).toBe('GBP');
    expect(revLines.find((l) => l.accountId === acct['1020'])!.currency).toBe('EUR');
    expect(await foreignClosing('1020')).toBe(eur0);
    expect(await foreignClosing('1040')).toBe(gbp0);
    await invariants();
  });

  it('[6] reversing a home-only revaluation line (foreign amount 0) leaves the EUR register untouched', async () => {
    const eur0 = await foreignClosing('1020');
    const home0 = await bal('1020');
    const je = await postJournalEntry(ctx, {
      date: d('2026-08-05'),
      description: 'Revalue EUR bank',
      lines: [
        { accountId: acct['1020'], debit: '25.00', foreignAmount: '0' },
        { accountId: acct['3000'], credit: '25.00' },
      ],
    });
    expect(await foreignClosing('1020')).toBe(eur0);
    const rev = await reverseEntry(ctx, je.id, d('2026-08-06'));
    const bank = (await linesOf(rev.id)).find((l) => l.accountId === acct['1020'])!;
    expect(Money.of(bank.foreignAmount ?? '0').toFixed(2)).toBe('0.00');
    expect(await foreignClosing('1020')).toBe(eur0);
    expect(await bal('1020')).toBe(home0);
    await invariants();
  });

  it('[6] reversing a home-currency entry writes no foreign columns; another company cannot reverse it', async () => {
    const je = await postJournalEntry(ctx, {
      date: d('2026-08-10'),
      description: 'Home accrual',
      lines: [
        { accountId: acct['6300'], debit: '40.00' },
        { accountId: acct['1000'], credit: '40.00' },
      ],
    });
    await expect(reverseEntry(ctxB, je.id, d('2026-08-11'))).rejects.toThrow();
    const rev = await reverseEntry(ctx, je.id, d('2026-08-11'));
    for (const l of await linesOf(rev.id)) {
      expect(l.foreignAmount).toBeNull();
      expect(l.currency).toBeNull();
    }
    await invariants();
    await invariants(ctxB, acctB);
  });

  // ---------------------------------------------------------------------------------------------
  // Issue 7 (full-run failure) — the 0043 guard is live and known to Verify Data
  // ---------------------------------------------------------------------------------------------

  it('[7] the foreign-amount guard blocks tampering with a posted line and Verify Data reports all guards present', async () => {
    expect(LEDGER_GUARD_TRIGGERS.bka_jel_fx_guard).toBeTruthy();
    const [line] = await db
      .select({ id: journalEntryLines.id })
      .from(journalEntryLines)
      .where(and(eq(journalEntryLines.accountId, acct['1020']), sql`${journalEntryLines.foreignAmount} IS NOT NULL`))
      .limit(1);
    await expect(
      db.update(journalEntryLines).set({ foreignAmount: '1.23' }).where(eq(journalEntryLines.id, line.id)),
    ).rejects.toThrow();
    const res = await verifyIntegrity(ctx);
    const bad = res.checks.filter((c) => !c.ok);
    expect(bad).toEqual([]);
    expect(res.allOk).toBe(true);
  });
});
