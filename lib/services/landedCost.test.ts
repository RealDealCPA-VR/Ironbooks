/**
 * Landed cost — allocate a bill's freight/duty charge onto item receipts by quantity, value or
 * weight. Verifies the cost subledger (average cost / FIFO layers), the GL (balanced entries via
 * posting.ts, inventory asset == valuation), the sold-units COGS split, and the void / edit
 * guards on the bill and the receipts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, customers, vendors, items, accounts, inventoryLayers } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { createBill, getBill, voidBill, updateBill } from './bills';
import { createItemReceipt, voidItemReceipt } from './itemReceipts';
import { createInvoice } from './invoices';
import { receiveStock } from './fifo';
import { inventoryValuation } from './inventory';
import {
  allocateLandedCost,
  listLandedCostSources,
  previewLandedCost,
  voidLandedCostAllocation,
  listLandedCostAllocations,
} from './landedCost';
import { verifySiteInvariants, quantityOnHandBySite } from './inventorySiteReports';
import { createCompanyBackup, restoreCompanyBackup } from './backup';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-landed-cost');

let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
let customerId: string;
let vendorId: string;
let widget: string; // average cost
let gadget: string; // FIFO
let receiptId: string;
let billId: string;
let freightLineId: string;

async function balance(code: string): Promise<string> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, acct[code]));
  return row.balance;
}

async function item(id: string) {
  const [row] = await db.select().from(items).where(eq(items.id, id));
  return row;
}

async function assertBooksTie() {
  expect((await trialBalance(ctx)).balanced).toBe(true);
  const val = await inventoryValuation(ctx);
  expect(await balance('1300')).toBe(val.grandTotal);
  const inv = await verifySiteInvariants(ctx);
  expect(inv.checks.filter((c) => !c.ok)).toEqual([]);
}

describe('Landed cost', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'lc@test.local', name: 'LC', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Landed Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    const defs: Array<[string, string, string, string]> = [
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['1300', 'Inventory Asset', 'asset', 'inventory'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['2200', 'Sales Tax Payable', 'liability', 'long_term_liability'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
      ['6100', 'Freight In', 'expense', 'operating_expenses'],
      ['6200', 'Customs Duty', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    }
    customerId = (await db.insert(customers).values({ companyId: company.id, displayName: 'Buyer' }).returning())[0].id;
    vendorId = (await db.insert(vendors).values({ companyId: company.id, displayName: 'Shipper' }).returning())[0].id;
    const seed = async (name: string) =>
      (
        await db
          .insert(items)
          .values({ companyId: company.id, name, type: 'inventory', quantityOnHand: '0', averageCost: '0' } as never)
          .returning()
      )[0].id;
    widget = await seed('Widget');
    gadget = await seed('Gadget');

    // Gadget becomes FIFO-tracked with an older 1 @ $5 layer.
    await receiveStock(ctx, { itemId: gadget, quantity: 1, unitCost: 5, date: new Date('2026-05-01') });

    const receipt = await createItemReceipt(ctx, {
      vendorId,
      date: new Date('2026-05-02'),
      reference: 'PS-1',
      lines: [
        { itemId: widget, quantity: 10, unitCost: 10 },
        { itemId: gadget, quantity: 20, unitCost: 5 },
      ],
    });
    receiptId = receipt.id;

    const bill = await createBill(ctx, {
      vendorId,
      billNumber: 'FRT-1',
      date: new Date('2026-05-03'),
      lines: [
        { accountId: acct['6100'], description: 'Freight', amount: 60 },
        { accountId: acct['6200'], description: 'Duty', amount: 30 },
      ],
    });
    billId = bill.id;
    const full = await getBill(ctx, bill.id);
    freightLineId = full.lines[0].id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('lists bill charge lines as landed-cost sources', async () => {
    const sources = await listLandedCostSources(ctx, { billId });
    expect(sources.map((s) => [s.description, s.remaining])).toEqual([
      ['Freight', '60.00'],
      ['Duty', '30.00'],
    ]);
  });

  it('allocates by quantity into average cost and the receipt FIFO layer', async () => {
    const preview = await previewLandedCost(ctx, { billId, billLineId: freightLineId, method: 'quantity', itemReceiptIds: [receiptId] });
    expect(preview.lines.map((l) => [l.amount, l.inventoryAmount, l.cogsAmount])).toEqual([
      ['20.00', '20.00', '0.00'],
      ['40.00', '40.00', '0.00'],
    ]);

    const freightBefore = await balance('6100');
    const alloc = await allocateLandedCost(ctx, { billId, billLineId: freightLineId, method: 'quantity', itemReceiptIds: [receiptId] });
    expect(alloc.lines).toHaveLength(2);
    expect((await item(widget)).averageCost).toBe('12.0000');
    const layers = await db
      .select()
      .from(inventoryLayers)
      .where(and(eq(inventoryLayers.itemId, gadget), eq(inventoryLayers.sourceRef, `item_receipt:${receiptId}`)));
    expect(layers[0].unitCost).toBe('7.0000');
    expect(Number(await balance('6100'))).toBe(Number(freightBefore) - 60);
    await assertBooksTie();

    // Fully allocated: no more to spread.
    await expect(
      allocateLandedCost(ctx, { billId, billLineId: freightLineId, method: 'quantity', itemReceiptIds: [receiptId] }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    // The bill and the receipt are locked while the allocation is active.
    await expect(voidBill(ctx, billId)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      updateBill(ctx, billId, { vendorId, date: new Date('2026-05-03'), lines: [{ accountId: acct['6100'], amount: 61 }] }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(voidItemReceipt(ctx, receiptId)).rejects.toMatchObject({ code: 'CONFLICT' });

    // Void restores the costs exactly while stock is untouched.
    await voidLandedCostAllocation(ctx, alloc.id);
    expect((await item(widget)).averageCost).toBe('10.0000');
    const [layer] = await db.select().from(inventoryLayers).where(eq(inventoryLayers.id, layers[0].id));
    expect(layer.unitCost).toBe('5.0000');
    expect(await balance('6100')).toBe(freightBefore);
    await assertBooksTie();
  });

  it('splits value-based allocations between inventory and COGS when units were already sold', async () => {
    // Sell 5 Gadgets: FIFO takes the old 1 @ 5 then 4 from the receipt layer (16 of 20 left).
    await createInvoice(ctx, { customerId, date: new Date('2026-05-04'), lines: [{ itemId: gadget, quantity: 5, rate: 9 }] });
    const cogsBefore = Number(await balance('5000'));

    const alloc = await allocateLandedCost(ctx, {
      billId,
      billLineId: freightLineId,
      method: 'value',
      amount: '60.00',
      itemReceiptIds: [receiptId],
      memo: 'Ocean freight',
    });
    const g = alloc.lines.find((l) => l.itemId === gadget)!;
    expect([g.amount, g.inventoryAmount, g.cogsAmount]).toEqual(['30.00', '24.00', '6.00']);
    const w = alloc.lines.find((l) => l.itemId === widget)!;
    expect([w.amount, w.inventoryAmount, w.cogsAmount]).toEqual(['30.00', '30.00', '0.00']);
    expect((await item(widget)).averageCost).toBe('13.0000');
    expect(Number(await balance('5000'))).toBeCloseTo(cogsBefore + 6, 2);
    await assertBooksTie();

    // Once more of the revalued stock is sold, an exact void is impossible.
    await createInvoice(ctx, { customerId, date: new Date('2026-05-05'), lines: [{ itemId: gadget, quantity: 2, rate: 9 }] });
    await expect(voidLandedCostAllocation(ctx, alloc.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await assertBooksTie();

    const list = await listLandedCostAllocations(ctx);
    expect(list[0].chargeAccountName).toBe('Freight In');
  });

  it('allocates by weight and requires item weights', async () => {
    const dutyLine = (await getBill(ctx, billId)).lines[1].id;
    await expect(
      allocateLandedCost(ctx, { billId, billLineId: dutyLine, method: 'weight', itemReceiptIds: [receiptId] }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await db.update(items).set({ weight: '2' }).where(eq(items.id, widget));
    await db.update(items).set({ weight: '0.5' }).where(eq(items.id, gadget));
    // Weights: widget 10*2 = 20, gadget 20*0.5 = 10 → 20 / 10 of $30.
    const preview = await previewLandedCost(ctx, { billId, billLineId: dutyLine, method: 'weight', itemReceiptIds: [receiptId] });
    expect(preview.lines.map((l) => l.amount)).toEqual(['20.00', '10.00']);
    await allocateLandedCost(ctx, { billId, billLineId: dutyLine, method: 'weight', itemReceiptIds: [receiptId] });
    await assertBooksTie();
  });

  it('rejects inventory item lines and non-expense lines as charges', async () => {
    const stockBill = await createBill(ctx, { vendorId, date: new Date('2026-05-06'), lines: [{ itemId: widget, quantity: 1, unitCost: 10 }] });
    const line = (await getBill(ctx, stockBill.id)).lines[0].id;
    await expect(
      allocateLandedCost(ctx, { billId: stockBill.id, billLineId: line, method: 'quantity', itemReceiptIds: [receiptId] }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await assertBooksTie();
  });

  it('company backup/restore carries receipts, landed cost and site data intact', async () => {
    const { buffer } = await createCompanyBackup(db, ctx.companyId);
    const restored = await restoreCompanyBackup(db, buffer, { ownerId: ctx.userId! });
    expect(restored.tableCounts.landedCostAllocations).toBeGreaterThan(0);
    expect(restored.tableCounts.itemReceipts).toBe(1);
    const rctx: ServiceContext = { db, companyId: restored.companyId, userId: ctx.userId };
    const a = await quantityOnHandBySite(ctx);
    const b = await quantityOnHandBySite(rctx);
    expect(b.rows.map((r) => [r.name, r.totalQuantity, r.totalValue])).toEqual(
      a.rows.map((r) => [r.name, r.totalQuantity, r.totalValue]),
    );
    const inv = await verifySiteInvariants(rctx);
    expect(inv.checks.filter((c) => !c.ok)).toEqual([]);
  });
});
