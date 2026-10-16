import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, items, journalEntryLines, journalEntries } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { updateItem } from './items';
import { inventoryValuation, adjustInventory } from './inventory';
import { physicalCount } from './inventoryOps';
import { createSite, ensureDefaultSite, quantityAtSite, setDefaultSite } from './inventorySites';
import { adjustQuantityAtSite } from './inventorySiteOps';
import { consumeStock } from './fifo';
import { setBom, buildAssembly } from './assemblies';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-inventory-review');
let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};

async function seedItem(vals: Record<string, unknown>): Promise<string> {
  const [row] = await db
    .insert(items)
    .values({ companyId: ctx.companyId, type: 'inventory', quantityOnHand: '0', averageCost: '0', assetAccountId: acct['1300'], ...vals } as never)
    .returning();
  return row.id;
}

async function glInventory(): Promise<number> {
  const rows = await db
    .select({ d: journalEntryLines.debit, c: journalEntryLines.credit })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.status, 'posted'), eq(journalEntryLines.accountId, acct['1300'])));
  return Math.round(rows.reduce((s, r) => s + Number(r.d ?? 0) - Number(r.c ?? 0), 0) * 100) / 100;
}

describe('review: inventory', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'rev@inv.test', name: 'R', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Rev Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    const defs: Array<[string, string, string, string]> = [
      ['1300', 'Inventory Asset', 'asset', 'inventory'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
    ];
    for (const [code, name, type, subtype] of defs) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    }
  });
  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('A: setDefaultSite keeps quantities when the old default derived qty is 0 but its movements are not', async () => {
    const main = await ensureDefaultSite(ctx);
    const east = await createSite(ctx, { name: 'East' });
    const id = await seedItem({ name: 'SiteWidget' });
    await adjustQuantityAtSite(ctx, { itemId: id, quantityChange: 5, unitCost: 2, date: new Date('2026-01-01') });
    await physicalCount(ctx, { itemId: id, countedQty: 0, date: new Date('2026-01-02') }); // no movement written
    expect((await quantityAtSite(ctx, id, main.id)).toFixed(4)).toBe('0.0000');
    await setDefaultSite(ctx, east.id);
    // Item has 0 on hand, so every site must show 0.
    expect((await quantityAtSite(ctx, id, main.id)).toFixed(4)).toBe('0.0000');
    expect((await quantityAtSite(ctx, id, east.id)).toFixed(4)).toBe('0.0000');
    await setDefaultSite(ctx, main.id);
  });

  it('B: FIFO receive on an average-cost item with stock must not orphan existing units', async () => {
    const id = await seedItem({ name: 'MixWidget' });
    await adjustInventory(ctx, { itemId: id, quantityChange: 10, unitCost: 5, date: new Date('2026-02-01') });
    const before = await glInventory();
    await adjustQuantityAtSite(ctx, { itemId: id, quantityChange: 5, unitCost: 6, date: new Date('2026-02-02'), costing: 'fifo' });
    const val = await inventoryValuation(ctx);
    const row = val.items.find((r) => r.id === id)!;
    expect(row.quantityOnHand).toBe('15.0000');
    expect(row.totalValue).toBe('80.00');
    // QOH is 15, so consuming 12 must work
    await consumeStock(ctx, { itemId: id, quantity: 12, date: new Date('2026-02-03') });
    expect(await glInventory()).toBe(before + 30 - 62);
    expect(before).toBeGreaterThan(0);
  });

  it('C: changing an inventory item with stock to service must not break valuation = GL', async () => {
    const id = await seedItem({ name: 'TypeWidget' });
    await adjustInventory(ctx, { itemId: id, quantityChange: 4, unitCost: 10, date: new Date('2026-03-01') });
    const valBefore = Number((await inventoryValuation(ctx)).grandTotal);
    await expect(updateItem(ctx, id, { type: 'service' })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(Number((await inventoryValuation(ctx)).grandTotal)).toBe(valBefore);
  });

  it('D: building a non-inventory "assembly" must not drop value from the valuation', async () => {
    const comp = await seedItem({ name: 'Comp' });
    await adjustInventory(ctx, { itemId: comp, quantityChange: 10, unitCost: 3, date: new Date('2026-04-01') });
    const [asm] = await db
      .insert(items)
      .values({ companyId: ctx.companyId, name: 'NonInvAsm', type: 'non_inventory', quantityOnHand: '0', averageCost: '0' } as never)
      .returning();
    await setBom(ctx, asm.id, [{ componentItemId: comp, quantity: 2 }]);
    const valBefore = Number((await inventoryValuation(ctx)).grandTotal);
    await expect(buildAssembly(ctx, { assemblyItemId: asm.id, quantity: 2 })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(Number((await inventoryValuation(ctx)).grandTotal)).toBe(valBefore);
  });

  it('E: physical count of a zero-cost item adjusts quantity', async () => {
    const id = await seedItem({ name: 'FreeWidget', quantityOnHand: '3', averageCost: '0' });
    const res = await physicalCount(ctx, { itemId: id, countedQty: 1, date: new Date('2026-05-01') });
    expect(res.updatedQty).toBe('1.0000');
  });
});
