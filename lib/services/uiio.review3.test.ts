/**
 * Review round 3 (UI <-> API round-trips, import/export) regression tests.
 *
 *  - Editing a bill keeps the billed-invoice link of an already-invoiced billable line, and
 *    refuses a financial change to such a line (as checks/expenses do).
 *  - An untouched bill / expense item line re-saves its stored amount (the edit forms re-send the
 *    amount, not qty x the rounded unit cost they display).
 *  - Purchase-order lines keep 4-decimal quantity / rate, so edits and Convert to Bill keep the
 *    PO amount.
 *  - A list exported to CSV (formula cells get a leading apostrophe) re-imports without
 *    duplicating names that start with - = + @.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, customers, vendors, items, billLines } from '@/lib/db/schema';
import { csvSafeText, csvUnsafeText } from '@/lib/csv';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { createBill, getBill, updateBill } from './bills';
import { listUnbilled, createInvoiceWithBillables } from './billables';
import { createCustomer } from './customers';
import { createExpense, getExpense, updateExpense } from './expenses';
import { exportListCsv } from './listExport';
import { importCustomersCSV } from './qbImport';
import { readCsv } from './qbGlFiles';
import { parseCSV } from './import';
import { convertToBill, createPurchaseOrder, getPurchaseOrder, updatePurchaseOrder } from './purchaseOrders';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review3-uiio');
let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};
let customerId: string;
let vendorId: string;
let itemId: string;

/** The edit forms' rule (app/bills/page.tsx, app/expenses/page.tsx): an untouched loaded item
 *  line sends its stored amount; the displayed unit cost is amount / qty rounded to 4 places. */
function shownUnitCost(amount: string, quantity: string): string {
  const qty = Number(quantity) || 1;
  return String(parseFloat((Number(amount) / qty).toFixed(4)));
}

describe('review3 ui/io', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'r3@test.local', name: 'R3', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'R3 Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['2200', 'Sales Tax Payable', 'liability', 'long_term_liability'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['6000', 'Job Materials', 'expense', 'operating_expenses'],
      ['6100', 'Other Materials', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    }
    const [cust] = await db.insert(customers).values({ companyId: company.id, displayName: 'Jobsite LLC' }).returning();
    customerId = cust.id;
    const [vend] = await db.insert(vendors).values({ companyId: company.id, displayName: 'Lumber Yard' }).returning();
    vendorId = vend.id;
    const [it0] = await db
      .insert(items)
      .values({ companyId: company.id, name: 'Screws', type: 'non_inventory', expenseAccountId: acct['6000'], incomeAccountId: acct['4000'] })
      .returning();
    itemId = it0.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('editing a bill keeps the billed-invoice link of an invoiced billable line; a financial change to it is refused', async () => {
    const bill = await createBill(ctx, {
      vendorId,
      date: new Date('2025-06-01'),
      lines: [
        { accountId: acct['6000'], description: 'Lumber', amount: '200.00', customerId },
        { accountId: acct['6100'], description: 'Nails', amount: '15.00' },
      ],
    });
    const [bl] = await db.select().from(billLines).where(eq(billLines.billId, bill.id)).orderBy(billLines.lineOrder);
    const inv = await createInvoiceWithBillables(
      ctx,
      { customerId, date: new Date('2025-06-10'), lines: [] },
      { billLineIds: [bl.id] },
    );
    expect((await listUnbilled(ctx, customerId)).costs).toHaveLength(0);

    // The Bills page re-sends the same lines (memo fix, the other line's amount changed).
    await updateBill(ctx, bill.id, {
      vendorId,
      date: new Date('2025-06-01'),
      memo: 'fixed memo',
      lines: [
        { accountId: acct['6000'], description: 'Lumber (deck)', amount: '200.00', customerId },
        { accountId: acct['6100'], description: 'Nails', amount: '18.00' },
      ],
    });
    const after = await db.select().from(billLines).where(eq(billLines.billId, bill.id)).orderBy(billLines.lineOrder);
    expect(after[0].billedInvoiceId).toBe(inv.id);
    expect(after[1].billedInvoiceId).toBeNull();
    expect((await listUnbilled(ctx, customerId)).costs).toHaveLength(0);

    // Changing the billed line's amount is refused, and nothing changes.
    await expect(
      updateBill(ctx, bill.id, {
        vendorId,
        date: new Date('2025-06-01'),
        lines: [
          { accountId: acct['6000'], description: 'Lumber', amount: '250.00', customerId },
          { accountId: acct['6100'], description: 'Nails', amount: '18.00' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const still = await getBill(ctx, bill.id);
    expect(still.total).toBe('218.00');
    const [kept] = await db.select().from(billLines).where(eq(billLines.id, after[0].id));
    expect(kept.billedInvoiceId).toBe(inv.id);
  });

  it('opening and saving an unchanged bill item line keeps its amount', async () => {
    const bill = await createBill(ctx, {
      vendorId,
      date: new Date('2025-06-02'),
      lines: [{ itemId, quantity: '300', amount: '1000.00' }],
    });
    expect(bill.total).toBe('1000.00');
    const l = (await getBill(ctx, bill.id)).lines[0];
    // Old form payload (qty + rounded unit cost) drifted to 999.99.
    expect(Number(shownUnitCost(l.amount, l.quantity)) * 300).toBeCloseTo(999.99, 2);
    const updated = await updateBill(ctx, bill.id, {
      vendorId,
      date: new Date('2025-06-02'),
      lines: [{ itemId, quantity: String(Number(l.quantity)), amount: l.amount }],
    });
    expect(updated.total).toBe('1000.00');
  });

  it('opening and saving an unchanged check item line keeps its amount', async () => {
    const exp = await createExpense(ctx, {
      vendorId,
      date: new Date('2025-06-03'),
      method: 'cash',
      paymentAccountId: acct['1000'],
      lines: [{ itemId, quantity: '300', amount: '1000.00' }],
    });
    const d = await getExpense(ctx, exp.id);
    const l = d.lines[0];
    expect(l.unitCost).toBe('3.3333'); // stored rounded: qty x stored cost = 999.99
    await updateExpense(ctx, exp.id, {
      vendorId,
      date: new Date('2025-06-03'),
      method: 'cash',
      paymentAccountId: acct['1000'],
      lines: [{ itemId, quantity: String(Number(l.quantity)), amount: String(Math.abs(Number(l.amount)).toFixed(2)) }],
    });
    expect((await getExpense(ctx, exp.id)).total).toBe('1000.00');
  });

  it('purchase-order lines keep 4-decimal rates, so an edit and Convert to Bill keep the PO amount', async () => {
    const po = await createPurchaseOrder(ctx, {
      vendorId,
      date: new Date('2025-06-04'),
      lines: [{ itemId, quantity: '1000', rate: '0.125' }],
    });
    const loaded = await getPurchaseOrder(ctx, po.id);
    expect(Number(loaded.lines[0].rate)).toBe(0.125);
    expect(loaded.total).toBe('125.00');
    // The PO page re-sends String(parseFloat(rate)).
    const upd = await updatePurchaseOrder(ctx, po.id, {
      vendorId,
      date: new Date('2025-06-04'),
      lines: [{ id: loaded.lines[0].id, itemId, quantity: String(parseFloat(loaded.lines[0].quantity)), rate: String(parseFloat(loaded.lines[0].rate)) }],
    } as never);
    expect((upd as { total: string }).total).toBe('125.00');
    const bill = await convertToBill(ctx, po.id);
    expect((bill as { total: string }).total).toBe('125.00');
  });

  it('csvUnsafeText is the inverse of csvSafeText for formula-like text', () => {
    for (const s of ['-Dash Corp', '=SUM(A1)', '+1 Plumbing', '@home', 'Plain', '-150.00', "O'Brien", '']) {
      expect(csvUnsafeText(csvSafeText(s))).toBe(s);
    }
  });

  it('a customer list exported to CSV re-imports without duplicating names that start with -', async () => {
    await createCustomer(ctx, { displayName: '-Dash Corp' });
    const { csv } = await exportListCsv(ctx, 'customers');
    expect(csv).toContain("'-Dash Corp");
    const counts = await importCustomersCSV(ctx, csv, { displayName: 'Name' });
    const rows = await db.select({ name: customers.displayName }).from(customers).where(eq(customers.companyId, ctx.companyId));
    expect(rows.map((r) => r.name)).not.toContain("'-Dash Corp");
    expect(counts.customers).toBe(0);
    expect(counts.issues.some((i) => i.reason === 'duplicate' && i.name === '-Dash Corp')).toBe(true);
  });

  it('the GL / open-items CSV reader and the bank CSV parser drop the export apostrophe', () => {
    const grid = readCsv(`Name,Memo\r\n"'-Dash Corp","'=Hi"\r\n`);
    expect(grid[1].cells).toEqual(['-Dash Corp', '=Hi']);
    const txns = parseCSV(`Date,Description,Amount\n2025-01-15,'-Refund ACME,-5.00\n`, {
      dateCol: 'Date',
      descriptionCol: 'Description',
      amountCol: 'Amount',
    });
    expect(txns[0].description).toBe('-Refund ACME');
    expect(txns[0].amount).toBe('-5.00');
  });
});
