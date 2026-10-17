/**
 * Inventory completion suite — integration tests for:
 *   - adjustInventoryValue (average-cost + FIFO layer revaluation)
 *   - physicalWorksheet / batchPhysicalCount (FIFO items skipped with a note)
 *   - committedQuantity / stockStatus (open SO commitment, open PO on-order)
 *   - pending builds (create / shortage block / finalize / cancel)
 *   - inventoryValuationAsOf + inventoryValuationDetail (GL reconstruction)
 *
 * Scenario timeline (all on the average item AVG unless noted):
 *   2025-01-05  FIFO: receive 10 @ $2          (+$20 GL)
 *   2025-01-06  FIFO: receive 10 @ $4          (+$40 GL)
 *   2025-01-08  CMP:  receive  5 @ $2          (+$10 GL)
 *   2025-01-10  AVG:  receive 10 @ $5          (+$50 GL)
 *   2025-02-01  AVG:  value adjust to $40      (-$10 GL, avgCost 4)
 *   2025-02-02  AVG:  value adjust unit $6     (+$20 GL, avgCost 6)
 *   2025-02-03  FIFO: value adjust unit $5     (+$40 GL, layers -> $100)
 *   2025-03-01  batch count: AVG -> 8          (-$12 GL at avg 6); FIFO skipped
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  accounts,
  items,
  customers,
  vendors,
  salesOrders,
  salesOrderLines,
  purchaseOrders,
  purchaseOrderLines,
  inventoryLayers,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import {
  adjustInventory,
  committedQuantity,
  stockStatus,
  inventoryValuationAsOf,
  inventoryValuationDetail,
} from './inventory';
import { receiveStock, fifoValuation } from './fifo';
import {
  adjustInventoryValue,
  physicalWorksheet,
  batchPhysicalCount,
} from './inventoryOps';
import {
  setBom,
  createPendingBuild,
  listPendingBuilds,
  finalizePendingBuild,
  cancelPendingBuild,
} from './assemblies';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-inventory-suite');
let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};
let avgId: string; // average-cost inventory item
let fifoId: string; // FIFO-tracked inventory item
let cmpId: string; // assembly component (average cost)
let asmId: string; // assembly item

async function seedItem(name: string, sku: string): Promise<string> {
  const [row] = await db
    .insert(items)
    .values({ companyId: ctx.companyId, name, sku, type: 'inventory' })
    .returning();
  return row.id;
}

describe('inventory suite (value adjust, counts, commitment, pending builds, valuation)', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'owner@inv-suite-test.local', name: 'Suite Owner', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'Inventory Suite Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    const defs: Array<[string, string, string, string]> = [
      ['1300', 'Inventory Asset', 'asset', 'inventory'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }

    avgId = await seedItem('Avg Widget', 'AVG-1');
    fifoId = await seedItem('Fifo Widget', 'FIFO-1');
    cmpId = await seedItem('Component Bolt', 'CMP-1');
    asmId = await seedItem('Widget Kit', 'ASM-1');

    // Opening stock with GL postings (sourceRef item:<id>):
    await receiveStock(ctx, { itemId: fifoId, quantity: 10, unitCost: 2, date: new Date('2025-01-05') });
    await receiveStock(ctx, { itemId: fifoId, quantity: 10, unitCost: 4, date: new Date('2025-01-06') });
    await adjustInventory(ctx, { itemId: cmpId, quantityChange: 5, unitCost: 2, date: new Date('2025-01-08') });
    await adjustInventory(ctx, { itemId: avgId, quantityChange: 10, unitCost: 5, date: new Date('2025-01-10') });
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── adjustInventoryValue ───────────────────────────────────────────────────

  it('value adjustment (avg, newTotalValue): write-down $50 -> $40, avgCost 4, GL balanced', async () => {
    // The default Adjustment Account also took the stock-receipt offsets; measure the change.
    const adjBefore = (await db.select().from(accounts)).find(
      (a) => a.companyId === ctx.companyId && a.name === 'Inventory Adjustments',
    );
    const result = await adjustInventoryValue(ctx, {
      itemId: avgId,
      newTotalValue: '40',
      date: new Date('2025-02-01'),
      reason: 'Market value drop',
    });

    expect(result.costingMethod).toBe('average');
    expect(result.oldValue).toBe('50.00');
    expect(result.newValue).toBe('40.00');
    expect(result.delta).toBe('-10.00');
    expect(result.newUnitCost).toBe('4.0000');
    expect(result.journalEntryId).toBeTruthy();

    const [row] = await db.select().from(items).where(eq(items.id, avgId));
    expect(row.averageCost).toBe('4.0000');
    expect(row.quantityOnHand).toBe('10.0000'); // qty untouched

    // Write-down: default Adjustment Account "Inventory Adjustments" debit balance +10
    const [adj] = await db.select().from(accounts).where(eq(accounts.id, result.adjustmentAccountId));
    expect(adj.name).toBe('Inventory Adjustments');
    expect(Number(adj.balance) - Number(adjBefore?.balance ?? 0)).toBeCloseTo(10, 2);

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('value adjustment (avg, newUnitCost): write-up to $6/unit -> value $60', async () => {
    const result = await adjustInventoryValue(ctx, {
      itemId: avgId,
      newUnitCost: '6',
      date: new Date('2025-02-02'),
    });

    expect(result.oldValue).toBe('40.00');
    expect(result.newValue).toBe('60.00');
    expect(result.delta).toBe('20.00');

    const [row] = await db.select().from(items).where(eq(items.id, avgId));
    expect(row.averageCost).toBe('6.0000');

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('value adjustment rejects both / neither of newTotalValue and newUnitCost', async () => {
    await expect(
      adjustInventoryValue(ctx, {
        itemId: avgId,
        newTotalValue: '10',
        newUnitCost: '1',
        date: new Date('2025-02-02'),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      adjustInventoryValue(ctx, { itemId: avgId, date: new Date('2025-02-02') }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('value adjustment (FIFO): revalues remaining layers to the new unit cost', async () => {
    const result = await adjustInventoryValue(ctx, {
      itemId: fifoId,
      newUnitCost: '5',
      date: new Date('2025-02-03'),
    });

    expect(result.costingMethod).toBe('fifo');
    expect(result.oldValue).toBe('60.00'); // 10*2 + 10*4
    expect(result.newValue).toBe('100.00'); // 20*5
    expect(result.delta).toBe('40.00');

    const layers = await db.select().from(inventoryLayers).where(eq(inventoryLayers.itemId, fifoId));
    expect(layers).toHaveLength(2);
    for (const l of layers) expect(l.unitCost).toBe('5.0000');

    const fv = await fifoValuation(ctx);
    const fifoRow = fv.items.find((i) => i.itemId === fifoId);
    expect(fifoRow?.totalValue).toBe('100.00');

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  // ── physical worksheet + batch count ───────────────────────────────────────

  it('physicalWorksheet lists inventory items and flags FIFO-tracked ones', async () => {
    const { rows } = await physicalWorksheet(ctx);
    const byId = new Map(rows.map((r) => [r.id, r]));

    expect(byId.get(avgId)?.fifoTracked).toBe(false);
    expect(byId.get(avgId)?.quantityOnHand).toBe('10.0000');
    expect(byId.get(fifoId)?.fifoTracked).toBe(true);
    expect(byId.get(fifoId)?.fifoTracked).toBe(true);
    expect(byId.has(asmId)).toBe(true); // inventory-type items only, all included
  });

  it('batchPhysicalCount applies avg counts and skips FIFO items with a clear note', async () => {
    const result = await batchPhysicalCount(ctx, {
      date: new Date('2025-03-01'),
      counts: [
        { itemId: avgId, countedQty: '8' }, // delta -2 @ avg 6 => $12 shrinkage
        { itemId: fifoId, countedQty: '19' }, // FIFO-tracked -> skipped by the guard
      ],
    });

    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].itemId).toBe(avgId);
    expect(result.applied[0].delta).toBe('-2.0000');
    expect(result.applied[0].glAmount).toBe('12.00');

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].itemId).toBe(fifoId);
    expect(result.skipped[0].reason).toMatch(/FIFO/i);

    const [row] = await db.select().from(items).where(eq(items.id, avgId));
    expect(row.quantityOnHand).toBe('8.0000');

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('batchPhysicalCount rejects an empty batch and duplicate items', async () => {
    await expect(
      batchPhysicalCount(ctx, { date: new Date('2025-03-01'), counts: [] }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      batchPhysicalCount(ctx, {
        date: new Date('2025-03-01'),
        counts: [
          { itemId: avgId, countedQty: '8' },
          { itemId: avgId, countedQty: '9' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  // ── SO commitment + stock status ───────────────────────────────────────────

  it('committedQuantity / stockStatus: open SOs commit stock, open POs add on-order', async () => {
    const [customer] = await db
      .insert(customers)
      .values({ companyId: ctx.companyId, displayName: 'Stock Customer' })
      .returning();
    const [vendor] = await db
      .insert(vendors)
      .values({ companyId: ctx.companyId, displayName: 'Stock Vendor' })
      .returning();

    // Open SO: line qty 4, 1 already invoiced -> commits 3
    const [so] = await db
      .insert(salesOrders)
      .values({
        companyId: ctx.companyId,
        customerId: customer.id,
        orderNumber: 1,
        date: new Date('2025-03-05'),
        status: 'open',
      })
      .returning();
    await db.insert(salesOrderLines).values({
      salesOrderId: so.id,
      itemId: avgId,
      quantity: '4.0000',
      quantityInvoiced: '1.0000',
      rate: '10',
      amount: '40.00',
    });

    // Closed SO must NOT commit stock
    const [soClosed] = await db
      .insert(salesOrders)
      .values({
        companyId: ctx.companyId,
        customerId: customer.id,
        orderNumber: 2,
        date: new Date('2025-03-05'),
        status: 'closed',
      })
      .returning();
    await db.insert(salesOrderLines).values({
      salesOrderId: soClosed.id,
      itemId: avgId,
      quantity: '99.0000',
      rate: '10',
      amount: '990.00',
    });

    // Open PO: line qty 5, 2 already billed -> 3 on order
    const [po] = await db
      .insert(purchaseOrders)
      .values({
        companyId: ctx.companyId,
        vendorId: vendor.id,
        poNumber: 1,
        date: new Date('2025-03-05'),
        status: 'open',
      })
      .returning();
    await db.insert(purchaseOrderLines).values({
      purchaseOrderId: po.id,
      itemId: avgId,
      quantity: '5.0000',
      quantityBilled: '2.0000',
      rate: '5',
      amount: '25.00',
    });

    expect(await committedQuantity(ctx, avgId)).toBe('3.0000');

    const status = await stockStatus(ctx);
    const row = status.rows.find((r) => r.id === avgId);
    expect(row).toBeDefined();
    expect(row!.quantityOnHand).toBe('8.0000');
    expect(row!.committed).toBe('3.0000');
    expect(row!.available).toBe('5.0000');
    expect(row!.onPO).toBe('3.0000');

    // FIFO item has no commitments
    const fifoRow = status.rows.find((r) => r.id === fifoId);
    expect(fifoRow!.committed).toBe('0.0000');
    expect(fifoRow!.available).toBe(fifoRow!.quantityOnHand);
  });

  it('stockStatus suggests an order when available + onPO falls to the reorder point', async () => {
    await db.update(items).set({ reorderPoint: '9.0000' }).where(eq(items.id, avgId));
    const status = await stockStatus(ctx);
    const row = status.rows.find((r) => r.id === avgId)!;
    // available 5 + onPO 3 = 8 <= reorder 9 -> suggest 2*9 - 8 = 10
    expect(row.reorderPoint).toBe('9.0000');
    expect(row.suggestedOrder).toBe('10.0000');
    expect(status.attentionCount).toBeGreaterThanOrEqual(1);
  });

  // ── pending builds ─────────────────────────────────────────────────────────

  it('createPendingBuild validates the BOM and reports component shortages', async () => {
    // No BOM yet -> rejected
    await expect(
      createPendingBuild(ctx, { assemblyItemId: asmId, quantity: 1, date: new Date('2025-04-01') }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    await setBom(ctx, asmId, [{ componentItemId: cmpId, quantity: '2' }]);

    // CMP on hand = 5; building 10 needs 20 -> shortage 15
    const build = await createPendingBuild(ctx, {
      assemblyItemId: asmId,
      quantity: 10,
      date: new Date('2025-04-01'),
      memo: 'Big order',
    });
    expect(build.status).toBe('pending');
    expect(build.canBuild).toBe(false);
    expect(build.shortageCount).toBe(1);
    expect(build.components[0].required).toBe('20.0000');
    expect(build.components[0].onHand).toBe('5.0000');
    expect(build.components[0].shortage).toBe('15.0000');
  });

  it('finalizePendingBuild is blocked with shortage detail while components are short', async () => {
    const builds = await listPendingBuilds(ctx, 'pending');
    expect(builds).toHaveLength(1);

    await expect(finalizePendingBuild(ctx, builds[0].id)).rejects.toMatchObject({
      code: 'VALIDATION',
      details: { shortages: [expect.objectContaining({ componentItemId: cmpId })] },
    });

    // Still pending — nothing moved
    const after = await listPendingBuilds(ctx, 'pending');
    expect(after).toHaveLength(1);
    const [cmp] = await db.select().from(items).where(eq(items.id, cmpId));
    expect(cmp.quantityOnHand).toBe('5.0000');
  });

  it('cancelPendingBuild marks the build cancelled', async () => {
    const [pending] = await listPendingBuilds(ctx, 'pending');
    const result = await cancelPendingBuild(ctx, pending.id);
    expect(result.status).toBe('cancelled');
    expect(await listPendingBuilds(ctx, 'pending')).toHaveLength(0);
    // Cancelled rows cannot be finalized or re-cancelled
    await expect(finalizePendingBuild(ctx, pending.id)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(cancelPendingBuild(ctx, pending.id)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('finalizePendingBuild builds the assembly when components suffice', async () => {
    const build = await createPendingBuild(ctx, {
      assemblyItemId: asmId,
      quantity: 2, // needs 4 of CMP; 5 on hand
      date: new Date('2025-04-02'),
    });
    expect(build.canBuild).toBe(true);

    const result = await finalizePendingBuild(ctx, build.id);
    expect(result.status).toBe('built');
    expect(result.build.quantityBuilt).toBe('2.0000');
    expect(result.build.totalCost).toBe('8.00'); // 4 units of CMP @ $2

    const [asm] = await db.select().from(items).where(eq(items.id, asmId));
    expect(asm.quantityOnHand).toBe('2.0000');
    expect(asm.averageCost).toBe('4.0000'); // $8 / 2 units
    const [cmp] = await db.select().from(items).where(eq(items.id, cmpId));
    expect(cmp.quantityOnHand).toBe('1.0000');

    const all = await listPendingBuilds(ctx);
    expect(all.map((b) => b.status).sort()).toEqual(['built', 'cancelled']);

    const tb = await trialBalance(ctx); // build posts no GL; ledger must remain balanced
    expect(tb.balanced).toBe(true);
  });

  // ── as-of valuation + detail ───────────────────────────────────────────────

  it('inventoryValuationAsOf reconstructs values at a past date from the GL', async () => {
    // 2025-01-31: only the opening receipts exist.
    const early = await inventoryValuationAsOf(ctx, new Date('2025-01-31'));
    const byId = new Map(early.items.map((r) => [r.id, r]));

    expect(byId.get(avgId)?.valueAsOf).toBe('50.00');
    expect(byId.get(fifoId)?.valueAsOf).toBe('60.00');
    expect(byId.get(cmpId)?.valueAsOf).toBe('10.00');
    expect(byId.get(asmId)?.valueAsOf).toBe('0.00');
    expect(early.grandTotal).toBe('120.00');
    expect(early.notes.length).toBeGreaterThan(0);

    // FIFO qty approximation: $60 at current effective cost $5 -> 12 units
    // (documented approximation: layer costs changed after the as-of date).
    expect(byId.get(fifoId)?.quantityAsOf).toBe('12.0000');
    expect(byId.get(fifoId)?.costingMethod).toBe('fifo');
  });

  it('inventoryValuationAsOf at a late date ties to the current item value', async () => {
    const late = await inventoryValuationAsOf(ctx, new Date('2025-12-31'));
    const byId = new Map(late.items.map((r) => [r.id, r]));

    // AVG: 50 - 10 + 20 - 12 = 48 == current 8 units @ $6
    expect(byId.get(avgId)?.valueAsOf).toBe('48.00');
    expect(byId.get(avgId)?.quantityAsOf).toBe('8.0000'); // exact: cost unchanged since
    // FIFO: 60 + 40 = 100
    expect(byId.get(fifoId)?.valueAsOf).toBe('100.00');
    // review3: the build posts Dr assembly / Cr component, so the value moved with the units:
    // CMP keeps 1 unit @ $2 and the kit carries the $8 of components it consumed.
    expect(byId.get(cmpId)?.valueAsOf).toBe('2.00');
    expect(byId.get(asmId)?.valueAsOf).toBe('8.00');
  });

  it('inventoryValuationDetail lists movements with a running balance', async () => {
    const detail = await inventoryValuationDetail(ctx, { itemId: avgId });
    expect(detail.items).toHaveLength(1);
    const item = detail.items[0];

    expect(item.openingValue).toBe('0.00');
    expect(item.movements).toHaveLength(4); // receipt, -10, +20, -12
    expect(item.movements[0].valueIn).toBe('50.00');
    expect(item.movements.map((m) => m.runningValue)).toEqual(['50.00', '40.00', '60.00', '48.00']);
    expect(item.closingValue).toBe('48.00');
    // Approx qty for the receipt at current cost $6: 50/6
    expect(item.movements[0].approxQty).toBe('8.3333');
  });

  it('inventoryValuationDetail honors from/to (opening accumulates prior activity)', async () => {
    const detail = await inventoryValuationDetail(ctx, {
      itemId: avgId,
      from: new Date('2025-02-01'),
      to: new Date('2025-02-28'),
    });
    const item = detail.items[0];
    expect(item.openingValue).toBe('50.00'); // the January receipt
    expect(item.movements).toHaveLength(2); // the two February value adjustments
    expect(item.closingValue).toBe('60.00');
  });
});
