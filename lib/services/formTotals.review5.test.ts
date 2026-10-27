/**
 * Review round 5 (team uia): the live totals the forms show are what the services save.
 *
 * lib/invoiceLineMath.ts (invoice form) and lib/purchaseLineMath.ts (Enter Bills, Create Purchase
 * Orders, Create Item Receipts, PO Receive & Bill) are client-side copies of the services'
 * rounding. These tests save the same documents through the real services and compare:
 *  - an invoice with retainage AND a payment line: the form's "Due now" is the server's
 *    total − retainage (it showed the balance net of the payment, so the payment came off twice);
 *  - bill / item receipt item lines of 3 × 1.335 save 4.01 each (the forms showed 4.00 / 8.01);
 *  - a purchase order keeps its rate at 4 places, and Receive & Bill bills round2(qty × rate).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, customers, vendors, items, bills } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { createItem } from './items';
import { createInvoice } from './invoices';
import { createBill } from './bills';
import { createPurchaseOrder, convertToBill, getPurchaseOrder } from './purchaseOrders';
import { createItemReceipt } from './itemReceipts';
import { trialBalance } from './reports';
import { invoiceFormTotals } from '@/lib/invoiceLineMath';
import { billItemLineAmount, poLineAmount, sumLineAmounts } from '@/lib/purchaseLineMath';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-form-totals-review5');
let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
let customerId: string;
let vendorId: string;
let serviceItemId: string;
let paymentItemId: string;

describe('form totals as the services save them (review round 5)', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'r5uia@test.local', name: 'R5', passwordHash: 'x' }).returning();
    const [c] = await db.insert(companies).values({ name: 'R5 UIA Co', ownerId: u.id }).returning();
    ctx = { db, companyId: c.id, userId: u.id };
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1050', 'Undeposited Funds', 'asset', 'undeposited_funds'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['2200', 'Sales Tax Payable', 'liability', 'long_term_liability'],
      ['4000', 'Sales', 'revenue', 'sales'],
      ['6000', 'Supplies', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    }
    const [cust] = await db.insert(customers).values({ companyId: c.id, displayName: 'Builder Co' }).returning();
    customerId = cust.id;
    const [vend] = await db.insert(vendors).values({ companyId: c.id, displayName: 'Supply House' }).returning();
    vendorId = vend.id;
    const [svc] = await db
      .insert(items)
      .values({ companyId: c.id, name: 'Fasteners', type: 'service', expenseAccountId: acct['6000'], incomeAccountId: acct['4000'] })
      .returning();
    serviceItemId = svc.id;
    paymentItemId = (await createItem(ctx, { name: 'Deposit Applied', type: 'payment' })).id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('invoice with retainage and a payment line: "Due now" = total − retainage, Balance Due = that − payments', async () => {
    const inv = await createInvoice(ctx, {
      customerId,
      date: new Date('2026-06-01'),
      lines: [
        { accountId: acct['4000'], description: 'Phase 1', quantity: 1, rate: '1000.05' },
        { itemId: paymentItemId, description: 'Deposit received', quantity: 1, rate: '100' },
      ],
      retainagePercent: 10,
    });
    const form = invoiceFormTotals({
      lines: [
        { kind: 'income', quantity: '1', rate: '1000.05', taxable: false },
        { kind: 'payment', quantity: '1', rate: '100', taxable: false },
      ],
      discount: '',
      discountType: 'amount',
      taxRate: '',
      retainagePercent: '10',
    });
    expect(form.total.toFixed(2)).toBe(inv.total);
    expect(form.retainage.toFixed(2)).toBe(inv.retainageAmount);
    expect(form.balanceDue.toFixed(2)).toBe(inv.balanceDue); // 800.04
    // The server's dueNow (total − retainage) is the balance before the payment line.
    expect(form.dueNow.toFixed(2)).toBe('900.04');
    expect(form.dueNow.minus(form.payments).toFixed(2)).toBe(inv.balanceDue);
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('a bill with two item lines of 3 × 1.335 saves 8.02, what Enter Bills now shows', async () => {
    const bill = await createBill(ctx, {
      vendorId,
      date: new Date('2026-06-02'),
      lines: [
        { itemId: serviceItemId, quantity: '3', unitCost: '1.335' },
        { itemId: serviceItemId, quantity: '3', unitCost: '1.335' },
      ],
    });
    const shown = sumLineAmounts([billItemLineAmount('3', '1.335'), billItemLineAmount('3', '1.335')]);
    expect(bill.total).toBe('8.02');
    expect(shown.toFixed(2)).toBe(bill.total);
  });

  it('an item receipt of 3 × 1.335 saves 4.01, what Create Item Receipts now shows', async () => {
    const receipt = await createItemReceipt(ctx, {
      vendorId,
      date: new Date('2026-06-03'),
      lines: [{ itemId: serviceItemId, quantity: '3', unitCost: '1.335' }],
    });
    expect(Number(receipt.total).toFixed(2)).toBe(billItemLineAmount('3', '1.335').toFixed(2));
  });

  it('a purchase order and its Receive & Bill total match the form previews', async () => {
    const po = await createPurchaseOrder(ctx, {
      vendorId,
      date: new Date('2026-06-04'),
      lines: [
        { accountId: acct['6000'], description: 'Bolts', quantity: '3', rate: '1.335' },
        { accountId: acct['6000'], description: 'Washers', quantity: '1000', rate: '1.00004' },
      ],
    });
    const shown = sumLineAmounts([poLineAmount('3', '1.335'), poLineAmount('1000', '1.00004')]);
    expect(Number(po.total).toFixed(2)).toBe(shown.toFixed(2)); // 4.01 + 1000.00
    expect(shown.toFixed(2)).toBe('1004.01');

    const detail = await getPurchaseOrder(ctx, po.id);
    const bolts = detail.lines.find((l) => l.description === 'Bolts')!;
    // Receive & Bill: the dialog's total for 3 of the bolts.
    const converted = await convertToBill(ctx, po.id, { lines: [{ lineId: bolts.id, quantity: '3' }] });
    const [bill] = await db.select().from(bills).where(eq(bills.id, converted.id));
    expect(bill.total).toBe(billItemLineAmount('3', bolts.rate).toFixed(2));
    expect(bill.total).toBe('4.01');
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });
});
