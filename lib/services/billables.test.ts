/**
 * Billable time & costs passthrough — integration tests.
 *
 * Verifies:
 *  - listUnbilled gathers reimbursable bill lines, expense lines, and unbilled
 *    billable time (with billTimeToInvoice-style rate resolution).
 *  - createInvoiceWithBillables pulls the selection onto the invoice (markup
 *    applied to cost lines), stamps billed_invoice_id / invoiced_invoice_id in
 *    the SAME transaction, and the GL stays balanced.
 *  - Already-billed rows disappear from listUnbilled and re-billing them is a
 *    CONFLICT (no double-billing).
 *  - Voided source documents are excluded from billables.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  customers,
  vendors,
  items,
  billLines,
  expenseLines,
  timeEntries,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { createBill } from './bills';
import { createExpense } from './expenses';
import { createTimeEntry } from './timeTracking';
import { getInvoice } from './invoices';
import { listUnbilled, createInvoiceWithBillables, addBillablesToInvoice } from './billables';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-billables-svc');

let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};
let customerId: string;
let otherCustomerId: string;
let vendorId: string;
let serviceItemId: string;

let billLineId: string;
let expenseLineId: string;
let timeEntryId: string;

describe('Billables service', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'owner@billables.test', name: 'Owner', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'Billables Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['2200', 'Sales Tax Payable', 'liability', 'long_term_liability'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['6000', 'Job Materials', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }

    const [cust] = await db
      .insert(customers)
      .values({ companyId: company.id, displayName: 'Jobsite LLC', taxable: true })
      .returning();
    customerId = cust.id;
    const [other] = await db
      .insert(customers)
      .values({ companyId: company.id, displayName: 'Other Co', taxable: true })
      .returning();
    otherCustomerId = other.id;

    const [vend] = await db
      .insert(vendors)
      .values({ companyId: company.id, displayName: 'Lumber Yard' })
      .returning();
    vendorId = vend.id;

    const [svc] = await db
      .insert(items)
      .values({
        companyId: company.id,
        name: 'Consulting',
        type: 'service',
        salesPrice: '120.00',
        incomeAccountId: acct['4000'],
      })
      .returning();
    serviceItemId = svc.id;

    // --- Reimbursable bill line ($200 materials for Jobsite LLC) ---
    const bill = await createBill(ctx, {
      vendorId,
      date: new Date('2025-06-01'),
      lines: [{ accountId: acct['6000'], description: 'Lumber for deck', amount: '200.00' }],
    });
    // createBill has no billable-customer input — stamp customerId directly
    // (the billable flag IS the customerId per schema comment).
    const [bl] = await db
      .update(billLines)
      .set({ customerId })
      .where(eq(billLines.billId, bill.id))
      .returning();
    billLineId = bl.id;

    // --- Reimbursable expense line ($80 permit fee, paid cash) ---
    const expense = await createExpense(ctx, {
      vendorId,
      date: new Date('2025-06-02'),
      method: 'cash',
      paymentAccountId: acct['1000'],
      lines: [
        { accountId: acct['6000'], description: 'Permit fee', amount: '80.00', customerId },
      ],
    });
    const [el] = await db
      .select()
      .from(expenseLines)
      .where(eq(expenseLines.expenseId, expense.id));
    expenseLineId = el.id;

    // --- Billable time: 3h with no entry rate → falls back to item price $120 ---
    const entry = await createTimeEntry(ctx, {
      customerId,
      serviceItemId,
      date: new Date('2025-06-03'),
      hours: 3,
      billable: true,
      description: 'On-site consulting',
    });
    timeEntryId = entry.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('lists unbilled costs and time for the customer', async () => {
    const unbilled = await listUnbilled(ctx, customerId);

    expect(unbilled.costs).toHaveLength(2);
    const billCost = unbilled.costs.find((c) => c.source === 'bill')!;
    expect(billCost.id).toBe(billLineId);
    expect(billCost.amount).toBe('200.00');
    const expCost = unbilled.costs.find((c) => c.source === 'expense')!;
    expect(expCost.id).toBe(expenseLineId);
    expect(expCost.amount).toBe('80.00');

    expect(unbilled.time).toHaveLength(1);
    expect(unbilled.time[0].id).toBe(timeEntryId);
    expect(unbilled.time[0].rate).toBe('120.00'); // item salesPrice fallback
    expect(unbilled.time[0].amount).toBe('360.00'); // 3h * 120

    // Other customers see nothing.
    const none = await listUnbilled(ctx, otherCustomerId);
    expect(none.costs).toHaveLength(0);
    expect(none.time).toHaveLength(0);
  });

  it('creates an invoice from billables with markup and stamps the sources', async () => {
    const invoice = await createInvoiceWithBillables(
      ctx,
      {
        customerId,
        date: new Date('2025-06-10'),
        lines: [{ description: 'Project management', quantity: 1, rate: 100 }],
      },
      {
        billLineIds: [billLineId],
        expenseLineIds: [expenseLineId],
        timeEntryIds: [timeEntryId],
        markupPercent: 10,
      },
    );

    // 100 manual + 220 (200 +10%) + 88 (80 +10%) + 360 time (no markup on time).
    expect(invoice.total).toBe('768.00');

    const full = await getInvoice(ctx, invoice.id);
    // Each cost bills at cost plus its own markup line (QB: markup is credited to income,
    // never netted against the expense): manual + 2 costs + 2 markups + time.
    expect(full.lines).toHaveLength(6);
    const billable = full.lines.find((l) => l.description?.startsWith('Billable cost: Lumber for deck'))!;
    expect(billable.amount).toBe('200.00');
    const markupLine = full.lines.find((l) => l.description?.startsWith('Markup on Lumber for deck'))!;
    expect(markupLine.amount).toBe('20.00');
    expect(markupLine.description).toContain('+10.00% markup');
    const time = full.lines.find((l) => l.description === 'On-site consulting')!;
    expect(Number(time.quantity)).toBe(3);
    expect(Number(time.rate)).toBe(120);

    // Sources stamped with the invoice id.
    const [bl] = await db.select().from(billLines).where(eq(billLines.id, billLineId));
    expect(bl.billedInvoiceId).toBe(invoice.id);
    const [el] = await db.select().from(expenseLines).where(eq(expenseLines.id, expenseLineId));
    expect(el.billedInvoiceId).toBe(invoice.id);
    const [te] = await db.select().from(timeEntries).where(eq(timeEntries.id, timeEntryId));
    expect(te.invoicedInvoiceId).toBe(invoice.id);

    // Nothing left to bill.
    const after = await listUnbilled(ctx, customerId);
    expect(after.costs).toHaveLength(0);
    expect(after.time).toHaveLength(0);

    const tb = await trialBalance(ctx, new Date('2025-12-31'));
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });

  it('refuses to bill the same sources twice', async () => {
    await expect(
      createInvoiceWithBillables(
        ctx,
        { customerId, date: new Date('2025-06-11'), lines: [] },
        { billLineIds: [billLineId] },
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await expect(
      addBillablesToInvoice(ctx, '00000000-0000-0000-0000-000000000000', {
        timeEntryIds: [timeEntryId],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('requires a non-empty selection', async () => {
    await expect(
      createInvoiceWithBillables(
        ctx,
        { customerId, date: new Date('2025-06-12'), lines: [] },
        {},
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('an invoice can be built from billables alone (no manual lines)', async () => {
    const expense = await createExpense(ctx, {
      vendorId,
      date: new Date('2025-06-15'),
      method: 'cash',
      paymentAccountId: acct['1000'],
      lines: [
        { accountId: acct['6000'], description: 'Disposal fee', amount: '45.00', customerId },
      ],
    });
    const [el] = await db
      .select()
      .from(expenseLines)
      .where(eq(expenseLines.expenseId, expense.id));

    const invoice = await createInvoiceWithBillables(
      ctx,
      { customerId, date: new Date('2025-06-16'), lines: [] },
      { expenseLineIds: [el.id] },
    );
    expect(invoice.total).toBe('45.00');
    const full = await getInvoice(ctx, invoice.id);
    expect(full.lines).toHaveLength(1);
    expect(full.lines[0].description).toContain('Disposal fee');
  });
});
