/**
 * Record locking on every 'convert' POST action (estimates, purchase orders, item receipts; sales
 * orders are covered by concurrency.actions.retest2.tester.test.ts) through the real route
 * handlers, plus the client sending the loaded version on 'convert' for each resource.
 *
 * A stale convert is refused with a 409 naming who changed the record; nothing is created and the
 * TB doesn't move. With the current version (or no header) the convert goes through.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, userCompanies, vendors, customers, accounts, items, estimates, purchaseOrders, itemReceipts, invoices, bills } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createEstimate, updateEstimate } from './estimates';
import { createPurchaseOrder, updatePurchaseOrder } from './purchaseOrders';
import { createItemReceipt, updateItemReceipt } from './itemReceipts';
import { trialBalance } from './reports';
import { api } from '@/lib/client';

let ctx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ctx) }));
import { POST as estPOST } from '@/app/api/estimates/[id]/route';
import { POST as poPOST } from '@/app/api/purchase-orders/[id]/route';
import { POST as irPOST } from '@/app/api/item-receipts/[id]/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-concurrency-convert');
let db: DB;
let alice: ServiceContext;
let bob: ServiceContext;
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
async function version(t: typeof estimates | typeof purchaseOrders | typeof itemReceipts, id: string) {
  const [r] = await db.select({ v: t.updatedAt }).from(t as typeof estimates).where(eq(t.id, id));
  return r.v.toISOString();
}
const invoiceCount = async () => (await db.select().from(invoices).where(eq(invoices.customerId, customerId))).length;
const billCount = async () => (await db.select().from(bills).where(eq(bills.vendorId, vendorId))).length;

afterEach(() => vi.unstubAllGlobals());

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [ua] = await db.insert(users).values({ email: 'alice-cv@test.local', name: 'Alice', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Convert Lock Co', ownerId: ua.id });
  alice = { db, companyId: company.id, userId: ua.id };
  const [ub] = await db.insert(users).values({ email: 'bob-cv@test.local', name: 'Bob Builder', passwordHash: 'x' }).returning();
  await db.insert(userCompanies).values({ userId: ub.id, companyId: company.id, role: 'admin' });
  bob = { db, companyId: company.id, userId: ub.id };
  ctx = alice;
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, alice.companyId))) code[a.code] = a.id;
  vendorId = (await db.insert(vendors).values({ companyId: alice.companyId, displayName: 'Depot' }).returning())[0].id;
  customerId = (await db.insert(customers).values({ companyId: alice.companyId, displayName: 'Acme' }).returning())[0].id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('record locking on convert', () => {
  it('estimate: a stale convert is refused naming Bob; the current version converts', async () => {
    ctx = alice;
    const input = { customerId, date: d('2026-06-01'), lines: [{ description: 'Consulting', quantity: 2, rate: 100 }] };
    const est = await createEstimate(alice, input as never);
    const opened = await version(estimates, est.id);
    await tick();
    await updateEstimate(bob, est.id, { ...input, memo: 'Bob edit' } as never);
    const tb = (await trialBalance(alice)).rows;
    const before = await invoiceCount();

    const stale = await estPOST(post(`/api/estimates/${est.id}`, { action: 'convert' }, opened), params(est.id));
    expect(stale.status).toBe(409);
    expect(JSON.stringify(await stale.json())).toMatch(/Bob Builder/);
    expect(await invoiceCount()).toBe(before);
    expect((await trialBalance(alice)).rows).toEqual(tb);

    const ok = await estPOST(post(`/api/estimates/${est.id}`, { action: 'convert' }, await version(estimates, est.id)), params(est.id));
    expect(ok.status).toBe(201);
    expect(await invoiceCount()).toBe(before + 1);
    expect((await trialBalance(alice)).balanced).toBe(true);
  });

  it('purchase order: a stale convert is refused; no header still converts', async () => {
    ctx = alice;
    const input = { vendorId, date: d('2026-06-02'), lines: [{ accountId: code['6300'], quantity: '1', rate: '10' }] };
    const po = await createPurchaseOrder(alice, input as never);
    const opened = await version(purchaseOrders, po.id);
    await tick();
    await updatePurchaseOrder(bob, po.id, { ...input, memo: 'Bob edit' } as never);
    const tb = (await trialBalance(alice)).rows;
    const before = await billCount();

    const stale = await poPOST(post(`/api/purchase-orders/${po.id}`, { action: 'convert' }, opened), params(po.id));
    expect(stale.status).toBe(409);
    expect(JSON.stringify(await stale.json())).toMatch(/Bob Builder/);
    expect(await billCount()).toBe(before);
    expect((await trialBalance(alice)).rows).toEqual(tb);

    const ok = await poPOST(post(`/api/purchase-orders/${po.id}`, { action: 'convert' }), params(po.id));
    expect(ok.status).toBeLessThan(300);
    expect(await billCount()).toBe(before + 1);
    expect((await trialBalance(alice)).balanced).toBe(true);
  });

  it('item receipt: a stale convert is refused and the books stay put; the current version converts', async () => {
    ctx = alice;
    const [item] = await db
      .insert(items)
      .values({ companyId: alice.companyId, name: 'Gizmo', type: 'inventory', quantityOnHand: '0', averageCost: '0' } as never)
      .returning();
    const input = { vendorId, date: d('2026-06-03'), lines: [{ itemId: item.id, quantity: 3, unitCost: 4 }] };
    const ir = await createItemReceipt(alice, input as never);
    const opened = await version(itemReceipts, ir.id);
    await tick();
    await updateItemReceipt(bob, ir.id, { ...input, memo: 'Bob' } as never);
    const tb = (await trialBalance(alice)).rows;
    const before = await billCount();

    const stale = await irPOST(post(`/api/item-receipts/${ir.id}`, { action: 'convert' }, opened), params(ir.id));
    expect(stale.status).toBe(409);
    expect(await billCount()).toBe(before);
    expect((await trialBalance(alice)).rows).toEqual(tb);

    const ok = await irPOST(post(`/api/item-receipts/${ir.id}`, { action: 'convert' }, await version(itemReceipts, ir.id)), params(ir.id));
    expect(ok.status).toBeLessThan(300);
    expect(await billCount()).toBe(before + 1);
    expect((await trialBalance(alice)).balanced).toBe(true);
  });

  it('the client sends the loaded version on convert for every convertible resource', async () => {
    const loaded = '2026-06-04T10:00:00.000Z';
    for (const resource of ['estimates', 'sales-orders', 'purchase-orders', 'item-receipts']) {
      const id = '22222222-2222-4222-8222-222222222222';
      const sent: Array<Record<string, string> | undefined> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_u: string, init?: RequestInit) => {
          sent.push(init?.headers as Record<string, string> | undefined);
          return new Response(JSON.stringify({ id, updatedAt: loaded, status: 'open' }), { status: 200 });
        }),
      );
      await api.get(`/api/${resource}/${id}`);
      await api.post(`/api/${resource}/${id}`, { action: 'convert' });
      expect(sent[1]?.['x-expected-updated-at'], resource).toBe(loaded);
      // Creating a record (no id in the path) never sends a version.
      await api.post(`/api/${resource}`, { action: 'convert' });
      expect(sent[2]?.['x-expected-updated-at'], resource).toBeUndefined();
      vi.unstubAllGlobals();
    }
  });
});
