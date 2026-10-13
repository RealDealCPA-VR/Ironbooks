/**
 * Inventory service integration test.
 *
 * Scenario:
 *   1. Receive 10 units @ $5.00  → qty=10, avgCost=5.00, GL: Dr Inventory $50, Cr Equity $50
 *   2. Sell 4 units (recordCOGS) → qty=6,  COGS posted $20,  GL: Dr COGS $20, Cr Inventory $20
 *   3. Assert trial balance is balanced throughout.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, accounts, items } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { adjustInventory, recordCOGS, inventoryValuation, lowStock } from './inventory';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-inventory');
let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};
let itemId: string;

describe('Inventory service (end-to-end)', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'owner@inv-test.local', name: 'Inv Owner', passwordHash: 'x' })
      .returning();

    const [company] = await db
      .insert(companies)
      .values({ name: 'Inv Test Co', ownerId: user.id })
      .returning();

    ctx = { db, companyId: company.id, userId: user.id };

    // Seed the accounts this service needs
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking',         'asset',   'checking'],
      ['1300', 'Inventory Asset',  'asset',   'inventory'],
      ['3000', "Owner's Equity",   'equity',  'owners_equity'],
      ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
    ];

    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }

    // Seed one inventory item (no assetAccountId — will fall back to code 1300)
    const [item] = await db
      .insert(items)
      .values({
        companyId: company.id,
        name: 'Widget A',
        sku: 'WGT-A',
        type: 'inventory',
        quantityOnHand: '0',
        averageCost: '0',
        reorderPoint: '5',   // low-stock threshold: reorder when qty <= 5
      })
      .returning();

    itemId = item.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------

  it('rejects receipt with missing unitCost', async () => {
    await expect(
      adjustInventory(ctx, {
        itemId,
        quantityChange: '10',
        date: new Date('2025-01-01'),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('receives 10 units @ $5.00 — qty and averageCost updated, GL balanced', async () => {
    const result = await adjustInventory(ctx, {
      itemId,
      quantityChange: '10',
      unitCost: '5.00',
      date: new Date('2025-01-01'),
      memo: 'Initial stock receipt',
    });

    // Check returned item fields
    expect(result.item.quantityOnHand).toBe('10.0000');
    expect(result.item.averageCost).toBe('5.0000');
    expect(result.glAmount).toBe('50.00');

    // Verify DB state
    const [row] = await db.select().from(items).where(eq(items.id, itemId));
    expect(row.quantityOnHand).toBe('10.0000');
    expect(row.averageCost).toBe('5.0000');

    // Check GL: Inventory Asset debit = 50.00, Equity credit = 50.00
    const [invAcct] = await db.select().from(accounts).where(eq(accounts.id, acct['1300']));
    expect(invAcct.balance).toBe('50.00');

    // p1 purchases: the offset is the Adjustment Account (default "Inventory Adjustments",
    // created on first use) — never Owner's Equity.
    const [eqAcct] = await db.select().from(accounts).where(eq(accounts.id, acct['3000']));
    expect(eqAcct.balance).toBe('0.00');
    const adjAcct = (await db.select().from(accounts)).find((a) => a.companyId === ctx.companyId && a.name === 'Inventory Adjustments');
    expect(adjAcct?.type).toBe('expense');
    expect(Math.abs(Number(adjAcct?.balance))).toBe(50);

    // Trial balance must be balanced
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('receives 5 more units @ $7.00 — weighted average cost updated correctly', async () => {
    // Old: 10 @ $5 = $50. New: 5 @ $7 = $35. Total: 15 units, $85 → avg = $85/15 ≈ $5.6667
    const result = await adjustInventory(ctx, {
      itemId,
      quantityChange: '5',
      unitCost: '7.00',
      date: new Date('2025-01-05'),
      memo: 'Second receipt',
    });

    expect(result.item.quantityOnHand).toBe('15.0000');
    // Weighted avg: (10*5 + 5*7) / 15 = 85/15 = 5.6666...
    const avgNum = parseFloat(result.item.averageCost);
    expect(avgNum).toBeCloseTo(5.6667, 3);

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('recordCOGS for 4 units — qty decrements, COGS posted, GL balanced', async () => {
    // After two receipts: 15 units @ ~5.6667 avg
    const [before] = await db.select().from(items).where(eq(items.id, itemId));
    const avgBefore = before.averageCost!;

    const result = await recordCOGS(ctx, {
      itemId,
      quantity: '4',
      date: new Date('2025-01-10'),
      memo: 'Sale of 4 units',
    });

    expect(result.item.quantityOnHand).toBe('11.0000');

    // COGS amount = 4 * avgCost (rounded to 2dp)
    const expectedCOGS = parseFloat(avgBefore) * 4;
    expect(parseFloat(result.cogsAmount)).toBeCloseTo(expectedCOGS, 1);

    // Check COGS account balance increased
    const [cogsAcct] = await db.select().from(accounts).where(eq(accounts.id, acct['5000']));
    expect(parseFloat(cogsAcct.balance)).toBeCloseTo(expectedCOGS, 1);

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('inventoryValuation returns correct totals', async () => {
    const valuation = await inventoryValuation(ctx);

    expect(valuation.items).toHaveLength(1);
    const row = valuation.items[0];
    expect(row.quantityOnHand).toBe('11.0000');

    // grandTotal = qty * avgCost
    const expectedTotal = parseFloat(row.quantityOnHand) * parseFloat(row.averageCost);
    expect(parseFloat(row.totalValue)).toBeCloseTo(expectedTotal, 1);
    expect(parseFloat(valuation.grandTotal)).toBeCloseTo(expectedTotal, 1);
  });

  it('lowStock returns item once qty <= reorderPoint', async () => {
    // Currently 11 units, reorderPoint = 5. Not low stock yet.
    let low = await lowStock(ctx);
    expect(low.length).toBe(0);

    // Reduce to exactly 5 units
    await recordCOGS(ctx, {
      itemId,
      quantity: '6',
      date: new Date('2025-01-15'),
      memo: 'Sale of 6 units',
    });

    low = await lowStock(ctx);
    expect(low.length).toBe(1);
    expect(low[0].id).toBe(itemId);

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('rejects removal beyond available quantity', async () => {
    await expect(
      adjustInventory(ctx, {
        itemId,
        quantityChange: '-999',
        date: new Date('2025-01-20'),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects recordCOGS beyond available quantity', async () => {
    await expect(
      recordCOGS(ctx, {
        itemId,
        quantity: '999',
        date: new Date('2025-01-20'),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
