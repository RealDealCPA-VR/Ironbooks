/**
 * Review round 5 — multi-currency (team fx). Each test failed before its fix.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, currencies, homeCurrencyAdjustments, journalEntries, journalEntryLines, users, vendors } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createAccount } from './accounts';
import {
  upsertCurrency,
  setBaseCurrency,
  setAccountCurrency,
  recordFxAdjustment,
  getHomeCurrencyCode,
  listCurrencies,
} from './currencies';
import { createVendor } from './vendors';
import { createCustomer } from './customers';
import { createBill } from './bills';
import { createInvoice } from './invoices';
import { receivePayment } from './payments';
import { postJournalEntry } from './posting';
import { accountRegister } from './journal';
import { withAccountCurrency } from './fxLedger';
import { createHomeCurrencyAdjustment, previewHomeCurrencyAdjustment } from './homeCurrencyAdjustment';
import { createBankAccount } from './bankAccounts';
import { startReconciliation, completeReconciliation, payCreditCardBalance } from './reconcile';
import { trialBalance } from './reports';
import { arAging } from './reportsExtra';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-fx');
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

async function foreignBalance(accountId: string): Promise<string> {
  const reg = await withAccountCurrency(ctx, await accountRegister(ctx, accountId), {});
  return reg.foreignClosingBalance ?? 'home';
}

describe('review5 fx', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'review5-fx@test.local', name: 'R5 FX', passwordHash: 'x' }).returning();
    userId = u.id;
  });
  beforeEach(async () => {
    seq += 1;
    const company = await createCompany(db, { name: `R5 FX Co ${seq}`, ownerId: userId });
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

  it('the home currency cannot be changed once foreign-currency data exists (books would be re-denominated)', async () => {
    const v = await eurVendor('EUR supplier');
    await createBill(ctx, { vendorId: v.id, date: d('2026-02-01'), currency: 'EUR', exchangeRate: '1.20', lines: [{ accountId: acct['6000'], amount: '100.00' }] } as never);
    await expect(setBaseCurrency(ctx, { code: 'EUR', name: 'Euro' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await getHomeCurrencyCode(ctx)).toBe('USD');
    const eur = (await listCurrencies(ctx)).find((c) => c.code === 'EUR');
    expect(eur?.isBase).toBe(false);
    expect(Money.of(eur!.rateToBase).toFixed(2)).toBe('1.20');
    // Re-saving the same home currency (e.g. its name) is still fine.
    await expect(setBaseCurrency(ctx, { code: 'USD', name: 'United States Dollar' })).resolves.toMatchObject({ isBase: true });
  });

  it('changing the home currency before any foreign data rebases the other rates', async () => {
    // USD home, EUR 1.20 USD. Switching home to EUR: 1 USD = 1/1.2 EUR.
    await upsertCurrency(ctx, { code: 'GBP', name: 'Pound', rateToBase: '1.50' });
    await db.update(accounts).set({ currency: null }).where(eq(accounts.id, acct['1020']));
    await setBaseCurrency(ctx, { code: 'EUR', name: 'Euro' });
    const list = await listCurrencies(ctx);
    const by = Object.fromEntries(list.map((c) => [c.code, c]));
    expect(by.EUR.isBase).toBe(true);
    expect(Money.of(by.USD.rateToBase).toFixed(6)).toBe('0.833333');
    expect(Money.of(by.GBP.rateToBase).toFixed(6)).toBe('1.250000');
    expect(list.filter((c) => c.isBase)).toHaveLength(1);
  });

  it('an FX adjustment on a foreign-currency bank account changes its home value only (EUR balance unchanged)', async () => {
    await postJournalEntry(ctx, {
      date: d('2026-01-02'),
      description: 'Opening EUR',
      currency: 'EUR',
      exchangeRate: '1.20',
      lines: [
        { accountId: acct['1020'], debit: '1200.00', foreignAmount: '1000.00' },
        { accountId: acct['3000'], credit: '1200.00' },
      ],
    });
    expect(await foreignBalance(acct['1020'])).toBe('1000.00');
    await recordFxAdjustment(ctx, { accountId: acct['1020'], amount: '30.00', gain: true, date: d('2026-01-31') });
    await recordFxAdjustment(ctx, { accountId: acct['1020'], amount: '10.00', gain: false, date: d('2026-02-28') });
    expect(await foreignBalance(acct['1020'])).toBe('1000.00');
    const [a] = await db.select().from(accounts).where(eq(accounts.id, acct['1020']));
    expect(Money.of(a.balance).toFixed(2)).toBe('1220.00');
  });

  it('currency list input: a rate or code that is not valid is a plain validation error', async () => {
    await expect(upsertCurrency(ctx, { code: 'GBP', name: 'Pound', rateToBase: 'abc' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(upsertCurrency(ctx, { code: 'GBP', name: 'Pound', rateToBase: '1e12' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(upsertCurrency(ctx, { code: 'GBP', name: 'Pound', rateToBase: 'Infinity' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(upsertCurrency(ctx, { code: 'G1', name: 'Pound', rateToBase: '1.5' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(upsertCurrency(ctx, { code: 'GBP', name: 'P'.repeat(101), rateToBase: '1.5' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(upsertCurrency(ctx, { code: 123 as never, name: 'Pound', rateToBase: '1.5' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(setBaseCurrency(ctx, { code: 'U$D', name: 'Dollar' })).rejects.toMatchObject({ code: 'VALIDATION' });
    // Lower case / padded codes are normalised (the currency list stays one row per code).
    await upsertCurrency(ctx, { code: ' gbp ', name: 'Pound', rateToBase: '1.5' });
    const rows = await db.select().from(currencies).where(and(eq(currencies.companyId, ctx.companyId), eq(currencies.code, 'GBP')));
    expect(rows).toHaveLength(1);
  });

  it('adding the same currency twice at once leaves one row in the currency list', async () => {
    await Promise.allSettled([
      upsertCurrency(ctx, { code: 'CAD', name: 'Canadian Dollar', rateToBase: '0.75' }),
      upsertCurrency(ctx, { code: 'CAD', name: 'Canadian Dollar', rateToBase: '0.76' }),
    ]);
    const rows = await db.select().from(currencies).where(and(eq(currencies.companyId, ctx.companyId), eq(currencies.code, 'CAD')));
    expect(rows).toHaveLength(1);
  });

  it('a double-submitted Home Currency Adjustment posts the revaluation once', async () => {
    await postJournalEntry(ctx, {
      date: d('2026-01-02'),
      description: 'Opening EUR',
      currency: 'EUR',
      exchangeRate: '1.20',
      lines: [
        { accountId: acct['1020'], debit: '1200.00', foreignAmount: '1000.00' },
        { accountId: acct['3000'], credit: '1200.00' },
      ],
    });
    const input = { date: midnight('2026-01-31'), rates: { EUR: '1.25' } };
    await Promise.allSettled([createHomeCurrencyAdjustment(ctx, input), createHomeCurrencyAdjustment(ctx, input)]);
    const live = await db
      .select()
      .from(homeCurrencyAdjustments)
      .where(and(eq(homeCurrencyAdjustments.companyId, ctx.companyId), sql`${homeCurrencyAdjustments.voidedAt} IS NULL`));
    expect(live).toHaveLength(1);
    const [a] = await db.select().from(accounts).where(eq(accounts.id, acct['1020']));
    expect(Money.of(a.balance).toFixed(2)).toBe('1250.00');
  });

  it('Home Currency Adjustment as of a date revalues everything dated that day (whole as-of day)', async () => {
    const c = await createCustomer(ctx, { displayName: `EUR customer ${seq}` } as never);
    // Dated 3/31 at noon; the adjustment as of 3/31 (date picker: midnight) must include it, as
    // the A/R aging and the balance sheet as of 3/31 do.
    await createInvoice(ctx, { customerId: c.id, date: d('2026-03-31'), currency: 'EUR', exchangeRate: '1.20', lines: [{ accountId: acct['4000'], quantity: 1, rate: '1000.00' }] } as never);
    await postJournalEntry(ctx, {
      date: d('2026-03-31'),
      description: 'EUR in',
      currency: 'EUR',
      exchangeRate: '1.20',
      lines: [
        { accountId: acct['1020'], debit: '120.00', foreignAmount: '100.00' },
        { accountId: acct['3000'], credit: '120.00' },
      ],
    });
    const p = await previewHomeCurrencyAdjustment(ctx, { date: midnight('2026-03-31'), rates: { EUR: '1.25' } });
    const cust = p.lines.find((l) => l.kind === 'customer');
    expect(cust?.adjustment).toBe('50.00');
    const bank = p.lines.find((l) => l.kind === 'account');
    expect(bank?.adjustment).toBe('5.00');
    await createHomeCurrencyAdjustment(ctx, { date: midnight('2026-03-31'), rates: { EUR: '1.25' } });
    const ar = await arAging(ctx, midnight('2026-03-31'));
    const tb = await trialBalance(ctx, midnight('2026-03-31'));
    const arTb = tb.rows.find((r: { accountId: string }) => r.accountId === acct['1200']) as { debit?: string; credit?: string } | undefined;
    expect(Money.of(ar.totals.total).toFixed(2)).toBe(Money.of(arTb?.debit ?? 0).minus(Money.of(arTb?.credit ?? 0)).toFixed(2));
    expect(Money.of(ar.totals.total).toFixed(2)).toBe('1250.00');
  });

  it('a foreign register filtered to a date shows the last day in the account currency too', async () => {
    await postJournalEntry(ctx, {
      date: d('2026-03-31'),
      description: 'EUR in',
      currency: 'EUR',
      exchangeRate: '1.20',
      lines: [
        { accountId: acct['1020'], debit: '120.00', foreignAmount: '100.00' },
        { accountId: acct['3000'], credit: '120.00' },
      ],
    });
    const opts = { from: midnight('2026-03-01'), to: midnight('2026-03-31') };
    const reg = await withAccountCurrency(ctx, await accountRegister(ctx, acct['1020'], opts), opts);
    expect(reg.rows).toHaveLength(1);
    expect((reg.rows[0] as { foreignDebit: string | null }).foreignDebit).toBe('100.00');
    expect(reg.foreignClosingBalance).toBe('100.00');
  });

  it('Receive Payments refuses a deposit account in another currency than the payment', async () => {
    acct['1030'] = (await createAccount(ctx, { code: '1030', name: 'Pound Bank', type: 'asset' as never, subtype: 'checking' })).id;
    await upsertCurrency(ctx, { code: 'GBP', name: 'Pound', rateToBase: '1.50' });
    await setAccountCurrency(ctx, acct['1030'], 'GBP');
    const c = await createCustomer(ctx, { displayName: `EUR payer ${seq}` } as never);
    const inv = await createInvoice(ctx, { customerId: c.id, date: d('2026-03-01'), currency: 'EUR', exchangeRate: '1.20', lines: [{ accountId: acct['4000'], quantity: 1, rate: '100.00' }] } as never);
    await expect(
      receivePayment(ctx, { customerId: c.id, date: d('2026-03-05'), amount: '100.00', method: 'ach', depositAccountId: acct['1030'], currency: 'EUR', exchangeRate: '1.20', applications: [{ invoiceId: inv.id, amountApplied: '100.00' }] } as never),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const h = await createCustomer(ctx, { displayName: `USD payer ${seq}` } as never);
    const hinv = await createInvoice(ctx, { customerId: h.id, date: d('2026-03-01'), lines: [{ accountId: acct['4000'], quantity: 1, rate: '100.00' }] } as never);
    await expect(
      receivePayment(ctx, { customerId: h.id, date: d('2026-03-05'), amount: '100.00', method: 'ach', depositAccountId: acct['1020'], applications: [{ invoiceId: hinv.id, amountApplied: '100.00' }] } as never),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    // Same currency, or home currency (Undeposited Funds), is fine.
    await expect(
      receivePayment(ctx, { customerId: c.id, date: d('2026-03-05'), amount: '100.00', method: 'ach', depositAccountId: acct['1020'], currency: 'EUR', exchangeRate: '1.20', applications: [{ invoiceId: inv.id, amountApplied: '100.00' }] } as never),
    ).resolves.toBeTruthy();
  });

  it('a foreign invoice without a typed rate takes the currency list rate (not 1); an edit keeps its saved rate', async () => {
    const { updateInvoice } = await import('./invoices');
    const c = await createCustomer(ctx, { displayName: `EUR buyer ${seq}` } as never);
    const line = [{ accountId: acct['4000'], quantity: 1, rate: '1000.00' }];
    // The invoice form leaves Exchange Rate blank (placeholder "1.00") and types the currency in lower case.
    const inv = await createInvoice(ctx, { customerId: c.id, date: d('2026-03-01'), currency: 'eur', lines: line } as never);
    expect(inv.currency).toBe('EUR');
    expect(Money.of(inv.exchangeRate!).toFixed(4)).toBe('1.2000');
    const [ar] = await db
      .select({ debit: journalEntryLines.debit })
      .from(journalEntryLines)
      .where(and(eq(journalEntryLines.journalEntryId, inv.postedEntryId!), eq(journalEntryLines.accountId, acct['1200'])));
    expect(ar.debit).toBe('1200.00');
    // The list rate moves; a memo edit that leaves the rate blank keeps the booked 1.20.
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.30' });
    const edited = await updateInvoice(ctx, inv.id, { customerId: c.id, date: d('2026-03-01'), currency: 'EUR', memo: 'edited', lines: line } as never);
    expect(Money.of(edited.exchangeRate!).toFixed(4)).toBe('1.2000');
    // The home currency typed as the currency is a home invoice at rate 1 (a stray rate is ignored).
    const home = await createInvoice(ctx, { customerId: c.id, date: d('2026-03-01'), currency: 'USD', exchangeRate: '1.30', lines: line } as never);
    expect(home.currency).toBeNull();
    expect(Money.of(home.exchangeRate!).toFixed(4)).toBe('1.0000');
    // A currency that is not in the list needs a typed rate.
    await expect(createInvoice(ctx, { customerId: c.id, date: d('2026-03-01'), currency: 'JPY', lines: line } as never)).rejects.toMatchObject({ code: 'VALIDATION' });
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('home-currency documents refuse a foreign-currency bank (sales receipt, credit memo refund, payment refund)', async () => {
    const { createSalesReceipt } = await import('./salesReceipts');
    const { createCreditMemo, refundCreditMemo } = await import('./creditMemos');
    const { refundPayment } = await import('./payments');
    const c = await createCustomer(ctx, { displayName: `Walk-in ${seq}` } as never);
    // A home-currency sale deposited straight into the EUR bank would post USD 100 as EUR 83.33.
    await expect(
      createSalesReceipt(ctx, { customerId: c.id, date: d('2026-03-01'), depositAccountId: acct['1020'], lines: [{ accountId: acct['4000'], quantity: 1, rate: '100.00' }] } as never),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const cm = await createCreditMemo(ctx, { customerId: c.id, date: d('2026-03-01'), lines: [{ accountId: acct['4000'], quantity: 1, rate: '50.00' }] } as never);
    await expect(refundCreditMemo(ctx, { creditMemoId: cm.id, bankAccountId: acct['1020'], amount: '50.00', date: d('2026-03-02') })).rejects.toMatchObject({ code: 'VALIDATION' });
    // A home overpayment refunded from the EUR bank.
    const pay = await receivePayment(ctx, { customerId: c.id, date: d('2026-03-03'), amount: '40.00', method: 'cash', applications: [] } as never);
    await expect(refundPayment(ctx, { paymentId: pay.payment.id, bankAccountId: acct['1020'], amount: '40.00', date: d('2026-03-04') })).rejects.toMatchObject({ code: 'VALIDATION' });
    // A EUR overpayment refunded from a GBP bank.
    acct['1030'] = (await createAccount(ctx, { code: '1030', name: 'Pound Bank', type: 'asset' as never, subtype: 'checking' })).id;
    await upsertCurrency(ctx, { code: 'GBP', name: 'Pound', rateToBase: '1.50' });
    await setAccountCurrency(ctx, acct['1030'], 'GBP');
    const eurPay = await receivePayment(ctx, { customerId: c.id, date: d('2026-03-03'), amount: '40.00', method: 'ach', depositAccountId: acct['1020'], currency: 'EUR', exchangeRate: '1.20', applications: [] } as never);
    await expect(refundPayment(ctx, { paymentId: eurPay.payment.id, bankAccountId: acct['1030'], amount: '40.00', date: d('2026-03-04') })).rejects.toMatchObject({ code: 'VALIDATION' });
    // Home-currency banks still work.
    await expect(refundCreditMemo(ctx, { creditMemoId: cm.id, bankAccountId: acct['1000'], amount: '50.00', date: d('2026-03-02') })).resolves.toBeTruthy();
    await expect(refundPayment(ctx, { paymentId: eurPay.payment.id, bankAccountId: acct['1020'], amount: '40.00', date: d('2026-03-04') })).resolves.toBeTruthy();
  });

  it('a double-submitted payment of a foreign credit card balance posts once', async () => {
    acct['2150'] = (await createAccount(ctx, { code: '2150', name: 'Euro Card', type: 'liability' as never, subtype: 'credit_card' })).id;
    await setAccountCurrency(ctx, acct['2150'], 'EUR');
    const v = await eurVendor('EUR shop');
    const { createExpense } = await import('./expenses');
    await createExpense(ctx, { vendorId: v.id, date: d('2026-03-02'), method: 'credit_card', paymentAccountId: acct['2150'], currency: 'EUR', exchangeRate: '1.20', lines: [{ accountId: acct['6000'], amount: '100.00' }] } as never);
    const ba = await createBankAccount(ctx, { accountId: acct['2150'], bankName: 'Card Co', accountNumber: '4111' } as never);
    const rec = await startReconciliation(ctx, { bankAccountId: ba.id, statementDate: d('2026-03-31'), statementBalance: '0.00' } as never);
    await completeReconciliation(ctx, rec.id).catch(() => undefined);
    const [r] = await db.execute(sql`SELECT status FROM reconciliations WHERE id = ${rec.id}`).then((x) => x.rows as Array<{ status: string }>);
    if (r.status !== 'completed') await db.execute(sql`UPDATE reconciliations SET status = 'completed' WHERE id = ${rec.id}`);
    const input = { paymentAccountId: acct['1020'], amount: '100.00', date: d('2026-04-01'), exchangeRate: '1.20' };
    await Promise.allSettled([payCreditCardBalance(ctx, rec.id, input), payCreditCardBalance(ctx, rec.id, input)]);
    const pays = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.sourceRef, `cc-payment:${rec.id}`), eq(journalEntries.status, 'posted')));
    expect(pays).toHaveLength(1);
    void journalEntryLines;
  });
});
