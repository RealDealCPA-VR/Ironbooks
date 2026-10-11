/**
 * Wave2 accountant — fix round 1 regressions:
 *   I8 WTB across a fiscal-year boundary (P&L resets, prior earnings roll into Retained Earnings),
 *   I5/I6 per-document-area permissions, I6 one listing per sales receipt, I2 orphaned corrections
 *   after the original payment is voided (batch void + manual undo), D7 tax paid to an agency's
 *   earlier liability account stays in the report.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, deposits, journalEntries, taxAgencies, users } from '@/lib/db/schema';
import type { ServiceContext } from '../_base';
import { createCompany } from '../company';
import { createAccount } from '../accounts';
import { createCustomer } from '../customers';
import { createExpense, voidExpense } from '../expenses';
import { createInvoice } from '../invoices';
import { createSalesReceipt } from '../salesReceipts';
import { postJournalEntry } from '../posting';
import { trialBalance } from '../reports';
import { createTaxAgency, createTaxRate } from '../salesTax';
import { paySalesTax } from '../liabilityPayments';
import { emptyPermissionSet, type EffectiveAccess, type Area } from '@/lib/permissions/model';
import { salesTaxLiabilityReport } from './salesTaxLedger';
import { findMisrecordedSalesTax, reclassifySalesTaxPayment, undoOrphanedSalesTaxFix } from './salesTaxTools';
import { workingTrialBalance } from './workingTrialBalance';
import { batchEnterTransactions } from './batchEnter';
import { batchVoidTransactions, listBatchTransactions } from './batchVoid';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-accountant-fixes');
let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
let agency: string;
let rate: string;
let customerId: string;

const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const eod = (s: string) => new Date(`${s}T23:59:59.999Z`);

function only(areas: Partial<Record<Area, Array<'view' | 'create' | 'modify' | 'delete' | 'print'>>>): EffectiveAccess {
  const permissions = emptyPermissionSet();
  for (const [k, v] of Object.entries(areas)) (permissions as Record<string, string[]>)[k] = v as string[];
  return {
    roleKeys: ['fix-round'],
    permissions,
    flags: { sensitivePayroll: false, fullAccountNumbers: false, closedPeriod: false },
    isAdmin: false,
  };
}

describe('wave2 accountant — fix round 1', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'acct-fix@test.local', name: 'Fixer', passwordHash: 'x' })
      .returning();
    const company = await createCompany(db, { name: 'Fix Round Co', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
    agency = (await createTaxAgency(ctx, { name: 'Fix County Revenue' })).id;
    rate = (await createTaxRate(ctx, { name: 'Fix County 5%', rate: '0.05', agencyId: agency })).id;
    customerId = (await createCustomer(ctx, { displayName: 'Fix Customer' })).id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('WTB: income/expense reset at the fiscal year start and prior earnings roll into Retained Earnings', async () => {
    // FY2024: revenue 1,000, expense 300 → prior earnings 700.
    await postJournalEntry(ctx, {
      date: d('2024-05-01'),
      description: 'FY24 sale',
      lines: [
        { accountId: acct['1000'], debit: '1000' },
        { accountId: acct['4100'], credit: '1000' },
      ],
    });
    await postJournalEntry(ctx, {
      date: d('2024-06-01'),
      description: 'FY24 rent',
      lines: [
        { accountId: acct['6400'], debit: '300' },
        { accountId: acct['1000'], credit: '300' },
      ],
    });
    // FY2025 January (before the WTB period) and February (inside it).
    await postJournalEntry(ctx, {
      date: d('2025-01-15'),
      description: 'Jan sale',
      lines: [
        { accountId: acct['1000'], debit: '200' },
        { accountId: acct['4100'], credit: '200' },
      ],
    });
    await postJournalEntry(ctx, {
      date: d('2025-02-10'),
      description: 'Feb sale',
      lines: [
        { accountId: acct['1000'], debit: '50' },
        { accountId: acct['4100'], credit: '50' },
      ],
    });

    const w = await workingTrialBalance(ctx, { from: d('2025-02-01'), to: eod('2025-02-28') });
    expect(w.balanced).toBe(true);
    expect(w.fiscalYearStart).toBe('2025-01-01');
    const row = (code: string) => w.rows.find((r) => r.code === code)!;
    // Service income starts the year at zero: beginning = January only, not lifetime.
    expect(row('4100').beginning).toBe('-200.00');
    expect(row('4100').ending).toBe('-250.00');
    // Rent was all last year → closed out (absent or zero).
    expect(w.rows.find((r) => r.code === '6400')?.beginning ?? '0.00').toBe('0.00');
    // Retained Earnings carries last year's 700 profit (credit = negative).
    expect(row('3900').beginning).toBe('-700.00');
    expect(row('3900').ending).toBe('-700.00');
    // Balance-sheet accounts keep their full history.
    expect(row('1000').beginning).toBe('900.00');
    expect(row('1000').ending).toBe('950.00');
    // Totals: the books balance in every column.
    expect(w.totals.beginning).toBe('0.00');
    expect(w.totals.ending).toBe('0.00');

    // Same year as the data → identical to the lifetime trial balance for balance-sheet accounts.
    const tb = await trialBalance(ctx, eod('2025-02-28'));
    const cash = tb.rows.find((r) => r.code === '1000')!;
    expect(Number(cash.debit) - Number(cash.credit)).toBeCloseTo(950, 2);
  });

  it('I5: Batch Enter checks need Banking rights, invoices need Customers rights', async () => {
    const acctPlusCustomers = only({ accounting: ['view', 'create'], customers: ['view', 'create'] });
    const before = await db.select().from(deposits).where(eq(deposits.companyId, ctx.companyId));
    await expect(
      batchEnterTransactions({ ...ctx, access: acctPlusCustomers }, {
        type: 'deposit',
        bankAccountId: acct['1000'],
        rows: [{ date: '2025-03-01', account: '4900', amount: '10' }],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const after = await db.select().from(deposits).where(eq(deposits.companyId, ctx.companyId));
    expect(after.length).toBe(before.length);
    // …while the same role can batch-enter invoices.
    const res = await batchEnterTransactions({ ...ctx, access: acctPlusCustomers }, {
      type: 'invoice',
      rows: [{ date: '2025-03-01', name: 'Fix Customer', account: '4100', amount: '10' }],
    });
    expect(res.saved).toBe(1);
  });

  it('I6: voiding a Pay Sales Tax entry also needs Sales Tax rights', async () => {
    await createInvoice(ctx, { customerId, date: d('2025-03-02'), taxRateId: rate, lines: [{ description: 'x', quantity: 1, rate: '100' }] });
    const pay = await paySalesTax(ctx, { agencyId: agency, amount: '5.00', paymentAccountId: acct['1000'], date: d('2025-03-20') });
    const entryId = pay.id;
    const res = await batchVoidTransactions({ ...ctx, access: only({ accounting: ['view', 'delete'] }) }, [`journal:${entryId}`]);
    expect(res.succeeded).toBe(0);
    const [e] = await db.select().from(journalEntries).where(eq(journalEntries.id, entryId));
    expect(e.status).toBe('posted');
  });

  it('I6: a sales receipt with a second entry sharing its sourceRef is listed once', async () => {
    const sr = await createSalesReceipt(ctx, {
      customerId,
      date: d('2025-04-02'),
      depositAccountId: acct['1000'],
      lines: [{ description: 'Counter sale', quantity: 1, rate: '40' }] as never,
    });
    const srId = (sr as { id?: string; receipt?: { id: string } }).receipt?.id ?? (sr as { id: string }).id;
    // Simulate the COGS entry that reuses salesreceipt:<id>.
    await postJournalEntry(ctx, {
      date: d('2025-04-02'),
      description: 'COGS',
      sourceRef: `salesreceipt:${srId}`,
      lines: [
        { accountId: acct['5000'], debit: '7' },
        { accountId: acct['6000'], credit: '7' },
      ],
    });
    const rows = await listBatchTransactions(ctx, { from: d('2025-04-01'), to: eod('2025-04-30') });
    const mine = rows.filter((r) => r.key === `sales_receipt:${srId}`);
    expect(mine.length).toBe(1);
    expect(mine[0].amount).toBe('40.00');
  });

  it('I2: voiding a payment that was "counted as tax payment" removes the correction (batch void and manual undo)', async () => {
    const mk = async (date: string) =>
      createExpense(ctx, {
        payeeName: 'Fix County Revenue',
        date: d(date),
        method: 'check',
        paymentAccountId: acct['1000'],
        lines: [{ accountId: acct['6700'], amount: '3', description: 'Fix County Revenue sales tax' }],
      });
    const exp1 = await mk('2025-05-02');
    const exp2 = await mk('2025-05-03');
    const exp1Id = (exp1 as { id?: string; expense?: { id: string } }).expense?.id ?? (exp1 as { id: string }).id;
    const exp2Id = (exp2 as { id?: string; expense?: { id: string } }).expense?.id ?? (exp2 as { id: string }).id;
    const issues = (await findMisrecordedSalesTax(ctx)).filter((i) => i.issue === 'expense_payment');
    expect(issues.length).toBe(2);
    const report0 = await salesTaxLiabilityReport(ctx);
    for (const i of issues) await reclassifySalesTaxPayment(ctx, { lineId: i.lineId, agencyId: agency });
    const report1 = await salesTaxLiabilityReport(ctx);
    expect(Number(report1.totals.balance)).toBeCloseTo(Number(report0.totals.balance) - 6, 2);

    // (a) Batch Void takes the correction with it.
    const r = await batchVoidTransactions(ctx, [`check:${exp1Id}`]);
    expect(r.succeeded).toBe(1);
    const report2 = await salesTaxLiabilityReport(ctx);
    expect(Number(report2.totals.balance)).toBeCloseTo(Number(report0.totals.balance) - 3, 2);
    expect(report2.tiesToGl).toBe(true);

    // (b) A void from the check screen leaves an orphan the Fix screen lists and can undo.
    await voidExpense(ctx, exp2Id);
    const orphan = (await findMisrecordedSalesTax(ctx)).find((i) => i.issue === 'orphaned_fix');
    expect(orphan).toBeDefined();
    await undoOrphanedSalesTaxFix(ctx, orphan!.entryId);
    const report3 = await salesTaxLiabilityReport(ctx);
    expect(report3.totals.balance).toBe(report0.totals.balance);
    expect(report3.tiesToGl).toBe(true);
    expect((await findMisrecordedSalesTax(ctx)).some((i) => i.issue === 'orphaned_fix')).toBe(false);
    // Undoing a correction that is still needed is refused (the voided one is no longer an orphan).
    await expect(undoOrphanedSalesTaxFix(ctx, orphan!.entryId)).rejects.toMatchObject({ code: 'CONFLICT' });
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('D7: payments to an agency\'s earlier liability account stay in the report after the agency is re-pointed', async () => {
    const own = await createAccount(ctx, { code: '2210', name: 'County Tax Payable', type: 'liability' as never, subtype: 'long_term_liability' });
    await db.update(taxAgencies).set({ liabilityAccountId: own.id }).where(eq(taxAgencies.id, agency));
    await createInvoice(ctx, { customerId, date: d('2025-06-02'), taxRateId: rate, lines: [{ description: 'y', quantity: 1, rate: '100' }] });
    await paySalesTax(ctx, { agencyId: agency, amount: '5.00', paymentAccountId: acct['1000'], date: d('2025-06-20') });
    // Agency now moves to a different account (simulates a later edit).
    const next = await createAccount(ctx, { code: '2220', name: 'County Tax Payable (new)', type: 'liability' as never, subtype: 'long_term_liability' });
    await db.update(taxAgencies).set({ liabilityAccountId: next.id }).where(and(eq(taxAgencies.id, agency)));
    const rep = await salesTaxLiabilityReport(ctx);
    expect(rep.tiesToGl).toBe(true);
    const a = rep.agencies.find((x) => x.agencyId === agency)!;
    expect(Number(a.paid)).toBeGreaterThanOrEqual(5);
  });
});
