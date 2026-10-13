/**
 * P1 controls — re-test round 1 (independent tester): record locking on the POST action routes
 * (fix 3ed76d9) through the real route handlers.
 *
 *  - The 409 names who changed the record (QB's "This record was changed by <user>").
 *  - The version returned by a successful action is accepted by the next action (no false 409
 *    naming yourself after your own void/close/status change).
 *  - No version header (scripts, older clients) still works — locking is opt-in per request.
 *  - Another company's record id with a version header is NOT_FOUND (404), never 409/200, and the
 *    record is untouched (isolation).
 *  - A stale void of an item receipt moves neither the books nor the item's quantity on hand.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, userCompanies, vendors, customers, accounts, items, purchaseOrders, salesOrders, itemReceipts } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createPurchaseOrder, updatePurchaseOrder } from './purchaseOrders';
import { createSalesOrder } from './salesOrders';
import { createItemReceipt, updateItemReceipt } from './itemReceipts';
import { trialBalance } from './reports';

let ctx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ctx) }));
import { POST as poPOST } from '@/app/api/purchase-orders/[id]/route';
import { POST as soPOST } from '@/app/api/sales-orders/[id]/route';
import { POST as irPOST } from '@/app/api/item-receipts/[id]/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-concurrency-actions-retest1');
let db: DB;
let alice: ServiceContext;
let bob: ServiceContext;
let stranger: ServiceContext;
const code: Record<string, string> = {};
let vendorId: string;
let customerId: string;
const d = (s: string) => new Date(`${s}T12:00:00Z`);
const tick = () => new Promise((r) => setTimeout(r, 5));

function post(url: string, body: unknown, version?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (version) headers['x-expected-updated-at'] = version;
  return new Request(`http://localhost${url}`, { method: 'POST', headers, body: JSON.stringify(body) }) as never;
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function row(t: typeof purchaseOrders | typeof salesOrders | typeof itemReceipts, id: string) {
  const [r] = await db.select({ v: t.updatedAt, status: t.status }).from(t as typeof purchaseOrders).where(eq(t.id, id));
  return { v: r.v.toISOString(), status: r.status as string };
}

const poLines = () => [{ accountId: code['6300'], quantity: '1', rate: '10' }];

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [ua] = await db.insert(users).values({ email: 'alice-r1@test.local', name: 'Alice', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Actions Retest Co', ownerId: ua.id });
  alice = { db, companyId: company.id, userId: ua.id };
  const [ub] = await db.insert(users).values({ email: 'bob-r1@test.local', name: 'Bob Builder', passwordHash: 'x' }).returning();
  await db.insert(userCompanies).values({ userId: ub.id, companyId: company.id, role: 'admin' });
  bob = { db, companyId: company.id, userId: ub.id };
  const [us] = await db.insert(users).values({ email: 'stranger-r1@test.local', name: 'Stranger', passwordHash: 'x' }).returning();
  const c2 = await createCompany(db, { name: 'Stranger Co', ownerId: us.id });
  stranger = { db, companyId: c2.id, userId: us.id };
  ctx = alice;
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, alice.companyId))) code[a.code] = a.id;
  vendorId = (await db.insert(vendors).values({ companyId: alice.companyId, displayName: 'Depot' }).returning())[0].id;
  customerId = (await db.insert(customers).values({ companyId: alice.companyId, displayName: 'Acme' }).returning())[0].id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('record locking on POST actions (re-test)', () => {
  it("the 409 names the other user who changed the purchase order", async () => {
    ctx = alice;
    const po = await createPurchaseOrder(alice, { vendorId, date: d('2026-04-01'), lines: poLines() } as never);
    const opened = (await row(purchaseOrders, po.id)).v;
    await tick();
    await updatePurchaseOrder(bob, po.id, { vendorId, date: d('2026-04-01'), memo: 'Bob edit', lines: poLines() } as never);
    const res = await poPOST(post(`/api/purchase-orders/${po.id}`, { action: 'close' }, opened), params(po.id));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.details?.staleVersion).toBe(true);
    expect(String(body.error ?? body.message ?? JSON.stringify(body))).toMatch(/Bob Builder/);
    expect((await row(purchaseOrders, po.id)).status).toBe('open');
  });

  it('the version returned by my own status change is accepted by my next one (no false 409)', async () => {
    ctx = alice;
    const so = await createSalesOrder(alice, { customerId, date: d('2026-04-02'), lines: [{ description: 'x', quantity: 1, rate: '5' }] });
    const v0 = (await row(salesOrders, so.id)).v;
    const r1 = await soPOST(post(`/api/sales-orders/${so.id}`, { action: 'status', status: 'open' }, v0), params(so.id));
    expect(r1.status).toBe(200);
    const v1 = (await r1.json()).updatedAt as string;
    expect(typeof v1).toBe('string');
    expect(v1).toBe((await row(salesOrders, so.id)).v);
    const r2 = await soPOST(post(`/api/sales-orders/${so.id}`, { action: 'status', status: 'void' }, v1), params(so.id));
    expect(r2.status).toBe(200);
    expect((await row(salesOrders, so.id)).status).toBe('void');
  });

  it('no version header: void / close still work (locking is opt-in per request)', async () => {
    ctx = alice;
    const po = await createPurchaseOrder(alice, { vendorId, date: d('2026-04-03'), lines: poLines() } as never);
    const res = await poPOST(post(`/api/purchase-orders/${po.id}`, { action: 'void' }), params(po.id));
    expect(res.status).toBe(200);
    expect((await row(purchaseOrders, po.id)).status).toBe('void');
  });

  it("another company's record id with a version header is 404 and untouched", async () => {
    ctx = alice;
    const po = await createPurchaseOrder(alice, { vendorId, date: d('2026-04-04'), lines: poLines() } as never);
    const so = await createSalesOrder(alice, { customerId, date: d('2026-04-04'), lines: [{ description: 'y', quantity: 1, rate: '7' }] });
    const poV = (await row(purchaseOrders, po.id)).v;
    const soV = (await row(salesOrders, so.id)).v;
    ctx = stranger;
    try {
      for (const action of ['void', 'close']) {
        const res = await poPOST(post(`/api/purchase-orders/${po.id}`, { action }, poV), params(po.id));
        expect(res.status, action).toBe(404);
      }
      const res = await soPOST(post(`/api/sales-orders/${so.id}`, { action: 'status', status: 'void' }, soV), params(so.id));
      expect(res.status).toBe(404);
    } finally {
      ctx = alice;
    }
    expect(await row(purchaseOrders, po.id)).toEqual({ v: poV, status: 'open' });
    expect(await row(salesOrders, so.id)).toEqual({ v: soV, status: 'open' });
  });

  it('a stale void of an item receipt moves neither the books nor quantity on hand', async () => {
    ctx = alice;
    const [item] = await db
      .insert(items)
      .values({ companyId: alice.companyId, name: 'Gadget', type: 'inventory', quantityOnHand: '0', averageCost: '0' } as never)
      .returning();
    const input = { vendorId, date: d('2026-04-05'), lines: [{ itemId: item.id, quantity: 3, unitCost: 4 }] };
    const ir = await createItemReceipt(alice, input as never);
    const opened = (await row(itemReceipts, ir.id)).v;
    await tick();
    await updateItemReceipt(bob, ir.id, { ...input, memo: 'Bob' } as never);
    const tb = (await trialBalance(alice)).rows;
    const qty = (await db.select().from(items).where(eq(items.id, item.id)))[0].quantityOnHand;

    const res = await irPOST(post(`/api/item-receipts/${ir.id}`, { action: 'void' }, opened), params(ir.id));
    expect(res.status).toBe(409);
    expect((await trialBalance(alice)).rows).toEqual(tb);
    expect((await db.select().from(items).where(eq(items.id, item.id)))[0].quantityOnHand).toBe(qty);
    expect((await row(itemReceipts, ir.id)).status).not.toBe('void');
  });
});
