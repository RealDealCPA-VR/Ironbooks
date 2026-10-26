/**
 * Round-5 review regression (cash basis): a General Journal credit applied to an invoice (an A/R
 * write-off, a goodwill credit) or a General Journal vendor credit applied to a bill settles that
 * document on the day it was APPLIED, like a credit memo or a vendor credit. The cash-basis P&L
 * used to recognize the invoice's income (the bill's expense) on the document's own date, because
 * the application had no dated settlement: January showed $100 of cash income that was never
 * received in January (and the March write-off showed its expense with no income beside it).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq, isNotNull } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, accounts, journalEntryLines } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createInvoice } from './invoices';
import { createBill } from './bills';
import { createManualEntry } from './journal';
import { applyJournalCredit } from './journalApplications';
import { profitAndLossCashBasis } from './cashBasisReports';
import { balanceSheetCashBasis } from './balanceSheetCashBasis';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-cash-basis');
let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T00:00:00Z`);
const line = (pl: { income: Array<{ code: string; amount: string }>; expenses: Array<{ code: string; amount: string }> }, code: string) =>
  [...pl.income, ...pl.expenses].find((l) => l.code === code)?.amount ?? '0.00';

describe('cash basis (review round 5)', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'r5@cash.test', name: 'Cass', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'Review5 Cash', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[r.code] = r.id;
  });

  afterAll(async () => {
    await closeDb();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle; the next run wipes it */
    }
  });

  it('A: a General Journal credit applied to an invoice settles it on the application date', async () => {
    const cust = await createCustomer(ctx, { displayName: 'Never Paid' } as never);
    const inv = await createInvoice(ctx, {
      customerId: cust.id,
      date: d('2026-01-10'),
      lines: [{ accountId: acct['4100'], quantity: 1, rate: '100.00' }],
    } as never);
    // March: write the invoice off with a journal entry and apply its credit to the invoice.
    const je = await createManualEntry(ctx, {
      date: d('2026-03-05'),
      description: 'Write off Never Paid',
      lines: [
        { accountId: acct['6100'], debit: '100.00' },
        { accountId: acct['1200'], credit: '100.00', entityType: 'customer', entityId: cust.id },
      ],
    });
    const [cr] = await db
      .select({ id: journalEntryLines.id })
      .from(journalEntryLines)
      .where(and(eq(journalEntryLines.journalEntryId, je.id), isNotNull(journalEntryLines.credit)));
    await applyJournalCredit(ctx, { journalLineId: cr.id, invoiceId: inv.id, amount: '100.00', date: d('2026-03-05') });

    const jan = await profitAndLossCashBasis(ctx, { from: d('2026-01-01'), to: d('2026-01-31') });
    expect(line(jan, '4100')).toBe('0.00');
    const mar = await profitAndLossCashBasis(ctx, { from: d('2026-03-01'), to: d('2026-03-31') });
    expect(line(mar, '4100')).toBe('100.00');
    expect(line(mar, '6100')).toBe('100.00');
    expect(mar.netIncome).toBe('0.00');
    // The cash-basis balance sheet balances on every date in between.
    for (const at of ['2026-01-31', '2026-02-28', '2026-03-31']) {
      expect((await balanceSheetCashBasis(ctx, d(at))).balanced, at).toBe(true);
    }
  });

  it('B: a General Journal vendor credit applied to a bill settles it on the application date', async () => {
    const vend = await createVendor(ctx, { displayName: 'Credit Vendor' } as never);
    const bill = await createBill(ctx, {
      vendorId: vend.id,
      date: d('2026-04-02'),
      lines: [{ accountId: acct['6300'], amount: '40.00' }],
    } as never);
    const je = await createManualEntry(ctx, {
      date: d('2026-06-10'),
      description: 'Vendor credit for damaged goods',
      lines: [
        { accountId: acct['2000'], debit: '40.00', entityType: 'vendor', entityId: vend.id },
        { accountId: acct['4900'], credit: '40.00' },
      ],
    });
    const [dr] = await db
      .select({ id: journalEntryLines.id })
      .from(journalEntryLines)
      .where(and(eq(journalEntryLines.journalEntryId, je.id), isNotNull(journalEntryLines.debit)));
    await applyJournalCredit(ctx, { journalLineId: dr.id, billId: bill.id, amount: '40.00', date: d('2026-06-10') });

    const apr = await profitAndLossCashBasis(ctx, { from: d('2026-04-01'), to: d('2026-04-30') });
    expect(line(apr, '6300')).toBe('0.00');
    const jun = await profitAndLossCashBasis(ctx, { from: d('2026-06-01'), to: d('2026-06-30') });
    expect(line(jun, '6300')).toBe('40.00');
  });
});
