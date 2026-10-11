/**
 * Advanced Inventory (team inventory) — sites, bins, transfers, serial/lot tracking, barcodes,
 * per-site reorder points, builds at a site and the invariants that must always hold:
 *   - Σ site quantities == quantity on hand
 *   - inventory asset GL == inventory valuation
 *   - every value change posts balanced entries (trial balance stays balanced)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, customers, vendors, items, journalEntries } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { createInvoice, updateInvoice, voidInvoice, postDraftInvoice, getInvoice } from './invoices';
import { createBill, voidBill } from './bills';
import { createItemReceipt, voidItemReceipt } from './itemReceipts';
import { createSalesReceipt, voidSalesReceipt } from './salesReceipts';
import { createCreditMemo, voidCreditMemo } from './creditMemos';
import { createItem, updateItem, findItemByBarcode } from './items';
import { setBom, buildAssembly } from './assemblies';
import { physicalCount } from './inventoryOps';
import {
  createBin,
  createSite,
  ensureDefaultSite,
  listSites,
  quantityAtSite,
  binQuantities,
  setDefaultSite,
  siteQuantities,
  updateSite,
} from './inventorySites';
import { createInventoryTransfer, voidInventoryTransfer, listInventoryTransfers } from './inventoryTransfers';
import { adjustQuantityAtSite, setSiteReorderPoint } from './inventorySiteOps';
import {
  quantityOnHandBySite,
  reorderBySite,
  serialLotInStock,
  stockStatusBySite,
  transactionsBySerialLot,
  verifySiteInvariants,
} from './inventorySiteReports';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-inventory-sites');

let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
let customerId: string;
let vendorId: string;
let mainId: string; // default site
let eastId: string;
let westId: string;
let eastBinA: string;
let eastBinB: string;

async function qty(itemId: string): Promise<string> {
  const [row] = await db.select().from(items).where(eq(items.id, itemId));
  return row.quantityOnHand ?? '0';
}

async function siteQty(itemId: string, siteId: string): Promise<string> {
  return (await quantityAtSite(ctx, itemId, siteId)).toFixed(4);
}

async function seedItem(vals: Record<string, unknown>): Promise<string> {
  const [row] = await db
    .insert(items)
    .values({ companyId: ctx.companyId, type: 'inventory', quantityOnHand: '0', averageCost: '0', incomeAccountId: acct['4000'], ...vals } as never)
    .returning();
  return row.id;
}

async function assertInvariants() {
  const tb = await trialBalance(ctx);
  expect(tb.balanced).toBe(true);
  const inv = await verifySiteInvariants(ctx);
  const failed = inv.checks.filter((c) => !c.ok);
  expect(failed).toEqual([]);
  // Σ sites == QOH for every item, checked directly too.
  const all = await siteQuantities(ctx);
  const rows = await db.select().from(items).where(and(eq(items.companyId, ctx.companyId), eq(items.type, 'inventory')));
  for (const it of rows) {
    let total = 0;
    for (const q of (all.get(it.id) ?? new Map()).values()) total += Number(q.toFixed(4));
    expect(total.toFixed(4)).toBe(Number(it.quantityOnHand ?? 0).toFixed(4));
  }
}

describe('Advanced Inventory: sites, bins, transfers, serial/lot, barcodes', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'inv@sites.test', name: 'Inv', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Sites Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };

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
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }
    const [cust] = await db.insert(customers).values({ companyId: company.id, displayName: 'Acme' }).returning();
    customerId = cust.id;
    const [vend] = await db.insert(vendors).values({ companyId: company.id, displayName: 'Supplier' }).returning();
    vendorId = vend.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  it('creates a default site lazily and manages sites and bins', async () => {
    const def = await ensureDefaultSite(ctx);
    expect(def.isDefault).toBe(true);
    mainId = def.id;
    const east = await createSite(ctx, { name: 'East Warehouse', code: 'E' });
    const west = await createSite(ctx, { name: 'West Store' });
    eastId = east.id;
    westId = west.id;
    expect(east.isDefault).toBe(false);
    await expect(createSite(ctx, { name: 'east warehouse' })).rejects.toMatchObject({ code: 'VALIDATION' });

    eastBinA = (await createBin(ctx, { siteId: eastId, name: 'A-01' })).id;
    eastBinB = (await createBin(ctx, { siteId: eastId, name: 'B-01' })).id;
    await expect(createBin(ctx, { siteId: eastId, name: 'a-01' })).rejects.toMatchObject({ code: 'VALIDATION' });

    const sites = await listSites(ctx);
    expect(sites.map((s) => s.name)).toEqual(['Main Warehouse', 'East Warehouse', 'West Store']);
    await expect(updateSite(ctx, mainId, { isActive: false })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  // -------------------------------------------------------------------------
  describe('per-site quantities on every inventory document', () => {
    let widget: string; // average-cost item

    it('bills and item receipts receive into the chosen site/bin; un-sited lines land on the default site', async () => {
      widget = await seedItem({ name: 'Widget', salesPrice: '25.00' });
      await createBill(ctx, {
        vendorId,
        billNumber: 'B-1',
        date: new Date('2026-01-05'),
        lines: [
          { itemId: widget, quantity: 10, unitCost: 10, siteId: eastId, binId: eastBinA },
          { itemId: widget, quantity: 4, unitCost: 10 },
        ],
      });
      await createItemReceipt(ctx, {
        vendorId,
        date: new Date('2026-01-06'),
        lines: [{ itemId: widget, quantity: 6, unitCost: 10, siteId: westId }],
      });
      expect(await qty(widget)).toBe('20.0000');
      expect(await siteQty(widget, eastId)).toBe('10.0000');
      expect(await siteQty(widget, westId)).toBe('6.0000');
      expect(await siteQty(widget, mainId)).toBe('4.0000');
      await assertInvariants();
    });

    it('invoices and sales receipts relieve stock from the chosen site; shortages at a site are refused', async () => {
      // Main only has 4 — selling 5 un-sited must fail even though the company has 20.
      await expect(
        createInvoice(ctx, { customerId, date: new Date('2026-01-10'), lines: [{ itemId: widget, quantity: 5, rate: 25 }] }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await qty(widget)).toBe('20.0000'); // rolled back

      const inv = await createInvoice(ctx, {
        customerId,
        date: new Date('2026-01-10'),
        lines: [{ itemId: widget, quantity: 3, rate: 25, siteId: eastId, binId: eastBinA }],
      });
      expect(await siteQty(widget, eastId)).toBe('7.0000');
      const full = await getInvoice(ctx, inv.id);
      expect((full.lines[0] as { siteId?: string }).siteId).toBe(eastId);

      await createSalesReceipt(ctx, {
        date: new Date('2026-01-11'),
        lines: [{ itemId: widget, quantity: 2, rate: 25, siteId: westId }],
      });
      expect(await siteQty(widget, westId)).toBe('4.0000');
      await expect(
        createSalesReceipt(ctx, { date: new Date('2026-01-11'), lines: [{ itemId: widget, quantity: 5, rate: 25, siteId: westId }] }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await assertInvariants();

      // Editing the invoice without site fields keeps it at East (carry-forward).
      await updateInvoice(ctx, inv.id, {
        customerId,
        date: new Date('2026-01-10'),
        lines: [{ itemId: widget, quantity: 4, rate: 25 }],
      });
      expect(await siteQty(widget, eastId)).toBe('6.0000');
      expect(await siteQty(widget, mainId)).toBe('4.0000');

      // Voiding puts the stock back at East.
      await voidInvoice(ctx, inv.id);
      expect(await siteQty(widget, eastId)).toBe('10.0000');
      await assertInvariants();
    });

    it('credit memos restock into a site; void pulls the units back out', async () => {
      const cm = await createCreditMemo(ctx, {
        customerId,
        date: new Date('2026-01-12'),
        lines: [{ itemId: widget, quantity: 1, rate: 25, siteId: westId }],
      });
      expect(await siteQty(widget, westId)).toBe('5.0000');
      await voidCreditMemo(ctx, cm.id);
      expect(await siteQty(widget, westId)).toBe('4.0000');
      await assertInvariants();
    });

    it('draft invoices keep their site and relieve it when posted', async () => {
      const draft = await createInvoice(ctx, {
        customerId,
        date: new Date('2026-01-13'),
        status: 'draft',
        lines: [{ itemId: widget, quantity: 2, rate: 25, siteId: westId }],
      });
      expect(await siteQty(widget, westId)).toBe('4.0000');
      await postDraftInvoice(ctx, draft.id);
      expect(await siteQty(widget, westId)).toBe('2.0000');
      await assertInvariants();
    });

    it('transfers move stock between sites/bins with no GL impact, and can be voided', async () => {
      const entriesBefore = await db.select().from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId));
      const tbBefore = await trialBalance(ctx);
      const t = await createInventoryTransfer(ctx, {
        date: new Date('2026-01-14'),
        fromSiteId: eastId,
        toSiteId: westId,
        lines: [{ itemId: widget, quantity: 3, fromBinId: eastBinA }],
      });
      expect(t.transferNumber).toBe(1);
      expect(await siteQty(widget, eastId)).toBe('7.0000');
      expect(await siteQty(widget, westId)).toBe('5.0000');
      expect(await qty(widget)).toBe('16.0000');
      const entriesAfter = await db.select().from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId));
      expect(entriesAfter.length).toBe(entriesBefore.length);
      expect((await trialBalance(ctx)).totalDebit).toBe(tbBefore.totalDebit);

      // Moving more than the source holds fails; so does the same site twice.
      await expect(
        createInventoryTransfer(ctx, { date: new Date('2026-01-14'), fromSiteId: mainId, toSiteId: westId, lines: [{ itemId: widget, quantity: 99 }] }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(
        createInventoryTransfer(ctx, { date: new Date('2026-01-14'), fromSiteId: westId, toSiteId: westId, lines: [{ itemId: widget, quantity: 1 }] }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });

      // Bin-level: B-01 is empty.
      await expect(
        createInventoryTransfer(ctx, { date: new Date('2026-01-14'), fromSiteId: eastId, toSiteId: westId, lines: [{ itemId: widget, quantity: 1, fromBinId: eastBinB }] }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });

      await voidInventoryTransfer(ctx, t.id);
      expect(await siteQty(widget, eastId)).toBe('10.0000');
      expect(await siteQty(widget, westId)).toBe('2.0000');
      const list = await listInventoryTransfers(ctx);
      expect(list[0].status).toBe('void');

      // Default site participates too (remainder model).
      await createInventoryTransfer(ctx, { date: new Date('2026-01-15'), fromSiteId: mainId, toSiteId: westId, lines: [{ itemId: widget, quantity: 4 }] });
      expect(await siteQty(widget, mainId)).toBe('0.0000');
      expect(await siteQty(widget, westId)).toBe('6.0000');
      await assertInvariants();
    });

    it('site adjustments post balanced entries and tag the site', async () => {
      await adjustQuantityAtSite(ctx, { itemId: widget, quantityChange: 5, unitCost: 10, date: new Date('2026-01-16'), siteId: eastId, binId: eastBinB });
      expect(await siteQty(widget, eastId)).toBe('15.0000');
      await adjustQuantityAtSite(ctx, { itemId: widget, quantityChange: -1, date: new Date('2026-01-16'), siteId: eastId, binId: eastBinB });
      expect(await siteQty(widget, eastId)).toBe('14.0000');
      await assertInvariants();
    });

    it('whole-company physical counts cannot count away stock held at other sites', async () => {
      // Main holds 0; East/West hold 20. Counting the company to 10 would need main = -10.
      await expect(physicalCount(ctx, { itemId: widget, countedQty: 10, date: new Date('2026-01-17') })).rejects.toMatchObject({ code: 'CONFLICT' });
      await physicalCount(ctx, { itemId: widget, countedQty: 22, date: new Date('2026-01-17') });
      expect(await siteQty(widget, mainId)).toBe('2.0000');
      await assertInvariants();
    });

    it('changing the default site never moves quantities', async () => {
      const before = await siteQuantities(ctx, [widget]);
      await setDefaultSite(ctx, westId);
      const after = await siteQuantities(ctx, [widget]);
      for (const s of [mainId, eastId, westId]) {
        expect(after.get(widget)?.get(s)?.toFixed(4) ?? '0.0000').toBe(before.get(widget)?.get(s)?.toFixed(4) ?? '0.0000');
      }
      await setDefaultSite(ctx, mainId);
      const back = await siteQuantities(ctx, [widget]);
      for (const s of [mainId, eastId, westId]) {
        expect(back.get(widget)?.get(s)?.toFixed(4) ?? '0.0000').toBe(before.get(widget)?.get(s)?.toFixed(4) ?? '0.0000');
      }
      // A site holding stock cannot be deactivated.
      await expect(updateSite(ctx, eastId, { isActive: false })).rejects.toMatchObject({ code: 'CONFLICT' });
      await assertInvariants();
    });

    it('reports Quantity on Hand / Stock Status / Reorder by site with per-site reorder points', async () => {
      await setSiteReorderPoint(ctx, { itemId: widget, siteId: westId, reorderPoint: 10, maxQuantity: 30 });
      const qoh = await quantityOnHandBySite(ctx);
      const row = qoh.rows.find((r) => r.itemId === widget)!;
      expect(row.bySite[eastId]).toBe('14.0000');
      expect(row.totalQuantity).toBe(await qty(widget));
      expect(row.bins.find((b) => b.binId === eastBinA)?.quantity).toBe('10.0000');

      const status = await stockStatusBySite(ctx, { siteId: westId });
      const w = status.rows.find((r) => r.itemId === widget)!;
      expect(w.onHand).toBe('6.0000');
      expect(w.needsReorder).toBe(true);
      expect(w.suggestedOrder).toBe('24.0000'); // up to max 30
      const reorder = await reorderBySite(ctx);
      expect(reorder.rows.map((r) => r.siteId)).toEqual([westId]);
    });

    it('assemblies build at a site: components drawn from it, finished goods land in it', async () => {
      const assembly = await seedItem({ name: 'Widget Kit' });
      await setBom(ctx, assembly, [{ componentItemId: widget, quantity: 2 }]);
      await expect(buildAssembly(ctx, { assemblyItemId: assembly, quantity: 4, siteId: westId })).rejects.toMatchObject({ code: 'CONFLICT' });
      await buildAssembly(ctx, { assemblyItemId: assembly, quantity: 3, siteId: westId });
      expect(await siteQty(widget, westId)).toBe('0.0000');
      expect(await siteQty(assembly, westId)).toBe('3.0000');
      await assertInvariants();
    });
  });

  // -------------------------------------------------------------------------
  describe('serial numbers', () => {
    let phone: string;

    it('requires one unique serial per unit on receipt and rejects duplicates', async () => {
      const created = await createItem(ctx, { name: 'Phone', type: 'inventory', trackingMode: 'serial', incomeAccountId: acct['4000'] });
      phone = created.id;
      await expect(
        createItemReceipt(ctx, { vendorId, date: new Date('2026-02-01'), lines: [{ itemId: phone, quantity: 2, unitCost: 100, serialNumbers: ['SN1'] }] }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      await createItemReceipt(ctx, {
        vendorId,
        date: new Date('2026-02-01'),
        lines: [{ itemId: phone, quantity: 3, unitCost: 100, siteId: eastId, binId: eastBinA, serialNumbers: ['SN1', 'SN2', 'SN3'] }],
      });
      await expect(
        createItemReceipt(ctx, { vendorId, date: new Date('2026-02-02'), lines: [{ itemId: phone, quantity: 1, unitCost: 100, serialNumbers: ['SN2'] }] }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(
        createBill(ctx, { vendorId, date: new Date('2026-02-02'), lines: [{ itemId: phone, quantity: 2, unitCost: 100, serialNumbers: ['SN9', 'SN9'] }] }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      expect(await qty(phone)).toBe('3.0000');
      await assertInvariants();
    });

    it('cannot sell a serial that is not on hand at the site', async () => {
      await expect(
        createInvoice(ctx, { customerId, date: new Date('2026-02-03'), lines: [{ itemId: phone, quantity: 1, rate: 300, siteId: eastId, serialNumbers: ['SN404'] }] }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(
        createInvoice(ctx, { customerId, date: new Date('2026-02-03'), lines: [{ itemId: phone, quantity: 1, rate: 300, siteId: westId, serialNumbers: ['SN1'] }] }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(
        createInvoice(ctx, { customerId, date: new Date('2026-02-03'), lines: [{ itemId: phone, quantity: 1, rate: 300, siteId: eastId }] }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });

      const inv = await createInvoice(ctx, {
        customerId,
        date: new Date('2026-02-03'),
        lines: [{ itemId: phone, quantity: 1, rate: 300, siteId: eastId, serialNumbers: ['SN1'] }],
      });
      // Already sold — selling it again is refused.
      await expect(
        createSalesReceipt(ctx, { date: new Date('2026-02-04'), lines: [{ itemId: phone, quantity: 1, rate: 300, siteId: eastId, serialNumbers: ['SN1'] }] }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });

      // Transfer SN2 to West, sell it there via a sales receipt, then void it back.
      await createInventoryTransfer(ctx, { date: new Date('2026-02-05'), fromSiteId: eastId, toSiteId: westId, lines: [{ itemId: phone, quantity: 1, serialNumbers: ['SN2'] }] });
      const sr = await createSalesReceipt(ctx, { date: new Date('2026-02-06'), lines: [{ itemId: phone, quantity: 1, rate: 300, siteId: westId, serialNumbers: ['SN2'] }] });
      await voidSalesReceipt(ctx, sr.id);

      const stock = await serialLotInStock(ctx, { itemId: phone });
      expect(stock.serials.map((s) => [s.serialNumber, s.siteId]).sort()).toEqual([
        ['SN2', westId],
        ['SN3', eastId],
      ]);
      expect(stock.serials.find((s) => s.serialNumber === 'SN3')?.binId).toBe(eastBinA);

      // Customer returns SN1 to West.
      await createCreditMemo(ctx, { customerId, date: new Date('2026-02-07'), lines: [{ itemId: phone, quantity: 1, rate: 300, siteId: westId, serialNumbers: ['SN1'] }] });
      const history = await transactionsBySerialLot(ctx, { serialNumber: 'SN1' });
      expect(history.rows.map((r) => r.sourceType)).toEqual(['item_receipt', 'invoice', 'credit_memo']);
      expect(history.rows[1].sourceNumber).toBe(String(inv.invoiceNumber));
      await assertInvariants();
    });

    it('a receipt whose serial was sold cannot be voided; tracking mode is locked while stock exists', async () => {
      const r = await createItemReceipt(ctx, {
        vendorId,
        date: new Date('2026-02-08'),
        lines: [{ itemId: phone, quantity: 1, unitCost: 100, siteId: westId, serialNumbers: ['SN7'] }],
      });
      await createInvoice(ctx, { customerId, date: new Date('2026-02-09'), lines: [{ itemId: phone, quantity: 1, rate: 300, siteId: westId, serialNumbers: ['SN7'] }] });
      await expect(voidItemReceipt(ctx, r.id)).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(updateItem(ctx, phone, { trackingMode: 'none' })).rejects.toMatchObject({ code: 'VALIDATION' });
      await assertInvariants();
    });

    it('site adjustments capture serials', async () => {
      await adjustQuantityAtSite(ctx, { itemId: phone, quantityChange: -1, date: new Date('2026-02-10'), siteId: eastId, serialNumbers: ['SN3'] });
      await expect(
        adjustQuantityAtSite(ctx, { itemId: phone, quantityChange: -1, date: new Date('2026-02-10'), siteId: eastId, serialNumbers: ['SN3'] }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await assertInvariants();
    });
  });

  // -------------------------------------------------------------------------
  describe('lot numbers', () => {
    let syrup: string;

    it('tracks lots with expiration and prevents over-selling a lot', async () => {
      syrup = (await createItem(ctx, { name: 'Syrup', type: 'inventory', trackingMode: 'lot', incomeAccountId: acct['4000'] })).id;
      await createBill(ctx, {
        vendorId,
        date: new Date('2026-03-01'),
        lines: [
          { itemId: syrup, quantity: 10, unitCost: 2, lotNumber: 'L-100', lotExpiration: new Date('2026-12-31') },
          { itemId: syrup, quantity: 5, unitCost: 2, lotNumber: 'L-200', siteId: eastId },
        ],
      });
      await expect(
        createInvoice(ctx, { customerId, date: new Date('2026-03-02'), lines: [{ itemId: syrup, quantity: 1, rate: 5 }] }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(
        createInvoice(ctx, { customerId, date: new Date('2026-03-02'), lines: [{ itemId: syrup, quantity: 11, rate: 5, lotNumber: 'L-100' }] }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await createInvoice(ctx, { customerId, date: new Date('2026-03-02'), lines: [{ itemId: syrup, quantity: 4, rate: 5, lotNumber: 'L-100' }] });

      const stock = await serialLotInStock(ctx, { itemId: syrup });
      const l100 = stock.lots.find((l) => l.lotNumber === 'L-100')!;
      expect(l100.quantity).toBe('6.0000');
      expect(l100.siteId).toBe(mainId);
      expect(l100.expirationDate?.toISOString().slice(0, 10)).toBe('2026-12-31');
      expect(stock.lots.find((l) => l.lotNumber === 'L-200')?.siteId).toBe(eastId);

      const history = await transactionsBySerialLot(ctx, { lotNumber: 'L-100' });
      expect(history.rows.map((r) => r.quantity)).toEqual(['10.0000', '-4.0000']);
      await assertInvariants();
    });

    it('rejects serial/lot detail on untracked items', async () => {
      const plain = await seedItem({ name: 'Plain' });
      await expect(
        createBill(ctx, { vendorId, date: new Date('2026-03-03'), lines: [{ itemId: plain, quantity: 1, unitCost: 1, lotNumber: 'X' }] }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    });
  });

  // -------------------------------------------------------------------------
  describe('barcodes', () => {
    it('are unique per company and resolve scans (SKU fallback)', async () => {
      const a = await createItem(ctx, { name: 'Scanner Gun', type: 'non_inventory', barcode: '0123456789012', sku: 'SG-1' });
      await expect(createItem(ctx, { name: 'Other', barcode: '0123456789012' })).rejects.toMatchObject({ code: 'VALIDATION' });
      const b = await createItem(ctx, { name: 'Cable', sku: 'CBL-9' });
      await expect(updateItem(ctx, b.id, { barcode: '0123456789012' })).rejects.toMatchObject({ code: 'VALIDATION' });
      expect((await findItemByBarcode(ctx, ' 0123456789012 '))?.id).toBe(a.id);
      expect((await findItemByBarcode(ctx, 'cbl-9'))?.id).toBe(b.id);
      expect(await findItemByBarcode(ctx, 'nope')).toBeNull();
      await expect(createItem(ctx, { name: 'Svc', type: 'service', trackingMode: 'serial' })).rejects.toMatchObject({ code: 'VALIDATION' });
    });
  });

  it('un-binned removals take unbinned stock first, then bins (default and other sites)', async () => {
    const bolt = await seedItem({ name: 'Bolt' });
    const mainBin = (await createBin(ctx, { siteId: mainId, name: 'M-01' })).id;
    await createBill(ctx, {
      vendorId,
      date: new Date('2026-04-10'),
      lines: [
        { itemId: bolt, quantity: 4, unitCost: 1, binId: mainBin },
        { itemId: bolt, quantity: 6, unitCost: 1 },
        { itemId: bolt, quantity: 5, unitCost: 1, siteId: eastId, binId: eastBinA },
        { itemId: bolt, quantity: 5, unitCost: 1, siteId: eastId },
      ],
    });
    const binQty = async (binId: string) =>
      (await binQuantities(ctx, { itemIds: [bolt] })).find((b) => b.binId === binId)?.quantity ?? '0';

    // Default site: 6 unbinned + 4 in M-01; selling 8 leaves 2 in the bin.
    await createInvoice(ctx, { customerId, date: new Date('2026-04-11'), lines: [{ itemId: bolt, quantity: 8, rate: 2 }] });
    expect(await binQty(mainBin)).toBe('2.0000');
    // East: 5 unbinned + 5 in A-01; selling 7 there leaves 3 in the bin.
    await createInvoice(ctx, { customerId, date: new Date('2026-04-11'), lines: [{ itemId: bolt, quantity: 7, rate: 2, siteId: eastId }] });
    expect(await binQty(eastBinA)).toBe('3.0000');
    // Transfer out of the default site (now only bin stock) draws from the bin.
    await createInventoryTransfer(ctx, { date: new Date('2026-04-12'), fromSiteId: mainId, toSiteId: westId, lines: [{ itemId: bolt, quantity: 1 }] });
    expect(await binQty(mainBin)).toBe('1.0000');
    expect(await siteQty(bolt, mainId)).toBe('1.0000');
    await assertInvariants();
  });

  it('a voided bill takes its stock back out of the receiving site', async () => {
    const gizmo = await seedItem({ name: 'Gizmo' });
    const bill = await createBill(ctx, { vendorId, date: new Date('2026-04-01'), lines: [{ itemId: gizmo, quantity: 5, unitCost: 3, siteId: eastId }] });
    await createInventoryTransfer(ctx, { date: new Date('2026-04-02'), fromSiteId: eastId, toSiteId: westId, lines: [{ itemId: gizmo, quantity: 5 }] });
    // The units have left East — un-receiving them there is refused.
    await expect(voidBill(ctx, bill.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await createInventoryTransfer(ctx, { date: new Date('2026-04-03'), fromSiteId: westId, toSiteId: eastId, lines: [{ itemId: gizmo, quantity: 5 }] });
    await voidBill(ctx, bill.id);
    expect(await qty(gizmo)).toBe('0.0000');
    expect(await siteQty(gizmo, eastId)).toBe('0.0000');
    await assertInvariants();
  });
});
