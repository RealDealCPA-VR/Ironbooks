/**
 * Tester re-test 3: record locking on 'convert' (fix c0cf4c9), adversarial cases.
 *
 * - Replay: a convert with the version the record had BEFORE a successful convert is refused
 *   (the convert itself moves the source's version), for estimates, purchase orders and item
 *   receipts; exactly one invoice/bill exists and the TB balances.
 * - Race: two simultaneous converts holding the same (current) version — exactly one wins.
 * - Isolation: another company's user, even holding the right version, gets 404 and nothing is
 *   created in either company.
 * - Client: the version rides along on the closing-date-password retry of a convert; after a
 *   convert the source's version is forgotten (documented limit) and a reload restores it; the
 *   new invoice's version is never filed under the source record's URL.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, userCompanies, vendors, customers, accounts, items, estimates, purchaseOrders, itemReceipts, invoices, bills } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createEstimate } from './estimates';
import { createPurchaseOrder } from './purchaseOrders';
import { createItemReceipt } from './itemReceipts';
import { trialBalance } from './reports';
import { api, setClosingPasswordPrompt } from '@/lib/client';

let ctx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ctx) }));
import { POST as estPOST } from '@/app/api/estimates/[id]/route';
import { POST as poPOST } from '@/app/api/purchase-orders/[id]/route';
import { POST as irPOST } from '@/app/api/item-receipts/[id]/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-concurrency-convert-r3');
let db: DB;
let alice: ServiceContext;
let stranger: ServiceContext;
const code: Record<string, string> = {};
let vendorId: string;
let customerId: string;
let itemId: string;
const d = (s: string) => new Date(`${s}T12:00:00Z`);

function post(url: string, body: unknown, version?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (version) headers['x-expected-updated-at'] = version;
  return new Request(`http://localhost${url}`, { method: 'POST', headers, body: JSON.stringify(body) }) as never;
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
type T = typeof estimates | typeof purchaseOrders | typeof itemReceipts;
async function version(t: T, id: string) {
  const [r] = await db.select({ v: t.updatedAt }).from(t as typeof estimates).where(eq(t.id, id));
  return r.v.toISOString();
}
const invoiceCount = async (companyId = alice.companyId) =>
  (await db.select().from(invoices).where(and(eq(invoices.companyId, companyId), eq(invoices.customerId, customerId)))).length;
const billCount = async (companyId = alice.companyId) =>
  (await db.select().from(bills).where(and(eq(bills.companyId, companyId), eq(bills.vendorId, vendorId)))).length;
const allInvoices = async (companyId: string) => (await db.select().from(invoices).where(eq(invoices.companyId, companyId))).length;
const allBills = async (companyId: string) => (await db.select().from(bills).where(eq(bills.companyId, companyId))).length;

afterEach(() => {
  vi.unstubAllGlobals();
  setClosingPasswordPrompt(null);
});

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [ua] = await db.insert(users).values({ email: 'alice-r3@test.local', name: 'Alice', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Convert R3 Co', ownerId: ua.id });
  alice = { db, companyId: company.id, userId: ua.id };
  const [ub] = await db.insert(users).values({ email: 'bob-r3@test.local', name: 'Bob', passwordHash: 'x' }).returning();
  await db.insert(userCompanies).values({ userId: ub.id, companyId: company.id, role: 'admin' });
  const [us] = await db.insert(users).values({ email: 'stranger-r3@test.local', name: 'Stranger', passwordHash: 'x' }).returning();
  const c2 = await createCompany(db, { name: 'Stranger R3 Co', ownerId: us.id });
  stranger = { db, companyId: c2.id, userId: us.id };
  ctx = alice;
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, alice.companyId))) code[a.code] = a.id;
  vendorId = (await db.insert(vendors).values({ companyId: alice.companyId, displayName: 'Depot R3' }).returning())[0].id;
  customerId = (await db.insert(customers).values({ companyId: alice.companyId, displayName: 'Acme R3' }).returning())[0].id;
  itemId = (
    await db
      .insert(items)
      .values({ companyId: alice.companyId, name: 'Gizmo R3', type: 'inventory', quantityOnHand: '0', averageCost: '0' } as never)
      .returning()
  )[0].id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const newEstimate = (date: string) =>
  createEstimate(alice, { customerId, date: d(date), lines: [{ description: 'Consulting', quantity: 1, rate: 50 }] } as never);
const newPO = (date: string) =>
  createPurchaseOrder(alice, { vendorId, date: d(date), lines: [{ accountId: code['6300'], quantity: '1', rate: '10' }] } as never);
const newIR = (date: string) =>
  createItemReceipt(alice, { vendorId, date: d(date), lines: [{ itemId, quantity: 2, unitCost: 3 }] } as never);

describe('convert replay: the pre-convert version cannot convert again', () => {
  it('estimate', async () => {
    ctx = alice;
    const est = await newEstimate('2026-07-01');
    const v0 = await version(estimates, est.id);
    const before = await invoiceCount();
    const r1 = await estPOST(post(`/api/estimates/${est.id}`, { action: 'convert' }, v0), params(est.id));
    expect(r1.status).toBe(201);
    expect(await version(estimates, est.id)).not.toBe(v0);
    const replay = await estPOST(post(`/api/estimates/${est.id}`, { action: 'convert' }, v0), params(est.id));
    expect(replay.status).toBe(409);
    expect(await invoiceCount()).toBe(before + 1);
    expect((await trialBalance(alice)).balanced).toBe(true);
  });

  it('purchase order', async () => {
    ctx = alice;
    const po = await newPO('2026-07-02');
    const v0 = await version(purchaseOrders, po.id);
    const before = await billCount();
    const r1 = await poPOST(post(`/api/purchase-orders/${po.id}`, { action: 'convert' }, v0), params(po.id));
    expect(r1.status).toBeLessThan(300);
    expect(await version(purchaseOrders, po.id)).not.toBe(v0);
    const replay = await poPOST(post(`/api/purchase-orders/${po.id}`, { action: 'convert' }, v0), params(po.id));
    expect(replay.status).toBe(409);
    expect(await billCount()).toBe(before + 1);
    expect((await trialBalance(alice)).balanced).toBe(true);
  });

  it('item receipt', async () => {
    ctx = alice;
    const ir = await newIR('2026-07-03');
    const v0 = await version(itemReceipts, ir.id);
    const before = await billCount();
    const r1 = await irPOST(post(`/api/item-receipts/${ir.id}`, { action: 'convert' }, v0), params(ir.id));
    expect(r1.status).toBeLessThan(300);
    expect(await version(itemReceipts, ir.id)).not.toBe(v0);
    const replay = await irPOST(post(`/api/item-receipts/${ir.id}`, { action: 'convert' }, v0), params(ir.id));
    expect(replay.status).toBe(409);
    expect(await billCount()).toBe(before + 1);
    expect((await trialBalance(alice)).balanced).toBe(true);
  });
});

describe('convert race: two tabs with the same current version, exactly one wins', () => {
  it('estimate, purchase order and item receipt', async () => {
    ctx = alice;
    const est = await newEstimate('2026-07-04');
    const po = await newPO('2026-07-04');
    const ir = await newIR('2026-07-04');
    const ve = await version(estimates, est.id);
    const vp = await version(purchaseOrders, po.id);
    const vi_ = await version(itemReceipts, ir.id);
    const inv0 = await invoiceCount();
    const bill0 = await billCount();

    const est2 = await Promise.all([
      estPOST(post(`/api/estimates/${est.id}`, { action: 'convert' }, ve), params(est.id)),
      estPOST(post(`/api/estimates/${est.id}`, { action: 'convert' }, ve), params(est.id)),
    ]);
    const po2 = await Promise.all([
      poPOST(post(`/api/purchase-orders/${po.id}`, { action: 'convert' }, vp), params(po.id)),
      poPOST(post(`/api/purchase-orders/${po.id}`, { action: 'convert' }, vp), params(po.id)),
    ]);
    const ir2 = await Promise.all([
      irPOST(post(`/api/item-receipts/${ir.id}`, { action: 'convert' }, vi_), params(ir.id)),
      irPOST(post(`/api/item-receipts/${ir.id}`, { action: 'convert' }, vi_), params(ir.id)),
    ]);
    for (const pair of [est2, po2, ir2]) {
      const ok = pair.filter((r) => r.status < 300).length;
      expect(ok).toBe(1);
      expect(pair.map((r) => r.status).filter((s) => s >= 300)[0]).toBeGreaterThanOrEqual(400);
    }
    expect(await invoiceCount()).toBe(inv0 + 1);
    expect(await billCount()).toBe(bill0 + 2);
    expect((await trialBalance(alice)).balanced).toBe(true);
  });
});

describe('isolation: another company cannot convert even with the right version', () => {
  it('estimate, purchase order and item receipt → 404, nothing created anywhere', async () => {
    ctx = alice;
    const est = await newEstimate('2026-07-05');
    const po = await newPO('2026-07-05');
    const ir = await newIR('2026-07-05');
    const ve = await version(estimates, est.id);
    const vp = await version(purchaseOrders, po.id);
    const vir = await version(itemReceipts, ir.id);
    const counts = async () => [
      await allInvoices(alice.companyId),
      await allBills(alice.companyId),
      await allInvoices(stranger.companyId),
      await allBills(stranger.companyId),
    ];
    const before = await counts();
    const tb = (await trialBalance(alice)).rows;
    ctx = stranger;
    try {
      expect((await estPOST(post(`/api/estimates/${est.id}`, { action: 'convert' }, ve), params(est.id))).status).toBe(404);
      expect((await poPOST(post(`/api/purchase-orders/${po.id}`, { action: 'convert' }, vp), params(po.id))).status).toBe(404);
      expect((await irPOST(post(`/api/item-receipts/${ir.id}`, { action: 'convert' }, vir), params(ir.id))).status).toBe(404);
    } finally {
      ctx = alice;
    }
    expect(await counts()).toEqual(before);
    expect((await trialBalance(alice)).rows).toEqual(tb);
    expect(await version(estimates, est.id)).toBe(ve);
    expect(await version(purchaseOrders, po.id)).toBe(vp);
    expect(await version(itemReceipts, ir.id)).toBe(vir);
  });
});

describe('client: convert carries the version through retries and forgets it afterwards', () => {
  const SRC = '33333333-3333-4333-8333-333333333333';
  const NEW = '44444444-4444-4444-8444-444444444444';
  const loaded = '2026-07-06T10:00:00.000Z';

  it('the closing-date-password retry of a convert still sends the loaded version', async () => {
    const sent: Array<Record<string, string>> = [];
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init?: RequestInit) => {
        sent.push((init?.headers as Record<string, string>) ?? {});
        n++;
        if (n === 1) return new Response(JSON.stringify({ id: SRC, updatedAt: loaded }), { status: 200 });
        if (n === 2)
          return new Response(JSON.stringify({ error: 'This date is on or before the closing date.', code: 'PERIOD_CLOSED' }), {
            status: 403,
          });
        return new Response(JSON.stringify({ id: NEW, updatedAt: '2026-07-06T11:00:00.000Z' }), { status: 201 });
      }),
    );
    setClosingPasswordPrompt(async () => 'secret');
    for (const resource of ['estimates']) {
      await api.get(`/api/${resource}/${SRC}`);
      await api.post(`/api/${resource}/${SRC}`, { action: 'convert' });
      expect(sent[1]['x-expected-updated-at']).toBe(loaded);
      expect(sent[2]['x-expected-updated-at']).toBe(loaded);
      expect(sent[2]['x-closing-password']).toBe('secret');
    }
  });

  it('after a convert the new invoice/bill version is not filed under the source; a reload restores the check', async () => {
    for (const resource of ['estimates', 'sales-orders', 'purchase-orders', 'item-receipts']) {
      const sent: Array<Record<string, string>> = [];
      let reply: unknown = { id: SRC, updatedAt: loaded, status: 'open' };
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_u: string, init?: RequestInit) => {
          sent.push((init?.headers as Record<string, string>) ?? {});
          return new Response(JSON.stringify(reply), { status: 200 });
        }),
      );
      await api.get(`/api/${resource}/${SRC}`);
      // Convert replies with the NEW invoice/bill.
      reply = { id: NEW, updatedAt: '2030-01-01T00:00:00.000Z' };
      await api.post(`/api/${resource}/${SRC}`, { action: 'convert' });
      expect(sent[1]['x-expected-updated-at'], resource).toBe(loaded);
      // The next action on the source never carries the invoice's version (a false 409).
      await api.post(`/api/${resource}/${SRC}`, { action: 'status', status: 'closed' });
      expect(sent[2]['x-expected-updated-at'], resource).not.toBe('2030-01-01T00:00:00.000Z');
      // Reload restores the check with the source's fresh version.
      reply = { id: SRC, updatedAt: '2026-07-06T12:00:00.000Z', status: 'closed' };
      await api.get(`/api/${resource}/${SRC}`);
      await api.post(`/api/${resource}/${SRC}`, { action: 'void' });
      expect(sent[4]['x-expected-updated-at'], resource).toBe('2026-07-06T12:00:00.000Z');
      vi.unstubAllGlobals();
    }
  });

  it('a 409 on convert does not drop the loaded version (the user can reload, not silently overwrite)', async () => {
    const sent: Array<Record<string, string>> = [];
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init?: RequestInit) => {
        sent.push((init?.headers as Record<string, string>) ?? {});
        n++;
        if (n === 1) return new Response(JSON.stringify({ id: SRC, updatedAt: loaded }), { status: 200 });
        return new Response(JSON.stringify({ error: 'This record was changed by Bob.', code: 'CONFLICT' }), { status: 409 });
      }),
    );
    await api.get(`/api/purchase-orders/${SRC}`);
    await expect(api.post(`/api/purchase-orders/${SRC}`, { action: 'convert' })).rejects.toThrow();
    // A retry from the same stale tab still carries the stale version and is refused again.
    await expect(api.post(`/api/purchase-orders/${SRC}`, { action: 'convert' })).rejects.toThrow();
    expect(sent[2]['x-expected-updated-at']).toBe(loaded);
  });
});
