/**
 * Accountant's Copy (PARITY I1): sales and purchase forms, payments, inventory adjustments and
 * list records (customers, vendors, items, other names) in the changes file.
 *
 * For every record type this module knows
 *  - payloadOf: the record as the input of its normal service (createInvoice, receivePayment,
 *    payBills, …) — built on the accountant side for the changes file, and on the client side to
 *    show what the client's file has now (the review's "before");
 *  - describe: a plain-language description (title, amount, detail lines) for the review;
 *  - apply: how the import creates / edits / voids it through the normal service, with the
 *    accountant-file ids mapped to the client's (new records the import created).
 * The payload shapes themselves (validated before any query) live in format.ts (DOC_SHAPES,
 * NAME_SHAPES).
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  auditLogs,
  inventoryMovements,
  items,
  journalEntries,
  journalEntryLines,
  otherNames,
  customers,
  vendors,
} from '@/lib/db/schema';
import { Money, formatCurrency, toAmountString } from '@/lib/money';
import { type ServiceContext, ServiceError, validation } from '../_base';
import { createInvoice, getInvoice, postDraftInvoice, updateInvoice, voidInvoice, type CreateInvoiceInput } from '../invoices';
import { createSalesReceipt, getSalesReceipt, updateSalesReceipt, voidSalesReceipt, type CreateSalesReceiptInput } from '../salesReceipts';
import { createCreditMemo, getCreditMemo, updateCreditMemo, voidCreditMemo, type CreateCreditMemoInput } from '../creditMemos';
import { getPayment, receivePayment, updatePayment, voidPayment, type ReceivePaymentInput } from '../payments';
import { createBill, getBill, updateBill, voidBill, type CreateBillInput } from '../bills';
import { getBillPayment, payBills, updateBillPayment, voidBillPayment, type PayBillsInput } from '../billPayments';
import { createVendorCredit, getVendorCredit, updateVendorCredit, voidVendorCredit, type CreateVendorCreditInput } from '../vendorCredits';
import { createItemReceipt, getItemReceipt, updateItemReceipt, voidItemReceipt, type CreateItemReceiptInput } from '../itemReceipts';
import { createEstimate, getEstimate, updateEstimate, updateEstimateStatus, type CreateEstimateInput, type EstimateStatus } from '../estimates';
import {
  createSalesOrder,
  getSalesOrder,
  updateSalesOrder,
  updateStatus as updateSalesOrderStatus,
  type CreateSalesOrderInput,
} from '../salesOrders';
import {
  createPurchaseOrder,
  getPurchaseOrder,
  updatePurchaseOrder,
  updateStatus as updatePurchaseOrderStatus,
  type CreatePurchaseOrderInput,
} from '../purchaseOrders';
import { adjustQuantityAtSite, type SiteAdjustmentInput } from '../inventorySiteOps';
import { createCustomer, updateCustomer, type CreateCustomerInput } from '../customers';
import { createVendor, updateVendor, type CreateVendorInput } from '../vendors';
import { createItem, updateItem, type CreateItemInput } from '../items';
import { createEntry, updateEntry as updateListEntry } from '../lists/simpleLists';
import { lineRefOf } from './lineRefs';
import {
  DOC_SHAPES,
  NAME_ADD_ONLY,
  NAME_SHAPES,
  type DocType,
  type FieldSpec,
  type LineRef,
  type NameType,
  type Shape,
} from './format';
import { NAME_COLUMNS } from './digest';

type P = Record<string, unknown>;

/** Forms in the order the import applies them (orders before the forms that use them, payments last). */
export const DOC_ORDER: DocType[] = [
  'estimate',
  'sales_order',
  'purchase_order',
  'invoice',
  'sales_receipt',
  'credit_memo',
  'bill',
  'vendor_credit',
  'item_receipt',
  'inventory_adjustment',
  'payment_received',
  'bill_payment',
];


// ---------------------------------------------------------------------------
// Small value helpers
// ---------------------------------------------------------------------------

const dec = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const nz = (v: unknown): string | null => (v === null || v === undefined || v === '' || Number(v) === 0 ? null : String(v));
const iso = (d: unknown): string | null => (d ? new Date(d as string).toISOString() : null);
const ymd = (d: unknown): string => (d ? new Date(d as string).toISOString().slice(0, 10) : '');
const strMap = (v: unknown): Record<string, string> | null => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v as P)) if (typeof x === 'string') out[k] = x;
  return Object.keys(out).length ? out : null;
};

/** Inventory detail of a document line (only the fields that are set). */
function invOf(l: P): P {
  const out: P = {};
  if (l.siteId) out.siteId = l.siteId;
  if (l.binId) out.binId = l.binId;
  if (Array.isArray(l.serialNumbers) && l.serialNumbers.length) out.serialNumbers = l.serialNumbers;
  if (l.lotNumber) out.lotNumber = l.lotNumber;
  if (l.lotExpiration) out.lotExpiration = iso(l.lotExpiration);
  return out;
}

async function lineRef(ctx: ServiceContext, lineId: string): Promise<LineRef> {
  const ref = await lineRefOf(ctx, lineId);
  if (!ref) throw new ServiceError('NOT_FOUND', 'A journal line this record uses is missing from the file.');
  return ref;
}

// ---------------------------------------------------------------------------
// Payloads (record → service input)
// ---------------------------------------------------------------------------

async function invoicePayload(ctx: ServiceContext, id: string): Promise<P> {
  const r = await getInvoice(ctx, id);
  return {
    refNumber: r.refNumber ?? String(r.invoiceNumber),
    customerId: r.customerId,
    date: iso(r.date),
    dueDate: iso(r.dueDate),
    terms: r.terms,
    taxRateId: r.taxRateId,
    classId: r.classId,
    jobId: r.jobId,
    salesRepId: r.salesRepId,
    // The stored discount is the dollar amount (a percent discount was already worked out).
    discount: nz(r.discount),
    discountType: 'amount',
    retainagePercent: nz(r.retainagePercent),
    memo: r.memo,
    currency: r.currency,
    exchangeRate: r.currency ? dec(r.exchangeRate) : null,
    status: r.status === 'draft' ? 'draft' : 'open',
    customFields: strMap(r.customFields),
    shipDate: iso(r.shipDate),
    shipVia: r.shipVia,
    fob: r.fob,
    trackingNumber: r.trackingNumber,
    shipTo: strMap(r.shipTo),
    poNumber: r.poNumber,
    toBePrinted: r.toBePrinted,
    toBeEmailed: r.toBeEmailed,
    isStatementCharge: r.isStatementCharge,
    total: toAmountString(r.total),
    lines: r.lines.map((l) => ({
      itemId: l.itemId,
      accountId: l.accountId,
      description: l.description,
      quantity: dec(l.quantity) ?? '1',
      rate: dec(l.rate),
      taxable: l.taxable,
      taxRateId: l.taxRateId,
      classId: l.classId,
      jobId: l.jobId,
      ...invOf(l as P),
    })),
  };
}

async function salesReceiptPayload(ctx: ServiceContext, id: string): Promise<P> {
  const r = await getSalesReceipt(ctx, id);
  return {
    refNumber: r.refNumber ?? String(r.receiptNumber),
    customerId: r.customerId,
    date: iso(r.date),
    taxRateId: r.taxRateId,
    depositAccountId: r.depositAccountId,
    method: r.method,
    reference: r.reference,
    memo: r.memo,
    classId: r.classId,
    shipDate: iso(r.shipDate),
    shipVia: r.shipVia,
    fob: r.fob,
    trackingNumber: r.trackingNumber,
    shipTo: strMap(r.shipTo),
    poNumber: r.poNumber,
    toBePrinted: r.toBePrinted,
    toBeEmailed: r.toBeEmailed,
    total: toAmountString(r.total),
    lines: r.lines.map((l) => ({
      itemId: l.itemId,
      accountId: l.accountId,
      description: l.description,
      quantity: dec(l.quantity) ?? '1',
      rate: dec(l.rate),
      taxable: l.taxable,
      taxRateId: l.taxRateId,
      ...invOf(l as P),
    })),
  };
}

async function creditMemoPayload(ctx: ServiceContext, id: string): Promise<P> {
  const r = await getCreditMemo(ctx, id);
  return {
    refNumber: r.refNumber ?? String(r.memoNumber),
    customerId: r.customerId,
    date: iso(r.date),
    taxRateId: r.taxRateId,
    memo: r.memo,
    toBePrinted: r.toBePrinted,
    toBeEmailed: r.toBeEmailed,
    total: toAmountString(r.total),
    lines: r.lines.map((l) => ({
      itemId: l.itemId,
      accountId: l.accountId,
      description: l.description,
      quantity: dec(l.quantity) ?? '1',
      rate: dec(l.rate),
      taxable: l.taxable,
      restock: l.restock,
      ...invOf(l as P),
    })),
  };
}

async function paymentPayload(ctx: ServiceContext, id: string): Promise<P> {
  const r = await getPayment(ctx, id);
  const journalItems: P[] = [];
  const journalCredits: P[] = [];
  for (const a of r.journalApplications) {
    if (a.kind === 'payment') journalItems.push({ line: await lineRef(ctx, a.journalLineId), amount: toAmountString(a.amount) });
    else if (a.kind === 'invoice_credit' && a.invoiceId) {
      journalCredits.push({ line: await lineRef(ctx, a.journalLineId), invoiceId: a.invoiceId, amount: toAmountString(a.amount) });
    }
  }
  const journalOffsets: P[] = [];
  for (const o of r.journalOffsets) {
    journalOffsets.push({ line: await lineRef(ctx, o.journalLineId), chargeLine: await lineRef(ctx, o.chargeLineId), amount: toAmountString(o.amount) });
  }
  return {
    customerId: r.customerId,
    date: iso(r.date),
    method: r.method,
    reference: r.reference,
    amount: toAmountString(r.amount),
    depositAccountId: r.depositAccountId,
    discountAccountId: r.discountAccountId,
    memo: r.memo,
    currency: r.currency,
    exchangeRate: r.currency ? dec(r.exchangeRate) : null,
    applications: r.applications.map((a) => ({
      invoiceId: a.invoiceId,
      amountApplied: toAmountString(a.amountApplied),
      discountAmount: nz(a.discountAmount),
    })),
    credits: r.credits.map((c) => ({ creditMemoId: c.creditMemoId, invoiceId: c.invoiceId, amount: toAmountString(c.amount) })),
    journalItems,
    journalCredits,
    journalOffsets,
  };
}

async function billPayload(ctx: ServiceContext, id: string): Promise<P> {
  const r = await getBill(ctx, id);
  return {
    vendorId: r.vendorId,
    billNumber: r.billNumber,
    date: iso(r.date),
    dueDate: iso(r.dueDate),
    terms: r.terms,
    memo: r.memo,
    classId: r.classId,
    currency: r.currency,
    exchangeRate: r.currency ? dec(r.exchangeRate) : null,
    total: toAmountString(r.total),
    lines: r.lines.map((l) => ({
      accountId: l.itemId ? null : l.accountId,
      itemId: l.itemId,
      description: l.description,
      quantity: l.itemId ? dec(l.quantity) : null,
      unitCost: null,
      amount: toAmountString(l.amount),
      classId: l.classId,
      customerId: l.customerId,
      jobId: l.jobId,
      ...invOf(l as P),
    })),
  };
}

/**
 * Discounts taken per bill are not stored on the application (only the settled amount); the
 * payment's own audit entry has them.
 */
async function billPaymentDiscounts(ctx: ServiceContext, id: string, total: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (Number(total) === 0) return out;
  const rows = await ctx.db
    .select({ newValues: auditLogs.newValues })
    .from(auditLogs)
    .where(and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityType, 'bill_payment'), eq(auditLogs.entityId, id)))
    .orderBy(desc(auditLogs.createdAt));
  for (const r of rows) {
    const apps = (r.newValues as { applications?: Array<{ billId?: string; discountTaken?: string | null }> } | null)?.applications;
    if (!Array.isArray(apps)) continue;
    for (const a of apps) if (a.billId && a.discountTaken && Number(a.discountTaken) !== 0) out.set(a.billId, String(a.discountTaken));
    return out;
  }
  return out;
}

async function billPaymentPayload(ctx: ServiceContext, id: string): Promise<P> {
  const r = await getBillPayment(ctx, id);
  const discounts = await billPaymentDiscounts(ctx, id, r.discountTotal);
  if (!discounts.size && Number(r.discountTotal) !== 0 && r.applications.length === 1) {
    discounts.set(r.applications[0].billId, r.discountTotal);
  }
  const journalItems: P[] = [];
  const journalCredits: P[] = [];
  for (const a of r.journalApplications) {
    if (a.kind === 'bill_payment') journalItems.push({ line: await lineRef(ctx, a.journalLineId), amount: toAmountString(a.amount) });
    else if (a.kind === 'bill_credit' && a.billId) {
      journalCredits.push({ line: await lineRef(ctx, a.journalLineId), billId: a.billId, amount: toAmountString(a.amount) });
    }
  }
  const journalOffsets: P[] = [];
  for (const o of r.journalOffsets) {
    journalOffsets.push({ line: await lineRef(ctx, o.journalLineId), chargeLine: await lineRef(ctx, o.chargeLineId), amount: toAmountString(o.amount) });
  }
  return {
    vendorId: r.vendorId,
    date: iso(r.date),
    method: r.method,
    reference: r.reference,
    paymentAccountId: r.paymentAccountId,
    discountAccountId: r.discountAccountId,
    toPrint: r.toPrint,
    exchangeRate: r.currency ? dec(r.exchangeRate) : null,
    amount: toAmountString(r.amount),
    applications: r.applications.map((a) => {
      const disc = discounts.get(a.billId) ?? null;
      // amountApplied is stored as the full settlement (cash + discount).
      return {
        billId: a.billId,
        amountApplied: toAmountString(disc ? Money.of(a.amountApplied).minus(disc) : a.amountApplied),
        discountTaken: disc ? toAmountString(disc) : null,
      };
    }),
    journalItems,
    journalCredits,
    journalOffsets,
  };
}

async function vendorCreditPayload(ctx: ServiceContext, id: string): Promise<P> {
  const r = await getVendorCredit(ctx, id);
  return {
    vendorId: r.vendorId,
    date: iso(r.date),
    memo: r.memo,
    refNumber: r.refNumber,
    currency: r.currency,
    exchangeRate: r.currency ? dec(r.exchangeRate) : null,
    total: toAmountString(r.total),
    lines: r.lines.map((l) => ({
      accountId: l.itemId ? null : l.accountId,
      itemId: l.itemId,
      quantity: dec(l.quantity),
      unitCost: dec(l.unitCost),
      description: l.description,
      amount: toAmountString(l.amount),
      classId: l.classId,
      customerId: l.customerId,
      jobId: l.jobId,
    })),
  };
}

async function itemReceiptPayload(ctx: ServiceContext, id: string): Promise<P> {
  const r = await getItemReceipt(ctx, id);
  return {
    vendorId: r.vendorId,
    date: iso(r.date),
    reference: r.reference,
    memo: r.memo,
    purchaseOrderId: r.purchaseOrderId,
    total: toAmountString(r.total),
    lines: r.lines.map((l) => ({
      itemId: l.itemId,
      description: l.description,
      quantity: dec(l.quantity) ?? '1',
      unitCost: dec(l.unitCost) ?? '0',
      ...invOf(l as P),
    })),
  };
}

async function estimatePayload(ctx: ServiceContext, id: string): Promise<P> {
  const r = await getEstimate(ctx, id);
  return {
    refNumber: r.refNumber ?? String(r.estimateNumber),
    customerId: r.customerId,
    date: iso(r.date),
    expirationDate: iso(r.expirationDate),
    taxRateId: r.taxRateId,
    memo: r.memo,
    shipTo: strMap(r.shipTo),
    toBePrinted: r.toBePrinted,
    toBeEmailed: r.toBeEmailed,
    status: r.status,
    total: toAmountString(r.total),
    lines: r.lines.map((l) => ({
      itemId: l.itemId,
      description: l.description,
      quantity: dec(l.quantity) ?? '1',
      rate: dec(l.rate),
      taxable: l.taxable,
      classId: l.classId,
    })),
  };
}

async function salesOrderPayload(ctx: ServiceContext, id: string): Promise<P> {
  const r = await getSalesOrder(ctx, id);
  return {
    refNumber: r.refNumber ?? String(r.orderNumber),
    customerId: r.customerId,
    date: iso(r.date),
    memo: r.memo,
    taxRateId: r.taxRateId,
    shipDate: iso(r.shipDate),
    shipVia: r.shipVia,
    fob: r.fob,
    trackingNumber: r.trackingNumber,
    shipTo: strMap(r.shipTo),
    poNumber: r.poNumber,
    toBePrinted: r.toBePrinted,
    toBeEmailed: r.toBeEmailed,
    status: r.status,
    total: toAmountString(r.total),
    lines: r.lines.map((l) => ({
      id: l.id,
      itemId: l.itemId,
      description: l.description,
      quantity: dec(l.quantity) ?? '1',
      rate: dec(l.rate),
      taxable: l.taxable,
    })),
  };
}

async function purchaseOrderPayload(ctx: ServiceContext, id: string): Promise<P> {
  const r = await getPurchaseOrder(ctx, id);
  return {
    refNumber: r.refNumber ?? String(r.poNumber),
    vendorId: r.vendorId,
    date: iso(r.date),
    expectedDate: iso(r.expectedDate),
    memo: r.memo,
    status: r.status,
    total: toAmountString(r.total),
    lines: r.lines.map((l) => ({
      id: l.id,
      itemId: l.itemId,
      accountId: l.accountId,
      description: l.description,
      quantity: dec(l.quantity) ?? '1',
      rate: dec(l.rate) ?? '0',
    })),
  };
}

/**
 * An inventory quantity adjustment is identified by the entry it posted (there is no adjustment
 * record): its site movements give the item, quantity, site / bin / serials / lot; the entry gives
 * the value, the Adjustment Account and its Class / Customer:Job.
 */
export async function inventoryAdjustmentPayload(ctx: ServiceContext, entryId: string): Promise<P> {
  const moves = await ctx.db
    .select()
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.companyId, ctx.companyId),
        eq(inventoryMovements.sourceType, 'adjustment'),
        eq(inventoryMovements.sourceId, entryId),
      ),
    )
    .orderBy(asc(inventoryMovements.createdAt));
  const own = moves.filter((m) => !m.reversalOfId);
  if (!own.length) throw new ServiceError('NOT_FOUND', 'Inventory adjustment not found');
  const [entry] = await ctx.db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.id, entryId), eq(journalEntries.companyId, ctx.companyId)));
  const lines = await ctx.db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, entryId));
  const itemId = own[0].itemId;
  const [item] = await ctx.db.select().from(items).where(eq(items.id, itemId));
  const qty = own.reduce((s, m) => s.plus(Money.of(m.quantity)), Money.zero());
  // The inventory line is the one on the item's asset account (else the line on the other side
  // of the adjustment account).
  const inventoryLine =
    lines.find((l) => item?.assetAccountId && l.accountId === item.assetAccountId) ??
    lines.find((l) => (qty.greaterThan(0) ? Number(l.debit ?? 0) > 0 : Number(l.credit ?? 0) > 0));
  const offset = lines.find((l) => l !== inventoryLine);
  const total = Money.of(inventoryLine ? (qty.greaterThan(0) ? inventoryLine.debit : inventoryLine.credit) ?? 0 : 0);
  const serials = own.map((m) => m.serialNumber).filter((s): s is string => !!s);
  return {
    itemId,
    quantityChange: qty.toFixed(4),
    unitCost: qty.greaterThan(0) ? total.dividedBy(qty).toDecimalPlaces(8).toString() : null,
    date: iso(entry?.date ?? own[0].date),
    memo: own[0].memo,
    adjustmentAccountId: offset?.accountId ?? null,
    classId: offset?.classId ?? null,
    customerId: offset?.entityType === 'customer' ? offset.entityId : null,
    jobId: null,
    total: toAmountString(total),
    ...(own[0].siteId ? { siteId: own[0].siteId } : {}),
    ...(own[0].binId ? { binId: own[0].binId } : {}),
    ...(serials.length ? { serialNumbers: serials } : {}),
    ...(own[0].lotNumber ? { lotNumber: own[0].lotNumber } : {}),
  };
}

const PAYLOAD_OF: Record<DocType, (ctx: ServiceContext, id: string) => Promise<P>> = {
  invoice: invoicePayload,
  sales_receipt: salesReceiptPayload,
  credit_memo: creditMemoPayload,
  payment_received: paymentPayload,
  bill: billPayload,
  bill_payment: billPaymentPayload,
  vendor_credit: vendorCreditPayload,
  item_receipt: itemReceiptPayload,
  estimate: estimatePayload,
  sales_order: salesOrderPayload,
  purchase_order: purchaseOrderPayload,
  inventory_adjustment: inventoryAdjustmentPayload,
};

/** The record as its service's input (dates as ISO strings, money as decimal strings). */
export function docPayload(ctx: ServiceContext, type: DocType, id: string): Promise<P> {
  return PAYLOAD_OF[type](ctx, id);
}

/** A name / item as its create input (`forEdit`: only the fields an Accountant's Copy may change). */
export async function namePayload(ctx: ServiceContext, type: NameType, id: string, forEdit = false): Promise<P> {
  const { table, cols } = NAME_COLUMNS[type];
  const extra: Record<NameType, string[]> = {
    customer: ['parent_id'],
    vendor: ['currency'],
    item: ['type', 'income_account_id', 'expense_account_id', 'asset_account_id', 'tracking_mode', 'uom_set_id'],
    other_name: [],
  };
  const all = { ...cols, ...Object.fromEntries(extra[type].map((c) => [snakeToCamel(c), c])) };
  const res = await ctx.db.execute(
    sql`SELECT ${sql.raw(Object.entries(all).map(([k, c]) => `t.${c} AS "${k}"`).join(', '))} FROM ${sql.raw(table)} t WHERE t.company_id = ${ctx.companyId}::uuid AND t.id = ${id}::uuid`,
  );
  const row = (res as unknown as { rows: P[] }).rows[0];
  if (!row) throw new ServiceError('NOT_FOUND', `${NAME_LABEL[type]} not found`);
  const shape = NAME_SHAPES[type];
  const out: P = {};
  for (const [k, spec] of Object.entries(shape)) {
    if (forEdit && NAME_ADD_ONLY[type].includes(k)) continue;
    out[k] = normalizeField(row[k], spec);
  }
  return out;
}

const snakeToCamel = (s: string) => s.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

function normalizeField(v: unknown, spec: FieldSpec): unknown {
  if (typeof spec === 'object') return v ?? null;
  const base = spec.replace('?', '');
  if (v === undefined || v === null) return base === 'str' && !spec.endsWith('?') ? '' : null;
  if (base === 'dec') return String(v);
  if (base === 'strmap') return strMap(v);
  if (base === 'ids' || base === 'strs') return Array.isArray(v) && v.length ? v : null;
  if (base === 'bool') return Boolean(v);
  return v;
}

export const NAME_LABEL: Record<NameType, string> = {
  customer: 'Customer',
  vendor: 'Vendor',
  item: 'Item',
  other_name: 'Other name',
};

// ---------------------------------------------------------------------------
// Inventory adjustments made in the copy (accountant side)
// ---------------------------------------------------------------------------

/** Entries of the quantity adjustments made after `since` (still posted). */
export async function adjustmentEntriesSince(ctx: ServiceContext, since: Date): Promise<string[]> {
  const rows = await ctx.db
    .select({ entryId: inventoryMovements.sourceId, date: inventoryMovements.date })
    .from(inventoryMovements)
    .innerJoin(journalEntries, eq(journalEntries.id, inventoryMovements.sourceId))
    .where(
      and(
        eq(inventoryMovements.companyId, ctx.companyId),
        eq(inventoryMovements.sourceType, 'adjustment'),
        sql`${inventoryMovements.createdAt} > ${since}`,
        sql`${inventoryMovements.reversalOfId} IS NULL`,
        eq(journalEntries.status, 'posted'),
      ),
    )
    .orderBy(asc(inventoryMovements.date), asc(inventoryMovements.createdAt));
  return [...new Set(rows.map((r) => r.entryId).filter((x): x is string => !!x))];
}

// ---------------------------------------------------------------------------
// Decoding a payload for the import (ids mapped, dates → Date, line references resolved)
// ---------------------------------------------------------------------------

export interface DecodeHelpers {
  mapId: (id: string) => string;
  toDate: (iso: string) => Date;
  line: (ref: LineRef) => Promise<string>;
}

export async function decodePayload(value: P, shape: Shape, h: DecodeHelpers): Promise<P> {
  const out: P = {};
  for (const [k, spec] of Object.entries(shape)) {
    if (!(k in value)) continue;
    out[k] = await decodeField(value[k], spec, h);
  }
  return out;
}

async function decodeField(v: unknown, spec: FieldSpec, h: DecodeHelpers): Promise<unknown> {
  if (v === null || v === undefined) return v;
  if (typeof spec === 'object') {
    if ('arr' in spec) return Promise.all((v as P[]).map((x) => decodePayload(x, spec.arr, h)));
    return decodePayload(v as P, spec.obj, h);
  }
  switch (spec.replace('?', '')) {
    case 'id':
      return h.mapId(v as string);
    case 'ids':
      return (v as string[]).map(h.mapId);
    case 'date':
      return h.toDate(v as string);
    case 'lineRef':
      return h.line(v as LineRef);
    default:
      return v;
  }
}

// ---------------------------------------------------------------------------
// Apply (client import)
// ---------------------------------------------------------------------------

const asInput = <T>(p: P) => p as unknown as T;

/** Journal items / credits / offsets of a decoded payment payload, as the services take them. */
function journalParts(p: P, target: 'invoiceId' | 'billId') {
  const items = ((p.journalItems as P[] | undefined) ?? []).map((j) => ({ journalLineId: j.line as string, amount: j.amount as string }));
  const credits = ((p.journalCredits as P[] | undefined) ?? []).map((j) => ({
    journalLineId: j.line as string,
    [target]: j[target] as string,
    amount: j.amount as string,
  }));
  const offsets = ((p.journalOffsets as P[] | undefined) ?? []).map((j) => ({
    journalLineId: j.line as string,
    chargeLineId: j.chargeLine as string,
    amount: j.amount as string,
  }));
  return { items, credits, offsets };
}

function withoutDisplay(p: P): P {
  const { total: _t, status: _s, ...rest } = p;
  return rest;
}

/** Service input of a decoded document payload. */
function docInput(type: DocType, p: P): P {
  switch (type) {
    case 'invoice':
      return {
        ...withoutDisplay(p),
        status: p.status === 'draft' ? 'draft' : 'open',
        allowDuplicateNumber: true,
        overrideCreditLimit: true,
        allowOverBilling: true,
      };
    case 'sales_receipt':
    case 'credit_memo':
      return { ...withoutDisplay(p), allowDuplicateNumber: true };
    case 'estimate':
    case 'sales_order':
    case 'purchase_order':
      return { ...withoutDisplay(p), allowDuplicateNumber: true };
    case 'payment_received': {
      const j = journalParts(p, 'invoiceId');
      const { journalItems: _a, journalCredits: _b, journalOffsets: _c, ...rest } = p;
      return { ...rest, journalItems: j.items, journalCredits: j.credits, journalOffsets: j.offsets };
    }
    case 'bill_payment': {
      const j = journalParts(p, 'billId');
      const { journalItems: _a, journalCredits: _b, journalOffsets: _c, amount: _amt, ...rest } = p;
      return { ...rest, journalItems: j.items, journalCredits: j.credits, journalOffsets: j.offsets, checkDuplicateNumber: false };
    }
    case 'inventory_adjustment': {
      const { total: _t, ...rest } = p;
      return rest;
    }
    default:
      return withoutDisplay(p);
  }
}

/** Create the record; returns the new (client) id. */
export async function createDoc(tx: ServiceContext, type: DocType, p: P): Promise<string> {
  const input = docInput(type, p);
  switch (type) {
    case 'invoice':
      return (await createInvoice(tx, asInput<CreateInvoiceInput>(input))).id;
    case 'sales_receipt':
      return (await createSalesReceipt(tx, asInput<CreateSalesReceiptInput>(input))).id;
    case 'credit_memo':
      return (await createCreditMemo(tx, asInput<CreateCreditMemoInput>(input))).id;
    case 'payment_received':
      return (await receivePayment(tx, asInput<ReceivePaymentInput>(input))).payment.id;
    case 'bill':
      return (await createBill(tx, asInput<CreateBillInput>(input))).id;
    case 'bill_payment':
      return (await payBills(tx, asInput<PayBillsInput>(input))).id;
    case 'vendor_credit':
      return (await createVendorCredit(tx, asInput<CreateVendorCreditInput>(input))).id;
    case 'item_receipt':
      return (await createItemReceipt(tx, asInput<CreateItemReceiptInput>(input))).id;
    case 'estimate': {
      const row = await createEstimate(tx, asInput<CreateEstimateInput>(input));
      await setNonPostingStatus(tx, type, row.id, p.status as string);
      return row.id;
    }
    case 'sales_order': {
      const lines = ((input.lines as P[]) ?? []).map(({ id: _id, ...l }) => l);
      const row = await createSalesOrder(tx, asInput<CreateSalesOrderInput>({ ...input, lines }));
      await setNonPostingStatus(tx, type, row.id, p.status as string);
      return row.id;
    }
    case 'purchase_order': {
      const lines = ((input.lines as P[]) ?? []).map(({ id: _id, ...l }) => l);
      const row = await createPurchaseOrder(tx, asInput<CreatePurchaseOrderInput>({ ...input, lines }));
      await setNonPostingStatus(tx, type, row.id, p.status as string);
      return row.id;
    }
    case 'inventory_adjustment':
      return (await adjustQuantityAtSite(tx, asInput<SiteAdjustmentInput>(input))).entryId;
  }
}

/** Status changes of non-posting forms that a user makes (derived ones — partial, closed by conversion — are left alone). */
async function setNonPostingStatus(tx: ServiceContext, type: DocType, id: string, status: string | undefined) {
  if (!status) return;
  if (type === 'estimate') {
    const [cur] = await tx.db.execute(sql`SELECT status::text AS s FROM estimates WHERE id = ${id}::uuid`).then(
      (r) => (r as unknown as { rows: Array<{ s: string }> }).rows,
    );
    if (cur && cur.s !== status && ['draft', 'accepted', 'rejected'].includes(status)) {
      await updateEstimateStatus(tx, id, status as EstimateStatus);
    }
    return;
  }
  const table = type === 'sales_order' ? 'sales_orders' : 'purchase_orders';
  const [cur] = await tx.db.execute(sql`SELECT status::text AS s FROM ${sql.raw(table)} WHERE id = ${id}::uuid`).then(
    (r) => (r as unknown as { rows: Array<{ s: string }> }).rows,
  );
  if (!cur || cur.s === status || !['open', 'closed', 'void'].includes(status)) return;
  if (status === 'open' && cur.s !== 'void' && cur.s !== 'closed') return;
  const fn = type === 'sales_order' ? updateSalesOrderStatus : updatePurchaseOrderStatus;
  await fn(tx, id, status as 'open' | 'closed' | 'void');
}

/** Edit the client's record (already version-checked by the caller). */
export async function updateDoc(tx: ServiceContext, type: DocType, id: string, p: P): Promise<void> {
  const input = docInput(type, p);
  switch (type) {
    case 'invoice': {
      const [cur] = await tx.db.execute(sql`SELECT status::text AS s FROM invoices WHERE id = ${id}::uuid`).then(
        (r) => (r as unknown as { rows: Array<{ s: string }> }).rows,
      );
      const postNow = cur?.s === 'draft' && p.status !== 'draft';
      await updateInvoice(tx, id, asInput<CreateInvoiceInput>({ ...input, status: cur?.s === 'draft' ? 'draft' : 'open' }));
      if (postNow) await postDraftInvoice(tx, id, { overrideCreditLimit: true, allowOverBilling: true });
      return;
    }
    case 'sales_receipt':
      await updateSalesReceipt(tx, id, asInput<CreateSalesReceiptInput>(input));
      return;
    case 'credit_memo':
      await updateCreditMemo(tx, id, asInput<CreateCreditMemoInput>(input));
      return;
    case 'payment_received':
      await updatePayment(tx, id, asInput<ReceivePaymentInput>(input));
      return;
    case 'bill':
      await updateBill(tx, id, asInput<CreateBillInput>(input));
      return;
    case 'bill_payment':
      await updateBillPayment(tx, id, asInput<PayBillsInput>(input));
      return;
    case 'vendor_credit':
      await updateVendorCredit(tx, id, asInput<CreateVendorCreditInput>(input));
      return;
    case 'item_receipt':
      await updateItemReceipt(tx, id, asInput<CreateItemReceiptInput>(input));
      return;
    case 'estimate':
      await updateEstimate(tx, id, asInput<CreateEstimateInput>(input));
      await setNonPostingStatus(tx, type, id, p.status as string);
      return;
    case 'sales_order':
    case 'purchase_order': {
      // Keep the line ids the client's order has (they carry invoiced / received quantities).
      const table = type === 'sales_order' ? 'sales_order_lines' : 'purchase_order_lines';
      const fk = type === 'sales_order' ? 'sales_order_id' : 'purchase_order_id';
      const existing = new Set(
        (
          (await tx.db.execute(sql`SELECT id::text AS id FROM ${sql.raw(table)} WHERE ${sql.raw(fk)} = ${id}::uuid`)) as unknown as {
            rows: Array<{ id: string }>;
          }
        ).rows.map((r) => r.id),
      );
      const lines = ((input.lines as P[]) ?? []).map((l) => ({ ...l, id: l.id && existing.has(l.id as string) ? l.id : null }));
      if (type === 'sales_order') await updateSalesOrder(tx, id, asInput<CreateSalesOrderInput>({ ...input, lines }));
      else await updatePurchaseOrder(tx, id, asInput<CreatePurchaseOrderInput>({ ...input, lines }) as never);
      await setNonPostingStatus(tx, type, id, p.status as string);
      return;
    }
    case 'inventory_adjustment':
      throw validation('An inventory adjustment can only be added.');
  }
}

export async function voidDoc(tx: ServiceContext, type: DocType, id: string): Promise<void> {
  switch (type) {
    case 'invoice':
      await voidInvoice(tx, id);
      return;
    case 'sales_receipt':
      await voidSalesReceipt(tx, id);
      return;
    case 'credit_memo':
      await voidCreditMemo(tx, id);
      return;
    case 'payment_received':
      await voidPayment(tx, id);
      return;
    case 'bill':
      await voidBill(tx, id);
      return;
    case 'bill_payment':
      await voidBillPayment(tx, id);
      return;
    case 'vendor_credit':
      await voidVendorCredit(tx, id);
      return;
    case 'item_receipt':
      await voidItemReceipt(tx, id);
      return;
    case 'sales_order':
      await updateSalesOrderStatus(tx, id, 'void');
      return;
    case 'purchase_order':
      await updatePurchaseOrderStatus(tx, id, 'void');
      return;
    default:
      throw validation(`A ${DOC_LABEL[type].toLowerCase()} can't be voided.`);
  }
}

/** Create a name / item; returns the new (client) id. */
export async function createName(tx: ServiceContext, type: NameType, p: P): Promise<string> {
  switch (type) {
    case 'customer':
      return (await createCustomer(tx, asInput<CreateCustomerInput>(p))).id;
    case 'vendor':
      return (await createVendor(tx, asInput<CreateVendorInput>(p))).id;
    case 'item':
      return (await createItem(tx, asInput<CreateItemInput>(p))).id;
    case 'other_name':
      return (await createEntry(tx, 'other-names', p)).id;
  }
}

export async function updateName(tx: ServiceContext, type: NameType, id: string, p: P): Promise<void> {
  const patch: P = { ...p };
  for (const k of NAME_ADD_ONLY[type]) delete patch[k];
  switch (type) {
    case 'customer':
      await updateCustomer(tx, id, patch as never);
      return;
    case 'vendor':
      await updateVendor(tx, id, patch as never);
      return;
    case 'item':
      await updateItem(tx, id, patch as never);
      return;
    case 'other_name':
      await updateListEntry(tx, 'other-names', id, patch);
      return;
  }
}

/** Version of a name record (other names have no record locking of their own). */
export async function otherNameVersion(tx: Pick<ServiceContext, 'db' | 'companyId'>, id: string): Promise<Date | null> {
  const [r] = await tx.db
    .select({ v: otherNames.updatedAt })
    .from(otherNames)
    .where(and(eq(otherNames.id, id), eq(otherNames.companyId, tx.companyId)));
  return r?.v ?? null;
}

// ---------------------------------------------------------------------------
// Plain-language descriptions
// ---------------------------------------------------------------------------

export const DOC_LABEL: Record<DocType, string> = {
  invoice: 'Invoice',
  sales_receipt: 'Sales receipt',
  credit_memo: 'Credit memo',
  payment_received: 'Customer payment',
  bill: 'Bill',
  bill_payment: 'Bill payment',
  vendor_credit: 'Vendor credit',
  item_receipt: 'Item receipt',
  estimate: 'Estimate',
  sales_order: 'Sales order',
  purchase_order: 'Purchase order',
  inventory_adjustment: 'Inventory adjustment',
};

/** Labels for the ids a payload names (accounts, classes, names, items, documents). */
export interface Labels {
  account(id: unknown): string;
  cls(id: unknown): string;
  name(id: unknown): string;
  item(id: unknown): string;
  /** "Invoice #1004 (Steady Customer)" for a document id, if known. */
  doc(id: unknown): string;
}

const money = (v: unknown) => formatCurrency(String(v ?? '0'));
const qtyText = (v: unknown) => {
  const n = Money.of(String(v ?? '0'));
  return n.toDecimalPlaces(4).toString();
};

function salesLine(L: Labels, l: P): string {
  const what = l.itemId ? L.item(l.itemId) : L.account(l.accountId);
  const amount = l.rate != null ? Money.mul(String(l.quantity ?? '1'), String(l.rate)) : null;
  const extras = [l.description, l.classId ? `class ${L.cls(l.classId)}` : null].filter(Boolean);
  return `${what} — ${qtyText(l.quantity)} × ${money(l.rate ?? 0)}${amount ? ` = ${money(toAmountString(amount))}` : ''}${extras.length ? ` (${extras.join(', ')})` : ''}`;
}

function purchaseLine(L: Labels, l: P): string {
  const what = l.itemId ? `${L.item(l.itemId)}${l.quantity ? ` × ${qtyText(l.quantity)}` : ''}` : L.account(l.accountId);
  const amount =
    l.amount != null ? String(l.amount) : l.unitCost != null && l.quantity != null ? toAmountString(Money.mul(String(l.quantity), String(l.unitCost))) : '0';
  const extras = [l.description, l.classId ? `class ${L.cls(l.classId)}` : null, l.customerId ? `for ${L.name(l.customerId)}` : null].filter(Boolean);
  return `${what} — ${money(amount)}${extras.length ? ` (${extras.join(', ')})` : ''}`;
}

export interface Described {
  title: string;
  amount: string | null;
  lines: string[];
}

/** Title + amount + detail lines of a document payload. */
export function describeDoc(type: DocType, p: P, L: Labels): Described {
  const num = (k: string) => (p[k] ? ` #${p[k]}` : '');
  const memo = p.memo ? [`Memo: ${p.memo}`] : [];
  const day = ymd(p.date);
  switch (type) {
    case 'invoice':
    case 'sales_receipt':
    case 'credit_memo':
    case 'estimate':
    case 'sales_order': {
      const who = p.customerId ? L.name(p.customerId) : 'no customer';
      const head = `${DOC_LABEL[type]}${num('refNumber')} for ${who}, ${day}${p.status === 'draft' && type === 'invoice' ? ' (pending)' : ''}`;
      const extra = [
        ...(type === 'sales_receipt' && p.depositAccountId ? [`Deposited to ${L.account(p.depositAccountId)}`] : []),
        ...(p.discount ? [`Discount ${money(p.discount)}`] : []),
        ...(type !== 'invoice' && type !== 'sales_receipt' && type !== 'credit_memo' && p.status ? [`Status: ${p.status}`] : []),
      ];
      return {
        title: head,
        amount: toAmountString(String(p.total ?? '0')),
        lines: [head, ...((p.lines as P[]) ?? []).map((l) => salesLine(L, l)), ...extra, ...memo],
      };
    }
    case 'purchase_order': {
      const head = `${DOC_LABEL[type]}${num('refNumber')} to ${L.name(p.vendorId)}, ${day}`;
      return {
        title: head,
        amount: toAmountString(String(p.total ?? '0')),
        lines: [head, ...((p.lines as P[]) ?? []).map((l) => salesLine(L, l)), `Status: ${p.status}`, ...memo],
      };
    }
    case 'bill':
    case 'vendor_credit':
    case 'item_receipt': {
      const ref = type === 'bill' ? num('billNumber') : type === 'vendor_credit' ? num('refNumber') : num('reference');
      const head = `${DOC_LABEL[type]}${ref} from ${L.name(p.vendorId)}, ${day}`;
      return {
        title: head,
        amount: toAmountString(String(p.total ?? '0')),
        lines: [head, ...((p.lines as P[]) ?? []).map((l) => purchaseLine(L, l)), ...(p.purchaseOrderId ? [`Against ${L.doc(p.purchaseOrderId)}`] : []), ...memo],
      };
    }
    case 'payment_received': {
      const head = `Payment${p.reference ? ` #${p.reference}` : ''} from ${L.name(p.customerId)}, ${day} — ${money(p.amount)} by ${String(p.method).replace(/_/g, ' ')}`;
      const apps = ((p.applications as P[]) ?? []).map(
        (a) => `Applied ${money(a.amountApplied)} to ${L.doc(a.invoiceId)}${a.discountAmount ? ` (discount ${money(a.discountAmount)})` : ''}`,
      );
      const credits = ((p.credits as P[]) ?? []).map((c) => `Credit ${L.doc(c.creditMemoId)} — ${money(c.amount)} to ${L.doc(c.invoiceId)}`);
      const journal = [
        ...((p.journalItems as P[]) ?? []).map((j) => `Paid ${money(j.amount)} of a journal entry charge`),
        ...((p.journalCredits as P[]) ?? []).map((j) => `Journal entry credit ${money(j.amount)} applied to ${L.doc(j.invoiceId)}`),
        ...((p.journalOffsets as P[]) ?? []).map((j) => `Journal entry credit ${money(j.amount)} applied to a journal entry charge`),
      ];
      return {
        title: `Payment from ${L.name(p.customerId)}${p.reference ? ` #${p.reference}` : ''}`,
        amount: toAmountString(String(p.amount)),
        lines: [head, ...(p.depositAccountId ? [`Deposited to ${L.account(p.depositAccountId)}`] : []), ...apps, ...credits, ...journal, ...memo],
      };
    }
    case 'bill_payment': {
      const head = `Bill payment${p.reference ? ` #${p.reference}` : ''} to ${L.name(p.vendorId)}, ${day} — ${money(p.amount)} from ${L.account(p.paymentAccountId)}`;
      const apps = ((p.applications as P[]) ?? []).map(
        (a) => `Paid ${money(a.amountApplied)} on ${L.doc(a.billId)}${a.discountTaken ? ` (discount ${money(a.discountTaken)})` : ''}`,
      );
      const journal = [
        ...((p.journalItems as P[]) ?? []).map((j) => `Paid ${money(j.amount)} of a journal entry amount owed`),
        ...((p.journalCredits as P[]) ?? []).map((j) => `Journal entry credit ${money(j.amount)} applied to ${L.doc(j.billId)}`),
        ...((p.journalOffsets as P[]) ?? []).map((j) => `Journal entry credit ${money(j.amount)} applied to a journal entry amount owed`),
      ];
      return {
        title: `Bill payment to ${L.name(p.vendorId)}${p.reference ? ` #${p.reference}` : ''}`,
        amount: toAmountString(String(p.amount)),
        lines: [head, ...apps, ...journal],
      };
    }
    case 'inventory_adjustment': {
      const qty = Money.of(String(p.quantityChange));
      const head = `${qty.greaterThan(0) ? 'Add' : 'Remove'} ${qty.abs().toDecimalPlaces(4).toString()} of ${L.item(p.itemId)}, ${day}`;
      return {
        title: `Inventory adjustment: ${L.item(p.itemId)}`,
        amount: toAmountString(String(p.total ?? '0')),
        lines: [
          head,
          ...(p.unitCost ? [`At ${money(toAmountString(Money.round2(p.unitCost as string)))} each`] : ['At average cost']),
          ...(p.adjustmentAccountId ? [`Adjustment account: ${L.account(p.adjustmentAccountId)}`] : []),
          ...memo,
        ],
      };
    }
  }
}

/** Title + detail lines of a name / item payload. */
export function describeName(type: NameType, p: P, L: Labels): Described {
  const label = (p.displayName ?? p.name) as string;
  const lines = [`${NAME_LABEL[type]}: ${label}`];
  const show: Array<[string, string]> = [
    ['companyName', 'Company'],
    ['email', 'Email'],
    ['phone', 'Phone'],
    ['terms', 'Terms'],
    ['creditLimit', 'Credit limit'],
    ['sku', 'SKU'],
    ['description', 'Description'],
    ['salesPrice', 'Sales price'],
    ['purchaseCost', 'Cost'],
    ['accountNumber', 'Account no.'],
    ['printOnCheckAs', 'Print on check as'],
    ['notes', 'Notes'],
  ];
  for (const [k, t] of show) {
    const v = p[k];
    if (v === null || v === undefined || v === '') continue;
    lines.push(`${t}: ${k === 'creditLimit' || k === 'salesPrice' || k === 'purchaseCost' ? money(v) : String(v)}`);
  }
  for (const k of ['billingAddress', 'shippingAddress', 'address']) {
    const a = p[k] as Record<string, string> | null | undefined;
    if (a && Object.values(a).some(Boolean)) lines.push(`${k === 'shippingAddress' ? 'Ship to' : 'Address'}: ${Object.values(a).filter(Boolean).join(', ')}`);
  }
  if (p.is1099) lines.push('1099 vendor');
  if (p.type) lines.push(`Type: ${String(p.type).replace(/_/g, ' ')}`);
  if (p.parentId) lines.push(`Under ${L.name(p.parentId)}`);
  if (p.defaultExpenseAccountId) lines.push(`Default account: ${L.account(p.defaultExpenseAccountId)}`);
  return { title: `${NAME_LABEL[type]} ${label}`, amount: null, lines };
}

/** The fields an edit changes, as "Field: before → after" (for names / items). */
export function nameEditSummary(before: P, after: P): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(after)) {
    const b = before[k];
    if (JSON.stringify(b ?? null) === JSON.stringify(v ?? null)) continue;
    const show = (x: unknown) => (x === null || x === undefined || x === '' ? '(blank)' : typeof x === 'object' ? Object.values(x as P).filter(Boolean).join(', ') : String(x));
    out.push(`${k.replace(/([A-Z])/g, ' $1').toLowerCase()}: ${show(b)} → ${show(v)}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ids a payload names, by kind (for labels)
// ---------------------------------------------------------------------------

/** Every id in a payload, grouped by the field that holds it (camelCase key). */
export function idsIn(p: unknown, shape: Shape, out: Map<string, Set<string>> = new Map()): Map<string, Set<string>> {
  if (!p || typeof p !== 'object') return out;
  for (const [k, spec] of Object.entries(shape)) {
    const v = (p as P)[k];
    if (v === null || v === undefined) continue;
    if (typeof spec === 'object') {
      if ('arr' in spec) for (const x of v as P[]) idsIn(x, spec.arr, out);
      else idsIn(v, spec.obj, out);
      continue;
    }
    const base = spec.replace('?', '');
    if (base === 'id' || base === 'ids') {
      if (!out.has(k)) out.set(k, new Set());
      for (const id of base === 'ids' ? (v as string[]) : [v as string]) out.get(k)!.add(id);
    }
  }
  return out;
}

/** Customer / vendor / other-name / employee display names, by id (company-scoped). */
export async function partyNames(ctx: Pick<ServiceContext, 'db' | 'companyId'>, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  for (const r of await ctx.db
    .select({ id: customers.id, n: customers.displayName })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), inArray(customers.id, ids)))) out.set(r.id, r.n);
  for (const r of await ctx.db
    .select({ id: vendors.id, n: vendors.displayName })
    .from(vendors)
    .where(and(eq(vendors.companyId, ctx.companyId), inArray(vendors.id, ids)))) out.set(r.id, r.n);
  for (const r of await ctx.db
    .select({ id: otherNames.id, n: otherNames.name })
    .from(otherNames)
    .where(and(eq(otherNames.companyId, ctx.companyId), inArray(otherNames.id, ids)))) out.set(r.id, r.n);
  return out;
}

export { DOC_SHAPES, NAME_SHAPES };
