/**
 * A/R and A/P aging on the standard report engine (QB Reports > Customers & Receivables and
 * Vendors & Payables): A/R Aging Summary / Detail, A/P Aging Summary / Detail, Open Invoices and
 * the Collections Report — memorizable, schedulable, filterable and with QuickZoom.
 *
 * The open items come from the aging reconstruction in reportsExtra.ts (arAgingDetail /
 * apAgingDetail): every open invoice / bill at its balance AS OF the report date, unapplied
 * credits and payments as negatives, and named General Journal A/R / A/P lines. That is the same
 * set the A/R and A/P control accounts hold, so the reports tie to the balance sheet.
 *
 * QB options honoured here:
 *  - Interval (days) and Through (days past due): the aging columns are Current, 1 – N,
 *    N+1 – 2N, … up to "through", then "> through" (defaults 30 / 90);
 *  - Aging from the due date (QB default) or from the transaction date (Preferences > Reports,
 *    overridable per report);
 *  - Customer:Job (includes the customer's jobs), vendor and class filters. Class applies to
 *    invoices and bills (the documents that carry a class); unclassified credits drop out when a
 *    class is chosen, as in QB.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type Decimal from 'decimal.js';
import { bills, customers, invoices, paymentsReceived } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import type { CellValue, StdColumn, StdReport, StdRow } from '@/lib/reports/types';
import type { ReportParams } from '@/lib/validation/reports';
import type { ServiceContext } from './_base';
import { validation } from './_base';
import { getPreferences } from './company';
import { apAgingDetail, arAgingDetail, type AgingDetailRow } from './reportsExtra';
import { customerNames, dayStr, entryIdsForSourceRefs, fmtDay, resolveAsOf, stdHref } from './reportEngine';

const amt = (v: Decimal) => toAmountString(v);
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Aging columns
// ---------------------------------------------------------------------------

export interface AgingColumn {
  key: string;
  label: string;
  /** Inclusive day range; `max` null = open-ended (the "> through" column). */
  min: number;
  max: number | null;
}

export const DEFAULT_AGING_INTERVAL = 30;
export const DEFAULT_AGING_THROUGH = 90;
const MAX_AGING_COLUMNS = 24;

/** QB aging columns for an interval / through pair: Current, 1 - 30, 31 - 60, 61 - 90, > 90. */
export function agingColumns(interval = DEFAULT_AGING_INTERVAL, through = DEFAULT_AGING_THROUGH): AgingColumn[] {
  if (!Number.isInteger(interval) || interval < 1) throw validation('Interval must be at least 1 day.');
  if (!Number.isInteger(through) || through < 1) throw validation('"Through" must be at least 1 day past due.');
  if (Math.ceil(through / interval) > MAX_AGING_COLUMNS) {
    throw validation('That makes more than 24 aging columns. Use a longer interval or a shorter "through".');
  }
  const cols: AgingColumn[] = [{ key: 'current', label: 'Current', min: Number.NEGATIVE_INFINITY, max: 0 }];
  for (let lo = 1, i = 0; lo <= through; lo += interval, i++) {
    const hi = Math.min(lo + interval - 1, through);
    cols.push({ key: `b${i}`, label: `${lo} - ${hi}`, min: lo, max: hi });
  }
  cols.push({ key: 'over', label: `> ${through}`, min: through + 1, max: null });
  return cols;
}

export function agingColumnFor(days: number, cols: AgingColumn[]): AgingColumn {
  for (const c of cols) if (days >= c.min && (c.max === null || days <= c.max)) return c;
  return cols[cols.length - 1];
}

/** Whole days from `from` to `to` by calendar day (time of day ignored). */
export function daysBetween(from: Date | string, to: Date | string): number {
  const a = Date.parse(`${typeof from === 'string' ? from.slice(0, 10) : dayStr(from)}T00:00:00.000Z`);
  const b = Date.parse(`${typeof to === 'string' ? to.slice(0, 10) : dayStr(to)}T00:00:00.000Z`);
  return Math.round((b - a) / DAY_MS);
}

// ---------------------------------------------------------------------------
// Open items as of a date
// ---------------------------------------------------------------------------

export interface OpenItem extends AgingDetailRow {
  /** Days past due (or since the transaction date) on the report date; null for credits. */
  aging: number | null;
  column: AgingColumn;
  terms: string;
  poNumber: string;
  classId: string | null;
  entryId: string | null;
  docLabel: string;
  typeLabel: string;
}

const TYPE_LABEL: Record<AgingDetailRow['docType'], string> = {
  invoice: 'Invoice',
  credit_memo: 'Credit Memo',
  bill: 'Bill',
  vendor_credit: 'Credit',
  journal_entry: 'General Journal',
  payment: 'Payment',
};

const SOURCE_PREFIX: Partial<Record<AgingDetailRow['docType'], string>> = {
  invoice: 'invoice',
  credit_memo: 'credit_memo',
  bill: 'bill',
  vendor_credit: 'vendor_credit',
};

/** "Net 30" from the stored terms key ("net_30"). */
function termsLabel(t: string | null | undefined): string {
  if (!t) return '';
  const m = /^net_(\d+)$/.exec(t);
  if (m) return `Net ${m[1]}`;
  if (t === 'due_on_receipt') return 'Due on receipt';
  return t.replace(/_/g, ' ');
}

/**
 * Every open A/R or A/P item as of `asOf`, aged with the report's options and filtered by
 * name / class. Customer filter includes the customer's jobs (sub-customers).
 */
export async function openItems(
  ctx: ServiceContext,
  side: 'ar' | 'ap',
  p: ReportParams,
): Promise<{ asOf: Date; cols: AgingColumn[]; fromTxnDate: boolean; items: OpenItem[]; interval: number; through: number }> {
  const asOf = resolveAsOf(p);
  const interval = p.interval ? Number(p.interval) : DEFAULT_AGING_INTERVAL;
  const through = p.through ? Number(p.through) : DEFAULT_AGING_THROUGH;
  const cols = agingColumns(interval, through);
  const fromTxnDate = (p.agingFrom ?? (await getPreferences(ctx)).agingFrom) === 'transaction_date';
  const detail = side === 'ar' ? await arAgingDetail(ctx, asOf) : await apAgingDetail(ctx, asOf);
  let rows = detail.rows;

  if (side === 'ar' && p.customerId) {
    const names = await customerNames(ctx);
    const keep = new Set([p.customerId]);
    // A customer includes its jobs (any depth).
    let grew = true;
    while (grew) {
      grew = false;
      for (const [id, c] of names) if (c.parentId && keep.has(c.parentId) && !keep.has(id)) (keep.add(id), (grew = true));
    }
    rows = rows.filter((r) => keep.has(r.entityId));
  }
  if (side === 'ap' && p.vendorId) rows = rows.filter((r) => r.entityId === p.vendorId);

  // Document header extras: terms, P.O. number, class.
  const docIds = rows.filter((r) => r.docType === 'invoice' || r.docType === 'bill').map((r) => r.docId);
  const extra = new Map<string, { terms: string | null; po: string | null; classId: string | null }>();
  if (docIds.length) {
    if (side === 'ar') {
      for (let i = 0; i < docIds.length; i += 2000) {
        for (const d of await ctx.db
          .select({ id: invoices.id, terms: invoices.terms, po: invoices.poNumber, classId: invoices.classId })
          .from(invoices)
          .where(and(eq(invoices.companyId, ctx.companyId), inArray(invoices.id, docIds.slice(i, i + 2000))))) {
          extra.set(d.id, d);
        }
      }
    } else {
      for (let i = 0; i < docIds.length; i += 2000) {
        for (const d of await ctx.db
          .select({ id: bills.id, terms: bills.terms, classId: bills.classId })
          .from(bills)
          .where(and(eq(bills.companyId, ctx.companyId), inArray(bills.id, docIds.slice(i, i + 2000))))) {
          extra.set(d.id, { ...d, po: null });
        }
      }
    }
  }
  if (p.classId) rows = rows.filter((r) => extra.get(r.docId)?.classId === p.classId);

  // QuickZoom: the posted entry of each document.
  const refs = rows.map((r) => (SOURCE_PREFIX[r.docType] ? `${SOURCE_PREFIX[r.docType]}:${r.docId}` : ''));
  const entryIds = await entryIdsForSourceRefs(ctx, refs);
  const payIds = rows.filter((r) => r.docType === 'payment').map((r) => r.docId);
  const payEntry = new Map<string, string | null>();
  for (let i = 0; i < payIds.length; i += 2000) {
    for (const r of await ctx.db
      .select({ id: paymentsReceived.id, entryId: paymentsReceived.postedEntryId })
      .from(paymentsReceived)
      .where(and(eq(paymentsReceived.companyId, ctx.companyId), inArray(paymentsReceived.id, payIds.slice(i, i + 2000))))) {
      payEntry.set(r.id, r.entryId);
    }
  }

  // Customer:Job full names.
  const full = side === 'ar' ? await customerNames(ctx) : null;

  const items: OpenItem[] = rows.map((r, i) => {
    const credit = Money.of(r.openBalance).isNegative();
    const basisDate = fromTxnDate ? r.date : (r.dueDate ?? r.date);
    const days = daysBetween(basisDate, asOf);
    const aging = credit ? null : days;
    const column = credit ? cols[0] : agingColumnFor(days, cols);
    const x = extra.get(r.docId);
    const num = r.docNumber.replace(/^(Invoice #|Credit Memo #|Bill |General Journal #|Payment )/, '');
    return {
      ...r,
      entityName: full?.get(r.entityId)?.name ?? r.entityName,
      aging,
      column,
      terms: termsLabel(x?.terms),
      poNumber: x?.po ?? '',
      classId: x?.classId ?? null,
      entryId:
        r.docType === 'journal_entry'
          ? r.docId
          : r.docType === 'payment'
            ? (payEntry.get(r.docId) ?? null)
            : (entryIds.get(refs[i]) ?? null),
      docLabel: num === r.docNumber && /^(Bill|Payment|Vendor Credit)$/.test(num) ? '' : num,
      typeLabel: TYPE_LABEL[r.docType],
    };
  });
  return { asOf, cols, fromTxnDate, items, interval, through };
}

function optionsSubtitle(asOf: Date, fromTxnDate: boolean): string {
  return `As of ${fmtDay(asOf)}${fromTxnDate ? ' · Aged from transaction date' : ''}`;
}

/** Params carried into QuickZoom links so the drill-down uses the same aging options. */
function carry(p: ReportParams, asOf: Date): Record<string, string | undefined> {
  return { asOf: dayStr(asOf), interval: p.interval, through: p.through, agingFrom: p.agingFrom, classId: p.classId };
}

// ---------------------------------------------------------------------------
// Aging Summary
// ---------------------------------------------------------------------------

export async function agingSummary(ctx: ServiceContext, p: ReportParams, side: 'ar' | 'ap'): Promise<StdReport> {
  const { asOf, cols, fromTxnDate, items } = await openItems(ctx, side, p);
  const byName = new Map<string, { name: string; v: Map<string, Decimal> }>();
  for (const it of items) {
    const cur = byName.get(it.entityId) ?? { name: it.entityName, v: new Map<string, Decimal>() };
    cur.v.set(it.column.key, (cur.v.get(it.column.key) ?? Money.zero()).plus(Money.of(it.openBalance)));
    byName.set(it.entityId, cur);
  }
  const detailKey = side === 'ar' ? 'ar-aging-detail' : 'ap-aging-detail';
  const nameParam = side === 'ar' ? 'customerId' : 'vendorId';
  const grand = new Map<string, Decimal>();
  const rows: StdRow[] = [];
  let grandTotal = Money.zero();
  for (const [id, g] of [...byName.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
    const total = [...g.v.values()].reduce((s, v) => s.plus(v), Money.zero());
    if (total.isZero() && [...g.v.values()].every((v) => v.isZero())) continue;
    const cells: Record<string, CellValue> = { label: g.name };
    const hrefs: Record<string, string> = {};
    for (const c of cols) {
      const v = g.v.get(c.key) ?? Money.zero();
      cells[c.key] = amt(v);
      grand.set(c.key, (grand.get(c.key) ?? Money.zero()).plus(v));
    }
    cells.total = amt(total);
    grandTotal = grandTotal.plus(total);
    const zoom = stdHref(detailKey, { ...carry(p, asOf), [nameParam]: id });
    for (const c of cols) hrefs[c.key] = zoom;
    hrefs.total = zoom;
    rows.push({ id: `ag:${id}`, depth: 0, kind: 'data', cells, href: zoom, hrefs });
  }
  const tc: Record<string, CellValue> = { label: 'TOTAL', total: amt(grandTotal) };
  for (const c of cols) tc[c.key] = amt(grand.get(c.key) ?? Money.zero());
  rows.push({ id: 'ag:grand', depth: 0, kind: 'grand', cells: tc, href: stdHref(detailKey, carry(p, asOf)) });
  const columns: StdColumn[] = [
    { key: 'label', header: side === 'ar' ? 'Customer' : 'Vendor' },
    ...cols.map((c) => ({ key: c.key, header: c.label, type: 'money' as const })),
    { key: 'total', header: 'TOTAL', type: 'money' },
  ];
  return {
    key: side === 'ar' ? 'ar-aging-summary' : 'ap-aging-summary',
    title: side === 'ar' ? 'A/R Aging Summary' : 'A/P Aging Summary',
    subtitle: optionsSubtitle(asOf, fromTxnDate),
    columns,
    rows,
  };
}

// ---------------------------------------------------------------------------
// Aging Detail (grouped by aging column)
// ---------------------------------------------------------------------------

const DETAIL_COLS = (side: 'ar' | 'ap'): StdColumn[] => [
  { key: 'label', header: '' },
  { key: 'type', header: 'Type' },
  { key: 'date', header: 'Date', type: 'date' },
  { key: 'num', header: 'Num' },
  ...(side === 'ar' ? [{ key: 'po', header: 'P. O. #' }] : []),
  { key: 'name', header: 'Name' },
  { key: 'terms', header: 'Terms' },
  { key: 'due', header: 'Due Date', type: 'date' },
  { key: 'aging', header: 'Aging', type: 'number' },
  { key: 'open', header: 'Open Balance', type: 'money' },
];

function itemCells(it: OpenItem): Record<string, CellValue> {
  return {
    label: '',
    type: it.typeLabel,
    date: it.date.slice(0, 10),
    num: it.docLabel,
    po: it.poNumber,
    name: it.entityName,
    terms: it.terms,
    due: it.dueDate ? it.dueDate.slice(0, 10) : '',
    aging: it.aging !== null && it.aging > 0 ? it.aging : null,
    open: it.openBalance,
  };
}

function byDateThenName(a: OpenItem, b: OpenItem) {
  return (a.dueDate ?? a.date).localeCompare(b.dueDate ?? b.date) || a.entityName.localeCompare(b.entityName) || a.docLabel.localeCompare(b.docLabel, undefined, { numeric: true });
}

export async function agingDetail(ctx: ServiceContext, p: ReportParams, side: 'ar' | 'ap'): Promise<StdReport> {
  const { asOf, cols, fromTxnDate, items } = await openItems(ctx, side, p);
  const rows: StdRow[] = [];
  let grand = Money.zero();
  for (const c of cols) {
    const list = items.filter((i) => i.column.key === c.key).sort(byDateThenName);
    if (!list.length) continue;
    const hid = `agd:${c.key}`;
    const sub = list.reduce((s, i) => s.plus(Money.of(i.openBalance)), Money.zero());
    const label = c.key === 'current' ? 'Current' : c.max === null ? `> ${c.min - 1} days past due` : `${c.label} days past due`;
    rows.push({ id: hid, depth: 0, kind: 'section', collapseKind: 'group', cells: { label }, collapsedCells: { label, open: amt(sub) } });
    for (const it of list) rows.push({ id: `${hid}:${it.docType}:${it.docId}`, parentId: hid, depth: 1, kind: 'data', cells: itemCells(it), entryId: it.entryId });
    rows.push({ id: `${hid}:total`, depth: 0, kind: 'subtotal', totalOf: hid, cells: { label: `Total ${label}`, open: amt(sub) } });
    grand = grand.plus(sub);
  }
  rows.push({ id: 'agd:grand', depth: 0, kind: 'grand', cells: { label: 'TOTAL', open: amt(grand) } });
  return {
    key: side === 'ar' ? 'ar-aging-detail' : 'ap-aging-detail',
    title: side === 'ar' ? 'A/R Aging Detail' : 'A/P Aging Detail',
    subtitle: optionsSubtitle(asOf, fromTxnDate),
    columns: DETAIL_COLS(side),
    rows,
  };
}

// ---------------------------------------------------------------------------
// Open Invoices / Collections Report (by customer)
// ---------------------------------------------------------------------------

async function byCustomerReport(
  ctx: ServiceContext,
  p: ReportParams,
  kind: 'open-invoices' | 'collections-report',
): Promise<StdReport> {
  // QB ages both of these from the due date.
  const { asOf, items } = await openItems(ctx, 'ar', { ...p, agingFrom: 'due_date' });
  const collections = kind === 'collections-report';
  const overDays = p.overDays !== undefined ? Number(p.overDays) : null;
  const list = (collections ? items.filter((i) => i.aging !== null && i.aging > 0) : items).filter(
    (i) => overDays === null || (i.aging !== null && i.aging > overDays),
  );
  const contact = new Map<string, { phone: string | null; email: string | null }>();
  if (collections && list.length) {
    const ids = [...new Set(list.map((i) => i.entityId))];
    for (let i = 0; i < ids.length; i += 2000) {
      for (const c of await ctx.db
        .select({ id: customers.id, phone: customers.phone, email: customers.email })
        .from(customers)
        .where(and(eq(customers.companyId, ctx.companyId), inArray(customers.id, ids.slice(i, i + 2000))))) {
        contact.set(c.id, c);
      }
    }
  }
  const groups = new Map<string, OpenItem[]>();
  for (const it of list) groups.set(it.entityId, [...(groups.get(it.entityId) ?? []), it]);
  const rows: StdRow[] = [];
  let grand = Money.zero();
  for (const [id, g] of [...groups.entries()].sort((a, b) => a[1][0].entityName.localeCompare(b[1][0].entityName))) {
    const name = g[0].entityName;
    const ct = contact.get(id);
    const label = collections && ct && (ct.phone || ct.email) ? `${name} (${[ct.phone, ct.email].filter(Boolean).join(' · ')})` : name;
    const hid = `${kind}:${id}`;
    const sub = g.reduce((s, i) => s.plus(Money.of(i.openBalance)), Money.zero());
    rows.push({ id: hid, depth: 0, kind: 'section', collapseKind: 'group', cells: { label }, collapsedCells: { label, open: amt(sub) } });
    for (const it of g.sort(byDateThenName)) {
      rows.push({ id: `${hid}:${it.docType}:${it.docId}`, parentId: hid, depth: 1, kind: 'data', cells: itemCells(it), entryId: it.entryId });
    }
    rows.push({ id: `${hid}:total`, depth: 0, kind: 'subtotal', totalOf: hid, cells: { label: `Total ${name}`, open: amt(sub) } });
    grand = grand.plus(sub);
  }
  rows.push({ id: `${kind}:grand`, depth: 0, kind: 'grand', cells: { label: 'TOTAL', open: amt(grand) } });
  const columns = DETAIL_COLS('ar').filter((c) => c.key !== 'name');
  return {
    key: kind,
    title: collections ? 'Collections Report' : 'Open Invoices',
    subtitle: `As of ${fmtDay(asOf)}${overDays !== null ? ` · more than ${overDays} days past due` : ''}`,
    columns,
    rows,
    notes: collections ? ['Overdue invoices and charges only, with each customer’s phone and email.'] : undefined,
  };
}

export const arAgingSummaryReport = (ctx: ServiceContext, p: ReportParams) => agingSummary(ctx, p, 'ar');
export const arAgingDetailReport = (ctx: ServiceContext, p: ReportParams) => agingDetail(ctx, p, 'ar');
export const apAgingSummaryReport = (ctx: ServiceContext, p: ReportParams) => agingSummary(ctx, p, 'ap');
export const apAgingDetailReport = (ctx: ServiceContext, p: ReportParams) => agingDetail(ctx, p, 'ap');
export const openInvoicesReport = (ctx: ServiceContext, p: ReportParams) => byCustomerReport(ctx, p, 'open-invoices');
export const collectionsStdReport = (ctx: ServiceContext, p: ReportParams) => byCustomerReport(ctx, p, 'collections-report');

