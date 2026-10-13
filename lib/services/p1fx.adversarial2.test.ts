/**
 * P1 round, team FX — adversarial QA, part 2 (tester, resumed run).
 *
 * Rollback-on-refusal and reversal scenarios not covered by p1fx.test.ts / p1fx.adversarial.test.ts.
 * Every scenario ends with: TB balanced, balance sheet balances, A/R and A/P control == aging.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, accounts, customers, journalEntries, journalEntryLines } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance, balanceSheet } from './reports';
import { postJournalEntry } from './posting';
import { upsertCurrency, setBaseCurrency, setAccountCurrency } from './currencies';
import { accountRegister, reverseEntry, voidEntry } from './journal';
import { withAccountCurrency } from './fxLedger';
import { createDeposit, listUndepositedPayments } from './deposits';
import { createVendor } from './vendors';
import { createBill } from './bills';
import { createVendorCredit, applyToBill, getVendorCredit } from './vendorCredits';
import { createInvoice } from './invoices';
import { receivePayment } from './payments';
import { apAging, arAging } from './reportsExtra';
import {
  createHomeCurrencyAdjustment,
  listHomeCurrencyAdjustments,
  voidHomeCurrencyAdjustment,
} from './homeCurrencyAdjustment';
import { Money } from '@/lib/money';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-fx-adversarial2');
let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T12:00:00Z`);

async function bal(code: string): Promise<string> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, acct[code]));
  return Money.of(row.balance).toFixed(2);
}
async function foreignClosing(code: string): Promise<string> {
  const reg = await withAccountCurrency(ctx, await accountRegister(ctx, acct[code]));
  return reg.foreignClosingBalance!;
}
async function entryCount(): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(journalEntries);
  return r.n;
}
async function invariants() {
  const tb = await trialBalance(ctx);
  expect(tb.balanced).toBe(true);
  const bs = await balanceSheet(ctx);
  expect(Money.of(bs.totalAssets).toFixed(2)).toBe(
    Money.of(bs.totalLiabilities).plus(Money.of(bs.totalEquity)).toFixed(2),
  );
  const asOf = d('2027-12-31');
  expect(Money.of((await apAging(ctx, asOf)).totals.total).toFixed(2)).toBe(await bal('2000'));
  expect(Money.of((await arAging(ctx, asOf)).totals.total).toFixed(2)).toBe(await bal('1200'));
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
  ['6300', 'Office Supplies', 'expense', 'operating_expenses'],
];

describe('P1 FX — adversarial QA part 2', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'p1fx-adv2@test.local', name: 'FX QA2', passwordHash: 'x' })
      .returning();
    const [company] = await db.insert(companies).values({ name: 'FX QA2 Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    for (const [code, name, type, subtype] of DEFS) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    }
    await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.10' });
    await upsertCurrency(ctx, { code: 'GBP', name: 'Pound', rateToBase: '1.25' });
    await setAccountCurrency(ctx, acct['1020'], 'EUR');
    await setAccountCurrency(ctx, acct['1040'], 'GBP');
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
  });

  afterAll(async () => {
    await closeDb();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle. */
    }
  });

  it('voiding a EUR journal entry posted at a stated rate restores the EUR register exactly', async () => {
    const eur0 = await foreignClosing('1020');
    const je = await postJournalEntry(ctx, {
      date: d('2026-02-01'),
      description: 'EUR in at 1.20',
      currency: 'EUR',
      exchangeRate: '1.20',
      lines: [
        { accountId: acct['1020'], debit: '120.00', foreignAmount: '100.00' },
        { accountId: acct['3000'], credit: '120.00' },
      ],
    });
    expect(Money.of(await foreignClosing('1020')).minus(eur0).toFixed(2)).toBe('100.00');
    await voidEntry(ctx, je.id);
    expect(await foreignClosing('1020')).toBe(eur0);
    await invariants();
  });

  it('depositing a EUR payment into a home or GBP account is refused and writes nothing', async () => {
    const [cust] = await db
      .insert(customers)
      .values({ companyId: ctx.companyId, displayName: 'Refused Deposit' })
      .returning();
    const inv = await createInvoice(ctx, {
      customerId: cust.id,
      date: d('2026-04-01'),
      currency: 'EUR',
      exchangeRate: '1.10',
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '200' }],
    } as never);
    const { payment } = await receivePayment(ctx, {
      customerId: cust.id,
      date: d('2026-04-02'),
      method: 'check',
      amount: '200.00',
      currency: 'EUR',
      exchangeRate: '1.10',
      depositAccountId: acct['1050'],
      applications: [{ invoiceId: inv.id, amountApplied: '200.00' }],
    } as never);
    const n0 = await entryCount();
    const chk0 = await bal('1000');
    const uf0 = await bal('1050');
    await expect(
      createDeposit(ctx, { depositAccountId: acct['1000'], date: d('2026-04-03'), paymentIds: [payment.id] }),
    ).rejects.toThrow();
    await expect(
      createDeposit(ctx, { depositAccountId: acct['1040'], date: d('2026-04-03'), paymentIds: [payment.id] }),
    ).rejects.toThrow();
    expect(await entryCount()).toBe(n0);
    expect(await bal('1000')).toBe(chk0);
    expect(await bal('1050')).toBe(uf0);
    expect((await listUndepositedPayments(ctx)).some((p) => p.id === payment.id)).toBe(true);
    // Into the EUR bank at the same rate: exactly 220.00 leaves UF, no gain/loss.
    const eur0 = await foreignClosing('1020');
    await createDeposit(ctx, {
      depositAccountId: acct['1020'],
      date: d('2026-04-03'),
      paymentIds: [payment.id],
      exchangeRate: '1.10',
    });
    expect(Money.of(await bal('1050')).minus(uf0).toFixed(2)).toBe('-220.00');
    expect(Money.of(await foreignClosing('1020')).minus(eur0).toFixed(2)).toBe('200.00');
    await invariants();
  });

  it('a EUR vendor credit cannot be applied to a GBP bill; nothing is written', async () => {
    const vEur = await createVendor(ctx, { displayName: 'Euro Supplier', currency: 'EUR' });
    const vGbp = await createVendor(ctx, { displayName: 'Pound Supplier', currency: 'GBP' });
    const bill = await createBill(ctx, {
      vendorId: vGbp.id,
      date: d('2026-05-01'),
      exchangeRate: '1.25',
      lines: [{ accountId: acct['6300'], amount: '50.00' }],
    } as never);
    const vc = await createVendorCredit(ctx, {
      vendorId: vEur.id,
      date: d('2026-05-02'),
      exchangeRate: '1.10',
      lines: [{ accountId: acct['6300'], amount: '20.00' }],
    });
    const n0 = await entryCount();
    const ap0 = await bal('2000');
    await expect(
      applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '10.00', date: d('2026-05-03') }),
    ).rejects.toThrow();
    expect(await entryCount()).toBe(n0);
    expect(await bal('2000')).toBe(ap0);
    const after = await getVendorCredit(ctx, vc.id);
    expect(after.unapplied).toBe('20.00');
    expect(after.homeUnapplied).toBe('22.00');
    await invariants();
  });

  it('HCA then void: bank, A/R and A/P balances return exactly; list rates untouched when asked', async () => {
    const snap = async () => ({ eur: await bal('1020'), ar: await bal('1200'), ap: await bal('2000') });
    const before = await snap();
    await createHomeCurrencyAdjustment(ctx, {
      date: d('2026-06-30'),
      rates: { EUR: '1.30', GBP: '1.40' },
      updateCurrencyList: false,
    });
    expect(await bal('1020')).not.toBe(before.eur);
    await invariants();
    const res = (await db.execute(
      sql`SELECT rate_to_base FROM currencies WHERE company_id = ${ctx.companyId} AND code = 'EUR'`,
    )) as unknown as { rows: Array<{ rate_to_base: string }> };
    expect(Money.of(res.rows[0].rate_to_base).toFixed(2)).toBe('1.10');
    const list = (await listHomeCurrencyAdjustments(ctx)) as Array<{ id: string; voidedAt: Date | null }>;
    const open = list.filter((r) => r.voidedAt == null);
    expect(open.length).toBe(1);
    await voidHomeCurrencyAdjustment(ctx, open[0].id);
    expect(await snap()).toEqual(before);
    await invariants();
  });

  // Cross-file finding kept last so a failure cannot cascade into the scenarios above.
  it('[journal.ts reverseEntry] reversing a EUR entry posted at a stated rate takes the same EUR amount back out', async () => {
    // QB: a reversing entry mirrors the original in the transaction currency. Posted 100.00 EUR at
    // 1.20 (120.00 home); the reversal must remove 100.00 EUR, not 120.00 / list 1.10 = 109.09 EUR.
    const eur0 = await foreignClosing('1020');
    const je = await postJournalEntry(ctx, {
      date: d('2026-07-10'),
      description: 'Accrual EUR at 1.20',
      currency: 'EUR',
      exchangeRate: '1.20',
      lines: [
        { accountId: acct['1020'], debit: '120.00', foreignAmount: '100.00' },
        { accountId: acct['3000'], credit: '120.00' },
      ],
    });
    const rev = await reverseEntry(ctx, je.id, d('2026-08-01'));
    const revBank = (
      await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, rev.id))
    ).find((l) => l.accountId === acct['1020'])!;
    expect(revBank.credit).toBe('120.00');
    expect(revBank.foreignAmount).toBe('100.00');
    expect(await foreignClosing('1020')).toBe(eur0);
    await invariants();
  });
});
