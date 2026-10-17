/**
 * Review round 4 (runtime crawl, scripts/crawl.mjs): regression tests for the HTTP 500s the crawl
 * found on reachable input, driven through the real route handlers.
 *
 *  1. PERIOD_CLOSED answered 500 by hand-rolled ServiceError → status maps (now lib/routeErrors.ts
 *     serviceErrorStatus everywhere).
 *  2. PATCH /api/jobs/:id {} → drizzle "No values to set".
 *  3. GET /api/reports/commissions?from=garbage → RangeError.
 *  4. Malformed JSON / `null` / wrong-typed bodies → SyntaxError / TypeError (74 route+method pairs).
 *  5. A pay run where every check is refused left an empty pay-run header behind (HTTP 201).
 *  +  Opening stock opened a FIFO layer, so the item could not be built, counted or revalued.
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

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review4-crawl');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'review4-crawl-secret';

import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, fiscalPeriods, inventoryLayers, items, payRuns, users } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { createSessionToken, hashPassword, SESSION_COOKIE } from '@/lib/auth';
import { COMPANY_COOKIE } from '@/lib/context';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { serviceErrorStatus } from '@/lib/routeErrors';
import { createCompany } from './company';
import { POST as transfersPOST } from '@/app/api/transfers/route';
import { POST as depositsPOST } from '@/app/api/deposits/route';
import { POST as billsPOST } from '@/app/api/bills/route';
import { DELETE as billDELETE } from '@/app/api/bills/[id]/route';
import { POST as billPaymentsPOST } from '@/app/api/bill-payments/route';
import { POST as salesReceiptsPOST } from '@/app/api/sales-receipts/route';
import { POST as payrollPOST } from '@/app/api/payroll/route';
import { POST as payRunsPOST } from '@/app/api/payroll/pay-runs/route';
import { POST as poPOST } from '@/app/api/purchase-orders/route';
import { POST as poActionPOST } from '@/app/api/purchase-orders/[id]/route';
import { POST as vendorsPOST } from '@/app/api/vendors/route';
import { POST as itemsPOST } from '@/app/api/items/route';
import { POST as employeesPOST } from '@/app/api/employees/route';
import { POST as jobsPOST } from '@/app/api/jobs/route';
import { PATCH as jobPATCH } from '@/app/api/jobs/[id]/route';
import { GET as commissionsGET } from '@/app/api/reports/commissions/route';
import { POST as taxRatesPOST } from '@/app/api/tax-rates/route';
import { POST as taxAgenciesPOST } from '@/app/api/tax-agencies/route';
import { POST as salesRepsPOST } from '@/app/api/sales-reps/route';
import { PATCH as salesRepPATCH } from '@/app/api/sales-reps/[id]/route';
import { POST as expenseReportsPOST } from '@/app/api/expense-reports/route';
import { POST as excludePOST } from '@/app/api/bank-transactions/exclude/route';
import { POST as fxAdjustPOST } from '@/app/api/currencies/fx-adjustment/route';
import { PUT as assembliesPUT } from '@/app/api/assemblies/route';
import { POST as buildPOST } from '@/app/api/assemblies/build/route';
import { POST as physicalCountPOST } from '@/app/api/inventory/physical-count/route';
import { POST as valueAdjustPOST } from '@/app/api/inventory/value-adjust/route';

let db: DB;
let owner: string;
let companyId: string;
const acct: Record<string, string> = {};
const CLOSED = '2026-01-15';
const NO_ID = '00000000-0000-4000-8000-000000000000';

type Handler = (r: NextRequest, c: never) => Promise<Response>;

function as(method: string, routePath: string) {
  h.headers.clear();
  h.headers.set(ROUTE_PATH_HEADER, routePath);
  h.headers.set(ROUTE_METHOD_HEADER, method);
  h.cookies.clear();
  h.cookies.set(SESSION_COOKIE, createSessionToken(owner));
  h.cookies.set(COMPANY_COOKIE, companyId);
}
function req(method: string, url: string, body?: unknown, raw?: string) {
  return new NextRequest(`http://127.0.0.1${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) });
async function call(handler: Handler, method: string, route: string, body?: unknown, opts: { id?: string; raw?: string; query?: string } = {}) {
  const url = route.replace('[id]', opts.id ?? '') + (opts.query ?? '');
  as(method, route.includes('[id]') ? url.split('?')[0] : route);
  const res = await handler(req(method, url, body, opts.raw), (opts.id ? params({ id: opts.id }) : undefined) as never);
  return { status: res.status, data: await res.json().catch(() => null) };
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'owner@review4.local', name: 'Owner', passwordHash: await hashPassword('pass12345') }).returning();
  owner = u.id;
  companyId = (await createCompany(db, { name: 'Review4 Crawl Co', ownerId: owner })).id;
  for (const code of ['1000', '1010', '1300', '3000', '4000', '4100', '5000', '6000', '6400']) {
    const [row] = await db.select().from(accounts).where(and(eq(accounts.companyId, companyId), eq(accounts.code, code)));
    acct[code] = row.id;
  }
  // Close January 2026 (Fiscal Periods screen).
  await db.insert(fiscalPeriods).values({
    companyId,
    periodStart: new Date('2026-01-01T00:00:00Z'),
    periodEnd: new Date('2026-01-31T00:00:00Z'),
    isClosed: true,
    closedAt: new Date(),
  });
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('shared ServiceError → HTTP status map', () => {
  it('maps every ServiceError code (PERIOD_CLOSED included) and honours per-route overrides', () => {
    expect(serviceErrorStatus('NOT_FOUND')).toBe(404);
    expect(serviceErrorStatus('VALIDATION')).toBe(400);
    expect(serviceErrorStatus('UNBALANCED')).toBe(400);
    expect(serviceErrorStatus('PERIOD_CLOSED')).toBe(400);
    expect(serviceErrorStatus('FORBIDDEN')).toBe(403);
    expect(serviceErrorStatus('CONFLICT')).toBe(409);
    expect(serviceErrorStatus('INTERNAL')).toBe(500);
    expect(serviceErrorStatus('SOMETHING_ELSE')).toBe(500);
    expect(serviceErrorStatus('toString')).toBe(500); // own keys only
    expect(serviceErrorStatus('PERIOD_CLOSED', { PERIOD_CLOSED: 422 })).toBe(422);
    expect(serviceErrorStatus('NOT_FOUND', { PERIOD_CLOSED: 422 })).toBe(404);
  });
});

describe('PERIOD_CLOSED must be a 4xx on every posting route', () => {
  let vendorId: string;
  let itemId: string;
  let employeeId: string;
  let openBillId: string;

  beforeAll(async () => {
    vendorId = (await call(vendorsPOST as Handler, 'POST', '/api/vendors', { displayName: 'Closed Vendor' })).data.id;
    itemId = (await call(itemsPOST as Handler, 'POST', '/api/items', { name: 'Svc', type: 'service', salesPrice: '10', incomeAccountId: acct['4100'], expenseAccountId: acct['6400'] })).data.item.id;
    employeeId = (await call(employeesPOST as Handler, 'POST', '/api/employees', { firstName: 'Eve', lastName: 'W', payType: 'hourly', payRate: '20' })).data.id;
    openBillId = (await call(billsPOST as Handler, 'POST', '/api/bills', { vendorId, billNumber: 'OPEN-1', date: '2026-03-01', lines: [{ accountId: acct['6400'], amount: '100.00' }] })).data.id;
  });

  const expectClosed = (r: { status: number; data: { code?: string } | null }) => {
    expect(r.data?.code).toBe('PERIOD_CLOSED');
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  };

  it('POST /api/transfers', async () => {
    expectClosed(await call(transfersPOST as Handler, 'POST', '/api/transfers', { date: CLOSED, fromAccountId: acct['1000'], toAccountId: acct['1010'], amount: '10.00' }));
  });
  it('POST /api/deposits', async () => {
    expectClosed(await call(depositsPOST as Handler, 'POST', '/api/deposits', { depositAccountId: acct['1000'], date: CLOSED, extraLines: [{ accountId: acct['3000'], amount: '10.00' }] }));
  });
  it('POST /api/bills', async () => {
    expectClosed(await call(billsPOST as Handler, 'POST', '/api/bills', { vendorId, billNumber: 'CLOSED-1', date: CLOSED, lines: [{ accountId: acct['6400'], amount: '10.00' }] }));
  });
  it('POST /api/bill-payments', async () => {
    expectClosed(await call(billPaymentsPOST as Handler, 'POST', '/api/bill-payments', {
      vendorId, date: CLOSED, method: 'check', paymentAccountId: acct['1000'], applications: [{ billId: openBillId, amountApplied: '10.00' }],
    }));
  });
  it('POST /api/sales-receipts', async () => {
    expectClosed(await call(salesReceiptsPOST as Handler, 'POST', '/api/sales-receipts', { date: CLOSED, method: 'cash', lines: [{ itemId, quantity: '1', rate: '10' }] }));
  });
  it('POST /api/payroll (paycheck)', async () => {
    expectClosed(await call(payrollPOST as Handler, 'POST', '/api/payroll', { employeeId, payDate: CLOSED, earnings: [{ kind: 'regular', hours: '1', rate: '20' }] }));
  });
  it('POST /api/purchase-orders/:id {action:"convert"}', async () => {
    const po = await call(poPOST as Handler, 'POST', '/api/purchase-orders', { vendorId, date: '2026-03-01', lines: [{ itemId, quantity: '1', rate: '5' }] });
    expectClosed(await call(poActionPOST as Handler, 'POST', '/api/purchase-orders/[id]', { action: 'convert', date: CLOSED }, { id: po.data.id }));
  });
  it('POST /api/currencies/fx-adjustment', async () => {
    expectClosed(await call(fxAdjustPOST as Handler, 'POST', '/api/currencies/fx-adjustment', { accountId: acct['1000'], amount: '5.00', gain: true, date: CLOSED }));
  });
  it('POST /api/payroll/pay-runs: every check refused → 4xx and NO empty pay-run header', async () => {
    const before = (await db.select().from(payRuns).where(eq(payRuns.companyId, companyId))).length;
    const r = await call(payRunsPOST as Handler, 'POST', '/api/payroll/pay-runs', { payDate: CLOSED, employees: [{ employeeId, hours: '1' }] });
    expectClosed(r);
    expect(r.data?.details?.results?.[0]?.ok).toBe(false);
    expect((await db.select().from(payRuns).where(eq(payRuns.companyId, companyId))).length).toBe(before);
    // A run with at least one good check still posts (201) and keeps its header.
    const ok = await call(payRunsPOST as Handler, 'POST', '/api/payroll/pay-runs', { payDate: '2026-03-13', employees: [{ employeeId, hours: '1' }] });
    expect(ok.status).toBe(201);
    expect(ok.data.payRun.id).toBeTruthy();
    expect((await db.select().from(payRuns).where(eq(payRuns.companyId, companyId))).length).toBe(before + 1);
  });
  it('DELETE /api/bills/:id of a bill dated in a closed period', async () => {
    const b = await call(billsPOST as Handler, 'POST', '/api/bills', { vendorId, billNumber: 'FEB-1', date: '2026-02-10', lines: [{ accountId: acct['6400'], amount: '10.00' }] });
    await db.insert(fiscalPeriods).values({ companyId, periodStart: new Date('2026-02-01T00:00:00Z'), periodEnd: new Date('2026-02-28T00:00:00Z'), isClosed: true, closedAt: new Date() });
    expectClosed(await call(billDELETE as unknown as Handler, 'DELETE', '/api/bills/[id]', undefined, { id: b.data.id }));
  });
});

describe('other reachable 500s', () => {
  it('PATCH /api/jobs/:id with an empty body is a no-op, not "No values to set"', async () => {
    const job = await call(jobsPOST as Handler, 'POST', '/api/jobs', { name: 'Remodel' });
    const r = await call(jobPATCH as unknown as Handler, 'PATCH', '/api/jobs/[id]', {}, { id: job.data.id });
    expect(r.status).toBe(200);
    expect(r.data.name).toBe('Remodel');
  });
  it('GET /api/reports/commissions?from=garbage answers 400, not RangeError → 500', async () => {
    as('GET', '/api/reports/commissions');
    expect((await commissionsGET(req('GET', '/api/reports/commissions?from=garbage&to=2026-12-31'))).status).toBe(400);
    as('GET', '/api/reports/commissions');
    expect((await commissionsGET(req('GET', '/api/reports/commissions?from=2026-01-01&to=2026-12-31'))).status).toBe(200);
  });
  it('non-string names and bad expense lines answer 400 (no TypeError → 500)', async () => {
    expect((await call(taxRatesPOST as Handler, 'POST', '/api/tax-rates', { name: 123, rate: '0.05' })).status).toBe(400);
    expect((await call(taxAgenciesPOST as Handler, 'POST', '/api/tax-agencies', { name: ['x'] })).status).toBe(400);
    expect((await call(salesRepsPOST as Handler, 'POST', '/api/sales-reps', { name: 7 })).status).toBe(400);
    const rep = await call(salesRepsPOST as Handler, 'POST', '/api/sales-reps', { name: 'Rep One' });
    expect(rep.status).toBe(201);
    expect((await call(salesRepPATCH as unknown as Handler, 'PATCH', '/api/sales-reps/[id]', { name: 7 }, { id: rep.data.id })).status).toBe(400);
    expect((await call(expenseReportsPOST as Handler, 'POST', '/api/expense-reports', { title: 'T', lines: [null, 5] })).status).toBe(400);
    expect((await call(expenseReportsPOST as Handler, 'POST', '/api/expense-reports', { title: 'T', lines: [{ accountId: acct['6000'], date: 'nope', amount: '5' }] })).status).toBe(400);
  });
  it('POST /api/bank-transactions/exclude with a malformed JSON body answers 400', async () => {
    expect((await call(excludePOST as Handler, 'POST', '/api/bank-transactions/exclude', undefined, { raw: '{"a":' })).status).toBe(400);
  });
});

// The 74 (method, route) pairs the crawl saw answer 500 to a malformed / null / non-object body.
const INVALID_BODY_PAIRS: Array<[string, string]> = [
  ['PATCH', '/api/collections/notes/[id]'], ['PATCH', '/api/custom-fields'], ['PATCH', '/api/estimates/[id]'],
  ['PATCH', '/api/finance-charges/settings'], ['PATCH', '/api/jobs/[id]'], ['PATCH', '/api/journal-entries/[id]'],
  ['PATCH', '/api/reconciliations/[id]'], ['PATCH', '/api/reports/1099/mapping'], ['PATCH', '/api/sales-forms/[kind]/[id]/flags'],
  ['PATCH', '/api/sales-reps/[id]'], ['PATCH', '/api/tax-rates/[id]/components'], ['POST', '/api/assemblies/build'],
  ['POST', '/api/assemblies/pending'], ['POST', '/api/assemblies/pending/[id]'], ['POST', '/api/bank-accounts'],
  ['POST', '/api/bank-transactions/bulk'], ['POST', '/api/bank-transactions/categorize'], ['POST', '/api/bank-transactions/exclude'],
  ['POST', '/api/bank-transactions/match'], ['POST', '/api/bank-transactions/unmatch'], ['POST', '/api/checks/pdf'],
  ['POST', '/api/collections/notes'], ['POST', '/api/credit-memos/[id]'], ['POST', '/api/currencies'],
  ['POST', '/api/currencies/fx-adjustment'], ['POST', '/api/currencies/home-currency-adjustment'], ['POST', '/api/custom-fields/values'],
  ['POST', '/api/customer-prices'], ['POST', '/api/demo-feed'], ['POST', '/api/estimates/[id]'],
  ['POST', '/api/estimates/expire'], ['POST', '/api/expense-reports'], ['POST', '/api/expense-reports/[id]'],
  ['POST', '/api/expenses/[id]/print'], ['POST', '/api/export/reports'], ['POST', '/api/fifo'],
  ['POST', '/api/fiscal-periods'], ['POST', '/api/import'], ['POST', '/api/import/rebuild'],
  ['POST', '/api/income-tracker/actions'], ['POST', '/api/inventory'], ['POST', '/api/inventory-transfers/[id]'],
  ['POST', '/api/inventory/batch-count'], ['POST', '/api/inventory/physical-count'], ['POST', '/api/inventory/value-adjust'],
  ['POST', '/api/landed-cost/[id]'], ['POST', '/api/notes'], ['POST', '/api/pay-liabilities'],
  ['POST', '/api/pay-liabilities/by-item'], ['POST', '/api/pay-liabilities/checks/[id]'], ['POST', '/api/payments/[id]'],
  ['POST', '/api/payroll/calc'], ['POST', '/api/payroll/state-tax'], ['POST', '/api/plaid/exchange'],
  ['POST', '/api/plaid/sync'], ['POST', '/api/portal/login'], ['POST', '/api/qb-import'],
  ['POST', '/api/reconciliations'], ['POST', '/api/reconciliations/[id]/pay'], ['POST', '/api/reconciliations/undo'],
  ['POST', '/api/report-builder'], ['POST', '/api/rules'], ['POST', '/api/sales-forms/queue'],
  ['POST', '/api/sales-reps'], ['POST', '/api/sales-reps/assign'], ['POST', '/api/sales-tax/pay'],
  ['POST', '/api/sales-tax/payments/[id]'], ['POST', '/api/tax-agencies'], ['POST', '/api/tax-rates'],
  ['POST', '/api/vendor-credits/[id]'], ['POST', '/api/year-end-close'], ['PUT', '/api/assemblies'],
  ['PUT', '/api/finance-charges/settings'], ['PUT', '/api/payroll/accruals'],
];
// Vite (vitest) resolves import.meta.glob at transform time; vite/client types are not a direct
// dependency here, so the one signature used is declared below.
declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}
const routeModules = import.meta.glob('../../app/api/**/route.ts');

describe('invalid request bodies answer 4xx, never 500', () => {
  it('lists 74 distinct pairs', () => {
    expect(new Set(INVALID_BODY_PAIRS.map((p) => p.join(' '))).size).toBe(74);
  });
  for (const [method, route] of INVALID_BODY_PAIRS) {
    it(`${method} ${route}`, async () => {
      const load = routeModules[`../../app${route}/route.ts`];
      expect(load, `route module for ${route}`).toBeDefined();
      const mod = (await load()) as Record<string, Handler>;
      const handler = mod[method];
      expect(handler, `${method} export of ${route}`).toBeTypeOf('function');
      const concrete = route.replace('[kind]', 'invoice').replace('[id]', NO_ID);
      for (const raw of ['{"a":', 'null', '[]', '"x"']) {
        as(method, concrete);
        const res = await handler(req(method, concrete, undefined, raw), params({ id: NO_ID, kind: 'invoice' }) as never);
        expect(res.status, `${method} ${route} with body ${raw}`).toBeLessThan(500);
      }
    });
  }
});

describe('opening stock is average-cost by default (no FIFO layer)', () => {
  it('an item created with opening stock can be built into an assembly, physically counted and revalued', async () => {
    const mk = async (body: Record<string, unknown>) => {
      const r = await call(itemsPOST as Handler, 'POST', '/api/items', {
        type: 'inventory', incomeAccountId: acct['4000'], expenseAccountId: acct['5000'], assetAccountId: acct['1300'], ...body,
      });
      expect(r.status, JSON.stringify(r.data)).toBe(201);
      return r.data.item as { id: string };
    };
    const bolt = await mk({ name: 'Opening Bolt', openingQuantity: '100', openingUnitCost: '0.25', openingAsOf: '2026-03-01' });
    const nut = await mk({ name: 'Opening Nut', openingQuantity: '100', openingUnitCost: '0.10', openingAsOf: '2026-03-01' });
    const kit = await mk({ name: 'Opening Kit', salesPrice: '9.00' });
    expect(await db.select().from(inventoryLayers).where(eq(inventoryLayers.itemId, bolt.id))).toHaveLength(0);

    const bom = await call(assembliesPUT as Handler, 'PUT', '/api/assemblies', { assemblyItemId: kit.id, components: [{ componentItemId: bolt.id, quantity: '4' }, { componentItemId: nut.id, quantity: '4' }] });
    expect(bom.status, JSON.stringify(bom.data)).toBeLessThan(300);
    const build = await call(buildPOST as Handler, 'POST', '/api/assemblies/build', { assemblyItemId: kit.id, quantity: '5', action: 'build', date: '2026-03-05' });
    expect(build.status, JSON.stringify(build.data)).toBe(201);
    expect(Number(build.data.newAssemblyQty)).toBe(5);

    const count = await call(physicalCountPOST as Handler, 'POST', '/api/inventory/physical-count', { itemId: bolt.id, countedQty: '75', date: '2026-03-06' });
    expect(count.status, JSON.stringify(count.data)).toBeLessThan(300);
    const [boltRow] = await db.select().from(items).where(eq(items.id, bolt.id));
    expect(Number(boltRow.quantityOnHand)).toBe(75); // 100 - 20 built - 5 shrink

    const revalue = await call(valueAdjustPOST as Handler, 'POST', '/api/inventory/value-adjust', { itemId: nut.id, newUnitCost: '0.12', date: '2026-03-07', reason: 'Revalue' });
    expect(revalue.status, JSON.stringify(revalue.data)).toBeLessThan(300);
  });

  it("openingCosting: 'fifo' still opens a FIFO layer (and the average-cost count is refused)", async () => {
    const r = await call(itemsPOST as Handler, 'POST', '/api/items', {
      name: 'Opening Fifo', type: 'inventory', assetAccountId: acct['1300'], openingQuantity: '10', openingUnitCost: '2', openingAsOf: '2026-03-01', openingCosting: 'fifo',
    });
    expect(r.status).toBe(201);
    const layers = await db.select().from(inventoryLayers).where(eq(inventoryLayers.itemId, r.data.item.id));
    expect(layers).toHaveLength(1);
    const count = await call(physicalCountPOST as Handler, 'POST', '/api/inventory/physical-count', { itemId: r.data.item.id, countedQty: '9', date: '2026-03-06' });
    expect(count.status).toBe(400);
  });
});
