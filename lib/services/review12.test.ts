/**
 * Review loop 12 — A/R cash, payables, posting core, job costing, combined reports.
 * Each test failed before its fix.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, journalEntries, journalEntryLines, paymentsReceived, users } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createAccount } from './accounts';
import { upsertCurrency, setBaseCurrency, setAccountCurrency } from './currencies';
import { createCustomer } from './customers';
import { receivePayment, refundPayment } from './payments';
import { voidJournalEntry } from './posting';
import { createVendor } from './vendors';
import { createBill } from './bills';
import { createVendorCredit } from './vendorCredits';
import { createJob, jobProfitability } from './jobs';
import { createTaxRate } from './salesTax';
import { setComponents } from './combinedTax';
import { createEmployee } from './payroll';
import { createReport, submitReport, approveAndReimburse } from './expenseReports';
import { createCreditMemo, refundCreditMemo } from './creditMemos';
import { payPayrollLiabilities } from './liabilityPayments';
import { createManualEntry, updateEntry } from './journal';
import { yearEndClose } from './fiscalClose';
import { setClosingDate } from './company';
import { condensePeriod } from './condense';
import { profitAndLoss } from './reports';
import { taxRates } from '@/lib/db/schema';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review12');
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

describe('review loop 12', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'review12@test.local', name: 'R12', passwordHash: 'x' }).returning();
    userId = u.id;
  });
  beforeEach(async () => {
    seq += 1;
    const company = await createCompany(db, { name: `R12 Co ${seq}`, ownerId: userId });
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

  it('voiding a foreign refund that booked an exchange loss gives back the credit, with no phantom gain', async () => {
    await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.10' });
    acct['1020'] = (await createAccount(ctx, { code: '1020', name: 'Euro Bank', type: 'asset' as never, subtype: 'checking' })).id;
    await setAccountCurrency(ctx, acct['1020'], 'EUR');
    const c = await createCustomer(ctx, { displayName: `EUR customer ${seq}` } as never);
    const pay = await receivePayment(ctx, {
      customerId: c.id,
      date: d('2026-03-01'),
      amount: '100.00',
      method: 'ach',
      depositAccountId: acct['1020'],
      currency: 'EUR',
      exchangeRate: '1.10',
      applications: [],
    } as never);
    const arAfterPayment = await glBalance(acct['1200']);
    expect(arAfterPayment).toBe('-110.00');
    // Refunded at 1.20: Dr A/R 110, Dr Exchange loss 10, Cr bank 120.
    const { entry } = await refundPayment(ctx, { paymentId: pay.payment.id, bankAccountId: acct['1020'], amount: '100.00', date: d('2026-03-05'), exchangeRate: '1.20' });
    expect(await glBalance(acct['1200'])).not.toBe(arAfterPayment);
    await voidJournalEntry(ctx, entry.id);
    const [after] = await db.select().from(paymentsReceived).where(eq(paymentsReceived.id, pay.payment.id));
    expect(Money.of(after.unapplied).toFixed(2)).toBe('100.00');
    // The customer's credit is back on A/R at its booked value, with no extra plug.
    expect(await glBalance(acct['1200'])).toBe(arAfterPayment);
  });
  it('the Jobs page subtracts vendor credits costed to the job, like Job Profitability', async () => {
    const cust = await createCustomer(ctx, { displayName: `Job customer ${seq}` } as never);
    const job = (await createJob(ctx, { customerId: cust.id, name: 'Kitchen' } as never)).id;
    const v = await createVendor(ctx, { displayName: `Supplier ${seq}` } as never);
    await createBill(ctx, { vendorId: v.id, date: d('2026-03-01'), lines: [{ accountId: acct['6300'], amount: '1000.00', jobId: job }] } as never);
    await createVendorCredit(ctx, { vendorId: v.id, date: d('2026-03-05'), lines: [{ accountId: acct['6300'], amount: '300.00', jobId: job }] } as never);
    const p = await jobProfitability(ctx, job);
    expect(p.cost).toBe('700.00');
    expect(p.lines.some((l) => l.source === 'vendor_credit_line' && l.amount === '-300.00')).toBe(true);
  });

  it('saving an empty component list keeps the tax rate instead of dropping it to 0%', async () => {
    const rate = await createTaxRate(ctx, { name: `Combined ${seq}`, rate: '0.0725' } as never);
    await setComponents(ctx, rate.id, [
      { name: 'State', rate: '0.06' },
      { name: 'County', rate: '0.0125' },
    ] as never);
    await setComponents(ctx, rate.id, []);
    const [row] = await db.select().from(taxRates).where(eq(taxRates.id, rate.id));
    expect(Money.of(row.rate).toFixed(4)).toBe('0.0725');
  });

  it('an expense reimbursement is paid from the checking account even when it is not numbered 1000', async () => {
    // A chart converted from QuickBooks: Checking is 10000.
    await db.update(accounts).set({ code: '10000' }).where(eq(accounts.id, acct['1000']));
    const emp = await createEmployee(ctx, { firstName: 'Alice', lastName: `Smith ${seq}`, payType: 'salary', payRate: '60000.00' } as never);
    const r = await createReport(ctx, { employeeId: emp.id, title: 'Trip', lines: [{ accountId: acct['6300'], description: 'Paper', amount: '45.00' }] });
    await submitReport(ctx, r.id);
    await approveAndReimburse(ctx, r.id);
    expect(await glBalance(acct['1000'])).toBe('-45.00');
    // A chosen account must be a bank account.
    const r2 = await createReport(ctx, { employeeId: emp.id, title: 'Trip 2', lines: [{ accountId: acct['6300'], amount: '5.00' }] });
    await submitReport(ctx, r2.id);
    await expect(approveAndReimburse(ctx, r2.id, { bankAccountId: acct['6300'] })).rejects.toMatchObject({ code: 'VALIDATION' });
    await approveAndReimburse(ctx, r2.id, { bankAccountId: acct['1010'] });
    expect(await glBalance(acct['1010'])).toBe('-5.00');
  });

  it('a customer refund cannot be paid from Undeposited Funds or Retainage Receivable', async () => {
    const c = await createCustomer(ctx, { displayName: `Refund customer ${seq}` } as never);
    const cm = await createCreditMemo(ctx, { customerId: c.id, date: d('2026-03-01'), lines: [{ accountId: acct['4000'], quantity: 1, rate: '50.00' }] } as never);
    for (const code of ['1050', '1250']) {
      await expect(
        refundCreditMemo(ctx, { creditMemoId: cm.id, bankAccountId: acct[code], amount: '50.00', date: d('2026-03-02') }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    await expect(refundCreditMemo(ctx, { creditMemoId: cm.id, bankAccountId: acct['1000'], amount: '50.00', date: d('2026-03-02') })).resolves.toBeTruthy();
  });

  it('a payroll liability check cannot be edited as a General Journal entry', async () => {
    const entry = await payPayrollLiabilities(ctx, { amount: '250.00', date: d('2026-04-20'), paymentAccountId: acct['1000'] } as never);
    await expect(
      updateEntry(ctx, entry.id, {
        date: d('2026-04-20'),
        description: 'Edited',
        lines: [
          { accountId: acct['2300'], debit: '200.00' },
          { accountId: acct['1000'], credit: '200.00' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('Condense keeps the year-end closing entry, so the closed year still shows its net income', async () => {
    await createManualEntry(ctx, {
      date: d('2025-03-01'),
      description: 'Cash sale',
      lines: [
        { accountId: acct['1000'], debit: '500.00' },
        { accountId: acct['4000'], credit: '500.00' },
      ],
    });
    await yearEndClose(ctx, { fiscalYear: 2025 } as never);
    const range = { from: new Date('2025-01-01T00:00:00Z'), to: new Date('2025-12-31T23:59:59Z') };
    expect((await profitAndLoss(ctx, range)).netIncome).toBe('500.00');
    await setClosingDate(ctx, { closingDate: '2025-12-31' });
    await condensePeriod(ctx, { beforeDate: new Date('2026-01-01T00:00:00Z'), dataDir: TEST_DIR });
    expect((await profitAndLoss(ctx, range)).netIncome).toBe('500.00');
    await setClosingDate(ctx, { closingDate: null });
  });
});
