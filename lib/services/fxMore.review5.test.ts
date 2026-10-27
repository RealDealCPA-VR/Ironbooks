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
});
