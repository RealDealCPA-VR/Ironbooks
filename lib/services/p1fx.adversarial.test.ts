/**
 * P1 round, team FX — independent adversarial QA (tester).
 *
 * Each scenario checks a QuickBooks multi-currency behaviour the doer's own tests do not cover,
 * and ends with the ledger invariants: TB balanced, balance sheet balances, A/R and A/P control
 * accounts equal their aging totals (home currency). Foreign bank / card registers must always
 * be expressible in the account's own currency: what the bank statement shows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, lte, sql } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  accounts,
  customers,
  bankTransactions,
  journalEntries,
  journalEntryLines,
  homeCurrencyAdjustments,
  loanPayments,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance, balanceSheet } from './reports';
import { postJournalEntry } from './posting';
import { upsertCurrency, setBaseCurrency, setAccountCurrency } from './currencies';
import { createBankAccount } from './bankAccounts';
import { categorize, matchTransaction, suggestMatches, unmatch } from './bankCategorize';
import { importTransactions } from './import';
import { accountRegister } from './journal';
import { withAccountCurrency } from './fxLedger';
import {
  startReconciliation,
  listClearable,
  toggleCleared,
  completeReconciliation,
  getProgress,
  getReconcileInfo,
  payCreditCardBalance,
} from './reconcile';
import { createDeposit, voidDeposit, listUndepositedPayments } from './deposits';
import { createTransfer, updateTransfer, voidTransfer } from './transfers';
import { createVendor } from './vendors';
import { createBill } from './bills';
import {
  createVendorCredit,
  updateVendorCredit,
  applyToBill,
  unapplyFromBill,
  voidVendorCredit,
  getVendorCredit,
} from './vendorCredits';
import { createLoan, getLoan, setUpLoanPayment } from './loans';
import { createInvoice } from './invoices';
import { receivePayment } from './payments';
import { apAging, apAgingDetail, arAging } from './reportsExtra';
import { vendorBalanceDetail } from './reportsLists';
import {
  previewHomeCurrencyAdjustment,
  createHomeCurrencyAdjustment,
  voidHomeCurrencyAdjustment,
} from './homeCurrencyAdjustment';
import { setClosingDate } from './company';
import { Money } from '@/lib/money';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-fx-adversarial');
let db: DB;
let ctx: ServiceContext;
let ctxB: ServiceContext;
const acct: Record<string, string> = {};
const acctB: Record<string, string> = {};
let eurBankId = '';
let eurCardBankId = '';

const d = (s: string) => new Date(`${s}T12:00:00Z`);

async function bal(code: string, c: Record<string, string> = acct): Promise<string> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, c[code]));
  return Money.of(row.balance).toFixed(2);
}

async function balAsOf(code: string, asOf: Date, c: ServiceContext = ctx, map = acct): Promise<string> {
  const [row] = await db
    .select({
      d: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`,
      c: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(journalEntryLines.accountId, map[code]),
        eq(journalEntries.companyId, c.companyId),
        eq(journalEntries.status, 'posted'),
        lte(journalEntries.date, asOf),
      ),
    );
  const net = Money.of(row.d).minus(Money.of(row.c));
  return (code.startsWith('1') ? net : net.negated()).toFixed(2);
}

async function invariants(asOf = d('2027-12-31'), c: ServiceContext = ctx, map = acct) {
  const tb = await trialBalance(c);
  expect(tb.balanced).toBe(true);
  const bs = await balanceSheet(c);
  expect(Money.of(bs.totalAssets).toFixed(2)).toBe(
    Money.of(bs.totalLiabilities).plus(Money.of(bs.totalEquity)).toFixed(2),
  );
  const ap = await apAging(c, asOf);
  expect(Money.of(ap.totals.total).toFixed(2)).toBe(await balAsOf('2000', asOf, c, map));
  const ar = await arAging(c, asOf);
  expect(Money.of(ar.totals.total).toFixed(2)).toBe(await balAsOf('1200', asOf, c, map));
}

async function linesOf(entryId: string) {
  return db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, entryId));
}

async function foreignClosing(code: string): Promise<string> {
  const reg = await withAccountCurrency(ctx, await accountRegister(ctx, acct[code]));
  return reg.foreignClosingBalance!;
}

async function stageFeed(bankAccountId: string, date: string, amount: string, description: string) {
  const [row] = await db
    .insert(bankTransactions)
    .values({ companyId: ctx.companyId, bankAccountId, date: d(date), description, amount, matched: false })
    .returning();
  return row;
}

async function newCustomer(name: string) {
  const [c] = await db.insert(customers).values({ companyId: ctx.companyId, displayName: name }).returning();
  return c;
}

const DEFS: Array<[string, string, string, string]> = [
  ['1000', 'Checking', 'asset', 'checking'],
  ['1020', 'Euro Bank', 'asset', 'checking'],
  ['1030', 'Euro Savings', 'asset', 'savings'],
  ['1040', 'Pound Bank', 'asset', 'checking'],
  ['1050', 'Undeposited Funds', 'asset', 'checking'],
  ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
  ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
  ['2200', 'Sales Tax Payable', 'liability', 'other_current_liability'],
  ['2150', 'Euro Card', 'liability', 'credit_card'],
  ['2600', 'Euro Loan', 'liability', 'long_term_liability'],
  ['3000', "Owner's Equity", 'equity', 'owners_equity'],
  ['4000', 'Sales', 'revenue', 'sales'],
  ['4900', 'Other Income', 'revenue', 'other_income'],
  ['6100', 'Bank Fees', 'expense', 'operating_expenses'],
  ['6300', 'Office Supplies', 'expense', 'operating_expenses'],
  ['6800', 'Interest Expense', 'expense', 'operating_expenses'],
];

describe('P1 FX — adversarial QA', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'p1fx-adv@test.local', name: 'FX QA', passwordHash: 'x' })
      .returning();
    const [company] = await db.insert(companies).values({ name: 'FX QA Co', ownerId: user.id }).returning();
    const [companyB] = await db.insert(companies).values({ name: 'Other Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    ctxB = { db, companyId: companyB.id, userId: user.id };
    for (const [code, name, type, subtype] of DEFS) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    }
    for (const [code, name, type, subtype] of DEFS) {
      acctB[code] = (await createAccount(ctxB, { code, name, type: type as never, subtype })).id;
    }
    await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.10' });
    await upsertCurrency(ctx, { code: 'GBP', name: 'Pound', rateToBase: '1.25' });
    await setAccountCurrency(ctx, acct['1020'], 'EUR');
    await setAccountCurrency(ctx, acct['1030'], 'EUR');
    await setAccountCurrency(ctx, acct['1040'], 'GBP');
    await setAccountCurrency(ctx, acct['2150'], 'EUR');
    eurBankId = (await createBankAccount(ctx, { accountId: acct['1020'], bankName: 'Euro Bank', accountNumber: '901' })).id;
    eurCardBankId = (await createBankAccount(ctx, { accountId: acct['2150'], bankName: 'Euro Card', accountNumber: '902' })).id;
    await postJournalEntry(ctx, {
      date: d('2026-01-01'),
      description: 'Opening funds',
      lines: [
        { accountId: acct['1000'], debit: '50000.00' },
        { accountId: acct['3000'], credit: '50000.00' },
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
    // Company B: its own home currency (EUR) and a USD account, nothing foreign posted.
    await setBaseCurrency(ctxB, { code: 'EUR', name: 'Euro' });
    await upsertCurrency(ctxB, { code: 'USD', name: 'US Dollar', rateToBase: '0.50' });
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
  // Validation edges
  // ---------------------------------------------------------------------------------------------

  it('rejects nonsense rates and negative foreign amounts without writing anything', async () => {
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(journalEntries);
    const fee = await stageFeed(eurBankId, '2026-01-05', '-10.00', 'Fee');
    for (const bad of ['0', '-1.1', 'abc']) {
      await expect(
        categorize(ctx, { bankTransactionId: fee.id, accountId: acct['6100'], exchangeRate: bad }),
      ).rejects.toThrow();
    }
    await expect(
      postJournalEntry(ctx, {
        date: d('2026-01-05'),
        description: 'neg foreign',
        lines: [
          { accountId: acct['1020'], debit: '10.00', foreignAmount: '-9.00' },
          { accountId: acct['3000'], credit: '10.00' },
        ],
      }),
    ).rejects.toThrow(/negative/);
    const after = await db.select({ n: sql<number>`count(*)::int` }).from(journalEntries);
    expect(after[0].n).toBe(before[0].n);
    const [row] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, fee.id));
    expect(row.matched).toBe(false);
    // Clean up: categorize properly so the staging row doesn't linger.
    await categorize(ctx, { bankTransactionId: fee.id, accountId: acct['6100'] });
    await invariants();
  });

  // ---------------------------------------------------------------------------------------------
  // Bank feeds
  // ---------------------------------------------------------------------------------------------

  it('undoing a categorized EUR feed line restores the EUR register exactly; a home-value lookalike does not match', async () => {
    const eurBefore = await foreignClosing('1020');
    const homeBefore = await bal('1020');
    const t = await stageFeed(eurBankId, '2026-01-06', '333.33', 'Odd wire');
    const r = await categorize(ctx, { bankTransactionId: t.id, accountId: acct['4900'], exchangeRate: '1.0712' });
    const bankLine = (await linesOf(r.entry.id)).find((l) => l.accountId === acct['1020'])!;
    expect(bankLine.foreignAmount).toBe('333.33');
    expect(bankLine.debit).toBe('357.06'); // round2(333.33 x 1.0712)
    expect(Money.of(await foreignClosing('1020')).minus(eurBefore).toFixed(2)).toBe('333.33');
    await unmatch(ctx, t.id);
    expect(await foreignClosing('1020')).toBe(eurBefore);
    expect(await bal('1020')).toBe(homeBefore);

    // A EUR feed line of 357.06 (= the HOME value of the entry) must not be offered/accepted.
    const r2 = await categorize(ctx, { bankTransactionId: t.id, accountId: acct['4900'], exchangeRate: '1.0712' });
    const look = await stageFeed(eurBankId, '2026-01-07', '357.06', 'Lookalike');
    const cands = await suggestMatches(ctx, look.id);
    expect(cands.map((c) => c.entryId)).not.toContain(r2.entry.id);
    await expect(matchTransaction(ctx, look.id, r2.entry.id)).rejects.toThrow();
    await categorize(ctx, { bankTransactionId: look.id, accountId: acct['4900'] });
    await invariants();
  });

  it('CSV import into a EUR account stages EUR amounts that post at the list rate', async () => {
    const csv = 'Date,Description,Amount\n2026-01-08,Card refund,25.00\n';
    const res = await importTransactions(ctx, { bankAccountId: eurBankId, fileType: 'csv', content: csv, csvMapping: { dateCol: 'Date', descriptionCol: 'Description', amountCol: 'Amount' } } as never);
    expect(res.imported).toBe(1);
    const [row] = await db
      .select()
      .from(bankTransactions)
      .where(and(eq(bankTransactions.bankAccountId, eurBankId), eq(bankTransactions.description, 'Card refund')));
    const r = await categorize(ctx, { bankTransactionId: row.id, accountId: acct['4900'] });
    const bankLine = (await linesOf(r.entry.id)).find((l) => l.accountId === acct['1020'])!;
    expect(bankLine.foreignAmount).toBe('25.00');
    expect(bankLine.debit).toBe('27.50');
    await invariants();
  });

  // ---------------------------------------------------------------------------------------------
  // Customer payments straight into a foreign bank (helpers consumed by Receive Payments)
  // ---------------------------------------------------------------------------------------------

  it('[payments.ts + fxLines] a EUR payment deposited straight to the EUR bank shows the EUR amount received in the register', async () => {
    // List rate is 1.10; the payment is received at 1.20. The bank statement shows 100.00 EUR.
    const cust = await newCustomer('Direct Deposit Client');
    const inv = await createInvoice(ctx, {
      customerId: cust.id,
      date: d('2026-02-01'),
      currency: 'EUR',
      exchangeRate: '1.10',
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '100' }],
    } as never);
    const eurBefore = await foreignClosing('1020');
    const { payment } = await receivePayment(ctx, {
      customerId: cust.id,
      date: d('2026-02-05'),
      method: 'check',
      amount: '100.00',
      currency: 'EUR',
      exchangeRate: '1.20',
      depositAccountId: acct['1020'],
      applications: [{ invoiceId: inv.id, amountApplied: '100.00' }],
    } as never);
    const bankLine = (await linesOf(payment.postedEntryId!)).find((l) => l.accountId === acct['1020'])!;
    expect(bankLine.debit).toBe('120.00');
    expect(bankLine.foreignAmount).toBe('100.00');
    expect(Money.of(await foreignClosing('1020')).minus(eurBefore).toFixed(2)).toBe('100.00');
    await invariants();
  });

  it('depositing a EUR payment clears exactly what Undeposited Funds received (high-precision rate)', async () => {
    const cust = await newCustomer('Precise Client');
    const inv = await createInvoice(ctx, {
      customerId: cust.id,
      date: d('2026-03-01'),
      currency: 'EUR',
      exchangeRate: '1.2345674',
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '100000' }],
    } as never);
    const ufBefore = Money.of(await bal('1050'));
    const { payment } = await receivePayment(ctx, {
      customerId: cust.id,
      date: d('2026-03-02'),
      method: 'check',
      amount: '100000.00',
      currency: 'EUR',
      exchangeRate: '1.2345674',
      depositAccountId: acct['1050'],
      applications: [{ invoiceId: inv.id, amountApplied: '100000.00' }],
    } as never);
    const ufIn = Money.of(await bal('1050')).minus(ufBefore);
    // Receive Payments stores the settlement rate at the column's 6 decimals (1.234567) and posts
    // at exactly that rate (payments team, resolvePaymentCurrency).
    expect(ufIn.toFixed(2)).toBe('123456.70');
    await createDeposit(ctx, { depositAccountId: acct['1020'], date: d('2026-03-03'), paymentIds: [payment.id], exchangeRate: '1.2345674' });
    // Same rate on both sides: UF back to where it was, no exchange gain/loss.
    expect(Money.of(await bal('1050')).minus(ufBefore).toFixed(2)).toBe('0.00');
    await invariants();
  });

  // ---------------------------------------------------------------------------------------------
  // Deposits
  // ---------------------------------------------------------------------------------------------

  it('voiding a foreign deposit puts the payments back in Undeposited Funds and removes the gain', async () => {
    const cust = await newCustomer('Void Deposit Client');
    const inv = await createInvoice(ctx, {
      customerId: cust.id,
      date: d('2026-03-10'),
      currency: 'EUR',
      exchangeRate: '1.10',
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '250' }],
    } as never);
    const { payment } = await receivePayment(ctx, {
      customerId: cust.id,
      date: d('2026-03-11'),
      method: 'check',
      amount: '250.00',
      currency: 'EUR',
      exchangeRate: '1.10',
      depositAccountId: acct['1050'],
      applications: [{ invoiceId: inv.id, amountApplied: '250.00' }],
    } as never);
    const uf0 = await bal('1050');
    const bank0 = await bal('1020');
    const eur0 = await foreignClosing('1020');
    // Mixed currencies in one deposit are refused (GBP bank).
    await expect(
      createDeposit(ctx, { depositAccountId: acct['1040'], date: d('2026-03-12'), paymentIds: [payment.id] }),
    ).rejects.toThrow();
    const dep = await createDeposit(ctx, {
      depositAccountId: acct['1020'],
      date: d('2026-03-12'),
      paymentIds: [payment.id],
      exchangeRate: '1.0712',
    });
    expect(dep.homeTotal).toBe('267.80');
    // 275.00 left UF, 267.80 hit the bank: 7.20 realized loss.
    const loss = (await linesOf(dep.postedEntryId!)).find((l) => l.memo === 'Realized exchange loss');
    expect(loss?.debit).toBe('7.20');
    expect(Money.of(await foreignClosing('1020')).minus(eur0).toFixed(2)).toBe('250.00');
    await invariants();
    await voidDeposit(ctx, dep.id);
    expect(await bal('1050')).toBe(uf0);
    expect(await bal('1020')).toBe(bank0);
    expect(await foreignClosing('1020')).toBe(eur0);
    expect((await listUndepositedPayments(ctx)).some((p) => p.id === payment.id)).toBe(true);
    await invariants();
  });

  // ---------------------------------------------------------------------------------------------
  // Transfers
  // ---------------------------------------------------------------------------------------------

  it('EUR -> GBP transfer: each register moves in its own currency; edit and void keep them exact', async () => {
    const eur0 = await foreignClosing('1020');
    const gbp0 = await foreignClosing('1040');
    const t = await createTransfer(ctx, {
      date: d('2026-04-01'),
      fromAccountId: acct['1020'],
      toAccountId: acct['1040'],
      amount: '500.00',
      toAmount: '430.00',
    });
    expect(t.currency).toBe('EUR');
    expect(t.toCurrency).toBe('GBP');
    expect(t.homeAmount).toBe('550.00'); // 500 EUR at the EUR list rate
    expect(Money.of(eur0).minus(await foreignClosing('1020')).toFixed(2)).toBe('500.00');
    expect(Money.of(await foreignClosing('1040')).minus(gbp0).toFixed(2)).toBe('430.00');
    await invariants();

    // Edit only the amount that arrived (home value unchanged) — the GBP register must follow.
    await updateTransfer(ctx, t.id, {
      date: d('2026-04-01'),
      fromAccountId: acct['1020'],
      toAccountId: acct['1040'],
      amount: '500.00',
      toAmount: '431.00',
    });
    expect(Money.of(await foreignClosing('1040')).minus(gbp0).toFixed(2)).toBe('431.00');
    expect(Money.of(eur0).minus(await foreignClosing('1020')).toFixed(2)).toBe('500.00');
    await invariants();

    await voidTransfer(ctx, t.id);
    expect(await foreignClosing('1020')).toBe(eur0);
    expect(await foreignClosing('1040')).toBe(gbp0);
    await invariants();
  });

  it('a large cross-currency transfer with a stated home amount over 1,000,000 is accepted', async () => {
    await postJournalEntry(ctx, {
      date: d('2026-04-02'),
      description: 'Big funding',
      lines: [
        { accountId: acct['1000'], debit: '3000000.00' },
        { accountId: acct['3000'], credit: '3000000.00' },
      ],
    });
    const t = await createTransfer(ctx, {
      date: d('2026-04-03'),
      fromAccountId: acct['1000'],
      toAccountId: acct['1030'],
      amount: '2200000.00',
      toAmount: '2000000.00',
      homeAmount: '2200000.00',
    });
    expect(t.homeAmount).toBe('2200000.00');
    await voidTransfer(ctx, t.id);
    await invariants();
  });

  it('a transfer between two accounts of the same foreign currency never asks for a cross amount', async () => {
    const t = await createTransfer(ctx, {
      date: d('2026-04-04'),
      fromAccountId: acct['1020'],
      toAccountId: acct['1030'],
      amount: '0.01',
      exchangeRate: '1.10',
    });
    expect(t.toAmount).toBe('0.01');
    expect(t.homeAmount).toBe('0.01');
    // Rounds to zero home value: refused in plain language.
    await expect(
      createTransfer(ctx, {
        date: d('2026-04-04'),
        fromAccountId: acct['1020'],
        toAccountId: acct['1030'],
        amount: '0.01',
        exchangeRate: '0.10',
      }),
    ).rejects.toThrow(/too small/);
    await invariants();
  });

  // ---------------------------------------------------------------------------------------------
  // Vendor credits
  // ---------------------------------------------------------------------------------------------

  it('foreign vendor credit applied in three pieces with rounding: bill and credit close to the cent', async () => {
    const v = await createVendor(ctx, { displayName: 'Penny Supplier', currency: 'EUR' });
    const ap0 = Money.of(await bal('2000'));
    const bill = await createBill(ctx, {
      vendorId: v.id,
      date: d('2026-05-01'),
      exchangeRate: '1.0712',
      lines: [{ accountId: acct['6300'], amount: '10.00' }],
    } as never);
    const vc = await createVendorCredit(ctx, {
      vendorId: v.id,
      date: d('2026-05-02'),
      exchangeRate: '1.3333',
      lines: [{ accountId: acct['6300'], amount: '10.00' }],
    });
    expect(vc.homeTotal).toBe('13.33');
    for (const [i, amt] of ['3.33', '3.33', '3.34'].entries()) {
      await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: amt, date: d(`2026-05-0${i + 3}`) });
      await invariants();
    }
    const after = await getVendorCredit(ctx, vc.id);
    expect(after.unapplied).toBe('0.00');
    expect(after.homeUnapplied).toBe('0.00');
    expect(Money.of(await bal('2000')).minus(ap0).toFixed(2)).toBe('0.00');
    // Unapply everything (full), then void the credit: A/P ties and nothing is left.
    await unapplyFromBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '10.00', date: d('2026-05-08') });
    await invariants();
    await voidVendorCredit(ctx, vc.id);
    expect(Money.of(await bal('2000')).minus(ap0).toFixed(2)).toBe('10.71');
    await invariants();
  });

  it('editing a foreign vendor credit re-posts at the new rate; a credit cannot change currency', async () => {
    const v = await createVendor(ctx, { displayName: 'Edit Supplier', currency: 'EUR' });
    const vc = await createVendorCredit(ctx, {
      vendorId: v.id,
      date: d('2026-05-10'),
      exchangeRate: '1.10',
      lines: [{ accountId: acct['6300'], amount: '40.00' }],
    });
    expect(vc.homeTotal).toBe('44.00');
    const up = await updateVendorCredit(ctx, vc.id, {
      vendorId: v.id,
      date: d('2026-05-10'),
      exchangeRate: '1.20',
      lines: [{ accountId: acct['6300'], amount: '40.00' }],
    });
    expect(up.homeTotal).toBe('48.00');
    expect(up.homeUnapplied).toBe('48.00');
    const lines = await linesOf(up.postedEntryId!);
    expect(lines.find((l) => l.accountId === acct['2000'])!.debit).toBe('48.00');
    await invariants();
    const home = await createVendor(ctx, { displayName: 'Home Supplier' });
    await expect(
      updateVendorCredit(ctx, vc.id, {
        vendorId: home.id,
        date: d('2026-05-10'),
        lines: [{ accountId: acct['6300'], amount: '40.00' }],
      }),
    ).rejects.toThrow(/Void it/);
    // A EUR credit can't be applied to a home bill of the same vendor (other vendor rejected anyway).
    await voidVendorCredit(ctx, vc.id);
    await invariants();
  });

  // ---------------------------------------------------------------------------------------------
  // Loans
  // ---------------------------------------------------------------------------------------------

  it('a EUR loan paid off at its booked rate leaves exactly zero on the liability', async () => {
    const lender = await createVendor(ctx, { displayName: 'Payoff Bank', currency: 'EUR' });
    const liab0 = Money.of(await bal('2600'));
    await postJournalEntry(ctx, {
      date: d('2026-06-01'),
      description: 'EUR loan proceeds',
      currency: 'EUR',
      exchangeRate: '1.0712',
      lines: [
        { accountId: acct['1020'], debit: '1071.20', foreignAmount: '1000.00' },
        { accountId: acct['2600'], credit: '1071.20' },
      ],
    });
    const loan = await createLoan(ctx, {
      name: 'Payoff note',
      lenderVendorId: lender.id,
      liabilityAccountId: acct['2600'],
      interestAccountId: acct['6800'],
      paymentAccountId: acct['1020'],
      originalAmount: '1000',
      annualRate: '7',
      termMonths: 12,
      originDate: d('2026-06-01'),
      firstPaymentDate: d('2026-07-01'),
      exchangeRate: '1.0712',
    });
    for (let i = 0; i < 12; i++) {
      await setUpLoanPayment(ctx, loan.id, { kind: 'check', exchangeRate: '1.0712' });
    }
    const after = await getLoan(ctx, loan.id);
    expect(Money.of(after.balance).toFixed(2)).toBe('0.00');
    expect(Money.of(await bal('2600')).minus(liab0).toFixed(2)).toBe('0.00');
    await invariants();
  });

  it('a loan payment dated in a closed period writes nothing (no check, no exchange entry, no schedule row)', async () => {
    const lender = await createVendor(ctx, { displayName: 'Closed Bank', currency: 'EUR' });
    const loan = await createLoan(ctx, {
      name: 'Closed note',
      lenderVendorId: lender.id,
      liabilityAccountId: acct['2600'],
      interestAccountId: acct['6800'],
      paymentAccountId: acct['1020'],
      originalAmount: '500',
      annualRate: '5',
      termMonths: 6,
      originDate: d('2026-01-01'),
      firstPaymentDate: d('2026-02-01'),
      exchangeRate: '1.10',
    });
    const entries0 = await db.select({ n: sql<number>`count(*)::int` }).from(journalEntries);
    await setClosingDate(ctx, { closingDate: '2026-03-31' });
    try {
      await expect(
        setUpLoanPayment(ctx, loan.id, { kind: 'check', exchangeRate: '1.30', date: d('2026-02-01') }),
      ).rejects.toThrow();
    } finally {
      await setClosingDate(ctx, { closingDate: null });
    }
    const entries1 = await db.select({ n: sql<number>`count(*)::int` }).from(journalEntries);
    expect(entries1[0].n).toBe(entries0[0].n);
    const lps = await db.select().from(loanPayments).where(eq(loanPayments.loanId, loan.id));
    expect(lps.length).toBe(0);
    await invariants();
  });

  // ---------------------------------------------------------------------------------------------
  // Reconciliation + credit card
  // ---------------------------------------------------------------------------------------------

  it('a EUR card cannot be paid from a GBP account; the statement payment from home cash carries the EUR amount', async () => {
    const charge = await stageFeed(eurCardBankId, '2026-07-02', '-40.00', 'Taxi');
    await categorize(ctx, { bankTransactionId: charge.id, accountId: acct['6300'] });
    const recon = await startReconciliation(ctx, {
      bankAccountId: eurCardBankId,
      statementDate: d('2026-07-31'),
      statementBalance: '40.00',
    });
    for (const l of await listClearable(ctx, eurCardBankId, d('2026-07-31'), recon.id)) {
      await toggleCleared(ctx, recon.id, l.journalEntryLineId, true);
    }
    expect((await getProgress(ctx, recon.id)).difference).toBe('0.00');
    await completeReconciliation(ctx, recon.id);
    await expect(
      payCreditCardBalance(ctx, recon.id, { paymentAccountId: acct['1040'], date: d('2026-08-01') }),
    ).rejects.toThrow(/GBP/);
    const entry = await payCreditCardBalance(ctx, recon.id, {
      paymentAccountId: acct['1000'],
      date: d('2026-08-01'),
      exchangeRate: '1.15',
    });
    const lines = await linesOf(entry.id);
    expect(lines.find((l) => l.accountId === acct['2150'])!.foreignAmount).toBe('40.00');
    expect(lines.find((l) => l.accountId === acct['1000'])!.credit).toBe('46.00');
    expect(lines.find((l) => l.accountId === acct['1000'])!.foreignAmount).toBeNull();
    // Paying twice is refused.
    await expect(
      payCreditCardBalance(ctx, recon.id, { paymentAccountId: acct['1000'], date: d('2026-08-01') }),
    ).rejects.toThrow();
    expect(await foreignClosing('2150')).toBe('0.00');
    await invariants();
  });

  // ---------------------------------------------------------------------------------------------
  // Home Currency Adjustment
  // ---------------------------------------------------------------------------------------------

  it('HCA: a later reconciliation of the EUR bank is unaffected; the revaluation never shows as a statement item', async () => {
    const asOf = d('2026-08-31');
    const hca = await createHomeCurrencyAdjustment(ctx, { date: asOf, rates: { EUR: '1.05', GBP: '1.30' } });
    // As of the adjustment date: home balance = foreign balance x new rate (later lines excluded).
    const eurAt = await withAccountCurrency(ctx, await accountRegister(ctx, acct['1020'], { to: asOf }), { to: asOf });
    expect(eurAt.closingBalance).toBe(
      Money.round2(Money.of(eurAt.foreignClosingBalance!).times('1.05')).toFixed(2),
    );
    const gbpAt = await withAccountCurrency(ctx, await accountRegister(ctx, acct['1040'], { to: asOf }), { to: asOf });
    expect(gbpAt.closingBalance).toBe(
      Money.round2(Money.of(gbpAt.foreignClosingBalance!).times('1.30')).toFixed(2),
    );
    const stmtDate = d('2026-09-30');
    const eurReg = await withAccountCurrency(ctx, await accountRegister(ctx, acct['1020'], { to: stmtDate }), { to: stmtDate });
    await invariants(asOf);
    await invariants();
    const recon = await startReconciliation(ctx, {
      bankAccountId: eurBankId,
      statementDate: stmtDate,
      statementBalance: eurReg.foreignClosingBalance!,
    });
    const items = await listClearable(ctx, eurBankId, d('2026-09-30'), recon.id);
    expect(items.some((l) => l.journalEntryId === hca.entryId)).toBe(false);
    for (const l of items) await toggleCleared(ctx, recon.id, l.journalEntryLineId, true);
    expect((await getProgress(ctx, recon.id)).difference).toBe('0.00');
    await completeReconciliation(ctx, recon.id);
    const info = await getReconcileInfo(ctx, eurBankId);
    expect(info.beginningBalance).toBe(eurReg.foreignClosingBalance);
    expect(info.discrepancy).toBe('0.00');
    // A second HCA at the same rates has nothing to do for the bank accounts.
    const again = await previewHomeCurrencyAdjustment(ctx, { date: asOf, rates: { EUR: '1.05', GBP: '1.30' } });
    expect(again.lines.filter((l) => l.kind === 'account')).toEqual([]);
  });

  it('HCA dated in a closed period is refused and leaves no adjustment row or entry behind', async () => {
    const rows0 = await db.select().from(homeCurrencyAdjustments).where(eq(homeCurrencyAdjustments.companyId, ctx.companyId));
    const entries0 = await db.select({ n: sql<number>`count(*)::int` }).from(journalEntries);
    await setClosingDate(ctx, { closingDate: '2026-12-31' });
    try {
      await expect(createHomeCurrencyAdjustment(ctx, { date: d('2026-10-31'), rates: { EUR: '1.50' } })).rejects.toThrow();
      // Voiding the earlier adjustment (inside the closed period) is refused too.
      await expect(voidHomeCurrencyAdjustment(ctx, rows0[0].id)).rejects.toThrow();
    } finally {
      await setClosingDate(ctx, { closingDate: null });
    }
    const rows1 = await db.select().from(homeCurrencyAdjustments).where(eq(homeCurrencyAdjustments.companyId, ctx.companyId));
    expect(rows1.length).toBe(rows0.length);
    expect(rows1.every((r) => r.voidedAt == null)).toBe(true);
    const entries1 = await db.select({ n: sql<number>`count(*)::int` }).from(journalEntries);
    expect(entries1[0].n).toBe(entries0[0].n);
    // The rate list is not changed by the failed run.
    const [eur] = await db.execute(sql`SELECT rate_to_base FROM currencies WHERE company_id = ${ctx.companyId} AND code = 'EUR'`).then((r) => (r as unknown as { rows: Array<{ rate_to_base: string }> }).rows);
    expect(Money.of(eur.rate_to_base).toFixed(2)).toBe('1.05');
    await invariants();
  });

  it('HCA rejects zero / negative / non-numeric rates', async () => {
    for (const bad of ['0', '-1', 'x']) {
      await expect(previewHomeCurrencyAdjustment(ctx, { date: d('2026-11-30'), rates: { EUR: bad } })).rejects.toThrow();
    }
  });

  it('HCA is company-scoped: another company sees none of these foreign balances', async () => {
    const p = await previewHomeCurrencyAdjustment(ctxB, { date: d('2026-12-31') });
    expect(p.lines).toEqual([]);
    await expect(createHomeCurrencyAdjustment(ctxB, { date: d('2026-12-31') })).rejects.toThrow(/Nothing to adjust/);
    const rowsB = await db.select().from(homeCurrencyAdjustments).where(eq(homeCurrencyAdjustments.companyId, ctxB.companyId));
    expect(rowsB.length).toBe(0);
    // And company A's adjustment cannot be voided from company B.
    const [rowA] = await db.select().from(homeCurrencyAdjustments).where(eq(homeCurrencyAdjustments.companyId, ctx.companyId));
    await expect(voidHomeCurrencyAdjustment(ctxB, rowA.id)).rejects.toThrow();
    await invariants(d('2027-12-31'), ctxB, acctB);
  });
  it('Vendor Balance Detail and A/P Aging Detail show foreign bills in both currencies; aging is home', async () => {
    const v = await createVendor(ctx, { displayName: 'Report Supplier', currency: 'GBP' });
    const bill = await createBill(ctx, {
      vendorId: v.id,
      date: d('2026-12-01'),
      exchangeRate: '1.25',
      lines: [{ accountId: acct['6300'], amount: '80.00' }],
    } as never);
    const vc = await createVendorCredit(ctx, {
      vendorId: v.id,
      date: d('2026-12-02'),
      exchangeRate: '1.30',
      lines: [{ accountId: acct['6300'], amount: '20.00' }],
    });
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '20.00', date: d('2026-12-03') });
    const det = await apAgingDetail(ctx, d('2026-12-31'));
    const row = det.rows.find((r) => r.docId === bill.id)!;
    expect(row.currency).toBe('GBP');
    expect(row.foreignOpenBalance).toBe('60.00');
    expect(row.openBalance).toBe('75.00'); // 100.00 - 25.00 relieved at the bill's rate
    const rep = await vendorBalanceDetail(ctx, { vendorId: v.id, to: '2026-12-31' } as never);
    expect(rep.columns.some((c) => c.key === 'foreignAmount')).toBe(true);
    const billRow = rep.rows.find((r) => r.kind === 'data' && r.cells.foreignAmount === '80.00');
    expect(billRow?.cells.currency).toBe('GBP');
    await invariants(d('2026-12-31'));
    await invariants();
  });

  // Cross-team findings (invoices.ts / payments.ts) are kept LAST so a failure here cannot cascade
  // into the invariant checks of the FX scenarios above.
  it('[invoices.ts] a foreign invoice keeps the exchange rate as entered (QB allows 4+ decimals)', async () => {
    const cust = await newCustomer('Rate Precision Client');
    const inv = await createInvoice(ctx, {
      customerId: cust.id,
      date: d('2027-01-10'),
      currency: 'EUR',
      exchangeRate: '1.0712',
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '100' }],
    } as never);
    expect(Money.of(inv.exchangeRate!).toFixed(4)).toBe('1.0712');
    const arLine = (await linesOf(inv.postedEntryId!)).find((l) => l.accountId === acct['1200'])!;
    expect(arLine.debit).toBe('107.12');
  });

  it('[payments.ts] a foreign invoice paid in full in three partial payments leaves nothing on A/R (A/R == aging)', async () => {
    const cust = await newCustomer('Penny Client');
    const arBefore = Money.of(await bal('1200'));
    const inv = await createInvoice(ctx, {
      customerId: cust.id,
      date: d('2026-02-10'),
      currency: 'EUR',
      exchangeRate: '1.07',
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '100' }],
    } as never);
    const invLines = await linesOf(inv.postedEntryId!);
    expect(invLines.find((l) => l.accountId === acct['1200'])!.debit).toBe('107.00');
    for (const [i, amt] of ['33.33', '33.33', '33.34'].entries()) {
      await receivePayment(ctx, {
        customerId: cust.id,
        date: d(`2026-02-1${i + 1}`),
        method: 'check',
        amount: amt,
        currency: 'EUR',
        exchangeRate: '1.07',
        depositAccountId: acct['1050'],
        applications: [{ invoiceId: inv.id, amountApplied: amt }],
      } as never);
    }
    // Invoice booked 107.00 home (35.66 + 35.66 + 35.67 = 106.99 relieved by naive rounding); fully paid -> A/R back exactly where it was.
    expect(Money.of(await bal('1200')).minus(arBefore).toFixed(2)).toBe('0.00');
    await invariants();
  });

});
