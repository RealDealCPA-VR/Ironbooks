/**
 * Enhanced receiving tests: receiving separated from billing, quantity + price variances,
 * variance posting (inventory/COGS split for average-cost and FIFO items, PPV account,
 * non-inventory expense), write-off of never-billed quantity, PO "closed only when fully
 * received AND billed", bill void unwinding, legacy receipt->bill conversion, and a balanced
 * trial balance after every step.
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
  inventoryLayers,
  itemReceiptLines,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { createPurchaseOrder, getPurchaseOrder } from './purchaseOrders';
import { getBill, updateBill, voidBill } from './bills';
import { createInvoice } from './invoices';
import {
  createItemReceipt,
  getItemReceipt,
  convertToBill as convertReceiptToBill,
  ITEM_RECEIPT_ACCRUAL_CODE,
} from './itemReceipts';
import {
  enterBillForReceivedItems,
  listOpenReceiptLines,
  poReceivingStatus,
  previewReceiptBill,
  updateReceivingSettings,
} from './receiving';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-enhanced-receiving');
let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};
let vendorId: string;
let otherVendorId: string;
let customerId: string;
let widgetId: string; // inventory, average cost
let gadgetId: string; // inventory, FIFO
let freightId: string; // service with expense account

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
  const tb = await trialBalance(ctx);
  expect(tb.balanced).toBe(true);
}

async function receiptLineIds(receiptId: string) {
  const rows = await db
    .select()
    .from(itemReceiptLines)
    .where(eq(itemReceiptLines.itemReceiptId, receiptId))
    .orderBy(asc(itemReceiptLines.lineOrder));
  return rows.map((r) => r.id);
}

describe('Enhanced receiving', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'recv@test.local', name: 'Recv', passwordHash: 'x' })
      .returning();
    const [company] = await db.insert(companies).values({ name: 'Recv Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };

    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['1300', 'Inventory Asset', 'asset', 'inventory'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['2200', 'Sales Tax Payable', 'liability', 'accounts_payable'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
      ['6300', 'Freight', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    }
    vendorId = (await db.insert(vendors).values({ companyId: company.id, displayName: 'Supplier' }).returning())[0].id;
    otherVendorId = (await db.insert(vendors).values({ companyId: company.id, displayName: 'Other' }).returning())[0].id;
    customerId = (await db.insert(customers).values({ companyId: company.id, displayName: 'Buyer' }).returning())[0].id;

    const inv = { type: 'inventory' as const, assetAccountId: acct['1300'], expenseAccountId: acct['5000'], quantityOnHand: '0', averageCost: '0' };
    widgetId = (await db.insert(items).values({ companyId: company.id, name: 'Widget', salesPrice: '20.00', ...inv }).returning())[0].id;
    gadgetId = (await db.insert(items).values({ companyId: company.id, name: 'Gadget', salesPrice: '30.00', ...inv }).returning())[0].id;
    await db.insert(inventoryLayers).values({
      companyId: company.id,
      itemId: gadgetId,
      date: new Date('2025-01-01'),
      quantityRemaining: '0',
      unitCost: '1',
    });
    freightId = (
      await db
        .insert(items)
        .values({ companyId: company.id, name: 'Inbound Freight', type: 'service', expenseAccountId: acct['6300'] })
        .returning()
    )[0].id;

    await updateReceivingSettings(ctx, { enhancedReceiving: true, varianceMode: 'inventory' });
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  let poId: string;
  let receiptId: string;
  let lineId: string;
  let secondBillId: string;

  it('receiving against a PO keeps it open until billed (enhanced receiving)', async () => {
    const po = await createPurchaseOrder(ctx, {
      vendorId,
      date: new Date('2026-05-01'),
      lines: [{ itemId: widgetId, quantity: 10, rate: '5.00' }],
    });
    poId = po.id;
    const receipt = await createItemReceipt(ctx, {
      vendorId,
      date: new Date('2026-05-02'),
      purchaseOrderId: po.id,
      reference: 'PS-1',
      lines: [{ itemId: widgetId, quantity: 10, unitCost: '5.00' }],
    });
    receiptId = receipt.id;
    [lineId] = await receiptLineIds(receipt.id);

    expect((await getPurchaseOrder(ctx, po.id)).status).toBe('partial'); // received, not billed
    const status = await poReceivingStatus(ctx, po.id);
    expect(status.lines[0]).toMatchObject({ ordered: '10.0000', received: '10.0000', billed: '0.0000' });

    const open = await listOpenReceiptLines(ctx, vendorId);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ quantityOpen: '10.0000', receiptUnitCost: '5.0000', poUnitCost: '5.0000', poNumber: po.poNumber });
    expect(await balanceOf(ITEM_RECEIPT_ACCRUAL_CODE)).toBe('50.00');
    await expectBalanced();
  });

  it('previews quantity + price variances and the balanced entry', async () => {
    const preview = await previewReceiptBill(ctx, {
      vendorId,
      date: new Date('2026-05-10'),
      lines: [{ receiptLineId: lineId, quantity: 6, unitCost: '5.50' }],
    });
    expect(preview.billTotal).toBe('33.00');
    expect(preview.accrualRelieved).toBe('30.00');
    expect(preview.lines[0]).toMatchObject({
      quantityRemaining: '4.0000',
      priceVariance: '3.00',
      poPriceVariance: '3.00',
      varianceMode: 'inventory',
      inventoryVariance: '3.00',
      expensedVariance: '0.00',
    });
    const debits = preview.postingLines.reduce((s, l) => s + Number(l.debit ?? 0), 0);
    const credits = preview.postingLines.reduce((s, l) => s + Number(l.credit ?? 0), 0);
    expect(debits.toFixed(2)).toBe(credits.toFixed(2));
    // Nothing saved.
    expect(await balanceOf('2000')).toBe('0.00');
  });

  it('bills part of a receipt at a higher price: variance capitalized into average cost', async () => {
    const bill = await enterBillForReceivedItems(ctx, {
      vendorId,
      billNumber: 'V-100',
      date: new Date('2026-05-10'),
      lines: [{ receiptLineId: lineId, quantity: 6, unitCost: '5.50' }],
    });
    expect(bill.total).toBe('33.00');
    expect(await balanceOf('2000')).toBe('33.00');
    expect(await balanceOf(ITEM_RECEIPT_ACCRUAL_CODE)).toBe('20.00');
    expect(await balanceOf('1300')).toBe('53.00');
    const widget = await itemRow(widgetId);
    expect(widget.averageCost).toBe('5.3000');
    expect((await getItemReceipt(ctx, receiptId)).status).toBe('partial');
    expect((await getPurchaseOrder(ctx, poId)).status).toBe('partial');
    await expect(updateBill(ctx, bill.id, { vendorId, date: new Date('2026-05-10'), lines: [{ accountId: acct['6300'], amount: '1' }] })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expectBalanced();
  });

  it('rejects billing more than received, or another vendor', async () => {
    await expect(
      enterBillForReceivedItems(ctx, { vendorId, date: new Date('2026-05-11'), lines: [{ receiptLineId: lineId, quantity: 5, unitCost: '5' }] }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      enterBillForReceivedItems(ctx, { vendorId: otherVendorId, date: new Date('2026-05-11'), lines: [{ receiptLineId: lineId, quantity: 1, unitCost: '5' }] }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('a cheaper bill after some stock was sold splits the variance between inventory and COGS; PO closes', async () => {
    // Sell 8 of the 10 widgets (COGS at the 5.30 average).
    await createInvoice(ctx, { customerId, date: new Date('2026-05-12'), lines: [{ itemId: widgetId, quantity: 8, rate: '20.00' }] });
    expect((await itemRow(widgetId)).quantityOnHand).toBe('2.0000');
    const cogsBefore = Number(await balanceOf('5000'));
    const invBefore = Number(await balanceOf('1300'));

    const bill = await enterBillForReceivedItems(ctx, {
      vendorId,
      date: new Date('2026-05-15'),
      lines: [{ receiptLineId: lineId, quantity: 4, unitCost: '4.50' }],
    });
    secondBillId = bill.id;
    // 4 @ 4.50 = 18.00 vs accrual 20.00 -> -2.00; 2 of 4 still on hand -> -1.00 inventory, -1.00 COGS.
    expect(bill.total).toBe('18.00');
    expect(bill.preview.lines[0]).toMatchObject({ inventoryVariance: '-1.00', expensedVariance: '-1.00' });
    expect(await balanceOf(ITEM_RECEIPT_ACCRUAL_CODE)).toBe('0.00');
    expect((Number(await balanceOf('1300')) - invBefore).toFixed(2)).toBe('-1.00');
    expect((Number(await balanceOf('5000')) - cogsBefore).toFixed(2)).toBe('-1.00');
    expect((await itemRow(widgetId)).averageCost).toBe('4.8000'); // (2 x 5.30 - 1.00) / 2
    expect((await getItemReceipt(ctx, receiptId)).status).toBe('billed');
    expect((await getPurchaseOrder(ctx, poId)).status).toBe('closed'); // fully received AND billed
    expect(await listOpenReceiptLines(ctx, vendorId)).toHaveLength(0);
    await expectBalanced();
  });

  it('voiding a receipt bill restores the accrual, receipt, PO and item cost', async () => {
    await voidBill(ctx, secondBillId);
    expect(await balanceOf(ITEM_RECEIPT_ACCRUAL_CODE)).toBe('20.00');
    expect((await itemRow(widgetId)).averageCost).toBe('5.3000');
    expect((await getItemReceipt(ctx, receiptId)).status).toBe('partial');
    expect((await getPurchaseOrder(ctx, poId)).status).toBe('partial');
    expect((await poReceivingStatus(ctx, poId)).lines[0].billed).toBe('6.0000');
    await expectBalanced();
  });

  it('closeLine writes off the quantity the vendor will never bill', async () => {
    const bill = await enterBillForReceivedItems(ctx, {
      vendorId,
      date: new Date('2026-05-16'),
      lines: [{ receiptLineId: lineId, quantity: 3, unitCost: '5.00', closeLine: true }],
    });
    // Bill 3 @ 5 = 15; accrual relieved 20 (incl. 1 unit written off) -> variance -5.00,
    // half on hand (2 of 4 touched) -> -2.50 inventory / -2.50 COGS.
    expect(bill.total).toBe('15.00');
    expect(bill.preview.lines[0]).toMatchObject({ quantityWrittenOff: '1.0000', writeOffVariance: '-5.00', inventoryVariance: '-2.50' });
    expect(await balanceOf(ITEM_RECEIPT_ACCRUAL_CODE)).toBe('0.00');
    expect((await getItemReceipt(ctx, receiptId)).status).toBe('billed');
    expect((await getPurchaseOrder(ctx, poId)).status).toBe('closed');
    const lines = (await getBill(ctx, bill.id)).lines;
    expect(lines.every((l) => l.itemId === null)).toBe(true);
    await expectBalanced();
  });

  it('FIFO items: the variance re-costs the receipt layer (split when partly billed); void reverts it', async () => {
    const receipt = await createItemReceipt(ctx, {
      vendorId,
      date: new Date('2026-06-01'),
      lines: [{ itemId: gadgetId, quantity: 4, unitCost: '8.00' }],
    });
    const [gLine] = await receiptLineIds(receipt.id);
    const bill = await enterBillForReceivedItems(ctx, {
      vendorId,
      date: new Date('2026-06-02'),
      lines: [{ receiptLineId: gLine, quantity: 2, unitCost: '9.50' }],
    });
    expect(bill.preview.lines[0].inventoryVariance).toBe('3.00');
    let layers = (await db.select().from(inventoryLayers).where(eq(inventoryLayers.itemId, gadgetId)))
      .filter((l) => Number(l.quantityRemaining) > 0)
      .map((l) => `${Number(l.quantityRemaining)}@${l.unitCost}`)
      .sort();
    expect(layers).toEqual(['2@8.0000', '2@9.5000']);
    await expectBalanced();

    await voidBill(ctx, bill.id);
    layers = (await db.select().from(inventoryLayers).where(eq(inventoryLayers.itemId, gadgetId)))
      .filter((l) => Number(l.quantityRemaining) > 0)
      .map((l) => `${Number(l.quantityRemaining)}@${l.unitCost}`)
      .sort();
    expect(layers).toEqual(['2@8.0000', '2@8.0000']);
    expect((await getItemReceipt(ctx, receipt.id)).status).toBe('open');
    await expectBalanced();
  });

  it('PPV preference posts inventory variances to Purchase Price Variance; non-inventory to its expense account', async () => {
    await updateReceivingSettings(ctx, { varianceMode: 'ppv' });
    const receipt = await createItemReceipt(ctx, {
      vendorId,
      date: new Date('2026-06-10'),
      lines: [
        { itemId: gadgetId, quantity: 5, unitCost: '10.00' },
        { itemId: freightId, quantity: 1, unitCost: '100.00' },
      ],
    });
    const [gLine, fLine] = await receiptLineIds(receipt.id);
    const invBefore = await balanceOf('1300');
    const freightBefore = Number(await balanceOf('6300'));
    // Previews are read-only: the PPV account is not created until the bill is saved.
    const preview = await previewReceiptBill(ctx, {
      vendorId,
      date: new Date('2026-06-11'),
      lines: [{ receiptLineId: gLine, quantity: 5, unitCost: '11.00' }],
    });
    expect(preview.postingLines.some((l) => l.accountName.startsWith('Purchase Price Variance'))).toBe(true);
    const noPpv = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '5150')));
    expect(noPpv).toHaveLength(0);
    const bill = await enterBillForReceivedItems(ctx, {
      vendorId,
      date: new Date('2026-06-11'),
      lines: [
        { receiptLineId: gLine, quantity: 5, unitCost: '11.00' },
        { receiptLineId: fLine, quantity: 1, unitCost: '120.00' },
      ],
    });
    expect(bill.total).toBe('175.00');
    expect(await balanceOf('5150')).toBe('5.00'); // auto-created PPV account
    expect(await balanceOf('1300')).toBe(invBefore); // item cost untouched
    expect((Number(await balanceOf('6300')) - freightBefore).toFixed(2)).toBe('20.00');
    const [ppv] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '5150')));
    expect(ppv.name).toBe('Purchase Price Variance');
    await expectBalanced();
    await updateReceivingSettings(ctx, { varianceMode: 'inventory' });
  });

  it('legacy receipt -> bill conversion records links so voiding the bill reopens the receipt', async () => {
    const receipt = await createItemReceipt(ctx, {
      vendorId,
      date: new Date('2026-07-01'),
      lines: [{ itemId: widgetId, quantity: 2, unitCost: '6.00' }],
    });
    const accrualBefore = await balanceOf(ITEM_RECEIPT_ACCRUAL_CODE);
    const bill = await convertReceiptToBill(ctx, receipt.id, { billNumber: 'L-1' });
    expect((await getItemReceipt(ctx, receipt.id)).status).toBe('billed');
    await voidBill(ctx, bill.id);
    const after = await getItemReceipt(ctx, receipt.id);
    expect(after.status).toBe('open');
    expect(after.convertedBillId).toBeNull();
    expect(await balanceOf(ITEM_RECEIPT_ACCRUAL_CODE)).toBe(accrualBefore);
    // ...and it can be billed again through enhanced receiving.
    const [l] = await receiptLineIds(receipt.id);
    await enterBillForReceivedItems(ctx, { vendorId, date: new Date('2026-07-02'), lines: [{ receiptLineId: l, quantity: 2, unitCost: '6.00' }] });
    await expectBalanced();
  });

  it('with enhanced receiving off, a fully received PO closes on receipt (legacy behaviour)', async () => {
    await updateReceivingSettings(ctx, { enhancedReceiving: false });
    const po = await createPurchaseOrder(ctx, {
      vendorId,
      date: new Date('2026-08-01'),
      lines: [{ itemId: widgetId, quantity: 3, rate: '5.00' }],
    });
    await createItemReceipt(ctx, {
      vendorId,
      date: new Date('2026-08-02'),
      purchaseOrderId: po.id,
      lines: [{ itemId: widgetId, quantity: 3, unitCost: '5.00' }],
    });
    expect((await getPurchaseOrder(ctx, po.id)).status).toBe('closed');
    // Turning enhanced receiving back on never reopens closed POs.
    await updateReceivingSettings(ctx, { enhancedReceiving: true });
    expect((await getPurchaseOrder(ctx, po.id)).status).toBe('closed');
    await expectBalanced();
  });
});
