/**
 * Perpetual inventory + item-aware forms — end-to-end integration tests.
 *
 * Verifies the QB Desktop core inventory behaviors wired into invoices/bills:
 *  - A bill with an inventory item line posts Dr Inventory Asset / Cr A/P,
 *    increases quantityOnHand, and maintains the weighted average cost.
 *  - A bill line for a FIFO-tracked item creates a new cost layer.
 *  - An invoice selling an inventory item posts COGS (avg or FIFO layer cost),
 *    decrements quantityOnHand, and stays balanced.
 *  - voidInvoice reverses the COGS entry and restores stock (QOH + layers).
 *  - voidBill reverses the receipt (QOH, avg cost, layers) and is blocked when
 *    the received stock has already been consumed.
 *  - Class/job tags persist on invoice headers/lines and flow to GL lines.
 *  - Manual description-only lines and service-item bill lines still work.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  accounts,
  customers,
  vendors,
  items,
  classes,
  jobs,
  taxRates,
  invoiceLines,
  billLines,
  inventoryLayers,
  journalEntries,
  journalEntryLines,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { ServiceError } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { createInvoice, voidInvoice, listInvoices } from './invoices';
import { createBill, getBill, voidBill } from './bills';
import { receiveStock } from './fifo';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-perpetual-inventory');

let ctx: ServiceContext;
let db: DB;

const acct: Record<string, string> = {};
let customerId: string;
let vendorId: string;
let taxRateId: string;
let classId: string;
let jobId: string;

// Items under test
let widgetId: string; // average-cost inventory item
let gadgetId: string; // FIFO-tracked inventory item
let gizmoId: string; // FIFO-tracked inventory item (bill receipt test)
let consultingId: string; // service item (expense routing test)

/** Read the cached balance of an account by code. */
async function balanceOf(code: string): Promise<string> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, acct[code]));
  return row.balance;
}

/** Read quantityOnHand / averageCost for an item. */
async function itemState(id: string): Promise<{ qty: string; avg: string }> {
  const [row] = await db.select().from(items).where(eq(items.id, id));
  return { qty: row.quantityOnHand ?? '0', avg: row.averageCost ?? '0' };
}

describe('Perpetual inventory (invoices + bills)', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'owner@perpetual.test', name: 'Owner', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'Perpetual Test Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    const defs: Array<[string, string, string, string]> = [
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['1300', 'Inventory Asset', 'asset', 'inventory'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['2200', 'Sales Tax Payable', 'liability', 'long_term_liability'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
      ['6000', 'Outside Services', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }

    const [cust] = await db
      .insert(customers)
      .values({ companyId: company.id, displayName: 'Acme Corp', taxable: true })
      .returning();
    customerId = cust.id;

    const [vend] = await db
      .insert(vendors)
      .values({ companyId: company.id, displayName: 'Supplies Inc' })
      .returning();
    vendorId = vend.id;

    const [rate] = await db
      .insert(taxRates)
      .values({ companyId: company.id, name: 'Sales Tax 8.25%', rate: '0.082500' })
      .returning();
    taxRateId = rate.id;

    const [cls] = await db
      .insert(classes)
      .values({ companyId: company.id, name: 'Retail' })
      .returning();
    classId = cls.id;

    const [job] = await db
      .insert(jobs)
      .values({ companyId: company.id, customerId, name: 'Acme:Refit' })
      .returning();
    jobId = job.id;

    const seedItem = async (vals: Record<string, unknown>) => {
      const [row] = await db
        .insert(items)
        .values({ companyId: company.id, ...vals } as never)
        .returning();
      return row.id;
    };
    widgetId = await seedItem({
      name: 'Widget',
      type: 'inventory',
      salesPrice: '20.00',
      incomeAccountId: acct['4000'],
      quantityOnHand: '0',
      averageCost: '0',
    });
    gadgetId = await seedItem({
      name: 'Gadget',
      type: 'inventory',
      salesPrice: '30.00',
      quantityOnHand: '0',
      averageCost: '0',
    });
    gizmoId = await seedItem({
      name: 'Gizmo',
      type: 'inventory',
      quantityOnHand: '0',
      averageCost: '0',
    });
    consultingId = await seedItem({
      name: 'Consulting',
      type: 'service',
      expenseAccountId: acct['6000'],
      incomeAccountId: acct['4000'],
    });
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Bills receive stock (average cost)
  // -------------------------------------------------------------------------

  it('bill with an inventory item line posts Dr Inventory / Cr A/P and receives stock', async () => {
    const bill = await createBill(ctx, {
      vendorId,
      billNumber: 'B-100',
      date: new Date('2025-03-01'),
      lines: [{ itemId: widgetId, quantity: 10, unitCost: 8 }],
    });

    expect(bill.total).toBe('80.00');
    expect(await balanceOf('1300')).toBe('80.00');
    expect(await balanceOf('2000')).toBe('80.00');

    const state = await itemState(widgetId);
    expect(state.qty).toBe('10.0000');
    expect(state.avg).toBe('8.0000');

    // The stored line carries the item and the inventory asset account.
    const full = await getBill(ctx, bill.id);
    expect(full.lines).toHaveLength(1);
    expect(full.lines[0].itemId).toBe(widgetId);
    expect(full.lines[0].accountId).toBe(acct['1300']);
    expect(full.lines[0].quantity).toBe('10.0000');

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  let secondBillId: string;

  it('a second receipt updates the weighted average cost', async () => {
    const bill = await createBill(ctx, {
      vendorId,
      billNumber: 'B-101',
      date: new Date('2025-03-02'),
      lines: [{ itemId: widgetId, quantity: 10, unitCost: 10 }],
    });
    secondBillId = bill.id;

    const state = await itemState(widgetId);
    expect(state.qty).toBe('20.0000');
    expect(state.avg).toBe('9.0000'); // (10*8 + 10*10) / 20
    expect(await balanceOf('1300')).toBe('180.00');
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Invoices post COGS and relieve stock (average cost) + class/job tagging
  // -------------------------------------------------------------------------

  let avgInvoiceId: string;

  it('invoice selling an average-cost item posts COGS, decrements stock, and tags class/job', async () => {
    const invoice = await createInvoice(ctx, {
      customerId,
      date: new Date('2025-03-05'),
      taxRateId,
      classId,
      lines: [{ itemId: widgetId, quantity: 4, rate: 20, jobId }],
    });
    avgInvoiceId = invoice.id;

    // Revenue side: subtotal 80, tax 6.60, total 86.60.
    expect(invoice.subtotal).toBe('80.00');
    expect(invoice.taxAmount).toBe('6.60');
    expect(invoice.total).toBe('86.60');
    expect(invoice.classId).toBe(classId);

    // Inventory side: 4 units @ avg 9.00 = 36.00 COGS.
    const state = await itemState(widgetId);
    expect(state.qty).toBe('16.0000');
    expect(await balanceOf('5000')).toBe('36.00');
    expect(await balanceOf('1300')).toBe('144.00');
    expect(await balanceOf('4000')).toBe('80.00');

    // Line persists item + class + job.
    const lines = await db
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, invoice.id));
    expect(lines).toHaveLength(1);
    expect(lines[0].itemId).toBe(widgetId);
    expect(lines[0].classId).toBe(classId);
    expect(lines[0].jobId).toBe(jobId);

    // The income GL line carries the class (P&L by Class).
    const glLines = await db
      .select()
      .from(journalEntryLines)
      .where(
        and(
          eq(journalEntryLines.journalEntryId, invoice.postedEntryId!),
          eq(journalEntryLines.accountId, acct['4000']),
        ),
      );
    expect(glLines).toHaveLength(1);
    expect(glLines[0].classId).toBe(classId);

    // A COGS entry exists, tagged for reversal.
    const cogsEntries = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.sourceRef, `invoice-cogs:${invoice.id}`));
    expect(cogsEntries).toHaveLength(1);
    expect(cogsEntries[0].status).toBe('posted');
    expect(cogsEntries[0].reference).toBe('cogs:0');

    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('voiding the invoice reverses COGS and restores quantity on hand', async () => {
    const voided = await voidInvoice(ctx, avgInvoiceId);
    expect(voided.status).toBe('void');

    const state = await itemState(widgetId);
    expect(state.qty).toBe('20.0000');
    expect(state.avg).toBe('9.0000');
    expect(await balanceOf('5000')).toBe('0.00');
    expect(await balanceOf('1300')).toBe('180.00');
    expect(await balanceOf('4000')).toBe('0.00');

    const cogsEntries = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.sourceRef, `invoice-cogs:${avgInvoiceId}`));
    expect(cogsEntries[0].status).toBe('void');

    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('rejects an invoice that sells more than the quantity on hand (and rolls back)', async () => {
    const before = (await listInvoices(ctx)).length;
    await expect(
      createInvoice(ctx, {
        customerId,
        date: new Date('2025-03-06'),
        lines: [{ itemId: widgetId, quantity: 1000, rate: 20 }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    // Nothing persisted: same invoice count, stock untouched, TB balanced.
    expect((await listInvoices(ctx)).length).toBe(before);
    expect((await itemState(widgetId)).qty).toBe('20.0000');
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('blocks selling an inventory item that has stock but no average cost', async () => {
    const [freebie] = await db
      .insert(items)
      .values({
        companyId: ctx.companyId,
        name: 'Freebie',
        type: 'inventory',
        quantityOnHand: '5',
        averageCost: '0',
      })
      .returning();

    await expect(
      createInvoice(ctx, {
        customerId,
        date: new Date('2025-03-07'),
        lines: [{ itemId: freebie.id, quantity: 1, rate: 10 }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  // -------------------------------------------------------------------------
  // FIFO-tracked items
  // -------------------------------------------------------------------------

  let fifoInvoiceId: string;

  it('invoice selling a FIFO item consumes layers oldest-first', async () => {
    await receiveStock(ctx, {
      itemId: gadgetId,
      quantity: 5,
      unitCost: 10,
      date: new Date('2025-04-01'),
    });
    await receiveStock(ctx, {
      itemId: gadgetId,
      quantity: 5,
      unitCost: 12,
      date: new Date('2025-04-02'),
    });
    const inv1300 = Number(await balanceOf('1300')); // 180 + 110 = 290

    const invoice = await createInvoice(ctx, {
      customerId,
      date: new Date('2025-04-05'),
      lines: [{ itemId: gadgetId, quantity: 6, rate: 30 }],
    });
    fifoInvoiceId = invoice.id;

    // COGS = 5*10 + 1*12 = 62 (exact FIFO, not average).
    expect(await balanceOf('5000')).toBe('62.00');
    expect(Number(await balanceOf('1300'))).toBeCloseTo(inv1300 - 62, 2);
    expect((await itemState(gadgetId)).qty).toBe('4.0000');

    const layers = await db
      .select()
      .from(inventoryLayers)
      .where(eq(inventoryLayers.itemId, gadgetId))
      .orderBy(asc(inventoryLayers.date));
    expect(layers[0].quantityRemaining).toBe('0.0000');
    expect(layers[1].quantityRemaining).toBe('4.0000');

    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('voiding the FIFO invoice puts the units back into the layers they came from', async () => {
    const before1300 = Number(await balanceOf('1300'));

    await voidInvoice(ctx, fifoInvoiceId);

    expect((await itemState(gadgetId)).qty).toBe('10.0000');
    expect(await balanceOf('5000')).toBe('0.00');
    expect(Number(await balanceOf('1300'))).toBeCloseTo(before1300 + 62, 2);

    // Review round 5: the 5 @ 10 and 1 @ 12 go back into their own layers (FIFO order kept),
    // instead of a new blended layer (62 / 6 = 10.3333) dated the invoice.
    const layers = await db
      .select()
      .from(inventoryLayers)
      .where(eq(inventoryLayers.itemId, gadgetId))
      .orderBy(asc(inventoryLayers.date));
    expect(layers.map((l) => [l.quantityRemaining, l.unitCost])).toEqual([
      ['5.0000', '10.0000'],
      ['5.0000', '12.0000'],
    ]);

    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('bill item line for a FIFO-tracked item creates a new cost layer (and void removes it)', async () => {
    // Make gizmo FIFO-tracked with an initial layer.
    await receiveStock(ctx, {
      itemId: gizmoId,
      quantity: 1,
      unitCost: 5,
      date: new Date('2025-04-10'),
    });
    const before1300 = Number(await balanceOf('1300'));

    const bill = await createBill(ctx, {
      vendorId,
      billNumber: 'B-200',
      date: new Date('2025-04-11'),
      lines: [{ itemId: gizmoId, quantity: 3, unitCost: 15 }],
    });
    expect(bill.total).toBe('45.00');
    expect((await itemState(gizmoId)).qty).toBe('4.0000');
    expect(Number(await balanceOf('1300'))).toBeCloseTo(before1300 + 45, 2);

    const layers = await db
      .select()
      .from(inventoryLayers)
      .where(eq(inventoryLayers.itemId, gizmoId));
    expect(layers).toHaveLength(2);
    const newLayer = layers.find((l) => l.unitCost === '15.0000');
    expect(newLayer?.quantityRemaining).toBe('3.0000');

    // Voiding the bill removes the received layer quantity again.
    await voidBill(ctx, bill.id);
    expect((await itemState(gizmoId)).qty).toBe('1.0000');
    expect(Number(await balanceOf('1300'))).toBeCloseTo(before1300, 2);
    const after = await db
      .select()
      .from(inventoryLayers)
      .where(eq(inventoryLayers.itemId, gizmoId));
    const remaining15 = after.filter((l) => l.unitCost === '15.0000');
    expect(remaining15.every((l) => Number(l.quantityRemaining) === 0)).toBe(true);

    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Bill void (average cost) + consumed-stock guard
  // -------------------------------------------------------------------------

  it('voiding an average-cost receipt bill reverses quantity and weighted cost', async () => {
    const before1300 = Number(await balanceOf('1300'));

    await voidBill(ctx, secondBillId); // the 10 @ $10 receipt

    const state = await itemState(widgetId);
    expect(state.qty).toBe('10.0000');
    // Pool: 20 @ 9.00 = 180, minus 10 @ 10 = 80 over 10 units → 8.00
    expect(state.avg).toBe('8.0000');
    expect(Number(await balanceOf('1300'))).toBeCloseTo(before1300 - 100, 2);
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('blocks voiding a bill whose received stock has been consumed', async () => {
    // Receive 5 more @ 8 → QOH 15, then sell 12 → QOH 3 (< 5).
    const bill = await createBill(ctx, {
      vendorId,
      date: new Date('2025-05-01'),
      lines: [{ itemId: widgetId, quantity: 5, unitCost: 8 }],
    });
    await createInvoice(ctx, {
      customerId,
      date: new Date('2025-05-02'),
      lines: [{ itemId: widgetId, quantity: 12, rate: 20 }],
    });
    expect((await itemState(widgetId)).qty).toBe('3.0000');

    await expect(voidBill(ctx, bill.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await itemState(widgetId)).qty).toBe('3.0000');
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Non-inventory paths keep working
  // -------------------------------------------------------------------------

  it('manual description-only invoice lines still work with no inventory impact', async () => {
    const qtyBefore = (await itemState(widgetId)).qty;
    const invoice = await createInvoice(ctx, {
      customerId,
      date: new Date('2025-05-03'),
      lines: [{ description: 'Manual services line', quantity: 2, rate: 100 }],
    });
    expect(invoice.total).toBe('200.00');
    expect((await itemState(widgetId)).qty).toBe(qtyBefore);
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('service-item bill lines route to the item expense account without touching stock', async () => {
    const before6000 = Number(await balanceOf('6000'));
    const bill = await createBill(ctx, {
      vendorId,
      date: new Date('2025-05-04'),
      lines: [{ itemId: consultingId, quantity: 2, unitCost: 50 }],
    });
    expect(bill.total).toBe('100.00');
    expect(Number(await balanceOf('6000'))).toBeCloseTo(before6000 + 100, 2);

    const lines = await db.select().from(billLines).where(eq(billLines.billId, bill.id));
    expect(lines[0].accountId).toBe(acct['6000']);
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('rejects an item bill line without quantity or cost basis', async () => {
    await expect(
      createBill(ctx, {
        vendorId,
        date: new Date('2025-05-05'),
        lines: [{ itemId: widgetId, quantity: 0, unitCost: 8 }],
      }),
    ).rejects.toBeInstanceOf(ServiceError);

    await expect(
      createBill(ctx, {
        vendorId,
        date: new Date('2025-05-05'),
        lines: [{ itemId: widgetId, quantity: 2 }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
