/**
 * Advanced Inventory — independent QA (tester) suite.
 *
 * Adversarial coverage the implementation's own tests do not exercise:
 *   - landed-cost rounding (inventory GL must still equal valuation for large quantities)
 *   - over-allocation / idempotent voids / malformed amounts
 *   - RBAC (viewer contexts) and cross-company id injection (sites, bins, bills)
 *   - transfer edge cases (duplicate serials, lots, inactive sites, rollback, tiny quantities)
 *   - serial/bin mismatches, duplicate serials across lines
 *   - rollback of costing when the site movement is refused
 *   - closing-date protection on transfers
 *   - batch physical counts vs site guards (atomicity)
 *   - negative-inventory sequences vs the site invariants self-check
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  customers,
  vendors,
  items,
  accounts,
  journalEntries,
  inventoryTransfers,
  inventoryMovements,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { createInvoice } from './invoices';
import { createBill, getBill, updateBill } from './bills';
import { createItemReceipt } from './itemReceipts';
import { createSalesReceipt } from './salesReceipts';
import { createItem, findItemByBarcode } from './items';
import { receiveStock } from './fifo';
import { inventoryValuation } from './inventory';
import { batchPhysicalCount } from './inventoryOps';
import {
  createBin,
  createSite,
  ensureDefaultSite,
  quantityAtSite,
  setDefaultSite,
  updateBin,
  updateSite,
} from './inventorySites';
import { createInventoryTransfer, voidInventoryTransfer } from './inventoryTransfers';
import { adjustQuantityAtSite, setSiteReorderPoint } from './inventorySiteOps';
import { verifySiteInvariants, serialLotInStock } from './inventorySiteReports';
import { allocateLandedCost, voidLandedCostAllocation } from './landedCost';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-inventory-advanced-qa');

let db: DB;

interface Co {
  ctx: ServiceContext;
  acct: Record<string, string>;
  customerId: string;
  vendorId: string;
  mainId: string;
  eastId: string;
  westId: string;
}

let A: Co;
let B: Co;

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
  const westId = (await createSite(ctx, { name: 'West' })).id;
  return { ctx, acct, customerId, vendorId, mainId, eastId, westId };
}

async function seedItem(co: Co, vals: Record<string, unknown>): Promise<string> {
  const [row] = await db
    .insert(items)
    .values({
      companyId: co.ctx.companyId,
      type: 'inventory',
      quantityOnHand: '0',
      averageCost: '0',
      incomeAccountId: co.acct['4000'],
      ...vals,
    } as never)
    .returning();
  return row.id;
}

async function qoh(itemId: string): Promise<string> {
  const [row] = await db.select().from(items).where(eq(items.id, itemId));
  return row.quantityOnHand ?? '0';
}

async function siteQty(co: Co, itemId: string, siteId: string) {
  return (await quantityAtSite(co.ctx, itemId, siteId)).toFixed(4);
}

async function balance(co: Co, code: string): Promise<string> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, co.acct[code]));
  return row.balance;
}

async function entryCount(co: Co): Promise<number> {
  return (await db.select().from(journalEntries).where(eq(journalEntries.companyId, co.ctx.companyId))).length;
}

/** Inventory GL == valuation (to the cent), TB balanced, all site self-checks pass. */
async function assertBooksTie(co: Co) {
  expect((await trialBalance(co.ctx)).balanced).toBe(true);
  const val = await inventoryValuation(co.ctx);
  expect(await balance(co, '1300')).toBe(val.grandTotal);
  const inv = await verifySiteInvariants(co.ctx);
  expect(inv.checks.filter((c) => !c.ok)).toEqual([]);
}

describe('Advanced Inventory — QA adversarial suite', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
  });

  // Every test gets two fresh companies so one failure (e.g. a GL/valuation drift) cannot
  // cascade into the books-tie assertions of later tests.
  let seq = 0;
  beforeEach(async () => {
    seq += 1;
    A = await setupCompany(`QA Co A${seq}`, `qa-a${seq}@inv.test`);
    B = await setupCompany(`QA Co B${seq}`, `qa-b${seq}@inv.test`);
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ===========================================================================
  // Landed cost
  // ===========================================================================
  describe('landed cost', () => {
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

    it('FIFO: a charge spread over many units keeps inventory GL == valuation (unit-cost rounding)', async () => {
      // 1,200 units, $250 freight → $0.208333/unit. Layer unit cost is stored at 4dp; the
      // capitalised value must still equal the GL debit to the cent.
      const fifoItem = await seedItem(A, { name: 'LC FIFO Bulk' });
      await receiveStock(A.ctx, { itemId: fifoItem, quantity: 1, unitCost: 2.5, date: new Date('2026-06-01') });
      const receipt = await createItemReceipt(A.ctx, {
        vendorId: A.vendorId,
        date: new Date('2026-06-01'),
        lines: [{ itemId: fifoItem, quantity: 1200, unitCost: 2.5 }],
      });
      await assertBooksTie(A);
      const { billId, lineId } = await freightBill(A, 250, 'FRT-FIFO');
      await allocateLandedCost(A.ctx, { billId, billLineId: lineId, method: 'quantity', itemReceiptIds: [receipt.id] });
      await assertBooksTie(A);
    });

    it('average cost: a charge spread over many units keeps inventory GL == valuation (avg-cost rounding)', async () => {
      // 3,000 units @ $10, $10 freight → avg 10.003333…; stored at 4dp the pool is worth
      // 30,009.90 while the GL was debited 30,010.00.
      const avgItem = await seedItem(A, { name: 'LC AVG Bulk' });
      const receipt = await createItemReceipt(A.ctx, {
        vendorId: A.vendorId,
        date: new Date('2026-06-01'),
        lines: [{ itemId: avgItem, quantity: 3000, unitCost: 10 }],
      });
      await assertBooksTie(A);
      const { billId, lineId } = await freightBill(A, 10, 'FRT-AVG');
      await allocateLandedCost(A.ctx, { billId, billLineId: lineId, method: 'quantity', itemReceiptIds: [receipt.id] });
      await assertBooksTie(A);
    });

    it('partial allocations cannot exceed the charge; voids are idempotent; malformed amounts are refused', async () => {
      const it1 = await seedItem(A, { name: 'LC Partial' });
      const receipt = await createItemReceipt(A.ctx, {
        vendorId: A.vendorId,
        date: new Date('2026-06-01'),
        lines: [{ itemId: it1, quantity: 10, unitCost: 4 }],
      });
      const { billId, lineId } = await freightBill(A, 60, 'FRT-PART');
      const base = { billId, billLineId: lineId, method: 'quantity' as const, itemReceiptIds: [receipt.id] };

      const a1 = await allocateLandedCost(A.ctx, { ...base, amount: '25.00' });
      await allocateLandedCost(A.ctx, { ...base, amount: '35.00' });
      await expect(allocateLandedCost(A.ctx, { ...base, amount: '0.01' })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(allocateLandedCost(A.ctx, { ...base, amount: '-5' })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(
        allocateLandedCost(A.ctx, { ...base, method: 'bogus' as never }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(allocateLandedCost(A.ctx, { ...base, itemReceiptIds: [] })).rejects.toMatchObject({ code: 'VALIDATION' });
      await assertBooksTie(A);

      // Void one allocation; voiding it again is a no-op (no extra reversing entries).
      await voidLandedCostAllocation(A.ctx, a1.id);
      const n = await entryCount(A);
      const freight = await balance(A, '6100');
      const again = await voidLandedCostAllocation(A.ctx, a1.id);
      expect(again.status).toBe('void');
      expect(await entryCount(A)).toBe(n);
      expect(await balance(A, '6100')).toBe(freight);
      // The voided 25.00 is available again, but no more.
      await expect(allocateLandedCost(A.ctx, { ...base, amount: '25.01' })).rejects.toMatchObject({ code: 'VALIDATION' });
      await allocateLandedCost(A.ctx, { ...base, amount: '25.00' });
      await assertBooksTie(A);
    });

    it('a non-numeric amount is a VALIDATION error, not a raw DecimalError (500)', async () => {
      const it1 = await seedItem(A, { name: 'LC Malformed' });
      const receipt = await createItemReceipt(A.ctx, {
        vendorId: A.vendorId,
        date: new Date('2026-06-01'),
        lines: [{ itemId: it1, quantity: 10, unitCost: 4 }],
      });
      const { billId, lineId } = await freightBill(A, 60, 'FRT-BAD');
      await expect(
        allocateLandedCost(A.ctx, { billId, billLineId: lineId, method: 'quantity', itemReceiptIds: [receipt.id], amount: 'abc' }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    });

    it('rejects a bill, bill line or receipt that belongs to another company', async () => {
      const it1 = await seedItem(A, { name: 'LC Cross' });
      const receiptA = await createItemReceipt(A.ctx, {
        vendorId: A.vendorId,
        date: new Date('2026-06-01'),
        lines: [{ itemId: it1, quantity: 5, unitCost: 4 }],
      });
      const billA = await freightBill(A, 20, 'FRT-X');
      const itB = await seedItem(B, { name: 'LC Cross B' });
      const receiptB = await createItemReceipt(B.ctx, {
        vendorId: B.vendorId,
        date: new Date('2026-06-01'),
        lines: [{ itemId: itB, quantity: 5, unitCost: 4 }],
      });
      const billB = await freightBill(B, 20, 'FRT-XB');

      // B using A's bill.
      await expect(
        allocateLandedCost(B.ctx, { billId: billA.billId, billLineId: billA.lineId, method: 'quantity', itemReceiptIds: [receiptB.id] }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      // B's bill but A's receipt.
      await expect(
        allocateLandedCost(B.ctx, { billId: billB.billId, billLineId: billB.lineId, method: 'quantity', itemReceiptIds: [receiptA.id] }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      // B's bill with A's bill line id.
      await expect(
        allocateLandedCost(B.ctx, { billId: billB.billId, billLineId: billA.lineId, method: 'quantity', itemReceiptIds: [receiptB.id] }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await assertBooksTie(A);
      await assertBooksTie(B);
    });

    it('viewers cannot allocate or void landed cost', async () => {
      const it1 = await seedItem(A, { name: 'LC Viewer' });
      const receipt = await createItemReceipt(A.ctx, {
        vendorId: A.vendorId,
        date: new Date('2026-06-01'),
        lines: [{ itemId: it1, quantity: 5, unitCost: 4 }],
      });
      const { billId, lineId } = await freightBill(A, 10, 'FRT-V');
      const viewer: ServiceContext = { ...A.ctx, role: 'viewer' };
      const n = await entryCount(A);
      await expect(
        allocateLandedCost(viewer, { billId, billLineId: lineId, method: 'quantity', itemReceiptIds: [receipt.id] }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await entryCount(A)).toBe(n);
      const alloc = await allocateLandedCost(A.ctx, { billId, billLineId: lineId, method: 'quantity', itemReceiptIds: [receipt.id] });
      await expect(voidLandedCostAllocation(viewer, alloc.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await assertBooksTie(A);
    });

    it('a bill edit cannot silently drop a charge line that has landed cost allocated', async () => {
      const it1 = await seedItem(A, { name: 'LC Edit' });
      const receipt = await createItemReceipt(A.ctx, {
        vendorId: A.vendorId,
        date: new Date('2026-06-01'),
        lines: [{ itemId: it1, quantity: 5, unitCost: 4 }],
      });
      const { billId, lineId } = await freightBill(A, 10, 'FRT-E');
      await allocateLandedCost(A.ctx, { billId, billLineId: lineId, method: 'quantity', itemReceiptIds: [receipt.id] });
      await expect(
        updateBill(A.ctx, billId, { vendorId: A.vendorId, date: new Date('2026-06-02'), lines: [{ accountId: A.acct['6100'], amount: 10 }] }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await assertBooksTie(A);
    });
  });

  // ===========================================================================
  // RBAC and tenancy
  // ===========================================================================
  describe('RBAC and cross-company ids', () => {
    it('viewers cannot create/modify sites, bins, transfers, adjustments or reorder points', async () => {
      const viewer: ServiceContext = { ...A.ctx, role: 'viewer' };
      const it1 = await seedItem(A, { name: 'RBAC Item' });
      await adjustQuantityAtSite(A.ctx, { itemId: it1, quantityChange: 5, unitCost: 1, date: new Date('2026-06-05'), siteId: A.eastId });
      const bin = await createBin(A.ctx, { siteId: A.eastId, name: 'RB-1' });

      await expect(createSite(viewer, { name: 'Viewer Site' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(updateSite(viewer, A.eastId, { name: 'Hacked' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(setDefaultSite(viewer, A.eastId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(createBin(viewer, { siteId: A.eastId, name: 'VB' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(updateBin(viewer, bin.id, { name: 'VB2' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        createInventoryTransfer(viewer, { date: new Date('2026-06-05'), fromSiteId: A.eastId, toSiteId: A.westId, lines: [{ itemId: it1, quantity: 1 }] }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        adjustQuantityAtSite(viewer, { itemId: it1, quantityChange: -1, date: new Date('2026-06-05'), siteId: A.eastId }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        setSiteReorderPoint(viewer, { itemId: it1, siteId: A.eastId, reorderPoint: 3 }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await siteQty(A, it1, A.eastId)).toBe('5.0000');
      await assertBooksTie(A);
    });

    it("refuses another company's site / bin ids on documents, transfers and adjustments", async () => {
      const it1 = await seedItem(A, { name: 'Tenancy Item' });
      await adjustQuantityAtSite(A.ctx, { itemId: it1, quantityChange: 5, unitCost: 2, date: new Date('2026-06-05') });
      const binB = await createBin(B.ctx, { siteId: B.eastId, name: 'B-BIN' });
      const n = await entryCount(A);

      await expect(
        createBill(A.ctx, { vendorId: A.vendorId, date: new Date('2026-06-05'), lines: [{ itemId: it1, quantity: 1, unitCost: 2, siteId: B.eastId }] }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        createBill(A.ctx, { vendorId: A.vendorId, date: new Date('2026-06-05'), lines: [{ itemId: it1, quantity: 1, unitCost: 2, binId: binB.id }] }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        createInvoice(A.ctx, { customerId: A.customerId, date: new Date('2026-06-05'), lines: [{ itemId: it1, quantity: 1, rate: 5, siteId: B.mainId }] }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        createInventoryTransfer(A.ctx, { date: new Date('2026-06-05'), fromSiteId: A.mainId, toSiteId: B.westId, lines: [{ itemId: it1, quantity: 1 }] }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        adjustQuantityAtSite(A.ctx, { itemId: it1, quantityChange: 1, unitCost: 2, date: new Date('2026-06-05'), siteId: B.eastId }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        adjustQuantityAtSite(A.ctx, { itemId: it1, quantityChange: 1, unitCost: 2, date: new Date('2026-06-05'), siteId: A.eastId, binId: binB.id }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      // B cannot transfer A's item.
      await expect(
        createInventoryTransfer(B.ctx, { date: new Date('2026-06-05'), fromSiteId: B.mainId, toSiteId: B.westId, lines: [{ itemId: it1, quantity: 1 }] }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      // Nothing posted, nothing moved.
      expect(await entryCount(A)).toBe(n);
      expect(await qoh(it1)).toBe('5.0000');
      await assertBooksTie(A);
      await assertBooksTie(B);
    });

    it('barcodes are unique per company only, blank barcodes never collide, and scans stay in-company', async () => {
      const a = await createItem(A.ctx, { name: 'BC A', type: 'non_inventory', barcode: '9990001112223' });
      const b = await createItem(B.ctx, { name: 'BC B', type: 'non_inventory', barcode: '9990001112223' });
      expect((await findItemByBarcode(A.ctx, '9990001112223'))?.id).toBe(a.id);
      expect((await findItemByBarcode(B.ctx, '9990001112223'))?.id).toBe(b.id);
      await createItem(A.ctx, { name: 'Blank 1', type: 'non_inventory', barcode: '' });
      await createItem(A.ctx, { name: 'Blank 2', type: 'non_inventory', barcode: '   ' });
      expect(await findItemByBarcode(A.ctx, '')).toBeNull();
      await expect(createItem(A.ctx, { name: 'Too long', type: 'non_inventory', barcode: 'x'.repeat(101) })).rejects.toMatchObject({
        code: 'VALIDATION',
      });
    });
  });

  // ===========================================================================
  // Transfers
  // ===========================================================================
  describe('transfers', () => {
    it('validation failures roll back completely and do not consume a transfer number', async () => {
      const it1 = await seedItem(A, { name: 'TR Rollback' });
      await adjustQuantityAtSite(A.ctx, { itemId: it1, quantityChange: 3, unitCost: 1, date: new Date('2026-06-06'), siteId: A.eastId });
      const before = await db.select().from(inventoryTransfers).where(eq(inventoryTransfers.companyId, A.ctx.companyId));
      const mvBefore = await db.select().from(inventoryMovements).where(eq(inventoryMovements.itemId, it1));

      // Line 1 ok, line 2 over-draws → whole transfer refused.
      await expect(
        createInventoryTransfer(A.ctx, {
          date: new Date('2026-06-06'),
          fromSiteId: A.eastId,
          toSiteId: A.westId,
          lines: [
            { itemId: it1, quantity: 2 },
            { itemId: it1, quantity: 2 },
          ],
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      const after = await db.select().from(inventoryTransfers).where(eq(inventoryTransfers.companyId, A.ctx.companyId));
      expect(after.length).toBe(before.length);
      const mvAfter = await db.select().from(inventoryMovements).where(eq(inventoryMovements.itemId, it1));
      expect(mvAfter.length).toBe(mvBefore.length);
      expect(await siteQty(A, it1, A.eastId)).toBe('3.0000');

      const t = await createInventoryTransfer(A.ctx, {
        date: new Date('2026-06-06'),
        fromSiteId: A.eastId,
        toSiteId: A.westId,
        lines: [{ itemId: it1, quantity: 3 }],
      });
      expect(t.transferNumber).toBe(before.length + 1);
      // Void is idempotent.
      await voidInventoryTransfer(A.ctx, t.id);
      await voidInventoryTransfer(A.ctx, t.id);
      expect(await siteQty(A, it1, A.eastId)).toBe('3.0000');
      expect(await siteQty(A, it1, A.westId)).toBe('0.0000');
      await assertBooksTie(A);
    });

    it('rejects non-positive, non-inventory, inactive-site and sub-precision quantities', async () => {
      const it1 = await seedItem(A, { name: 'TR Validate' });
      await adjustQuantityAtSite(A.ctx, { itemId: it1, quantityChange: 3, unitCost: 1, date: new Date('2026-06-06'), siteId: A.eastId });
      const svc = await createItem(A.ctx, { name: 'TR Service', type: 'service' });
      const t = (lines: Array<{ itemId: string; quantity: string | number }>, to = A.westId) =>
        createInventoryTransfer(A.ctx, { date: new Date('2026-06-06'), fromSiteId: A.eastId, toSiteId: to, lines });

      await expect(t([{ itemId: it1, quantity: 0 }])).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(t([{ itemId: it1, quantity: -1 }])).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(t([{ itemId: svc.id, quantity: 1 }])).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(t([])).rejects.toMatchObject({ code: 'VALIDATION' });

      const closed = await createSite(A.ctx, { name: 'Closed Store' });
      await updateSite(A.ctx, closed.id, { isActive: false });
      await expect(t([{ itemId: it1, quantity: 1 }], closed.id)).rejects.toMatchObject({ code: 'VALIDATION' });
      // An inactive site cannot become the default.
      await expect(setDefaultSite(A.ctx, closed.id)).rejects.toMatchObject({ code: 'VALIDATION' });
      expect(await siteQty(A, it1, A.eastId)).toBe('3.0000');
      await assertBooksTie(A);
    });

    it('a sub-precision quantity (rounds to 0.0000 at 4dp) does not create an empty transfer', async () => {
      const it1 = await seedItem(A, { name: 'TR Tiny' });
      await adjustQuantityAtSite(A.ctx, { itemId: it1, quantityChange: 3, unitCost: 1, date: new Date('2026-06-06'), siteId: A.eastId });
      await expect(
        createInventoryTransfer(A.ctx, {
          date: new Date('2026-06-06'),
          fromSiteId: A.eastId,
          toSiteId: A.westId,
          lines: [{ itemId: it1, quantity: '0.00001' }],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    });

    it('serial and lot transfers: duplicate serials across lines and over-drawn lots are refused', async () => {
      const phone = (await createItem(A.ctx, { name: 'TR Phone', type: 'inventory', trackingMode: 'serial', incomeAccountId: A.acct['4000'] })).id;
      await createItemReceipt(A.ctx, {
        vendorId: A.vendorId,
        date: new Date('2026-06-07'),
        lines: [{ itemId: phone, quantity: 2, unitCost: 50, siteId: A.eastId, serialNumbers: ['TP-1', 'TP-2'] }],
      });
      await expect(
        createInventoryTransfer(A.ctx, {
          date: new Date('2026-06-07'),
          fromSiteId: A.eastId,
          toSiteId: A.westId,
          lines: [
            { itemId: phone, quantity: 1, serialNumbers: ['TP-1'] },
            { itemId: phone, quantity: 1, serialNumbers: ['TP-1'] },
          ],
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      // Serial count must match the quantity on a transfer too.
      await expect(
        createInventoryTransfer(A.ctx, {
          date: new Date('2026-06-07'),
          fromSiteId: A.eastId,
          toSiteId: A.westId,
          lines: [{ itemId: phone, quantity: 2, serialNumbers: ['TP-1'] }],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      // Fractional serial quantities are refused.
      await expect(
        adjustQuantityAtSite(A.ctx, { itemId: phone, quantityChange: '0.5', unitCost: 1, date: new Date('2026-06-07'), siteId: A.eastId, serialNumbers: ['TP-9'] }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });

      const syrup = (await createItem(A.ctx, { name: 'TR Syrup', type: 'inventory', trackingMode: 'lot', incomeAccountId: A.acct['4000'] })).id;
      await createBill(A.ctx, {
        vendorId: A.vendorId,
        date: new Date('2026-06-07'),
        lines: [
          { itemId: syrup, quantity: 4, unitCost: 2, siteId: A.eastId, lotNumber: 'LOT-A' },
          { itemId: syrup, quantity: 6, unitCost: 2, siteId: A.eastId, lotNumber: 'LOT-B' },
        ],
      });
      // East holds 10 syrup, but only 4 of LOT-A.
      await expect(
        createInventoryTransfer(A.ctx, {
          date: new Date('2026-06-07'),
          fromSiteId: A.eastId,
          toSiteId: A.westId,
          lines: [{ itemId: syrup, quantity: 5, lotNumber: 'LOT-A' }],
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      // Lot-tracked transfer without a lot is refused.
      await expect(
        createInventoryTransfer(A.ctx, {
          date: new Date('2026-06-07'),
          fromSiteId: A.eastId,
          toSiteId: A.westId,
          lines: [{ itemId: syrup, quantity: 1 }],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      await createInventoryTransfer(A.ctx, {
        date: new Date('2026-06-07'),
        fromSiteId: A.eastId,
        toSiteId: A.westId,
        lines: [{ itemId: syrup, quantity: 4, lotNumber: 'LOT-A' }],
      });
      // LOT-A is now only at West: selling it from East is refused, from West is fine.
      await expect(
        createSalesReceipt(A.ctx, { date: new Date('2026-06-08'), lines: [{ itemId: syrup, quantity: 1, rate: 5, siteId: A.eastId, lotNumber: 'LOT-A' }] }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await createSalesReceipt(A.ctx, { date: new Date('2026-06-08'), lines: [{ itemId: syrup, quantity: 1, rate: 5, siteId: A.westId, lotNumber: 'LOT-A' }] });
      const stock = await serialLotInStock(A.ctx, { itemId: syrup });
      expect(stock.lots.find((l) => l.lotNumber === 'LOT-A')).toMatchObject({ siteId: A.westId, quantity: '3.0000' });
      await assertBooksTie(A);
    });

    it('transfers dated on/before the closing date are refused (QB closing-date parity)', async () => {
      const it1 = await seedItem(A, { name: 'TR Closed' });
      await adjustQuantityAtSite(A.ctx, { itemId: it1, quantityChange: 4, unitCost: 1, date: new Date('2026-06-09'), siteId: A.eastId });
      const t = await createInventoryTransfer(A.ctx, {
        date: new Date('2026-06-09'),
        fromSiteId: A.eastId,
        toSiteId: A.westId,
        lines: [{ itemId: it1, quantity: 1 }],
      });
      const [co] = await db.select().from(companies).where(eq(companies.id, A.ctx.companyId));
      await db
        .update(companies)
        .set({ settings: { ...(co.settings ?? {}), closingDate: '2026-06-30' } as never })
        .where(eq(companies.id, A.ctx.companyId));
      try {
        await expect(
          createInventoryTransfer(A.ctx, {
            date: new Date('2026-06-15'),
            fromSiteId: A.eastId,
            toSiteId: A.westId,
            lines: [{ itemId: it1, quantity: 1 }],
          }),
        ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
        await expect(voidInventoryTransfer(A.ctx, t.id)).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
      } finally {
        await db.update(companies).set({ settings: co.settings as never }).where(eq(companies.id, A.ctx.companyId));
      }
    });
  });

  // ===========================================================================
  // Serial numbers / bins
  // ===========================================================================
  describe('serial numbers and bins', () => {
    it('a serial cannot be received twice on two lines of the same document; serials are item-scoped', async () => {
      const cam = (await createItem(A.ctx, { name: 'SN Camera', type: 'inventory', trackingMode: 'serial', incomeAccountId: A.acct['4000'] })).id;
      const lens = (await createItem(A.ctx, { name: 'SN Lens', type: 'inventory', trackingMode: 'serial', incomeAccountId: A.acct['4000'] })).id;
      await expect(
        createItemReceipt(A.ctx, {
          vendorId: A.vendorId,
          date: new Date('2026-06-10'),
          lines: [
            { itemId: cam, quantity: 1, unitCost: 100, serialNumbers: ['DUP-1'] },
            { itemId: cam, quantity: 1, unitCost: 100, siteId: A.eastId, serialNumbers: ['DUP-1'] },
          ],
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await qoh(cam)).toBe('0.0000');

      await createItemReceipt(A.ctx, {
        vendorId: A.vendorId,
        date: new Date('2026-06-10'),
        lines: [{ itemId: cam, quantity: 1, unitCost: 100, siteId: A.eastId, serialNumbers: [' S-100 '] }],
      });
      // Whitespace-trimmed duplicate is still a duplicate.
      await expect(
        createItemReceipt(A.ctx, {
          vendorId: A.vendorId,
          date: new Date('2026-06-10'),
          lines: [{ itemId: cam, quantity: 1, unitCost: 100, serialNumbers: ['S-100'] }],
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      // The camera's serial cannot be sold as a lens.
      await createItemReceipt(A.ctx, {
        vendorId: A.vendorId,
        date: new Date('2026-06-10'),
        lines: [{ itemId: lens, quantity: 1, unitCost: 10, siteId: A.eastId, serialNumbers: ['L-1'] }],
      });
      await expect(
        createInvoice(A.ctx, { customerId: A.customerId, date: new Date('2026-06-11'), lines: [{ itemId: lens, quantity: 1, rate: 20, siteId: A.eastId, serialNumbers: ['S-100'] }] }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await assertBooksTie(A);
    });

    it('selling a serial from the wrong bin is refused; bins must belong to the line site; inactive bins are refused', async () => {
      const tab = (await createItem(A.ctx, { name: 'SN Tablet', type: 'inventory', trackingMode: 'serial', incomeAccountId: A.acct['4000'] })).id;
      const b1 = (await createBin(A.ctx, { siteId: A.eastId, name: 'SNB-1' })).id;
      const b2 = (await createBin(A.ctx, { siteId: A.eastId, name: 'SNB-2' })).id;
      const wb = (await createBin(A.ctx, { siteId: A.westId, name: 'SNW-1' })).id;
      await createItemReceipt(A.ctx, {
        vendorId: A.vendorId,
        date: new Date('2026-06-12'),
        lines: [{ itemId: tab, quantity: 1, unitCost: 80, siteId: A.eastId, binId: b1, serialNumbers: ['T-1'] }],
      });
      await expect(
        createInvoice(A.ctx, { customerId: A.customerId, date: new Date('2026-06-12'), lines: [{ itemId: tab, quantity: 1, rate: 99, siteId: A.eastId, binId: b2, serialNumbers: ['T-1'] }] }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(
        createInvoice(A.ctx, { customerId: A.customerId, date: new Date('2026-06-12'), lines: [{ itemId: tab, quantity: 1, rate: 99, siteId: A.eastId, binId: wb, serialNumbers: ['T-1'] }] }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });

      const plain = await seedItem(A, { name: 'Bin Plain' });
      const empty = (await createBin(A.ctx, { siteId: A.eastId, name: 'SNB-EMPTY' })).id;
      await updateBin(A.ctx, empty, { isActive: false });
      await expect(
        createBill(A.ctx, { vendorId: A.vendorId, date: new Date('2026-06-12'), lines: [{ itemId: plain, quantity: 1, unitCost: 1, siteId: A.eastId, binId: empty }] }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      // A bin holding stock cannot be deactivated.
      await expect(updateBin(A.ctx, b1, { isActive: false })).rejects.toMatchObject({ code: 'CONFLICT' });
      await assertBooksTie(A);
    });

    it('a refused serial movement rolls back the site adjustment costing (no orphan journal entry)', async () => {
      const dev = (await createItem(A.ctx, { name: 'SN Device', type: 'inventory', trackingMode: 'serial', incomeAccountId: A.acct['4000'] })).id;
      await adjustQuantityAtSite(A.ctx, { itemId: dev, quantityChange: 1, unitCost: 40, date: new Date('2026-06-13'), siteId: A.eastId, serialNumbers: ['D-1'] });
      const n = await entryCount(A);
      const inv = await balance(A, '1300');
      // Duplicate serial receipt → refused AFTER costing ran; the whole thing must roll back.
      await expect(
        adjustQuantityAtSite(A.ctx, { itemId: dev, quantityChange: 1, unitCost: 40, date: new Date('2026-06-13'), siteId: A.westId, serialNumbers: ['D-1'] }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      // Removing a serial that is not on hand.
      await expect(
        adjustQuantityAtSite(A.ctx, { itemId: dev, quantityChange: -1, date: new Date('2026-06-13'), siteId: A.eastId, serialNumbers: ['D-404'] }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await entryCount(A)).toBe(n);
      expect(await balance(A, '1300')).toBe(inv);
      expect(await qoh(dev)).toBe('1.0000');
      await assertBooksTie(A);
    });
  });

  // ===========================================================================
  // Documents / site invariants
  // ===========================================================================
  describe('document edits and whole-company operations', () => {
    it('editing a bill moves its receipt to the new site; a refused edit rolls back fully', async () => {
      const it1 = await seedItem(A, { name: 'Edit Bill Item' });
      const bill = await createBill(A.ctx, {
        vendorId: A.vendorId,
        date: new Date('2026-06-14'),
        lines: [{ itemId: it1, quantity: 5, unitCost: 3, siteId: A.eastId }],
      });
      await updateBill(A.ctx, bill.id, {
        vendorId: A.vendorId,
        date: new Date('2026-06-14'),
        lines: [{ itemId: it1, quantity: 5, unitCost: 3, siteId: A.westId }],
      });
      expect(await siteQty(A, it1, A.eastId)).toBe('0.0000');
      expect(await siteQty(A, it1, A.westId)).toBe('5.0000');

      // Sell 4 at West, then try to edit the bill down to 2 units — West would go negative.
      await createInvoice(A.ctx, { customerId: A.customerId, date: new Date('2026-06-15'), lines: [{ itemId: it1, quantity: 4, rate: 6, siteId: A.westId }] });
      const n = await entryCount(A);
      await expect(
        updateBill(A.ctx, bill.id, {
          vendorId: A.vendorId,
          date: new Date('2026-06-14'),
          lines: [{ itemId: it1, quantity: 2, unitCost: 3, siteId: A.westId }],
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await entryCount(A)).toBe(n);
      expect(await qoh(it1)).toBe('1.0000');
      expect(await siteQty(A, it1, A.westId)).toBe('1.0000');
      await assertBooksTie(A);
    });

    it('a batch physical count never half-applies when one item is blocked by the site guard', async () => {
      const ok = await seedItem(A, { name: 'Batch OK' });
      const blocked = await seedItem(A, { name: 'Batch Blocked' });
      await adjustQuantityAtSite(A.ctx, { itemId: ok, quantityChange: 2, unitCost: 1, date: new Date('2026-06-16') });
      await adjustQuantityAtSite(A.ctx, { itemId: blocked, quantityChange: 5, unitCost: 1, date: new Date('2026-06-16'), siteId: A.eastId });
      // Counting "blocked" to 0 company-wide would need the default site at −5.
      let threw = false;
      let result: Awaited<ReturnType<typeof batchPhysicalCount>> | null = null;
      try {
        result = await batchPhysicalCount(A.ctx, {
          date: new Date('2026-06-16'),
          counts: [
            { itemId: ok, countedQty: 7 },
            { itemId: blocked, countedQty: 0 },
          ],
        });
      } catch {
        threw = true;
      }
      if (threw) {
        // All-or-nothing: the first item must not have been counted.
        expect(await qoh(ok)).toBe('2.0000');
      } else {
        expect(result!.skipped.map((s) => s.itemId)).toContain(blocked);
        expect(await qoh(ok)).toBe('7.0000');
      }
      expect(await qoh(blocked)).toBe('5.0000');
      await assertBooksTie(A);
    });

    it('selling into negative at the default site, then receiving at another site, keeps the site self-check green', async () => {
      // Legacy single-site behaviour allows the default site to go negative while no other
      // site holds stock. A subsequent receipt at another site must not leave the company in a
      // state its own invariant report flags as broken.
      const co = B;
      const it1 = await seedItem(co, { name: 'Neg Default' });
      let sold = true;
      try {
        await createInvoice(co.ctx, { customerId: co.customerId, date: new Date('2026-06-17'), lines: [{ itemId: it1, quantity: 1, rate: 5 }] });
      } catch {
        sold = false; // negative inventory refused outright — nothing further to check
      }
      if (!sold) return;
      let received = true;
      try {
        await createBill(co.ctx, {
          vendorId: co.vendorId,
          date: new Date('2026-06-18'),
          lines: [{ itemId: it1, quantity: 5, unitCost: 2, siteId: co.eastId }],
        });
      } catch {
        received = false; // refused with a clear error is acceptable
      }
      if (received) {
        const inv = await verifySiteInvariants(co.ctx);
        expect(inv.checks.filter((c) => !c.ok)).toEqual([]);
      }
    });

    it('sum of site quantities equals QOH after a mixed sequence across every document type', async () => {
      const co = A;
      const it1 = await seedItem(co, { name: 'Mixed Seq' });
      const bin = (await createBin(co.ctx, { siteId: co.westId, name: 'MX-1' })).id;
      await createBill(co.ctx, { vendorId: co.vendorId, date: new Date('2026-06-20'), lines: [{ itemId: it1, quantity: 10, unitCost: 3, siteId: co.westId, binId: bin }] });
      await createItemReceipt(co.ctx, { vendorId: co.vendorId, date: new Date('2026-06-20'), lines: [{ itemId: it1, quantity: 4, unitCost: 3 }] });
      await createInventoryTransfer(co.ctx, { date: new Date('2026-06-21'), fromSiteId: co.westId, toSiteId: co.eastId, lines: [{ itemId: it1, quantity: 3, fromBinId: bin }] });
      await createSalesReceipt(co.ctx, { date: new Date('2026-06-21'), lines: [{ itemId: it1, quantity: 2, rate: 9, siteId: co.eastId }] });
      await createInvoice(co.ctx, { customerId: co.customerId, date: new Date('2026-06-22'), lines: [{ itemId: it1, quantity: 7, rate: 9, siteId: co.westId }] });
      await adjustQuantityAtSite(co.ctx, { itemId: it1, quantityChange: -1, date: new Date('2026-06-22') });
      await setDefaultSite(co.ctx, co.eastId);
      await adjustQuantityAtSite(co.ctx, { itemId: it1, quantityChange: 2, unitCost: 3, date: new Date('2026-06-22') });
      await setDefaultSite(co.ctx, co.mainId);

      const m = await siteQty(co, it1, co.mainId);
      const e = await siteQty(co, it1, co.eastId);
      const w = await siteQty(co, it1, co.westId);
      expect([m, e, w]).toEqual(['3.0000', '3.0000', '0.0000']);
      expect(await qoh(it1)).toBe('6.0000');
      // A fully consistent ledger: total movements of non-default sites match.
      const rows = await db
        .select()
        .from(inventoryMovements)
        .where(and(eq(inventoryMovements.itemId, it1), eq(inventoryMovements.siteId, co.westId)));
      expect(rows.reduce((s, r) => s + Number(r.quantity), 0)).toBe(0);
      await assertBooksTie(co);
    });
  });
});
