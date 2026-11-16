/**
 * Review loop 13 — launch readiness (deferred loop-12 items and day-one findings).
 * Each test failed before its fix.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, bankTransactions, journalEntries, journalEntryLines, paymentsReceived, users } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createAccount } from './accounts';
import { upsertCurrency, setBaseCurrency, setAccountCurrency } from './currencies';
import { createCustomer } from './customers';
import { receivePayment, refundPayment } from './payments';
import { voidJournalEntry } from './posting';
import { createInvoice } from './invoices';
import { billRetainage } from './retainage';
import { reverseEntry } from './journal';
import { closePeriod } from './fiscalPeriods';
import { createBankAccount } from './bankAccounts';
import { startReconciliation, listClearable, setClearedMany, completeWithAdjustment, getProgress, startReconciliation as startRecon2, getReconciliationReport, completeReconciliation } from './reconcile';
import { autoPostBlockers, BLOCK_REASONS } from './autoPostGuard';
import { suggestMatchesForAccount } from './bankCategorize';
import { readBankAmount, parseCSV } from './import';
import { createManualEntry } from './journal';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review13');
let db: DB;
let ctx: ServiceContext;
let userId: string;
let acct: Record<string, string> = {};
let seq = 0;
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);

/** Posted GL balance (debit - credit) of an account. */
async function glBalance(accountId: string): Promise<string> {
  const [r] = await db
    .select({ b: sql<string>`COALESCE(SUM(COALESCE(${journalEntryLines.debit}, 0)::numeric - COALESCE(${journalEntryLines.credit}, 0)::numeric), 0)` })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.status, 'posted'), eq(journalEntryLines.accountId, accountId)));
  return Money.of(r?.b ?? '0').toFixed(2);
}

describe('review loop 13', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'review13@test.local', name: 'R13', passwordHash: 'x' }).returning();
    userId = u.id;
  });
  beforeEach(async () => {
    seq += 1;
    const company = await createCompany(db, { name: `R13 Co ${seq}`, ownerId: userId });
    ctx = { db, companyId: company.id, userId };
    acct = {};
    for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) if (r.code) acct[r.code] = r.id;
  });
  afterAll(async () => {
    await closeDb(TEST_DIR);
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle. */
    }
  });

  it('a journal entry can be reversed only once while its reversal stands', async () => {
    const je = await createManualEntry(ctx, {
      date: d('2026-03-31'),
      description: 'Accrue wages',
      lines: [
        { accountId: acct['6500'], debit: '1000.00' },
        { accountId: acct['2300'], credit: '1000.00' },
      ],
    });
    const rev = await reverseEntry(ctx, je.id);
    await expect(reverseEntry(ctx, je.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await glBalance(acct['6500'])).toBe('0.00');
    // Voiding the reversal allows a new one.
    await voidJournalEntry(ctx, rev.id);
    await expect(reverseEntry(ctx, je.id)).resolves.toBeTruthy();
    expect(await glBalance(acct['6500'])).toBe('0.00');
  });

  it('a closed period cannot overlap another closed period', async () => {
    await closePeriod(ctx, { periodStart: new Date('2025-01-01T00:00:00Z'), periodEnd: new Date('2025-12-31T00:00:00Z') });
    await expect(closePeriod(ctx, { periodStart: new Date('2025-12-01T00:00:00Z'), periodEnd: new Date('2026-01-31T00:00:00Z') })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(closePeriod(ctx, { periodStart: new Date('2026-02-01T00:00:00Z'), periodEnd: new Date('2026-01-01T00:00:00Z') })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(closePeriod(ctx, { periodStart: new Date('2026-01-01T00:00:00Z'), periodEnd: new Date('2026-01-31T00:00:00Z') })).resolves.toBeTruthy();
  });

  it('retainage cannot be billed with a date before the invoice that held it', async () => {
    const c = await createCustomer(ctx, { displayName: `Builder ${seq}` } as never);
    await createInvoice(ctx, {
      customerId: c.id,
      date: d('2026-03-01'),
      lines: [{ description: 'Phase 1', quantity: 1, rate: 5000, accountId: acct['4000'] }],
      retainagePercent: 10,
    } as never);
    await expect(billRetainage(ctx, { customerId: c.id, date: d('2026-01-15'), amount: '500' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(billRetainage(ctx, { customerId: c.id, date: d('2026-04-01'), amount: '500' })).resolves.toBeTruthy();
  });
  it('Mark All clears every listed line, and Finish with Adjustment posts the difference and finishes', async () => {
    const bank = (await createBankAccount(ctx, { accountId: acct['1000'], bankName: 'First Bank', accountNumber: `12345${seq}` } as never)).id;
    // A converted opening balance that hides a $350 check still outstanding from before the conversion.
    await createManualEntry(ctx, { date: d('2026-01-01'), description: 'QB opening', lines: [{ accountId: acct['1000'], debit: '10000.00' }, { accountId: acct['3000'], credit: '10000.00' }] });
    await createManualEntry(ctx, { date: d('2026-01-10'), description: 'Rent', reference: '1001', lines: [{ accountId: acct['6400'], debit: '2000.00' }, { accountId: acct['1000'], credit: '2000.00' }] });
    // The old check is still outstanding at the bank, so the bank holds 350 more than the books.
    const recon = await startReconciliation(ctx, { bankAccountId: bank, statementDate: d('2026-01-31'), statementBalance: '8350.00' });
    const lines = await listClearable(ctx, bank, d('2026-01-31'), recon.id);
    expect(lines.map((l) => l.description)).toEqual(['QB opening', 'Rent']); // date order
    expect(lines[1].reference).toBe('1001'); // with the check number
    const progress = await setClearedMany(ctx, recon.id, lines.map((l) => l.journalEntryLineId), true);
    expect(progress.difference).toBe('350.00');
    const done = await completeWithAdjustment(ctx, recon.id);
    expect(done.adjustment).toBe('350.00');
    expect(done.reconciliation.status).toBe('completed');
    expect(await glBalance(acct['1000'])).toBe('8350.00');
    const [disc] = await db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.name, 'Reconciliation Discrepancies')));
    expect(await glBalance(disc.id)).toBe('-350.00');
    // The next reconciliation starts from the statement balance.
    const next = await startRecon2(ctx, { bankAccountId: bank, statementDate: d('2026-02-28'), statementBalance: '8350.00' });
    expect((await getProgress(ctx, next.id)).difference).toBe('0.00');
  });

  it('automatic posting holds back a likely duplicate download and a line in a reconciled month', async () => {
    const bank = (await createBankAccount(ctx, { accountId: acct['1000'], bankName: 'First Bank', accountNumber: `23456${seq}` } as never)).id;
    const add = async (desc: string, amount: string, date: string) =>
      (await db.insert(bankTransactions).values({ companyId: ctx.companyId, bankAccountId: bank, date: d(date), description: desc, payee: desc, amount }).returning())[0].id;
    const pending = await add('AMAZON MKTPLACE', '-42.17', '2026-11-14');
    const posted = await add('AMAZON MKTPLACE AMZN.COM/BILL', '-42.17', '2026-11-15');
    const lone = await add('Coffee shop', '-6.25', '2026-11-15');
    const blockers = await autoPostBlockers(ctx, bank, [pending, posted, lone]);
    expect(blockers.get(posted)).toBe(BLOCK_REASONS.duplicate);
    expect(blockers.get(pending)).toBe(BLOCK_REASONS.duplicate);
    expect(blockers.has(lone)).toBe(false);
  });

  it('Bank Review offers a check that cleared weeks after it was written', async () => {
    const bank = (await createBankAccount(ctx, { accountId: acct['1000'], bankName: 'First Bank', accountNumber: `34567${seq}` } as never)).id;
    await createManualEntry(ctx, { date: d('2026-10-01'), description: 'Contractor', reference: '1050', lines: [{ accountId: acct['6400'], debit: '780.00' }, { accountId: acct['1000'], credit: '780.00' }] });
    const [line] = await db.insert(bankTransactions).values({ companyId: ctx.companyId, bankAccountId: bank, date: d('2026-10-25'), description: 'CHECK 1050', amount: '-780.00' }).returning();
    const candidates = (await suggestMatchesForAccount(ctx, bank, { bankTransactionIds: [line.id] }))[line.id] ?? [];
    expect(candidates).toHaveLength(1);
    expect(candidates[0].referenceMatch).toBe(true);
  });

  it('bank CSVs: CR / DR amounts, blank comma rows and a Total row', () => {
    expect(readBankAmount('125.00 CR')).toBe('125.00');
    expect(readBankAmount('125.00 DR')).toBe('-125.00');
    expect(readBankAmount('$1,250.00CR')).toBe('1250.00');
    const map = { dateCol: 'Date', descriptionCol: 'Description', amountCol: 'Amount' } as never;
    const rows = parseCSV(
      ['Date,Description,Amount', '11/01/2026,Coffee,-4.50', '11/02/2026,Deposit,100.00', ',,', ' , , ', 'Total,,95.50', ''].join('\n'),
      map,
    );
    expect(rows.map((r) => r.amount)).toEqual(['-4.50', '100.00']);
    // A row with an amount but no date is still refused.
    expect(() => parseCSV(['Date,Description,Amount', ',Coffee,-4.50', ''].join('\n'), map)).toThrow(/missing date/);
  });
  it('the reconciliation report lists uncleared transactions and ties to the register balance', async () => {
    const bank = (await createBankAccount(ctx, { accountId: acct['1000'], bankName: 'First Bank', accountNumber: `45678${seq}` } as never)).id;
    await createManualEntry(ctx, { date: d('2026-01-01'), description: 'Deposit', lines: [{ accountId: acct['1000'], debit: '5000.00' }, { accountId: acct['3000'], credit: '5000.00' }] });
    await createManualEntry(ctx, { date: d('2026-01-20'), description: 'Check 1002', lines: [{ accountId: acct['6400'], debit: '700.00' }, { accountId: acct['1000'], credit: '700.00' }] });
    const recon = await startReconciliation(ctx, { bankAccountId: bank, statementDate: d('2026-01-31'), statementBalance: '5000.00' });
    const lines = await listClearable(ctx, bank, d('2026-01-31'), recon.id);
    await setClearedMany(ctx, recon.id, lines.filter((l) => l.description === 'Deposit').map((l) => l.journalEntryLineId), true);
    await completeReconciliation(ctx, recon.id);
    const rep = await getReconciliationReport(ctx, recon.id);
    expect(rep.uncleared.map((l) => l.description)).toEqual(['Check 1002']);
    expect(rep.unclearedTotal).toBe('-700.00');
    expect(rep.registerBalance).toBe('4300.00');
    expect(Money.of(rep.clearedBalance).plus(rep.unclearedTotal).toFixed(2)).toBe(rep.registerBalance);
  });
});
