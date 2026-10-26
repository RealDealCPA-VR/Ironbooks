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
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, ne, notInArray, sql, type SQL } from 'drizzle-orm';
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
  expenseLines,
  expenses,
  invoiceLines,
  invoices,
  items,
  journalEntries,
  journalEntryLines,
  purchaseOrderLines,
  purchaseOrders,
  salesOrderLines,
  salesOrders,
  salesReceiptLines,
  salesReceipts,
  vendorCreditLines,
  vendorCredits,
  vendors,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import type { CellValue, StdColumn, StdReport, StdRow } from '@/lib/reports/types';
import type { ReportParams } from '@/lib/validation/reports';
import type { ServiceContext } from './_base';
import { apAgingDetail } from './reportsExtra';
import { cashBasisLedger } from './cashBasisLedger';
import type { TxnTypeKey } from '@/lib/validation/reports';
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
  homeAmountsByLine,
  isPLSection,
  layoutDetail,
  ledgerTotalsByName,
  loadAccountMeta,
  naturalAmount,
  resolveAsOf,
  resolveRange,
  stdHref,
  TXN_TYPE_LABELS,
  type AccountMeta,
  type GlLine,
  type NameType,
  type SectionKey,
} from './reportEngine';
import { rangeLabel } from './reportsStandard';
import { docRef } from './docNumbers';
import { foreignAmountsByEntry } from './fxSubledger';

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
  lines: Pick<GlLine, 'nameType' | 'nameId' | 'name' | 'natural'>[],
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

/**
 * Balance per name on the A/R or A/P accounts as of a date. Accrual: summed in SQL per name
 * (ledgerTotalsByName — every line, however large the file); cash basis: the cash-basis lines.
 */
async function balancesByName(ctx: ServiceContext, section: 'ar' | 'ap', p: ReportParams, asOf: Date) {
  if (p.basis === 'cash') {
    const { lines, truncated } = await ledgerByName(ctx, section, { ...p, customerId: undefined, vendorId: undefined }, { to: asOf });
    return { totals: lines, truncated };
  }
  const meta = await loadAccountMeta(ctx);
  return { totals: await ledgerTotalsByName(ctx, meta, { sections: [section], to: asOf, classId: p.classId }), truncated: false };
}

export async function customerBalanceSummary(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const asOf = resolveAsOf(p);
  const { totals: lines, truncated } = await balancesByName(ctx, 'ar', p, asOf);
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
  const { totals: lines, truncated } = await balancesByName(ctx, 'ap', p, asOf);
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
  // p1 fx: QB shows foreign-currency transactions in both currencies — add the transaction's
  // currency and its amount in that currency next to the home amount.
  const columns = detailColumns(keys);
  const fx = await foreignAmountsByEntry(ctx, lines.map((l) => l.entryId));
  if (fx.size > 0) {
    columns.splice(columns.length - 2, 0, { key: 'currency', header: 'Currency' }, { key: 'foreignAmount', header: 'Foreign Amount', type: 'money' });
    for (const row of laid.rows) {
      const f = row.entryId ? fx.get(row.entryId) : undefined;
      if (!f || row.kind !== 'data') continue;
      const home = Money.of(String(row.cells.amount ?? '0'));
      row.cells.currency = f.currency;
      row.cells.foreignAmount = amt(home.isNegative() ? f.amount.negated() : f.amount);
    }
  }
  return {
    key: customer ? 'customer-balance-detail' : 'vendor-balance-detail',
    title: customer ? 'Customer Balance Detail' : 'Vendor Balance Detail',
    subtitle: from ? rangeLabel(from, asOf) : `All transactions as of ${fmtDay(asOf)}`,
    columns,
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
  const overDays = p.overDays !== undefined ? Number(p.overDays) : null;
  const docs = aging.rows.filter(
    (r) => (!p.vendorId || r.entityId === p.vendorId) && (overDays === null || r.daysPastDue > overDays),
  );
  // QuickZoom: a bill / credit opens its posted entry; a named General Journal A/P line IS its
  // entry (it used to be looked up as a "vendor_credit:" document, so it never opened, and was
  // labelled "Bill Credit").
  const refOf = (r: (typeof docs)[number]) => (r.docType === 'bill' ? `bill:${r.docId}` : r.docType === 'vendor_credit' ? `vendor_credit:${r.docId}` : '');
  const entryIds = await entryIdsForSourceRefs(ctx, docs.map(refOf));
  const creditIds = docs.filter((r) => r.docType === 'vendor_credit').map((r) => r.docId);
  const creditRefs = new Map<string, string | null>();
  for (let i = 0; i < creditIds.length; i += 2000) {
    for (const c of await ctx.db
      .select({ id: vendorCredits.id, ref: vendorCredits.refNumber })
      .from(vendorCredits)
      .where(and(eq(vendorCredits.companyId, ctx.companyId), inArray(vendorCredits.id, creditIds.slice(i, i + 2000))))) {
      creditRefs.set(c.id, c.ref);
    }
  }
  const TYPE: Record<string, string> = { bill: 'Bill', vendor_credit: 'Credit', journal_entry: 'General Journal' };
  /** The Num column: the document's own number (QB), never "Bill …" / "Vendor Credit". */
  const numOf = (r: (typeof docs)[number]) =>
    r.docType === 'bill'
      ? r.docNumber.replace(/^Bill ?/, '')
      : r.docType === 'vendor_credit'
        ? (creditRefs.get(r.docId) ?? '')
        : r.docNumber.replace(/^General Journal /, '');
  const byVendor = new Map<string, typeof docs>();
  for (const r of docs) byVendor.set(r.entityId, [...(byVendor.get(r.entityId) ?? []), r]);
  const rows: StdRow[] = [];
  let total = Money.zero();
  for (const [vid, list] of [...byVendor.entries()].sort((a, b) => a[1][0].entityName.localeCompare(b[1][0].entityName))) {
    const hid = `ub:${vid}`;
    let sub = Money.zero();
    const header: StdRow = { id: hid, depth: 0, kind: 'section', collapseKind: 'group', cells: { label: list[0].entityName } };
    rows.push(header);
    for (const [i, r] of list.sort((a, b) => (a.dueDate ?? a.date).localeCompare(b.dueDate ?? b.date)).entries()) {
      sub = sub.plus(Money.of(r.openBalance));
      rows.push({
        // A General Journal entry can name the vendor on several A/P lines: keep row ids unique.
        id: `ub:d:${r.docType}:${r.docId}:${i}`,
        parentId: hid,
        depth: 1,
        kind: 'data',
        cells: {
          label: '',
          type: TYPE[r.docType] ?? 'General Journal',
          date: r.date.slice(0, 10),
          num: numOf(r),
          due: r.dueDate ? r.dueDate.slice(0, 10) : '',
          aging: r.daysPastDue > 0 ? r.daysPastDue : null,
          open: r.openBalance,
        },
        entryId: r.docType === 'journal_entry' ? r.docId : (entryIds.get(refOf(r)) ?? null),
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
    subtitle: `As of ${fmtDay(asOf)}${overDays !== null ? ` · more than ${overDays} days past due` : ''}`,
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
  let tCredited = Money.zero();
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
      tCredited = tCredited.plus(Money.of(b.credited));
      rows.push({
        id: `bap:c:${b.id}`,
        parentId: hid,
        depth: 1,
        kind: 'data',
        cells: { label: '', type: 'Bill Credit', memo: 'Credits applied', amount: toAmountString(Money.of(b.credited).negated()) },
      });
    }
  }
  // The TOTAL is the sum of the rows above it: bills less the payments AND credits applied.
  rows.push({ id: 'bap:grand', depth: 0, kind: 'grand', cells: { label: 'TOTAL', amount: amt(tBill.minus(tPaid).minus(tCredited)) } });
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

export interface SalesLine {
  id: string;
  /** Invoice / Sales Receipt / Credit Memo, or on a cash basis the settling transaction type. */
  type: string;
  /** Cash basis: the settling transaction's entry (QuickZoom), overriding sourceRef. */
  entryId?: string | null;
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
  /** Cash basis: the accrual line this settled share comes from, and that line's full amount. */
  baseId?: string;
  baseAmount?: Decimal;
}

/** Home-currency value of a document amount (invoices may be in a foreign currency). */
const homeOf = (v: Decimal, rate: string | null | undefined): Decimal =>
  rate && !Money.eq(rate, 1) ? Money.round2(v.times(Money.of(rate))) : v;

/**
 * Lines that are sales: every line except subtotal items (non-posting; their amount repeats the
 * lines above them), payment items (money received, not sales) and manual sales-tax items (owed
 * to the tax agency). Discount lines stay — they reduce sales. Needs `items` joined on the line.
 */
const SALES_LINE_ONLY = sql`COALESCE(${items.type}::text, '') NOT IN ('subtotal', 'payment', 'sales_tax')`;

/** Item sales lines (invoices, sales receipts, credit memos as negatives) in a date range. */
export async function salesLines(
  ctx: ServiceContext,
  range: { from: Date; to: Date },
  filter: { customerId?: string; itemId?: string; classId?: string } = {},
  /** Only these invoices / credit memos, any date (no sales receipts) — used by the cash basis. */
  scope?: { invoiceIds: string[]; creditMemoIds: string[] },
): Promise<SalesLine[]> {
  const c = ctx.companyId;
  const out: SalesLine[] = [];
  const invConds: SQL[] = [eq(invoices.companyId, c), notInArray(invoices.status, ['void', 'draft']), SALES_LINE_ONLY];
  if (scope) invConds.push(scope.invoiceIds.length ? inArray(invoices.id, scope.invoiceIds) : sql`false`);
  else invConds.push(gte(invoices.date, range.from), lte(invoices.date, range.to));
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
      fx: invoices.exchangeRate,
    })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoiceLines.invoiceId, invoices.id))
    .leftJoin(items, eq(invoiceLines.itemId, items.id))
    .where(and(...invConds))) {
    // Foreign-currency invoices: home currency at the invoice's rate, as the income was posted.
    out.push({ id: r.id, type: 'Invoice', sourceRef: `invoice:${r.docId}`, date: r.date, num: docRef(r.ref, r.num), customerId: r.customerId, itemId: r.itemId, item: r.item ?? '', memo: r.memo ?? '', qty: Money.of(r.qty), price: homeOf(Money.of(r.rate), r.fx), amount: homeOf(Money.of(r.amount), r.fx) });
  }
  // The invoice header discount (the invoice's Discount field) reduces sales like a discount
  // line: it is posted as a debit to income, so the sales reports show it as a negative line.
  if (!filter.itemId) {
    const discConds: SQL[] = [eq(invoices.companyId, c), notInArray(invoices.status, ['void', 'draft']), sql`${invoices.discount} <> 0`];
    if (scope) discConds.push(scope.invoiceIds.length ? inArray(invoices.id, scope.invoiceIds) : sql`false`);
    else discConds.push(gte(invoices.date, range.from), lte(invoices.date, range.to));
    if (filter.customerId) discConds.push(eq(invoices.customerId, filter.customerId));
    if (filter.classId) discConds.push(eq(invoices.classId, filter.classId));
    for (const r of await ctx.db
      .select({ id: invoices.id, date: invoices.date, num: invoices.invoiceNumber, ref: invoices.refNumber, customerId: invoices.customerId, discount: invoices.discount, fx: invoices.exchangeRate })
      .from(invoices)
      .where(and(...discConds))) {
      const amount = homeOf(Money.of(r.discount), r.fx).negated();
      out.push({ id: `disc:${r.id}`, type: 'Invoice', sourceRef: `invoice:${r.id}`, date: r.date, num: docRef(r.ref, r.num), customerId: r.customerId, itemId: null, item: 'Discount', memo: 'Invoice discount', qty: Money.zero(), price: amount, amount });
    }
  }
  const srConds: SQL[] = [eq(salesReceipts.companyId, c), ne(salesReceipts.status, 'void'), SALES_LINE_ONLY, gte(salesReceipts.date, range.from), lte(salesReceipts.date, range.to)];
  if (scope) srConds.push(sql`false`);
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
    const cmConds: SQL[] = [eq(creditMemos.companyId, c), ne(creditMemos.status, 'void'), SALES_LINE_ONLY];
    if (scope) cmConds.push(scope.creditMemoIds.length ? inArray(creditMemos.id, scope.creditMemoIds) : sql`false`);
    else cmConds.push(gte(creditMemos.date, range.from), lte(creditMemos.date, range.to));
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

/**
 * Sales lines on the report's basis. Accrual: salesLines. Cash (QB "Report Basis: Cash"): sales
 * receipts as they are, and each invoice / credit memo line recognized on the dates the document
 * was paid (or credited), in proportion to the share of its income settled then — the same
 * settlements the cash-basis ledger (cashBasisLedger.ts) uses for the Profit & Loss. Each line
 * is rounded cumulatively, so a fully paid line always adds up to its own amount.
 */
export async function salesLinesOnBasis(
  ctx: ServiceContext,
  range: { from: Date; to: Date },
  filter: { customerId?: string; itemId?: string; classId?: string },
  basis: 'accrual' | 'cash' | undefined,
): Promise<SalesLine[]> {
  if (basis !== 'cash') return salesLines(ctx, range, filter);
  const receipts = (await salesLines(ctx, range, filter)).filter((l) => l.type === 'Sales Receipt');
  const meta = await loadAccountMeta(ctx);
  const { adjustments } = await cashBasisLedger(ctx, { to: range.to });
  const deferred = new Map<string, Decimal>();
  const recog = new Map<string, Map<string, { date: Date; net: Decimal; entryId: string | null; txnType: TxnTypeKey }>>();
  for (const a of adjustments) {
    if (a.control || (a.doc.kind !== 'invoice' && a.doc.kind !== 'credit_memo')) continue;
    if (meta.get(a.accountId)?.type !== 'revenue') continue;
    const dk = `${a.doc.kind}:${a.doc.id}`;
    if (a.kind === 'defer') {
      deferred.set(dk, (deferred.get(dk) ?? Money.zero()).plus(a.net));
      continue;
    }
    const sk = `${a.date.getTime()}|${a.settle?.entryId ?? ''}|${a.settle?.txnType ?? ''}`;
    const m = recog.get(dk) ?? new Map();
    const cur = m.get(sk) ?? { date: a.date, net: Money.zero(), entryId: a.settle?.entryId ?? a.doc.entryId, txnType: a.settle?.txnType ?? 'payment' };
    cur.net = cur.net.plus(a.net);
    m.set(sk, cur);
    recog.set(dk, m);
  }
  // Only documents with a settlement inside the range matter.
  const inRange = (d: Date) => d >= range.from && d <= range.to;
  const docs = [...recog.entries()].filter(([, m]) => [...m.values()].some((r) => inRange(r.date)));
  if (docs.length === 0) return receipts;
  const scope = {
    invoiceIds: docs.filter(([k]) => k.startsWith('invoice:')).map(([k]) => k.slice('invoice:'.length)),
    creditMemoIds: docs.filter(([k]) => k.startsWith('credit_memo:')).map(([k]) => k.slice('credit_memo:'.length)),
  };
  const docLines = await salesLines(ctx, range, filter, scope);
  const byDoc = new Map<string, SalesLine[]>();
  for (const l of docLines) byDoc.set(l.sourceRef, [...(byDoc.get(l.sourceRef) ?? []), l]);
  const out: SalesLine[] = [...receipts];
  for (const [dk, m] of docs) {
    const def = deferred.get(dk);
    const lines = byDoc.get(dk);
    if (!def || def.isZero() || !lines) continue;
    const settlements = [...m.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
    let cum = Money.zero();
    const prevAmt = new Map<string, Decimal>();
    const prevQty = new Map<string, Decimal>();
    settlements.forEach((s, k) => {
      cum = cum.plus(s.net.negated().dividedBy(def));
      if (!inRange(s.date)) {
        for (const l of lines) {
          prevAmt.set(l.id, Money.round2(l.amount.times(cum)));
          prevQty.set(l.id, l.qty.times(cum).toDecimalPlaces(4));
        }
        return;
      }
      for (const l of lines) {
        const a = Money.round2(l.amount.times(cum));
        const q = l.qty.times(cum).toDecimalPlaces(4);
        const share = a.minus(prevAmt.get(l.id) ?? Money.zero());
        const qty = q.minus(prevQty.get(l.id) ?? Money.zero());
        prevAmt.set(l.id, a);
        prevQty.set(l.id, q);
        if (share.isZero() && qty.isZero()) continue;
        out.push({ ...l, id: `${l.id}:cash${k}`, baseId: l.id, baseAmount: l.amount, type: TXN_TYPE_LABELS[s.txnType], date: s.date, qty, amount: share, entryId: s.entryId });
      }
    });
  }
  return out.sort((a, b) => a.date.getTime() - b.date.getTime() || a.num.localeCompare(b.num, undefined, { numeric: true }));
}

/**
 * The COGS actually POSTED for each sales line (invoice line, sales receipt line, credit memo line
 * — negative for a return), from the document's own COGS entries: invoice-cogs:<invoice> with
 * reference cogs:<lineOrder>, salesreceipt:<receipt> / creditmemo-cogs:<memo> with the line id as
 * reference. Their P&L (expense) side is the COGS, at the cost the sale relieved — not today's
 * average cost — so it ties to the COGS accounts and never changes after the fact.
 * Keyed by the accrual line id. Lines with no COGS entry (services, …) are absent.
 */
export async function postedCogsBySalesLine(ctx: ServiceContext, lines: SalesLine[]): Promise<Map<string, Decimal>> {
  const refs = new Set<string>();
  const invoiceIds = new Set<string>();
  for (const l of lines) {
    const [kind, id] = l.sourceRef.split(':');
    if (kind === 'invoice') {
      refs.add(`invoice-cogs:${id}`);
      invoiceIds.add(id);
    } else if (kind === 'salesreceipt') refs.add(`salesreceipt:${id}`);
    else if (kind === 'credit_memo') refs.add(`creditmemo-cogs:${id}`);
  }
  const out = new Map<string, Decimal>();
  if (refs.size === 0) return out;
  // Invoice COGS entries name the line by its line order.
  const invLineByOrder = new Map<string, string>();
  const invIds = [...invoiceIds];
  for (let i = 0; i < invIds.length; i += 2000) {
    for (const r of await ctx.db
      .select({ id: invoiceLines.id, invoiceId: invoiceLines.invoiceId, lineOrder: invoiceLines.lineOrder })
      .from(invoiceLines)
      .where(inArray(invoiceLines.invoiceId, invIds.slice(i, i + 2000)))) {
      invLineByOrder.set(`${r.invoiceId}|${r.lineOrder}`, r.id);
    }
  }
  const refList = [...refs];
  for (let i = 0; i < refList.length; i += 2000) {
    const rows = await ctx.db
      .select({
        sourceRef: journalEntries.sourceRef,
        reference: journalEntries.reference,
        accountType: accounts.type,
        // A line's other side is NULL (not 0), so each side is coalesced before subtracting.
        cogs: sql<string>`COALESCE(SUM(COALESCE(${journalEntryLines.debit}, 0) - COALESCE(${journalEntryLines.credit}, 0)), 0)`,
      })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
      .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
      .where(
        and(
          eq(journalEntries.companyId, ctx.companyId),
          eq(journalEntries.status, 'posted'),
          inArray(journalEntries.sourceRef, refList.slice(i, i + 2000)),
        ),
      )
      .groupBy(journalEntries.sourceRef, journalEntries.reference, accounts.type);
    for (const r of rows) {
      // The P&L (expense) side of the entry is the COGS; the inventory asset side mirrors it.
      if (String(r.accountType) !== 'expense') continue;
      const [kind, docId] = String(r.sourceRef).split(':');
      let lineId: string | undefined;
      if (kind === 'invoice-cogs') {
        const m = /^cogs:(\d+)$/.exec(r.reference ?? '');
        lineId = m ? invLineByOrder.get(`${docId}|${m[1]}`) : undefined;
      } else {
        lineId = r.reference ?? undefined;
      }
      if (!lineId) continue;
      const v = Money.of(r.cogs);
      if (!v.isZero()) out.set(lineId, (out.get(lineId) ?? Money.zero()).plus(v));
    }
  }
  return out;
}

/** COGS of one (accrual or cash-basis) sales line from the posted COGS by line. */
export function cogsOfSalesLine(l: SalesLine, posted: Map<string, Decimal>): Decimal {
  const base = posted.get(l.baseId ?? l.id);
  if (!base) return Money.zero();
  if (!l.baseId) return base;
  // Cash basis: the share of the line settled in this payment.
  if (l.baseAmount && !l.baseAmount.isZero()) return Money.round2(base.times(l.amount).dividedBy(l.baseAmount));
  return Money.zero();
}

async function salesDetail(ctx: ServiceContext, p: ReportParams, by: 'customer' | 'item'): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  const basis = p.basis === 'cash' ? 'cash' : undefined;
  const lines = await salesLinesOnBasis(ctx, { from, to }, { customerId: p.customerId, itemId: p.itemId, classId: p.classId }, basis);
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
        entryId: l.entryId !== undefined ? l.entryId : (entryIds.get(l.sourceRef) ?? null),
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
    subtitle: `${rangeLabel(from, to)}${basis ? ' · Cash Basis' : ''}`,
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

/** Sales by Customer Summary (QB): sales per customer:job for the period, either basis. */
export async function salesByCustomerSummary(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  const basis = p.basis === 'cash' ? 'cash' : undefined;
  const lines = await salesLinesOnBasis(ctx, { from, to }, { customerId: p.customerId, itemId: p.itemId, classId: p.classId }, basis);
  const names = await customerNames(ctx);
  const by = new Map<string, Decimal>();
  for (const l of lines) by.set(l.customerId ?? '', (by.get(l.customerId ?? '') ?? Money.zero()).plus(l.amount));
  const label = (id: string) => (id ? (names.get(id)?.name ?? '') : '(no customer)');
  let total = Money.zero();
  const rows: StdRow[] = [...by.entries()]
    .filter(([, v]) => !v.isZero())
    .sort((a, b) => (a[0] === '' ? 1 : b[0] === '' ? -1 : label(a[0]).localeCompare(label(b[0]))))
    .map(([id, v]) => {
      total = total.plus(v);
      return {
        id: `sbc:${id || 'none'}`,
        depth: 0,
        kind: 'data' as const,
        cells: { label: label(id), amount: amt(v) },
        href: id ? stdHref('sales-by-customer-detail', { customerId: id, itemId: p.itemId, classId: p.classId, from: dayStr(from), to: dayStr(to), basis }) : null,
      };
    });
  rows.push({ id: 'sbc:grand', depth: 0, kind: 'grand', cells: { label: 'TOTAL', amount: amt(total) } });
  return {
    key: 'sales-by-customer-summary',
    title: 'Sales by Customer Summary',
    subtitle: `${rangeLabel(from, to)}${basis ? ' · Cash Basis' : ''}`,
    columns: [{ key: 'label', header: 'Customer' }, { key: 'amount', header: 'Amount', type: 'money' }],
    rows,
  };
}

/** Sales by Item Summary row key of the invoice header discounts. */
const DISCOUNT_KEY = '~invoice-discount';

const ITEM_TYPE_LABEL: Record<string, string> = {
  inventory: 'Inventory',
  non_inventory: 'Non-inventory',
  service: 'Service',
  other_charge: 'Other Charges',
  discount: 'Discounts',
  bundle: 'Groups',
  payment: 'Payments',
  subtotal: 'Subtotals',
  sales_tax: 'Sales Tax',
};

/**
 * Sales by Item Summary (QB): per item, grouped by item type — Qty, Amount, % of Sales, Avg Price,
 * COGS, Avg COGS, Gross Margin and Gross Margin %. COGS is what each sale actually posted (the
 * average / FIFO cost relieved at the time of sale — postedCogsBySalesLine), so it ties to the
 * COGS accounts and a later purchase at another cost never rewrites a past period.
 */
export async function salesByItemSummary(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  const basis = p.basis === 'cash' ? 'cash' : undefined;
  const lines = await salesLinesOnBasis(ctx, { from, to }, { customerId: p.customerId, itemId: p.itemId, classId: p.classId }, basis);
  const posted = await postedCogsBySalesLine(ctx, lines);
  const acc = new Map<string, { qty: Decimal; amount: Decimal; cogs: Decimal }>();
  for (const l of lines) {
    // Invoice header discounts get their own row (they are not an item).
    const k = l.itemId ?? (l.id.startsWith('disc:') ? DISCOUNT_KEY : '');
    const cur = acc.get(k) ?? { qty: Money.zero(), amount: Money.zero(), cogs: Money.zero() };
    cur.qty = cur.qty.plus(l.qty);
    cur.amount = cur.amount.plus(l.amount);
    cur.cogs = cur.cogs.plus(cogsOfSalesLine(l, posted));
    acc.set(k, cur);
  }
  const ids = [...acc.keys()].filter((k) => k && k !== DISCOUNT_KEY);
  const meta = new Map(
    (ids.length
      ? await ctx.db
          .select({ id: items.id, name: items.name, type: items.type, averageCost: items.averageCost })
          .from(items)
          .where(and(eq(items.companyId, ctx.companyId), inArray(items.id, ids)))
      : []
    ).map((i) => [i.id, i]),
  );
  const grandAmount = [...acc.values()].reduce((s, v) => s.plus(v.amount), Money.zero());
  const pctOf = (v: Decimal) => (grandAmount.isZero() ? null : v.dividedBy(grandAmount.abs()).times(100).toFixed(2));
  type Agg = { qty: Decimal; amount: Decimal; cogs: Decimal };
  const cellsFor = (label: string, a: Agg): Record<string, CellValue> => {
    const margin = a.amount.minus(a.cogs);
    return {
      label,
      qty: a.qty.toFixed(4),
      amount: amt(a.amount),
      pct: pctOf(a.amount),
      avgPrice: a.qty.isZero() ? null : a.amount.dividedBy(a.qty).toFixed(2),
      cogs: amt(a.cogs),
      avgCogs: a.qty.isZero() ? null : a.cogs.dividedBy(a.qty).toFixed(2),
      margin: amt(margin),
      marginPct: a.amount.isZero() ? null : margin.dividedBy(a.amount.abs()).times(100).toFixed(2),
    };
  };
  const groups = new Map<string, { id: string; name: string; agg: Agg }[]>();
  for (const [id, v] of acc) {
    if (v.amount.isZero() && v.qty.isZero()) continue;
    const it = id ? meta.get(id) : undefined;
    const type = it ? (ITEM_TYPE_LABEL[it.type] ?? it.type) : id === DISCOUNT_KEY ? ITEM_TYPE_LABEL.discount : 'No item';
    const name = it?.name ?? (id === DISCOUNT_KEY ? 'Invoice discounts' : '(no item)');
    groups.set(type, [...(groups.get(type) ?? []), { id: id === DISCOUNT_KEY ? '' : id, name, agg: { ...v } }]);
  }
  const rows: StdRow[] = [];
  const grand: Agg = { qty: Money.zero(), amount: Money.zero(), cogs: Money.zero() };
  for (const [type, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const hid = `sbi:${type}`;
    const sub: Agg = { qty: Money.zero(), amount: Money.zero(), cogs: Money.zero() };
    const header: StdRow = { id: hid, depth: 0, kind: 'section', collapseKind: 'group', cells: { label: type } };
    rows.push(header);
    for (const x of list.sort((a, b) => a.name.localeCompare(b.name))) {
      sub.qty = sub.qty.plus(x.agg.qty);
      sub.amount = sub.amount.plus(x.agg.amount);
      sub.cogs = sub.cogs.plus(x.agg.cogs);
      rows.push({
        id: `${hid}:${x.id || 'none'}`,
        parentId: hid,
        depth: 1,
        kind: 'data',
        cells: cellsFor(x.name, x.agg),
        href: x.id ? stdHref('sales-by-item-detail', { itemId: x.id, customerId: p.customerId, classId: p.classId, from: dayStr(from), to: dayStr(to), basis }) : null,
      });
    }
    grand.qty = grand.qty.plus(sub.qty);
    grand.amount = grand.amount.plus(sub.amount);
    grand.cogs = grand.cogs.plus(sub.cogs);
    header.collapsedCells = cellsFor(type, sub);
    rows.push({ id: `${hid}:total`, depth: 0, kind: 'subtotal', totalOf: hid, cells: cellsFor(`Total ${type}`, sub) });
  }
  rows.push({ id: 'sbi:grand', depth: 0, kind: 'grand', cells: cellsFor('TOTAL', grand) });
  return {
    key: 'sales-by-item-summary',
    title: 'Sales by Item Summary',
    subtitle: `${rangeLabel(from, to)}${basis ? ' · Cash Basis' : ''}`,
    columns: [
      { key: 'label', header: '' },
      { key: 'qty', header: 'Qty', type: 'number' },
      { key: 'amount', header: 'Amount', type: 'money' },
      { key: 'pct', header: '% of Sales', type: 'percent' },
      { key: 'avgPrice', header: 'Avg Price', type: 'money' },
      { key: 'cogs', header: 'COGS', type: 'money' },
      { key: 'avgCogs', header: 'Avg COGS', type: 'money' },
      { key: 'margin', header: 'Gross Margin', type: 'money' },
      { key: 'marginPct', header: 'Gross Margin %', type: 'percent' },
    ],
    rows,
  };
}

async function openSalesOrders(ctx: ServiceContext, p: ReportParams, by: 'customer' | 'item'): Promise<StdReport> {
  // Subtotal / sales-tax lines are not ordered goods: they are never invoiced, so they would
  // show as permanently "backordered" and inflate the open amount.
  const conds: SQL[] = [eq(salesOrders.companyId, ctx.companyId), notInArray(salesOrders.status, ['void', 'closed', 'paid']), SALES_LINE_ONLY];
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
        href: id ? stdHref('expenses-by-vendor-detail', { vendorId: id, classId: p.classId, from: dayStr(from), to: dayStr(to), basis: p.basis === 'cash' ? 'cash' : undefined }) : null,
      };
    });
  rows.push({ id: 'ebv:grand', depth: 0, kind: 'grand', cells: { label: 'TOTAL', amount: amt(total) } });
  return {
    key: 'expenses-by-vendor-summary',
    title: 'Expenses by Vendor Summary',
    subtitle: `${rangeLabel(from, to)}${p.basis === 'cash' ? ' · Cash Basis' : ''}`,
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
    subtitle: `${rangeLabel(from, to)}${p.basis === 'cash' ? ' · Cash Basis' : ''}`,
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
  // Every A/R / A/P line, summed per name in SQL (no line cap on a large file).
  const lines = await ledgerTotalsByName(ctx, meta, { sections: [section] });
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

// Income tax reports moved to incomeTaxReports.ts (form line names, form order, company form).
export { incomeTaxPreparation, incomeTaxReport, defaultTaxLineMapper, type TaxLine, type TaxLineMapper } from './incomeTaxReports';

export type { CellValue, StdColumn };

/**
 * One purchase of an item (QB Reports > Purchases): an item line on a bill, on a check or
 * credit-card charge (Write Checks / Enter Credit Card Charges, Items tab), or on a vendor credit
 * (a return: negative quantity and amount). Amounts are in HOME currency, exactly as the
 * document posted them (homeAmounts: one round2(total x rate) anchor penny-allocated over the
 * document's lines), so a EUR bill never adds euros to dollars.
 */
export interface PurchaseLine {
  id: string;
  type: 'Bill' | 'Check' | 'Credit Card Charge' | 'Credit';
  sourceRef: string;
  date: Date;
  num: string;
  vendorId: string | null;
  vendor: string;
  itemId: string;
  item: string | null;
  memo: string;
  qty: Decimal;
  amount: Decimal;
}

/** Item purchases in [from, to] (void documents excluded), optionally for one item / vendor. */
export async function purchaseLines(
  ctx: ServiceContext,
  p: Pick<ReportParams, 'itemId' | 'vendorId'>,
  from: Date,
  to: Date,
): Promise<PurchaseLine[]> {
  const c = ctx.companyId;
  const out: PurchaseLine[] = [];

  const billConds: SQL[] = [eq(bills.companyId, c), ne(bills.status, 'void'), gte(bills.date, from), lte(bills.date, to), isNotNull(billLines.itemId)];
  if (p.itemId) billConds.push(eq(billLines.itemId, p.itemId));
  if (p.vendorId) billConds.push(eq(bills.vendorId, p.vendorId));
  const billRows = await ctx.db
    .select({ id: billLines.id, docId: bills.id, num: bills.billNumber, date: bills.date, vendorId: bills.vendorId, vendor: vendors.displayName, itemId: billLines.itemId, item: items.name, memo: billLines.description, qty: billLines.quantity, amount: billLines.amount, rate: bills.exchangeRate })
    .from(billLines)
    .innerJoin(bills, eq(billLines.billId, bills.id))
    .innerJoin(vendors, eq(bills.vendorId, vendors.id))
    .leftJoin(items, eq(billLines.itemId, items.id))
    .where(and(...billConds));
  const billHome = await homeAmountsByLine(ctx, 'bill', billRows.map((r) => ({ id: r.docId, rate: r.rate })));
  for (const r of billRows) {
    out.push({ id: r.id, type: 'Bill', sourceRef: `bill:${r.docId}`, date: r.date, num: r.num ?? '', vendorId: r.vendorId, vendor: r.vendor, itemId: r.itemId!, item: r.item, memo: r.memo ?? '', qty: Money.of(r.qty), amount: billHome.get(r.id) ?? Money.of(r.amount) });
  }

  // Checks and credit-card charges with item lines (a card credit cannot carry items).
  const expConds: SQL[] = [eq(expenses.companyId, c), isNull(expenses.voidedAt), gte(expenses.date, from), lte(expenses.date, to), isNotNull(expenseLines.itemId)];
  if (p.itemId) expConds.push(eq(expenseLines.itemId, p.itemId));
  if (p.vendorId) expConds.push(eq(expenses.vendorId, p.vendorId));
  const expRows = await ctx.db
    .select({ id: expenseLines.id, docId: expenses.id, num: expenses.reference, date: expenses.date, method: expenses.method, vendorId: expenses.vendorId, vendor: vendors.displayName, payee: expenses.payeeName, itemId: expenseLines.itemId, item: items.name, memo: expenseLines.description, qty: expenseLines.quantity, amount: expenseLines.amount, rate: expenses.exchangeRate })
    .from(expenseLines)
    .innerJoin(expenses, eq(expenseLines.expenseId, expenses.id))
    .leftJoin(vendors, eq(expenses.vendorId, vendors.id))
    .leftJoin(items, eq(expenseLines.itemId, items.id))
    .where(and(...expConds));
  const expHome = await homeAmountsByLine(ctx, 'expense', expRows.map((r) => ({ id: r.docId, rate: r.rate })));
  for (const r of expRows) {
    out.push({
      id: r.id,
      type: r.method === 'credit_card' ? 'Credit Card Charge' : 'Check',
      sourceRef: `expense:${r.docId}`,
      date: r.date,
      num: r.num ?? '',
      vendorId: r.vendorId,
      vendor: r.vendor ?? r.payee ?? '',
      itemId: r.itemId!,
      item: r.item,
      memo: r.memo ?? '',
      qty: Money.of(r.qty ?? '1'),
      amount: expHome.get(r.id) ?? Money.of(r.amount),
    });
  }

  // Vendor credits (returns) reduce what was bought.
  const vcConds: SQL[] = [eq(vendorCredits.companyId, c), ne(vendorCredits.status, 'void'), gte(vendorCredits.date, from), lte(vendorCredits.date, to), isNotNull(vendorCreditLines.itemId)];
  if (p.itemId) vcConds.push(eq(vendorCreditLines.itemId, p.itemId));
  if (p.vendorId) vcConds.push(eq(vendorCredits.vendorId, p.vendorId));
  const vcRows = await ctx.db
    .select({ id: vendorCreditLines.id, docId: vendorCredits.id, num: vendorCredits.refNumber, date: vendorCredits.date, vendorId: vendorCredits.vendorId, vendor: vendors.displayName, itemId: vendorCreditLines.itemId, item: items.name, memo: vendorCreditLines.description, qty: vendorCreditLines.quantity, amount: vendorCreditLines.amount, rate: vendorCredits.exchangeRate })
    .from(vendorCreditLines)
    .innerJoin(vendorCredits, eq(vendorCreditLines.vendorCreditId, vendorCredits.id))
    .innerJoin(vendors, eq(vendorCredits.vendorId, vendors.id))
    .leftJoin(items, eq(vendorCreditLines.itemId, items.id))
    .where(and(...vcConds));
  const vcHome = await homeAmountsByLine(ctx, 'vendor_credit', vcRows.map((r) => ({ id: r.docId, rate: r.rate })));
  for (const r of vcRows) {
    out.push({ id: r.id, type: 'Credit', sourceRef: `vendor_credit:${r.docId}`, date: r.date, num: r.num ?? '', vendorId: r.vendorId, vendor: r.vendor, itemId: r.itemId!, item: r.item, memo: r.memo ?? '', qty: Money.of(r.qty ?? '1').negated(), amount: (vcHome.get(r.id) ?? Money.of(r.amount)).negated() });
  }
  return out.sort((a, b) => a.date.getTime() - b.date.getTime() || a.num.localeCompare(b.num, undefined, { numeric: true }) || a.id.localeCompare(b.id));
}

/**
 * Purchases by Item Detail — every purchase of an item (bills, checks, credit-card charges and
 * vendor credits as returns; void documents excluded), by item, in home currency.
 */
export async function purchasesByItemDetail(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  const lines = await purchaseLines(ctx, p, from, to);
  const entryIds = await entryIdsForSourceRefs(ctx, lines.map((r) => r.sourceRef));
  const rows: StdRow[] = [];
  let tQty = Money.zero();
  let tAmt = Money.zero();
  const groups = new Map<string, PurchaseLine[]>();
  for (const r of lines) groups.set(r.itemId, [...(groups.get(r.itemId) ?? []), r]);
  for (const [k, list] of [...groups.entries()].sort((a, b) => (a[1][0].item ?? '').localeCompare(b[1][0].item ?? ''))) {
    const label = list[0].item ?? '(no item)';
    const hid = `pid:${k}`;
    const header: StdRow = { id: hid, depth: 0, kind: 'section', collapseKind: 'group', cells: { label } };
    rows.push(header);
    let q = Money.zero();
    let a = Money.zero();
    for (const r of list) {
      q = q.plus(r.qty);
      a = a.plus(r.amount);
      rows.push({
        id: `pid:l:${r.id}`,
        parentId: hid,
        depth: 1,
        kind: 'data',
        cells: { label: '', type: r.type, date: dayStr(r.date), num: r.num, name: r.vendor, memo: r.memo, qty: r.qty.toFixed(4), amount: amt(r.amount), balance: amt(a) },
        entryId: entryIds.get(r.sourceRef) ?? null,
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

/**
 * Purchases by Item Summary / Purchases by Vendor Summary (QB Reports > Purchases): item
 * purchases in the period (purchaseLines), totalled per item or per vendor.
 */
async function purchasesSummary(ctx: ServiceContext, p: ReportParams, by: 'item' | 'vendor'): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  const lines = await purchaseLines(ctx, p, from, to);
  const acc = new Map<string, { label: string; qty: Decimal; amount: Decimal }>();
  for (const l of lines) {
    const k = (by === 'item' ? l.itemId : l.vendorId) ?? '';
    const cur = acc.get(k) ?? { label: (by === 'item' ? l.item : l.vendorId ? l.vendor : '(no vendor)') ?? '(none)', qty: Money.zero(), amount: Money.zero() };
    cur.qty = cur.qty.plus(l.qty);
    cur.amount = cur.amount.plus(l.amount);
    acc.set(k, cur);
  }
  const grandAmt = [...acc.values()].reduce((s, v) => s.plus(v.amount), Money.zero());
  const grandQty = [...acc.values()].reduce((s, v) => s.plus(v.qty), Money.zero());
  const rows: StdRow[] = [...acc.entries()]
    .sort((a, b) => a[1].label.localeCompare(b[1].label))
    .map(([id, v]) => ({
      id: `pbs:${by}:${id || 'none'}`,
      depth: 0,
      kind: 'data' as const,
      cells: {
        label: v.label,
        qty: v.qty.toFixed(4),
        amount: amt(v.amount),
        pct: grandAmt.isZero() ? null : v.amount.dividedBy(grandAmt.abs()).times(100).toFixed(2),
        avgCost: v.qty.isZero() ? null : v.amount.dividedBy(v.qty).toFixed(2),
      },
      href: id ? stdHref('purchases-by-item-detail', { [by === 'item' ? 'itemId' : 'vendorId']: id, from: dayStr(from), to: dayStr(to) }) : null,
    }));
  rows.push({ id: `pbs:${by}:grand`, depth: 0, kind: 'grand', cells: { label: 'TOTAL', qty: grandQty.toFixed(4), amount: amt(grandAmt), pct: grandAmt.isZero() ? null : '100.00' } });
  const columns: StdColumn[] = [
    { key: 'label', header: by === 'item' ? 'Item' : 'Vendor' },
    { key: 'qty', header: 'Qty', type: 'number' },
    { key: 'amount', header: 'Amount', type: 'money' },
    { key: 'pct', header: '% of Purchases', type: 'percent' },
  ];
  if (by === 'item') columns.push({ key: 'avgCost', header: 'Avg Cost', type: 'money' });
  return {
    key: by === 'item' ? 'purchases-by-item-summary' : 'purchases-by-vendor-summary',
    title: by === 'item' ? 'Purchases by Item Summary' : 'Purchases by Vendor Summary',
    subtitle: rangeLabel(from, to),
    columns,
    rows,
  };
}

export const purchasesByItemSummary = (ctx: ServiceContext, p: ReportParams) => purchasesSummary(ctx, p, 'item');
export const purchasesByVendorSummary = (ctx: ServiceContext, p: ReportParams) => purchasesSummary(ctx, p, 'vendor');
