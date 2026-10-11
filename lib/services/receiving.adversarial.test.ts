/**
 * Enhanced receiving — independent QA (adversarial) tests.
 *
 * Rollback on posting failure (closed period: no bill, no receipt-quantity claim, no PPV account),
 * cross-company / viewer / malformed input, idempotency (re-submitting a bill), penny-exact
 * accrual relief across several partial bills, receipt-void guards, preferences validation,
 * GL inventory vs subledger valuation after variances, and the bill-void path after part of the
 * re-costed stock was sold (average cost).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, asc, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  accounts,
  vendors,
  customers,
  items,
  bills,
  fiscalPeriods,
  inventoryLayers,
  itemReceiptLines,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { createPurchaseOrder, getPurchaseOrder } from './purchaseOrders';
import { voidBill, getBill } from './bills';
import { createInvoice } from './invoices';
import { createItemReceipt, getItemReceipt, voidItemReceipt, ITEM_RECEIPT_ACCRUAL_CODE } from './itemReceipts';
import {
  enterBillForReceivedItems,
  listOpenReceiptLines,
  poReceivingStatus,
  previewReceiptBill,
  updateReceivingSettings,
} from './receiving';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-enhanced-receiving-qa');
let ctx: ServiceContext;
let otherCtx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};
let vendorId: string;
let customerId: string;
let avgItem: string; // inventory, average cost
let fifoItem: string; // inventory, FIFO
let foreignVendor: string;
let foreignLine: string;

async function balanceOf(code: string): Promise<string> {
  const [row] = await db
    .select({ balance: accounts.balance })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
  return row ? Number(row.balance).toFixed(2) : '0.00';
}
async function itemRow(id: string) {
  const [row] = await db.select().from(items).where(eq(items.id, id));
  return row;
}
async function expectBalanced() {
  expect((await trialBalance(ctx)).balanced).toBe(true);
}
async function lineIds(receiptId: string) {
  const rows = await db
    .select()
    .from(itemReceiptLines)
    .where(eq(itemReceiptLines.itemReceiptId, receiptId))
    .orderBy(asc(itemReceiptLines.lineOrder));
  return rows.map((r) => r.id);
}
async function billCount() {
  return (await db.select({ id: bills.id }).from(bills).where(eq(bills.companyId, ctx.companyId))).length;
}

describe('Enhanced receiving (QA)', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'rqa@test.local', name: 'RQA', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Recv QA', ownerId: user.id }).returning();
    const [otherCo] = await db.insert(companies).values({ name: 'Recv Other', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    otherCtx = { db, companyId: otherCo.id, userId: user.id };

    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['1300', 'Inventory Asset', 'asset', 'inventory'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['2200', 'Sales Tax Payable', 'liability', 'accounts_payable'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
    ];
    for (const [code, name, type, subtype] of defs) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
      await createAccount(otherCtx, { code, name, type: type as never, subtype });
    }
    vendorId = (await db.insert(vendors).values({ companyId: company.id, displayName: 'Supplier' }).returning())[0].id;
    customerId = (await db.insert(customers).values({ companyId: company.id, displayName: 'Buyer' }).returning())[0].id;
    const inv = { type: 'inventory' as const, assetAccountId: acct['1300'], expenseAccountId: acct['5000'], quantityOnHand: '0', averageCost: '0' };
    avgItem = (await db.insert(items).values({ companyId: company.id, name: 'AvgThing', salesPrice: '20.00', ...inv }).returning())[0].id;
    fifoItem = (await db.insert(items).values({ companyId: company.id, name: 'FifoThing', salesPrice: '30.00', ...inv }).returning())[0].id;
    await db.insert(inventoryLayers).values({ companyId: company.id, itemId: fifoItem, date: new Date('2025-01-01'), quantityRemaining: '0', unitCost: '1' });

    // Foreign company receipt line (must never be billable from this company).
    foreignVendor = (await db.insert(vendors).values({ companyId: otherCo.id, displayName: 'Foreign' }).returning())[0].id;
    const [fAcct] = await db.select().from(accounts).where(and(eq(accounts.companyId, otherCo.id), eq(accounts.code, '1300')));
    const fItem = (
      await db.insert(items).values({ companyId: otherCo.id, name: 'Foreign item', type: 'inventory', assetAccountId: fAcct.id, quantityOnHand: '0', averageCost: '0' }).returning()
    )[0].id;
    const fr = await createItemReceipt(otherCtx, { vendorId: foreignVendor, date: new Date('2026-03-01'), lines: [{ itemId: fItem, quantity: 1, unitCost: '9.00' }] });
    [foreignLine] = (await db.select().from(itemReceiptLines).where(eq(itemReceiptLines.itemReceiptId, fr.id))).map((l) => l.id);

    await updateReceivingSettings(ctx, { enhancedReceiving: true, varianceMode: 'inventory' });
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('a bill dated in a CLOSED period rolls back completely (no bill, no claim, no PPV account)', async () => {
    await updateReceivingSettings(ctx, { varianceMode: 'ppv' });
    const r = await createItemReceipt(ctx, { vendorId, date: new Date('2026-03-02'), lines: [{ itemId: avgItem, quantity: 4, unitCost: '5.00' }] });
    const [l] = await lineIds(r.id);
    await db.insert(fiscalPeriods).values({
      companyId: ctx.companyId,
      periodStart: new Date('2026-01-01T00:00:00Z'),
      periodEnd: new Date('2026-01-31T23:59:59Z'),
      isClosed: true,
    });
    const bills0 = await billCount();
    await expect(
      enterBillForReceivedItems(ctx, { vendorId, date: new Date('2026-01-15'), lines: [{ receiptLineId: l, quantity: 4, unitCost: '6.00' }] }),
    ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
    expect(await billCount()).toBe(bills0);
    const [line] = await db.select().from(itemReceiptLines).where(eq(itemReceiptLines.id, l));
    expect(Number(line.quantityBilled)).toBe(0);
    expect((await getItemReceipt(ctx, r.id)).status).toBe('open');
    const ppv = await db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.name, 'Purchase Price Variance')));
    expect(ppv).toHaveLength(0);
    expect(await balanceOf(ITEM_RECEIPT_ACCRUAL_CODE)).toBe('20.00');
    await expectBalanced();

    // Same bill in an open period works, and posts the variance to an auto-created PPV account.
    const bill = await enterBillForReceivedItems(ctx, { vendorId, date: new Date('2026-03-03'), lines: [{ receiptLineId: l, quantity: 4, unitCost: '6.00' }] });
    expect(bill.total).toBe('24.00');
    const [ppvRow] = await db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.name, 'Purchase Price Variance')));
    expect(Number(ppvRow.balance).toFixed(2)).toBe('4.00');
    expect(await balanceOf(ITEM_RECEIPT_ACCRUAL_CODE)).toBe('0.00');
    await expectBalanced();
    await updateReceivingSettings(ctx, { varianceMode: 'inventory' });
  });

  it('re-submitting the same bill (double click) is rejected and changes nothing', async () => {
    const r = await createItemReceipt(ctx, { vendorId, date: new Date('2026-03-04'), lines: [{ itemId: avgItem, quantity: 2, unitCost: '5.00' }] });
    const [l] = await lineIds(r.id);
    const input = { vendorId, billNumber: 'DUP-1', date: new Date('2026-03-05'), lines: [{ receiptLineId: l, quantity: 2, unitCost: '5.00' }] };
    await enterBillForReceivedItems(ctx, input);
    const ap = await balanceOf('2000');
    const n = await billCount();
    await expect(enterBillForReceivedItems(ctx, input)).rejects.toMatchObject({ code: expect.stringMatching(/CONFLICT|VALIDATION/) });
    expect(await balanceOf('2000')).toBe(ap);
    expect(await billCount()).toBe(n);
    await expectBalanced();
  });

  it('rejects malformed, foreign and viewer requests without side effects', async () => {
    const r = await createItemReceipt(ctx, { vendorId, date: new Date('2026-03-06'), lines: [{ itemId: avgItem, quantity: 3, unitCost: '5.00' }] });
    const [l] = await lineIds(r.id);
    const base = { vendorId, date: new Date('2026-03-07') };
    const n = await billCount();
    await expect(enterBillForReceivedItems(ctx, { ...base, lines: [] })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(enterBillForReceivedItems(ctx, { ...base, lines: [{ receiptLineId: l, quantity: 1, unitCost: '-1' }] })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(enterBillForReceivedItems(ctx, { ...base, lines: [{ receiptLineId: l, quantity: -1, unitCost: '5' }] })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(enterBillForReceivedItems(ctx, { ...base, lines: [{ receiptLineId: l, quantity: 0, unitCost: '5' }] })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(enterBillForReceivedItems(ctx, { ...base, lines: [{ receiptLineId: l, quantity: '3.0001', unitCost: '5' }] })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(enterBillForReceivedItems(ctx, { ...base, lines: [{ receiptLineId: l, quantity: 1, unitCost: '0' }] })).rejects.toMatchObject({ code: 'VALIDATION' }); // $0 bill
    await expect(
      enterBillForReceivedItems(ctx, { ...base, lines: [{ receiptLineId: l, quantity: 1, unitCost: '5' }, { receiptLineId: l, quantity: 1, unitCost: '5' }] }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    // Another company's receipt line / vendor.
    await expect(enterBillForReceivedItems(ctx, { ...base, lines: [{ receiptLineId: foreignLine, quantity: 1, unitCost: '9' }] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(enterBillForReceivedItems(ctx, { vendorId: foreignVendor, date: base.date, lines: [{ receiptLineId: foreignLine, quantity: 1, unitCost: '9' }] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(listOpenReceiptLines(ctx, foreignVendor)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(previewReceiptBill(ctx, { ...base, lines: [{ receiptLineId: foreignLine, quantity: 1, unitCost: '9' }] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Viewer.
    await expect(
      enterBillForReceivedItems({ ...ctx, role: 'viewer' }, { ...base, lines: [{ receiptLineId: l, quantity: 1, unitCost: '5' }] }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(updateReceivingSettings({ ...ctx, role: 'viewer' }, { varianceMode: 'ppv' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await billCount()).toBe(n);
    const [line] = await db.select().from(itemReceiptLines).where(eq(itemReceiptLines.id, l));
    expect(Number(line.quantityBilled)).toBe(0);
  });

  it('receiving preferences reject a foreign or non-expense PPV account', async () => {
    const [foreignExpense] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.companyId, otherCtx.companyId), eq(accounts.code, '5000')));
    await expect(updateReceivingSettings(ctx, { ppvAccountId: foreignExpense.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(updateReceivingSettings(ctx, { ppvAccountId: acct['1300'] })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateReceivingSettings(ctx, { varianceMode: 'bogus' as never })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('penny-exact accrual relief across three partial bills of an odd unit cost', async () => {
    const accrual0 = Number(await balanceOf(ITEM_RECEIPT_ACCRUAL_CODE));
    const r = await createItemReceipt(ctx, { vendorId, date: new Date('2026-03-10'), lines: [{ itemId: fifoItem, quantity: 3, unitCost: '3.3333' }] });
    const [l] = await lineIds(r.id);
    const accrualAfterReceipt = Number(await balanceOf(ITEM_RECEIPT_ACCRUAL_CODE)) - accrual0;
    expect(accrualAfterReceipt.toFixed(2)).toBe('10.00');
    for (const day of ['11', '12', '13']) {
      await enterBillForReceivedItems(ctx, { vendorId, date: new Date(`2026-03-${day}`), lines: [{ receiptLineId: l, quantity: 1, unitCost: '3.3333' }] });
      await expectBalanced();
    }
    // Every cent the receipt accrued has been relieved — nothing stranded in 2050.
    expect((Number(await balanceOf(ITEM_RECEIPT_ACCRUAL_CODE)) - accrual0).toFixed(2)).toBe('0.00');
    expect((await getItemReceipt(ctx, r.id)).status).toBe('billed');
  });

  it('GL inventory equals the FIFO layer valuation after a capitalized variance split across odd quantities', async () => {
    const r = await createItemReceipt(ctx, { vendorId, date: new Date('2026-03-20'), lines: [{ itemId: fifoItem, quantity: 7, unitCost: '10.00' }] });
    const [l] = await lineIds(r.id);
    await enterBillForReceivedItems(ctx, { vendorId, date: new Date('2026-03-21'), lines: [{ receiptLineId: l, quantity: 7, unitCost: '10.1429' }] }); // 71.00 vs 70.00
    const layers = await db.select().from(inventoryLayers).where(eq(inventoryLayers.itemId, fifoItem));
    const layerValue = layers.reduce((s, x) => s + Number(x.quantityRemaining) * Number(x.unitCost), 0);
    const avgValue = (await db.select().from(items).where(eq(items.type, 'inventory')))
      .filter((i) => i.companyId === ctx.companyId && i.id !== fifoItem)
      .reduce((s, i) => s + Number(i.quantityOnHand ?? 0) * Number(i.averageCost ?? 0), 0);
    const gl = Number(await balanceOf('1300'));
    expect(Math.abs(gl - (layerValue + avgValue))).toBeLessThan(0.01);
    await expectBalanced();
  });

  it('cannot void a receipt that is partly billed; after voiding the bill it can be voided and the PO reopens', async () => {
    const po = await createPurchaseOrder(ctx, { vendorId, date: new Date('2026-04-01'), lines: [{ itemId: avgItem, quantity: 5, rate: '5.00' }] });
    const r = await createItemReceipt(ctx, { vendorId, date: new Date('2026-04-02'), purchaseOrderId: po.id, lines: [{ itemId: avgItem, quantity: 5, unitCost: '5.00' }] });
    const [l] = await lineIds(r.id);
    const bill = await enterBillForReceivedItems(ctx, { vendorId, date: new Date('2026-04-03'), lines: [{ receiptLineId: l, quantity: 2, unitCost: '5.00' }] });
    expect((await getPurchaseOrder(ctx, po.id)).status).toBe('partial');
    expect((await poReceivingStatus(ctx, po.id)).lines[0]).toMatchObject({ received: '5.0000', billed: '2.0000' });
    await expect(voidItemReceipt(ctx, r.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await voidBill(ctx, bill.id);
    await voidBill(ctx, bill.id); // idempotent
    expect((await getBill(ctx, bill.id)).status).toBe('void');
    await voidItemReceipt(ctx, r.id);
    expect((await getPurchaseOrder(ctx, po.id)).status).toBe('open');
    expect((await poReceivingStatus(ctx, po.id)).lines[0]).toMatchObject({ received: '0.0000', billed: '0.0000' });
    await expect(poReceivingStatus(otherCtx, po.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expectBalanced();
  });

  it('a PO with two lines closes only once BOTH are received AND billed', async () => {
    const po = await createPurchaseOrder(ctx, {
      vendorId,
      date: new Date('2026-04-10'),
      lines: [
        { itemId: avgItem, quantity: 2, rate: '5.00' },
        { itemId: fifoItem, quantity: 2, rate: '8.00' },
      ],
    });
    const r = await createItemReceipt(ctx, {
      vendorId,
      date: new Date('2026-04-11'),
      purchaseOrderId: po.id,
      lines: [
        { itemId: avgItem, quantity: 2, unitCost: '5.00' },
        { itemId: fifoItem, quantity: 2, unitCost: '8.00' },
      ],
    });
    const [la, lf] = await lineIds(r.id);
    await enterBillForReceivedItems(ctx, { vendorId, date: new Date('2026-04-12'), lines: [{ receiptLineId: la, quantity: 2, unitCost: '5.00' }] });
    expect((await getPurchaseOrder(ctx, po.id)).status).toBe('partial');
    await enterBillForReceivedItems(ctx, { vendorId, date: new Date('2026-04-13'), lines: [{ receiptLineId: lf, quantity: 2, unitCost: '8.00' }] });
    expect((await getPurchaseOrder(ctx, po.id)).status).toBe('closed');
    await expectBalanced();
  });

  it('voiding a variance bill after part of the re-costed average-cost stock was sold: refuse, or restore the receipt cost', async () => {
    // Fresh average-cost item so earlier tests do not blur the numbers.
    const [fresh] = await db
      .insert(items)
      .values({ companyId: ctx.companyId, name: 'AvgFresh', type: 'inventory', salesPrice: '20.00', assetAccountId: acct['1300'], expenseAccountId: acct['5000'], quantityOnHand: '0', averageCost: '0' })
      .returning();
    const r = await createItemReceipt(ctx, { vendorId, date: new Date('2026-05-01'), lines: [{ itemId: fresh.id, quantity: 10, unitCost: '5.00' }] });
    const [l] = await lineIds(r.id);
    const bill = await enterBillForReceivedItems(ctx, { vendorId, date: new Date('2026-05-02'), lines: [{ receiptLineId: l, quantity: 10, unitCost: '6.00' }] });
    expect((await itemRow(fresh.id)).averageCost).toBe('6.0000'); // +10.00 capitalized
    await createInvoice(ctx, { customerId, date: new Date('2026-05-03'), lines: [{ itemId: fresh.id, quantity: 5, rate: '20.00' }] });
    expect((await itemRow(fresh.id)).quantityOnHand).toBe('5.0000');

    let refused = false;
    try {
      await voidBill(ctx, bill.id);
    } catch (err) {
      expect(err).toMatchObject({ code: 'CONFLICT' });
      refused = true;
    }
    if (!refused) {
      // Bill gone -> the 5 units still on hand cost what the receipt said: 5.00 each.
      // (Half the 10.00 capitalized variance already flowed to COGS with the sold units, so
      // reversing all 10.00 from the remaining stock values it at 4.00 — understated.)
      expect((await itemRow(fresh.id)).averageCost).toBe('5.0000');
    } else {
      expect((await getBill(ctx, bill.id)).status).not.toBe('void');
    }
    await expectBalanced();
  });
});
