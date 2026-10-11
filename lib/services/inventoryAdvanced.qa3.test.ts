/**
 * Advanced Inventory — independent QA, re-test round 2.
 *
 * Verifies the round-2 landed-cost fix (a void restores a FIFO layer together with the one-unit
 * layers later allocations split off it) against orderings and neighbours the doer's tests do not
 * cover: interleaved allocate/void, re-allocation after a void, two lines of one item on a single
 * receipt (splits made inside the same allocation), sales that touch only the older layer,
 * transfers between sites (no layer movement), receipt void after stacked splits, and idempotent
 * double voids. Every step checks inventory GL == valuation, TB balance and site invariants.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, customers, vendors, items, accounts, journalEntries, inventoryLayers } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { createInvoice } from './invoices';
import { createBill, getBill } from './bills';
import { createItemReceipt, voidItemReceipt } from './itemReceipts';
import { receiveStock } from './fifo';
import { inventoryValuation } from './inventory';
import { createSite, ensureDefaultSite, quantityAtSite } from './inventorySites';
import { createInventoryTransfer } from './inventoryTransfers';
import { verifySiteInvariants } from './inventorySiteReports';
import { allocateLandedCost, getLandedCostAllocation, voidLandedCostAllocation } from './landedCost';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-inventory-advanced-qa3');

let db: DB;

interface Co {
  ctx: ServiceContext;
  acct: Record<string, string>;
  customerId: string;
  vendorId: string;
  mainId: string;
  eastId: string;
}

let A: Co;

async function setupCompany(name: string, email: string): Promise<Co> {
  const [user] = await db.insert(users).values({ email, name, passwordHash: 'x' }).returning();
  const [company] = await db.insert(companies).values({ name, ownerId: user.id }).returning();
  const ctx: ServiceContext = { db, companyId: company.id, userId: user.id };
  const acct: Record<string, string> = {};
  const defs: Array<[string, string, string, string]> = [
    ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
    ['1300', 'Inventory Asset', 'asset', 'inventory'],
    ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
    ['2200', 'Sales Tax Payable', 'liability', 'long_term_liability'],
    ['3000', "Owner's Equity", 'equity', 'owners_equity'],
    ['4000', 'Sales Income', 'revenue', 'sales'],
    ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
    ['6100', 'Freight In', 'expense', 'operating_expenses'],
  ];
  for (const [code, n, type, subtype] of defs) {
    acct[code] = (await createAccount(ctx, { code, name: n, type: type as never, subtype })).id;
  }
  const customerId = (await db.insert(customers).values({ companyId: company.id, displayName: 'Cust' }).returning())[0].id;
  const vendorId = (await db.insert(vendors).values({ companyId: company.id, displayName: 'Vend' }).returning())[0].id;
  const mainId = (await ensureDefaultSite(ctx)).id;
  const eastId = (await createSite(ctx, { name: 'East' })).id;
  return { ctx, acct, customerId, vendorId, mainId, eastId };
}

async function seedItem(co: Co, name: string): Promise<string> {
  const [row] = await db
    .insert(items)
    .values({
      companyId: co.ctx.companyId,
      name,
      type: 'inventory',
      quantityOnHand: '0',
      averageCost: '0',
      incomeAccountId: co.acct['4000'],
    } as never)
    .returning();
  return row.id;
}

async function balance(co: Co, code: string): Promise<string> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, co.acct[code]));
  return row.balance;
}

async function entryCount(co: Co): Promise<number> {
  return (await db.select().from(journalEntries).where(eq(journalEntries.companyId, co.ctx.companyId))).length;
}

async function layersOf(itemId: string) {
  return db.select().from(inventoryLayers).where(eq(inventoryLayers.itemId, itemId));
}

async function layerQty(itemId: string) {
  return (await layersOf(itemId)).reduce((s, l) => s.plus(Money.of(l.quantityRemaining)), Money.zero()).toFixed(4);
}

async function assertBooksTie(co: Co) {
  expect((await trialBalance(co.ctx)).balanced).toBe(true);
  const val = await inventoryValuation(co.ctx);
  expect(await balance(co, '1300')).toBe(val.grandTotal);
  const inv = await verifySiteInvariants(co.ctx);
  expect(inv.checks.filter((c) => !c.ok)).toEqual([]);
}

async function freightBill(co: Co, amount: number, billNumber: string) {
  const bill = await createBill(co.ctx, {
    vendorId: co.vendorId,
    billNumber,
    date: new Date('2026-06-02'),
    lines: [{ accountId: co.acct['6100'], description: 'Freight', amount }],
  });
  const full = await getBill(co.ctx, bill.id);
  return { billId: bill.id, lineId: full.lines[0].id };
}

describe('Advanced Inventory — QA re-test round 2 (stacked landed-cost voids)', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
  });

  let seq = 0;
  beforeEach(async () => {
    seq += 1;
    A = await setupCompany(`QA3 Co ${seq}`, `qa3-${seq}@inv.test`);
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  /** FIFO item with a 1 @ 2.50 opening layer (dated before the receipt) and a receipt of `qty`. */
  async function fifoReceipt(name: string, lines: number[] = [1200], cost = 2.5) {
    const item = await seedItem(A, name);
    await receiveStock(A.ctx, { itemId: item, quantity: 1, unitCost: cost, date: new Date('2026-05-01') });
    const receipt = await createItemReceipt(A.ctx, {
      vendorId: A.vendorId,
      date: new Date('2026-06-01'),
      lines: lines.map((q) => ({ itemId: item, quantity: q, unitCost: cost })),
    });
    return { item, receipt };
  }

  async function alloc(receiptId: string, amount: number, no: string) {
    const f = await freightBill(A, amount, no);
    return allocateLandedCost(A.ctx, { billId: f.billId, billLineId: f.lineId, method: 'quantity', itemReceiptIds: [receiptId] });
  }

  it('interleaved allocate / void / allocate / void restores every layer to the original cost', async () => {
    const { item, receipt } = await fifoReceipt('QA3 Interleave');
    const a1 = await alloc(receipt.id, 250, 'I-1');
    const a2 = await alloc(receipt.id, 251, 'I-2');
    await voidLandedCostAllocation(A.ctx, a1.id);
    await assertBooksTie(A);
    // a3 splits the parent layer again AFTER a1 was voided; a2's family now includes a3's split.
    const a3 = await alloc(receipt.id, 253, 'I-3');
    await assertBooksTie(A);
    await voidLandedCostAllocation(A.ctx, a2.id);
    await assertBooksTie(A);
    await voidLandedCostAllocation(A.ctx, a3.id);
    await assertBooksTie(A);
    for (const l of await layersOf(item)) expect(l.unitCost).toBe('2.5000');
    expect(await layerQty(item)).toBe('1201.0000');
    expect(await balance(A, '1300')).toBe('3002.50');
    expect(await balance(A, '6100')).toBe('754.00');
  });

  it('re-allocating after a void and voiding again in FIFO order ties exactly', async () => {
    const { item, receipt } = await fifoReceipt('QA3 Realloc');
    const a1 = await alloc(receipt.id, 250, 'R-1');
    await voidLandedCostAllocation(A.ctx, a1.id);
    const a2 = await alloc(receipt.id, 250, 'R-2');
    const a3 = await alloc(receipt.id, 250, 'R-3');
    await voidLandedCostAllocation(A.ctx, a2.id);
    await assertBooksTie(A);
    await voidLandedCostAllocation(A.ctx, a3.id);
    await assertBooksTie(A);
    for (const l of await layersOf(item)) expect(l.unitCost).toBe('2.5000');
    expect(await balance(A, '1300')).toBe('3002.50');
  });

  it('two lines of one item on a single receipt (splits inside one allocation) void cleanly in any order', async () => {
    const { item, receipt } = await fifoReceipt('QA3 Two lines', [700, 500]);
    const a1 = await alloc(receipt.id, 250, 'TL-1');
    const a2 = await alloc(receipt.id, 333.33, 'TL-2');
    await assertBooksTie(A);
    expect(await layerQty(item)).toBe('1201.0000');
    await voidLandedCostAllocation(A.ctx, a1.id);
    await assertBooksTie(A);
    await voidLandedCostAllocation(A.ctx, a2.id);
    await assertBooksTie(A);
    for (const l of await layersOf(item)) expect(l.unitCost).toBe('2.5000');
    expect(await balance(A, '1300')).toBe('3002.50');
    expect(await balance(A, '6100')).toBe('583.33');
  });

  it('a sale that consumes only the older opening layer does not block voiding stacked allocations', async () => {
    const { item, receipt } = await fifoReceipt('QA3 Sell opening layer');
    const a1 = await alloc(receipt.id, 250, 'SO-1');
    const a2 = await alloc(receipt.id, 250, 'SO-2');
    // FIFO: the single 2026-05-01 unit goes first; the receipt layers are untouched.
    await createInvoice(A.ctx, { customerId: A.customerId, date: new Date('2026-06-10'), lines: [{ itemId: item, quantity: 1, rate: 5 }] });
    await assertBooksTie(A);
    await voidLandedCostAllocation(A.ctx, a1.id);
    await assertBooksTie(A);
    await voidLandedCostAllocation(A.ctx, a2.id);
    await assertBooksTie(A);
    expect(await balance(A, '1300')).toBe('3000.00');
    expect(await balance(A, '5000')).toBe('2.50');
  });

  it('a site transfer (no layer movement) does not block voiding stacked allocations', async () => {
    const { item, receipt } = await fifoReceipt('QA3 Transfer');
    const a1 = await alloc(receipt.id, 250, 'TR-1');
    const a2 = await alloc(receipt.id, 250, 'TR-2');
    const glBefore = await balance(A, '1300');
    await createInventoryTransfer(A.ctx, {
      date: new Date('2026-06-05'),
      fromSiteId: A.mainId,
      toSiteId: A.eastId,
      lines: [{ itemId: item, quantity: 600 }],
    });
    expect(await balance(A, '1300')).toBe(glBefore);
    expect((await quantityAtSite(A.ctx, item, A.eastId)).toFixed(4)).toBe('600.0000');
    await voidLandedCostAllocation(A.ctx, a1.id);
    await voidLandedCostAllocation(A.ctx, a2.id);
    await assertBooksTie(A);
    expect(await balance(A, '1300')).toBe('3002.50');
  });

  it('after voiding stacked allocations the receipt void removes every split layer', async () => {
    const { item, receipt } = await fifoReceipt('QA3 Receipt void');
    const a1 = await alloc(receipt.id, 250, 'RV-1');
    const a2 = await alloc(receipt.id, 250, 'RV-2');
    const a3 = await alloc(receipt.id, 250, 'RV-3');
    await voidLandedCostAllocation(A.ctx, a2.id);
    await voidLandedCostAllocation(A.ctx, a1.id);
    await voidLandedCostAllocation(A.ctx, a3.id);
    await voidItemReceipt(A.ctx, receipt.id);
    expect(await layerQty(item)).toBe('1.0000');
    const [row] = await db.select().from(items).where(eq(items.id, item));
    expect(row.quantityOnHand).toBe('1.0000');
    await assertBooksTie(A);
    expect(await balance(A, '1300')).toBe('2.50');
  });

  it('voiding a stacked allocation twice is idempotent (no extra entries, costs not backed out twice)', async () => {
    const { item, receipt } = await fifoReceipt('QA3 Double void');
    const a1 = await alloc(receipt.id, 250, 'DV-1');
    await alloc(receipt.id, 250, 'DV-2');
    await voidLandedCostAllocation(A.ctx, a1.id);
    const n = await entryCount(A);
    const costs = (await layersOf(item)).map((l) => `${l.id}:${l.unitCost}`).sort();
    await voidLandedCostAllocation(A.ctx, a1.id);
    expect(await entryCount(A)).toBe(n);
    expect((await layersOf(item)).map((l) => `${l.id}:${l.unitCost}`).sort()).toEqual(costs);
    expect((await getLandedCostAllocation(A.ctx, a1.id)).status).toBe('void');
    await assertBooksTie(A);
    expect(await balance(A, '1300')).toBe('3252.50');
  });

  it('selling one receipt unit after stacked allocations blocks BOTH voids and changes nothing', async () => {
    const { item, receipt } = await fifoReceipt('QA3 Sell receipt unit');
    const a1 = await alloc(receipt.id, 250, 'SR-1');
    const a2 = await alloc(receipt.id, 250, 'SR-2');
    await createInvoice(A.ctx, { customerId: A.customerId, date: new Date('2026-06-10'), lines: [{ itemId: item, quantity: 2, rate: 5 }] });
    const n = await entryCount(A);
    const costs = (await layersOf(item)).map((l) => `${l.id}:${l.unitCost}:${l.quantityRemaining}`).sort();
    await expect(voidLandedCostAllocation(A.ctx, a2.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(voidLandedCostAllocation(A.ctx, a1.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await entryCount(A)).toBe(n);
    expect((await layersOf(item)).map((l) => `${l.id}:${l.unitCost}:${l.quantityRemaining}`).sort()).toEqual(costs);
    expect((await getLandedCostAllocation(A.ctx, a1.id)).status).not.toBe('void');
    await assertBooksTie(A);
  });
});
