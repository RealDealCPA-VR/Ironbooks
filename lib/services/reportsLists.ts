/**
 * Standard customer / vendor / sales / purchases reports and list reports (QB Reports menu):
 *
 *  - Customer Balance Summary / Detail and Vendor Balance Summary / Detail — built from the A/R
 *    and A/P ledger lines (so they always tie to the balance sheet), by name.
 *  - Unpaid Bills Detail, Bills & Applied Payments, Open Purchase Orders.
 *  - Sales by Customer Detail, Sales by Item Detail, Open Sales Orders by Customer / by Item.
 *  - Expenses by Vendor Summary / Detail (expense, COGS and other-expense ledger lines).
 *  - List reports: Customer / Vendor Contact and Phone lists, Item Price List, Item Listing,
 *    Account Listing.
 *  - Income Tax Preparation / Summary / Detail (by tax line, via a mapping function).
 */
import { and, asc, eq, gte, inArray, isNull, lte, ne, notInArray, sql, type SQL } from 'drizzle-orm';
import type Decimal from 'decimal.js';
import {
  accounts,
  billLines,
  billPaymentApplications,
  billPayments,
  bills,
  creditMemoLines,
  creditMemos,
  customers,
  invoiceLines,
  invoices,
  items,
  purchaseOrderLines,
  purchaseOrders,
  salesOrderLines,
  salesOrders,
  salesReceiptLines,
  salesReceipts,
  vendors,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import type { CellValue, StdColumn, StdReport, StdRow } from '@/lib/reports/types';
import type { ReportParams } from '@/lib/validation/reports';
import type { ServiceContext } from './_base';
import { apAgingDetail } from './reportsExtra';
import {
  SECTION_LABELS,
  activityByAccount,
  customerNames,
  dayStr,
  detailColumns,
  entryIdsForSourceRefs,
  fetchGlLines,
  fmtDay,
  glFilterFromParams,
  isPLSection,
  layoutDetail,
  loadAccountMeta,
  naturalAmount,
  resolveAsOf,
  resolveRange,
  stdHref,
  type AccountMeta,
  type GlLine,
  type NameType,
  type SectionKey,
} from './reportEngine';
import { rangeLabel } from './reportsStandard';
import { docRef } from './docNumbers';

const amt = (v: Decimal) => toAmountString(v);

// ===========================================================================
// Customer / Vendor balances (A/R and A/P ledger by name)
// ===========================================================================

async function ledgerByName(
  ctx: ServiceContext,
  section: 'ar' | 'ap',
  p: ReportParams,
  range: { from?: Date; to?: Date },
) {
  const meta = await loadAccountMeta(ctx);
  const f = glFilterFromParams(meta, p, range);
  f.sections = [section];
  return { meta, ...(await fetchGlLines(ctx, meta, { ...f, limit: 50000 })) };
}

function balanceSummary(
  lines: GlLine[],
  nameType: NameType,
  detailKey: string,
  asOf: Date,
): { rows: StdRow[]; total: Decimal } {
  const byName = new Map<string, { name: string; total: Decimal }>();
  for (const l of lines) {
    const key = l.nameType === nameType && l.nameId ? l.nameId : '';
    const name = key ? l.name || '(unnamed)' : '(no name)';
    const cur = byName.get(key) ?? { name, total: Money.zero() };
    cur.total = cur.total.plus(l.natural);
    byName.set(key, cur);
  }
  let total = Money.zero();
  const rows: StdRow[] = [...byName.entries()]
    .filter(([, v]) => !v.total.isZero())
    .sort((a, b) => (a[0] === '' ? 1 : b[0] === '' ? -1 : a[1].name.localeCompare(b[1].name)))
    .map(([id, v]) => {
      total = total.plus(v.total);
      const param = nameType === 'customer' ? 'customerId' : 'vendorId';
      return {
        id: `bal:${id || 'none'}`,
        depth: 0,
        kind: 'data' as const,
        cells: { label: v.name, balance: amt(v.total) },
        href: id ? stdHref(detailKey, { [param]: id, to: dayStr(asOf) }) : null,
      };
    });
  rows.push({ id: 'bal:total', depth: 0, kind: 'grand', cells: { label: 'TOTAL', balance: amt(total) } });
  return { rows, total };
}

export async function customerBalanceSummary(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const asOf = resolveAsOf(p);
  const { lines, truncated } = await ledgerByName(ctx, 'ar', { ...p, customerId: undefined }, { to: asOf });
  const { rows } = balanceSummary(lines, 'customer', 'customer-balance-detail', asOf);
  return {
    key: 'customer-balance-summary',
    title: 'Customer Balance Summary',
    subtitle: `As of ${fmtDay(asOf)}`,
    columns: [{ key: 'label', header: 'Customer' }, { key: 'balance', header: 'Balance', type: 'money' }],
    rows,
    truncated,
  };
}

export async function vendorBalanceSummary(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const asOf = resolveAsOf(p);
  const { lines, truncated } = await ledgerByName(ctx, 'ap', { ...p, vendorId: undefined }, { to: asOf });
  const { rows } = balanceSummary(lines, 'vendor', 'vendor-balance-detail', asOf);
  return {
    key: 'vendor-balance-summary',
    title: 'Vendor Balance Summary',
    subtitle: `As of ${fmtDay(asOf)}`,
    columns: [{ key: 'label', header: 'Vendor' }, { key: 'balance', header: 'Balance', type: 'money' }],
    rows,
    truncated,
  };
}

async function balanceDetail(ctx: ServiceContext, p: ReportParams, section: 'ar' | 'ap'): Promise<StdReport> {
  const asOf = resolveAsOf(p);
  const from = p.from ? (await resolveRange(ctx, { from: p.from, to: dayStr(asOf) })).from : undefined;
  const { lines, truncated } = await ledgerByName(ctx, section, p, { from, to: asOf });
  const keys = ['label', 'type', 'date', 'num', 'memo', 'account', 'amount', 'balance'];
  const laid = layoutDetail(lines, {
    columns: detailColumns(keys),
    groupBy: 'name',
    sortBy: p.sortBy,
    sortDir: p.sortDir,
    natural: true,
    running: true,
    idPrefix: `bd${section}`,
  });
  const customer = section === 'ar';
  return {
    key: customer ? 'customer-balance-detail' : 'vendor-balance-detail',
    title: customer ? 'Customer Balance Detail' : 'Vendor Balance Detail',
    subtitle: from ? rangeLabel(from, asOf) : `All transactions as of ${fmtDay(asOf)}`,
    columns: detailColumns(keys),
    rows: laid.rows,
    truncated,
  };
}

export const customerBalanceDetail = (ctx: ServiceContext, p: ReportParams) => balanceDetail(ctx, p, 'ar');
export const vendorBalanceDetail = (ctx: ServiceContext, p: ReportParams) => balanceDetail(ctx, p, 'ap');

// ===========================================================================
// Unpaid Bills Detail / Bills & Applied Payments / Open Purchase Orders
// ===========================================================================

export async function unpaidBillsDetail(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const asOf = resolveAsOf(p);
  const aging = await apAgingDetail(ctx, asOf);
  const docs = aging.rows.filter((r) => !p.vendorId || r.entityId === p.vendorId);
  const refs = docs.map((r) => `${r.docType === 'bill' ? 'bill' : 'vendor_credit'}:${r.docId}`);
  const entryIds = await entryIdsForSourceRefs(ctx, refs);
  const byVendor = new Map<string, typeof docs>();
  for (const r of docs) byVendor.set(r.entityId, [...(byVendor.get(r.entityId) ?? []), r]);
  const rows: StdRow[] = [];
  let total = Money.zero();
  for (const [vid, list] of [...byVendor.entries()].sort((a, b) => a[1][0].entityName.localeCompare(b[1][0].entityName))) {
    const hid = `ub:${vid}`;
    let sub = Money.zero();
    const header: StdRow = { id: hid, depth: 0, kind: 'section', collapseKind: 'group', cells: { label: list[0].entityName } };
    rows.push(header);
    for (const r of list.sort((a, b) => (a.dueDate ?? a.date).localeCompare(b.dueDate ?? b.date))) {
      sub = sub.plus(Money.of(r.openBalance));
      rows.push({
        id: `ub:d:${r.docId}`,
        parentId: hid,
        depth: 1,
        kind: 'data',
        cells: {
          label: '',
          type: r.docType === 'bill' ? 'Bill' : 'Bill Credit',
          date: r.date.slice(0, 10),
          num: r.docNumber,
          due: r.dueDate ? r.dueDate.slice(0, 10) : '',
          aging: r.daysPastDue > 0 ? r.daysPastDue : null,
          open: r.openBalance,
        },
        entryId: entryIds.get(refs[docs.indexOf(r)]) ?? null,
      });
    }
    total = total.plus(sub);
    header.collapsedCells = { label: list[0].entityName, open: amt(sub) };
    rows.push({ id: `${hid}:total`, depth: 0, kind: 'subtotal', totalOf: hid, cells: { label: `Total ${list[0].entityName}`, open: amt(sub) } });
  }
  rows.push({ id: 'ub:grand', depth: 0, kind: 'grand', cells: { label: 'TOTAL', open: amt(total) } });
  return {
    key: 'unpaid-bills-detail',
    title: 'Unpaid Bills Detail',
    subtitle: `As of ${fmtDay(asOf)}`,
    columns: [
      { key: 'label', header: '' },
      { key: 'type', header: 'Type' },
      { key: 'date', header: 'Date', type: 'date' },
      { key: 'num', header: 'Num' },
      { key: 'due', header: 'Due Date', type: 'date' },
      { key: 'aging', header: 'Aging (days)', type: 'number' },
      { key: 'open', header: 'Open Balance', type: 'money' },
    ],
    rows,
  };
}

export async function billsAndAppliedPayments(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  const conds: SQL[] = [eq(bills.companyId, ctx.companyId), ne(bills.status, 'void'), gte(bills.date, from), lte(bills.date, to)];
  if (p.vendorId) conds.push(eq(bills.vendorId, p.vendorId));
  const billRows = await ctx.db
    .select({
      id: bills.id,
      vendorId: bills.vendorId,
      vendor: vendors.displayName,
      num: bills.billNumber,
      date: bills.date,
      total: bills.total,
      credited: bills.amountCredited,
      balanceDue: bills.balanceDue,
    })
    .from(bills)
    .innerJoin(vendors, eq(bills.vendorId, vendors.id))
    .where(and(...conds))
    .orderBy(asc(vendors.displayName), asc(bills.date));
  const ids = billRows.map((b) => b.id);
  const apps = ids.length
    ? await ctx.db
        .select({
          billId: billPaymentApplications.billId,
          paymentId: billPayments.id,
          date: billPayments.date,
          ref: billPayments.reference,
          method: billPayments.method,
          applied: billPaymentApplications.amountApplied,
        })
        .from(billPaymentApplications)
        .innerJoin(billPayments, eq(billPaymentApplications.billPaymentId, billPayments.id))
        .where(and(inArray(billPaymentApplications.billId, ids), isNull(billPayments.voidedAt)))
    : [];
  const entryIds = await entryIdsForSourceRefs(ctx, ids.map((i) => `bill:${i}`));
  const rows: StdRow[] = [];
  let tBill = Money.zero();
  let tPaid = Money.zero();
  for (const b of billRows) {
    const hid = `bap:${b.id}`;
    tBill = tBill.plus(Money.of(b.total));
    const header: StdRow = {
      id: hid,
      depth: 0,
      kind: 'data',
      collapseKind: 'group',
      cells: { label: b.vendor, type: 'Bill', date: dayStr(b.date), num: b.num ?? '', amount: toAmountString(b.total), open: toAmountString(b.balanceDue) },
      entryId: entryIds.get(`bill:${b.id}`) ?? null,
    };
    rows.push(header);
    for (const a of apps.filter((x) => x.billId === b.id).sort((x, y) => x.date.getTime() - y.date.getTime())) {
      tPaid = tPaid.plus(Money.of(a.applied));
      rows.push({
        id: `bap:p:${b.id}:${a.paymentId}`,
        parentId: hid,
        depth: 1,
        kind: 'data',
        cells: { label: '', type: 'Bill Pmt', date: dayStr(a.date), num: a.ref ?? '', memo: a.method, amount: toAmountString(Money.of(a.applied).negated()) },
      });
    }
    if (!Money.isZero(b.credited)) {
      rows.push({
        id: `bap:c:${b.id}`,
        parentId: hid,
        depth: 1,
        kind: 'data',
        cells: { label: '', type: 'Bill Credit', memo: 'Credits applied', amount: toAmountString(Money.of(b.credited).negated()) },
      });
    }
  }
  rows.push({ id: 'bap:grand', depth: 0, kind: 'grand', cells: { label: 'TOTAL', amount: amt(tBill.minus(tPaid)) } });
  return {
    key: 'bills-applied-payments',
    title: 'Bills & Applied Payments',
    subtitle: rangeLabel(from, to),
    columns: [
      { key: 'label', header: 'Vendor' },
      { key: 'type', header: 'Type' },
      { key: 'date', header: 'Date', type: 'date' },
      { key: 'num', header: 'Num' },
      { key: 'memo', header: 'Memo' },
      { key: 'amount', header: 'Amount', type: 'money' },
      { key: 'open', header: 'Open Balance', type: 'money' },
    ],
    rows,
  };
}

/** Open Purchase Orders — PO lines not yet fully received/billed, by vendor. */
export async function openPurchaseOrders(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const conds: SQL[] = [eq(purchaseOrders.companyId, ctx.companyId), notInArray(purchaseOrders.status, ['void', 'closed', 'paid'])];
  if (p.vendorId) conds.push(eq(purchaseOrders.vendorId, p.vendorId));
  if (p.to) conds.push(lte(purchaseOrders.date, resolveAsOf(p)));
  const rowsDb = await ctx.db
    .select({
      poId: purchaseOrders.id,
      poNumber: purchaseOrders.poNumber,
      poRef: purchaseOrders.refNumber,
      date: purchaseOrders.date,
      expected: purchaseOrders.expectedDate,
      vendorId: purchaseOrders.vendorId,
      vendor: vendors.displayName,
      lineId: purchaseOrderLines.id,
      item: items.name,
      description: purchaseOrderLines.description,
      qty: purchaseOrderLines.quantity,
      billed: purchaseOrderLines.quantityBilled,
      rate: purchaseOrderLines.rate,
    })
    .from(purchaseOrderLines)
    .innerJoin(purchaseOrders, eq(purchaseOrderLines.purchaseOrderId, purchaseOrders.id))
    .innerJoin(vendors, eq(purchaseOrders.vendorId, vendors.id))
    .leftJoin(items, eq(purchaseOrderLines.itemId, items.id))
    .where(and(...conds))
    .orderBy(asc(vendors.displayName), asc(purchaseOrders.date), asc(purchaseOrderLines.lineOrder));
  const groups = new Map<string, typeof rowsDb>();
  for (const r of rowsDb) {
    const remaining = Money.of(r.qty).minus(Money.of(r.billed));
    if (!remaining.greaterThan(0)) continue;
    groups.set(r.vendorId, [...(groups.get(r.vendorId) ?? []), r]);
  }
  const rows: StdRow[] = [];
  let total = Money.zero();
  for (const [vid, list] of groups) {
    const hid = `opo:${vid}`;
    const header: StdRow = { id: hid, depth: 0, kind: 'section', collapseKind: 'group', cells: { label: list[0].vendor } };
    rows.push(header);
    let sub = Money.zero();
    for (const r of list) {
      const remaining = Money.of(r.qty).minus(Money.of(r.billed));
      const open = Money.round2(remaining.times(Money.of(r.rate)));
      sub = sub.plus(open);
      rows.push({
        id: `opo:l:${r.lineId}`,
        parentId: hid,
        depth: 1,
        kind: 'data',
        cells: {
          label: '',
          date: dayStr(r.date),
          num: docRef(r.poRef, r.poNumber),
          due: r.expected ? dayStr(r.expected) : '',
          item: r.item ?? r.description ?? '',
          qty: r.qty,
          received: r.billed,
          backordered: remaining.toFixed(4),
          open: amt(open),
        },
        href: '/purchase-orders',
      });
    }
    total = total.plus(sub);
    header.collapsedCells = { label: list[0].vendor, open: amt(sub) };
    rows.push({ id: `${hid}:total`, depth: 0, kind: 'subtotal', totalOf: hid, cells: { label: `Total ${list[0].vendor}`, open: amt(sub) } });
  }
  rows.push({ id: 'opo:grand', depth: 0, kind: 'grand', cells: { label: 'TOTAL', open: amt(total) } });
  return {
    key: 'open-purchase-orders',
    title: 'Open Purchase Orders',
    subtitle: 'All open purchase orders',
    columns: [
      { key: 'label', header: 'Vendor' },
      { key: 'date', header: 'Date', type: 'date' },
      { key: 'num', header: 'PO #' },
      { key: 'due', header: 'Expected', type: 'date' },
      { key: 'item', header: 'Item' },
      { key: 'qty', header: 'Qty Ordered', type: 'number' },
      { key: 'received', header: 'Received / Billed', type: 'number' },
      { key: 'backordered', header: 'Backordered', type: 'number' },
      { key: 'open', header: 'Open Amount', type: 'money' },
    ],
    rows,
  };
}

// ===========================================================================
// Sales detail (by customer / by item) and open sales orders
// ===========================================================================

interface SalesLine {
  id: string;
  type: 'Invoice' | 'Sales Receipt' | 'Credit Memo';
  sourceRef: string;
  date: Date;
  num: string;
  customerId: string | null;
  itemId: string | null;
  item: string;
  memo: string;
  qty: Decimal;
  price: Decimal;
  amount: Decimal;
}

/** Item sales lines (invoices, sales receipts, credit memos as negatives) in a date range. */
export async function salesLines(
  ctx: ServiceContext,
  range: { from: Date; to: Date },
  filter: { customerId?: string; itemId?: string; classId?: string } = {},
): Promise<SalesLine[]> {
  const c = ctx.companyId;
  const out: SalesLine[] = [];
  const invConds: SQL[] = [eq(invoices.companyId, c), notInArray(invoices.status, ['void', 'draft']), gte(invoices.date, range.from), lte(invoices.date, range.to)];
  if (filter.customerId) invConds.push(eq(invoices.customerId, filter.customerId));
  if (filter.itemId) invConds.push(eq(invoiceLines.itemId, filter.itemId));
  if (filter.classId) invConds.push(sql`COALESCE(${invoiceLines.classId}, ${invoices.classId}) = ${filter.classId}`);
  for (const r of await ctx.db
    .select({
      id: invoiceLines.id,
      docId: invoices.id,
      date: invoices.date,
      num: invoices.invoiceNumber, ref: invoices.refNumber,
      customerId: invoices.customerId,
      itemId: invoiceLines.itemId,
      item: items.name,
      memo: invoiceLines.description,
      qty: invoiceLines.quantity,
      rate: invoiceLines.rate,
      amount: invoiceLines.amount,
    })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoiceLines.invoiceId, invoices.id))
    .leftJoin(items, eq(invoiceLines.itemId, items.id))
    .where(and(...invConds))) {
    out.push({ id: r.id, type: 'Invoice', sourceRef: `invoice:${r.docId}`, date: r.date, num: docRef(r.ref, r.num), customerId: r.customerId, itemId: r.itemId, item: r.item ?? '', memo: r.memo ?? '', qty: Money.of(r.qty), price: Money.of(r.rate), amount: Money.of(r.amount) });
  }
  const srConds: SQL[] = [eq(salesReceipts.companyId, c), ne(salesReceipts.status, 'void'), gte(salesReceipts.date, range.from), lte(salesReceipts.date, range.to)];
  if (filter.customerId) srConds.push(eq(salesReceipts.customerId, filter.customerId));
  if (filter.itemId) srConds.push(eq(salesReceiptLines.itemId, filter.itemId));
  if (filter.classId) srConds.push(sql`COALESCE(${salesReceiptLines.classId}, ${salesReceipts.classId}) = ${filter.classId}`);
  for (const r of await ctx.db
    .select({
      id: salesReceiptLines.id,
      docId: salesReceipts.id,
      date: salesReceipts.date,
      num: salesReceipts.receiptNumber, ref: salesReceipts.refNumber,
      customerId: salesReceipts.customerId,
      itemId: salesReceiptLines.itemId,
      item: items.name,
      memo: salesReceiptLines.description,
      qty: salesReceiptLines.quantity,
      rate: salesReceiptLines.rate,
      amount: salesReceiptLines.amount,
    })
    .from(salesReceiptLines)
    .innerJoin(salesReceipts, eq(salesReceiptLines.salesReceiptId, salesReceipts.id))
    .leftJoin(items, eq(salesReceiptLines.itemId, items.id))
    .where(and(...srConds))) {
    out.push({ id: r.id, type: 'Sales Receipt', sourceRef: `salesreceipt:${r.docId}`, date: r.date, num: docRef(r.ref, r.num), customerId: r.customerId, itemId: r.itemId, item: r.item ?? '', memo: r.memo ?? '', qty: Money.of(r.qty), price: Money.of(r.rate), amount: Money.of(r.amount) });
  }
  if (!filter.classId) {
    const cmConds: SQL[] = [eq(creditMemos.companyId, c), ne(creditMemos.status, 'void'), gte(creditMemos.date, range.from), lte(creditMemos.date, range.to)];
    if (filter.customerId) cmConds.push(eq(creditMemos.customerId, filter.customerId));
    if (filter.itemId) cmConds.push(eq(creditMemoLines.itemId, filter.itemId));
    for (const r of await ctx.db
      .select({
        id: creditMemoLines.id,
        docId: creditMemos.id,
        date: creditMemos.date,
        num: creditMemos.memoNumber, ref: creditMemos.refNumber,
        customerId: creditMemos.customerId,
        itemId: creditMemoLines.itemId,
        item: items.name,
        memo: creditMemoLines.description,
        qty: creditMemoLines.quantity,
        rate: creditMemoLines.rate,
        amount: creditMemoLines.amount,
      })
      .from(creditMemoLines)
      .innerJoin(creditMemos, eq(creditMemoLines.creditMemoId, creditMemos.id))
      .leftJoin(items, eq(creditMemoLines.itemId, items.id))
      .where(and(...cmConds))) {
      out.push({ id: r.id, type: 'Credit Memo', sourceRef: `credit_memo:${r.docId}`, date: r.date, num: docRef(r.ref, r.num), customerId: r.customerId, itemId: r.itemId, item: r.item ?? '', memo: r.memo ?? '', qty: Money.of(r.qty).negated(), price: Money.of(r.rate), amount: Money.of(r.amount).negated() });
    }
  }
  return out.sort((a, b) => a.date.getTime() - b.date.getTime() || a.num.localeCompare(b.num, undefined, { numeric: true }));
}

async function salesDetail(ctx: ServiceContext, p: ReportParams, by: 'customer' | 'item'): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  const lines = await salesLines(ctx, { from, to }, { customerId: p.customerId, itemId: p.itemId, classId: p.classId });
  const names = await customerNames(ctx);
  const entryIds = await entryIdsForSourceRefs(ctx, lines.map((l) => l.sourceRef));
  const groups = new Map<string, { label: string; lines: SalesLine[] }>();
  for (const l of lines) {
    const key = by === 'customer' ? (l.customerId ?? '') : (l.itemId ?? '');
    const label = by === 'customer' ? (l.customerId ? (names.get(l.customerId)?.name ?? '') : '(no customer)') : l.item || '(no item)';
    if (!groups.has(key)) groups.set(key, { label, lines: [] });
    groups.get(key)!.lines.push(l);
  }
  const rows: StdRow[] = [];
  let tQty = Money.zero();
  let tAmt = Money.zero();
  for (const [key, g] of [...groups.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label))) {
    const hid = `sd:${by}:${key || 'none'}`;
    const header: StdRow = { id: hid, depth: 0, kind: 'section', collapseKind: 'group', cells: { label: g.label } };
    rows.push(header);
    let qty = Money.zero();
    let total = Money.zero();
    for (const l of g.lines) {
      qty = qty.plus(l.qty);
      total = total.plus(l.amount);
      rows.push({
        id: `sd:l:${l.id}`,
        parentId: hid,
        depth: 1,
        kind: 'data',
        cells: {
          label: '',
          type: l.type,
          date: dayStr(l.date),
          num: l.num,
          memo: l.memo,
          name: by === 'customer' ? l.item : l.customerId ? (names.get(l.customerId)?.name ?? '') : '',
          qty: l.qty.toFixed(4),
          price: l.price.toFixed(2),
          amount: amt(l.amount),
          balance: amt(total),
        },
        entryId: entryIds.get(l.sourceRef) ?? null,
      });
    }
    tQty = tQty.plus(qty);
    tAmt = tAmt.plus(total);
    const tc = { label: `Total ${g.label}`, qty: qty.toFixed(4), amount: amt(total), balance: amt(total) };
    header.collapsedCells = { ...tc, label: g.label };
    rows.push({ id: `${hid}:total`, depth: 0, kind: 'subtotal', totalOf: hid, cells: tc });
  }
  rows.push({ id: 'sd:grand', depth: 0, kind: 'grand', cells: { label: 'TOTAL', qty: tQty.toFixed(4), amount: amt(tAmt) } });
  return {
    key: by === 'customer' ? 'sales-by-customer-detail' : 'sales-by-item-detail',
    title: by === 'customer' ? 'Sales by Customer Detail' : 'Sales by Item Detail',
    subtitle: rangeLabel(from, to),
    columns: [
      { key: 'label', header: '' },
      { key: 'type', header: 'Type' },
      { key: 'date', header: 'Date', type: 'date' },
      { key: 'num', header: 'Num' },
      { key: 'memo', header: 'Memo' },
      { key: 'name', header: by === 'customer' ? 'Item' : 'Name' },
      { key: 'qty', header: 'Qty', type: 'number' },
      { key: 'price', header: 'Sales Price', type: 'money' },
      { key: 'amount', header: 'Amount', type: 'money' },
      { key: 'balance', header: 'Balance', type: 'money' },
    ],
    rows,
  };
}

export const salesByCustomerDetail = (ctx: ServiceContext, p: ReportParams) => salesDetail(ctx, p, 'customer');
export const salesByItemDetail = (ctx: ServiceContext, p: ReportParams) => salesDetail(ctx, p, 'item');

async function openSalesOrders(ctx: ServiceContext, p: ReportParams, by: 'customer' | 'item'): Promise<StdReport> {
  const conds: SQL[] = [eq(salesOrders.companyId, ctx.companyId), notInArray(salesOrders.status, ['void', 'closed', 'paid'])];
  if (p.customerId) conds.push(eq(salesOrders.customerId, p.customerId));
  if (p.itemId) conds.push(eq(salesOrderLines.itemId, p.itemId));
  const dbRows = await ctx.db
    .select({
      soId: salesOrders.id,
      num: salesOrders.orderNumber, ref: salesOrders.refNumber,
      date: salesOrders.date,
      customerId: salesOrders.customerId,
      lineId: salesOrderLines.id,
      itemId: salesOrderLines.itemId,
      item: items.name,
      description: salesOrderLines.description,
      qty: salesOrderLines.quantity,
      invoiced: salesOrderLines.quantityInvoiced,
      rate: salesOrderLines.rate,
    })
    .from(salesOrderLines)
    .innerJoin(salesOrders, eq(salesOrderLines.salesOrderId, salesOrders.id))
    .leftJoin(items, eq(salesOrderLines.itemId, items.id))
    .where(and(...conds))
    .orderBy(asc(salesOrders.date), asc(salesOrders.orderNumber), asc(salesOrderLines.lineOrder));
  const names = await customerNames(ctx);
  const groups = new Map<string, { label: string; rows: typeof dbRows }>();
  for (const r of dbRows) {
    const remaining = Money.of(r.qty).minus(Money.of(r.invoiced));
    if (!remaining.greaterThan(0)) continue;
    const key = by === 'customer' ? r.customerId : (r.itemId ?? '');
    const label = by === 'customer' ? (names.get(r.customerId)?.name ?? '') : (r.item ?? r.description ?? '(no item)');
    if (!groups.has(key)) groups.set(key, { label, rows: [] });
    groups.get(key)!.rows.push(r);
  }
  const rows: StdRow[] = [];
  let total = Money.zero();
  for (const [key, g] of [...groups.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label))) {
    const hid = `oso:${key || 'none'}`;
    const header: StdRow = { id: hid, depth: 0, kind: 'section', collapseKind: 'group', cells: { label: g.label } };
    rows.push(header);
    let sub = Money.zero();
    for (const r of g.rows) {
      const remaining = Money.of(r.qty).minus(Money.of(r.invoiced));
      const open = Money.round2(remaining.times(Money.of(r.rate)));
      sub = sub.plus(open);
      rows.push({
        id: `oso:l:${r.lineId}`,
        parentId: hid,
        depth: 1,
        kind: 'data',
        cells: {
          label: '',
          date: dayStr(r.date),
          num: docRef(r.ref, r.num),
          name: by === 'customer' ? (r.item ?? r.description ?? '') : (names.get(r.customerId)?.name ?? ''),
          qty: r.qty,
          invoiced: r.invoiced,
          backordered: remaining.toFixed(4),
          open: amt(open),
        },
        href: '/sales-orders',
      });
    }
    total = total.plus(sub);
    header.collapsedCells = { label: g.label, open: amt(sub) };
    rows.push({ id: `${hid}:total`, depth: 0, kind: 'subtotal', totalOf: hid, cells: { label: `Total ${g.label}`, open: amt(sub) } });
  }
  rows.push({ id: 'oso:grand', depth: 0, kind: 'grand', cells: { label: 'TOTAL', open: amt(total) } });
  return {
    key: by === 'customer' ? 'open-sales-orders-by-customer' : 'open-sales-orders-by-item',
    title: by === 'customer' ? 'Open Sales Orders by Customer' : 'Open Sales Orders by Item',
    subtitle: 'All open sales orders',
    columns: [
      { key: 'label', header: by === 'customer' ? 'Customer' : 'Item' },
      { key: 'date', header: 'Date', type: 'date' },
      { key: 'num', header: 'Num' },
      { key: 'name', header: by === 'customer' ? 'Item' : 'Customer' },
      { key: 'qty', header: 'Qty Ordered', type: 'number' },
      { key: 'invoiced', header: 'Invoiced', type: 'number' },
      { key: 'backordered', header: 'Backordered', type: 'number' },
      { key: 'open', header: 'Open Amount', type: 'money' },
    ],
    rows,
  };
}

export const openSalesOrdersByCustomer = (ctx: ServiceContext, p: ReportParams) => openSalesOrders(ctx, p, 'customer');
export const openSalesOrdersByItem = (ctx: ServiceContext, p: ReportParams) => openSalesOrders(ctx, p, 'item');

// ===========================================================================
// Expenses by Vendor (ledger based)
// ===========================================================================

const EXPENSE_SECTIONS: SectionKey[] = ['cogs', 'expense', 'other_expense'];

export async function expensesByVendorSummary(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  const meta = await loadAccountMeta(ctx);
  const f = glFilterFromParams(meta, { ...p, vendorId: undefined }, { from, to });
  f.sections = EXPENSE_SECTIONS;
  f.excludeClose = true;
  const { lines, truncated } = await fetchGlLines(ctx, meta, { ...f, limit: 50000 });
  const byVendor = new Map<string, { name: string; total: Decimal }>();
  for (const l of lines) {
    const key = l.nameType === 'vendor' && l.nameId ? l.nameId : '';
    const name = key ? l.name : '(no vendor)';
    const cur = byVendor.get(key) ?? { name, total: Money.zero() };
    cur.total = cur.total.plus(l.natural);
    byVendor.set(key, cur);
  }
  let total = Money.zero();
  const rows: StdRow[] = [...byVendor.entries()]
    .filter(([, v]) => !v.total.isZero())
    .sort((a, b) => b[1].total.comparedTo(a[1].total))
    .map(([id, v]) => {
      total = total.plus(v.total);
      return {
        id: `ebv:${id || 'none'}`,
        depth: 0,
        kind: 'data' as const,
        cells: { label: v.name, amount: amt(v.total) },
        href: id ? stdHref('expenses-by-vendor-detail', { vendorId: id, from: dayStr(from), to: dayStr(to) }) : null,
      };
    });
  rows.push({ id: 'ebv:grand', depth: 0, kind: 'grand', cells: { label: 'TOTAL', amount: amt(total) } });
  return {
    key: 'expenses-by-vendor-summary',
    title: 'Expenses by Vendor Summary',
    subtitle: rangeLabel(from, to),
    columns: [{ key: 'label', header: 'Vendor' }, { key: 'amount', header: 'Amount', type: 'money' }],
    rows,
    truncated,
  };
}

export async function expensesByVendorDetail(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  const meta = await loadAccountMeta(ctx);
  const f = glFilterFromParams(meta, p, { from, to });
  f.sections = EXPENSE_SECTIONS;
  f.excludeClose = true;
  const { lines, truncated } = await fetchGlLines(ctx, meta, f);
  const keys = ['label', 'type', 'date', 'num', 'memo', 'account', 'clr', 'split', 'amount', 'balance'];
  const laid = layoutDetail(lines, {
    columns: detailColumns(keys),
    groupBy: 'name',
    sortBy: p.sortBy,
    sortDir: p.sortDir,
    natural: true,
    running: true,
    idPrefix: 'ebvd',
  });
  return {
    key: 'expenses-by-vendor-detail',
    title: 'Expenses by Vendor Detail',
    subtitle: rangeLabel(from, to),
    columns: detailColumns(keys),
    rows: laid.rows,
    truncated,
  };
}

// ===========================================================================
// List reports
// ===========================================================================

function addressLine(a: Record<string, string> | null | undefined): string {
  if (!a) return '';
  return [a.line1 ?? a.street, a.line2, a.city, a.state, a.zip ?? a.postalCode, a.country].filter(Boolean).join(', ');
}

async function nameBalances(ctx: ServiceContext, section: 'ar' | 'ap', nameType: NameType): Promise<Map<string, Decimal>> {
  const meta = await loadAccountMeta(ctx);
  const { lines } = await fetchGlLines(ctx, meta, { sections: [section], limit: 50000 });
  const out = new Map<string, Decimal>();
  for (const l of lines) {
    if (l.nameType !== nameType || !l.nameId) continue;
    out.set(l.nameId, (out.get(l.nameId) ?? Money.zero()).plus(l.natural));
  }
  return out;
}

export async function customerContactList(ctx: ServiceContext, _p: ReportParams, phoneOnly = false): Promise<StdReport> {
  const rowsDb = await ctx.db
    .select()
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.isActive, true)));
  const names = await customerNames(ctx);
  const balances = phoneOnly ? new Map<string, Decimal>() : await nameBalances(ctx, 'ar', 'customer');
  const rows: StdRow[] = rowsDb
    .map((c) => ({ c, name: names.get(c.id)?.name ?? c.displayName }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ c, name }): StdRow => ({
      id: `cust:${c.id}`,
      depth: 0,
      kind: 'data' as const,
      cells: phoneOnly
        ? { label: name, phone: c.phone ?? '' }
        : {
            label: name,
            company: c.companyName ?? '',
            phone: c.phone ?? '',
            email: c.email ?? '',
            billTo: addressLine(c.billingAddress),
            terms: c.terms ?? '',
            balance: amt(balances.get(c.id) ?? Money.zero()),
          },
      href: stdHref('customer-balance-detail', { customerId: c.id }),
    }));
  return {
    key: phoneOnly ? 'customer-phone-list' : 'customer-contact-list',
    title: phoneOnly ? 'Customer Phone List' : 'Customer Contact List',
    subtitle: 'Active customers',
    columns: phoneOnly
      ? [{ key: 'label', header: 'Customer' }, { key: 'phone', header: 'Phone' }]
      : [
          { key: 'label', header: 'Customer' },
          { key: 'company', header: 'Company' },
          { key: 'phone', header: 'Phone' },
          { key: 'email', header: 'Email' },
          { key: 'billTo', header: 'Bill To' },
          { key: 'terms', header: 'Terms' },
          { key: 'balance', header: 'Balance Total', type: 'money' },
        ],
    rows,
  };
}

export async function vendorContactList(ctx: ServiceContext, _p: ReportParams, phoneOnly = false): Promise<StdReport> {
  const rowsDb = await ctx.db
    .select()
    .from(vendors)
    .where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.isActive, true)))
    .orderBy(asc(vendors.displayName));
  const balances = phoneOnly ? new Map<string, Decimal>() : await nameBalances(ctx, 'ap', 'vendor');
  const rows: StdRow[] = rowsDb.map((v): StdRow => ({
    id: `vend:${v.id}`,
    depth: 0,
    kind: 'data' as const,
    cells: phoneOnly
      ? { label: v.displayName, phone: v.phone ?? '' }
      : {
          label: v.displayName,
          company: v.companyName ?? '',
          phone: v.phone ?? '',
          email: v.email ?? '',
          address: addressLine(v.address),
          terms: v.terms ?? '',
          is1099: v.is1099 ? 'Yes' : '',
          balance: amt(balances.get(v.id) ?? Money.zero()),
        },
    href: stdHref('vendor-balance-detail', { vendorId: v.id }),
  }));
  return {
    key: phoneOnly ? 'vendor-phone-list' : 'vendor-contact-list',
    title: phoneOnly ? 'Vendor Phone List' : 'Vendor Contact List',
    subtitle: 'Active vendors',
    columns: phoneOnly
      ? [{ key: 'label', header: 'Vendor' }, { key: 'phone', header: 'Phone' }]
      : [
          { key: 'label', header: 'Vendor' },
          { key: 'company', header: 'Company' },
          { key: 'phone', header: 'Phone' },
          { key: 'email', header: 'Email' },
          { key: 'address', header: 'Address' },
          { key: 'terms', header: 'Terms' },
          { key: 'is1099', header: '1099' },
          { key: 'balance', header: 'Balance Total', type: 'money' },
        ],
    rows,
  };
}

const ITEM_TYPE_LABELS: Record<string, string> = {
  service: 'Service',
  inventory: 'Inventory Part',
  non_inventory: 'Non-inventory Part',
  bundle: 'Group',
  other_charge: 'Other Charge',
  discount: 'Discount',
  subtotal: 'Subtotal',
  payment: 'Payment',
  sales_tax: 'Sales Tax Item',
};

export async function itemPriceList(ctx: ServiceContext): Promise<StdReport> {
  const rowsDb = await ctx.db
    .select()
    .from(items)
    .where(and(eq(items.companyId, ctx.companyId), eq(items.isActive, true)))
    .orderBy(asc(items.name));
  return {
    key: 'item-price-list',
    title: 'Item Price List',
    subtitle: 'Active items',
    columns: [
      { key: 'label', header: 'Item' },
      { key: 'description', header: 'Description' },
      { key: 'type', header: 'Type' },
      { key: 'price', header: 'Price', type: 'money' },
    ],
    rows: rowsDb.map((i) => ({
      id: `ipl:${i.id}`,
      depth: 0,
      kind: 'data',
      cells: { label: i.name, description: i.description ?? '', type: ITEM_TYPE_LABELS[i.type] ?? i.type, price: i.salesPrice ? toAmountString(i.salesPrice) : null },
      href: '/items',
    })),
  };
}

export async function itemListing(ctx: ServiceContext): Promise<StdReport> {
  const rowsDb = await ctx.db
    .select()
    .from(items)
    .where(eq(items.companyId, ctx.companyId))
    .orderBy(asc(items.name));
  const meta = await loadAccountMeta(ctx);
  const acct = (id: string | null) => (id ? (meta.get(id)?.fullName ?? '') : '');
  return {
    key: 'item-listing',
    title: 'Item Listing',
    subtitle: 'All items',
    columns: [
      { key: 'label', header: 'Item' },
      { key: 'sku', header: 'SKU' },
      { key: 'description', header: 'Description' },
      { key: 'type', header: 'Type' },
      { key: 'cost', header: 'Cost', type: 'money' },
      { key: 'price', header: 'Price', type: 'money' },
      { key: 'onHand', header: 'Qty On Hand', type: 'number' },
      { key: 'reorder', header: 'Reorder Point', type: 'number' },
      { key: 'income', header: 'Income Account' },
      { key: 'expense', header: 'Expense / COGS Account' },
      { key: 'asset', header: 'Asset Account' },
      { key: 'active', header: 'Active' },
    ],
    rows: rowsDb.map((i) => ({
      id: `il:${i.id}`,
      depth: 0,
      kind: 'data',
      cells: {
        label: i.name,
        sku: i.sku ?? '',
        description: i.description ?? '',
        type: ITEM_TYPE_LABELS[i.type] ?? i.type,
        cost: i.purchaseCost ? toAmountString(i.purchaseCost) : null,
        price: i.salesPrice ? toAmountString(i.salesPrice) : null,
        onHand: i.type === 'inventory' ? (i.quantityOnHand ?? '0') : null,
        reorder: i.reorderPoint ?? null,
        income: acct(i.incomeAccountId),
        expense: acct(i.expenseAccountId),
        asset: acct(i.assetAccountId),
        active: i.isActive ? 'Yes' : 'No',
      },
      href: '/items',
    })),
  };
}

export async function accountListing(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const asOf = resolveAsOf(p);
  const meta = await loadAccountMeta(ctx);
  const act = await activityByAccount(ctx, { to: asOf });
  const bal = new Map<string, Decimal>();
  for (const r of act) {
    const a = meta.get(r.accountId);
    if (!a) continue;
    bal.set(r.accountId, naturalAmount(a.section, r.debit, r.credit));
  }
  const rowsAll = await ctx.db.select({ id: accounts.id, description: accounts.description }).from(accounts).where(eq(accounts.companyId, ctx.companyId));
  const desc = new Map(rowsAll.map((r) => [r.id, r.description ?? '']));
  const list = [...meta.values()].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  return {
    key: 'account-listing',
    title: 'Account Listing',
    subtitle: `Balances as of ${fmtDay(asOf)}`,
    columns: [
      { key: 'code', header: 'Number' },
      { key: 'label', header: 'Account' },
      { key: 'type', header: 'Type' },
      { key: 'balance', header: 'Balance Total', type: 'money' },
      { key: 'description', header: 'Description' },
      { key: 'active', header: 'Active' },
    ],
    rows: list.map((a) => ({
      id: `al:${a.id}`,
      depth: 0,
      kind: 'data',
      cells: {
        code: a.code,
        label: a.fullName,
        type: SECTION_LABELS[a.section],
        // Balance Total: P&L accounts show their fiscal activity in QB; here we show the
        // ledger balance for balance-sheet accounts only (income statement accounts are blank).
        balance: isPLSection(a.section) ? null : amt(bal.get(a.id) ?? Money.zero()),
        description: desc.get(a.id) ?? '',
        active: a.isActive ? 'Yes' : 'No',
      },
      href: `/registers/${a.id}`,
    })),
  };
}

// ===========================================================================
// Income tax reports (by tax line)
// ===========================================================================

export interface TaxLine {
  id: string;
  name: string;
}

/** Maps an account to its income-tax form line (null = unassigned). */
export type TaxLineMapper = (account: AccountMeta & { raw: Record<string, unknown> }) => TaxLine | null;

/**
 * Default mapper: reads the account's tax-line assignment when the accounts table carries one
 * (the foundation package adds it as `taxLineId` / `taxLine`). Until that column exists every
 * account is "unassigned", so the income-tax reports stay hidden in the Report Center.
 * TODO(foundation: tax lines) — resolve a tax-line id to its display name from the tax line list.
 */
export const defaultTaxLineMapper: TaxLineMapper = (a) => {
  const v = (a.raw.taxLineId ?? a.raw.taxLine ?? a.raw.tax_line) as unknown;
  if (typeof v === 'string' && v.trim()) return { id: v, name: v };
  if (v && typeof v === 'object' && 'id' in (v as object)) {
    const o = v as { id: string; name?: string };
    return { id: o.id, name: o.name ?? o.id };
  }
  return null;
};

async function accountsWithRaw(ctx: ServiceContext) {
  const meta = await loadAccountMeta(ctx);
  const raw = await ctx.db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId));
  const rawById = new Map(raw.map((r) => [r.id, r as unknown as Record<string, unknown>]));
  return { meta, rawById };
}

/** Income Tax Preparation — every account with its assigned tax line. */
export async function incomeTaxPreparation(ctx: ServiceContext, _p: ReportParams, mapper: TaxLineMapper = defaultTaxLineMapper): Promise<StdReport> {
  const { meta, rawById } = await accountsWithRaw(ctx);
  const list = [...meta.values()].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  return {
    key: 'income-tax-preparation',
    title: 'Income Tax Preparation',
    subtitle: 'Tax line assignments',
    columns: [
      { key: 'label', header: 'Account' },
      { key: 'type', header: 'Type' },
      { key: 'taxLine', header: 'Tax Line' },
    ],
    rows: list.map((a) => ({
      id: `itp:${a.id}`,
      depth: 0,
      kind: 'data',
      cells: { label: a.fullName, type: SECTION_LABELS[a.section], taxLine: mapper({ ...a, raw: rawById.get(a.id) ?? {} })?.name ?? '<Unassigned>' },
    })),
  };
}

/**
 * Income Tax Summary / Detail — period activity per tax line (P&L accounts: period activity;
 * balance-sheet accounts: balance as of the end date), from the posted ledger.
 */
export async function incomeTaxReport(
  ctx: ServiceContext,
  p: ReportParams,
  detail: boolean,
  mapper: TaxLineMapper = defaultTaxLineMapper,
): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  const { meta, rawById } = await accountsWithRaw(ctx);
  const lineOf = new Map<string, TaxLine>();
  for (const a of meta.values()) {
    const t = mapper({ ...a, raw: rawById.get(a.id) ?? {} });
    if (t) lineOf.set(a.id, t);
  }
  const [plAct, bsAct] = await Promise.all([
    activityByAccount(ctx, { from, to, excludeClose: true }),
    activityByAccount(ctx, { to }),
  ]);
  const perAccount = new Map<string, Decimal>();
  for (const r of plAct) {
    const a = meta.get(r.accountId);
    if (a && isPLSection(a.section)) perAccount.set(r.accountId, naturalAmount(a.section, r.debit, r.credit));
  }
  for (const r of bsAct) {
    const a = meta.get(r.accountId);
    if (a && !isPLSection(a.section)) perAccount.set(r.accountId, naturalAmount(a.section, r.debit, r.credit));
  }
  const groups = new Map<string, { line: TaxLine; accounts: { a: AccountMeta; v: Decimal }[] }>();
  for (const [id, v] of perAccount) {
    if (v.isZero()) continue;
    const t = lineOf.get(id) ?? { id: '', name: '<Unassigned>' };
    if (!groups.has(t.id)) groups.set(t.id, { line: t, accounts: [] });
    groups.get(t.id)!.accounts.push({ a: meta.get(id)!, v });
  }
  const rows: StdRow[] = [];
  for (const g of [...groups.values()].sort((a, b) => (a.line.id === '' ? 1 : b.line.id === '' ? -1 : a.line.name.localeCompare(b.line.name)))) {
    const total = g.accounts.reduce((s, x) => s.plus(x.v), Money.zero());
    if (!detail) {
      rows.push({ id: `it:${g.line.id || 'none'}`, depth: 0, kind: 'data', cells: { label: g.line.name, amount: amt(total) } });
      continue;
    }
    const hid = `it:${g.line.id || 'none'}`;
    rows.push({ id: hid, depth: 0, kind: 'section', collapseKind: 'group', cells: { label: g.line.name }, collapsedCells: { label: g.line.name, amount: amt(total) } });
    for (const x of g.accounts.sort((a, b) => a.a.code.localeCompare(b.a.code))) {
      rows.push({
        id: `${hid}:${x.a.id}`,
        parentId: hid,
        depth: 1,
        kind: 'data',
        cells: { label: x.a.fullName, amount: amt(x.v) },
        href: stdHref('transaction-detail-by-account', { accountId: x.a.id, from: isPLSection(x.a.section) ? dayStr(from) : undefined, to: dayStr(to) }),
      });
    }
    rows.push({ id: `${hid}:total`, depth: 0, kind: 'subtotal', totalOf: hid, cells: { label: `Total ${g.line.name}`, amount: amt(total) } });
  }
  return {
    key: detail ? 'income-tax-detail' : 'income-tax-summary',
    title: detail ? 'Income Tax Detail' : 'Income Tax Summary',
    subtitle: rangeLabel(from, to),
    columns: [{ key: 'label', header: 'Tax Line' }, { key: 'amount', header: 'Amount', type: 'money' }],
    rows,
  };
}

export type { CellValue, StdColumn };

/** Purchases by Item Detail — item lines on bills (void bills excluded), by item. */
export async function purchasesByItemDetail(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  const conds: SQL[] = [eq(bills.companyId, ctx.companyId), ne(bills.status, 'void'), gte(bills.date, from), lte(bills.date, to), sql`${billLines.itemId} IS NOT NULL`];
  if (p.itemId) conds.push(eq(billLines.itemId, p.itemId));
  if (p.vendorId) conds.push(eq(bills.vendorId, p.vendorId));
  const rowsDb = await ctx.db
    .select({ id: billLines.id, billId: bills.id, num: bills.billNumber, date: bills.date, vendor: vendors.displayName, itemId: billLines.itemId, item: items.name, memo: billLines.description, qty: billLines.quantity, amount: billLines.amount })
    .from(billLines)
    .innerJoin(bills, eq(billLines.billId, bills.id))
    .innerJoin(vendors, eq(bills.vendorId, vendors.id))
    .leftJoin(items, eq(billLines.itemId, items.id))
    .where(and(...conds))
    .orderBy(asc(items.name), asc(bills.date));
  const entryIds = await entryIdsForSourceRefs(ctx, rowsDb.map((r) => `bill:${r.billId}`));
  const rows: StdRow[] = [];
  let tQty = Money.zero();
  let tAmt = Money.zero();
  const groups = new Map<string, typeof rowsDb>();
  for (const r of rowsDb) groups.set(r.itemId ?? '', [...(groups.get(r.itemId ?? '') ?? []), r]);
  for (const [k, list] of groups) {
    const label = list[0].item ?? '(no item)';
    const hid = `pid:${k}`;
    const header: StdRow = { id: hid, depth: 0, kind: 'section', collapseKind: 'group', cells: { label } };
    rows.push(header);
    let q = Money.zero();
    let a = Money.zero();
    for (const r of list) {
      q = q.plus(Money.of(r.qty));
      a = a.plus(Money.of(r.amount));
      rows.push({
        id: `pid:l:${r.id}`,
        parentId: hid,
        depth: 1,
        kind: 'data',
        cells: { label: '', type: 'Bill', date: dayStr(r.date), num: r.num ?? '', name: r.vendor, memo: r.memo ?? '', qty: Money.of(r.qty).toFixed(4), amount: toAmountString(r.amount), balance: amt(a) },
        entryId: entryIds.get(`bill:${r.billId}`) ?? null,
      });
    }
    tQty = tQty.plus(q);
    tAmt = tAmt.plus(a);
    const tc = { label: `Total ${label}`, qty: q.toFixed(4), amount: amt(a), balance: amt(a) };
    header.collapsedCells = { ...tc, label };
    rows.push({ id: `${hid}:total`, depth: 0, kind: 'subtotal', totalOf: hid, cells: tc });
  }
  rows.push({ id: 'pid:grand', depth: 0, kind: 'grand', cells: { label: 'TOTAL', qty: tQty.toFixed(4), amount: amt(tAmt) } });
  return {
    key: 'purchases-by-item-detail',
    title: 'Purchases by Item Detail',
    subtitle: rangeLabel(from, to),
    columns: [
      { key: 'label', header: '' },
      { key: 'type', header: 'Type' },
      { key: 'date', header: 'Date', type: 'date' },
      { key: 'num', header: 'Num' },
      { key: 'name', header: 'Vendor' },
      { key: 'memo', header: 'Memo' },
      { key: 'qty', header: 'Qty', type: 'number' },
      { key: 'amount', header: 'Amount', type: 'money' },
      { key: 'balance', header: 'Balance', type: 'money' },
    ],
    rows,
  };
}
