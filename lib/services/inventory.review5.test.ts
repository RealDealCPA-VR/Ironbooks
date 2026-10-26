/**
 * Review round 5 — inventory: items, FIFO / average cost, sites, assemblies, merges and the list
 * services. Each test reproduces a defect found in this round and failed before its fix.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq, like } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, assemblyComponents, items as itemsTable, journalEntries, users } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import { ServiceError, type ServiceContext } from './_base';
import { createCompany } from './company';
import { createItem, updateItem } from './items';
import { adjustInventory, inventoryValuation, inventoryValuationAsOf } from './inventory';
import { adjustQuantityAtSite } from './inventorySiteOps';
import { buildAssembly, getBom, setBom, unbuildAssembly } from './assemblies';
import { mergeItems } from './lists/mergeLists';
import { trialBalance } from './reports';
import { verifySiteInvariants } from './inventorySiteReports';
import { handleBulkPost } from '@/lib/lists/bulkRoute';
import { builtinRole, unionRoles } from '@/lib/permissions/model';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-inventory-review5');
let db: DB;
let ctx: ServiceContext;
let userId: string;
let acct: Record<string, string> = {};
let seq = 0;
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);

/** GL balance (debit-positive) of an account code. */
async function gl(code: string, asOf?: Date): Promise<string> {
  const row = (await trialBalance(ctx, asOf)).rows.find((r) => r.code === code);
  return row ? Money.sub(row.debit, row.credit).toFixed(2) : '0.00';
}

async function invItem(name: string, extra: Record<string, unknown> = {}) {
  return createItem(ctx, {
    name,
    type: 'inventory',
    salesPrice: '10.00',
    incomeAccountId: acct['4000'],
    expenseAccountId: acct['5000'],
    assetAccountId: acct['1300'],
    ...extra,
  } as never);
}

async function itemRow(id: string) {
  const [row] = await db.select().from(itemsTable).where(eq(itemsTable.id, id));
  return row;
}

describe('review5 inventory', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'review5-inv@test.local', name: 'R5', passwordHash: 'x' }).returning();
    userId = u.id;
  });
  beforeEach(async () => {
    seq += 1;
    const company = await createCompany(db, { name: `R5 inventory ${seq}`, ownerId: userId });
    ctx = { db, companyId: company.id, userId };
    acct = {};
    for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[r.code] = r.id;
  });
  afterAll(async () => {
    await closeDb(TEST_DIR);
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle. */
    }
  });

  // ---- merge items ----

  it('merge: an adjustment of the duplicate committed while the merge runs is not lost (GL = valuation)', async () => {
    const a = await invItem('Merge race A');
    const b = await invItem('Merge race B');
    await adjustInventory(ctx, { itemId: a.id, quantityChange: 10, unitCost: '2.00', date: d('2026-01-02') });
    await adjustInventory(ctx, { itemId: b.id, quantityChange: 10, unitCost: '2.00', date: d('2026-01-02') });
    // Another user's adjustment of the duplicate commits after the merge looked at the items but
    // before its transaction starts (deterministic stand-in for two requests interleaving).
    let fired = false;
    const mergeCtx: ServiceContext = {
      ...ctx,
      db: new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === 'transaction' && !fired) {
            return async (fn: never) => {
              fired = true;
              await adjustQuantityAtSite(ctx, { itemId: a.id, quantityChange: '-4', date: d('2026-01-03') });
              return target.transaction(fn);
            };
          }
          const v = Reflect.get(target, prop, receiver);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      }),
    };
    await mergeItems(mergeCtx, { fromId: a.id, toId: b.id });
    expect(fired).toBe(true);
    expect((await itemRow(b.id)).quantityOnHand).toBe('16.0000');
    expect((await inventoryValuation(ctx)).grandTotal).toBe(await gl('1300'));
  });

  it('merge: value remainders move to the survivor, so selling it out clears the GL to $0', async () => {
    const a = await invItem('Thirds A');
    const b = await invItem('Thirds B');
    // 3000 for $1000.00: average 0.3333 books 999.90, the GL holds 1000.00 (0.10 remainder).
    await adjustInventory(ctx, { itemId: a.id, quantityChange: 3000, unitCost: '0.33333333', date: d('2026-01-02') });
    await adjustInventory(ctx, { itemId: b.id, quantityChange: 3000, unitCost: '0.33333333', date: d('2026-01-02') });
    expect(await gl('1300')).toBe('2000.00');
    await mergeItems(ctx, { fromId: a.id, toId: b.id });
    expect((await itemRow(b.id)).quantityOnHand).toBe('6000.0000');
    await adjustInventory(ctx, { itemId: b.id, quantityChange: -6000, date: d('2026-01-05') });
    expect(await gl('1300')).toBe('0.00');
  });

  it('merge: two assemblies sharing a component keep ONE BOM line per component (builds stay tied)', async () => {
    const part = await invItem('Shared part');
    await adjustInventory(ctx, { itemId: part.id, quantityChange: 100, unitCost: '1.00', date: d('2026-01-02') });
    const kitA = await invItem('Kit A');
    const kitB = await invItem('Kit B');
    await setBom(ctx, kitA.id, [{ componentItemId: part.id, quantity: '2' }]);
    await setBom(ctx, kitB.id, [{ componentItemId: part.id, quantity: '3' }]);
    await mergeItems(ctx, { fromId: kitA.id, toId: kitB.id });
    const bom = await getBom(ctx, kitB.id);
    expect(bom.map((r) => r.componentItemId)).toEqual([part.id]);
    expect(bom[0].quantity).toBe('3.0000'); // the survivor's own BOM wins
    await buildAssembly(ctx, { assemblyItemId: kitB.id, quantity: 10, date: d('2026-01-03') });
    expect((await itemRow(part.id)).quantityOnHand).toBe('70.0000');
    expect((await inventoryValuation(ctx)).grandTotal).toBe(await gl('1300'));
    const rows = await db.select().from(assemblyComponents).where(eq(assemblyComponents.assemblyItemId, kitA.id));
    expect(rows).toHaveLength(0);
  });

  it("merge: the duplicate's adjustments follow the survivor (as-of valuation ties to the GL)", async () => {
    const a = await invItem('History A');
    const b = await invItem('History B');
    await adjustInventory(ctx, { itemId: a.id, quantityChange: 10, unitCost: '2.00', date: d('2026-01-02') });
    await adjustInventory(ctx, { itemId: b.id, quantityChange: 5, unitCost: '2.00', date: d('2026-01-02') });
    await mergeItems(ctx, { fromId: a.id, toId: b.id });
    const asOf = await inventoryValuationAsOf(ctx, d('2026-12-31'));
    expect(asOf.grandTotal).toBe('30.00');
    expect(asOf.items.find((r) => r.id === b.id)?.valueAsOf).toBe('30.00');
    const tagged = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.sourceRef, `item:${a.id}`)));
    expect(tagged).toHaveLength(0);
  });

  it('merge: a merge that would make an assembly its own component is refused (and rolled back)', async () => {
    const part = await invItem('Cycle part');
    const sub = await invItem('Cycle sub');
    const top = await invItem('Cycle top');
    await setBom(ctx, sub.id, [{ componentItemId: part.id, quantity: '1' }]);
    await setBom(ctx, top.id, [{ componentItemId: sub.id, quantity: '1' }]);
    // top -> sub -> part; merging part into top would give top -> sub -> top.
    await expect(mergeItems(ctx, { fromId: part.id, toId: top.id })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await itemRow(part.id)).isActive).toBe(true);
    expect((await getBom(ctx, sub.id)).map((r) => r.componentItemId)).toEqual([part.id]);
  });

  // ---- dates ----

  it('build / unbuild without a date are dated on the local calendar day (not tomorrow in UTC)', async () => {
    const part = await invItem('Late part');
    await adjustInventory(ctx, { itemId: part.id, quantityChange: 10, unitCost: '1.00', date: d('2026-12-01') });
    const kit = await invItem('Late kit');
    await setBom(ctx, kit.id, [{ componentItemId: part.id, quantity: '1' }]);
    const prevTz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // 11:30 pm on New Year's Eve in New York = 04:30 UTC on Jan 1.
      vi.setSystemTime(new Date('2027-01-01T04:30:00.000Z'));
      await buildAssembly(ctx, { assemblyItemId: kit.id, quantity: 2 });
      await unbuildAssembly(ctx, { assemblyItemId: kit.id, quantity: 1 });
    } finally {
      vi.useRealTimers();
      process.env.TZ = prevTz;
      if (prevTz === undefined) delete process.env.TZ;
    }
    const entries = await db
      .select({ date: journalEntries.date, sourceRef: journalEntries.sourceRef })
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), like(journalEntries.sourceRef, 'assembly%')));
    expect(entries).toHaveLength(2);
    for (const e of entries) expect(e.date.toISOString().slice(0, 10)).toBe('2026-12-31');
  });

  // ---- valuation includes inactive items that still hold stock ----

  it('valuation: an inactive item that still holds stock is valued (ties to the GL)', async () => {
    const a = await invItem('Retired widget');
    await adjustInventory(ctx, { itemId: a.id, quantityChange: 4, unitCost: '5.00', date: d('2026-01-02') });
    await updateItem(ctx, a.id, { isActive: false });
    expect((await inventoryValuation(ctx)).grandTotal).toBe('20.00');
    expect((await inventoryValuationAsOf(ctx, d('2026-12-31'))).grandTotal).toBe('20.00');
  });

  // ---- Advanced Inventory self-check ----

  it('self-check: a value remainder is not reported as a GL / valuation difference', async () => {
    const a = await invItem('Remainder widget');
    await adjustInventory(ctx, { itemId: a.id, quantityChange: 3000, unitCost: '0.33333333', date: d('2026-01-02') });
    const res = await verifySiteInvariants(ctx);
    const glCheck = res.checks.find((c) => c.name.startsWith('Inventory asset GL'));
    expect(glCheck?.ok, glCheck?.detail).toBe(true);
  });

  // ---- permissions ----

  it('Add/Edit Multiple: opening quantity on hand needs inventory rights (A/R clerk refused)', async () => {
    const clerk: ServiceContext = { ...ctx, access: unionRoles([builtinRole('ar_clerk')!]) };
    let caught: unknown;
    try {
      await handleBulkPost(clerk, 'items', 'lists', {
        rows: [{ name: 'Bulk stock', type: 'inventory', openingQuantity: '10', openingValue: '50.00', assetAccount: '1300' }],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('FORBIDDEN');
    expect(await gl('1300')).toBe('0.00');
  });
});
