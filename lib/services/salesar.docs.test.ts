/**
 * Team salesar (sub-builder "docs"):
 *  1. Estimates, sales orders and purchase orders can be VOIDED (kept, marked void, read-only, out
 *     of the open lists) or DELETED (lines go, attachments back to the inbox), never while an
 *     invoice / bill / item receipt made from them stands; both are audited and listed on the
 *     Voided/Deleted Transactions report with number, date, name and amount.
 *  2. Memorized transactions for estimates, sales orders and bill credits: stored-payload check,
 *     entering one (Enter Now / automatic / group) creates the form through its own service with a
 *     fresh number and the company's date, carrying Customer Message and per-line Sales Tax Codes.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  accountantCopies,
  accounts,
  attachments,
  auditLogs,
  estimateLines,
  estimates,
  invoiceLines,
  items,
  purchaseOrderLines,
  purchaseOrders,
  salesOrderLines,
  salesOrders,
  users,
  vendorCredits,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createInvoice, voidInvoice } from './invoices';
import { voidBill } from './bills';
import {
  convertToInvoice as convertEstimate,
  createEstimate,
  deleteEstimate,
  getEstimate,
  updateEstimate,
  updateEstimateStatus,
  voidEstimate,
} from './estimates';
import {
  convertToInvoice as convertSalesOrder,
  createSalesOrder,
  deleteSalesOrder,
  getSalesOrder,
  updateSalesOrder,
  updateStatus as updateSalesOrderStatus,
  voidSalesOrder,
} from './salesOrders';
import {
  convertToBill,
  createPurchaseOrder,
  deletePurchaseOrder,
  getPurchaseOrder,
  updatePurchaseOrder,
  voidPurchaseOrder,
} from './purchaseOrders';
import { voidedDeletedTransactions } from './accountant/auditReports';
import { openPurchaseOrders, openSalesOrdersByCustomer } from './reportsLists';
import { createTemplate, getTemplate, runDue, runGroup, runTemplateNow, updateTemplate } from './recurring';
import { companyToday } from './salesDates';
import { createEntry, listEntries } from './lists/simpleLists';
import { createTaxRate } from './salesTax';
import { apiRuleFor } from '@/lib/permissions/routes';
import { unionRoles } from '@/lib/permissions/model';
import { createRecurringTemplateSchema } from '@/lib/validation/recurring';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-salesar-docs');
let db: DB;
let userId: string;
let ctx: ServiceContext;
let routeCtx: ServiceContext;
let acct: Record<string, string> = {};
let seq = 0;
let cust: string;
let vend: string;
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const ymd = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString().slice(0, 10) : null);

vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => routeCtx) }));
import { DELETE as estimateDELETE, GET as estimateGET, POST as estimatePOST } from '@/app/api/estimates/[id]/route';
import { DELETE as soDELETE, POST as soPOST } from '@/app/api/sales-orders/[id]/route';
import { DELETE as poDELETE } from '@/app/api/purchase-orders/[id]/route';

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (method: string, url: string, body?: unknown) =>
  new Request(`http://localhost${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as never;

async function refusal(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await p;
  } catch (err) {
    return err as { code?: string; message: string };
  }
  throw new Error('expected a refusal');
}

/** A role with everything in Customers / Vendors except Delete. */
const noDelete = () =>
  unionRoles([
    {
      key: 'no_delete',
      name: 'No delete',
      description: '',
      builtin: false,
      permissions: { customers: ['view', 'create', 'modify', 'print'], vendors: ['view', 'create', 'modify', 'print'], lists: ['view', 'create', 'modify'] },
      flags: {},
    } as never,
  ]);

const estimateInput = (extra: Record<string, unknown> = {}) =>
  ({
    customerId: cust,
    date: d('2026-03-02'),
    taxRateId: null,
    lines: [{ description: 'Design work', quantity: 2, rate: '150.00', taxable: false }],
    ...extra,
  }) as never;
const orderInput = (extra: Record<string, unknown> = {}) =>
  ({
    customerId: cust,
    date: d('2026-03-03'),
    taxRateId: null,
    lines: [{ description: 'Widgets', quantity: 10, rate: '12.50', taxable: false }],
    ...extra,
  }) as never;
const poInput = (extra: Record<string, unknown> = {}) =>
  ({ vendorId: vend, date: d('2026-03-04'), lines: [{ accountId: acct['6000'], description: 'Paper', quantity: 4, rate: '25.00' }], ...extra }) as never;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'salesar-docs@test.local', name: 'Docs Tester', passwordHash: 'x' }).returning();
  userId = u.id;
});

beforeEach(async () => {
  seq += 1;
  const company = await createCompany(db, { name: `Salesar Docs ${seq}`, ownerId: userId });
  ctx = { db, companyId: company.id, userId };
  routeCtx = ctx;
  acct = {};
  for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[r.code] = r.id;
  cust = (await createCustomer(ctx, { displayName: `Acme ${seq}` } as never)).id;
  vend = (await createVendor(ctx, { displayName: `Paper Co ${seq}` } as never)).id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows may hold a handle; the next run wipes it. */
  }
});

// ---------------------------------------------------------------------------
describe('1. Void / delete estimates, sales orders and purchase orders', () => {
  it('a voided estimate keeps its amounts, is read-only, and is on the Voided/Deleted report', async () => {
    const est = await createEstimate(ctx, estimateInput({ refNumber: 'Q-100' }));
    const voided = await voidEstimate(ctx, est.id);
    expect(voided.status).toBe('void');
    expect(voided.total).toBe('300.00');
    // Voiding twice is a no-op (a double click).
    expect((await voidEstimate(ctx, est.id)).status).toBe('void');

    expect((await refusal(updateEstimate(ctx, est.id, estimateInput()))).code).toBe('CONFLICT');
    expect((await refusal(updateEstimateStatus(ctx, est.id, 'accepted'))).code).toBe('CONFLICT');
    expect((await refusal(convertEstimate(ctx, est.id))).code).toBe('CONFLICT');
    // An invoice can't be linked to a void estimate's line either.
    const [line] = await db.select().from(estimateLines).where(eq(estimateLines.estimateId, est.id));
    const linked = await refusal(
      createInvoice(ctx, {
        customerId: cust,
        date: d('2026-03-10'),
        lines: [{ description: 'Design work', quantity: 1, rate: '150.00', estimateLineId: line.id }],
      } as never),
    );
    expect(linked.code).toBe('CONFLICT');
    expect(linked.message).toMatch(/void/);

    const rep = await voidedDeletedTransactions(ctx);
    const row = rep.rows.find((r) => r.entityId === est.id);
    expect(row).toMatchObject({ action: 'void', typeLabel: 'Estimate', number: 'Q-100', name: `Acme ${seq}`, amount: '300.00' });
    expect(ymd(row!.transactionDate)).toBe('2026-03-02');
  });

  it('PATCH { status: "void" } and POST { action: "void" } void through the route', async () => {
    const a = await createEstimate(ctx, estimateInput());
    const b = await createEstimate(ctx, estimateInput());
    const { PATCH } = await import('@/app/api/estimates/[id]/route');
    expect((await PATCH(req('PATCH', `/api/estimates/${a.id}`, { status: 'void' }), params(a.id))).status).toBe(200);
    expect((await estimatePOST(req('POST', `/api/estimates/${b.id}`, { action: 'void' }), params(b.id))).status).toBe(200);
    expect((await getEstimate(ctx, a.id)).status).toBe('void');
    expect((await getEstimate(ctx, b.id)).status).toBe('void');
  });

  it('an estimate turned into an invoice cannot be voided or deleted until the invoice is voided; delete then removes it', async () => {
    const est = await createEstimate(ctx, estimateInput({ refNumber: 'Q-200' }));
    const inv = await convertEstimate(ctx, est.id);
    for (const p of [voidEstimate(ctx, est.id), deleteEstimate(ctx, est.id)]) {
      const err = await refusal(p);
      expect(err.code).toBe('CONFLICT');
      expect(err.message).toMatch(/Invoice #\S+ was made from this estimate/);
    }
    await voidInvoice(ctx, inv.id);

    // A document filed to the estimate goes back to the Doc Center inbox.
    const [att] = await db
      .insert(attachments)
      .values({ companyId: ctx.companyId, entityType: 'estimate', entityId: est.id, filename: 'quote.pdf', storagePath: 'x/quote.pdf' })
      .returning();

    const res = await estimateDELETE(req('DELETE', `/api/estimates/${est.id}`), params(est.id));
    expect(res.status).toBe(200);
    expect((await estimateGET(req('GET', `/api/estimates/${est.id}`), params(est.id))).status).toBe(404);
    expect(await db.select().from(estimates).where(eq(estimates.id, est.id))).toHaveLength(0);
    expect(await db.select().from(estimateLines).where(eq(estimateLines.estimateId, est.id))).toHaveLength(0);
    // The voided invoice no longer points at the deleted lines.
    const invLines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
    expect(invLines.every((l) => l.estimateLineId === null)).toBe(true);
    const [after] = await db.select().from(attachments).where(eq(attachments.id, att.id));
    expect(after).toMatchObject({ entityType: null, entityId: null });

    const rep = await voidedDeletedTransactions(ctx, { detail: true });
    const row = rep.rows.find((r) => r.entityId === est.id);
    expect(row).toMatchObject({ action: 'delete', typeLabel: 'Estimate', number: 'Q-200', name: `Acme ${seq}`, amount: '300.00' });
    expect(ymd(row!.transactionDate)).toBe('2026-03-02');
    expect((row!.original as { lines: unknown[] }).lines).toHaveLength(1);
  });

  it('a sales order with invoiced quantities cannot be voided or deleted; a closed order nothing was invoiced from can', async () => {
    const so = await createSalesOrder(ctx, orderInput({ refNumber: 'SO-7' }));
    const [line] = await db.select().from(salesOrderLines).where(eq(salesOrderLines.salesOrderId, so.id));
    const inv = await convertSalesOrder(ctx, so.id, { lines: [{ lineId: line.id, quantity: 4 }] });
    for (const p of [voidSalesOrder(ctx, so.id), deleteSalesOrder(ctx, so.id)]) {
      const err = await refusal(p);
      expect(err.code).toBe('CONFLICT');
      expect(err.message).toMatch(/has been invoiced/);
    }
    // Voiding the invoice gives the order its quantities back: now it can be voided.
    await voidInvoice(ctx, inv.id);
    const v = await voidSalesOrder(ctx, so.id);
    expect(v.status).toBe('void');
    expect(v.total).toBe('125.00');
    expect((await refusal(updateSalesOrder(ctx, so.id, orderInput()))).code).toBe('CONFLICT');
    // The route never reopens a void order.
    const reopen = await soPOST(req('POST', `/api/sales-orders/${so.id}`, { action: 'status', status: 'open' }), params(so.id));
    expect(reopen.status).toBe(409);
    expect((await getSalesOrder(ctx, so.id)).status).toBe('void');

    const closed = await createSalesOrder(ctx, orderInput());
    await updateSalesOrderStatus(ctx, closed.id, 'closed');
    expect((await voidSalesOrder(ctx, closed.id)).status).toBe('void');
  });

  it('deleting a sales order removes it and its lines; the report keeps number, date, customer and amount', async () => {
    const so = await createSalesOrder(ctx, orderInput({ refNumber: 'SO-9' }));
    const res = await soDELETE(req('DELETE', `/api/sales-orders/${so.id}`), params(so.id));
    expect(res.status).toBe(200);
    expect(await db.select().from(salesOrders).where(eq(salesOrders.id, so.id))).toHaveLength(0);
    expect(await db.select().from(salesOrderLines).where(eq(salesOrderLines.salesOrderId, so.id))).toHaveLength(0);
    const row = (await voidedDeletedTransactions(ctx)).rows.find((r) => r.entityId === so.id);
    expect(row).toMatchObject({ action: 'delete', typeLabel: 'Sales Order', number: 'SO-9', name: `Acme ${seq}`, amount: '125.00' });
    expect(ymd(row!.transactionDate)).toBe('2026-03-03');
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, so.id), eq(auditLogs.action, 'delete')));
    expect(audit.userId).toBe(userId);
  });

  it('a billed purchase order cannot be voided or deleted until its bill is voided', async () => {
    const po = await createPurchaseOrder(ctx, poInput({ refNumber: 'PO-55' }));
    const bill = await convertToBill(ctx, po.id);
    for (const p of [voidPurchaseOrder(ctx, po.id), deletePurchaseOrder(ctx, po.id)]) {
      const err = await refusal(p);
      expect(err.code).toBe('CONFLICT');
      expect(err.message).toMatch(/received or billed/);
    }
    await voidBill(ctx, (bill as { id: string }).id);
    const res = await poDELETE(req('DELETE', `/api/purchase-orders/${po.id}`), params(po.id));
    expect(res.status).toBe(200);
    expect(await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, po.id))).toHaveLength(0);
    expect(await db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, po.id))).toHaveLength(0);
    const row = (await voidedDeletedTransactions(ctx)).rows.find((r) => r.entityId === po.id);
    expect(row).toMatchObject({ action: 'delete', typeLabel: 'Purchase Order', number: 'PO-55', name: `Paper Co ${seq}`, amount: '100.00' });
  });

  it('a voided PO is read-only and on the report; voided POs and orders leave the open PO / sales order reports', async () => {
    const po = await createPurchaseOrder(ctx, poInput({ refNumber: 'PO-66' }));
    const so = await createSalesOrder(ctx, orderInput({ refNumber: 'SO-66' }));
    const before = JSON.stringify(await openPurchaseOrders(ctx, {} as never)) + JSON.stringify(await openSalesOrdersByCustomer(ctx, {} as never));
    expect(before).toContain('PO-66');
    expect(before).toContain('SO-66');
    await voidPurchaseOrder(ctx, po.id);
    await voidSalesOrder(ctx, so.id);
    const after = JSON.stringify(await openPurchaseOrders(ctx, {} as never)) + JSON.stringify(await openSalesOrdersByCustomer(ctx, {} as never));
    expect(after).not.toContain('PO-66');
    expect(after).not.toContain('SO-66');
    expect((await refusal(updatePurchaseOrder(ctx, po.id, poInput()))).code).toBe('CONFLICT');
    expect((await getPurchaseOrder(ctx, po.id)).status).toBe('void');
    const row = (await voidedDeletedTransactions(ctx)).rows.find((r) => r.entityId === po.id);
    expect(row).toMatchObject({ action: 'void', typeLabel: 'Purchase Order', number: 'PO-66', name: `Paper Co ${seq}`, amount: '100.00' });
  });

  it('void and delete need the Delete right; the routes carry it', async () => {
    const restricted: ServiceContext = { ...ctx, access: noDelete() };
    const est = await createEstimate(ctx, estimateInput());
    const so = await createSalesOrder(ctx, orderInput());
    const po = await createPurchaseOrder(ctx, poInput());
    for (const p of [
      voidEstimate(restricted, est.id),
      deleteEstimate(restricted, est.id),
      voidSalesOrder(restricted, so.id),
      deleteSalesOrder(restricted, so.id),
      voidPurchaseOrder(restricted, po.id),
      deletePurchaseOrder(restricted, po.id),
    ]) {
      expect((await refusal(p)).code).toBe('FORBIDDEN');
    }
    expect(apiRuleFor(`/api/estimates/${est.id}`, 'DELETE')).toEqual({ area: 'customers', action: 'delete' });
    expect(apiRuleFor(`/api/sales-orders/${so.id}`, 'DELETE')).toEqual({ area: 'customers', action: 'delete' });
    expect(apiRuleFor(`/api/purchase-orders/${po.id}`, 'DELETE')).toEqual({ area: 'vendors', action: 'delete' });
  });

  it("Accountant's Copy: the client can't touch forms on or before the dividing date; the accountant can't delete", async () => {
    const est = await createEstimate(ctx, estimateInput());
    const so = await createSalesOrder(ctx, orderInput());
    const po = await createPurchaseOrder(ctx, poInput());
    const [copy] = await db
      .insert(accountantCopies)
      .values({ companyId: ctx.companyId, side: 'client', status: 'outstanding', dividingDate: '2026-03-31', fileToken: `t${seq}` })
      .returning();
    for (const p of [voidEstimate(ctx, est.id), deleteEstimate(ctx, est.id), deleteSalesOrder(ctx, so.id), voidPurchaseOrder(ctx, po.id)]) {
      expect(['CONFLICT', 'FORBIDDEN', 'PERIOD_CLOSED', 'VALIDATION']).toContain((await refusal(p)).code);
    }
    expect((await getEstimate(ctx, est.id)).status).toBe('draft');

    await db.update(accountantCopies).set({ side: 'accountant', status: 'open' }).where(eq(accountantCopies.id, copy.id));
    for (const p of [deleteEstimate(ctx, est.id), deleteSalesOrder(ctx, so.id), deletePurchaseOrder(ctx, po.id), voidEstimate(ctx, est.id)]) {
      const err = await refusal(p);
      expect(err.code).toBe('FORBIDDEN');
      expect(err.message).toMatch(/Accountant's Copy/);
    }
    // A sales order / PO void is carried by the changes file: allowed in the copy.
    expect((await voidSalesOrder(ctx, so.id)).status).toBe('void');
    expect((await voidPurchaseOrder(ctx, po.id)).status).toBe('void');
  });
});

// ---------------------------------------------------------------------------
describe('2. Memorized estimates, sales orders and bill credits', () => {
  it('the request schema and the service accept the three new document types; the payload is checked', async () => {
    for (const docType of ['estimate', 'sales_order', 'vendor_credit']) {
      expect(createRecurringTemplateSchema.safeParse({ name: 'x', docType, frequency: 'monthly', template: {} }).success).toBe(true);
    }
    const base = { name: 'Bad', frequency: 'monthly' as const, nextRunDate: d('2026-04-01') };
    expect((await refusal(createTemplate(ctx, { ...base, docType: 'estimate', template: { lines: [{ quantity: 1 }] } }))).code).toBe('VALIDATION');
    expect(
      (await refusal(createTemplate(ctx, { ...base, docType: 'sales_order', template: { customerId: cust, lines: [] } }))).code,
    ).toBe('VALIDATION');
    const other = await createCompany(db, { name: `Other ${seq}`, ownerId: userId });
    const foreign = (await createCustomer({ db, companyId: other.id, userId }, { displayName: 'Elsewhere' } as never)).id;
    expect(
      (await refusal(createTemplate(ctx, { ...base, docType: 'estimate', template: { customerId: foreign, lines: [{ quantity: 1 }] } }))).code,
    ).toBe('NOT_FOUND');
    expect((await refusal(createTemplate(ctx, { ...base, docType: 'vendor_credit', template: { vendorId: cust, lines: [{}] } }))).code).toBe(
      'NOT_FOUND',
    );
    // A line naming another company's item / account / tax code is refused when memorized.
    const foreignItem = (
      await db.insert(items).values({ companyId: other.id, name: `Foreign item ${seq}`, type: 'service' as never }).returning()
    )[0].id;
    const [foreignAcct] = await db.select().from(accounts).where(eq(accounts.companyId, other.id)).limit(1);
    const foreignCode = String((await listEntries({ db, companyId: other.id, userId }, 'sales-tax-codes'))[0].id);
    for (const line of [{ itemId: foreignItem }, { accountId: foreignAcct.id }, { salesTaxCodeId: foreignCode }]) {
      expect(
        (await refusal(createTemplate(ctx, { ...base, docType: 'estimate', template: { customerId: cust, lines: [{ description: 'x', quantity: 1, ...line }] } })))
          .code,
      ).toBe('VALIDATION');
    }
    // A re-memorized payload is checked the same way.
    const ok = await createTemplate(ctx, {
      ...base,
      name: 'Good',
      docType: 'estimate',
      template: { customerId: cust, lines: [{ description: 'x', quantity: 1, rate: '1' }] },
    });
    expect((await refusal(updateTemplate(ctx, ok.id, { template: { customerId: cust, lines: [] } }))).code).toBe('VALIDATION');
  });

  it('Enter Now creates a new estimate with a fresh number, today\'s company date, its Customer Message and line tax codes', async () => {
    const codes = await listEntries(ctx, 'sales-tax-codes');
    const non = String(codes.find((c) => c.code === 'Non')!.id);
    const tax = String(codes.find((c) => c.code === 'Tax')!.id);
    const rate = (await createTaxRate(ctx, { name: `State ${seq}`, rate: '0.10' })).id;
    const msg = await createEntry(ctx, 'customer-messages', { message: `We appreciate your business ${seq}` });
    const original = await createEstimate(ctx, estimateInput({ refNumber: 'Q-500', taxRateId: rate, customerMessageId: msg.id }));
    // What the estimate form memorizes: its save body (with the line ids of a saved estimate).
    const tpl = await createTemplate(ctx, {
      name: 'Quarterly quote',
      docType: 'estimate',
      frequency: 'quarterly',
      mode: 'remind',
      nextRunDate: d('2026-06-01'),
      template: {
        customerId: cust,
        date: '2026-03-02',
        expirationDate: '2026-04-01',
        refNumber: 'Q-500',
        taxRateId: rate,
        customerMessageId: msg.id,
        memo: 'Recurring quote',
        lines: [
          { id: original.id, description: 'Labor', quantity: 2, rate: '100.00', taxable: false, salesTaxCodeId: non },
          { description: 'Parts', quantity: 1, rate: '50.00', taxable: true, salesTaxCodeId: tax },
        ],
      },
    });
    const doc = await runTemplateNow(ctx, tpl.id);
    expect(doc.docType).toBe('estimate');
    const est = await getEstimate(ctx, doc.docId);
    expect(est.id).not.toBe(original.id);
    expect(est.refNumber).not.toBe('Q-500');
    expect(est.customerId).toBe(cust);
    expect(ymd(est.date)).toBe(ymd(await companyToday(ctx)));
    // The expiration date keeps its 30 days from the estimate date.
    expect((new Date(est.expirationDate!).getTime() - new Date(est.date).getTime()) / 86_400_000).toBe(30);
    expect(est.customerMessageId).toBe(msg.id);
    expect(est.memo).toBe('Recurring quote');
    expect(est.lines.map((l) => l.salesTaxCodeId)).toEqual([non, tax]);
    expect(est.lines.map((l) => l.taxable)).toEqual([false, true]);
    expect(est.taxAmount).toBe('5.00');
    expect(est.total).toBe('255.00');
    expect(est.status).toBe('draft');
    // The schedule moved on (caught up past today, quarter by quarter from June 1).
    const next = (await getTemplate(ctx, tpl.id)).nextRunDate!;
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect(ymd(next)!.slice(5)).toMatch(/^(03|06|09|12)-01$/);
  });

  it('an automatic sales order is entered on its scheduled date with a fresh number', async () => {
    const msg = await createEntry(ctx, 'customer-messages', { message: `Order thanks ${seq}` });
    const first = await createSalesOrder(ctx, orderInput({ refNumber: 'SO-100' }));
    const tpl = await createTemplate(ctx, {
      name: 'Monthly widgets',
      docType: 'sales_order',
      frequency: 'monthly',
      mode: 'automatic',
      nextRunDate: d('2026-05-15'),
      template: {
        customerId: cust,
        date: '2026-03-03',
        shipDate: '2026-03-10',
        refNumber: 'SO-100',
        trackingNumber: '1Z999',
        poNumber: 'CUST-PO-1',
        taxRateId: null,
        customerMessageId: msg.id,
        lines: [{ description: 'Widgets', quantity: 10, rate: '12.50', taxable: false }],
      },
    });
    const run = await runDue(ctx, d('2026-05-15'));
    expect(run.failed).toEqual([]);
    const gen = run.generated.find((g) => g.templateId === tpl.id)!;
    expect(gen.docType).toBe('sales_order');
    const so = await getSalesOrder(ctx, gen.docId);
    expect(so.id).not.toBe(first.id);
    expect(so.refNumber).not.toBe('SO-100');
    expect(ymd(so.date)).toBe('2026-05-15');
    expect(ymd(so.shipDate)).toBe('2026-05-22');
    expect(so.trackingNumber).toBeNull();
    expect(so.poNumber).toBe('CUST-PO-1');
    expect(so.customerMessageId).toBe(msg.id);
    expect(so.total).toBe('125.00');
    expect(so.status).toBe('open');
  });

  it('a memorized bill credit posts through its own service when its group is entered', async () => {
    const tpl = await createTemplate(ctx, {
      name: 'Monthly rebate',
      docType: 'vendor_credit',
      frequency: 'monthly',
      mode: 'never',
      groupName: `Month end ${seq}`,
      nextRunDate: d('2026-04-30'),
      template: {
        vendorId: vend,
        date: '2026-03-31',
        refNumber: 'CM-1',
        memo: 'Volume rebate',
        lines: [{ accountId: acct['6000'], description: 'Rebate', amount: '40.00' }],
      },
    });
    const res = await runGroup(ctx, `Month end ${seq}`);
    expect(res.failed).toEqual([]);
    const gen = res.generated.find((g) => g.templateId === tpl.id)!;
    expect(gen.docType).toBe('vendor_credit');
    const [vc] = await db.select().from(vendorCredits).where(eq(vendorCredits.id, gen.docId));
    expect(vc).toMatchObject({ vendorId: vend, total: '40.00', unapplied: '40.00', status: 'open', memo: 'Volume rebate', refNumber: null });
    expect(vc.postedEntryId).toBeTruthy();
    expect(ymd(vc.date)).toBe(ymd(await companyToday(ctx)));
  });

  it("entering a memorized estimate needs the Customers create right (the document's own)", async () => {
    const tpl = await createTemplate(ctx, {
      name: 'Quote',
      docType: 'estimate',
      frequency: 'monthly',
      mode: 'never',
      nextRunDate: d('2026-04-01'),
      template: { customerId: cust, taxRateId: null, lines: [{ description: 'x', quantity: 1, rate: '10.00', taxable: false }] },
    });
    const vendorsOnly: ServiceContext = {
      ...ctx,
      access: unionRoles([
        { key: 'v', name: 'v', description: '', builtin: false, permissions: { vendors: ['view', 'create'], lists: ['view'] }, flags: {} } as never,
      ]),
    };
    const err = await refusal(runTemplateNow(vendorsOnly, tpl.id));
    expect(err.code).toBe('FORBIDDEN');
    expect(err.message).toMatch(/estimates/);
  });
});
