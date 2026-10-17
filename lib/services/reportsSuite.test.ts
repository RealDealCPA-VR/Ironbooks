/**
 * Integration tests for the report-suite completion services in reportsExtra:
 * aging detail, open invoices, collections, missing checks, check detail,
 * deposit detail, sales/purchases by item, transaction detail, and the
 * comparative balance sheet.
 *
 * Boots a throw-away PGlite directory and seeds documents directly (plus real
 * postJournalEntry postings for the GL-driven reports), mirroring the pattern
 * of reportsExtra.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  billLines,
  billPaymentApplications,
  billPayments,
  bills,
  companies,
  customers,
  deposits,
  depositLines,
  expenseLines,
  expenses,
  invoiceLines,
  invoices,
  items,
  paymentApplications,
  paymentsReceived,
  salesReceiptLines,
  salesReceipts,
  users,
  vendors,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import {
  apAgingDetail,
  arAgingDetail,
  balanceSheetComparative,
  checkDetail,
  collectionsReport,
  depositDetail,
  missingChecks,
  openInvoices,
  purchasesByItem,
  salesByItem,
  transactionDetail,
} from './reportsExtra';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reports-suite');
let ctx: ServiceContext;
let db: DB;

const acct: Record<string, string> = {};
let customerId: string;
let vendorId: string;
let inventoryItemId: string;
let serviceItemId: string;

const DAY = 24 * 60 * 60 * 1000;
const now = new Date();
const daysAgo = (n: number) => new Date(now.getTime() - n * DAY);
const daysAhead = (n: number) => new Date(now.getTime() + n * DAY);

beforeAll(async () => {
  db = await getDb(TEST_DIR);

  const [user] = await db
    .insert(users)
    .values({ email: 'owner@suite.test', name: 'Owner', passwordHash: 'x' })
    .returning();
  const [company] = await db
    .insert(companies)
    .values({ name: 'Report Suite Co', ownerId: user.id })
    .returning();
  ctx = { db, companyId: company.id, userId: user.id };

  const defs: Array<[string, string, string, string]> = [
    ['1000', 'Checking', 'asset', 'checking'],
    ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
    ['1300', 'Inventory Asset', 'asset', 'inventory'],
    ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
    ['3000', "Owner's Equity", 'equity', 'owners_equity'],
    ['4000', 'Sales Income', 'revenue', 'sales'],
    ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
    ['6000', 'Office Supplies', 'expense', 'operating_expenses'],
  ];
  for (const [code, name, type, subtype] of defs) {
    const row = await createAccount(ctx, { code, name, type: type as never, subtype });
    acct[code] = row.id;
  }

  const [cust] = await db
    .insert(customers)
    .values({
      companyId: company.id,
      displayName: 'Late Payer LLC',
      email: 'ap@latepayer.test',
      phone: '555-0100',
      balance: '0.00',
    })
    .returning();
  customerId = cust.id;

  const [vend] = await db
    .insert(vendors)
    .values({ companyId: company.id, displayName: 'Paper Co', balance: '0.00' })
    .returning();
  vendorId = vend.id;

  const [invItem] = await db
    .insert(items)
    .values({
      companyId: company.id,
      name: 'Widget',
      sku: 'WID-1',
      type: 'inventory',
      averageCost: '40.0000',
      assetAccountId: acct['1300'],
      incomeAccountId: acct['4000'],
      expenseAccountId: acct['5000'],
    })
    .returning();
  inventoryItemId = invItem.id;

  const [svcItem] = await db
    .insert(items)
    .values({
      companyId: company.id,
      name: 'Consulting Hour',
      type: 'service',
      incomeAccountId: acct['4000'],
    })
    .returning();
  serviceItemId = svcItem.id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedInvoice(opts: {
  number: number;
  total: string;
  date: Date;
  dueDate: Date | null;
  balanceDue?: string;
  amountPaid?: string;
  status?: 'open' | 'paid' | 'void';
  lines?: { itemId: string; quantity: string; rate: string; amount: string }[];
}) {
  const [inv] = await db
    .insert(invoices)
    .values({
      companyId: ctx.companyId,
      customerId,
      invoiceNumber: opts.number,
      date: opts.date,
      dueDate: opts.dueDate,
      status: opts.status ?? 'open',
      subtotal: opts.total,
      total: opts.total,
      amountPaid: opts.amountPaid ?? '0',
      balanceDue: opts.balanceDue ?? opts.total,
    })
    .returning();
  for (const l of opts.lines ?? []) {
    await db.insert(invoiceLines).values({
      invoiceId: inv.id,
      itemId: l.itemId,
      quantity: l.quantity,
      rate: l.rate,
      amount: l.amount,
    });
  }
  return inv;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('report suite', () => {
  // Seeded documents (ids captured for assertions).
  let overdueInvoiceId: string;
  let openBillId: string;

  beforeAll(async () => {
    // Invoice #1: 45 days overdue, $500 open (the collections target).
    const overdue = await seedInvoice({
      number: 1,
      total: '500.00',
      date: daysAgo(60),
      dueDate: daysAgo(45),
      lines: [{ itemId: inventoryItemId, quantity: '2', rate: '100', amount: '200.00' }],
    });
    overdueInvoiceId = overdue.id;

    // Invoice #2: current (due in 10 days), $300 open.
    await seedInvoice({
      number: 2,
      total: '300.00',
      date: daysAgo(5),
      dueDate: daysAhead(10),
      lines: [{ itemId: serviceItemId, quantity: '3', rate: '100', amount: '300.00' }],
    });

    // Invoice #3: fully paid (payment dated before today) — must not appear.
    const paid = await seedInvoice({
      number: 3,
      total: '100.00',
      date: daysAgo(30),
      dueDate: daysAgo(20),
      balanceDue: '0.00',
      amountPaid: '100.00',
      status: 'paid',
    });
    const [pmt] = await db
      .insert(paymentsReceived)
      .values({
        companyId: ctx.companyId,
        customerId,
        date: daysAgo(25),
        method: 'check',
        amount: '100.00',
        unapplied: '0',
      })
      .returning();
    await db
      .insert(paymentApplications)
      .values({ paymentId: pmt.id, invoiceId: paid.id, amountApplied: '100.00' });

    // Bill: 35 days overdue, $400 open; lines buy 10 Widgets at $40.
    const [bill] = await db
      .insert(bills)
      .values({
        companyId: ctx.companyId,
        vendorId,
        billNumber: 'B-100',
        date: daysAgo(50),
        dueDate: daysAgo(35),
        status: 'open',
        total: '400.00',
        amountPaid: '0',
        balanceDue: '400.00',
      })
      .returning();
    openBillId = bill.id;
    await db.insert(billLines).values({
      billId: bill.id,
      accountId: acct['1300'],
      itemId: inventoryItemId,
      quantity: '10',
      amount: '400.00',
    });

    // Checks: expenses #100, #101, #103 (voided) + non-numeric ref; bill payment #105.
    for (const [ref, voided] of [
      ['100', false],
      ['101', false],
      ['103', true],
      ['ABC', false],
    ] as const) {
      const [exp] = await db
        .insert(expenses)
        .values({
          companyId: ctx.companyId,
          vendorId,
          date: daysAgo(10),
          method: 'check',
          reference: ref,
          paymentAccountId: acct['1000'],
          total: '50.00',
          voidedAt: voided ? new Date() : null,
        })
        .returning();
      await db.insert(expenseLines).values({
        expenseId: exp.id,
        accountId: acct['6000'],
        description: `Supplies via check ${ref}`,
        amount: '50.00',
      });
    }
    const [bp] = await db
      .insert(billPayments)
      .values({
        companyId: ctx.companyId,
        vendorId,
        date: daysAgo(8),
        method: 'check',
        reference: '105',
        amount: '400.00',
        paymentAccountId: acct['1000'],
      })
      .returning();
    await db
      .insert(billPaymentApplications)
      .values({ billPaymentId: bp.id, billId: openBillId, amountApplied: '400.00' });

    // Deposits: one live ($500 = $300 customer payment + $200 other), one voided ($100).
    const [pmt2] = await db
      .insert(paymentsReceived)
      .values({
        companyId: ctx.companyId,
        customerId,
        date: daysAgo(7),
        method: 'check',
        amount: '300.00',
        unapplied: '300.00',
      })
      .returning();
    const [dep] = await db
      .insert(deposits)
      .values({
        companyId: ctx.companyId,
        depositAccountId: acct['1000'],
        date: daysAgo(6),
        total: '500.00',
        memo: 'Weekly deposit',
      })
      .returning();
    await db.insert(depositLines).values([
      { depositId: dep.id, paymentId: pmt2.id, amount: '300.00' },
      { depositId: dep.id, description: 'Vending machine cash', amount: '200.00' },
    ]);
    await db.insert(deposits).values({
      companyId: ctx.companyId,
      depositAccountId: acct['1000'],
      date: daysAgo(5),
      total: '100.00',
      voidedAt: new Date(),
    });

    // Sales receipt selling 1 Widget for $120 (adds to Sales by Item).
    const [sr] = await db
      .insert(salesReceipts)
      .values({
        companyId: ctx.companyId,
        customerId,
        receiptNumber: 1,
        date: daysAgo(3),
        method: 'cash',
        status: 'paid',
        subtotal: '120.00',
        total: '120.00',
      })
      .returning();
    await db.insert(salesReceiptLines).values({
      salesReceiptId: sr.id,
      itemId: inventoryItemId,
      quantity: '1',
      rate: '120',
      amount: '120.00',
    });

    // GL postings for transaction detail + comparative balance sheet.
    await postJournalEntry(ctx, {
      date: new Date('2024-06-01'),
      description: 'Owner funding',
      lines: [
        { accountId: acct['1000'], debit: '1000.00' },
        { accountId: acct['3000'], credit: '1000.00' },
      ],
    });
    await postJournalEntry(ctx, {
      date: new Date('2025-06-01'),
      description: 'Cash sale posting',
      lines: [
        { accountId: acct['1000'], debit: '500.00' },
        { accountId: acct['4000'], credit: '500.00' },
      ],
    });
  });

  // ---- A/R Aging Detail -----------------------------------------------------

  it('arAgingDetail lists each open invoice under the right bucket', async () => {
    const report = await arAgingDetail(ctx);
    const docs = report.rows.filter((r) => r.docType === 'invoice');
    expect(docs).toHaveLength(2); // paid invoice excluded

    const overdue = docs.find((r) => r.docId === overdueInvoiceId)!;
    expect(overdue.bucket).toBe('days31_60');
    expect(overdue.daysPastDue).toBe(45);
    expect(overdue.openBalance).toBe('500.00');

    const current = docs.find((r) => r.docNumber === 'Invoice #2')!;
    expect(current.bucket).toBe('current');
    expect(current.daysPastDue).toBe(0);

    expect(report.bucketTotals.days31_60).toBe('500.00');
    // The $300 payment received 7 days ago is unapplied: it was credited to A/R in full, so it
    // is a credit in the customer's aging (wave-2 foundation, customerCredits.ts) and offsets
    // the $300 current invoice — aging stays equal to the A/R account.
    const credit = report.rows.find((r) => r.docType === 'payment')!;
    expect(credit.openBalance).toBe('-300.00');
    expect(report.bucketTotals.current).toBe('0.00');
    expect(report.total).toBe('500.00');
  });

  it('arAgingDetail honors a backdated cutoff (invoice still current then)', async () => {
    // 50 days ago, invoice #1 existed but was not yet due (due 45 days ago).
    const report = await arAgingDetail(ctx, daysAgo(50));
    const rows = report.rows.filter((r) => r.docType === 'invoice');
    expect(rows).toHaveLength(1);
    expect(rows[0].docId).toBe(overdueInvoiceId);
    expect(rows[0].bucket).toBe('current');
  });

  // ---- A/P Aging Detail -----------------------------------------------------

  it('apAgingDetail reconstructs the bill balance as of the cutoff', async () => {
    // The $400 bill payment is dated 8 days ago, so the bill is settled today...
    const today = await apAgingDetail(ctx);
    expect(today.rows).toHaveLength(0);

    // ...but 10 days ago it was still open and 25 days past due (1-30 bucket).
    const backdated = await apAgingDetail(ctx, daysAgo(10));
    expect(backdated.rows).toHaveLength(1);
    const row = backdated.rows[0];
    expect(row.docId).toBe(openBillId);
    expect(row.docNumber).toBe('Bill B-100');
    expect(row.bucket).toBe('days1_30');
    expect(row.daysPastDue).toBe(25);
    expect(row.openBalance).toBe('400.00');
    expect(backdated.total).toBe('400.00');
  });

  // ---- Open Invoices ----------------------------------------------------------

  it('openInvoices returns only unpaid invoices with totals', async () => {
    const report = await openInvoices(ctx);
    expect(report.rows.map((r) => r.invoiceNumber).sort()).toEqual([1, 2]);
    const overdue = report.rows.find((r) => r.invoiceNumber === 1)!;
    expect(overdue.daysOverdue).toBe(45);
    expect(report.totalOpen).toBe('800.00');
  });

  // ---- Collections ------------------------------------------------------------

  it('collectionsReport groups overdue invoices by customer with contact info', async () => {
    const report = await collectionsReport(ctx);
    expect(report.customers).toHaveLength(1);
    const cust = report.customers[0];
    expect(cust.customerName).toBe('Late Payer LLC');
    expect(cust.email).toBe('ap@latepayer.test');
    expect(cust.phone).toBe('555-0100');
    // Only the overdue invoice — the current one is not a collections item.
    expect(cust.invoices).toHaveLength(1);
    expect(cust.invoices[0].invoiceNumber).toBe(1);
    expect(cust.invoices[0].daysOverdue).toBe(45);
    expect(cust.totalDue).toBe('500.00');
    expect(report.totalDue).toBe('500.00');
  });

  // ---- Missing Checks --------------------------------------------------------

  it('missingChecks finds gaps across expenses and bill payments', async () => {
    const report = await missingChecks(ctx);
    expect(report.accounts).toHaveLength(1);
    const row = report.accounts[0];
    expect(row.accountName).toBe('Checking');
    expect(row.firstNumber).toBe(100);
    expect(row.lastNumber).toBe(105);
    expect(row.checkCount).toBe(4); // 100, 101, 103 (voided counts), 105 — 'ABC' ignored
    expect(row.missing).toEqual([
      { from: 102, to: 102, count: 1 },
      { from: 104, to: 104, count: 1 },
    ]);
    expect(row.missingCount).toBe(2);
  });

  // ---- Check Detail -----------------------------------------------------------

  it('checkDetail merges expense checks and bill payments with split lines', async () => {
    const report = await checkDetail(ctx, { from: daysAgo(20), to: now });
    // 4 expense checks (incl. void + non-numeric) + 1 bill payment.
    expect(report.rows).toHaveLength(5);

    const bp = report.rows.find((r) => r.source === 'bill_payment')!;
    expect(bp.checkNumber).toBe('105');
    expect(bp.payee).toBe('Paper Co');
    expect(bp.lines).toEqual([{ description: null, detail: 'Bill B-100', amount: '400.00' }]);

    const expense100 = report.rows.find((r) => r.checkNumber === '100')!;
    expect(expense100.lines[0].detail).toBe('Office Supplies');
    expect(expense100.lines[0].amount).toBe('50.00');

    const voided = report.rows.find((r) => r.checkNumber === '103')!;
    expect(voided.voided).toBe(true);
    // Total excludes the voided $50 check: 3 x 50 + 400 = 550.
    expect(report.total).toBe('550.00');
  });

  // ---- Deposit Detail ---------------------------------------------------------

  it('depositDetail lists deposits with customer-resolved lines', async () => {
    const report = await depositDetail(ctx, { from: daysAgo(20), to: now });
    expect(report.rows).toHaveLength(2);

    const live = report.rows.find((r) => !r.voided)!;
    expect(live.total).toBe('500.00');
    expect(live.accountName).toBe('Checking');
    const customerLine = live.lines.find((l) => l.customerName !== null)!;
    expect(customerLine.customerName).toBe('Late Payer LLC');
    expect(customerLine.amount).toBe('300.00');
    const otherLine = live.lines.find((l) => l.customerName === null)!;
    expect(otherLine.description).toBe('Vending machine cash');

    // Voided $100 deposit excluded from the total.
    expect(report.total).toBe('500.00');
  });

  // ---- Sales by Item ----------------------------------------------------------

  it('salesByItem aggregates invoices + sales receipts with COGS and margin', async () => {
    const report = await salesByItem(ctx, { from: daysAgo(90), to: now });
    const widget = report.rows.find((r) => r.itemId === inventoryItemId)!;
    // 2 from invoice #1 + 1 from sales receipt.
    expect(widget.quantity).toBe('3');
    expect(widget.revenue).toBe('320.00'); // 200 + 120
    // Review 4: COGS is the COGS each sale POSTED (it ties to the COGS accounts), no longer
    // quantity x today's average cost. These documents are seeded straight into the tables and
    // posted no COGS entries, so their COGS is 0 (tieout.review4.test.ts covers posted COGS).
    expect(widget.cogs).toBe('0.00');
    expect(widget.margin).toBe('320.00');
    expect(widget.marginPct).toBe('100.00');

    const consulting = report.rows.find((r) => r.itemId === serviceItemId)!;
    expect(consulting.revenue).toBe('300.00');
    expect(consulting.cogs).toBe('0.00'); // services have no COGS

    expect(report.totals.revenue).toBe('620.00');
    expect(report.totals.cogs).toBe('0.00');
  });

  it('salesByItem respects the date range', async () => {
    // Only the last 4 days: just the sales receipt (1 Widget @ 120).
    const report = await salesByItem(ctx, { from: daysAgo(4), to: now });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].quantity).toBe('1');
    expect(report.rows[0].revenue).toBe('120.00');
  });

  // ---- Purchases by Item -------------------------------------------------------

  it('purchasesByItem aggregates bill lines per item', async () => {
    const report = await purchasesByItem(ctx, { from: daysAgo(90), to: now });
    expect(report.rows).toHaveLength(1);
    const row = report.rows[0];
    expect(row.itemId).toBe(inventoryItemId);
    expect(row.quantity).toBe('10');
    expect(row.cost).toBe('400.00');
    expect(row.avgUnitCost).toBe('40.00');
    expect(report.totals.cost).toBe('400.00');
  });

  // ---- Transaction Detail --------------------------------------------------------

  it('transactionDetail returns posted lines with running totals (balanced overall)', async () => {
    const report = await transactionDetail(ctx);
    expect(report.count).toBe(4); // two 2-line entries
    expect(report.totalDebit).toBe('1500.00');
    expect(report.totalCredit).toBe('1500.00');
    // Debits and credits cancel — running total ends at zero.
    expect(report.rows[report.rows.length - 1].runningTotal).toBe('0.00');
    expect(report.truncated).toBe(false);
  });

  it('transactionDetail filters by date range and account', async () => {
    const byDate = await transactionDetail(ctx, {
      from: new Date('2025-01-01'),
      to: new Date('2025-12-31'),
    });
    expect(byDate.count).toBe(2);
    expect(byDate.rows.every((r) => r.description === 'Cash sale posting')).toBe(true);

    const byAccount = await transactionDetail(ctx, { accountId: acct['1000'] });
    expect(byAccount.count).toBe(2);
    expect(byAccount.totalDebit).toBe('1500.00');
    // Running total over just the checking lines = 1000 then 1500.
    expect(byAccount.rows[0].runningTotal).toBe('1000.00');
    expect(byAccount.rows[1].runningTotal).toBe('1500.00');
  });

  it('transactionDetail free-text search matches the entry description', async () => {
    const report = await transactionDetail(ctx, { search: 'owner funding' });
    expect(report.count).toBe(2);
    expect(report.rows.every((r) => r.description === 'Owner funding')).toBe(true);
  });

  // ---- Comparative Balance Sheet ---------------------------------------------------

  it('balanceSheetComparative shows current vs prior with the change', async () => {
    const report = await balanceSheetComparative(
      ctx,
      new Date('2025-12-31'),
      new Date('2024-12-31'),
    );
    const checking = report.assets.find((r) => r.name === 'Checking')!;
    expect(checking.current).toBe('1500.00');
    expect(checking.prior).toBe('1000.00');
    expect(checking.change).toBe('500.00');

    expect(report.totals.assets.current).toBe('1500.00');
    expect(report.totals.assets.prior).toBe('1000.00');

    // 2025 net income (the $500 sale) flows into retained earnings.
    expect(report.retainedEarnings.current).toBe('500.00');
    expect(report.retainedEarnings.prior).toBe('0.00');
    expect(report.balanced).toBe(true);
  });
});
