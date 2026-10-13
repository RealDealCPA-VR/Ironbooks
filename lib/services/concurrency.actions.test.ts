/**
 * P1 controls (fix round 1) — record locking on the POST action routes.
 *
 * Voiding an item receipt, voiding / closing a purchase order and changing a sales order's
 * status change the record itself, so (like a save) they must be refused with QB's
 * "This record was changed by another user" when the record changed after the user opened it.
 * The client sends the loaded version on these actions (lib/client.ts VERSIONED_POST_ACTIONS).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, vendors, customers, accounts, items, purchaseOrders, salesOrders, itemReceipts } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createPurchaseOrder, updatePurchaseOrder } from './purchaseOrders';
import { createSalesOrder, updateSalesOrder } from './salesOrders';
import { createItemReceipt, updateItemReceipt } from './itemReceipts';
import { trialBalance } from './reports';

let ctx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ctx) }));
import { POST as poPOST } from '@/app/api/purchase-orders/[id]/route';
import { POST as soPOST } from '@/app/api/sales-orders/[id]/route';
import { POST as irPOST } from '@/app/api/item-receipts/[id]/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-concurrency-actions');
let db: DB;
const code: Record<string, string> = {};
let vendorId: string;
let customerId: string;
const d = (s: string) => new Date(`${s}T12:00:00Z`);

function post(url: string, body: unknown, version?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (version) headers['x-expected-updated-at'] = version;
  return new Request(`http://localhost${url}`, { method: 'POST', headers, body: JSON.stringify(body) }) as never;
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function versionOf(t: typeof purchaseOrders | typeof salesOrders | typeof itemReceipts, id: string) {
  const [row] = await db.select({ v: t.updatedAt, status: t.status }).from(t as typeof purchaseOrders).where(eq(t.id, id));
  return { v: row.v.toISOString(), status: row.status as string };
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'actions@test.local', name: 'Alice', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Actions Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId))) code[a.code] = a.id;
  vendorId = (await db.insert(vendors).values({ companyId: ctx.companyId, displayName: 'Depot' }).returning())[0].id;
  customerId = (await db.insert(customers).values({ companyId: ctx.companyId, displayName: 'Acme' }).returning())[0].id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('record locking on POST actions', () => {
  it('void / close of a purchase order changed since it was opened is refused (409); a current one goes through', async () => {
    const poLines = [{ accountId: code['6000'] ?? Object.values(code)[0], quantity: '1', rate: '10' }];
    const po = await createPurchaseOrder(ctx, { vendorId, date: d('2026-03-02'), lines: poLines } as never);
    const opened = (await versionOf(purchaseOrders, po.id)).v;
    await new Promise((r) => setTimeout(r, 5));
    await updatePurchaseOrder(ctx, po.id, { vendorId, date: d('2026-03-02'), memo: 'changed by Bob', lines: poLines } as never);

    for (const action of ['void', 'close']) {
      const res = await poPOST(post(`/api/purchase-orders/${po.id}`, { action }, opened), params(po.id));
      expect(res.status).toBe(409);
      expect((await res.json()).details?.staleVersion).toBe(true);
    }
    expect((await versionOf(purchaseOrders, po.id)).status).toBe('open');

    const current = (await versionOf(purchaseOrders, po.id)).v;
    const ok = await poPOST(post(`/api/purchase-orders/${po.id}`, { action: 'close' }, current), params(po.id));
    expect(ok.status).toBe(200);
    expect((await versionOf(purchaseOrders, po.id)).status).toBe('closed');
  });

  it('changing the status of a sales order changed since it was opened is refused (409)', async () => {
    const so = await createSalesOrder(ctx, { customerId, date: d('2026-03-03'), lines: [{ description: 'Order', quantity: 1, rate: '50' }] });
    const opened = (await versionOf(salesOrders, so.id)).v;
    await new Promise((r) => setTimeout(r, 5));
    await db.update(salesOrders).set({ memo: 'changed by Bob' }).where(eq(salesOrders.id, so.id));
    expect((await versionOf(salesOrders, so.id)).v).not.toBe(opened);

    const res = await soPOST(post(`/api/sales-orders/${so.id}`, { action: 'status', status: 'closed' }, opened), params(so.id));
    expect(res.status).toBe(409);
    expect((await versionOf(salesOrders, so.id)).status).toBe('open');

    const current = (await versionOf(salesOrders, so.id)).v;
    const ok = await soPOST(post(`/api/sales-orders/${so.id}`, { action: 'status', status: 'closed' }, current), params(so.id));
    expect(ok.status).toBe(200);
    expect((await versionOf(salesOrders, so.id)).status).toBe('closed');
  });

  it('voiding an item receipt changed since it was opened is refused (409); the books do not move', async () => {
    const [item] = await db
      .insert(items)
      .values({ companyId: ctx.companyId, name: 'Widget', type: 'inventory', quantityOnHand: '0', averageCost: '0' } as never)
      .returning();
    const input = { vendorId, date: d('2026-03-04'), lines: [{ itemId: item.id, quantity: 2, unitCost: 5 }] };
    const ir = await createItemReceipt(ctx, input as never);
    const opened = (await versionOf(itemReceipts, ir.id)).v;
    await new Promise((r) => setTimeout(r, 5));
    await updateItemReceipt(ctx, ir.id, { ...input, memo: 'changed by Bob' } as never);
    const tb = (await trialBalance(ctx)).rows;

    const res = await irPOST(post(`/api/item-receipts/${ir.id}`, { action: 'void' }, opened), params(ir.id));
    expect(res.status).toBe(409);
    expect((await trialBalance(ctx)).rows).toEqual(tb);
    expect((await versionOf(itemReceipts, ir.id)).status).not.toBe('void');

    const current = (await versionOf(itemReceipts, ir.id)).v;
    const ok = await irPOST(post(`/api/item-receipts/${ir.id}`, { action: 'void' }, current), params(ir.id));
    expect(ok.status).toBe(200);
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('converting a sales order changed since it was opened is refused (409) and makes no invoice; a current one converts', async () => {
    const input = { customerId, date: d('2026-03-05'), lines: [{ description: 'Service', quantity: 1, rate: '25' }] };
    const so = await createSalesOrder(ctx, input as never);
    const opened = (await versionOf(salesOrders, so.id)).v;
    await new Promise((r) => setTimeout(r, 5));
    await updateSalesOrder(ctx, so.id, { ...input, memo: 'changed by Bob' } as never);
    const tb = (await trialBalance(ctx)).rows;

    const res = await soPOST(post(`/api/sales-orders/${so.id}`, { action: 'convert' }, opened), params(so.id));
    expect(res.status).toBe(409);
    expect((await res.json()).details?.staleVersion).toBe(true);
    expect((await trialBalance(ctx)).rows).toEqual(tb);
    expect((await versionOf(salesOrders, so.id)).status).toBe('open');

    const current = (await versionOf(salesOrders, so.id)).v;
    const ok = await soPOST(post(`/api/sales-orders/${so.id}`, { action: 'convert' }, current), params(so.id));
    expect(ok.status).toBe(201);
    expect((await versionOf(salesOrders, so.id)).status).not.toBe('open');
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });
});
