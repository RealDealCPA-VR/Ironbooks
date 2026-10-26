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

  it('bank / card revaluations stay in date order: no back-dated adjustment, no void under a later one', async () => {
    const { voidHomeCurrencyAdjustment } = await import('./homeCurrencyAdjustment');
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
    const homeOf = async () => Money.of((await db.select().from(accounts).where(eq(accounts.id, acct['1020'])))[0].balance).toFixed(2);
    const jan = await createHomeCurrencyAdjustment(ctx, { date: midnight('2026-01-31'), rates: { EUR: '1.25' } });
    const feb = await createHomeCurrencyAdjustment(ctx, { date: midnight('2026-02-28'), rates: { EUR: '1.30' } });
    expect(await homeOf()).toBe('1300.00'); // EUR 1,000 at the last rate
    // Back-dated under February's: Feb's revaluation was computed without it (bank would end at 1,320).
    await expect(createHomeCurrencyAdjustment(ctx, { date: midnight('2026-01-15'), rates: { EUR: '1.22' } })).rejects.toMatchObject({ code: 'VALIDATION' });
    // Voiding January's under February's would leave the bank at 1,250 at February's 1.30.
    await expect(voidHomeCurrencyAdjustment(ctx, jan.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await homeOf()).toBe('1300.00');
    // Latest first is fine.
    await voidHomeCurrencyAdjustment(ctx, feb.id);
    await voidHomeCurrencyAdjustment(ctx, jan.id);
    expect(await homeOf()).toBe('1200.00');
  });

  it('editing a foreign transfer or deposit without retyping the rate keeps its booked rate (the forms send none)', async () => {
    const { createTransfer, updateTransfer } = await import('./transfers');
    const { createDeposit, updateDeposit } = await import('./deposits');
    acct['1025'] = (await createAccount(ctx, { code: '1025', name: 'Euro Savings', type: 'asset' as never, subtype: 'savings' })).id;
    await setAccountCurrency(ctx, acct['1025'], 'EUR');
    const tIn = { date: d('2026-03-02'), fromAccountId: acct['1020'], toAccountId: acct['1025'], amount: '100.00', exchangeRate: '1.20' };
    const t = await createTransfer(ctx, tIn);
    const dIn = { depositAccountId: acct['1020'], date: d('2026-03-03'), extraLines: [{ accountId: acct['3000'], amount: '100.00' }] };
    const dep = await createDeposit(ctx, { ...dIn, exchangeRate: '1.20' });
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.30' });
    // Memo-only edits, as the Transfer Funds / Make Deposits forms send them (no rate field).
    const t2 = await updateTransfer(ctx, t.id, { ...tIn, exchangeRate: undefined, memo: 'memo only' });
    expect(t2.homeAmount).toBe('120.00');
    expect(t2.postedEntryId).toBe(t.postedEntryId);
    const dep2 = await updateDeposit(ctx, dep.id, { ...dIn, memo: 'memo only' });
    expect(dep2.homeTotal).toBe('120.00');
    expect(dep2.postedEntryId).toBe(dep.postedEntryId);
    const [bank] = await db.select().from(accounts).where(eq(accounts.id, acct['1020']));
    expect(Money.of(bank.balance).toFixed(2)).toBe('0.00'); // +120 deposit, -120 transfer
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

  it('a foreign invoice with a payment-item line is open only for what A/R carries (HCA, foreign columns)', async () => {
    const { createItem } = await import('./items');
    const { foreignOpenReceivables, foreignAmountsByEntry } = await import('./fxSubledger');
    const pay = await createItem(ctx, { name: `Deposit received ${seq}`, type: 'payment' } as never);
    const c = await createCustomer(ctx, { displayName: `EUR deposit customer ${seq}` } as never);
    // EUR 1,000 invoice, EUR 400 received on the invoice itself: A/R carries EUR 600 (USD 720).
    const inv = await createInvoice(ctx, {
      customerId: c.id,
      date: d('2026-03-01'),
      currency: 'EUR',
      exchangeRate: '1.20',
      lines: [
        { accountId: acct['4000'], quantity: 1, rate: '1000.00' },
        { itemId: pay.id, quantity: 1, rate: '400.00' },
      ],
    } as never);
    expect(inv.balanceDue).toBe('600.00');
    const item = (await foreignOpenReceivables(ctx, d('2026-03-31'))).find((i) => i.id === inv.id);
    expect(item?.foreignOpen.toFixed(2)).toBe('600.00');
    expect(item?.homeOpen.toFixed(2)).toBe('720.00');
    const p = await previewHomeCurrencyAdjustment(ctx, { date: d('2026-03-31'), rates: { EUR: '1.25' } });
    expect(p.lines.find((l) => l.kind === 'customer')?.adjustment).toBe('30.00');
    // Customer Balance Detail's foreign column: the invoice moved EUR 600 onto A/R.
    expect((await foreignAmountsByEntry(ctx, [inv.postedEntryId!])).get(inv.postedEntryId!)?.amount.toFixed(2)).toBe('600.00');
    // Paid in full on the invoice: nothing left to revalue.
    const paid = await createInvoice(ctx, {
      customerId: c.id,
      date: d('2026-03-02'),
      currency: 'EUR',
      exchangeRate: '1.20',
      lines: [
        { accountId: acct['4000'], quantity: 1, rate: '500.00' },
        { itemId: pay.id, quantity: 1, rate: '500.00' },
      ],
    } as never);
    expect((await foreignOpenReceivables(ctx, d('2026-03-31'))).find((i) => i.id === paid.id)).toBeUndefined();
  });

  it('names and accounts in different currencies cannot be merged (the account-currency ledger would mix)', async () => {
    const { mergeAccounts, mergeVendors } = await import('./merge');
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
    acct['1030'] = (await createAccount(ctx, { code: '1030', name: 'Pound Bank', type: 'asset' as never, subtype: 'checking' })).id;
    await upsertCurrency(ctx, { code: 'GBP', name: 'Pound', rateToBase: '1.50' });
    await setAccountCurrency(ctx, acct['1030'], 'GBP');
    await expect(mergeAccounts(ctx, { fromId: acct['1020'], toId: acct['1030'] })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(mergeAccounts(ctx, { fromId: acct['1020'], toId: acct['1000'] })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(mergeAccounts(ctx, { fromId: acct['1000'], toId: acct['1020'] })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await foreignBalance(acct['1020'])).toBe('1000.00');
    const eur = await eurVendor('EUR maker');
    await createBill(ctx, { vendorId: eur.id, date: d('2026-02-01'), currency: 'EUR', exchangeRate: '1.20', lines: [{ accountId: acct['6000'], amount: '100.00' }] } as never);
    const usd = await createVendor(ctx, { displayName: `USD maker ${seq}` } as never);
    await expect(mergeVendors(ctx, { fromId: eur.id, toId: usd.id })).rejects.toMatchObject({ code: 'VALIDATION' });
    // Same currency still merges.
    const eur2 = await eurVendor('EUR maker two');
    await expect(mergeVendors(ctx, { fromId: eur2.id, toId: eur.id })).resolves.toBeTruthy();
  });

  it('a check from a foreign bank paying a card in the same currency moves the card by the exact amount (no round trip)', async () => {
    const { createExpense } = await import('./expenses');
    await upsertCurrency(ctx, { code: 'CAD', name: 'Canadian Dollar', rateToBase: '0.73' });
    acct['1040'] = (await createAccount(ctx, { code: '1040', name: 'CAD Bank', type: 'asset' as never, subtype: 'checking' })).id;
    acct['2160'] = (await createAccount(ctx, { code: '2160', name: 'CAD Card', type: 'liability' as never, subtype: 'credit_card' })).id;
    await setAccountCurrency(ctx, acct['1040'], 'CAD');
    await setAccountCurrency(ctx, acct['2160'], 'CAD');
    // CAD 100.02 at 0.73 = USD 73.01; converting back gives CAD 100.01.
    await createExpense(ctx, { payeeName: 'Card Co', date: d('2026-03-10'), method: 'check', paymentAccountId: acct['1040'], currency: 'CAD', exchangeRate: '0.73', lines: [{ accountId: acct['2160'], amount: '100.02' }] } as never);
    expect(await foreignBalance(acct['2160'])).toBe('-100.02');
    expect(await foreignBalance(acct['1040'])).toBe('-100.02');
    // The same payment downloaded on the CAD bank's feed and added against the CAD card.
    const { categorize } = await import('./bankCategorize');
    const { bankTransactions } = await import('@/lib/db/schema');
    const ba = await createBankAccount(ctx, { accountId: acct['1040'], bankName: 'CAD Bank', accountNumber: '7788' } as never);
    const [feed] = await db
      .insert(bankTransactions)
      .values({ companyId: ctx.companyId, bankAccountId: ba.id, date: d('2026-03-11'), description: 'CARD PAYMENT', amount: '-100.02', matched: false })
      .returning();
    await categorize(ctx, { bankTransactionId: feed.id, accountId: acct['2160'], exchangeRate: '0.73' });
    expect(await foreignBalance(acct['2160'])).toBe('-200.04');
    expect(await foreignBalance(acct['1040'])).toBe('-200.04');
  });

  it('a register entry is refused when the document would be written on an account in another currency', async () => {
    const { enterRegisterTransaction } = await import('./registerEntry');
    acct['2150'] = (await createAccount(ctx, { code: '2150', name: 'Euro Card', type: 'asset' as never, subtype: 'checking' })).id;
    await db.update(accounts).set({ type: 'liability' as never, subtype: 'credit_card' as never }).where(eq(accounts.id, acct['2150']));
    await setAccountCurrency(ctx, acct['2150'], 'EUR');
    const v = await eurVendor('Register EUR');
    // EUR 100 typed in the Euro Card register (paid down from home Checking) would be a USD 100 check.
    await expect(
      enterRegisterTransaction(ctx, acct['2150'], { date: d('2026-03-10'), payee: v.displayName, otherAccountId: acct['1000'], side: 'decrease', amount: '100.00' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    // 100 typed in the (home) expense register against the Euro Bank would be a EUR 100 check.
    await expect(
      enterRegisterTransaction(ctx, acct['6000'], { date: d('2026-03-10'), payee: v.displayName, otherAccountId: acct['1020'], side: 'increase', amount: '100.00' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    // 100 typed in the (home) income register against the Euro Bank would be a EUR 100 deposit.
    await expect(
      enterRegisterTransaction(ctx, acct['4000'], { date: d('2026-03-10'), payee: 'Sale', otherAccountId: acct['1020'], side: 'increase', amount: '100.00' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const lines = await db.select({ id: journalEntryLines.id }).from(journalEntryLines).where(eq(journalEntryLines.accountId, acct['1020']));
    expect(lines).toHaveLength(0);
    // In the Euro Bank's own register the amount is in EUR: a EUR 100 check at the list rate.
    const ok = await enterRegisterTransaction(ctx, acct['1020'], { date: d('2026-03-10'), payee: v.displayName, otherAccountId: acct['6000'], side: 'decrease', amount: '100.00' });
    expect(ok.kind).toBe('check');
    expect(await foreignBalance(acct['1020'])).toBe('-100.00');
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
