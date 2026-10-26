/**
 * Review round 5 — inventory: items, FIFO / average cost, sites, assemblies, merges and the list
 * services. Each test reproduces a defect found in this round and failed before its fix.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq, like, sql } from 'drizzle-orm';
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
import { consumeStock, receiveStock } from './fifo';
import { createCustomer } from './customers';
import { createInvoice, updateInvoice, voidInvoice } from './invoices';
import { createSalesReceipt, updateSalesReceipt, voidSalesReceipt } from './salesReceipts';
import { createBill, voidBill } from './bills';
import { createExpense } from './expenses';
import { createVendorCredit } from './vendorCredits';
import { inventoryItemDetail } from './lists/inventoryCenter';
import { createVendor } from './vendors';
import { createItemReceipt, voidItemReceipt } from './itemReceipts';
import { createCreditMemo, voidCreditMemo } from './creditMemos';
import { trialBalance } from './reports';
import { verifySiteInvariants } from './inventorySiteReports';
import { handleBulkPost } from '@/lib/lists/bulkRoute';
import { builtinRole, unionRoles } from '@/lib/permissions/model';
import { createEntry, listEntries } from './lists/simpleLists';
import { createType, listTypes } from './typeLists';
import { createUomSet, listUomSets } from './lists/uom';
import { createBillingRateLevel, listBillingRateLevels } from './lists/billingRates';

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

  // ---- FIFO: a sale's units go back into the layers they came from ----

  /** COGS (debit) of the posted entries tagged with a source ref. */
  async function cogsOf(sourceRef: string): Promise<string> {
    const rows = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.sourceRef, sourceRef), eq(journalEntries.status, 'posted')));
    let total = Money.zero();
    for (const r of rows) {
      const tb = await db.execute(
        sql`SELECT COALESCE(SUM(debit), 0) AS d FROM journal_entry_lines WHERE journal_entry_id = ${r.id}::uuid`,
      );
      const out = ((tb as unknown as { rows?: Array<{ d: string }> }).rows ?? []) as Array<{ d: string }>;
      total = total.plus(Money.of(out[0]?.d ?? '0'));
    }
    return total.toFixed(2);
  }

  async function fifoItemWithTwoLayers(name: string) {
    const it = await invItem(name);
    await receiveStock(ctx, { itemId: it.id, quantity: 10, unitCost: '1.00', date: d('2026-01-01') });
    await receiveStock(ctx, { itemId: it.id, quantity: 10, unitCost: '2.00', date: d('2026-01-05') });
    return it.id;
  }

  it('FIFO: re-saving an unchanged invoice keeps its COGS (units return to their own layer)', async () => {
    const item = await fifoItemWithTwoLayers('FIFO resave');
    const c = await createCustomer(ctx, { displayName: 'FIFO buyer' } as never);
    const input = { customerId: c.id, date: d('2026-02-01'), lines: [{ itemId: item, quantity: 10, rate: '5.00' }] };
    const inv = await createInvoice(ctx, input as never);
    expect(await cogsOf(`invoice-cogs:${inv.id}`)).toBe('10.00');
    await updateInvoice(ctx, inv.id, { ...input, memo: 'typo fixed' } as never);
    expect(await cogsOf(`invoice-cogs:${inv.id}`)).toBe('10.00');
    await updateInvoice(ctx, inv.id, { ...input, memo: 'again' } as never);
    expect(await cogsOf(`invoice-cogs:${inv.id}`)).toBe('10.00');
    expect((await inventoryValuation(ctx)).grandTotal).toBe(await gl('1300'));
    expect(await gl('1300')).toBe('20.00');
  });

  it('migration 0067: the audit trail is indexed by the record it is about (FIFO restores look it up)', async () => {
    const res = await db.execute(sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'audit_logs_company_entity_idx'`);
    const rows = ((res as unknown as { rows?: Array<{ indexdef: string }> }).rows ?? []) as Array<{ indexdef: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/\(company_id, entity_type, entity_id\)/);
  });

  it('FIFO: a voided sale puts its units back in FIFO order (the next sale is costed at the oldest cost)', async () => {
    const item = await fifoItemWithTwoLayers('FIFO void order');
    const c = await createCustomer(ctx, { displayName: 'FIFO void buyer' } as never);
    const sr = await createSalesReceipt(ctx, { customerId: c.id, date: d('2026-02-01'), depositAccountId: acct['1000'], lines: [{ itemId: item, quantity: 10, rate: '5.00' }] } as never);
    await voidSalesReceipt(ctx, sr.id);
    const next = await consumeStock(ctx, { itemId: item, quantity: 10, date: d('2026-02-02') });
    expect(next.totalCOGS).toBe('10.00');
    expect((await inventoryValuation(ctx)).grandTotal).toBe(await gl('1300'));
  });

  it('FIFO: re-saving an unchanged sales receipt keeps its COGS', async () => {
    const item = await fifoItemWithTwoLayers('FIFO SR resave');
    const c = await createCustomer(ctx, { displayName: 'FIFO SR buyer' } as never);
    const input = { customerId: c.id, date: d('2026-02-01'), depositAccountId: acct['1000'], lines: [{ itemId: item, quantity: 10, rate: '5.00' }] };
    const sr = await createSalesReceipt(ctx, input as never);
    expect(await cogsOf(`salesreceipt:${sr.id}`)).toBe('60.00'); // 50.00 sale + 10.00 COGS entry debits
    await updateSalesReceipt(ctx, sr.id, { ...input, memo: 'edited' } as never);
    expect(await cogsOf(`salesreceipt:${sr.id}`)).toBe('60.00');
    expect((await inventoryValuation(ctx)).grandTotal).toBe(await gl('1300'));
  });

  it('FIFO: voiding an invoice after a newer receipt restores the oldest units first', async () => {
    const item = await fifoItemWithTwoLayers('FIFO inv void');
    const c = await createCustomer(ctx, { displayName: 'FIFO inv void buyer' } as never);
    const inv = await createInvoice(ctx, { customerId: c.id, date: d('2026-02-01'), lines: [{ itemId: item, quantity: 15, rate: '5.00' }] } as never);
    expect(await cogsOf(`invoice-cogs:${inv.id}`)).toBe('20.00'); // 10 @ 1 + 5 @ 2
    await voidInvoice(ctx, inv.id);
    const next = await consumeStock(ctx, { itemId: item, quantity: 12, date: d('2026-02-03') });
    expect(next.totalCOGS).toBe('14.00'); // 10 @ 1 + 2 @ 2
  });

  // ---- FIFO: a layer is worth exactly what its document posted ----

  it('FIFO: 3000 units received for $1,000.00 are valued at $1,000.00 (bill, item receipt, adjustment)', async () => {
    const item = await invItem('FIFO thirds');
    await receiveStock(ctx, { itemId: item.id, quantity: 1, unitCost: '1.00', date: d('2026-01-01') }); // FIFO from the start
    const v = await createVendor(ctx, { displayName: 'Thirds supplier' } as never);
    const bill = await createBill(ctx, { vendorId: v.id, date: d('2026-01-02'), lines: [{ itemId: item.id, quantity: 3000, amount: '1000.00' }] } as never);
    expect(await gl('1300')).toBe('1001.00');
    expect((await inventoryValuation(ctx)).grandTotal).toBe('1001.00');
    const receipt = await createItemReceipt(ctx, { vendorId: v.id, date: d('2026-01-03'), lines: [{ itemId: item.id, quantity: 3000, unitCost: '0.66666667' }] } as never);
    expect((await inventoryValuation(ctx)).grandTotal).toBe(await gl('1300'));
    await receiveStock(ctx, { itemId: item.id, quantity: 3000, unitCost: '0.33333333', date: d('2026-01-04') });
    expect((await inventoryValuation(ctx)).grandTotal).toBe(await gl('1300'));
    // Selling everything clears the account to exactly $0, and the purchases still void cleanly.
    await voidItemReceipt(ctx, receipt.id);
    await voidBill(ctx, bill.id);
    expect((await inventoryValuation(ctx)).grandTotal).toBe(await gl('1300'));
    await consumeStock(ctx, { itemId: item.id, quantity: 3001, date: d('2026-01-05') });
    expect(await gl('1300')).toBe('0.00');
    expect((await inventoryValuation(ctx)).grandTotal).toBe('0.00');
  });

  it('item receipt: voiding a receipt with a 5-decimal unit cost takes back exactly what it posted', async () => {
    const v = await createVendor(ctx, { displayName: 'Fine cost supplier' } as never);
    // Average cost: 3000 x 0.33333 = 999.99 posted; the stored 4dp unit cost would say 999.90.
    const avg = await invItem('Fine avg');
    await adjustInventory(ctx, { itemId: avg.id, quantityChange: 10, unitCost: '1.00', date: d('2026-01-01') });
    const r1 = await createItemReceipt(ctx, { vendorId: v.id, date: d('2026-01-02'), lines: [{ itemId: avg.id, quantity: 3000, unitCost: '0.33333' }] } as never);
    expect(await gl('1300')).toBe('1009.99');
    await voidItemReceipt(ctx, r1.id);
    expect(await gl('1300')).toBe('10.00');
    expect((await inventoryValuation(ctx)).grandTotal).toBe('10.00');
    await adjustInventory(ctx, { itemId: avg.id, quantityChange: -10, date: d('2026-01-03') });
    expect(await gl('1300')).toBe('0.00');
  });

  it('FIFO: a large credit-memo restock is valued at exactly the cost it put back', async () => {
    const item = await invItem('FIFO restock');
    await receiveStock(ctx, { itemId: item.id, quantity: 3, unitCost: '1.00', date: d('2026-01-01') });
    await receiveStock(ctx, { itemId: item.id, quantity: 4, unitCost: '1.50', date: d('2026-01-02') }); // 9.00 / 7
    const c = await createCustomer(ctx, { displayName: 'Bulk returner' } as never);
    const cm = await createCreditMemo(ctx, { customerId: c.id, date: d('2026-01-03'), lines: [{ itemId: item.id, quantity: 7000, rate: '2.00', restock: true }] } as never);
    expect((await inventoryValuation(ctx)).grandTotal).toBe(await gl('1300'));
    await voidCreditMemo(ctx, cm.id);
    expect((await inventoryValuation(ctx)).grandTotal).toBe(await gl('1300'));
    expect(await gl('1300')).toBe('9.00');
  });

  it('FIFO: switching an average-cost item with a value remainder to FIFO keeps its cents', async () => {
    const item = await invItem('Switch to FIFO');
    await adjustInventory(ctx, { itemId: item.id, quantityChange: 3000, unitCost: '0.33333333', date: d('2026-01-02') });
    expect(await gl('1300')).toBe('1000.00');
    await receiveStock(ctx, { itemId: item.id, quantity: 1, unitCost: '1.00', date: d('2026-01-03') }); // starts FIFO
    expect((await inventoryValuation(ctx)).grandTotal).toBe('1001.00');
    await consumeStock(ctx, { itemId: item.id, quantity: 3001, date: d('2026-01-04') });
    expect(await gl('1300')).toBe('0.00');
  });

  it('FIFO: a consumption without a memo names the item in the journal, not its database id', async () => {
    const item = await invItem('Named gadget');
    await receiveStock(ctx, { itemId: item.id, quantity: 2, unitCost: '3.00', date: d('2026-01-01') });
    const res = await consumeStock(ctx, { itemId: item.id, quantity: 1, date: d('2026-01-02') });
    const [je] = await db.select().from(journalEntries).where(eq(journalEntries.id, res.entryId!));
    expect(je.description).toContain('Named gadget');
    expect(je.description).not.toContain(item.id);
  });

  // ---- zero-cost stock ----

  it('Adjust Quantity: stock with no cost can be added and removed (no $0 journal entry refused)', async () => {
    const avg = await invItem('Free sample');
    const added = await adjustQuantityAtSite(ctx, { itemId: avg.id, quantityChange: '5', unitCost: '0', date: d('2026-01-02') });
    expect(added.quantityOnHand).toBe('5.0000');
    const removed = await adjustQuantityAtSite(ctx, { itemId: avg.id, quantityChange: '-2', date: d('2026-01-03') });
    expect(removed.quantityOnHand).toBe('3.0000');
    // FIFO the same way.
    const fifo = await invItem('Free FIFO sample');
    await adjustQuantityAtSite(ctx, { itemId: fifo.id, quantityChange: '4', unitCost: '0', date: d('2026-01-02'), costing: 'fifo' });
    const out = await adjustQuantityAtSite(ctx, { itemId: fifo.id, quantityChange: '-4', date: d('2026-01-03') });
    expect(out.quantityOnHand).toBe('0.0000');
    expect(await gl('1300')).toBe('0.00');
    expect((await inventoryValuation(ctx)).grandTotal).toBe('0.00');
    // Selling FIFO units that carry no cost is refused with a plain message (not "a line must
    // have a debit or a credit"), like an average-cost item with no average.
    await adjustQuantityAtSite(ctx, { itemId: fifo.id, quantityChange: '2', unitCost: '0', date: d('2026-01-04') });
    const c = await createCustomer(ctx, { displayName: 'Free buyer' } as never);
    await expect(
      createInvoice(ctx, { customerId: c.id, date: d('2026-01-05'), lines: [{ itemId: fifo.id, quantity: 1, rate: '5.00' }] } as never),
    ).rejects.toThrow(/has no cost/);
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

  // ---- lists: double-submitted creates ----

  async function expectOneCreated(results: PromiseSettledResult<unknown>[]) {
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toBeInstanceOf(ServiceError);
    expect((failed[0].reason as ServiceError).code).toBe('VALIDATION');
  }

  it('lists: a double-submitted new list entry makes one entry and a plain duplicate-name error', async () => {
    await listEntries(ctx, 'ship-via'); // seeded
    await expectOneCreated(await Promise.allSettled([
      createEntry(ctx, 'ship-via', { name: 'Courier Twice' }),
      createEntry(ctx, 'ship-via', { name: 'Courier Twice' }),
    ]));
    expect((await listEntries(ctx, 'ship-via')).filter((e) => e.name === 'Courier Twice')).toHaveLength(1);
  });

  it('lists: double-submitted customer type, U/M set and billing rate level make one record each', async () => {
    await expectOneCreated(await Promise.allSettled([
      createType(ctx, 'customer', { name: 'Wholesale' }),
      createType(ctx, 'customer', { name: 'Wholesale' }),
    ]));
    expect((await listTypes(ctx, 'customer')).filter((t) => t.name === 'Wholesale')).toHaveLength(1);
    const set = { name: 'Case of 12', baseUnitName: 'Each', baseUnitAbbrev: 'ea', units: [{ name: 'Case', abbrev: 'cs', factor: '12' }] };
    await expectOneCreated(await Promise.allSettled([createUomSet(ctx, set), createUomSet(ctx, set)]));
    expect((await listUomSets(ctx)).filter((u) => u.name === 'Case of 12')).toHaveLength(1);
    const level = { name: 'Senior rate', type: 'fixed_rate', fixedRate: '150' };
    await expectOneCreated(await Promise.allSettled([createBillingRateLevel(ctx, level), createBillingRateLevel(ctx, level)]));
    expect((await listBillingRateLevels(ctx)).filter((l) => l.name === 'Senior rate')).toHaveLength(1);
  });

  // ---- Inventory Center ----

  it("Inventory Center: an item's transactions include checks, vendor credits and builds, with the quantity each moved", async () => {
    const part = await invItem('Center part');
    await adjustInventory(ctx, { itemId: part.id, quantityChange: 20, unitCost: '1.00', date: d('2026-01-01') });
    const kit = await invItem('Center kit');
    await setBom(ctx, kit.id, [{ componentItemId: part.id, quantity: '2' }]);
    const v = await createVendor(ctx, { displayName: 'Center supplier' } as never);
    await createExpense(ctx, { payeeName: 'Hardware Store', date: d('2026-01-02'), method: 'check', paymentAccountId: acct['1000'], lines: [{ itemId: part.id, quantity: '5', unitCost: '1.00' }] } as never);
    await createVendorCredit(ctx, { vendorId: v.id, date: d('2026-01-03'), lines: [{ itemId: part.id, quantity: '3', amount: '3.00' }] } as never);
    await buildAssembly(ctx, { assemblyItemId: kit.id, quantity: 4, date: d('2026-01-04') });
    const c = await createCustomer(ctx, { displayName: 'Center buyer' } as never);
    await createCreditMemo(ctx, { customerId: c.id, date: d('2026-01-05'), lines: [{ itemId: part.id, quantity: 2, rate: '1.00', restock: false }] } as never);
    const detail = await inventoryItemDetail(ctx, part.id);
    const byType = (t: string) => detail.transactions.filter((x) => x.type === t).map((x) => x.quantity);
    expect(byType('Check')).toEqual(['5.0000']);
    expect(byType('Vendor Credit')).toEqual(['-3.0000']);
    expect(byType('Build Assembly')).toEqual(['-8.0000']);
    expect(byType('Credit Memo')).toEqual(['0.0000']); // not restocked: no stock came back
    expect(byType('Inventory Adjustment')).toEqual(['20.0000']);
    // The quantities shown add up to the quantity on hand (20 + 5 - 3 - 8).
    const sum = detail.transactions.reduce((acc, x) => acc.plus(Money.of(x.quantity)), Money.zero());
    expect(sum.toFixed(4)).toBe((await itemRow(part.id)).quantityOnHand);
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
