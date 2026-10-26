/**
 * Review round 5 — inventory routes driven through the real handlers: bad input (a date that is
 * not a date, a quantity / cost that is not a number) must answer 400 with a plain message, never
 * an HTTP 500 from a RangeError / MoneyParseError deep in a service.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  headers: new Map<string, string>(),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (h.cookies.has(n) ? { name: n, value: h.cookies.get(n)! } : undefined),
  }),
  headers: async () => new Headers([...h.headers.entries()]),
}));

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-inventory-routes');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'review5-inventory-routes-secret';

import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, items, users } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { createSessionToken, hashPassword, SESSION_COOKIE } from '@/lib/auth';
import { COMPANY_COOKIE } from '@/lib/context';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { createCompany } from './company';
import { createItem } from './items';
import { adjustInventory } from './inventory';
import { setBom } from './assemblies';
import { POST as inventoryPOST } from '@/app/api/inventory/route';
import { POST as fifoPOST } from '@/app/api/fifo/route';
import { POST as physicalCountPOST } from '@/app/api/inventory/physical-count/route';
import { POST as valueAdjustPOST } from '@/app/api/inventory/value-adjust/route';
import { POST as batchCountPOST } from '@/app/api/inventory/batch-count/route';
import { POST as pendingPOST } from '@/app/api/assemblies/pending/route';
import { POST as buildPOST } from '@/app/api/assemblies/build/route';
import { PUT as bomPUT } from '@/app/api/assemblies/route';

let db: DB;
let owner: string;
let companyId: string;
const acct: Record<string, string> = {};
let avgItem: string;
let kit: string;

type Handler = (r: NextRequest, c: never) => Promise<Response>;

function as(method: string, routePath: string) {
  h.headers.clear();
  h.headers.set(ROUTE_PATH_HEADER, routePath);
  h.headers.set(ROUTE_METHOD_HEADER, method);
  h.cookies.clear();
  h.cookies.set(SESSION_COOKIE, createSessionToken(owner));
  h.cookies.set(COMPANY_COOKIE, companyId);
}
async function call(handler: Handler, method: string, route: string, body: unknown) {
  as(method, route);
  const res = await handler(
    new NextRequest(`http://127.0.0.1${route}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    undefined as never,
  );
  return { status: res.status, data: (await res.json().catch(() => null)) as { error?: string; code?: string } | null };
}

function expect400(r: { status: number; data: { error?: string; code?: string } | null }) {
  expect(r.status, JSON.stringify(r.data)).toBe(400);
  expect(r.data?.code).toBe('VALIDATION');
  expect(r.data?.error).toBeTruthy();
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'owner@review5-inv.local', name: 'Owner', passwordHash: await hashPassword('pass12345') }).returning();
  owner = u.id;
  companyId = (await createCompany(db, { name: 'Review5 Inventory Routes Co', ownerId: owner })).id;
  for (const code of ['1300', '4000', '5000']) {
    const [row] = await db.select().from(accounts).where(and(eq(accounts.companyId, companyId), eq(accounts.code, code)));
    acct[code] = row.id;
  }
  const ctx = { db, companyId, userId: owner };
  const mk = async (name: string) =>
    (await createItem(ctx, { name, type: 'inventory', incomeAccountId: acct['4000'], expenseAccountId: acct['5000'], assetAccountId: acct['1300'] })).id;
  avgItem = await mk('Route widget');
  await adjustInventory(ctx, { itemId: avgItem, quantityChange: 10, unitCost: '2.00', date: new Date('2026-01-02T12:00:00Z') });
  kit = await mk('Route kit');
  await setBom(ctx, kit, [{ componentItemId: avgItem, quantity: '1' }]);
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('inventory routes: bad input answers 400, never 500', () => {
  it('POST /api/inventory (adjust / cogs)', async () => {
    expect400(await call(inventoryPOST as Handler, 'POST', '/api/inventory', { action: 'adjust', itemId: avgItem, quantityChange: '-1', date: 'garbage' }));
    expect400(await call(inventoryPOST as Handler, 'POST', '/api/inventory', { action: 'adjust', itemId: avgItem, quantityChange: 'abc', date: '2026-02-01' }));
    expect400(await call(inventoryPOST as Handler, 'POST', '/api/inventory', { action: 'adjust', itemId: avgItem, quantityChange: '1', unitCost: 'x', date: '2026-02-01' }));
    expect400(await call(inventoryPOST as Handler, 'POST', '/api/inventory', { action: 'cogs', itemId: avgItem, quantity: '1', date: '2026-02-30' }));
    const [row] = await db.select().from(items).where(eq(items.id, avgItem));
    expect(row.quantityOnHand).toBe('10.0000');
  });

  it('POST /api/fifo (receive / consume)', async () => {
    expect400(await call(fifoPOST as Handler, 'POST', '/api/fifo', { action: 'receive', itemId: avgItem, quantity: '2', unitCost: 'abc', date: '2026-02-01' }));
    expect400(await call(fifoPOST as Handler, 'POST', '/api/fifo', { action: 'receive', itemId: avgItem, quantity: '2', unitCost: '1.00', date: 'nope' }));
    expect400(await call(fifoPOST as Handler, 'POST', '/api/fifo', { action: 'consume', itemId: avgItem, quantity: 'lots', date: '2026-02-01' }));
  });

  it('POST /api/inventory/physical-count', async () => {
    expect400(await call(physicalCountPOST as Handler, 'POST', '/api/inventory/physical-count', { itemId: avgItem, countedQty: 'ten', date: '2026-02-01' }));
    expect400(await call(physicalCountPOST as Handler, 'POST', '/api/inventory/physical-count', { itemId: avgItem, countedQty: '8', date: 'garbage' }));
  });

  it('POST /api/inventory/value-adjust', async () => {
    expect400(await call(valueAdjustPOST as Handler, 'POST', '/api/inventory/value-adjust', { itemId: avgItem, newTotalValue: 'abc', date: '2026-02-01' }));
    expect400(await call(valueAdjustPOST as Handler, 'POST', '/api/inventory/value-adjust', { itemId: avgItem, newUnitCost: '3', date: 'garbage' }));
  });

  it('POST /api/inventory/batch-count', async () => {
    expect400(await call(batchCountPOST as Handler, 'POST', '/api/inventory/batch-count', { date: 'garbage', counts: [{ itemId: avgItem, countedQty: '9' }] }));
    const r = await call(batchCountPOST as Handler, 'POST', '/api/inventory/batch-count', { date: '2026-02-01', counts: [{ itemId: avgItem, countedQty: 'nine' }] });
    expect(r.status).toBeLessThan(500);
    const [row] = await db.select().from(items).where(eq(items.id, avgItem));
    expect(row.quantityOnHand).toBe('10.0000');
  });

  it('assemblies: pending build, build and BOM', async () => {
    expect400(await call(pendingPOST as Handler, 'POST', '/api/assemblies/pending', { assemblyItemId: kit, quantity: '1', date: 'garbage' }));
    expect400(await call(pendingPOST as Handler, 'POST', '/api/assemblies/pending', { assemblyItemId: kit, quantity: 'one', date: '2026-02-01' }));
    expect400(await call(buildPOST as Handler, 'POST', '/api/assemblies/build', { assemblyItemId: kit, quantity: 'one', action: 'build' }));
    expect400(await call(bomPUT as Handler, 'PUT', '/api/assemblies', { assemblyItemId: kit, components: [{ componentItemId: avgItem, quantity: 'two' }] }));
  });
});
