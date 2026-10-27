/**
 * Advanced Inventory — independent QA, re-test round 1.
 *
 * Verifies the round-1 fixes go far enough and do not regress neighbouring behaviour:
 *   - landed cost: the FIFO layer split used for exact capitalisation must not block voids
 *     (stacked allocations on one receipt, LIFO and out-of-order), fractional layers, and
 *     downstream receipt voids / sales after the split
 *   - landed cost: Infinity / NaN / exponent amounts are VALIDATION errors
 *   - transfers: closing-date password override and closed fiscal periods; schema/service
 *     agreement on the 4dp quantity floor
 *   - batch physical count: atomic on unexpected errors, skips CONFLICT regardless of order
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
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
  inventoryLayers,
  fiscalPeriods,
} from '@/lib/db/schema';
import { Money } from '@/lib/money';
import { createInventoryTransferSchema } from '@/lib/validation/inventorySites';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { createInvoice } from './invoices';
import { createBill, getBill } from './bills';
import { createItemReceipt, voidItemReceipt } from './itemReceipts';
import { receiveStock } from './fifo';
import { inventoryValuation } from './inventory';
import { batchPhysicalCount } from './inventoryOps';
import { createSite, ensureDefaultSite, quantityAtSite } from './inventorySites';
import { createInventoryTransfer, voidInventoryTransfer } from './inventoryTransfers';
import { adjustQuantityAtSite } from './inventorySiteOps';
import { verifySiteInvariants } from './inventorySiteReports';
import { allocateLandedCost, getLandedCostAllocation, voidLandedCostAllocation } from './landedCost';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-inventory-advanced-qa2');

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

async function setClosingDate(co: Co, closingDate: string | null) {
  const [c] = await db.select().from(companies).where(eq(companies.id, co.ctx.companyId));
  const settings = { ...((c.settings as Record<string, unknown>) ?? {}) };
  if (closingDate) settings.closingDate = closingDate;
  else delete settings.closingDate;
  await db.update(companies).set({ settings: settings as never }).where(eq(companies.id, co.ctx.companyId));
}

describe('Advanced Inventory — QA re-test round 1', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
  });

  let seq = 0;
  beforeEach(async () => {
    seq += 1;
    A = await setupCompany(`QA2 Co A${seq}`, `qa2-a${seq}@inv.test`);
    B = await setupCompany(`QA2 Co B${seq}`, `qa2-b${seq}@inv.test`);
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ===========================================================================
  // Landed cost — the FIFO layer split
  // ===========================================================================
  describe('landed cost after the exact-capitalisation fix', () => {
    async function fifoReceipt(name: string, qty: number | string, cost = 2.5) {
      const item = await seedItem(A, { name });
      // A prior layer makes the item FIFO-tracked.
      await receiveStock(A.ctx, { itemId: item, quantity: 1, unitCost: cost, date: new Date('2026-05-01') });
      const receipt = await createItemReceipt(A.ctx, {
        vendorId: A.vendorId,
        date: new Date('2026-06-01'),
        lines: [{ itemId: item, quantity: qty as number, unitCost: cost }],
      });
      return { item, receipt };
    }

    it('two allocations on one FIFO receipt can both be voided in LIFO order (no stock moved)', async () => {
      const { receipt } = await fifoReceipt('LC2 Stack LIFO', 1200);
      const f1 = await freightBill(A, 250, 'FRT-S1');
      const f2 = await freightBill(A, 250, 'FRT-S2');
      const a1 = await allocateLandedCost(A.ctx, { billId: f1.billId, billLineId: f1.lineId, method: 'quantity', itemReceiptIds: [receipt.id] });
      const a2 = await allocateLandedCost(A.ctx, { billId: f2.billId, billLineId: f2.lineId, method: 'quantity', itemReceiptIds: [receipt.id] });
      await assertBooksTie(A);
      await voidLandedCostAllocation(A.ctx, a2.id);
      await assertBooksTie(A);
      // Nothing has moved since a1 — it must still be reversible.
      await voidLandedCostAllocation(A.ctx, a1.id);
      await assertBooksTie(A);
      expect(await balance(A, '1300')).toBe('3002.50');
    });

    it('the earlier of two allocations on one FIFO receipt can be voided first (no stock moved)', async () => {
      const { receipt } = await fifoReceipt('LC2 Stack FIFO-order', 1200);
      const f1 = await freightBill(A, 250, 'FRT-O1');
      const f2 = await freightBill(A, 250, 'FRT-O2');
      const a1 = await allocateLandedCost(A.ctx, { billId: f1.billId, billLineId: f1.lineId, method: 'quantity', itemReceiptIds: [receipt.id] });
      await allocateLandedCost(A.ctx, { billId: f2.billId, billLineId: f2.lineId, method: 'quantity', itemReceiptIds: [receipt.id] });
      await voidLandedCostAllocation(A.ctx, a1.id);
      await assertBooksTie(A);
    });

    // Doer fix round 2: the void restores the layer AND the units later allocations split off it.
    it('three stacked allocations voided out of order restore every layer to its original cost', async () => {
      const { item, receipt } = await fifoReceipt('LC2 Stack x3', 1200);
      const allocs = [];
      for (const n of [1, 2, 3]) {
        const f = await freightBill(A, 250 + n, `FRT-X${n}`);
        allocs.push(await allocateLandedCost(A.ctx, { billId: f.billId, billLineId: f.lineId, method: 'quantity', itemReceiptIds: [receipt.id] }));
      }
      await assertBooksTie(A);
      for (const i of [0, 2, 1]) {
        await voidLandedCostAllocation(A.ctx, allocs[i].id);
        await assertBooksTie(A);
      }
      const layers = await db.select().from(inventoryLayers).where(eq(inventoryLayers.itemId, item));
      for (const l of layers) expect(l.unitCost).toBe('2.5000');
      expect(layers.reduce((s, l) => s.plus(Money.of(l.quantityRemaining)), Money.zero()).toFixed(4)).toBe('1201.0000');
      expect(await balance(A, '1300')).toBe('3002.50');
    });

    it('selling a unit after two stacked allocations still blocks voiding the earlier one', async () => {
      const { item, receipt } = await fifoReceipt('LC2 Stack then sell', 1200);
      const f1 = await freightBill(A, 250, 'FRT-M1');
      const f2 = await freightBill(A, 250, 'FRT-M2');
      const a1 = await allocateLandedCost(A.ctx, { billId: f1.billId, billLineId: f1.lineId, method: 'quantity', itemReceiptIds: [receipt.id] });
      await allocateLandedCost(A.ctx, { billId: f2.billId, billLineId: f2.lineId, method: 'quantity', itemReceiptIds: [receipt.id] });
      await createInvoice(A.ctx, { customerId: A.customerId, date: new Date('2026-06-10'), lines: [{ itemId: item, quantity: 2, rate: 5 }] });
      await expect(voidLandedCostAllocation(A.ctx, a1.id)).rejects.toMatchObject({ code: 'CONFLICT' });
      await assertBooksTie(A);
    });

    it('after a split allocation is voided, the item receipt itself can be voided and books tie', async () => {
      const { item, receipt } = await fifoReceipt('LC2 Split then void receipt', 1200);
      const f = await freightBill(A, 250, 'FRT-V');
      const a = await allocateLandedCost(A.ctx, { billId: f.billId, billLineId: f.lineId, method: 'quantity', itemReceiptIds: [receipt.id] });
      const layers = await db.select().from(inventoryLayers).where(eq(inventoryLayers.itemId, item));
      const qtySum = layers.reduce((s, l) => s.plus(Money.of(l.quantityRemaining)), Money.zero());
      expect(qtySum.toFixed(4)).toBe('1201.0000');
      await voidLandedCostAllocation(A.ctx, a.id);
      await voidItemReceipt(A.ctx, receipt.id);
      expect(await qoh(item)).toBe('1.0000');
      await assertBooksTie(A);
      expect(await balance(A, '1300')).toBe('2.50');
    });

    it('selling across the split layer after allocation keeps GL == valuation (FIFO consumption)', async () => {
      const { item, receipt } = await fifoReceipt('LC2 Split then sell', 1200);
      const f = await freightBill(A, 250, 'FRT-SELL');
      await allocateLandedCost(A.ctx, { billId: f.billId, billLineId: f.lineId, method: 'quantity', itemReceiptIds: [receipt.id] });
      await createInvoice(A.ctx, { customerId: A.customerId, date: new Date('2026-06-10'), lines: [{ itemId: item, quantity: 1201, rate: 5 }] });
      expect(await qoh(item)).toBe('0.0000');
      await assertBooksTie(A);
      expect(await balance(A, '1300')).toBe('0.00');
      // All of the cost (2.50 + 3000 + 250) went to COGS.
      expect(await balance(A, '5000')).toBe('3252.50');
    });

    it('a fractional FIFO layer that cannot carry the remainder still ties (remainder to COGS, balanced)', async () => {
      const { receipt } = await fifoReceipt('LC2 Fractional', '1199.5');
      const f = await freightBill(A, 250, 'FRT-FRAC');
      const a = await allocateLandedCost(A.ctx, { billId: f.billId, billLineId: f.lineId, method: 'quantity', itemReceiptIds: [receipt.id] });
      await assertBooksTie(A);
      const line = (await getLandedCostAllocation(A.ctx, a.id)).lines[0];
      expect(Money.of(line.inventoryAmount).plus(Money.of(line.cogsAmount)).toFixed(2)).toBe('250.00');
      await voidLandedCostAllocation(A.ctx, a.id);
      await assertBooksTie(A);
      expect(await balance(A, '6100')).toBe('250.00');
    });

    it('value-method allocation across a FIFO and an average item on two receipts ties to the cent', async () => {
      const x = await fifoReceipt('LC2 Multi X', 777, 3.33);
      const y = await seedItem(A, { name: 'LC2 Multi Y (avg)' });
      const ry = await createItemReceipt(A.ctx, { vendorId: A.vendorId, date: new Date('2026-06-01'), lines: [{ itemId: y, quantity: 3001, unitCost: 1.17 }] });
      const f = await freightBill(A, 99.99, 'FRT-MULTI');
      const a = await allocateLandedCost(A.ctx, { billId: f.billId, billLineId: f.lineId, method: 'value', itemReceiptIds: [x.receipt.id, ry.id] });
      await assertBooksTie(A);
      await voidLandedCostAllocation(A.ctx, a.id);
      await assertBooksTie(A);
    });

    it('Infinity / NaN / huge-exponent amounts are VALIDATION errors', async () => {
      const { receipt } = await fifoReceipt('LC2 Bad amounts', 10);
      const f = await freightBill(A, 60, 'FRT-BAD2');
      const base = { billId: f.billId, billLineId: f.lineId, method: 'quantity' as const, itemReceiptIds: [receipt.id] };
      const n = await entryCount(A);
      for (const amount of ['Infinity', '-Infinity', 'NaN', '1e400', ' ', '12,50']) {
        await expect(allocateLandedCost(A.ctx, { ...base, amount }), `amount=${JSON.stringify(amount)}`).rejects.toMatchObject({
          code: 'VALIDATION',
        });
      }
      expect(await entryCount(A)).toBe(n);
      await assertBooksTie(A);
    });
  });

  // ===========================================================================
  // Transfers
  // ===========================================================================
  describe('transfers after the fix', () => {
    it('a verified closing-date override (password) still allows a transfer in the closed period', async () => {
      const it1 = await seedItem(A, { name: 'TR2 Override' });
      await adjustQuantityAtSite(A.ctx, { itemId: it1, quantityChange: 4, unitCost: 1, date: new Date('2026-06-09'), siteId: A.eastId });
      await setClosingDate(A, '2026-06-30');
      const t = await createInventoryTransfer({ ...A.ctx, closingDateOverride: true }, {
        date: new Date('2026-06-15'),
        fromSiteId: A.eastId,
        toSiteId: A.westId,
        lines: [{ itemId: it1, quantity: 1 }],
      });
      expect(await siteQty(A, it1, A.westId)).toBe('1.0000');
      await expect(voidInventoryTransfer(A.ctx, t.id)).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
      await voidInventoryTransfer({ ...A.ctx, closingDateOverride: true }, t.id);
      expect(await siteQty(A, it1, A.westId)).toBe('0.0000');
      // After the closing date, transfers work normally.
      await createInventoryTransfer(A.ctx, { date: new Date('2026-07-01'), fromSiteId: A.eastId, toSiteId: A.westId, lines: [{ itemId: it1, quantity: 2 }] });
      await assertBooksTie(A);
    });

    it('a transfer inside a closed fiscal period is refused and leaves no trace', async () => {
      const it1 = await seedItem(A, { name: 'TR2 FP' });
      await adjustQuantityAtSite(A.ctx, { itemId: it1, quantityChange: 4, unitCost: 1, date: new Date('2026-05-09'), siteId: A.eastId });
      await db.insert(fiscalPeriods).values({
        companyId: A.ctx.companyId,
        periodStart: new Date('2026-06-01'),
        periodEnd: new Date('2026-06-30T23:59:59Z'),
        isClosed: true,
      });
      const count = async () =>
        (await db.select().from(inventoryTransfers).where(eq(inventoryTransfers.companyId, A.ctx.companyId))).length;
      const before = await count();
      await expect(
        createInventoryTransfer(A.ctx, { date: new Date('2026-06-15'), fromSiteId: A.eastId, toSiteId: A.westId, lines: [{ itemId: it1, quantity: 1 }] }),
      ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
      expect(await count()).toBe(before);
      expect(await siteQty(A, it1, A.eastId)).toBe('4.0000');
    });

    it('schema and service agree on the 4dp quantity floor', async () => {
      const it1 = await seedItem(A, { name: 'TR2 Floor' });
      await adjustQuantityAtSite(A.ctx, { itemId: it1, quantityChange: 4, unitCost: 1, date: new Date('2026-06-09'), siteId: A.eastId });
      const body = (quantity: string) => ({
        date: '2026-06-10',
        fromSiteId: A.eastId,
        toSiteId: A.westId,
        lines: [{ itemId: it1, quantity }],
      });
      expect(createInventoryTransferSchema.safeParse(body('0.00001')).success).toBe(false);
      expect(createInventoryTransferSchema.safeParse(body('0.00004')).success).toBe(false);
      expect(createInventoryTransferSchema.safeParse(body('0.0001')).success).toBe(true);
      // Nothing that rounds to zero (or is not a number) may reach the books.
      const base = { date: new Date('2026-06-10'), fromSiteId: A.eastId, toSiteId: A.westId };
      for (const q of ['0.00004', '0.000049', 'abc', '-0.0001', 'Infinity', 'NaN']) {
        await expect(
          createInventoryTransfer(A.ctx, { ...base, lines: [{ itemId: it1, quantity: q as never }] }),
          `quantity=${q}`,
        ).rejects.toMatchObject({ code: 'VALIDATION' });
      }
      await createInventoryTransfer(A.ctx, { ...base, lines: [{ itemId: it1, quantity: '0.00005' as never }] });
      const movements = await db.select().from(inventoryMovements).where(eq(inventoryMovements.companyId, A.ctx.companyId));
      expect(movements.every((m) => !Money.of(m.quantity).isZero())).toBe(true);
      expect(await siteQty(A, it1, A.westId)).toBe('0.0001');
      await assertBooksTie(A);
    });
  });

  // ===========================================================================
  // Batch physical count atomicity
  // ===========================================================================
  describe('batch physical count after the fix', () => {
    it('a blocked item listed FIRST is skipped and later items still apply', async () => {
      const ok = await seedItem(A, { name: 'B2 OK' });
      const blocked = await seedItem(A, { name: 'B2 Blocked' });
      await adjustQuantityAtSite(A.ctx, { itemId: ok, quantityChange: 2, unitCost: 1, date: new Date('2026-06-16') });
      await adjustQuantityAtSite(A.ctx, { itemId: blocked, quantityChange: 5, unitCost: 1, date: new Date('2026-06-16'), siteId: A.eastId });
      const result = await batchPhysicalCount(A.ctx, {
        date: new Date('2026-06-16'),
        counts: [
          { itemId: blocked, countedQty: 0 },
          { itemId: ok, countedQty: 7 },
        ],
      });
      expect(result.skipped.map((s) => s.itemId)).toEqual([blocked]);
      expect(result.applied.map((r) => r.itemId)).toEqual([ok]);
      expect(await qoh(ok)).toBe('7.0000');
      expect(await qoh(blocked)).toBe('5.0000');
      await assertBooksTie(A);
    });

    it('an unexpected (non-ServiceError) failure rolls back items already counted in the batch', async () => {
      const ok = await seedItem(A, { name: 'B2 Rollback OK' });
      const other = await seedItem(A, { name: 'B2 Rollback Other' });
      await adjustQuantityAtSite(A.ctx, { itemId: ok, quantityChange: 2, unitCost: 1, date: new Date('2026-06-16') });
      await adjustQuantityAtSite(A.ctx, { itemId: other, quantityChange: 2, unitCost: 1, date: new Date('2026-06-16') });
      const n = await entryCount(A);
      // The second item's journal entry fails with a plain Error (a database crash, say). A count
      // that is merely not a number is a per-item VALIDATION skip since review round 5, so the
      // failure is injected at the database layer instead.
      let posted = 0;
      const failing = (db0: unknown): unknown =>
        new Proxy(db0 as object, {
          get(target, prop, receiver) {
            const v = Reflect.get(target, prop, receiver);
            if (prop === 'transaction') {
              return (fn: (t: unknown) => Promise<unknown>) =>
                (v as (f: (t: unknown) => Promise<unknown>) => Promise<unknown>).call(target, (t) => fn(failing(t)));
            }
            if (prop === 'insert') {
              return (table: unknown) => {
                if (table === journalEntries && ++posted === 2) throw new Error('simulated database failure');
                return (v as (t: unknown) => unknown).call(target, table);
              };
            }
            return typeof v === 'function' ? v.bind(target) : v;
          },
        });
      await expect(
        batchPhysicalCount({ ...A.ctx, db: failing(A.ctx.db) as typeof A.ctx.db }, {
          date: new Date('2026-06-16'),
          counts: [
            { itemId: ok, countedQty: 9 },
            { itemId: other, countedQty: 5 },
          ],
        }),
      ).rejects.toThrow(/simulated database failure/);
      expect(posted).toBe(2);
      expect(await qoh(ok)).toBe('2.0000');
      expect(await entryCount(A)).toBe(n);
      await assertBooksTie(A);
    });

    it('a count that is not a number is skipped with a plain reason (no HTTP 500)', async () => {
      const ok = await seedItem(A, { name: 'B2 Typo OK' });
      const typo = await seedItem(A, { name: 'B2 Typo' });
      await adjustQuantityAtSite(A.ctx, { itemId: ok, quantityChange: 2, unitCost: 1, date: new Date('2026-06-16') });
      await adjustQuantityAtSite(A.ctx, { itemId: typo, quantityChange: 2, unitCost: 1, date: new Date('2026-06-16') });
      const res = await batchPhysicalCount(A.ctx, {
        date: new Date('2026-06-16'),
        counts: [
          { itemId: ok, countedQty: 3 },
          { itemId: typo, countedQty: 'not-a-number' },
        ],
      });
      expect(res.applied.map((a) => a.itemId)).toEqual([ok]);
      expect(res.skipped).toEqual([{ itemId: typo, reason: expect.stringMatching(/must be a number/) }]);
      expect(await qoh(typo)).toBe('2.0000');
      await assertBooksTie(A);
    });

    it("another company's item id is skipped (NOT_FOUND) without touching that company", async () => {
      const mine = await seedItem(A, { name: 'B2 Mine' });
      const theirs = await seedItem(B, { name: 'B2 Theirs' });
      await adjustQuantityAtSite(A.ctx, { itemId: mine, quantityChange: 2, unitCost: 1, date: new Date('2026-06-16') });
      await adjustQuantityAtSite(B.ctx, { itemId: theirs, quantityChange: 3, unitCost: 1, date: new Date('2026-06-16') });
      const result = await batchPhysicalCount(A.ctx, {
        date: new Date('2026-06-16'),
        counts: [
          { itemId: theirs, countedQty: 0 },
          { itemId: mine, countedQty: 1 },
        ],
      });
      expect(result.skipped.map((s) => s.itemId)).toEqual([theirs]);
      expect(await qoh(theirs)).toBe('3.0000');
      expect(await qoh(mine)).toBe('1.0000');
      await assertBooksTie(A);
      await assertBooksTie(B);
    });

    it('viewers cannot run a batch count', async () => {
      const it1 = await seedItem(A, { name: 'B2 Viewer' });
      const viewer: ServiceContext = { ...A.ctx, role: 'viewer' };
      await expect(
        batchPhysicalCount(viewer, { date: new Date('2026-06-16'), counts: [{ itemId: it1, countedQty: 1 }] }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await qoh(it1)).toBe('0.0000');
    });
  });
});
