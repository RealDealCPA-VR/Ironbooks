/**
 * P1 controls — re-test round 2 (independent tester): record locking on the sales order
 * 'convert' action (fix 30fce5e) through the real route handler and the real client.
 *
 *  - A stale convert names the other user, creates no invoice, leaves the TB, A/R and the order's
 *    invoiced quantities alone.
 *  - Partial converts: a second convert with the version loaded before the first is refused; with
 *    the current version it invoices the remainder. Invoices total the order; TB balances.
 *  - No version header still converts (opt-in locking); another company's order is 404.
 *  - END TO END: the Sales Orders page converts through lib/client.ts api.post(..., { action:
 *    'convert' }). The client must send the version the user loaded, or the server-side check is
 *    never exercised from the UI (the reviewer's "stale tab" case).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, userCompanies, customers, accounts, salesOrders, salesOrderLines, invoices } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createSalesOrder, updateSalesOrder } from './salesOrders';
import { trialBalance } from './reports';
import { api } from '@/lib/client';

let ctx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ctx) }));
import { POST as soPOST } from '@/app/api/sales-orders/[id]/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-concurrency-actions-retest2');
let db: DB;
let alice: ServiceContext;
let bob: ServiceContext;
let stranger: ServiceContext;
const code: Record<string, string> = {};
let customerId: string;
const d = (s: string) => new Date(`${s}T12:00:00Z`);
const tick = () => new Promise((r) => setTimeout(r, 5));

function post(url: string, body: unknown, version?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (version) headers['x-expected-updated-at'] = version;
  return new Request(`http://localhost${url}`, { method: 'POST', headers, body: JSON.stringify(body) }) as never;
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function soRow(id: string) {
  const [r] = await db.select().from(salesOrders).where(eq(salesOrders.id, id));
  return { v: r.updatedAt.toISOString(), status: r.status as string };
}
async function invoicesFor(customer: string) {
  return db.select().from(invoices).where(eq(invoices.customerId, customer));
}
async function invoicedQty(soId: string) {
  return (await db.select().from(salesOrderLines).where(eq(salesOrderLines.salesOrderId, soId))).map((l) =>
    String((l as unknown as { quantityInvoiced: unknown }).quantityInvoiced),
  );
}
async function arBalance() {
  const tb = await trialBalance(alice);
  const row = tb.rows.find((r: { accountId?: string; code?: string }) => r.accountId === code['1200'] || r.code === '1200');
  return row ? JSON.stringify(row) : 'none';
}

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [ua] = await db.insert(users).values({ email: 'alice-r2@test.local', name: 'Alice', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Convert Retest Co', ownerId: ua.id });
  alice = { db, companyId: company.id, userId: ua.id };
  const [ub] = await db.insert(users).values({ email: 'bob-r2@test.local', name: 'Bob Builder', passwordHash: 'x' }).returning();
  await db.insert(userCompanies).values({ userId: ub.id, companyId: company.id, role: 'admin' });
  bob = { db, companyId: company.id, userId: ub.id };
  const [us] = await db.insert(users).values({ email: 'stranger-r2@test.local', name: 'Stranger', passwordHash: 'x' }).returning();
  const c2 = await createCompany(db, { name: 'Stranger Co 2', ownerId: us.id });
  stranger = { db, companyId: c2.id, userId: us.id };
  ctx = alice;
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, alice.companyId))) code[a.code] = a.id;
  customerId = (await db.insert(customers).values({ companyId: alice.companyId, displayName: 'Convert Cust' }).returning())[0].id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('sales order convert: record locking (re-test 2)', () => {
  it('a stale convert names Bob, makes no invoice and moves nothing', async () => {
    ctx = alice;
    const input = { customerId, date: d('2026-05-01'), lines: [{ description: 'Svc', quantity: 2, rate: '30' }] };
    const so = await createSalesOrder(alice, input as never);
    const opened = (await soRow(so.id)).v;
    await tick();
    await updateSalesOrder(bob, so.id, { ...input, memo: 'Bob edit' } as never);
    const tb = (await trialBalance(alice)).rows;
    const invBefore = (await invoicesFor(customerId)).length;
    const qtyBefore = await invoicedQty(so.id);

    const res = await soPOST(post(`/api/sales-orders/${so.id}`, { action: 'convert' }, opened), params(so.id));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.details?.staleVersion).toBe(true);
    expect(JSON.stringify(body)).toMatch(/Bob Builder/);
    expect((await invoicesFor(customerId)).length).toBe(invBefore);
    expect(await invoicedQty(so.id)).toEqual(qtyBefore);
    expect((await trialBalance(alice)).rows).toEqual(tb);
    expect((await soRow(so.id)).status).toBe('open');
  });

  it('partial converts: a second convert with the pre-first version is refused; the current version invoices the rest', async () => {
    ctx = alice;
    const so = await createSalesOrder(alice, {
      customerId,
      date: d('2026-05-02'),
      lines: [{ description: 'Widgets', quantity: 4, rate: '10' }],
    } as never);
    const [line] = await db.select().from(salesOrderLines).where(eq(salesOrderLines.salesOrderId, so.id));
    const v0 = (await soRow(so.id)).v;
    const invBefore = (await invoicesFor(customerId)).length;

    const r1 = await soPOST(
      post(`/api/sales-orders/${so.id}`, { action: 'convert', lines: [{ lineId: line.id, quantity: 1 }] }, v0),
      params(so.id),
    );
    expect(r1.status).toBe(201);
    const v1 = (await soRow(so.id)).v;
    expect(v1).not.toBe(v0);

    // A second tab still holding v0 cannot convert again.
    const stale = await soPOST(post(`/api/sales-orders/${so.id}`, { action: 'convert' }, v0), params(so.id));
    expect(stale.status).toBe(409);
    expect((await invoicesFor(customerId)).length).toBe(invBefore + 1);

    const r2 = await soPOST(post(`/api/sales-orders/${so.id}`, { action: 'convert' }, v1), params(so.id));
    expect(r2.status).toBe(201);
    const mine = (await invoicesFor(customerId)).slice(invBefore);
    expect(mine.length).toBe(2);
    const total = Money.add(...mine.map((i) => String((i as unknown as { total: unknown }).total)));
    expect(total.toFixed(2)).toBe('40.00');
    expect((await trialBalance(alice)).balanced).toBe(true);
    expect((await soRow(so.id)).status).not.toBe('open');
  });

  it('no version header still converts; another company gets 404 and nothing is created', async () => {
    ctx = alice;
    const so1 = await createSalesOrder(alice, { customerId, date: d('2026-05-03'), lines: [{ description: 'a', quantity: 1, rate: '5' }] } as never);
    const so2 = await createSalesOrder(alice, { customerId, date: d('2026-05-03'), lines: [{ description: 'b', quantity: 1, rate: '6' }] } as never);
    const noHeader = await soPOST(post(`/api/sales-orders/${so1.id}`, { action: 'convert' }), params(so1.id));
    expect(noHeader.status).toBe(201);

    const v2 = (await soRow(so2.id)).v;
    const invBefore = (await invoicesFor(customerId)).length;
    const ar = await arBalance();
    ctx = stranger;
    try {
      const res = await soPOST(post(`/api/sales-orders/${so2.id}`, { action: 'convert' }, v2), params(so2.id));
      expect(res.status).toBe(404);
    } finally {
      ctx = alice;
    }
    expect(await soRow(so2.id)).toEqual({ v: v2, status: 'open' });
    expect((await invoicesFor(customerId)).length).toBe(invBefore);
    expect(await arBalance()).toBe(ar);
  });

  it('END TO END: the client sends the loaded sales order version on convert (what the Sales Orders page calls)', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const loaded = '2026-05-04T10:00:00.000Z';
    const sent: Array<{ method?: string; headers?: Record<string, string> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init?: RequestInit) => {
        sent.push({ method: init?.method, headers: init?.headers as Record<string, string> | undefined });
        return new Response(JSON.stringify({ id, updatedAt: loaded, status: 'open' }), { status: 200 });
      }),
    );
    await api.get(`/api/sales-orders/${id}`);
    // Control: the 'status' action already carries the version.
    await api.post(`/api/sales-orders/${id}`, { action: 'status', status: 'closed' });
    expect(sent[1].headers?.['x-expected-updated-at']).toBe(loaded);
    // app/sales-orders/page.tsx: api.post(`/api/sales-orders/${order.id}`, { action: 'convert', lines, overrideCreditLimit })
    await api.get(`/api/sales-orders/${id}`);
    await api.post(`/api/sales-orders/${id}`, { action: 'convert' });
    expect(sent[3].headers?.['x-expected-updated-at'], 'convert must send the version the user loaded').toBe(loaded);
  });
});
