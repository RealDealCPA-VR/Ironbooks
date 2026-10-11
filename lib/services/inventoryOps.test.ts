/**
 * inventoryOps service integration test.
 *
 * Scenario:
 *   - Seed: inventory item qty=10, avgCost=5, reorderPoint=8
 *   - physicalCount to 7 → shrinkage delta=-3, GL Dr Shrinkage $15, Cr Inventory $15
 *   - trial balance balanced after adjustment
 *   - reorderReport now includes the item (qty=7 <= reorderPoint=8)
 *   - lowStockCount returns 1
 *   - delta=0 physicalCount returns no journal entry
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, accounts, items } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import { trialBalance } from './reports';
import { reorderReport, physicalCount, lowStockCount } from './inventoryOps';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-inventory-ops');
let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};
let itemId: string;

describe('inventoryOps service (end-to-end)', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'owner@inv-ops-test.local', name: 'InvOps Owner', passwordHash: 'x' })
      .returning();

    const [company] = await db
      .insert(companies)
      .values({ name: 'InvOps Test Co', ownerId: user.id })
      .returning();

    ctx = { db, companyId: company.id, userId: user.id };

    // Seed required accounts
    const defs: Array<[string, string, string, string]> = [
      ['1300', 'Inventory Asset',    'asset',   'inventory'],
      ['3000', "Owner's Equity",     'equity',  'owners_equity'],
      ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
    ];

    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }

    // Seed an open fiscal period so posting is allowed
    // (no closed period rows = all periods open)

    // Seed the inventory item: qty=10, avgCost=5, reorderPoint=8
    // We also manually set the Inventory Asset account balance to $50
    // to reflect an "already received" state without going through adjustInventory
    // (this keeps the test isolated to inventoryOps only).
    const [item] = await db
      .insert(items)
      .values({
        companyId: company.id,
        name: 'Test Widget',
        sku: 'TWG-1',
        type: 'inventory',
        quantityOnHand: '10.0000',
        averageCost: '5.0000',
        reorderPoint: '8.0000',
        // assetAccountId not set — will fall back to code 1300
      })
      .returning();

    itemId = item.id;

    // Seed the Inventory Asset account balance to match the item's opening state
    // so the trial balance will be balanced after we post adjustment entries.
    // We do this by posting a real opening entry (Dr Inventory, Cr Equity) —
    // accounts.balance is ledger-derived and cannot be written directly.
    await postJournalEntry(ctx, {
      date: new Date('2026-01-01'),
      description: 'Opening inventory',
      lines: [
        { accountId: acct['1300'], debit: '50.00' },
        { accountId: acct['3000'], credit: '50.00' },
      ],
    });
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------

  it('reorderReport does NOT include item when qty=10 > reorderPoint=8', async () => {
    const report = await reorderReport(ctx);
    expect(report.count).toBe(0);
    expect(report.rows).toHaveLength(0);
  });

  it('lowStockCount returns 0 before adjustment', async () => {
    const count = await lowStockCount(ctx);
    expect(count).toBe(0);
  });

  it('physicalCount to 7 — shrinkage $15 posted, qty updated to 7, GL balanced', async () => {
    const result = await physicalCount(ctx, {
      itemId,
      countedQty: '7',
      date: new Date('2025-06-01'),
    });

    // Check delta
    expect(result.previousQty).toBe('10.0000');
    expect(result.countedQty).toBe('7.0000');
    expect(result.delta).toBe('-3.0000');

    // GL amount: 3 * $5 = $15
    expect(result.glAmount).toBe('15.00');

    // Journal entry was created
    expect(result.journalEntryId).not.toBeNull();

    // adjustmentAccountId should be the auto-created 5900
    expect(result.adjustmentAccountId).not.toBeNull();

    // Updated qty in DB
    const [row] = await db.select().from(items).where(eq(items.id, itemId));
    expect(row.quantityOnHand).toBe('7.0000');

    // Shrinkage account (5900) should now have debit balance = 15
    const [shrinkAcct] = await db
      .select()
      .from(accounts)
      .where(
        eq(accounts.id, result.adjustmentAccountId!),
      );
    expect(shrinkAcct.code).toBe('5900');
    // Expense account: balance increases on debit
    expect(shrinkAcct.balance).toBe('15.00');

    // Inventory account (1300) should drop by 15
    const [invAcct] = await db.select().from(accounts).where(eq(accounts.id, acct['1300']));
    expect(invAcct.balance).toBe('35.00');

    // Trial balance must be balanced
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('reorderReport includes item after qty drops to 7 (<=8)', async () => {
    const report = await reorderReport(ctx);
    expect(report.count).toBe(1);
    expect(report.rows).toHaveLength(1);

    const row = report.rows[0];
    expect(row.id).toBe(itemId);
    expect(row.quantityOnHand).toBe('7.0000');
    expect(row.reorderPoint).toBe('8.0000');

    // suggestedReorderQty = max(reorderPoint*2 - qty, 1) = 16 - 7 = 9
    expect(parseFloat(row.suggestedReorderQty)).toBeCloseTo(9, 2);
  });

  it('lowStockCount returns 1 after adjustment', async () => {
    const count = await lowStockCount(ctx);
    expect(count).toBe(1);
  });

  it('physicalCount with delta=0 returns no journal entry and qty unchanged', async () => {
    // Current qty is 7 — count to 7 again
    const result = await physicalCount(ctx, {
      itemId,
      countedQty: '7',
      date: new Date('2025-06-02'),
    });

    expect(result.delta).toBe('0.0000');
    expect(result.glAmount).toBe('0.00');
    expect(result.journalEntryId).toBeNull();
    expect(result.updatedQty).toBe('7.0000');

    // Trial balance still balanced
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('physicalCount overage (count > current) — Dr Inventory, Cr Shrinkage', async () => {
    // Count to 9 (overage of 2 at $5 = $10)
    const result = await physicalCount(ctx, {
      itemId,
      countedQty: '9',
      date: new Date('2025-06-03'),
    });

    expect(result.delta).toBe('2.0000');
    expect(result.glAmount).toBe('10.00');
    expect(result.journalEntryId).not.toBeNull();

    // Inventory account should go from 35 back up by 10 = 45
    const [invAcct] = await db.select().from(accounts).where(eq(accounts.id, acct['1300']));
    expect(invAcct.balance).toBe('45.00');

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('physicalCount rejects negative countedQty', async () => {
    await expect(
      physicalCount(ctx, {
        itemId,
        countedQty: '-1',
        date: new Date('2025-06-04'),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('physicalCount rejects unknown itemId', async () => {
    await expect(
      physicalCount(ctx, {
        itemId: '00000000-0000-0000-0000-000000000000',
        countedQty: '5',
        date: new Date('2025-06-04'),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
