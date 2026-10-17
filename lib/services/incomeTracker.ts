/**
 * Income Tracker + Collections Center (wave2 sales, C9).
 *
 * Income Tracker (QB "Income Tracker"): one screen with four money bars —
 *   Unbilled  — open estimates (not yet fully invoiced), open sales orders (uninvoiced
 *               quantity), and billable time not yet on an invoice;
 *   Unpaid    — open invoices/statement charges not yet past due;
 *   Overdue   — open invoices/statement charges past their due date;
 *   Paid      — payments and sales receipts received in the last 30 days;
 * plus a row list with batch actions (email, queue for printing, convert to invoice).
 *
 * Collections Center (QB "Collections Center"): customers with overdue and almost-due balances,
 * each invoice with days late, contact details, and timestamped collection notes with a
 * follow-up date (`collection_notes`).
 *
 * Read-only except the notes and the batch actions (which go through the normal services, so
 * posting, permissions and the audit trail behave exactly as when done one at a time).
 */
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  auditLogs,
  collectionNotes,
  customers,
  estimateLines,
  estimates,
  invoiceLines,
  invoices,
  paymentsReceived,
  salesOrderLines,
  salesOrders,
  salesReceipts,
  timeEntries,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, ServiceError, inTransaction, notFound, validation, writeAudit } from './_base';
import { convertToInvoice as convertEstimate } from './estimates';
import { convertToInvoice as convertSalesOrder } from './salesOrders';
import { type SalesFormKind, sendQueuedEmails, setSendFlags } from './salesForms';
import { docRef } from './docNumbers';
import { arAgingDetail } from './reportsExtra';

const DAY_MS = 86_400_000;

function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

export type TrackerBucket = 'unbilled' | 'unpaid' | 'overdue' | 'paid';

export interface TrackerRow {
  bucket: TrackerBucket;
  /** estimate | sales_order | time | invoice | statement_charge | payment | sales_receipt */
  type: string;
  id: string;
  customerId: string | null;
  customerName: string;
  number: string | null;
  date: string;
  dueDate: string | null;
  /** Document amount. */
  amount: string;
  /** What is still open (unbilled / unpaid); for paid rows, the amount received. */
  openBalance: string;
  status: string;
  /** Days past due (overdue rows only). */
  daysOverdue: number | null;
}

export interface IncomeTracker {
  asOf: string;
  totals: Record<TrackerBucket, { amount: string; count: number }>;
  rows: TrackerRow[];
}

/**
 * The Income Tracker AS OF a day (default today). Every bucket is rebuilt for that day, the way
 * QuickBooks' as-of reports are:
 *  - documents dated after the day are left out;
 *  - estimates / sales orders / billable time count as unbilled if they had not been invoiced by
 *    then (invoices dated later are added back);
 *  - open invoices use their balance as of the day — the same reconstruction as A/R Aging Detail
 *    (payments dated later and General Journal credits applied later had not reduced them yet) —
 *    and are overdue when past due on that day;
 *  - paid = payments and sales receipts in the 30 days up to the day (a check that bounced after
 *    the day still counts; it had been received).
 */
export async function incomeTracker(
  ctx: ServiceContext,
  opts?: { asOf?: Date; customerId?: string },
): Promise<IncomeTracker> {
  const asOf = opts?.asOf ?? new Date();
  const today = startOfDay(asOf);
  /** Last instant of the as-of day: anything dated that day counts. */
  const cutoff = new Date(today.getTime() + DAY_MS - 1);
  const rows: TrackerRow[] = [];
  const custFilter = opts?.customerId;
  const nonVoidInvoice = ne(invoices.status, 'void');

  // --- Unbilled: estimates ---
  const estConds = [
    eq(estimates.companyId, ctx.companyId),
    // 'closed' estimates were invoiced (or closed) — only shown when that happened after the day.
    inArray(estimates.status, ['draft', 'accepted', 'partial', 'open', 'closed']),
    lte(estimates.date, cutoff),
  ];
  if (custFilter) estConds.push(eq(estimates.customerId, custFilter));
  const ests = await ctx.db
    .select({ id: estimates.id, customerId: estimates.customerId, num: estimates.estimateNumber, ref: estimates.refNumber, date: estimates.date, exp: estimates.expirationDate, total: estimates.total, invoiced: estimates.amountInvoiced, status: estimates.status, convertedInvoiceId: estimates.convertedInvoiceId })
    .from(estimates)
    .where(and(...estConds));
  // Amounts billed from each estimate by invoices dated AFTER the day (not yet billed on it).
  const estBilledLater = new Map<string, ReturnType<typeof Money.zero>>();
  const convertedLater = new Set<string>();
  if (ests.length > 0) {
    for (const r of await ctx.db
      .select({
        estimateId: estimateLines.estimateId,
        amount: sql<string>`COALESCE(SUM(CAST(${invoiceLines.amount} AS NUMERIC)), 0)`,
      })
      .from(invoiceLines)
      .innerJoin(estimateLines, eq(estimateLines.id, invoiceLines.estimateLineId))
      .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
      .where(
        and(
          eq(invoices.companyId, ctx.companyId),
          nonVoidInvoice,
          gt(invoices.date, cutoff),
          inArray(estimateLines.estimateId, ests.map((e) => e.id)),
        ),
      )
      .groupBy(estimateLines.estimateId)) {
      estBilledLater.set(r.estimateId, Money.of(r.amount));
    }
    const convIds = ests.map((e) => e.convertedInvoiceId).filter((x): x is string => !!x);
    if (convIds.length > 0) {
      const later = new Set(
        (
          await ctx.db
            .select({ id: invoices.id })
            .from(invoices)
            .where(and(eq(invoices.companyId, ctx.companyId), inArray(invoices.id, convIds), gt(invoices.date, cutoff)))
        ).map((r) => r.id),
      );
      for (const e of ests) if (e.convertedInvoiceId && later.has(e.convertedInvoiceId)) convertedLater.add(e.id);
    }
  }
  for (const e of ests) {
    const later = estBilledLater.get(e.id) ?? Money.zero();
    let invoicedAsOf = Money.of(e.invoiced ?? '0').minus(later);
    if (invoicedAsOf.lessThan(0)) invoicedAsOf = Money.zero();
    // A whole-estimate conversion dated after the day: nothing of it was billed yet.
    if (convertedLater.has(e.id) && later.isZero()) invoicedAsOf = Money.zero();
    if (e.status === 'closed' && later.isZero() && !convertedLater.has(e.id)) continue; // closed by the day
    const open = Money.round2(Money.of(e.total).minus(invoicedAsOf));
    if (!open.greaterThan(0)) continue;
    const status = e.status === 'closed' ? (invoicedAsOf.greaterThan(0) ? 'partial' : 'open') : e.status;
    rows.push({
      bucket: 'unbilled', type: 'estimate', id: e.id, customerId: e.customerId, customerName: '',
      number: docRef(e.ref, e.num), date: iso(e.date)!, dueDate: iso(e.exp), amount: toAmountString(e.total),
      openBalance: toAmountString(open), status, daysOverdue: null,
    });
  }

  // --- Unbilled: sales orders (uninvoiced quantity x rate, as of the day) ---
  const soConds = [
    eq(salesOrders.companyId, ctx.companyId),
    inArray(salesOrders.status, ['open', 'partial', 'closed']),
    lte(salesOrders.date, cutoff),
  ];
  if (custFilter) soConds.push(eq(salesOrders.customerId, custFilter));
  const sos = await ctx.db
    .select({ id: salesOrders.id, customerId: salesOrders.customerId, num: salesOrders.orderNumber, ref: salesOrders.refNumber, date: salesOrders.date, total: salesOrders.total, status: salesOrders.status })
    .from(salesOrders)
    .where(and(...soConds));
  if (sos.length > 0) {
    const lines = await ctx.db
      .select({ id: salesOrderLines.id, soId: salesOrderLines.salesOrderId, qty: salesOrderLines.quantity, inv: salesOrderLines.quantityInvoiced, rate: salesOrderLines.rate })
      .from(salesOrderLines)
      .where(inArray(salesOrderLines.salesOrderId, sos.map((s) => s.id)));
    // Quantities pulled onto invoices dated after the day were still unbilled on it. Each
    // conversion records its invoice and per-line quantities (salesOrders.convertToInvoice audit).
    const qtyLater = await salesOrderQtyInvoicedAfter(ctx, sos.map((s) => s.id), cutoff);
    const openBy = new Map<string, ReturnType<typeof Money.zero>>();
    const addedBack = new Set<string>();
    for (const l of lines) {
      const back = qtyLater.get(l.id) ?? Money.zero();
      if (back.greaterThan(0)) addedBack.add(l.soId);
      let invoicedAsOf = Money.of(l.inv ?? '0').minus(back);
      if (invoicedAsOf.lessThan(0)) invoicedAsOf = Money.zero();
      const remaining = Money.of(l.qty).minus(invoicedAsOf);
      if (!remaining.greaterThan(0)) continue;
      openBy.set(l.soId, (openBy.get(l.soId) ?? Money.zero()).plus(Money.round2(Money.mul(remaining, l.rate))));
    }
    for (const s of sos) {
      if (s.status === 'closed' && !addedBack.has(s.id)) continue; // fully invoiced by the day
      const open = openBy.get(s.id) ?? Money.zero();
      if (!open.greaterThan(0)) continue;
      rows.push({
        bucket: 'unbilled', type: 'sales_order', id: s.id, customerId: s.customerId, customerName: '',
        number: docRef(s.ref, s.num), date: iso(s.date)!, dueDate: null, amount: toAmountString(s.total),
        openBalance: toAmountString(Money.round2(open)), status: s.status === 'closed' ? 'partial' : s.status, daysOverdue: null,
      });
    }
  }

  // --- Unbilled: billable time not yet invoiced on the day ---
  const billedInv = alias(invoices, 'billed_inv');
  const teConds = [
    eq(timeEntries.companyId, ctx.companyId),
    eq(timeEntries.billable, true),
    sql`${timeEntries.customerId} IS NOT NULL`,
    lte(timeEntries.date, cutoff),
    or(isNull(timeEntries.invoicedInvoiceId), gt(billedInv.date, cutoff), eq(billedInv.status, 'void'))!,
  ];
  if (custFilter) teConds.push(eq(timeEntries.customerId, custFilter));
  for (const t of await ctx.db
    .select({ id: timeEntries.id, customerId: timeEntries.customerId, date: timeEntries.date, hours: timeEntries.hours, rate: timeEntries.rate, description: timeEntries.description })
    .from(timeEntries)
    .leftJoin(billedInv, eq(billedInv.id, timeEntries.invoicedInvoiceId))
    .where(and(...teConds))) {
    const amount = Money.round2(Money.mul(t.hours, t.rate ?? 0));
    rows.push({
      bucket: 'unbilled', type: 'time', id: t.id, customerId: t.customerId, customerName: '',
      number: null, date: iso(t.date)!, dueDate: null, amount: toAmountString(amount),
      openBalance: toAmountString(amount), status: `${Money.of(t.hours).toFixed(2)} h`, daysOverdue: null,
    });
  }

  // --- Unpaid / Overdue: invoices open on the day (balance as of the day, as A/R Aging Detail) ---
  const agingRows = (await arAgingDetail(ctx, cutoff)).rows.filter(
    (r) => r.docType === 'invoice' && (!custFilter || r.entityId === custFilter),
  );
  if (agingRows.length > 0) {
    const info = new Map(
      (
        await ctx.db
          .select({ id: invoices.id, num: invoices.invoiceNumber, ref: invoices.refNumber, date: invoices.date, due: invoices.dueDate, total: invoices.total, retainage: invoices.retainageAmount, sc: invoices.isStatementCharge })
          .from(invoices)
          .where(and(eq(invoices.companyId, ctx.companyId), inArray(invoices.id, agingRows.map((r) => r.docId))))
      ).map((i) => [i.id, i]),
    );
    for (const a of agingRows) {
      const i = info.get(a.docId);
      if (!i) continue;
      const due = i.due ?? i.date;
      const daysOverdue = Math.floor((today.getTime() - startOfDay(due).getTime()) / DAY_MS);
      const overdue = daysOverdue > 0;
      const billed = Money.of(i.total).minus(Money.of(i.retainage ?? '0'));
      // openBalance is home currency; a foreign invoice compares its foreign open amount with its
      // (foreign) billed total.
      const openInDocCurrency = Money.of(a.foreignOpenBalance ?? a.openBalance);
      const status = overdue ? 'overdue' : openInDocCurrency.lessThan(billed) ? 'partial' : 'open';
      rows.push({
        bucket: overdue ? 'overdue' : 'unpaid', type: i.sc ? 'statement_charge' : 'invoice', id: i.id,
        customerId: a.entityId, customerName: '', number: docRef(i.ref, i.num), date: iso(i.date)!, dueDate: iso(due),
        amount: toAmountString(i.total), openBalance: toAmountString(a.openBalance), status,
        daysOverdue: overdue ? daysOverdue : null,
      });
    }
  }

  // --- Paid in the last 30 days ---
  // The 30 days up to and including asOf (nothing received after asOf counts).
  const since = new Date(today.getTime() - 30 * DAY_MS);
  const until = new Date(today.getTime() + DAY_MS);
  const payConds = [
    eq(paymentsReceived.companyId, ctx.companyId),
    isNull(paymentsReceived.voidedAt),
    // A check that bounced after the day had still been received on it.
    or(isNull(paymentsReceived.bouncedAt), gt(paymentsReceived.bouncedAt, cutoff))!,
    gte(paymentsReceived.date, since),
    lt(paymentsReceived.date, until),
  ];
  if (custFilter) payConds.push(eq(paymentsReceived.customerId, custFilter));
  for (const p of await ctx.db
    .select({ id: paymentsReceived.id, customerId: paymentsReceived.customerId, ref: paymentsReceived.reference, date: paymentsReceived.date, amount: paymentsReceived.amount, method: paymentsReceived.method, rate: paymentsReceived.exchangeRate })
    .from(paymentsReceived)
    .where(and(...payConds))) {
    if (!Money.of(p.amount).greaterThan(0)) continue;
    // Like invoice rows: amount in the payment's currency, openBalance (summed into the bar) in home.
    const home = p.rate && !Money.eq(Money.of(p.rate), 1) ? Money.round2(Money.of(p.amount).times(Money.of(p.rate))) : Money.of(p.amount);
    rows.push({
      bucket: 'paid', type: 'payment', id: p.id, customerId: p.customerId, customerName: '', number: p.ref,
      date: iso(p.date)!, dueDate: null, amount: toAmountString(p.amount), openBalance: toAmountString(home),
      status: p.method, daysOverdue: null,
    });
  }
  const srConds = [eq(salesReceipts.companyId, ctx.companyId), ne(salesReceipts.status, 'void'), gte(salesReceipts.date, since), lt(salesReceipts.date, until)];
  if (custFilter) srConds.push(eq(salesReceipts.customerId, custFilter));
  for (const r of await ctx.db
    .select({ id: salesReceipts.id, customerId: salesReceipts.customerId, num: salesReceipts.receiptNumber, ref: salesReceipts.refNumber, date: salesReceipts.date, total: salesReceipts.total, method: salesReceipts.method })
    .from(salesReceipts)
    .where(and(...srConds))) {
    rows.push({
      bucket: 'paid', type: 'sales_receipt', id: r.id, customerId: r.customerId, customerName: '', number: docRef(r.ref, r.num),
      date: iso(r.date)!, dueDate: null, amount: toAmountString(r.total), openBalance: toAmountString(r.total),
      status: r.method, daysOverdue: null,
    });
  }

  // Customer names.
  const ids = [...new Set(rows.map((r) => r.customerId).filter(Boolean) as string[])];
  if (ids.length > 0) {
    const custs = await ctx.db
      .select({ id: customers.id, name: customers.displayName })
      .from(customers)
      .where(and(eq(customers.companyId, ctx.companyId), inArray(customers.id, ids)));
    const byId = new Map(custs.map((c) => [c.id, c.name]));
    for (const r of rows) r.customerName = r.customerId ? (byId.get(r.customerId) ?? 'Customer') : 'Walk-in customer';
  } else {
    for (const r of rows) r.customerName = 'Walk-in customer';
  }

  const totals = {} as IncomeTracker['totals'];
  for (const b of ['unbilled', 'unpaid', 'overdue', 'paid'] as const) {
    const inB = rows.filter((r) => r.bucket === b);
    totals[b] = {
      amount: toAmountString(inB.reduce((s, r) => s.plus(Money.of(r.openBalance)), Money.zero())),
      count: inB.length,
    };
  }
  rows.sort((a, b) => b.date.localeCompare(a.date));
  return { asOf: iso(today)!, totals, rows };
}

/**
 * Sales-order line quantities pulled onto (non-void) invoices dated AFTER `cutoff`, per line.
 * salesOrders.convertToInvoice records each conversion's invoice and per-line quantities in the
 * audit trail (`invoiceId`, `invoicedQuantities`), which is the only dated link from an order
 * line to the invoice that billed it.
 */
async function salesOrderQtyInvoicedAfter(
  ctx: ServiceContext,
  orderIds: string[],
  cutoff: Date,
): Promise<Map<string, ReturnType<typeof Money.zero>>> {
  const out = new Map<string, ReturnType<typeof Money.zero>>();
  if (orderIds.length === 0) return out;
  const logs = await ctx.db
    .select({ newValues: auditLogs.newValues })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.companyId, ctx.companyId),
        eq(auditLogs.entityType, 'sales_order'),
        inArray(auditLogs.entityId, orderIds),
        sql`${auditLogs.newValues} ->> 'invoiceId' IS NOT NULL`,
      ),
    );
  const conv: Array<{ invoiceId: string; lines: Array<{ lineId: string; quantity: string }> }> = [];
  for (const l of logs) {
    const v = (l.newValues ?? {}) as { invoiceId?: unknown; invoicedQuantities?: unknown };
    if (typeof v.invoiceId !== 'string' || !Array.isArray(v.invoicedQuantities)) continue;
    const lines = (v.invoicedQuantities as Array<{ lineId?: unknown; quantity?: unknown }>)
      .filter((q) => typeof q.lineId === 'string' && q.quantity !== undefined)
      .map((q) => ({ lineId: q.lineId as string, quantity: String(q.quantity) }));
    conv.push({ invoiceId: v.invoiceId, lines });
  }
  if (conv.length === 0) return out;
  const later = new Set(
    (
      await ctx.db
        .select({ id: invoices.id })
        .from(invoices)
        .where(
          and(
            eq(invoices.companyId, ctx.companyId),
            inArray(invoices.id, [...new Set(conv.map((c) => c.invoiceId))]),
            gt(invoices.date, cutoff),
            ne(invoices.status, 'void'),
          ),
        )
    ).map((r) => r.id),
  );
  for (const c of conv) {
    if (!later.has(c.invoiceId)) continue;
    for (const q of c.lines) out.set(q.lineId, (out.get(q.lineId) ?? Money.zero()).plus(Money.of(q.quantity)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Income Tracker batch actions
// ---------------------------------------------------------------------------

export type TrackerAction = 'email' | 'queue_print' | 'queue_email' | 'convert';

export interface TrackerActionResult {
  done: Array<{ type: string; id: string; detail?: string }>;
  failed: Array<{ type: string; id: string; error: string }>;
}

const FORM_OF: Record<string, SalesFormKind | undefined> = {
  invoice: 'invoice',
  statement_charge: 'invoice',
  estimate: 'estimate',
  sales_order: 'sales_order',
  sales_receipt: 'sales_receipt',
};

/**
 * Run a batch action on Income Tracker rows. Each row is handled on its own (one failure is
 * reported, the rest still run). 'convert' turns estimates / sales orders into invoices.
 */
export async function runTrackerAction(
  ctx: ServiceContext,
  action: TrackerAction,
  items: Array<{ type: string; id: string }>,
  opts?: { overrideCreditLimit?: boolean },
): Promise<TrackerActionResult> {
  if (items.length === 0) throw validation('Select at least one row.');
  const result: TrackerActionResult = { done: [], failed: [] };
  if (action === 'email') {
    const forms = items.filter((i) => FORM_OF[i.type]).map((i) => ({ kind: FORM_OF[i.type]!, id: i.id }));
    for (const i of items) if (!FORM_OF[i.type]) result.failed.push({ ...i, error: 'This kind of row cannot be emailed.' });
    const r = await sendQueuedEmails(ctx, forms);
    for (const s of r.sent) result.done.push({ type: s.kind, id: s.id, detail: `Emailed to ${s.to}` });
    for (const f of r.failed) result.failed.push({ type: f.kind, id: f.id, error: f.error });
    return result;
  }
  for (const it of items) {
    try {
      if (action === 'queue_print' || action === 'queue_email') {
        const kind = FORM_OF[it.type];
        if (!kind) throw validation('This kind of row has no printable form.');
        await setSendFlags(ctx, kind, it.id, action === 'queue_print' ? { toBePrinted: true } : { toBeEmailed: true });
        result.done.push({ ...it });
      } else if (action === 'convert') {
        if (it.type === 'estimate') {
          const inv = await convertEstimate(ctx, it.id, { overrideCreditLimit: opts?.overrideCreditLimit });
          result.done.push({ ...it, detail: `Invoice #${docRef(inv.refNumber, inv.invoiceNumber)}` });
        } else if (it.type === 'sales_order') {
          const inv = await convertSalesOrder(ctx, it.id, { overrideCreditLimit: opts?.overrideCreditLimit });
          result.done.push({ ...it, detail: `Invoice #${docRef(inv.refNumber, inv.invoiceNumber)}` });
        } else {
          throw validation('Only estimates and sales orders can be turned into invoices.');
        }
      } else {
        throw validation(`Unknown action "${String(action)}".`);
      }
    } catch (err) {
      if (err instanceof ServiceError && err.code === 'FORBIDDEN') throw err;
      if (!(err instanceof ServiceError)) throw err;
      result.failed.push({ ...it, error: err.message });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Collections Center
// ---------------------------------------------------------------------------

export interface CollectionsInvoice {
  id: string;
  number: number;
  date: string;
  dueDate: string;
  balanceDue: string;
  /** > 0 overdue by N days; <= 0 due in |N| days. */
  daysPastDue: number;
  isStatementCharge: boolean;
}

export interface CollectionsCustomer {
  customerId: string;
  customerName: string;
  email: string | null;
  phone: string | null;
  totalDue: string;
  invoices: CollectionsInvoice[];
  lastNote: { note: string; createdAt: string; followUpDate: string | null } | null;
  nextFollowUp: string | null;
}

export interface CollectionsCenter {
  asOf: string;
  almostDueDays: number;
  overdue: CollectionsCustomer[];
  almostDue: CollectionsCustomer[];
}

export async function collectionsCenter(
  ctx: ServiceContext,
  opts?: { asOf?: Date; almostDueDays?: number },
): Promise<CollectionsCenter> {
  const today = startOfDay(opts?.asOf ?? new Date());
  const almostDueDays = Math.max(1, Math.min(90, opts?.almostDueDays ?? 7));
  const inv = await ctx.db
    .select({
      id: invoices.id, customerId: invoices.customerId, num: invoices.invoiceNumber, ref: invoices.refNumber, date: invoices.date,
      due: invoices.dueDate, bal: invoices.balanceDue, sc: invoices.isStatementCharge,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.companyId, ctx.companyId),
        inArray(invoices.status, ['open', 'partial', 'overdue']),
        sql`CAST(${invoices.balanceDue} AS NUMERIC) > 0`,
      ),
    )
    .orderBy(asc(invoices.dueDate));

  const overdue = new Map<string, CollectionsInvoice[]>();
  const almost = new Map<string, CollectionsInvoice[]>();
  for (const i of inv) {
    const due = startOfDay(i.due ?? i.date);
    const days = Math.floor((today.getTime() - due.getTime()) / DAY_MS);
    const row: CollectionsInvoice = {
      id: i.id, number: i.num, date: iso(i.date)!, dueDate: iso(due)!, balanceDue: toAmountString(i.bal),
      daysPastDue: days, isStatementCharge: i.sc,
    };
    if (days > 0) overdue.set(i.customerId, [...(overdue.get(i.customerId) ?? []), row]);
    else if (-days <= almostDueDays) almost.set(i.customerId, [...(almost.get(i.customerId) ?? []), row]);
  }
  const ids = [...new Set([...overdue.keys(), ...almost.keys()])];
  const custs = ids.length
    ? await ctx.db
        .select({ id: customers.id, name: customers.displayName, email: customers.email, phone: customers.phone })
        .from(customers)
        .where(and(eq(customers.companyId, ctx.companyId), inArray(customers.id, ids)))
    : [];
  const custBy = new Map(custs.map((c) => [c.id, c]));
  const notes = ids.length
    ? await ctx.db
        .select()
        .from(collectionNotes)
        .where(and(eq(collectionNotes.companyId, ctx.companyId), inArray(collectionNotes.customerId, ids)))
        .orderBy(desc(collectionNotes.createdAt))
    : [];

  const build = (m: Map<string, CollectionsInvoice[]>): CollectionsCustomer[] =>
    [...m.entries()]
      .map(([cid, list]) => {
        const c = custBy.get(cid);
        const mine = notes.filter((n) => n.customerId === cid);
        const open = mine.filter((n) => !n.done && n.followUpDate).map((n) => n.followUpDate!.getTime());
        return {
          customerId: cid,
          customerName: c?.name ?? 'Customer',
          email: c?.email ?? null,
          phone: c?.phone ?? null,
          totalDue: toAmountString(list.reduce((s, i) => s.plus(Money.of(i.balanceDue)), Money.zero())),
          invoices: list,
          lastNote: mine[0]
            ? { note: mine[0].note, createdAt: mine[0].createdAt.toISOString(), followUpDate: iso(mine[0].followUpDate) }
            : null,
          nextFollowUp: open.length ? iso(new Date(Math.min(...open))) : null,
        };
      })
      .sort((a, b) => Number(b.totalDue) - Number(a.totalDue));

  return { asOf: iso(today)!, almostDueDays, overdue: build(overdue), almostDue: build(almost) };
}

export interface CollectionNoteInput {
  customerId: string;
  invoiceId?: string | null;
  note: string;
  followUpDate?: Date | null;
}

export async function listCollectionNotes(ctx: ServiceContext, customerId: string) {
  return ctx.db
    .select()
    .from(collectionNotes)
    .where(and(eq(collectionNotes.companyId, ctx.companyId), eq(collectionNotes.customerId, customerId)))
    .orderBy(desc(collectionNotes.createdAt));
}

export async function addCollectionNote(ctx: ServiceContext, input: CollectionNoteInput) {
  const text = input.note?.trim();
  if (!text) throw validation('Type a note first.');
  if (text.length > 4000) throw validation('Notes are limited to 4,000 characters.');
  const [cust] = await ctx.db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, input.customerId)));
  if (!cust) throw notFound('Customer');
  if (input.invoiceId) {
    const [i] = await ctx.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(eq(invoices.companyId, ctx.companyId), eq(invoices.id, input.invoiceId), eq(invoices.customerId, input.customerId)));
    if (!i) throw notFound('Invoice');
  }
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .insert(collectionNotes)
      .values({
        companyId: tx.companyId,
        customerId: input.customerId,
        invoiceId: input.invoiceId ?? null,
        note: text,
        followUpDate: input.followUpDate ?? null,
        createdBy: tx.userId,
      })
      .returning();
    await writeAudit(tx, { action: 'create', entityType: 'collection_note', entityId: row.id, newValues: row });
    return row;
  });
}

export async function setCollectionNoteDone(ctx: ServiceContext, id: string, done: boolean) {
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .update(collectionNotes)
      .set({ done })
      .where(and(eq(collectionNotes.companyId, tx.companyId), eq(collectionNotes.id, id)))
      .returning();
    if (!row) throw notFound('Collection note');
    await writeAudit(tx, { action: 'update', entityType: 'collection_note', entityId: id, newValues: { done } });
    return row;
  });
}
