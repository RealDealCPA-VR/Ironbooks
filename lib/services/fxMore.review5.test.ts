/**
 * Review round 5 — multi-currency (team fx), second batch. Each test failed before its fix.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, journalEntryLines, users, vendors } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createAccount } from './accounts';
import { upsertCurrency, setBaseCurrency, setAccountCurrency, recordFxAdjustment } from './currencies';
import { createVendor } from './vendors';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { receivePayment } from './payments';
import { createHomeCurrencyAdjustment } from './homeCurrencyAdjustment';
import { trialBalance } from './reports';
import { createBankAccount } from './bankAccounts';
import { bankTransactions } from '@/lib/db/schema';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-fxmore');
let db: DB;
let ctx: ServiceContext;
let userId: string;
let acct: Record<string, string> = {};
let seq = 0;
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const midnight = (s: string) => new Date(`${s}T00:00:00.000Z`);

async function eurVendor(name: string) {
  const v = await createVendor(ctx, { displayName: `${name} ${seq}` } as never);
  await db.update(vendors).set({ currency: 'EUR' }).where(eq(vendors.id, v.id));
  return v;
}

async function linesOf(entryId: string) {
  return db
    .select({ accountId: journalEntryLines.accountId, debit: journalEntryLines.debit, credit: journalEntryLines.credit, name: accounts.name })
    .from(journalEntryLines)
    .innerJoin(accounts, eq(accounts.id, journalEntryLines.accountId))
    .where(eq(journalEntryLines.journalEntryId, entryId));
}

describe('review5 fx (second batch)', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'review5-fxmore@test.local', name: 'R5 FX', passwordHash: 'x' }).returning();
    userId = u.id;
  });
  beforeEach(async () => {
    seq += 1;
    const company = await createCompany(db, { name: `R5 FX2 Co ${seq}`, ownerId: userId });
    ctx = { db, companyId: company.id, userId };
    acct = {};
    for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) if (r.code) acct[r.code] = r.id;
    await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.20' });
    acct['1020'] = (await createAccount(ctx, { code: '1020', name: 'Euro Bank', type: 'asset' as never, subtype: 'checking' })).id;
    await setAccountCurrency(ctx, acct['1020'], 'EUR');
  });
  afterAll(async () => {
    await closeDb(TEST_DIR);
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle. */
    }
  });

  it('an FX Adjustment posts the gain / loss to Exchange Gain or Loss, not Other Income / Bank Fees', async () => {
    // A converted QuickBooks file: no 4900 / 6100 numbers (QB's accounts are unnumbered).
    await db.update(accounts).set({ code: 'X4900' }).where(eq(accounts.id, acct['4900']));
    await db.update(accounts).set({ code: 'X6100' }).where(eq(accounts.id, acct['6100']));
    const gain = await recordFxAdjustment(ctx, { accountId: acct['1020'], amount: '25.00', gain: true, date: d('2026-03-31') });
    const loss = await recordFxAdjustment(ctx, { accountId: acct['1020'], amount: '10.00', gain: false, date: d('2026-04-30') });
    const g = (await linesOf(gain.entryId)).find((l) => l.accountId !== acct['1020'])!;
    const l = (await linesOf(loss.entryId)).find((x) => x.accountId !== acct['1020'])!;
    expect(g.name).toMatch(/exchange gain/i);
    expect(g.credit).toBe('25.00');
    expect(l.accountId).toBe(g.accountId);
    expect(l.debit).toBe('10.00');
    // Adjusting the Exchange Gain/Loss account against itself is refused.
    await expect(recordFxAdjustment(ctx, { accountId: g.accountId, amount: '1', gain: true, date: d('2026-04-30') })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('a payment at the same list rate as its invoice books no exchange gain or loss (rate kept to 8 decimals)', async () => {
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.08234567' });
    const c = await createCustomer(ctx, { displayName: `EUR precise ${seq}` } as never);
    const inv = await createInvoice(ctx, { customerId: c.id, date: d('2026-03-01'), currency: 'EUR', lines: [{ accountId: acct['4000'], quantity: 1, rate: '100000.00' }] } as never);
    const { payment, entry } = await receivePayment(ctx, {
      customerId: c.id,
      date: d('2026-03-05'),
      amount: '100000.00',
      method: 'ach',
      depositAccountId: acct['1020'],
      currency: 'EUR',
      applications: [{ invoiceId: inv.id, amountApplied: '100000.00' }],
    } as never);
    expect(Money.of(payment.exchangeRate!).toFixed(8)).toBe('1.08234567');
    const lines = await linesOf(entry!.id);
    expect(lines.filter((x) => /exchange/i.test(x.name))).toHaveLength(0);
    expect(lines.find((x) => x.accountId === acct['1020'])?.debit).toBe('108234.57');
  });

  it('editing a foreign loan without retyping the rate keeps the rate it was booked at', async () => {
    const { createLoan, updateLoan } = await import('./loans');
    const lender = await eurVendor('EUR bank lender');
    const liab = (await createAccount(ctx, { code: '2600', name: 'EUR Loan', type: 'liability' as never, subtype: 'long_term_liability' })).id;
    const interest = (await createAccount(ctx, { code: '6800', name: 'Interest Expense', type: 'expense' as never, subtype: 'operating_expenses' })).id;
    const input = {
      name: `EUR loan ${seq}`,
      lenderVendorId: lender.id,
      liabilityAccountId: liab,
      interestAccountId: interest,
      originalAmount: '10000.00',
      annualRate: '5',
      termMonths: 24,
      originDate: d('2026-01-01'),
      firstPaymentDate: d('2026-02-01'),
      exchangeRate: '1.20',
    };
    const loan = await createLoan(ctx, input);
    expect(Money.of(loan.exchangeRate!).toFixed(2)).toBe('1.20');
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.30' });
    // The Loan Manager form sends a blank rate when the field is left empty ("Blank = list rate").
    const edited = await updateLoan(ctx, loan.id, { ...input, notes: 'renamed only', exchangeRate: null });
    expect(Money.of(edited.exchangeRate!).toFixed(2)).toBe('1.20');
  });

  it('a home-currency statement of a foreign customer shows the Home Currency Adjustment and its reversal', async () => {
    const { customerStatement, customerArLedgerBalance } = await import('./statements');
    const c = await createCustomer(ctx, { displayName: `EUR statement ${seq}` } as never);
    await createInvoice(ctx, { customerId: c.id, date: d('2026-02-01'), currency: 'EUR', exchangeRate: '1.20', lines: [{ accountId: acct['4000'], quantity: 1, rate: '1000.00' }] } as never);
    await createHomeCurrencyAdjustment(ctx, { date: midnight('2026-03-31'), rates: { EUR: '1.25' } });
    // March statement: A/R carries the revaluation on 3/31.
    const march = await customerStatement(ctx, c.id, { from: midnight('2026-03-01'), to: midnight('2026-03-31') });
    expect(march.closingBalance).toBe(await customerArLedgerBalance(ctx, c.id, midnight('2026-03-31')));
    expect(march.closingBalance).toBe('1250.00');
    // April statement: opens with the revalued 1,250 and the 4/1 reversal takes it back to 1,200.
    const april = await customerStatement(ctx, c.id, { from: midnight('2026-04-01'), to: midnight('2026-04-30') });
    expect(april.openingBalance).toBe('1250.00');
    expect(april.closingBalance).toBe('1200.00');
    expect(april.closingBalance).toBe(await customerArLedgerBalance(ctx, c.id, midnight('2026-04-30')));
    // Whole history: the pair nets to zero.
    const all = await customerStatement(ctx, c.id);
    expect(all.closingBalance).toBe('1200.00');
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('a back-dated Home Currency Adjustment does not replace the current currency list rate with an old one', async () => {
    const { listCurrencies } = await import('./currencies');
    const c = await createCustomer(ctx, { displayName: `EUR catch-up ${seq}` } as never);
    await createInvoice(ctx, { customerId: c.id, date: d('2025-11-01'), currency: 'EUR', exchangeRate: '1.20', lines: [{ accountId: acct['4000'], quantity: 1, rate: '1000.00' }] } as never);
    // Today's rate is 1.17; last year's year-end revaluation is entered late, at that date's 1.10.
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.17' });
    await createHomeCurrencyAdjustment(ctx, { date: midnight('2025-12-31'), rates: { EUR: '1.10' } });
    const eur = (await listCurrencies(ctx)).find((x) => x.code === 'EUR')!;
    expect(Money.of(eur.rateToBase).toFixed(2)).toBe('1.17');
    // An adjustment dated today does update the list (as before).
    // (The date picker's today is the LOCAL calendar day, stored at UTC midnight.)
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    await createHomeCurrencyAdjustment(ctx, { date: midnight(today), rates: { EUR: '1.15' } });
    const eur2 = (await listCurrencies(ctx)).find((x) => x.code === 'EUR')!;
    expect(Money.of(eur2.rateToBase).toFixed(2)).toBe('1.15');
  });

  it('a bank-feed line is not added against a bank or card account in another currency (no invented amount)', async () => {
    const { categorize } = await import('./bankCategorize');
    const feedLine = async (accountId: string, amount: string) => {
      const ba = await createBankAccount(ctx, { accountId, bankName: `Bank ${accountId.slice(0, 4)}`, accountNumber: `${seq}${amount}` } as never);
      const [t] = await db
        .insert(bankTransactions)
        .values({ companyId: ctx.companyId, bankAccountId: ba.id, date: d('2026-03-11'), description: 'TRANSFER', amount, matched: false })
        .returning();
      return t.id;
    };
    // USD 100 leaving Checking "to the Euro bank": the EUR amount that arrived is unknown.
    const usdOut = await feedLine(acct['1000'], '-100.00');
    await expect(categorize(ctx, { bankTransactionId: usdOut, accountId: acct['1020'] })).rejects.toMatchObject({ code: 'VALIDATION' });
    // A EUR feed line against a GBP card.
    await upsertCurrency(ctx, { code: 'GBP', name: 'Pound', rateToBase: '1.50' });
    const gbpCard = (await createAccount(ctx, { code: '2170', name: 'GBP Card', type: 'liability' as never, subtype: 'credit_card' })).id;
    await setAccountCurrency(ctx, gbpCard, 'GBP');
    const eurOut = await feedLine(acct['1020'], '-50.00');
    await expect(categorize(ctx, { bankTransactionId: eurOut, accountId: gbpCard })).rejects.toMatchObject({ code: 'VALIDATION' });
    // Nothing was posted to either foreign account.
    const [eurBank] = await db.select().from(accounts).where(eq(accounts.id, acct['1020']));
    expect(Money.of(eurBank.balance).toFixed(2)).toBe('0.00');
    // The same lines against a home-currency account are fine.
    await expect(categorize(ctx, { bankTransactionId: usdOut, accountId: acct['6100'] })).resolves.toBeTruthy();
    await expect(categorize(ctx, { bankTransactionId: eurOut, accountId: acct['6100'] })).resolves.toBeTruthy();
  });

  it('a check, bill or vendor credit line on a bank / card account in another currency is refused (no invented amount)', async () => {
    const { createExpense } = await import('./expenses');
    const { createBill } = await import('./bills');
    const { createVendorCredit } = await import('./vendorCredits');
    acct['2150'] = (await createAccount(ctx, { code: '2150', name: 'Euro Card', type: 'liability' as never, subtype: 'credit_card' })).id;
    await setAccountCurrency(ctx, acct['2150'], 'EUR');
    // A USD check from Checking "paying the Euro card": the EUR amount it pays off is unknown.
    await expect(
      createExpense(ctx, { payeeName: 'Card Co', date: d('2026-03-10'), method: 'check', paymentAccountId: acct['1000'], lines: [{ accountId: acct['2150'], amount: '100.00' }] } as never),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    // A home vendor's bill with a line on the Euro bank.
    const homeVendor = await createVendor(ctx, { displayName: `Home vendor ${seq}` } as never);
    await expect(
      createBill(ctx, { vendorId: homeVendor.id, date: d('2026-03-10'), lines: [{ accountId: acct['1020'], amount: '100.00' }] } as never),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      createVendorCredit(ctx, { vendorId: homeVendor.id, date: d('2026-03-10'), lines: [{ accountId: acct['2150'], amount: '10.00' }] } as never),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const [card] = await db.select().from(accounts).where(eq(accounts.id, acct['2150']));
    expect(Money.of(card.balance).toFixed(2)).toBe('0.00');
    // Same currency (a EUR check from the Euro bank paying the Euro card) is fine.
    await expect(
      createExpense(ctx, { payeeName: 'Card Co', date: d('2026-03-10'), method: 'check', paymentAccountId: acct['1020'], lines: [{ accountId: acct['2150'], amount: '100.00' }] } as never),
    ).resolves.toBeTruthy();
  });

  it('paying off a foreign loan leaves nothing on its liability account (no rounding cents)', async () => {
    const { createLoan, setUpLoanPayment } = await import('./loans');
    const { postJournalEntry } = await import('./posting');
    const lender = await eurVendor('EUR lender');
    const liab = (await createAccount(ctx, { code: '2610', name: 'EUR Note', type: 'liability' as never, subtype: 'long_term_liability' })).id;
    const interest = (await createAccount(ctx, { code: '6810', name: 'Interest', type: 'expense' as never, subtype: 'operating_expenses' })).id;
    const loan = await createLoan(ctx, {
      name: `EUR note ${seq}`, lenderVendorId: lender.id, liabilityAccountId: liab, interestAccountId: interest, paymentAccountId: acct['1020'],
      originalAmount: '1000.00', annualRate: '0', termMonths: 3, originDate: d('2026-01-01'), firstPaymentDate: d('2026-02-01'), exchangeRate: '1.2345',
    });
    // The loan proceeds: EUR 1,000 into the Euro bank at the loan's rate (USD 1,234.50).
    await postJournalEntry(ctx, {
      date: d('2026-01-01'), description: 'Loan proceeds', currency: 'EUR', exchangeRate: '1.2345',
      lines: [{ accountId: acct['1020'], debit: '1234.50', foreignAmount: '1000.00' }, { accountId: liab, credit: '1234.50' }],
    });
    for (const [i, p] of ['333.33', '333.33', '333.34'].entries()) {
      await setUpLoanPayment(ctx, loan.id, { kind: 'check', date: d(`2026-0${i + 2}-01`), principal: p, interest: '0', exchangeRate: '1.2345' });
    }
    const [l] = await db.select().from(accounts).where(eq(accounts.id, liab));
    expect(Money.of(l.balance).toFixed(2)).toBe('0.00');
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('billable costs from a foreign bill are billed at what they cost in home currency', async () => {
    const { createBill } = await import('./bills');
    const { listUnbilled, createInvoiceWithBillables } = await import('./billables');
    const v = await eurVendor('EUR subcontractor');
    const c = await createCustomer(ctx, { displayName: `Home client ${seq}` } as never);
    // EUR 100.00 at 1.20 = USD 120.00 of Office Supplies, billable to a home-currency customer.
    const bill = await createBill(ctx, { vendorId: v.id, date: d('2026-03-01'), currency: 'EUR', exchangeRate: '1.20', lines: [{ accountId: acct['6300'], amount: '100.00', customerId: c.id }] } as never);
    const unbilled = await listUnbilled(ctx, c.id);
    expect(unbilled.costs).toHaveLength(1);
    expect(unbilled.costs[0].amount).toBe('120.00');
    const inv = await createInvoiceWithBillables(ctx, { customerId: c.id, date: d('2026-03-05'), lines: [] } as never, { billLineIds: [unbilled.costs[0].id] });
    expect(inv.total).toBe('120.00');
    // Track reimbursed expenses as income is off: the reimbursement nets the expense to zero.
    const [supplies] = await db.select().from(accounts).where(eq(accounts.id, acct['6300']));
    expect(Money.of(supplies.balance).toFixed(2)).toBe('0.00');
    expect(bill.id).toBeTruthy();
  });

  it('landed cost from a foreign freight bill moves its home cost into inventory', async () => {
    const { createBill, getBill } = await import('./bills');
    const { createItemReceipt } = await import('./itemReceipts');
    const { listLandedCostSources, allocateLandedCost } = await import('./landedCost');
    const { items } = await import('@/lib/db/schema');
    const freightIn = (await createAccount(ctx, { code: '6150', name: 'Freight In', type: 'expense' as never, subtype: 'operating_expenses' })).id;
    const [widget] = await db
      .insert(items)
      .values({ companyId: ctx.companyId, name: `Widget ${seq}`, type: 'inventory', quantityOnHand: '0', averageCost: '0' } as never)
      .returning();
    const supplier = await createVendor(ctx, { displayName: `Home supplier ${seq}` } as never);
    const receipt = await createItemReceipt(ctx, { vendorId: supplier.id, date: d('2026-05-02'), lines: [{ itemId: widget.id, quantity: 10, unitCost: 10 }] } as never);
    // EUR 100 of freight at 1.20: USD 120 on Freight In.
    const forwarder = await eurVendor('EUR forwarder');
    const bill = await createBill(ctx, { vendorId: forwarder.id, date: d('2026-05-03'), currency: 'EUR', exchangeRate: '1.20', lines: [{ accountId: freightIn, description: 'Freight', amount: '100.00' }] } as never);
    const line = (await getBill(ctx, bill.id)).lines[0];
    const src = (await listLandedCostSources(ctx, { billId: bill.id }))[0];
    expect(src.remaining).toBe('120.00');
    await allocateLandedCost(ctx, { billId: bill.id, billLineId: line.id, method: 'quantity', itemReceiptIds: [receipt.id] } as never);
    const [fi] = await db.select().from(accounts).where(eq(accounts.id, freightIn));
    expect(Money.of(fi.balance).toFixed(2)).toBe('0.00');
    const [w] = await db.select().from(items).where(eq(items.id, widget.id));
    expect(Money.of(w.averageCost!).toFixed(2)).toBe('22.00'); // (100 + 120) / 10
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });
});
