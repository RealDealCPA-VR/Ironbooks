/**
 * P1 round, team FX — multi-currency completeness, end to end:
 *  - bank feeds on a foreign-currency account post home value at the stated / list rate and keep
 *    the account-currency amount on the bank line; matching compares in the account's currency;
 *    an OFX file in another currency is refused;
 *  - the register shows account-currency columns and running balance;
 *  - reconciliation runs in the account's currency (incl. service charge + paying a foreign card);
 *  - deposits into a foreign bank (UF relieved at the received rate, realized gain/loss);
 *  - transfers between currencies (stated to-amount, home override, home value on both lines);
 *  - foreign vendor credits (create, apply with realized gain/loss, unapply, refund) keeping
 *    A/P == A/P aging in home currency, and Pay Bills closing the rest exactly;
 *  - Loan Manager loans in a foreign currency (realized gain/loss on principal, void together);
 *  - A/R aging of foreign invoices in home currency + Customer Balance Detail foreign columns;
 *  - Home Currency Adjustment over bank, card, A/R, A/P and loans, with next-day reversal, void;
 *  - the foreign amount of a posted line is immutable (bka_jel_fx_guard).
 * Every scenario ends with the trial balance and balance sheet balanced and A/R, A/P tied.
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
  loanPayments,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance, balanceSheet } from './reports';
import { postJournalEntry, allowLedgerRewrite } from './posting';
import { upsertCurrency, setBaseCurrency, setAccountCurrency } from './currencies';
import { createBankAccount } from './bankAccounts';
import { categorize, suggestMatches, matchTransaction } from './bankCategorize';
import { importTransactions, parseOFXCurrency } from './import';
import { accountRegister } from './journal';
import { withAccountCurrency } from './fxLedger';
import {
  startReconciliation,
  listClearable,
  toggleCleared,
  completeReconciliation,
  getProgress,
  addStatementAdjustments,
  payCreditCardBalance,
  getReconcileInfo,
} from './reconcile';
import { createExpense } from './expenses';
import { createDeposit, listUndepositedPayments } from './deposits';
import { createTransfer } from './transfers';
import { createVendor } from './vendors';
import { createBill, getBill } from './bills';
import { payBills } from './billPayments';
import {
  createVendorCredit,
  applyToBill,
  unapplyFromBill,
  refundVendorCredit,
  getVendorCredit,
} from './vendorCredits';
import { createLoan, getLoan, setUpLoanPayment, voidLoanPayment } from './loans';
import { createInvoice } from './invoices';
import { receivePayment } from './payments';
import { apAging, arAging } from './reportsExtra';
import { customerBalanceDetail } from './reportsLists';
import {
  previewHomeCurrencyAdjustment,
  createHomeCurrencyAdjustment,
  voidHomeCurrencyAdjustment,
} from './homeCurrencyAdjustment';
import { currencyRate, realizedGainLoss, toHome } from './exchangeRates';
import { Money } from '@/lib/money';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-fx');
let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
let eurBankId = ''; // bank_accounts row of 1020
let eurCardBankId = ''; // bank_accounts row of 2150

const d = (s: string) => new Date(`${s}T12:00:00Z`);

async function bal(code: string): Promise<string> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, acct[code]));
  return Money.of(row.balance).toFixed(2);
}

/** Natural GL balance of an account from posted lines dated on/before `asOf`. */
async function balAsOf(code: string, asOf: Date): Promise<string> {
  const [row] = await db
    .select({ d: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`, c: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)` })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(eq(journalEntryLines.accountId, acct[code]), eq(journalEntries.status, 'posted'), lte(journalEntries.date, asOf)));
  const net = Money.of(row.d).minus(Money.of(row.c));
  return (code.startsWith('1') ? net : net.negated()).toFixed(2);
}

/** TB + BS balanced, A/R and A/P aging tie to their control accounts (home currency). */
async function invariants(asOf = d('2026-12-31')) {
  const tb = await trialBalance(ctx);
  expect(tb.balanced).toBe(true);
  const bs = await balanceSheet(ctx);
  expect(Money.of(bs.totalAssets).toFixed(2)).toBe(Money.of(bs.totalLiabilities).plus(Money.of(bs.totalEquity)).toFixed(2));
  const ap = await apAging(ctx, asOf);
  expect(Money.of(ap.totals.total).toFixed(2)).toBe(await balAsOf('2000', asOf));
  const ar = await arAging(ctx, asOf);
  expect(Money.of(ar.totals.total).toFixed(2)).toBe(await balAsOf('1200', asOf));
}

async function linesOf(entryId: string) {
  return db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, entryId));
}

async function stageFeed(bankAccountId: string, date: string, amount: string, description: string) {
  const [row] = await db
    .insert(bankTransactions)
    .values({ companyId: ctx.companyId, bankAccountId, date: d(date), description, amount, matched: false })
    .returning();
  return row;
}

describe('P1 FX — multi-currency completeness', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'p1fx@test.local', name: 'FX', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'FX Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1020', 'Euro Bank', 'asset', 'checking'],
      ['1030', 'Euro Savings', 'asset', 'savings'],
      ['1050', 'Undeposited Funds', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['2150', 'Euro Card', 'liability', 'credit_card'],
      ['2200', 'Sales Tax Payable', 'liability', 'other_current_liability'],
      ['2600', 'Euro Loan', 'liability', 'long_term_liability'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4000', 'Sales', 'revenue', 'sales'],
      ['4900', 'Other Income', 'revenue', 'other_income'],
      ['6100', 'Bank Fees', 'expense', 'operating_expenses'],
      ['6300', 'Office Supplies', 'expense', 'operating_expenses'],
      ['6800', 'Interest Expense', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    }
    await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.10' });
    await upsertCurrency(ctx, { code: 'GBP', name: 'Pound', rateToBase: '1.25' });
    // review5 fx: the list rates were set at the start of the year, so the adjustments dated later
    // in 2026 update the list (a back-dated one keeps a newer list rate).
    await db.execute(sql`UPDATE currencies SET updated_at = '2026-01-01' WHERE company_id = ${ctx.companyId}`);
    await setAccountCurrency(ctx, acct['1020'], 'EUR');
    await setAccountCurrency(ctx, acct['1030'], 'EUR');
    await setAccountCurrency(ctx, acct['2150'], 'EUR');
    eurBankId = (await createBankAccount(ctx, { accountId: acct['1020'], bankName: 'Euro Bank', accountNumber: '111222333' })).id;
    eurCardBankId = (await createBankAccount(ctx, { accountId: acct['2150'], bankName: 'Euro Card', accountNumber: '444555666' })).id;
    await postJournalEntry(ctx, {
      date: d('2026-01-01'),
      description: 'Opening funds',
      lines: [
        { accountId: acct['1000'], debit: '10000.00' },
        { accountId: acct['3000'], credit: '10000.00' },
      ],
    });
  });

  afterAll(async () => {
    await closeDb();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle; the next run wipes the dir first. */
    }
  });

  it('helpers: list / stated rate, home conversion and realized gain/loss', async () => {
    expect((await currencyRate(ctx, 'EUR')).rate.toFixed(2)).toBe('1.10');
    expect((await currencyRate(ctx, 'EUR', '1.2345')).rate.toFixed(4)).toBe('1.2345');
    expect((await currencyRate(ctx, 'USD')).currency).toBeNull();
    await expect(currencyRate(ctx, 'JPY')).rejects.toThrow(/not in your currency list/);
    expect(toHome('33.33', '1.0712').toFixed(2)).toBe('35.70');
    const r = realizedGainLoss({ amount: '100', bookedRate: '1.10', settleRate: '1.20', side: 'asset' });
    expect(r.gain.toFixed(2)).toBe('10.00');
    const l = realizedGainLoss({ amount: '100', bookedRate: '1.10', settleRate: '1.20', side: 'liability' });
    expect(l.gain.toFixed(2)).toBe('-10.00');
  });

  it('a posted foreign line gets its account-currency amount; postings without one convert at the list rate', async () => {
    const e = await postJournalEntry(ctx, {
      date: d('2026-01-02'),
      description: 'Owner puts 1,000 EUR in',
      currency: 'EUR',
      exchangeRate: '1.10',
      lines: [
        { accountId: acct['1020'], debit: '1100.00', foreignAmount: '1000.00' },
        { accountId: acct['3000'], credit: '1100.00' },
      ],
    });
    const lines = await linesOf(e.id);
    const bank = lines.find((l) => l.accountId === acct['1020'])!;
    expect(bank.foreignAmount).toBe('1000.00');
    expect(bank.currency).toBe('EUR');
    expect(Money.of(bank.exchangeRate!).toFixed(2)).toBe('1.10');
    expect(lines.find((l) => l.accountId === acct['3000'])!.foreignAmount).toBeNull();

    // No foreign amount given: converted at the list rate (110 home -> 100 EUR).
    const e2 = await postJournalEntry(ctx, {
      date: d('2026-01-02'),
      description: 'Another 110 home into Euro Savings',
      lines: [
        { accountId: acct['1030'], debit: '110.00' },
        { accountId: acct['3000'], credit: '110.00' },
      ],
    });
    expect((await linesOf(e2.id)).find((l) => l.accountId === acct['1030'])!.foreignAmount).toBe('100.00');
    await invariants();
  });

  it('the foreign amount of a posted line cannot be changed afterwards', async () => {
    const [line] = await db
      .select()
      .from(journalEntryLines)
      .where(and(eq(journalEntryLines.accountId, acct['1020']), eq(journalEntryLines.foreignAmount, '1000.00')));
    await expect(
      db.update(journalEntryLines).set({ foreignAmount: '999.00' }).where(eq(journalEntryLines.id, line.id)),
    ).rejects.toThrow();
    const [after] = await db.select().from(journalEntryLines).where(eq(journalEntryLines.id, line.id));
    expect(after.foreignAmount).toBe('1000.00');
  });

  it('migration 0043 re-runs cleanly and back-fills foreign amounts of lines posted before it', async () => {
    const vendor = await createVendor(ctx, { displayName: 'Old Data Vendor', currency: 'EUR' });
    const chk = await createExpense(ctx, {
      vendorId: vendor.id,
      date: d('2026-01-03'),
      method: 'check',
      paymentAccountId: acct['1030'],
      exchangeRate: '1.25',
      lines: [{ accountId: acct['6300'], amount: '8.00' }],
    } as never);
    const [line] = (await linesOf(chk.postedEntryId!)).filter((l) => l.accountId === acct['1030']);
    expect(line.foreignAmount).toBe('8.00');
    // Simulate a line written before 0043 (no foreign columns), inside a sanctioned rewrite.
    await db.transaction(async (tx) => {
      await allowLedgerRewrite({ db: tx as unknown as DB }, 'restore');
      await tx.update(journalEntryLines).set({ foreignAmount: null, currency: null, exchangeRate: null }).where(eq(journalEntryLines.id, line.id));
    });
    // Re-run the whole migration (idempotent): the back-fill restores 8.00 EUR from the check's rate.
    const file = fs.readFileSync(path.resolve(process.cwd(), 'drizzle', '0043_p1_fx.sql'), 'utf8');
    for (const stmt of file.split('--> statement-breakpoint')) {
      if (stmt.replace(/--.*$/gm, '').trim()) await db.execute(sql.raw(stmt));
    }
    const [after] = await db.select().from(journalEntryLines).where(eq(journalEntryLines.id, line.id));
    expect(after.foreignAmount).toBe('8.00');
    expect(after.currency).toBe('EUR');
    expect(Money.of(after.exchangeRate!).toFixed(2)).toBe('1.25');
    await invariants();
  });

  it('bank feed on a EUR account: posts home value at the list / stated rate; matching compares EUR', async () => {
    const dep = await stageFeed(eurBankId, '2026-01-10', '200.00', 'Client wire');
    const r1 = await categorize(ctx, { bankTransactionId: dep.id, accountId: acct['4900'] });
    const l1 = await linesOf(r1.entry.id);
    expect(l1.find((l) => l.accountId === acct['1020'])!.debit).toBe('220.00');
    expect(l1.find((l) => l.accountId === acct['1020'])!.foreignAmount).toBe('200.00');
    expect(l1.find((l) => l.accountId === acct['4900'])!.credit).toBe('220.00');

    const fee = await stageFeed(eurBankId, '2026-01-11', '-50.00', 'Bank fee');
    const r2 = await categorize(ctx, { bankTransactionId: fee.id, accountId: acct['6100'], exchangeRate: '1.2' });
    const l2 = await linesOf(r2.entry.id);
    expect(l2.find((l) => l.accountId === acct['1020'])!.credit).toBe('60.00');
    expect(l2.find((l) => l.accountId === acct['1020'])!.foreignAmount).toBe('50.00');

    // A EUR check of 30 EUR (33.00 home) is matched by a -30.00 feed line (account currency).
    const vendor = await createVendor(ctx, { displayName: 'Paris Office', currency: 'EUR' });
    const chk = await createExpense(ctx, {
      vendorId: vendor.id,
      date: d('2026-01-12'),
      method: 'check',
      paymentAccountId: acct['1020'],
      lines: [{ accountId: acct['6300'], amount: '30.00' }],
    });
    const bankLine = (await linesOf(chk.postedEntryId!)).find((l) => l.accountId === acct['1020'])!;
    expect(bankLine.credit).toBe('33.00');
    expect(bankLine.foreignAmount).toBe('30.00');
    const feedChk = await stageFeed(eurBankId, '2026-01-13', '-30.00', 'Check');
    const cands = await suggestMatches(ctx, feedChk.id);
    expect(cands.map((c) => c.entryId)).toContain(chk.postedEntryId);
    expect(cands.find((c) => c.entryId === chk.postedEntryId)!.amount).toBe('-30.00');
    await matchTransaction(ctx, feedChk.id, chk.postedEntryId!);
    await invariants();
  });

  it('bank file import: refuses a statement in another currency, accepts its own', async () => {
    const ofx = (cur: string) =>
      `OFXHEADER:100\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>${cur}<BANKTRANLIST>` +
      `<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260115<TRNAMT>12.34<FITID>FX1<NAME>Interest</STMTTRN>` +
      `</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    expect(parseOFXCurrency(ofx('gbp'))).toBe('GBP');
    await expect(importTransactions(ctx, { bankAccountId: eurBankId, fileType: 'ofx', content: ofx('GBP') })).rejects.toThrow(
      /GBP statement/,
    );
    const ok = await importTransactions(ctx, { bankAccountId: eurBankId, fileType: 'ofx', content: ofx('EUR') });
    expect(ok.imported).toBe(1);
  });

  it('register of a EUR account: account-currency columns and running balance', async () => {
    const reg = await withAccountCurrency(ctx, await accountRegister(ctx, acct['1020']));
    expect(reg.currency).toBe('EUR');
    // 1000 + 200 - 50 - 30 = 1120 EUR; home 1100 + 220 - 60 - 33 = 1227.
    expect(reg.foreignClosingBalance).toBe('1120.00');
    expect(reg.closingBalance).toBe('1227.00');
    expect(await bal('1020')).toBe('1227.00');
    const feeRow = reg.rows.find((r) => 'foreignCredit' in r && r.foreignCredit === '50.00');
    expect(feeRow).toBeTruthy();
    const home = await withAccountCurrency(ctx, await accountRegister(ctx, acct['1000']));
    expect(home.currency).toBeNull();
  });

  it('reconciles a EUR account in EUR (service charge in EUR posts its home value)', async () => {
    const recon = await startReconciliation(ctx, { bankAccountId: eurBankId, statementDate: d('2026-01-31'), statementBalance: '1115.00' });
    const lines = await listClearable(ctx, eurBankId, d('2026-01-31'), recon.id);
    // Amounts are in EUR.
    expect(lines.some((l) => l.debit === '1000.00')).toBe(true);
    expect(lines.some((l) => l.credit === '30.00' && l.homeCredit === '33.00')).toBe(true);
    for (const l of lines) await toggleCleared(ctx, recon.id, l.journalEntryLineId, true);
    expect((await getProgress(ctx, recon.id)).clearedBalance).toBe('1120.00');
    await addStatementAdjustments(ctx, recon.id, { serviceCharge: { amount: '5.00', accountId: acct['6100'] }, exchangeRate: '1.20' });
    const p = await getProgress(ctx, recon.id);
    expect(p.clearedBalance).toBe('1115.00');
    expect(p.difference).toBe('0.00');
    await completeReconciliation(ctx, recon.id);
    const info = await getReconcileInfo(ctx, eurBankId);
    expect(info.currency).toBe('EUR');
    expect(info.beginningBalance).toBe('1115.00');
    expect(info.discrepancy).toBe('0.00');
    expect(await bal('1020')).toBe('1221.00'); // 1227 - 6.00 (5 EUR x 1.20)
    await invariants();
  });

  it('pays a EUR credit card statement in EUR after reconciling it', async () => {
    const charge = await stageFeed(eurCardBankId, '2026-02-02', '-80.00', 'Hotel');
    await categorize(ctx, { bankTransactionId: charge.id, accountId: acct['6300'] });
    expect(await bal('2150')).toBe('88.00');
    const recon = await startReconciliation(ctx, { bankAccountId: eurCardBankId, statementDate: d('2026-02-28'), statementBalance: '80.00' });
    for (const l of await listClearable(ctx, eurCardBankId, d('2026-02-28'), recon.id)) {
      await toggleCleared(ctx, recon.id, l.journalEntryLineId, true);
    }
    await completeReconciliation(ctx, recon.id);
    await expect(payCreditCardBalance(ctx, recon.id, { paymentAccountId: acct['1030'], exchangeRate: '1.15', date: d('2026-03-01') })).resolves.toBeTruthy();
    // 80 EUR at 1.15 = 92.00 home off the card (card carried 88.00 -> -4.00 until revalued).
    expect(await bal('2150')).toBe('-4.00');
    await invariants();
  });

  it('deposits a EUR payment into the EUR bank: UF relieved at the received rate, realized gain', async () => {
    const [cust] = await db.insert(customers).values({ companyId: ctx.companyId, displayName: 'Lyon Client' }).returning();
    const inv = await createInvoice(ctx, {
      customerId: cust.id,
      date: d('2026-03-01'),
      currency: 'EUR',
      exchangeRate: '1.10',
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '100' }],
    } as never);
    const { payment } = await receivePayment(ctx, {
      customerId: cust.id,
      date: d('2026-03-05'),
      method: 'check',
      amount: '100.00',
      currency: 'EUR',
      exchangeRate: '1.10',
      depositAccountId: acct['1050'],
      applications: [{ invoiceId: inv.id, amountApplied: '100.00' }],
    } as never);
    const items = await listUndepositedPayments(ctx);
    expect(items.find((i) => i.id === payment.id)!.currency).toBe('EUR');
    // A home-currency bank can't take a EUR payment.
    await expect(createDeposit(ctx, { depositAccountId: acct['1000'], date: d('2026-03-06'), paymentIds: [payment.id] })).rejects.toThrow(/EUR/);
    const bankBefore = await bal('1020');
    const dep = await createDeposit(ctx, { depositAccountId: acct['1020'], date: d('2026-03-07'), paymentIds: [payment.id], exchangeRate: '1.15' });
    expect(dep.currency).toBe('EUR');
    expect(dep.total).toBe('100.00');
    expect(dep.homeTotal).toBe('115.00');
    expect(Money.of(await bal('1020')).minus(bankBefore).toFixed(2)).toBe('115.00');
    expect(await bal('1050')).toBe('0.00');
    const lines = await linesOf(dep.postedEntryId!);
    expect(lines.find((l) => l.memo === 'Realized exchange gain')?.credit).toBe('5.00');
    expect(lines.find((l) => l.accountId === acct['1020'])!.foreignAmount).toBe('100.00');
    await invariants();
  });

  it('transfers between currencies: asks for the arrived amount; one home value on both lines', async () => {
    await expect(
      createTransfer(ctx, { date: d('2026-03-10'), fromAccountId: acct['1000'], toAccountId: acct['1020'], amount: '100.00' }),
    ).rejects.toThrow(/arrived in EUR/);
    const t = await createTransfer(ctx, {
      date: d('2026-03-10'),
      fromAccountId: acct['1000'],
      toAccountId: acct['1020'],
      amount: '100.00',
      toAmount: '90.00',
    });
    expect(t.homeAmount).toBe('100.00');
    expect(t.toAmount).toBe('90.00');
    expect(t.toCurrency).toBe('EUR');
    const lines = await linesOf(t.postedEntryId!);
    expect(lines.find((l) => l.accountId === acct['1020'])!.debit).toBe('100.00');
    expect(lines.find((l) => l.accountId === acct['1020'])!.foreignAmount).toBe('90.00');
    // EUR -> EUR at the stated rate.
    const t2 = await createTransfer(ctx, {
      date: d('2026-03-11'),
      fromAccountId: acct['1020'],
      toAccountId: acct['1030'],
      amount: '50.00',
      exchangeRate: '1.12',
    });
    expect(t2.homeAmount).toBe('56.00');
    // EUR -> home with a home-amount override.
    const t3 = await createTransfer(ctx, {
      date: d('2026-03-12'),
      fromAccountId: acct['1030'],
      toAccountId: acct['1000'],
      amount: '20.00',
      exchangeRate: '1.11',
      homeAmount: '22.50',
    });
    expect(t3.homeAmount).toBe('22.50');
    expect((await linesOf(t3.postedEntryId!)).find((l) => l.accountId === acct['1030'])!.foreignAmount).toBe('20.00');
    await invariants();
  });

  it('foreign vendor credits: home A/P, applied with realized gain/loss, unapply, refund — A/P ties', async () => {
    const v = await createVendor(ctx, { displayName: 'Berlin Parts', currency: 'EUR' });
    const ap0 = Money.of(await bal('2000'));
    const bill = await createBill(ctx, { vendorId: v.id, date: d('2026-04-01'), lines: [{ accountId: acct['6300'], amount: '100.00' }] });
    expect(bill.currency).toBe('EUR');
    const vc = await createVendorCredit(ctx, {
      vendorId: v.id,
      date: d('2026-04-02'),
      exchangeRate: '1.20',
      lines: [
        { accountId: acct['6300'], amount: '25.00' },
        { accountId: acct['6100'], amount: '15.00' },
      ],
    });
    expect(vc.currency).toBe('EUR');
    expect(vc.homeTotal).toBe('48.00');
    expect(Money.of(await bal('2000')).minus(ap0).toFixed(2)).toBe('62.00'); // 110 - 48
    await invariants();

    // Apply 40 EUR: bill relieved 44.00 (1.10), credit used 48.00 (1.20) -> 4.00 to A/P + loss.
    const res = await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-04-03') });
    expect(res.bill.balanceDue).toBe('60.00');
    expect(Money.of(await bal('2000')).minus(ap0).toFixed(2)).toBe('66.00'); // 60 EUR x 1.10
    await invariants();

    // Unapply 10 EUR, then re-apply it.
    await unapplyFromBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '10.00', date: d('2026-04-04') });
    expect((await getBill(ctx, bill.id)).balanceDue).toBe('70.00');
    expect((await getVendorCredit(ctx, vc.id)).unapplied).toBe('10.00');
    await invariants();
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '10.00', date: d('2026-04-05') });
    await invariants();

    // Pay the remaining 60 EUR at 1.05: A/P is relieved by exactly what is left (66.00).
    await payBills(ctx, {
      vendorId: v.id,
      date: d('2026-04-10'),
      method: 'check',
      reference: '7001',
      paymentAccountId: acct['1000'],
      exchangeRate: '1.05',
      applications: [{ billId: bill.id, amountApplied: '60.00' }],
    });
    expect((await getBill(ctx, bill.id)).status).toBe('paid');
    expect(Money.of(await bal('2000')).minus(ap0).toFixed(2)).toBe('0.00');
    await invariants();

    // Refund a second EUR credit into the EUR bank at a different rate (realized gain).
    const vc2 = await createVendorCredit(ctx, { vendorId: v.id, date: d('2026-04-12'), lines: [{ accountId: acct['6300'], amount: '50.00' }] });
    expect(vc2.homeTotal).toBe('55.00');
    await invariants();
    const home = await createVendor(ctx, { displayName: 'Home Vendor' });
    const homeVc = await createVendorCredit(ctx, { vendorId: home.id, date: d('2026-04-12'), lines: [{ accountId: acct['6300'], amount: '5.00' }] });
    await expect(
      refundVendorCredit(ctx, { vendorCreditId: homeVc.id, bankAccountId: acct['1020'], amount: '5.00', date: d('2026-04-13') }),
    ).rejects.toThrow(/EUR/);
    const bankBefore = await bal('1020');
    const ref = await refundVendorCredit(ctx, { vendorCreditId: vc2.id, bankAccountId: acct['1020'], amount: '20.00', date: d('2026-04-13'), exchangeRate: '1.25' });
    expect(Money.of(await bal('1020')).minus(bankBefore).toFixed(2)).toBe('25.00');
    const refLines = await linesOf(ref.entry.id);
    expect(refLines.find((l) => l.accountId === acct['1020'])!.foreignAmount).toBe('20.00');
    expect(refLines.find((l) => l.accountId === acct['2000'])!.credit).toBe('22.00');
    expect((await getVendorCredit(ctx, vc2.id)).homeUnapplied).toBe('33.00');
    await invariants();
  });

  it('Loan Manager: a EUR loan paid from a EUR bank with realized gain/loss on principal; void together', async () => {
    const lender = await createVendor(ctx, { displayName: 'Banque Lyon', currency: 'EUR' });
    await postJournalEntry(ctx, {
      date: d('2026-05-01'),
      description: 'EUR loan proceeds',
      currency: 'EUR',
      exchangeRate: '1.10',
      lines: [
        { accountId: acct['1020'], debit: '1100.00', foreignAmount: '1000.00' },
        { accountId: acct['2600'], credit: '1100.00' },
      ],
    });
    const loan = await createLoan(ctx, {
      name: 'Euro note',
      lenderVendorId: lender.id,
      liabilityAccountId: acct['2600'],
      interestAccountId: acct['6800'],
      paymentAccountId: acct['1020'],
      originalAmount: '1000',
      annualRate: '6',
      termMonths: 12,
      originDate: d('2026-05-01'),
      firstPaymentDate: d('2026-06-01'),
      exchangeRate: '1.10',
    });
    expect(loan.currency).toBe('EUR');
    // A home-currency payment account is refused for a EUR loan (nothing written).
    await expect(setUpLoanPayment(ctx, loan.id, { kind: 'check', paymentAccountId: acct['1000'] })).rejects.toThrow(/home currency/);
    expect((await getLoan(ctx, loan.id)).paymentsMade).toBe(0);
    const lp = await setUpLoanPayment(ctx, loan.id, { kind: 'check', exchangeRate: '1.20' });
    expect(lp.fxEntryId).toBeTruthy();
    const after = await getLoan(ctx, loan.id);
    // Liability carried at the booked rate: balance (EUR) x 1.10.
    expect(Money.of(await bal('2600')).toFixed(2)).toBe(Money.round2(Money.of(after.balance).times('1.10')).toFixed(2));
    await invariants();

    await voidLoanPayment(ctx, loan.id, lp.id);
    expect(await bal('2600')).toBe('1100.00');
    const [fx] = await db.select().from(journalEntries).where(eq(journalEntries.id, lp.fxEntryId!));
    expect(fx.status).toBe('void');
    expect((await getLoan(ctx, loan.id)).balance).toBe('1000.00');
    const [row] = await db.select().from(loanPayments).where(eq(loanPayments.id, lp.id));
    expect(row.exchangeRate).toBeTruthy();
    await invariants();

    // Payment again for the Home Currency Adjustment test below.
    await setUpLoanPayment(ctx, loan.id, { kind: 'check', exchangeRate: '1.10' });
    await invariants();
  });

  it('A/R aging shows foreign invoices at their home value; Customer Balance Detail shows both currencies', async () => {
    const [cust] = await db.insert(customers).values({ companyId: ctx.companyId, displayName: 'Nice Client' }).returning();
    const inv = await createInvoice(ctx, {
      customerId: cust.id,
      date: d('2026-06-01'),
      currency: 'EUR',
      exchangeRate: '1.10',
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '100' }],
    } as never);
    await receivePayment(ctx, {
      customerId: cust.id,
      date: d('2026-06-05'),
      method: 'check',
      amount: '33.33',
      currency: 'EUR',
      exchangeRate: '1.20',
      depositAccountId: acct['1020'],
      applications: [{ invoiceId: inv.id, amountApplied: '33.33' }],
    } as never);
    const aging = await arAging(ctx, d('2026-12-31'));
    expect(aging.rows.find((r) => r.id === cust.id)!.total).toBe('73.34'); // 110.00 - round2(33.33 x 1.10)
    await invariants();
    const rep = await customerBalanceDetail(ctx, { customerId: cust.id, to: '2026-12-31' } as never);
    expect(rep.columns.some((c) => c.key === 'foreignAmount')).toBe(true);
    const invRow = rep.rows.find((r) => r.kind === 'data' && r.cells.foreignAmount === '100.00');
    expect(invRow?.cells.currency).toBe('EUR');
  });

  it('Home Currency Adjustment revalues bank, card, A/R, A/P and loans; A/R/A/P/loans reverse next day; void', async () => {
    const v = await createVendor(ctx, { displayName: 'Rome Supplies', currency: 'EUR' });
    await createBill(ctx, { vendorId: v.id, date: d('2026-06-10'), lines: [{ accountId: acct['6300'], amount: '200.00' }] });
    await invariants();

    const asOf = d('2026-06-30');
    const preview = await previewHomeCurrencyAdjustment(ctx, { date: asOf, rates: { EUR: '1.30' } });
    const kinds = new Set(preview.lines.map((l) => l.kind));
    expect(kinds.has('account')).toBe(true);
    expect(kinds.has('customer')).toBe(true);
    expect(kinds.has('vendor')).toBe(true);
    expect(kinds.has('loan')).toBe(true);
    const bankLine = preview.lines.find((l) => l.kind === 'account' && l.accountId === acct['1020'])!;
    expect(bankLine.newHomeBalance).toBe(Money.round2(Money.of(bankLine.foreignBalance).times('1.30')).toFixed(2));
    const cardLine = preview.lines.find((l) => l.accountId === acct['2150']);
    expect(cardLine).toBeTruthy(); // 0 EUR owed but -4.00 home -> revalued to 0
    expect(cardLine!.newHomeBalance).toBe('0.00');

    const reg0 = await withAccountCurrency(ctx, await accountRegister(ctx, acct['1020']));
    const hca = await createHomeCurrencyAdjustment(ctx, { date: asOf, rates: { EUR: '1.30' } });
    expect(hca.entryId).toBeTruthy();
    expect(hca.reversalEntryId).toBeTruthy();
    // Bank home balance = foreign balance x 1.30; the EUR register is unchanged.
    const reg1 = await withAccountCurrency(ctx, await accountRegister(ctx, acct['1020']));
    expect(reg1.foreignClosingBalance).toBe(reg0.foreignClosingBalance);
    expect(reg1.closingBalance).toBe(Money.round2(Money.of(reg1.foreignClosingBalance!).times('1.30')).toFixed(2));
    expect(await bal('2150')).toBe('0.00');
    // The currency list took the new rate.
    expect((await currencyRate(ctx, 'EUR')).rate.toFixed(2)).toBe('1.30');
    // A/R and A/P aging tie on the adjustment date and after the reversal.
    await invariants(asOf);
    await invariants(d('2026-12-31'));
    const [rev] = await db.select().from(journalEntries).where(eq(journalEntries.id, hca.reversalEntryId!));
    expect(rev.date.toISOString().slice(0, 10)).toBe('2026-07-01');
    // Reversal only covers the reversible lines (A/R, A/P, loans): bank stays revalued.
    const revLines = await linesOf(hca.reversalEntryId!);
    expect(revLines.some((l) => l.accountId === acct['1020'])).toBe(false);
    expect(revLines.some((l) => l.accountId === acct['2000'])).toBe(true);
    // Reconciliation is unaffected: the revaluation line is not offered for clearing.
    const clearable = await listClearable(ctx, eurBankId, d('2026-12-31'));
    expect(clearable.some((l) => l.journalEntryId === hca.entryId)).toBe(false);

    await voidHomeCurrencyAdjustment(ctx, hca.id);
    expect(Money.of(await bal('1020')).toFixed(2)).toBe(Money.of(reg0.closingBalance).toFixed(2));
    await invariants();
  });
});
