/**
 * Sales Order Fulfillment Worksheet — independent QA (adversarial) tests.
 *
 * Availability math against the inventory module's committed quantity, fractional and
 * negative on-hand, void orders excluded, partial invoicing feeding back into allocation;
 * batch invoicing: validation is all-or-nothing, one failing order (credit limit) never blocks
 * the others or leaves half-posted state, re-running a batch never double-invoices,
 * cross-company / malformed selections, viewer role, and a balanced trial balance throughout.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, customers, items, invoices } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { committedQuantity } from './inventory';
import {
  createSalesOrder,
  getSalesOrder,
  convertToInvoice,
  updateStatus as updateSoStatus,
} from './salesOrders';
import { batchInvoiceSalesOrders, fulfillmentWorksheet, planShipments } from './fulfillment';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-so-fulfillment-qa');
let db: DB;
let ctx: ServiceContext;
let otherCtx: ServiceContext;
const it_ = { bolt: '', nut: '', neg: '', labor: '' };
const cust = { a: '', b: '', c: '' };
const so: Record<string, string> = {};

async function invoiceCount() {
  return (await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.companyId, ctx.companyId))).length;
}
async function onHand(id: string) {
  const [row] = await db.select().from(items).where(eq(items.id, id));
  return row.quantityOnHand;
}
async function expectBalanced() {
  expect((await trialBalance(ctx)).balanced).toBe(true);
}

describe('Sales order fulfillment (QA)', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'fqa@test.local', name: 'FQA', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Ful QA', ownerId: user.id }).returning();
    const [otherCo] = await db.insert(companies).values({ name: 'Ful Other', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    otherCtx = { db, companyId: otherCo.id, userId: user.id };
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
      await createAccount(otherCtx, { code, name, type: type as never, subtype });
    }
    const inv = { type: 'inventory' as const, averageCost: '2.0000' };
    it_.bolt = (await db.insert(items).values({ companyId: company.id, name: 'Bolt', salesPrice: '10.00', quantityOnHand: '5', ...inv }).returning())[0].id;
    it_.nut = (await db.insert(items).values({ companyId: company.id, name: 'Nut', salesPrice: '4.00', quantityOnHand: '2.5', ...inv }).returning())[0].id;
    it_.neg = (await db.insert(items).values({ companyId: company.id, name: 'Oversold', salesPrice: '3.00', quantityOnHand: '-3', ...inv }).returning())[0].id;
    it_.labor = (await db.insert(items).values({ companyId: company.id, name: 'Labor', type: 'service', salesPrice: '80.00' }).returning())[0].id;

    cust.a = (await db.insert(customers).values({ companyId: company.id, displayName: 'Alpha' }).returning())[0].id;
    cust.b = (await db.insert(customers).values({ companyId: company.id, displayName: 'Beta' }).returning())[0].id;
    cust.c = (await db.insert(customers).values({ companyId: company.id, displayName: 'Capped', creditLimit: '1.00' }).returning())[0].id;

    // A voided order dated EARLIEST must not reserve stock.
    so.void = (await createSalesOrder(ctx, { customerId: cust.a, date: new Date('2026-01-01'), lines: [{ itemId: it_.bolt, quantity: 100, rate: '10.00' }] })).id;
    await updateSoStatus(ctx, so.void, 'void');

    so.s1 = (await createSalesOrder(ctx, { customerId: cust.a, date: new Date('2026-02-01'), lines: [{ itemId: it_.bolt, quantity: 3, rate: '10.00' }] })).id;
    so.s2 = (
      await createSalesOrder(ctx, {
        customerId: cust.b,
        date: new Date('2026-02-02'),
        lines: [
          { itemId: it_.bolt, quantity: 4, rate: '10.00' },
          { itemId: it_.labor, quantity: 1, rate: '80.00' },
        ],
      })
    ).id;
    so.s3 = (
      await createSalesOrder(ctx, {
        customerId: cust.c,
        date: new Date('2026-02-03'),
        lines: [
          { itemId: it_.bolt, quantity: 1, rate: '10.00' },
          { itemId: it_.nut, quantity: 3, rate: '4.00' },
        ],
      })
    ).id;
    so.s4 = (await createSalesOrder(ctx, { customerId: cust.a, date: new Date('2026-02-04'), lines: [{ itemId: it_.neg, quantity: 1, rate: '3.00' }] })).id;

    so.foreign = (
      await createSalesOrder(otherCtx, {
        customerId: (await db.insert(customers).values({ companyId: otherCo.id, displayName: 'Foreign' }).returning())[0].id,
        date: new Date('2026-02-01'),
        lines: [{ description: 'Foreign service', quantity: 1, rate: '5.00' }],
      })
    ).id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('availability: void orders excluded, fractional / negative on-hand, matches the inventory committed quantity', async () => {
    const ws = await fulfillmentWorksheet(ctx);
    const byId = new Map(ws.orders.map((o) => [o.salesOrderId, o]));
    expect(byId.has(so.void)).toBe(false);
    expect(byId.has(so.foreign)).toBe(false);

    expect(byId.get(so.s1)!.lines[0]).toMatchObject({ canShip: '3.0000', shipStatus: 'complete' });
    const s2 = byId.get(so.s2)!;
    expect(s2.lines[0]).toMatchObject({ canShip: '2.0000', shipStatus: 'partial' });
    expect(s2.lines[1]).toMatchObject({ canShip: '1.0000', shipStatus: 'complete' });
    expect(s2.shipStatus).toBe('partial');
    expect(s2.shippableAmount).toBe('100.00');
    expect(s2.openAmount).toBe('120.00');
    const s3 = byId.get(so.s3)!;
    expect(s3.lines.find((l) => l.itemId === it_.bolt)).toMatchObject({ canShip: '0.0000', shipStatus: 'none' });
    expect(s3.lines.find((l) => l.itemId === it_.nut)).toMatchObject({ canShip: '2.5000', shipStatus: 'partial' });
    expect(s3.shipStatus).toBe('partial');
    expect(byId.get(so.s4)!.lines[0]).toMatchObject({ canShip: '0.0000', shipStatus: 'none' });
    expect(byId.get(so.s4)!.shipStatus).toBe('none');

    // Allocation never hands out more than is on hand.
    const boltShip = ws.orders.flatMap((o) => o.lines).filter((l) => l.itemId === it_.bolt).reduce((s, l) => s + Number(l.canShip), 0);
    expect(boltShip).toBeLessThanOrEqual(5);

    // Worksheet "committed" agrees with the inventory module (Stock Status by Item).
    for (const id of [it_.bolt, it_.nut, it_.neg]) {
      const row = ws.items.find((i) => i.itemId === id)!;
      expect(row.committedToOrders).toBe(await committedQuantity(ctx, id));
    }
    expect(ws.items.find((i) => i.itemId === it_.bolt)!.available).toBe('-3.0000'); // 5 - 8
    expect(ws.totals.shippableAmount).toBe(
      ws.orders.reduce((s, o) => s + Number(o.shippableAmount), 0).toFixed(2),
    );
  });

  it('a partial invoice outside the worksheet feeds back into allocation', async () => {
    const lineId = (await getSalesOrder(ctx, so.s1)).lines[0].id;
    await convertToInvoice(ctx, so.s1, { date: new Date('2026-02-05'), lines: [{ lineId, quantity: '2' }] });
    expect(await onHand(it_.bolt)).toBe('3.0000');
    const ws = await fulfillmentWorksheet(ctx);
    const byId = new Map(ws.orders.map((o) => [o.salesOrderId, o]));
    expect(byId.get(so.s1)!.lines[0]).toMatchObject({ quantityInvoiced: '2.0000', quantityRemaining: '1.0000', canShip: '1.0000' });
    expect(byId.get(so.s2)!.lines[0].canShip).toBe('2.0000'); // 3 on hand - 1 still owed to s1
    await expectBalanced();
  });

  it('malformed / foreign / duplicate selections are rejected before anything is invoiced', async () => {
    const before = await invoiceCount();
    const s2Line = (await getSalesOrder(ctx, so.s2)).lines[0].id;
    const s1Line = (await getSalesOrder(ctx, so.s1)).lines[0].id;
    const cases: Array<Parameters<typeof batchInvoiceSalesOrders>[1]['selections']> = [
      [], // nothing selected
      [{ salesOrderId: so.s1 }, { salesOrderId: so.s1 }], // duplicate
      [{ salesOrderId: so.foreign }], // other company
      [{ salesOrderId: so.void }], // void
      [{ salesOrderId: so.s1 }, { salesOrderId: so.s2, lines: [{ lineId: s2Line, quantity: '10' }] }], // > remaining
      [{ salesOrderId: so.s1 }, { salesOrderId: so.s2, lines: [{ lineId: s2Line, quantity: '-1' }] }], // negative
      [{ salesOrderId: so.s2, lines: [{ lineId: s1Line, quantity: '1' }] }], // line of another order
    ];
    for (const selections of cases) {
      await expect(batchInvoiceSalesOrders(ctx, { date: new Date('2026-02-10'), selections })).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    expect(await invoiceCount()).toBe(before);
    expect(await onHand(it_.bolt)).toBe('3.0000');
  });

  it('one failing order (credit limit) does not block the others and leaves no half-posted state', async () => {
    const before = await invoiceCount();
    const out = await batchInvoiceSalesOrders(ctx, {
      date: new Date('2026-02-10'),
      selections: [{ salesOrderId: so.s3 }, { salesOrderId: so.s1 }],
    });
    const r1 = out.results.find((r) => r.salesOrderId === so.s1)!;
    const r3 = out.results.find((r) => r.salesOrderId === so.s3)!;
    expect(r1).toMatchObject({ ok: true, total: '10.00' });
    expect(r3.ok).toBe(false);
    expect(r3.error).toMatch(/credit limit/i);
    expect(out).toMatchObject({ invoiced: 1, failed: 1 });
    expect(await invoiceCount()).toBe(before + 1);

    // The failed order is untouched: nothing invoiced, stock not consumed.
    const s3 = await getSalesOrder(ctx, so.s3);
    expect(s3.status).toBe('open');
    expect(s3.lines.every((l) => Number(l.quantityInvoiced) === 0)).toBe(true);
    expect(await onHand(it_.nut)).toBe('2.5000');
    expect(await onHand(it_.bolt)).toBe('2.0000');
    expect((await getSalesOrder(ctx, so.s1)).status).toBe('closed');
    await expectBalanced();
  });

  it('re-running a batch for an already fully invoiced order never double-invoices', async () => {
    const before = await invoiceCount();
    await expect(
      batchInvoiceSalesOrders(ctx, { date: new Date('2026-02-11'), selections: [{ salesOrderId: so.s1 }] }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await invoiceCount()).toBe(before);

    // Ship what can ship on s2 twice in a row: the second run finds nothing more to ship.
    const first = await batchInvoiceSalesOrders(ctx, { date: new Date('2026-02-11'), selections: [{ salesOrderId: so.s2 }] });
    expect(first.invoiced).toBe(1);
    expect(first.results[0].total).toBe('100.00'); // 2 bolts + labor
    const second = await batchInvoiceSalesOrders(ctx, { date: new Date('2026-02-11'), selections: [{ salesOrderId: so.s2 }] });
    expect(second.invoiced).toBe(0);
    expect(await invoiceCount()).toBe(before + 1);
    expect(await onHand(it_.bolt)).toBe('0.0000');
    await expectBalanced();
  });

  it('a viewer cannot batch-invoice (no invoices created), but can read the worksheet', async () => {
    const viewer: ServiceContext = { ...ctx, role: 'viewer' };
    const before = await invoiceCount();
    const ws = await fulfillmentWorksheet(viewer);
    expect(ws.orders.length).toBeGreaterThan(0);
    let out: Awaited<ReturnType<typeof batchInvoiceSalesOrders>> | null = null;
    try {
      out = await batchInvoiceSalesOrders(viewer, { selections: [{ salesOrderId: so.s3 }] });
    } catch (err) {
      expect(err).toMatchObject({ code: 'FORBIDDEN' });
    }
    if (out) expect(out.invoiced).toBe(0);
    expect(await invoiceCount()).toBe(before);
  });

  it('planShipments never plans more than physical stock across a multi-order batch', async () => {
    // Restock 1 nut-free bolt scenario: Nut has 2.5 on hand, s3 wants 3.
    const plan = await planShipments(ctx, [{ salesOrderId: so.s3 }]);
    const nut = plan[0].lines.find((l) => l.itemId === it_.nut)!;
    expect(nut.quantity).toBe('2.5000');
    expect(plan[0].lines.some((l) => l.itemId === it_.bolt)).toBe(false); // no bolts left
  });
});
