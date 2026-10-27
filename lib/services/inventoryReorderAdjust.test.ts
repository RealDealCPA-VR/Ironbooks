/**
 * G3 + P1 inventory fixes:
 *  - The reorder list nets committed (open SO) and on-order (open PO) quantities, suggests up to
 *    the max level (else the reorder point) and drops items already covered by open POs, so
 *    creating POs from it twice never duplicates the order.
 *  - Quantity / value adjustments post to the chosen Adjustment Account, defaulting to
 *    "Inventory Adjustments" — never Owner's Equity (3000) or 5900 Inventory Shrinkage.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  accounts,
  items,
  journalEntryLines,
  purchaseOrders,
  salesOrders,
  salesOrderLines,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { createVendor } from './vendors';
import { createCustomer } from './customers';
import { createClass } from './dimensions';
import { adjustInventory } from './inventory';
import { reorderReport, physicalCount, adjustInventoryValue, batchPhysicalCount } from './inventoryOps';
import { createPurchaseOrdersFromReorder } from './lists/itemTools';
import { ensureDefaultSite } from './inventorySites';
import { setSiteReorderPoint } from './inventorySiteOps';
import { trialBalance } from './reports';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-inv-reorder-adjust-g3p1');
let db: DB;
let userId: string;

async function newCompany(name: string) {
  const [company] = await db.insert(companies).values({ name, ownerId: userId }).returning();
  const ctx: ServiceContext = { db, companyId: company.id, userId };
  const acct: Record<string, string> = {};
  const defs: Array<[string, string, string, string]> = [
    ['1000', 'Checking', 'asset', 'checking'],
    ['1300', 'Inventory Asset', 'asset', 'inventory'],
    ['3000', "Owner's Equity", 'equity', 'owners_equity'],
    ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
    ['6100', 'Spoilage', 'expense', 'operating_expenses'],
  ];
  for (const [code, n, type, subtype] of defs) {
    acct[code] = (await createAccount(ctx, { code, name: n, type: type as never, subtype })).id;
  }
  return { ctx, acct };
}

async function newItem(ctx: ServiceContext, name: string, overrides: Partial<typeof items.$inferInsert> = {}) {
  const [row] = await db
    .insert(items)
    .values({ companyId: ctx.companyId, name, type: 'inventory', quantityOnHand: '0', averageCost: '0', ...overrides })
    .returning();
  return row.id;
}

async function balanceOf(id: string) {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, id));
  return row;
}

async function poCount(ctx: ServiceContext) {
  return (await db.select().from(purchaseOrders).where(eq(purchaseOrders.companyId, ctx.companyId))).length;
}

beforeAll(async () => {
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'owner@g3p1.local', name: 'G3 Owner', passwordHash: 'x' }).returning();
  userId = user.id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('reorder list (G3)', () => {
  it('subtracts open PO quantity and never duplicates POs for the same shortage', async () => {
    const { ctx } = await newCompany('Reorder PO Co');
    const vendor = await createVendor(ctx, { displayName: 'Widget Supply' });
    const itemId = await newItem(ctx, 'Widget', {
      quantityOnHand: '3',
      averageCost: '2',
      purchaseCost: '2',
      reorderPoint: '10',
      preferredVendorId: vendor.id,
    });

    const before = await reorderReport(ctx);
    const row = before.rows.find((r) => r.id === itemId)!;
    expect(row.onPurchaseOrder).toBe('0.0000');
    expect(row.available).toBe('3.0000');
    expect(row.suggestedReorderQty).toBe('7.0000'); // up to the reorder point (no max)

    const first = await createPurchaseOrdersFromReorder(ctx);
    expect(first.purchaseOrders).toHaveLength(1);
    expect(first.purchaseOrders[0].lines[0].quantity).toBe('7.0000');
    expect(await poCount(ctx)).toBe(1);

    // The open PO now covers the shortfall: the item drops off and a second run creates nothing.
    const after = await reorderReport(ctx);
    expect(after.rows.find((r) => r.id === itemId)).toBeUndefined();
    await expect(createPurchaseOrdersFromReorder(ctx)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createPurchaseOrdersFromReorder(ctx, { itemIds: [itemId] })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await poCount(ctx)).toBe(1);

    // A partial PO only reduces the suggestion to the remaining shortage.
    await db.update(items).set({ quantityOnHand: '0' }).where(eq(items.id, itemId));
    const partial = (await reorderReport(ctx)).rows.find((r) => r.id === itemId)!;
    expect(partial.onPurchaseOrder).toBe('7.0000');
    expect(partial.available).toBe('7.0000');
    expect(partial.suggestedReorderQty).toBe('3.0000');
  });

  it('nets quantity committed to open sales orders', async () => {
    const { ctx } = await newCompany('Reorder SO Co');
    const cust = await createCustomer(ctx, { displayName: 'Buyer' });
    const itemId = await newItem(ctx, 'Gadget', { quantityOnHand: '12', reorderPoint: '5' });
    expect((await reorderReport(ctx)).rows.find((r) => r.id === itemId)).toBeUndefined();

    const [so] = await db
      .insert(salesOrders)
      .values({ companyId: ctx.companyId, customerId: cust.id, orderNumber: 1, date: new Date('2026-03-01'), status: 'open' })
      .returning();
    await db.insert(salesOrderLines).values({ salesOrderId: so.id, itemId, quantity: '10', quantityInvoiced: '1' });

    const row = (await reorderReport(ctx)).rows.find((r) => r.id === itemId)!;
    expect(row.committed).toBe('9.0000');
    expect(row.available).toBe('3.0000');
    expect(row.suggestedReorderQty).toBe('2.0000');
  });

  it('suggests reordering up to the max level when one is set', async () => {
    const { ctx } = await newCompany('Reorder Max Co');
    const site = await ensureDefaultSite(ctx);
    const itemId = await newItem(ctx, 'Sprocket', { quantityOnHand: '4', reorderPoint: '5' });
    await setSiteReorderPoint(ctx, { itemId, siteId: site.id, reorderPoint: '5', maxQuantity: '20' });

    const row = (await reorderReport(ctx)).rows.find((r) => r.id === itemId)!;
    expect(row.maxQuantity).toBe('20.0000');
    expect(row.suggestedReorderQty).toBe('16.0000');
  });
});

describe('inventory adjustment account (P1)', () => {
  it('quantity adjustment defaults to Inventory Adjustments, never 3000', async () => {
    const { ctx, acct } = await newCompany('Adjust Default Co');
    const itemId = await newItem(ctx, 'Bolt');
    const res = await adjustInventory(ctx, { itemId, quantityChange: 5, unitCost: 3, date: new Date('2026-02-01') });
    const lines = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, res.entry!.id));
    const offset = lines.find((l) => l.accountId !== acct['1300'])!;
    expect(offset.accountId).not.toBe(acct['3000']);
    expect((await balanceOf(offset.accountId)).name).toBe('Inventory Adjustments');
    expect((await balanceOf(acct['3000'])).balance).toBe('0.00');
  });

  it('physical count and value adjustment default to Inventory Adjustments (not 5900 Shrinkage)', async () => {
    const { ctx, acct } = await newCompany('Count Default Co');
    const itemId = await newItem(ctx, 'Nut');
    await adjustInventory(ctx, { itemId, quantityChange: 10, unitCost: 2, date: new Date('2026-02-01') });

    const count = await physicalCount(ctx, { itemId, countedQty: 8, date: new Date('2026-02-02') });
    const adj = await balanceOf(count.adjustmentAccountId!);
    expect(adj.name).toBe('Inventory Adjustments');

    const value = await adjustInventoryValue(ctx, { itemId, newTotalValue: '12', date: new Date('2026-02-03') });
    expect(value.adjustmentAccountId).toBe(count.adjustmentAccountId);

    const shrink = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '5900')));
    expect(shrink).toHaveLength(0);
    expect((await balanceOf(acct['3000'])).balance).toBe('0.00');
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('posts to the chosen account with Class and Customer on the adjustment line', async () => {
    const { ctx, acct } = await newCompany('Adjust Chosen Co');
    const cls = await createClass(ctx, { name: 'Warehouse' });
    const cust = await createCustomer(ctx, { displayName: 'Job Customer' });
    const itemId = await newItem(ctx, 'Washer');
    await adjustInventory(ctx, { itemId, quantityChange: 10, unitCost: 1, date: new Date('2026-02-01'), adjustmentAccountId: acct['6100'] });

    const count = await physicalCount(ctx, {
      itemId,
      countedQty: 7,
      date: new Date('2026-02-02'),
      adjustmentAccountId: acct['6100'],
      classId: cls.id,
      customerId: cust.id,
    });
    expect(count.adjustmentAccountId).toBe(acct['6100']);
    const lines = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, count.journalEntryId!));
    const adjLine = lines.find((l) => l.accountId === acct['6100'])!;
    expect(adjLine.debit).toBe('3.00');
    expect(adjLine.classId).toBe(cls.id);
    expect(adjLine.entityId).toBe(cust.id);

    const value = await adjustInventoryValue(ctx, { itemId, newUnitCost: '2', date: new Date('2026-02-03'), adjustmentAccountId: acct['6100'] });
    expect(value.adjustmentAccountId).toBe(acct['6100']);
    // Spoilage (expense): receipt Cr 10, shrinkage Dr 3, write-up Cr 7 = -14
    expect((await balanceOf(acct['6100'])).balance).toBe('-14.00');

    // An inventory asset account is not a valid adjustment account; a batch fails up front.
    await expect(
      physicalCount(ctx, { itemId, countedQty: 6, date: new Date('2026-02-04'), adjustmentAccountId: acct['1300'] }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      batchPhysicalCount(ctx, { date: new Date('2026-02-04'), counts: [{ itemId, countedQty: 6 }], adjustmentAccountId: acct['1300'] }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
