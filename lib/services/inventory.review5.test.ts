/**
 * Review round 5 — inventory: items, FIFO / average cost, sites, assemblies, merges and the list
 * services. Each test reproduces a defect found in this round and failed before its fix.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq, like, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accountantCopies, accounts, assemblyComponents, items as itemsTable, journalEntries, users } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import { ServiceError, type ServiceContext } from './_base';
import { createCompany } from './company';
import { createItem, updateItem } from './items';
import { adjustInventory, inventoryValuation, inventoryValuationAsOf, setReorderPoint } from './inventory';
import { adjustQuantityAtSite } from './inventorySiteOps';
import { buildAssembly, getBom, setBom, unbuildAssembly } from './assemblies';
import { mergeItems } from './lists/mergeLists';
import { consumeStock, receiveStock } from './fifo';
import { createCustomer } from './customers';
import { createInvoice, updateInvoice, voidInvoice } from './invoices';
import { createSalesReceipt, updateSalesReceipt, voidSalesReceipt } from './salesReceipts';
import { createBill, voidBill } from './bills';
import { createExpense } from './expenses';
import { createVendorCredit, updateVendorCredit, voidVendorCredit } from './vendorCredits';
import { inventoryItemDetail } from './lists/inventoryCenter';
import { createPurchaseOrdersFromReorder } from './lists/itemTools';
import { createItemWithOpeningStock } from './lists/openingStock';

import { purchaseOrders } from '@/lib/db/schema';
import { createVendor } from './vendors';
import { createItemReceipt, voidItemReceipt } from './itemReceipts';
import { createCreditMemo, voidCreditMemo } from './creditMemos';
import { trialBalance } from './reports';
import { verifySiteInvariants } from './inventorySiteReports';
import { createBin, createSite, listBins, updateBin } from './inventorySites';
import { handleBulkPost } from '@/lib/lists/bulkRoute';
import { builtinRole, unionRoles } from '@/lib/permissions/model';
import { createEntry, listEntries, updateEntry } from './lists/simpleLists';
import { createType, listTypes, updateType } from './typeLists';
import { createUomSet, listUomSets, updateUomSet } from './lists/uom';
import { createBillingRateLevel, listBillingRateLevels } from './lists/billingRates';
import { auditLogs, companies, customers as customersTable } from '@/lib/db/schema';
import { physicalCount } from './inventoryOps';
import { inventoryCenterList } from './lists/inventoryCenter';
import { bulkLoad, bulkSave } from './lists/bulk';
import { createAccount } from './accounts';
import { withVersionCheck } from './concurrency';
import { createInventoryTransfer, voidInventoryTransfer } from './inventoryTransfers';
import { listSites, siteQuantities } from './inventorySites';
import { quantityOnHandBySite, serialLotInStock, transactionsBySerialLot } from './inventorySiteReports';

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

  it('FIFO: re-saving an unchanged vendor credit keeps the cost it returned (units go back to their own layer)', async () => {
    const item = await fifoItemWithTwoLayers('FIFO return');
    const v = await createVendor(ctx, { displayName: 'Return supplier' } as never);
    const input = { vendorId: v.id, date: d('2026-02-01'), lines: [{ itemId: item, quantity: '10', amount: '10.00' }] };
    const vc = await createVendorCredit(ctx, input as never);
    const cost = async () => {
      const [row] = await db.execute(sql`SELECT cost_amount FROM vendor_credit_lines WHERE vendor_credit_id = ${vc.id}::uuid`).then(
        (r) => ((r as unknown as { rows?: Array<{ cost_amount: string }> }).rows ?? []) as Array<{ cost_amount: string }>,
      );
      return row?.cost_amount;
    };
    expect(await cost()).toBe('10.00'); // the 10 @ 1.00 layer
    await updateVendorCredit(ctx, vc.id, { ...input, memo: 'edited' } as never);
    expect(await cost()).toBe('10.00');
    expect((await inventoryValuation(ctx)).grandTotal).toBe(await gl('1300'));
    await voidVendorCredit(ctx, vc.id);
    const next = await consumeStock(ctx, { itemId: item, quantity: 10, date: d('2026-02-03') });
    expect(next.totalCOGS).toBe('10.00');
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

  it('purchase orders from the reorder list are dated today on the local calendar (not tomorrow in UTC)', async () => {
    const v = await createVendor(ctx, { displayName: 'Reorder supplier' } as never);
    const it0 = await invItem('Reorder widget', { preferredVendorId: v.id, purchaseCost: '2.00' });
    await setReorderPoint(ctx, it0.id, 5);
    const prevTz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    vi.useFakeTimers({ toFake: ['Date'] });
    let poId: string;
    try {
      vi.setSystemTime(new Date('2027-01-01T03:00:00.000Z')); // 10 pm on Dec 31 in New York
      const res = await createPurchaseOrdersFromReorder(ctx, {});
      poId = (res.purchaseOrders[0] as unknown as { purchaseOrderId: string }).purchaseOrderId;
    } finally {
      vi.useRealTimers();
      process.env.TZ = prevTz;
      if (prevTz === undefined) delete process.env.TZ;
    }
    const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId));
    expect(po.date.toISOString().slice(0, 10)).toBe('2026-12-31');
  });

  it('opening quantity on hand without an as-of date is dated today on the local calendar', async () => {
    const prevTz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    vi.useFakeTimers({ toFake: ['Date'] });
    let entryId: string | null = null;
    try {
      vi.setSystemTime(new Date('2027-01-01T03:00:00.000Z')); // 10 pm on Dec 31 in New York
      const res = await createItemWithOpeningStock(ctx, {
        name: 'Year-end stock',
        type: 'inventory',
        assetAccountId: acct['1300'],
        incomeAccountId: acct['4000'],
        openingQuantity: '10',
        openingValue: '50.00',
      } as never);
      entryId = res.opening!.entryId;
    } finally {
      vi.useRealTimers();
      process.env.TZ = prevTz;
      if (prevTz === undefined) delete process.env.TZ;
    }
    const [je] = await db.select().from(journalEntries).where(eq(journalEntries.id, entryId!));
    expect(je.date.toISOString().slice(0, 10)).toBe('2026-12-31');
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

  // ---- item setup ----

  it("items: an inventory item's asset account must be an Other Current Asset (not a bank or Undeposited Funds)", async () => {
    for (const code of ['1000', '1050']) {
      await expect(
        createItem(ctx, { name: `Bad asset ${code}`, type: 'inventory', assetAccountId: acct[code], incomeAccountId: acct['4000'] } as never),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    const ok = await invItem('Good asset');
    await expect(updateItem(ctx, ok.id, { assetAccountId: acct['1000'] })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it("lists: while an Accountant's Copy is out, a customer type or U/M set can't be made inactive (like any list entry)", async () => {
    const t = await createType(ctx, 'vendor', { name: 'Freight' });
    const set = await createUomSet(ctx, { name: 'Dozen', baseUnitName: 'Each', baseUnitAbbrev: 'ea', units: [{ name: 'Dozen', abbrev: 'dz', factor: '12' }] });
    await db.insert(accountantCopies).values({ companyId: ctx.companyId, side: 'client', status: 'outstanding', dividingDate: '2026-03-31', fileToken: 'r5-token' });
    await expect(updateType(ctx, 'vendor', t.id, { name: 'Freight', isActive: false })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      updateUomSet(ctx, set.id, { name: 'Dozen', baseUnitName: 'Each', baseUnitAbbrev: 'ea', isActive: false, units: [{ name: 'Dozen', abbrev: 'dz', factor: '12' }] }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // Renaming is still fine.
    await expect(updateType(ctx, 'vendor', t.id, { name: 'Freight & Haulage' })).resolves.toBeTruthy();
    expect((await listTypes(ctx, 'vendor')).find((x) => x.id === t.id)?.isActive).toBe(true);
  });

  it('sites: renaming a bin to the name of another bin at the same site is refused (as creating one is)', async () => {
    const site = await createSite(ctx, { name: 'Back room' });
    const a = await createBin(ctx, { siteId: site.id, name: 'A1' });
    const b = await createBin(ctx, { siteId: site.id, name: 'B1' });
    await expect(createBin(ctx, { siteId: site.id, name: 'a1' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateBin(ctx, b.id, { name: 'a1' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateBin(ctx, a.id, { name: 'a1' })).resolves.toBeTruthy(); // its own name, other case
    expect((await listBins(ctx, { siteId: site.id })).map((x) => x.name).sort()).toEqual(['B1', 'a1']);
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

  // ---- part 2 ----

  async function setClosingDate(closingDate: string | null) {
    const [co] = await db.select().from(companies).where(eq(companies.id, ctx.companyId));
    await db
      .update(companies)
      .set({ settings: { ...((co.settings as Record<string, unknown>) ?? {}), closingDate } })
      .where(eq(companies.id, ctx.companyId));
  }
  const closingExceptions = () =>
    db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityType, 'closing_date_exception')));

  it('physical count / opening stock that move no value still respect the closing date', async () => {
    const a = await invItem('Count free sample');
    await adjustInventory(ctx, { itemId: a.id, quantityChange: 5, unitCost: '0', date: d('2026-01-02') });
    await setClosingDate('2026-03-31');
    await expect(physicalCount(ctx, { itemId: a.id, countedQty: 3, date: d('2026-03-15') })).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
    expect((await itemRow(a.id)).quantityOnHand).toBe('5.0000');
    // With the closing-date password it goes through, and the override is on record.
    const pw: ServiceContext = { ...ctx, closingDateOverride: true };
    await physicalCount(pw, { itemId: a.id, countedQty: 3, date: d('2026-03-15') });
    expect((await itemRow(a.id)).quantityOnHand).toBe('3.0000');
    expect(await closingExceptions()).toHaveLength(1);
    // A new item's opening quantity at $0, dated inside the closed period.
    await expect(
      createItemWithOpeningStock(ctx, {
        name: 'Free opening stock',
        type: 'inventory',
        assetAccountId: acct['1300'],
        incomeAccountId: acct['4000'],
        openingQuantity: '4',
        openingValue: '0',
        openingAsOf: d('2026-02-01'),
      } as never),
    ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
  });

  it('Add/Edit Multiple: an existing item edited in the grid saves (its Type column comes back unchanged)', async () => {
    const a = await invItem('Grid widget', { purchaseCost: '2.00' });
    const row = (await bulkLoad(ctx, 'items')).find((r) => r.id === a.id)!;
    expect(row.type).toBe('inventory');
    const res = await bulkSave(ctx, 'items', [{ ...row, salesPrice: '12.50' }]);
    expect(res.errors).toEqual([]);
    expect(res.saved).toBe(true);
    expect((await itemRow(a.id)).salesPrice).toBe('12.50');
    // Changing the type of an existing item is still refused.
    const res2 = await bulkSave(ctx, 'items', [{ ...row, type: 'service' }]);
    expect(res2.saved).toBe(false);
    expect(res2.errors[0]).toMatchObject({ field: 'type' });
  });

  it('Inventory Center: an average-cost item is valued with its value remainder (ties to the valuation report)', async () => {
    const a = await invItem('Center remainder');
    await adjustInventory(ctx, { itemId: a.id, quantityChange: 3000, unitCost: '0.33333333', date: d('2026-01-02') });
    const row = (await inventoryCenterList(ctx)).find((r) => r.id === a.id)!;
    const val = (await inventoryValuation(ctx)).items.find((r) => r.id === a.id)!;
    expect(val.totalValue).toBe('1000.00');
    expect(row.value).toBe(val.totalValue);
  });

  it("COGS relief of an average-cost item posts to the item's own COGS account (as FIFO items do)", async () => {
    const own = await createAccount(ctx, { code: '5010', name: 'COGS - Widgets', type: 'expense' as never, subtype: 'cost_of_goods_sold' });
    const a = await invItem('Own COGS widget', { expenseAccountId: own.id });
    await adjustInventory(ctx, { itemId: a.id, quantityChange: 10, unitCost: '2.00', date: d('2026-01-02') });
    await adjustQuantityAtSite(ctx, { itemId: a.id, quantityChange: '-3', date: d('2026-01-03'), purpose: 'cogs' });
    const f = await invItem('Own COGS FIFO widget', { expenseAccountId: own.id });
    await adjustQuantityAtSite(ctx, { itemId: f.id, quantityChange: '10', unitCost: '1.00', date: d('2026-01-02'), costing: 'fifo' });
    await adjustQuantityAtSite(ctx, { itemId: f.id, quantityChange: '-2', date: d('2026-01-03'), purpose: 'cogs' });
    expect(await gl('5010')).toBe('8.00');
    expect(await gl('5000')).toBe('0.00');
  });

  it('record locking: selling the item while its form is open does not make saving the form a conflict', async () => {
    const a = await invItem('Locked widget');
    await adjustInventory(ctx, { itemId: a.id, quantityChange: 10, unitCost: '2.00', date: d('2026-01-02') });
    // The version the item form loaded (lib/client.ts versionOf: editedAt where the record has one).
    const versionOf = (r: Record<string, unknown>) => (r.editedAt !== undefined ? r.editedAt : r.updatedAt) as Date;
    const loaded = versionOf(await itemRow(a.id));
    // Meanwhile another user sells two and adjusts one: stock moves, the item record is not edited.
    const c = await createCustomer(ctx, { displayName: 'Lock buyer' } as never);
    await createInvoice(ctx, { customerId: c.id, date: d('2026-01-03'), lines: [{ itemId: a.id, quantity: 2, rate: '5.00' }] } as never);
    await adjustQuantityAtSite(ctx, { itemId: a.id, quantityChange: '-1', date: d('2026-01-04') });
    const saved = await withVersionCheck(ctx, 'item', a.id, loaded, (c2) => updateItem(c2, a.id, { salesPrice: '11.00' }));
    expect(saved.salesPrice).toBe('11.00');
    expect((await itemRow(a.id)).quantityOnHand).toBe('7.0000');
    // A real edit of the item by someone else in between still conflicts.
    const mine = versionOf(saved as unknown as Record<string, unknown>);
    await updateItem(ctx, a.id, { description: 'changed by another user' });
    await expect(
      withVersionCheck(ctx, 'item', a.id, mine, (c2) => updateItem(c2, a.id, { salesPrice: '12.00' })),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('transfers dated on or before the closing date record the password override (Closing Date Exception report)', async () => {
    const def = (await listSites(ctx)).find((s) => s.isDefault)!; // "Main Warehouse"
    const site = await createSite(ctx, { name: 'Transfer annex' });
    const a = await invItem('Transfer widget');
    await adjustInventory(ctx, { itemId: a.id, quantityChange: 5, unitCost: '1.00', date: d('2026-01-02') });
    await setClosingDate('2026-03-31');
    await expect(
      createInventoryTransfer(ctx, { date: d('2026-03-10'), fromSiteId: def.id, toSiteId: site.id, lines: [{ itemId: a.id, quantity: '2' }] }),
    ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
    const pw: ServiceContext = { ...ctx, closingDateOverride: true };
    const t = await createInventoryTransfer(pw, { date: d('2026-03-10'), fromSiteId: def.id, toSiteId: site.id, lines: [{ itemId: a.id, quantity: '2' }] });
    await voidInventoryTransfer(pw, t.id);
    const ex = await closingExceptions();
    expect(ex.map((e) => (e.newValues as { operation: string }).operation).sort()).toEqual(['post', 'void']);
  });

  it('vendor credit: serial- and lot-tracked items can be returned, from the site that holds them', async () => {
    const v = await createVendor(ctx, { displayName: 'Serial supplier' } as never);
    const s = await invItem('Serial router', { trackingMode: 'serial' });
    await adjustQuantityAtSite(ctx, { itemId: s.id, quantityChange: '2', unitCost: '50.00', date: d('2026-01-02'), serialNumbers: ['SN-1', 'SN-2'] });
    const vc = await createVendorCredit(ctx, {
      vendorId: v.id,
      date: d('2026-01-05'),
      lines: [{ itemId: s.id, quantity: '1', amount: '50.00', serialNumbers: ['SN-1'] }],
    } as never);
    const inStock = async () => (await serialLotInStock(ctx, { itemId: s.id })).serials.map((x) => x.serialNumber).sort();
    expect(await inStock()).toEqual(['SN-2']);
    // Re-saving the credit unchanged (a form without the serial column) keeps the serial it returned.
    await updateVendorCredit(ctx, vc.id, {
      vendorId: v.id,
      date: d('2026-01-06'),
      lines: [{ itemId: s.id, quantity: '1', amount: '50.00' }],
    } as never);
    expect(await inStock()).toEqual(['SN-2']);
    await voidVendorCredit(ctx, vc.id);
    expect(await inStock()).toEqual(['SN-1', 'SN-2']);
    // Lot-tracked.
    const lot = await invItem('Lot paint', { trackingMode: 'lot' });
    await adjustQuantityAtSite(ctx, { itemId: lot.id, quantityChange: '10', unitCost: '3.00', date: d('2026-01-02'), lotNumber: 'L-7' });
    await createVendorCredit(ctx, { vendorId: v.id, date: d('2026-01-05'), lines: [{ itemId: lot.id, quantity: '4', amount: '12.00', lotNumber: 'L-7' }] } as never);
    expect((await serialLotInStock(ctx, { itemId: lot.id })).lots.map((l) => [l.lotNumber, l.quantity])).toEqual([['L-7', '6.0000']]);
    // Stock that sits at another site goes back to the vendor from that site.
    const annex = await createSite(ctx, { name: 'Return annex' });
    const p = await invItem('Annex part');
    await adjustQuantityAtSite(ctx, { itemId: p.id, quantityChange: '3', unitCost: '1.00', date: d('2026-01-02'), siteId: annex.id });
    await createVendorCredit(ctx, { vendorId: v.id, date: d('2026-01-05'), lines: [{ itemId: p.id, quantity: '2', amount: '2.00', siteId: annex.id }] } as never);
    const q = await siteQuantities(ctx, [p.id]);
    expect(q.get(p.id)?.get(annex.id)?.toFixed(4)).toBe('1.0000');
    expect((await verifySiteInvariants(ctx)).allOk).toBe(true);
  });

  it('selling average-cost stock that carries no cost is refused with a plain message on every sales form', async () => {
    const a = await invItem('Free giveaway');
    await adjustInventory(ctx, { itemId: a.id, quantityChange: 5, unitCost: '0', date: d('2026-01-02') });
    const c = await createCustomer(ctx, { displayName: 'Giveaway buyer' } as never);
    const sale = { customerId: c.id, date: d('2026-01-05'), depositAccountId: acct['1000'], lines: [{ itemId: a.id, quantity: 1, rate: '5.00' }] };
    await expect(createSalesReceipt(ctx, sale as never)).rejects.toThrow(/has no (average )?cost/);
    // An average so small that one unit is worth less than a cent: the same plain message.
    const b = await invItem('Tiny washer');
    await adjustInventory(ctx, { itemId: b.id, quantityChange: 1, unitCost: '0.0001', date: d('2026-01-02') });
    await expect(
      createInvoice(ctx, { customerId: c.id, date: d('2026-01-05'), lines: [{ itemId: b.id, quantity: 1, rate: '1.00' }] } as never),
    ).rejects.toThrow(/has no (average )?cost/);
    expect((await itemRow(a.id)).quantityOnHand).toBe('5.0000');
  });

  it('Build Assemblies window: the build is dated by its Date field (back-dated builds), as in QB', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'app/assemblies/page.tsx'), 'utf8');
    expect(src).toMatch(/id="build-date"[\s\S]{0,200}type="date"|type="date"[\s\S]{0,200}id="build-date"/);
    const call = (url: string) => {
      const at = src.indexOf(`api.post${url.includes('pending') ? '<{ build: PendingBuild }>' : ''}('${url}'`);
      expect(at, url).toBeGreaterThan(0);
      return src.slice(at, src.indexOf('});', at));
    };
    expect(call('/api/assemblies/build')).toMatch(/date: buildDate/);
    expect(call('/api/assemblies/pending')).toMatch(/date: buildDate/);
  });

  it('Vendor Credit window: the Items tab lists the items and carries site / serial / lot detail', () => {
    // GET /api/items answers { items: [...] } (app/api/items/route.ts), not a bare array.
    const route = fs.readFileSync(path.resolve(process.cwd(), 'app/api/items/route.ts'), 'utf8');
    expect(route).toMatch(/NextResponse\.json\(\{ items: rows \}\)/);
    const src = fs.readFileSync(path.resolve(process.cwd(), 'app/vendor-credits/page.tsx'), 'utf8');
    expect(src).not.toMatch(/api\.get<Named\[\]>\('\/api\/items'\)/);
    expect(src).toMatch(/api\.get<\{ items: Named\[\] \}>\('\/api\/items'\)/);
    // Returned units of serial / lot items and of other sites: the line's Advanced Inventory fields.
    expect(src).toMatch(/<InventoryLineFields[\s\S]{0,300}direction="out"/);
    expect(src).toMatch(/\.\.\.inventoryLinePayload\(l\.inv\)/);
    expect(src).toMatch(/inv: invFromLine\(l\)/);
  });

  it('items: two saves at once cannot give two items the same name or barcode (checked in the save transaction)', async () => {
    const a = await invItem('Twin A');
    const b = await invItem('Twin B');
    await expectOneCreated(await Promise.allSettled([updateItem(ctx, a.id, { name: 'Twin' }), updateItem(ctx, b.id, { name: 'Twin' })]));
    const named = (await db.select().from(itemsTable).where(eq(itemsTable.companyId, ctx.companyId))).filter((i) => i.name === 'Twin');
    expect(named).toHaveLength(1);
    // Barcodes have a unique index: the loser got the raw index error (HTTP 500), not the plain message.
    await expectOneCreated(
      await Promise.allSettled([updateItem(ctx, a.id, { barcode: '0042' }), updateItem(ctx, b.id, { barcode: '0042' })]),
    );
  });

  it("lists: changing a sales tax code's taxable flag updates the items and customers that use the code", async () => {
    const code = await createEntry(ctx, 'sales-tax-codes', { code: 'Res', description: 'Resale', taxable: true });
    const it0 = await createItem(ctx, { name: 'Coded widget', type: 'service', salesTaxCodeId: code.id, incomeAccountId: acct['4000'] } as never);
    const cust = await createCustomer(ctx, { displayName: 'Coded customer', salesTaxCodeId: code.id } as never);
    expect(it0.taxable).toBe(true);
    await updateEntry(ctx, 'sales-tax-codes', code.id, { taxable: false });
    expect((await itemRow(it0.id)).taxable).toBe(false);
    const [c] = await db.select().from(customersTable).where(eq(customersTable.id, cust.id));
    expect(c.taxable).toBe(false);
  });

  it('Quantity on Hand by Site: item, site and grand-total values tie to the Inventory Valuation Summary', async () => {
    const annexSiteOf = async () => {
      await listSites(ctx);
      return createSite(ctx, { name: 'Value annex' });
    };
    const annex = await annexSiteOf();
    const avg = await invItem('Site remainder widget');
    await adjustInventory(ctx, { itemId: avg.id, quantityChange: 3000, unitCost: '0.33333333', date: d('2026-01-02') }); // $1,000.00
    await createInventoryTransfer(ctx, {
      date: d('2026-01-03'),
      fromSiteId: (await listSites(ctx)).find((s) => s.isDefault)!.id,
      toSiteId: annex.id,
      lines: [{ itemId: avg.id, quantity: '1000' }],
    });
    const fifo = await invItem('Site FIFO widget');
    await adjustQuantityAtSite(ctx, { itemId: fifo.id, quantityChange: '3000', unitCost: '0.33333333', date: d('2026-01-02'), costing: 'fifo' });
    const val = await inventoryValuation(ctx);
    const rep = await quantityOnHandBySite(ctx);
    for (const id of [avg.id, fifo.id]) {
      expect(rep.rows.find((r) => r.itemId === id)!.totalValue).toBe(val.items.find((r) => r.id === id)!.totalValue);
    }
    expect(rep.grandTotalValue).toBe(val.grandTotal);
    const siteSum = rep.sites.reduce((s, x) => s.plus(Money.of(x.totalValue)), Money.zero());
    expect(siteSum.toFixed(2)).toBe(val.grandTotal);
  });

  it('merge: two serial-tracked items that both hold the same serial number in stock cannot be merged', async () => {
    const a = await invItem('Serial dup A', { trackingMode: 'serial' });
    const b = await invItem('Serial dup B', { trackingMode: 'serial' });
    await adjustQuantityAtSite(ctx, { itemId: a.id, quantityChange: '2', unitCost: '5.00', date: d('2026-01-02'), serialNumbers: ['X-1', 'X-2'] });
    await adjustQuantityAtSite(ctx, { itemId: b.id, quantityChange: '1', unitCost: '5.00', date: d('2026-01-02'), serialNumbers: ['X-2'] });
    await expect(mergeItems(ctx, { fromId: a.id, toId: b.id })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await itemRow(a.id)).isActive).toBe(true);
    expect((await verifySiteInvariants(ctx)).allOk).toBe(true);
    // Distinct serials merge fine.
    const c = await invItem('Serial dup C', { trackingMode: 'serial' });
    await adjustQuantityAtSite(ctx, { itemId: c.id, quantityChange: '1', unitCost: '5.00', date: d('2026-01-02'), serialNumbers: ['X-9'] });
    await mergeItems(ctx, { fromId: c.id, toId: b.id });
    expect((await verifySiteInvariants(ctx)).allOk).toBe(true);
  });

  it('Transactions by Serial/Lot Number names checks and vendor credits (label and number)', async () => {
    const v = await createVendor(ctx, { displayName: 'Lot supplier' } as never);
    const lot = await invItem('Lot glue', { trackingMode: 'lot' });
    const chk = await createExpense(ctx, {
      vendorId: v.id,
      date: d('2026-01-02'),
      method: 'check',
      reference: '1001',
      paymentAccountId: acct['1000'],
      lines: [{ itemId: lot.id, quantity: '5', unitCost: '2.00', lotNumber: 'G-1' }],
    } as never);
    expect(chk).toBeTruthy();
    const rows = (await transactionsBySerialLot(ctx, { lotNumber: 'G-1' })).rows;
    expect(rows.map((r) => [r.sourceLabel, r.sourceNumber])).toEqual([['Check', '1001']]);
  });
});
