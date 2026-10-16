/**
 * Assemblies / Bill of Materials — integration test.
 *
 * Scenario:
 *   - Assembly: "Bike Kit" (type: bundle)
 *   - Component A: "Frame"  — 10 on hand @ $20.00 avg cost
 *   - Component B: "Wheel"  — 20 on hand @ $15.00 avg cost
 *   - BOM: 1 Frame + 2 Wheels per Bike Kit
 *   - Build 5 Bike Kits:
 *       Component A consumed: 5 * 1 = 5 units  ($100)
 *       Component B consumed: 5 * 2 = 10 units ($150)
 *       Total cost = $250  →  assembly avgCost = $250 / 5 = $50.00
 *   - Unbuild 2 Bike Kits:
 *       Component A restored: 2 units
 *       Component B restored: 4 units
 *       Assembly qty drops from 5 → 3
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, accounts, items } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { setBom, getBom, buildAssembly, unbuildAssembly } from './assemblies';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-assemblies');
let ctx: ServiceContext;
let db: DB;

let assemblyId: string;
let compAId: string; // Frame
let compBId: string; // Wheel

describe('Assemblies service (end-to-end)', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'owner@asm-test.local', name: 'Asm Owner', passwordHash: 'x' })
      .returning();

    const [company] = await db
      .insert(companies)
      .values({ name: 'Asm Test Co', ownerId: user.id })
      .returning();

    ctx = { db, companyId: company.id, userId: user.id };

    // Seed the accounts (needed for trialBalance shape; no GL postings from assemblies)
    const defs: Array<[string, string, string, string]> = [
      ['1300', 'Inventory Asset',    'asset',   'inventory'],
      ['3000', "Owner's Equity",     'equity',  'owners_equity'],
      ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
    ];
    for (const [code, name, type, subtype] of defs) {
      await createAccount(ctx, { code, name, type: type as never, subtype });
    }

    // Seed the assembly item (Bike Kit)
    const [asm] = await db
      .insert(items)
      .values({
        companyId: company.id,
        name: 'Bike Kit',
        sku: 'BIKE-KIT',
        type: 'inventory',
        quantityOnHand: '0',
        averageCost: '0',
      })
      .returning();
    assemblyId = asm.id;

    // Seed component A: Frame (10 on hand @ $20)
    const [cA] = await db
      .insert(items)
      .values({
        companyId: company.id,
        name: 'Frame',
        sku: 'FRAME-01',
        type: 'inventory',
        quantityOnHand: '10.0000',
        averageCost: '20.0000',
      })
      .returning();
    compAId = cA.id;

    // Seed component B: Wheel (20 on hand @ $15)
    const [cB] = await db
      .insert(items)
      .values({
        companyId: company.id,
        name: 'Wheel',
        sku: 'WHEEL-01',
        type: 'inventory',
        quantityOnHand: '20.0000',
        averageCost: '15.0000',
      })
      .returning();
    compBId = cB.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── setBom ────────────────────────────────────────────────────────────────

  it('rejects self-referencing BOM', async () => {
    await expect(
      setBom(ctx, assemblyId, [{ componentItemId: assemblyId, quantity: '1' }]),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects duplicate component items in BOM', async () => {
    await expect(
      setBom(ctx, assemblyId, [
        { componentItemId: compAId, quantity: '1' },
        { componentItemId: compAId, quantity: '2' },
      ]),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects component with quantity <= 0', async () => {
    await expect(
      setBom(ctx, assemblyId, [{ componentItemId: compAId, quantity: '0' }]),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('sets BOM with 1 Frame + 2 Wheels', async () => {
    const result = await setBom(ctx, assemblyId, [
      { componentItemId: compAId, quantity: '1' },
      { componentItemId: compBId, quantity: '2' },
    ]);

    expect(result).toHaveLength(2);
    const frame = result.find((r) => r.componentItemId === compAId);
    const wheel = result.find((r) => r.componentItemId === compBId);

    expect(frame).toBeDefined();
    expect(frame!.componentName).toBe('Frame');
    expect(frame!.quantity).toBe('1.0000');

    expect(wheel).toBeDefined();
    expect(wheel!.componentName).toBe('Wheel');
    expect(wheel!.quantity).toBe('2.0000');
  });

  it('getBom returns the saved BOM', async () => {
    const bom = await getBom(ctx, assemblyId);
    expect(bom).toHaveLength(2);
    const ids = bom.map((r) => r.componentItemId);
    expect(ids).toContain(compAId);
    expect(ids).toContain(compBId);
  });

  // ── buildAssembly ─────────────────────────────────────────────────────────

  it('rejects build when components are insufficient', async () => {
    // Need 99 Frames but only 10 on hand
    await expect(
      buildAssembly(ctx, { assemblyItemId: assemblyId, quantity: '99' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('builds 5 Bike Kits — components reduced, assembly qty/cost increased', async () => {
    const result = await buildAssembly(ctx, { assemblyItemId: assemblyId, quantity: '5' });

    // Result shape
    expect(result.quantityBuilt).toBe('5.0000');
    expect(result.assemblyItemId).toBe(assemblyId);

    // Total cost = 5*1*$20 + 5*2*$15 = $100 + $150 = $250
    expect(result.totalCost).toBe('250.00');

    // averageCost = $250 / 5 = $50 (existing qty was 0)
    expect(result.newAssemblyAvgCost).toBe('50.0000');
    expect(result.newAssemblyQty).toBe('5.0000');

    // Verify DB state for assembly
    const [asmRow] = await db.select().from(items).where(eq(items.id, assemblyId));
    expect(asmRow.quantityOnHand).toBe('5.0000');
    expect(asmRow.averageCost).toBe('50.0000');

    // Verify component A (Frame): 10 - 5 = 5
    const [frameRow] = await db.select().from(items).where(eq(items.id, compAId));
    expect(frameRow.quantityOnHand).toBe('5.0000');

    // Verify component B (Wheel): 20 - 10 = 10
    const [wheelRow] = await db.select().from(items).where(eq(items.id, compBId));
    expect(wheelRow.quantityOnHand).toBe('10.0000');
  });

  it('averageCost is weighted when building into existing stock', async () => {
    // Assembly currently has 5 units @ $50. Build 1 more (cost = 1*$20 + 2*$15 = $50)
    // New weighted avg = (5*50 + 50) / 6 = 300 / 6 = $50.00 (happens to be same)
    const result = await buildAssembly(ctx, { assemblyItemId: assemblyId, quantity: '1' });
    expect(result.newAssemblyQty).toBe('6.0000');
    expect(result.newAssemblyAvgCost).toBe('50.0000');
  });

  // ── unbuildAssembly ───────────────────────────────────────────────────────

  it('rejects unbuild beyond assembly on-hand quantity', async () => {
    await expect(
      unbuildAssembly(ctx, { assemblyItemId: assemblyId, quantity: '999' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('unbuilds 2 Bike Kits — assembly qty reduced, components restored', async () => {
    // Before: Frame=4, Wheel=8 on hand; Assembly=6
    const result = await unbuildAssembly(ctx, { assemblyItemId: assemblyId, quantity: '2' });

    expect(result.quantityUnbuilt).toBe('2.0000');
    expect(result.newAssemblyQty).toBe('4.0000');

    // Assembly qty in DB
    const [asmRow] = await db.select().from(items).where(eq(items.id, assemblyId));
    expect(asmRow.quantityOnHand).toBe('4.0000');

    // Frame restored: 4 + 2 = 6
    const [frameRow] = await db.select().from(items).where(eq(items.id, compAId));
    expect(frameRow.quantityOnHand).toBe('6.0000');

    // Wheel restored: 8 + 4 = 12
    const [wheelRow] = await db.select().from(items).where(eq(items.id, compBId));
    expect(wheelRow.quantityOnHand).toBe('12.0000');
  });

  // ── clearing BOM ──────────────────────────────────────────────────────────

  it('setBom with empty array clears the BOM', async () => {
    await setBom(ctx, assemblyId, []);
    const bom = await getBom(ctx, assemblyId);
    expect(bom).toHaveLength(0);
  });

  it('buildAssembly rejects when BOM is empty', async () => {
    await expect(
      buildAssembly(ctx, { assemblyItemId: assemblyId, quantity: '1' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
