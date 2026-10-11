/**
 * Sales Order Fulfillment Worksheet tests: first-come-first-served availability that respects
 * stock committed to earlier orders and pending builds, ship status (complete / partial / none),
 * filters that never change availability, explicit-quantity guards, batch invoicing of what can
 * ship (balanced GL), and the pick-list / packing-slip PDFs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, customers, items, assemblyComponents, pendingBuilds } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { createSalesOrder, getSalesOrder } from './salesOrders';
import { batchInvoiceSalesOrders, fulfillmentWorksheet, planShipments } from './fulfillment';
import { renderPickListPdf, renderPackingSlipsPdf } from '@/lib/pdf/pickList';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-so-fulfillment');
let db: DB;
let ctx: ServiceContext;
let widgetId: string;
let installId: string;
let custA: string;
let custB: string;
const so: Record<string, string> = {};

describe('Sales order fulfillment worksheet', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'ful@test.local', name: 'Ful', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Ful Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    const defs: Array<[string, string, string, string]> = [
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['1300', 'Inventory Asset', 'asset', 'inventory'],
      ['2200', 'Sales Tax Payable', 'liability', 'accounts_payable'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
    ];
    for (const [code, name, type, subtype] of defs) {
      await createAccount(ctx, { code, name, type: type as never, subtype });
    }
    [{ id: widgetId }] = await db
      .insert(items)
      .values({ companyId: company.id, name: 'Widget', sku: 'W-1', type: 'inventory', salesPrice: '10.00', quantityOnHand: '10', averageCost: '4.0000' })
      .returning();
    [{ id: installId }] = await db
      .insert(items)
      .values({ companyId: company.id, name: 'Install', type: 'service', salesPrice: '50.00' })
      .returning();
    const [kit] = await db
      .insert(items)
      .values({ companyId: company.id, name: 'Kit', type: 'inventory', salesPrice: '99.00', quantityOnHand: '0' })
      .returning();
    await db.insert(assemblyComponents).values({ companyId: company.id, assemblyItemId: kit.id, componentItemId: widgetId, quantity: '2' });
    await db.insert(pendingBuilds).values({ companyId: company.id, assemblyItemId: kit.id, quantity: '1', date: new Date('2026-01-01'), status: 'pending' });

    [{ id: custA }] = await db.insert(customers).values({ companyId: company.id, displayName: 'Alpha' }).returning();
    [{ id: custB }] = await db.insert(customers).values({ companyId: company.id, displayName: 'Beta' }).returning();

    so.first = (await createSalesOrder(ctx, { customerId: custA, date: new Date('2026-02-01'), lines: [{ itemId: widgetId, quantity: 6, rate: '10.00' }] })).id;
    so.second = (
      await createSalesOrder(ctx, {
        customerId: custB,
        date: new Date('2026-02-02'),
        lines: [
          { itemId: widgetId, quantity: 6, rate: '10.00' },
          { itemId: installId, quantity: 1, rate: '50.00' },
        ],
      })
    ).id;
    so.third = (await createSalesOrder(ctx, { customerId: custA, date: new Date('2026-02-03'), lines: [{ itemId: widgetId, quantity: 3, rate: '10.00' }] })).id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('allocates stock first-come-first-served after pending-build commitments', async () => {
    const ws = await fulfillmentWorksheet(ctx);
    const byId = new Map(ws.orders.map((o) => [o.salesOrderId, o]));
    // On hand 10, 2 reserved for the pending Kit build -> 8 free.
    const first = byId.get(so.first)!;
    expect(first.shipStatus).toBe('complete');
    expect(first.lines[0]).toMatchObject({ canShip: '6.0000', quantityAllocatedBefore: '2.0000', quantityOnHand: '10.0000' });
    const second = byId.get(so.second)!;
    expect(second.shipStatus).toBe('partial');
    expect(second.lines[0].canShip).toBe('2.0000');
    expect(second.lines[1]).toMatchObject({ tracksStock: false, canShip: '1.0000', shipStatus: 'complete' });
    expect(second.shippableAmount).toBe('70.00');
    expect(byId.get(so.third)!.shipStatus).toBe('none');
    const widget = ws.items.find((i) => i.itemId === widgetId)!;
    expect(widget).toMatchObject({ onHand: '10.0000', committedToOrders: '15.0000', committedToBuilds: '2.0000', available: '-7.0000' });
    expect(ws.totals).toMatchObject({ orders: 3, complete: 1, partial: 1, none: 1 });
  });

  it('filters never change availability', async () => {
    const onlyB = await fulfillmentWorksheet(ctx, { customerId: custB });
    expect(onlyB.orders).toHaveLength(1);
    expect(onlyB.orders[0].lines[0].canShip).toBe('2.0000');
    const none = await fulfillmentWorksheet(ctx, { shipStatus: 'none' });
    expect(none.orders.map((o) => o.salesOrderId)).toEqual([so.third]);
    const dated = await fulfillmentWorksheet(ctx, { from: new Date('2026-02-02'), to: new Date('2026-02-02') });
    expect(dated.orders.map((o) => o.salesOrderId)).toEqual([so.second]);
    expect((await fulfillmentWorksheet(ctx, { itemId: installId })).orders).toHaveLength(1);
  });

  it('explicit quantities cannot exceed remaining or physical stock (builds stay reserved)', async () => {
    await expect(
      planShipments(ctx, [{ salesOrderId: so.third, lines: [{ lineId: (await getSalesOrder(ctx, so.third)).lines[0].id, quantity: 4 }] }]),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const secondLine = (await getSalesOrder(ctx, so.second)).lines[0].id;
    await expect(
      planShipments(ctx, [
        { salesOrderId: so.first },
        { salesOrderId: so.second, lines: [{ lineId: secondLine, quantity: 3 }] }, // only 2 physically left
      ]),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('prints a pick list and packing slips for the shipment plan', async () => {
    const shipments = await planShipments(ctx, [{ salesOrderId: so.first }, { salesOrderId: so.second }]);
    expect(shipments).toHaveLength(2);
    const pick = await renderPickListPdf({
      company: { name: 'Ful Co' },
      date: '2026-02-10',
      rows: [
        {
          itemName: 'Widget',
          sku: 'W-1',
          totalQuantity: '8',
          orders: shipments.map((s) => ({ orderNumber: s.orderNumber, customerName: s.customerName, quantity: s.lines[0].quantity })),
        },
      ],
    });
    expect(Buffer.from(pick.slice(0, 4)).toString()).toBe('%PDF');
    const slips = await renderPackingSlipsPdf(
      shipments.map((s) => ({
        company: { name: 'Ful Co' },
        customerName: s.customerName,
        slip: { invoiceNumber: '', label: `Sales Order #${s.orderNumber}`, date: '2026-02-10' },
        lines: s.lines.map((l) => ({ itemName: l.itemName, description: l.description ?? '', quantity: l.quantity })),
      })),
    );
    expect((await PDFDocument.load(slips)).getPageCount()).toBe(2);
  });

  it('batch-invoices what can ship, one invoice per order, and reports orders with nothing to ship', async () => {
    const out = await batchInvoiceSalesOrders(ctx, {
      date: new Date('2026-02-10'),
      selections: [{ salesOrderId: so.second }, { salesOrderId: so.first }, { salesOrderId: so.third }],
    });
    expect(out.invoiced).toBe(2);
    expect(out.failed).toBe(1);
    const first = out.results.find((r) => r.salesOrderId === so.first)!;
    const second = out.results.find((r) => r.salesOrderId === so.second)!;
    expect(first).toMatchObject({ ok: true, total: '60.00' });
    expect(second).toMatchObject({ ok: true, total: '70.00' });
    expect(out.results.find((r) => r.salesOrderId === so.third)).toMatchObject({ ok: false });

    expect((await getSalesOrder(ctx, so.first)).status).toBe('closed');
    expect((await getSalesOrder(ctx, so.second)).status).toBe('partial');
    const [widget] = await db.select().from(items).where(eq(items.id, widgetId));
    expect(widget.quantityOnHand).toBe('2.0000'); // the build reservation is untouched

    const ws = await fulfillmentWorksheet(ctx);
    expect(ws.orders.map((o) => o.shipStatus)).toEqual(['none', 'none']);
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });
});
