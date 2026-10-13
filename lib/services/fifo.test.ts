/**
 * FIFO inventory service test.
 *
 * Scenario:
 *   1. Receive 10 units @ $5.00  → layer 1: 10 @ 5
 *   2. Receive 10 units @ $7.00  → layer 2: 10 @ 7
 *   3. Consume 12 units (FIFO)   → takes 10 @ 5 + 2 @ 7 = $50 + $14 = $64 COGS
 *   4. Remaining stock: 8 units in layer 2 @ $7 = $56
 *   5. Trial balance must be balanced after every mutation.
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
import { receiveStock, consumeStock, fifoValuation } from './fifo';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-fifo-a1b2c3');
let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};
let itemId: string;

describe('FIFO inventory service (end-to-end)', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'owner@fifo-test.local', name: 'FIFO Owner', passwordHash: 'x' })
      .returning();

    const [company] = await db
      .insert(companies)
      .values({ name: 'FIFO Test Co', ownerId: user.id })
      .returning();

    ctx = { db, companyId: company.id, userId: user.id };

    // Seed the accounts this service needs
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking',           'asset',   'checking'],
      ['1300', 'Inventory Asset',    'asset',   'inventory'],
      ['3000', "Owner's Equity",     'equity',  'owners_equity'],
      ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
    ];

    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }

    // Seed one inventory item
    const [item] = await db
      .insert(items)
      .values({
        companyId: company.id,
        name: 'Widget FIFO',
        sku: 'WGT-FIFO',
        type: 'inventory',
        quantityOnHand: '0',
        averageCost: '0',
      })
      .returning();

    itemId = item.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Validation guards
  // -------------------------------------------------------------------------

  it('rejects receiveStock with non-positive quantity', async () => {
    await expect(
      receiveStock(ctx, { itemId, quantity: 0, unitCost: '5.00', date: new Date('2025-01-01') }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects consumeStock with non-positive quantity', async () => {
    await expect(
      consumeStock(ctx, { itemId, quantity: 0, date: new Date('2025-01-01') }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects consumeStock when there is no stock at all', async () => {
    await expect(
      consumeStock(ctx, { itemId, quantity: 1, date: new Date('2025-01-01') }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  // -------------------------------------------------------------------------
  // Core FIFO scenario
  // -------------------------------------------------------------------------

  it('receives 10 units @ $5.00 — layer created, GL balanced', async () => {
    const result = await receiveStock(ctx, {
      itemId,
      quantity: '10',
      unitCost: '5.00',
      date: new Date('2025-01-01'),
      memo: 'First receipt',
    });

    expect(result.quantity).toBe('10.0000');
    expect(result.unitCost).toBe('5.0000');
    expect(result.totalCost).toBe('50.00');

    // Inventory account should be debited $50
    const [invAcct] = await db.select().from(accounts).where(eq(accounts.id, acct['1300']));
    expect(invAcct.balance).toBe('50.00');

    // p1 purchases: the offset is the Adjustment Account (default "Inventory Adjustments",
    // created on first use) — never Owner's Equity.
    const [eqAcct] = await db.select().from(accounts).where(eq(accounts.id, acct['3000']));
    expect(eqAcct.balance).toBe('0.00');
    const adjAcct = (await db.select().from(accounts)).find((a) => a.companyId === ctx.companyId && a.name === 'Inventory Adjustments');
    expect(adjAcct?.type).toBe('expense');
    expect(Math.abs(Number(adjAcct?.balance))).toBe(50);

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('receives 10 units @ $7.00 — second layer created, GL balanced', async () => {
    const result = await receiveStock(ctx, {
      itemId,
      quantity: '10',
      unitCost: '7.00',
      date: new Date('2025-01-05'),
      memo: 'Second receipt',
    });

    expect(result.quantity).toBe('10.0000');
    expect(result.unitCost).toBe('7.0000');
    expect(result.totalCost).toBe('70.00');

    // Inventory should now be $50 + $70 = $120
    const [invAcct] = await db.select().from(accounts).where(eq(accounts.id, acct['1300']));
    expect(invAcct.balance).toBe('120.00');

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('consumes 12 units FIFO — COGS = 10*5 + 2*7 = $64, remaining 8@$7', async () => {
    const result = await consumeStock(ctx, {
      itemId,
      quantity: '12',
      date: new Date('2025-01-10'),
      memo: 'Sale of 12 units',
    });

    // Total COGS must be exactly $64
    expect(result.totalCOGS).toBe('64.00');
    expect(result.quantityConsumed).toBe('12.0000');

    // Should have consumed from exactly 2 layers
    expect(result.layers).toHaveLength(2);

    // Layer 1: 10 units @ $5 = $50
    const layer1 = result.layers[0];
    expect(layer1.quantityTaken).toBe('10.0000');
    expect(layer1.unitCost).toBe('5.0000');
    expect(layer1.layerCost).toBe('50.00');

    // Layer 2: 2 units @ $7 = $14
    const layer2 = result.layers[1];
    expect(layer2.quantityTaken).toBe('2.0000');
    expect(layer2.unitCost).toBe('7.0000');
    expect(layer2.layerCost).toBe('14.00');

    // COGS account: $64 debit
    const [cogsAcct] = await db.select().from(accounts).where(eq(accounts.id, acct['5000']));
    expect(cogsAcct.balance).toBe('64.00');

    // Inventory account: $120 - $64 = $56
    const [invAcct] = await db.select().from(accounts).where(eq(accounts.id, acct['1300']));
    expect(invAcct.balance).toBe('56.00');

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('fifoValuation shows 8 units @ $7 remaining = $56 total', async () => {
    const valuation = await fifoValuation(ctx);

    expect(valuation.items).toHaveLength(1);
    const row = valuation.items[0];
    expect(row.itemId).toBe(itemId);
    expect(row.totalQuantity).toBe('8.0000');
    expect(row.totalValue).toBe('56.00');
    expect(valuation.grandTotal).toBe('56.00');

    // There should be exactly one layer remaining (the second one with 8 units left)
    expect(row.layers).toHaveLength(1);
    expect(row.layers[0].quantityRemaining).toBe('8.0000');
    expect(row.layers[0].unitCost).toBe('7.0000');
    expect(row.layers[0].layerValue).toBe('56.00');
  });

  it('rejects consumeStock beyond remaining available stock', async () => {
    await expect(
      consumeStock(ctx, { itemId, quantity: '999', date: new Date('2025-01-15') }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('trial balance remains balanced after all operations', async () => {
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });
});
