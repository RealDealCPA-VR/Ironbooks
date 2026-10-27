/**
 * Linked transactions — QB "Transaction History" (Ctrl+H) view.
 *
 * Given a document (type + id) or a journal entry, walk the relationship graph
 * and return a typed tree (root + children + grandchildren, 2 levels deep):
 *
 *   invoice   -> estimate / sales order source, payments applied (each with the
 *                deposit that banked it), credit memos applied, COGS entries.
 *   bill      -> PO source, item receipt, bill payments, vendor credits applied.
 *   payment   -> invoices it paid, the deposit that banked it.
 *   deposit   -> payments it contains (each with the invoices they paid).
 *   paycheck  -> its pay run.
 *   expense   -> nothing much (standalone check).
 *
 * Manual journal entries get reversal/replacement links: entries posted with
 * sourceRef 'reversal:<id>' and audit-log old->new edges written by
 * journal.updateEntry (newValues.replacedBy).
 *
 * Relationship sources:
 *  - payment_applications / bill_payment_applications (first-class tables).
 *  - estimates/salesOrders.convertedInvoiceId, purchaseOrders/itemReceipts.convertedBillId.
 *  - deposit_lines.paymentId.
 *  - credit-memo applications: credit_applications rows (an undone application deletes its row),
 *    plus pre-wave2 applications recorded only in audit_logs jsonb.
 *  - vendor-credit applications are only recorded in audit_logs
 *    (vendorCredits.applyToBill writes no link row), so those edges are read from audit_logs jsonb.
 */
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  auditLogs,
  billPaymentApplications,
  billPayments,
  bills,
  creditApplications,
  creditMemos,
  depositLines,
  deposits,
  estimateLines,
  estimates,
  expenses,
  invoiceLines,
  invoices,
  itemReceipts,
  journalEntries,
  journalEntryLines,
  payRuns,
  paychecks,
  paymentApplications,
  paymentsReceived,
  purchaseOrders,
  salesOrders,
  salesReceipts,
  vendorCredits,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { notFound, type ServiceContext } from './_base';
import { docRef } from './docNumbers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LinkedKind =
  | 'invoice'
  | 'estimate'
  | 'sales_order'
  | 'payment'
  | 'credit_memo'
  | 'cogs'
  | 'deposit'
  | 'bill'
  | 'purchase_order'
  | 'item_receipt'
  | 'bill_payment'
  | 'vendor_credit'
  | 'expense'
  | 'sales_receipt'
  | 'paycheck'
  | 'pay_run'
  | 'journal_entry';

/** One node in the linked-transactions tree. */
export interface LinkedTransaction {
  kind: LinkedKind;
  id: string;
  label: string;
  /** ISO date string. */
  date: string;
  /** Decimal string ('123.45'). */
  amount: string;
  /** Page that hosts the document (QuickZoom target). */
  route: string;
  children?: LinkedTransaction[];
}

/** Document kinds buildLinkedTree accepts as a root. */
export type LinkedRootKind =
  | 'invoice'
  | 'bill'
  | 'payment'
  | 'bill_payment'
  | 'credit_memo'
  | 'vendor_credit'
  | 'deposit'
  | 'paycheck'
  | 'expense'
  | 'sales_receipt'
  | 'item_receipt';

/** kind -> list page (matches EntryDetailModal SOURCE_ROUTES). */
const ROUTES: Record<LinkedKind, string> = {
  invoice: '/invoices',
  estimate: '/estimates',
  sales_order: '/sales-orders',
  payment: '/payments',
  credit_memo: '/credit-memos',
  cogs: '/transactions',
  deposit: '/deposits',
  bill: '/bills',
  purchase_order: '/purchase-orders',
  item_receipt: '/bills',
  bill_payment: '/pay-bills',
  vendor_credit: '/vendor-credits',
  expense: '/expenses',
  sales_receipt: '/sales-receipts',
  paycheck: '/pay-stubs',
  pay_run: '/pay-stubs',
  journal_entry: '/transactions',
};

function node(
  kind: LinkedKind,
  id: string,
  label: string,
  date: Date | string,
  amount: string | number,
  children?: LinkedTransaction[],
): LinkedTransaction {
  return {
    kind,
    id,
    label,
    date: date instanceof Date ? date.toISOString() : new Date(date).toISOString(),
    amount: toAmountString(Money.round2(amount)),
    route: ROUTES[kind],
    ...(children && children.length > 0 ? { children } : {}),
  };
}

// ---------------------------------------------------------------------------
// Per-edge helpers (each returns child nodes, possibly with grandchildren)
// ---------------------------------------------------------------------------

/** Sum of debit lines on a journal entry (its "total"). */
async function entryTotal(ctx: ServiceContext, entryId: string): Promise<string> {
  const [row] = await ctx.db
    .select({ total: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)` })
    .from(journalEntryLines)
    .where(eq(journalEntryLines.journalEntryId, entryId));
  return toAmountString(Money.round2(row?.total ?? '0'));
}

function paymentLabel(p: { reference: string | null; method: string }): string {
  return p.reference ? `Payment ${p.reference}` : `Payment (${p.method})`;
}

/** Deposit(s) that banked a payment (depositLines.paymentId), voided excluded. */
async function depositsForPayment(
  ctx: ServiceContext,
  paymentId: string,
): Promise<LinkedTransaction[]> {
  const rows = await ctx.db
    .select({ id: deposits.id, date: deposits.date, total: deposits.total })
    .from(depositLines)
    .innerJoin(deposits, eq(depositLines.depositId, deposits.id))
    .where(
      and(
        eq(deposits.companyId, ctx.companyId),
        eq(depositLines.paymentId, paymentId),
        isNull(deposits.voidedAt),
      ),
    );
  return rows.map((d) => node('deposit', d.id, 'Deposit', d.date, d.total));
}

/** Invoices a payment was applied to (payment_applications). */
async function invoicesForPayment(
  ctx: ServiceContext,
  paymentId: string,
): Promise<LinkedTransaction[]> {
  const rows = await ctx.db
    .select({
      id: invoices.id,
      number: sql<string>`COALESCE(NULLIF(${invoices.refNumber}, ''), CAST(${invoices.invoiceNumber} AS TEXT))`,
      date: invoices.date,
      applied: paymentApplications.amountApplied,
    })
    .from(paymentApplications)
    .innerJoin(invoices, eq(paymentApplications.invoiceId, invoices.id))
    .where(and(eq(invoices.companyId, ctx.companyId), eq(paymentApplications.paymentId, paymentId)));
  return rows.map((r) => node('invoice', r.id, `Invoice #${r.number}`, r.date, r.applied));
}

/** Payments applied to an invoice, each carrying its banking deposit as a grandchild. */
async function paymentsForInvoice(
  ctx: ServiceContext,
  invoiceId: string,
): Promise<LinkedTransaction[]> {
  const rows = await ctx.db
    .select({
      id: paymentsReceived.id,
      date: paymentsReceived.date,
      reference: paymentsReceived.reference,
      method: paymentsReceived.method,
      applied: paymentApplications.amountApplied,
    })
    .from(paymentApplications)
    .innerJoin(paymentsReceived, eq(paymentApplications.paymentId, paymentsReceived.id))
    .where(
      and(
        eq(paymentsReceived.companyId, ctx.companyId),
        eq(paymentApplications.invoiceId, invoiceId),
        isNull(paymentsReceived.voidedAt),
      ),
    );
  const out: LinkedTransaction[] = [];
  for (const p of rows) {
    const children = await depositsForPayment(ctx, p.id);
    out.push(node('payment', p.id, paymentLabel(p), p.date, p.applied, children));
  }
  return out;
}

/**
 * Credit applications still in place, as (memo, invoice, amount) edges: the credit_applications
 * rows (wave2 sales — an undone application deletes its row), plus applications recorded before
 * that table existed, which live only in the audit trail (an apply row without a
 * creditApplicationId). Reading every audit apply row listed credits that were unapplied since,
 * e.g. by voiding the payment they were applied with.
 */
async function creditApplicationEdges(
  ctx: ServiceContext,
  by: { invoiceId?: string; creditMemoId?: string },
): Promise<Array<{ memoId: string; invoiceId: string; amount: ReturnType<typeof Money.zero> }>> {
  const out: Array<{ memoId: string; invoiceId: string; amount: ReturnType<typeof Money.zero> }> = [];
  const rows = await ctx.db
    .select({
      memoId: creditApplications.creditMemoId,
      invoiceId: creditApplications.invoiceId,
      amount: sql<string>`COALESCE(SUM(CAST(${creditApplications.amount} AS NUMERIC)), 0)`,
    })
    .from(creditApplications)
    .where(
      and(
        eq(creditApplications.companyId, ctx.companyId),
        by.invoiceId ? eq(creditApplications.invoiceId, by.invoiceId) : undefined,
        by.creditMemoId ? eq(creditApplications.creditMemoId, by.creditMemoId) : undefined,
      ),
    )
    .groupBy(creditApplications.creditMemoId, creditApplications.invoiceId);
  for (const r of rows) out.push({ memoId: r.memoId, invoiceId: r.invoiceId, amount: Money.of(r.amount) });

  const legacy = await ctx.db
    .select({ entityId: auditLogs.entityId, newValues: auditLogs.newValues })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.companyId, ctx.companyId),
        eq(auditLogs.entityType, 'credit_memo'),
        by.creditMemoId ? eq(auditLogs.entityId, by.creditMemoId) : undefined,
        by.invoiceId
          ? sql`${auditLogs.newValues}->>'appliedToInvoice' = ${by.invoiceId}`
          : sql`${auditLogs.newValues}->>'appliedToInvoice' IS NOT NULL`,
        sql`${auditLogs.newValues}->>'creditApplicationId' IS NULL`,
      ),
    );
  for (const r of legacy) {
    const nv = (r.newValues ?? {}) as { appliedToInvoice?: string; amountApplied?: string };
    if (!nv.appliedToInvoice) continue;
    const same = out.find((e) => e.memoId === r.entityId && e.invoiceId === nv.appliedToInvoice);
    if (same) same.amount = same.amount.plus(Money.of(nv.amountApplied ?? '0'));
    else out.push({ memoId: r.entityId, invoiceId: nv.appliedToInvoice, amount: Money.of(nv.amountApplied ?? '0') });
  }
  return out.filter((e) => e.amount.greaterThan(0));
}

/** Credit memos applied to an invoice (applications still in place), aggregated per memo. */
async function creditMemosForInvoice(
  ctx: ServiceContext,
  invoiceId: string,
): Promise<LinkedTransaction[]> {
  const edges = await creditApplicationEdges(ctx, { invoiceId });
  if (edges.length === 0) return [];

  // Aggregate applied amounts per memo.
  const appliedByMemo = new Map<string, ReturnType<typeof Money.zero>>();
  for (const e of edges) {
    appliedByMemo.set(e.memoId, (appliedByMemo.get(e.memoId) ?? Money.zero()).plus(e.amount));
  }

  const out: LinkedTransaction[] = [];
  for (const [memoId, applied] of appliedByMemo) {
    const [memo] = await ctx.db
      .select({ id: creditMemos.id, number: sql<string>`COALESCE(NULLIF(${creditMemos.refNumber}, ''), CAST(${creditMemos.memoNumber} AS TEXT))`, date: creditMemos.date })
      .from(creditMemos)
      .where(and(eq(creditMemos.companyId, ctx.companyId), eq(creditMemos.id, memoId)));
    if (!memo) continue;
    out.push(node('credit_memo', memo.id, `Credit Memo #${memo.number}`, memo.date, toAmountString(applied)));
  }
  return out;
}

/** Vendor credits applied to a bill (audit_logs edges from vendorCredits.applyToBill). */
async function vendorCreditsForBill(
  ctx: ServiceContext,
  billId: string,
): Promise<LinkedTransaction[]> {
  const rows = await ctx.db
    .select({ entityId: auditLogs.entityId, newValues: auditLogs.newValues })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.companyId, ctx.companyId),
        eq(auditLogs.entityType, 'vendor_credit'),
        sql`${auditLogs.newValues}->>'billId' = ${billId}`,
        sql`${auditLogs.newValues}->>'action' = 'applied_to_bill'`,
      ),
    );
  if (rows.length === 0) return [];

  const appliedByCredit = new Map<string, ReturnType<typeof Money.zero>>();
  for (const r of rows) {
    const nv = (r.newValues ?? {}) as { amount?: string };
    const prev = appliedByCredit.get(r.entityId) ?? Money.zero();
    appliedByCredit.set(r.entityId, prev.plus(Money.of(nv.amount ?? '0')));
  }

  const out: LinkedTransaction[] = [];
  for (const [creditId, applied] of appliedByCredit) {
    const [credit] = await ctx.db
      .select({ id: vendorCredits.id, date: vendorCredits.date })
      .from(vendorCredits)
      .where(and(eq(vendorCredits.companyId, ctx.companyId), eq(vendorCredits.id, creditId)));
    if (!credit) continue;
    out.push(node('vendor_credit', credit.id, 'Vendor Credit', credit.date, toAmountString(applied)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-document tree builders
// ---------------------------------------------------------------------------

async function invoiceTree(ctx: ServiceContext, invoiceId: string): Promise<LinkedTransaction> {
  const [inv] = await ctx.db
    .select()
    .from(invoices)
    .where(and(eq(invoices.companyId, ctx.companyId), eq(invoices.id, invoiceId)));
  if (!inv) throw notFound('Invoice');

  const children: LinkedTransaction[] = [];

  // Source documents: estimate(s) and/or sales order(s) this invoice bills. A progress invoice
  // bills estimate lines (invoice_lines.estimate_line_id) and a partial sales-order invoice
  // records its claim in the order's audit trail (salesOrders.convertToInvoice); only the invoice
  // that FINISHED the document is its convertedInvoiceId, so the earlier ones showed no source.
  const ests = await ctx.db
    .select({ id: estimates.id, number: sql<string>`COALESCE(NULLIF(${estimates.refNumber}, ''), CAST(${estimates.estimateNumber} AS TEXT))`, date: estimates.date, total: estimates.total })
    .from(estimates)
    .where(
      and(
        eq(estimates.companyId, ctx.companyId),
        sql`(${estimates.convertedInvoiceId} = ${invoiceId} OR ${estimates.id} IN (
          SELECT ${estimateLines.estimateId} FROM ${estimateLines}
          JOIN ${invoiceLines} ON ${invoiceLines.estimateLineId} = ${estimateLines.id}
          WHERE ${invoiceLines.invoiceId} = ${invoiceId}
        ))`,
      ),
    );
  for (const e of ests) children.push(node('estimate', e.id, `Estimate #${e.number}`, e.date, e.total));

  const sos = await ctx.db
    .select({ id: salesOrders.id, number: sql<string>`COALESCE(NULLIF(${salesOrders.refNumber}, ''), CAST(${salesOrders.orderNumber} AS TEXT))`, date: salesOrders.date, total: salesOrders.total })
    .from(salesOrders)
    .where(
      and(
        eq(salesOrders.companyId, ctx.companyId),
        sql`(${salesOrders.convertedInvoiceId} = ${invoiceId} OR ${salesOrders.id} IN (
          SELECT ${auditLogs.entityId} FROM ${auditLogs}
          WHERE ${auditLogs.companyId} = ${ctx.companyId}
            AND ${auditLogs.entityType} = 'sales_order'
            AND ${auditLogs.newValues}->>'invoiceId' = ${invoiceId}
            AND ${auditLogs.newValues}->'invoicedQuantities' IS NOT NULL
        ))`,
      ),
    );
  for (const s of sos) children.push(node('sales_order', s.id, `Sales Order #${s.number}`, s.date, s.total));

  children.push(...(await paymentsForInvoice(ctx, invoiceId)));
  children.push(...(await creditMemosForInvoice(ctx, invoiceId)));

  // COGS entries posted alongside the invoice (sourceRef 'invoice-cogs:<id>').
  const cogsEntries = await ctx.db
    .select({ id: journalEntries.id, number: journalEntries.entryNumber, date: journalEntries.date })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.sourceRef, `invoice-cogs:${invoiceId}`),
        eq(journalEntries.status, 'posted'),
      ),
    );
  for (const c of cogsEntries) {
    children.push(node('cogs', c.id, `COGS Entry #${c.number}`, c.date, await entryTotal(ctx, c.id)));
  }

  return node('invoice', inv.id, `Invoice #${docRef(inv.refNumber, inv.invoiceNumber)}`, inv.date, inv.total, children);
}

async function billTree(ctx: ServiceContext, billId: string): Promise<LinkedTransaction> {
  const [bill] = await ctx.db
    .select()
    .from(bills)
    .where(and(eq(bills.companyId, ctx.companyId), eq(bills.id, billId)));
  if (!bill) throw notFound('Bill');

  const children: LinkedTransaction[] = [];

  // PO source(s).
  const pos = await ctx.db
    .select({ id: purchaseOrders.id, number: sql<string>`COALESCE(NULLIF(${purchaseOrders.refNumber}, ''), CAST(${purchaseOrders.poNumber} AS TEXT))`, date: purchaseOrders.date, total: purchaseOrders.total })
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.companyId, ctx.companyId), eq(purchaseOrders.convertedBillId, billId)));
  for (const p of pos) children.push(node('purchase_order', p.id, `PO #${p.number}`, p.date, p.total));

  // Item receipt(s) converted into this bill.
  const receipts = await ctx.db
    .select({ id: itemReceipts.id, reference: itemReceipts.reference, date: itemReceipts.date, total: itemReceipts.total })
    .from(itemReceipts)
    .where(and(eq(itemReceipts.companyId, ctx.companyId), eq(itemReceipts.convertedBillId, billId)));
  for (const r of receipts) {
    children.push(
      node('item_receipt', r.id, r.reference ? `Item Receipt ${r.reference}` : 'Item Receipt', r.date, r.total),
    );
  }

  // Bill payments applied.
  const pays = await ctx.db
    .select({
      id: billPayments.id,
      date: billPayments.date,
      reference: billPayments.reference,
      method: billPayments.method,
      applied: billPaymentApplications.amountApplied,
    })
    .from(billPaymentApplications)
    .innerJoin(billPayments, eq(billPaymentApplications.billPaymentId, billPayments.id))
    .where(
      and(
        eq(billPayments.companyId, ctx.companyId),
        eq(billPaymentApplications.billId, billId),
        isNull(billPayments.voidedAt),
      ),
    );
  for (const p of pays) {
    const label = p.reference ? `Bill Payment ${p.reference}` : `Bill Payment (${p.method})`;
    children.push(node('bill_payment', p.id, label, p.date, p.applied));
  }

  children.push(...(await vendorCreditsForBill(ctx, billId)));

  const label = bill.billNumber ? `Bill ${bill.billNumber}` : 'Bill';
  return node('bill', bill.id, label, bill.date, bill.total, children);
}

async function paymentTree(ctx: ServiceContext, paymentId: string): Promise<LinkedTransaction> {
  const [pmt] = await ctx.db
    .select()
    .from(paymentsReceived)
    .where(and(eq(paymentsReceived.companyId, ctx.companyId), eq(paymentsReceived.id, paymentId)));
  if (!pmt) throw notFound('Payment');

  const children = [
    ...(await invoicesForPayment(ctx, paymentId)),
    ...(await depositsForPayment(ctx, paymentId)),
  ];
  return node('payment', pmt.id, paymentLabel(pmt), pmt.date, pmt.amount, children);
}

async function billPaymentTree(ctx: ServiceContext, id: string): Promise<LinkedTransaction> {
  const [pmt] = await ctx.db
    .select()
    .from(billPayments)
    .where(and(eq(billPayments.companyId, ctx.companyId), eq(billPayments.id, id)));
  if (!pmt) throw notFound('Bill payment');

  const rows = await ctx.db
    .select({
      id: bills.id,
      number: bills.billNumber,
      date: bills.date,
      applied: billPaymentApplications.amountApplied,
    })
    .from(billPaymentApplications)
    .innerJoin(bills, eq(billPaymentApplications.billId, bills.id))
    .where(and(eq(bills.companyId, ctx.companyId), eq(billPaymentApplications.billPaymentId, id)));
  const children = rows.map((b) =>
    node('bill', b.id, b.number ? `Bill ${b.number}` : 'Bill', b.date, b.applied),
  );

  const label = pmt.reference ? `Bill Payment ${pmt.reference}` : `Bill Payment (${pmt.method})`;
  return node('bill_payment', pmt.id, label, pmt.date, pmt.amount, children);
}

async function depositTree(ctx: ServiceContext, depositId: string): Promise<LinkedTransaction> {
  const [dep] = await ctx.db
    .select()
    .from(deposits)
    .where(and(eq(deposits.companyId, ctx.companyId), eq(deposits.id, depositId)));
  if (!dep) throw notFound('Deposit');

  const lines = await ctx.db
    .select({
      paymentId: paymentsReceived.id,
      date: paymentsReceived.date,
      reference: paymentsReceived.reference,
      method: paymentsReceived.method,
      amount: depositLines.amount,
    })
    .from(depositLines)
    .innerJoin(paymentsReceived, eq(depositLines.paymentId, paymentsReceived.id))
    .where(eq(depositLines.depositId, depositId));

  const children: LinkedTransaction[] = [];
  for (const l of lines) {
    const grand = await invoicesForPayment(ctx, l.paymentId);
    children.push(node('payment', l.paymentId, paymentLabel(l), l.date, l.amount, grand));
  }
  return node('deposit', dep.id, 'Deposit', dep.date, dep.total, children);
}

async function creditMemoTree(ctx: ServiceContext, memoId: string): Promise<LinkedTransaction> {
  const [memo] = await ctx.db
    .select()
    .from(creditMemos)
    .where(and(eq(creditMemos.companyId, ctx.companyId), eq(creditMemos.id, memoId)));
  if (!memo) throw notFound('Credit memo');

  // Invoices this memo is applied to (applications still in place), with the amount applied.
  const children: LinkedTransaction[] = [];
  const byInvoice = new Map<string, ReturnType<typeof Money.zero>>();
  for (const e of await creditApplicationEdges(ctx, { creditMemoId: memoId })) {
    byInvoice.set(e.invoiceId, (byInvoice.get(e.invoiceId) ?? Money.zero()).plus(e.amount));
  }
  for (const [invoiceId, applied] of byInvoice) {
    const [inv] = await ctx.db
      .select({ id: invoices.id, number: sql<string>`COALESCE(NULLIF(${invoices.refNumber}, ''), CAST(${invoices.invoiceNumber} AS TEXT))`, date: invoices.date })
      .from(invoices)
      .where(and(eq(invoices.companyId, ctx.companyId), eq(invoices.id, invoiceId)));
    if (inv) children.push(node('invoice', inv.id, `Invoice #${inv.number}`, inv.date, toAmountString(applied)));
  }
  return node('credit_memo', memo.id, `Credit Memo #${docRef(memo.refNumber, memo.memoNumber)}`, memo.date, memo.total, children);
}

async function vendorCreditTree(ctx: ServiceContext, creditId: string): Promise<LinkedTransaction> {
  const [credit] = await ctx.db
    .select()
    .from(vendorCredits)
    .where(and(eq(vendorCredits.companyId, ctx.companyId), eq(vendorCredits.id, creditId)));
  if (!credit) throw notFound('Vendor credit');

  const rows = await ctx.db
    .select({ newValues: auditLogs.newValues })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.companyId, ctx.companyId),
        eq(auditLogs.entityType, 'vendor_credit'),
        eq(auditLogs.entityId, creditId),
        sql`${auditLogs.newValues}->>'action' = 'applied_to_bill'`,
      ),
    );
  const children: LinkedTransaction[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const nv = (r.newValues ?? {}) as { billId?: string; amount?: string };
    if (!nv.billId || seen.has(nv.billId)) continue;
    seen.add(nv.billId);
    const [bill] = await ctx.db
      .select({ id: bills.id, number: bills.billNumber, date: bills.date })
      .from(bills)
      .where(and(eq(bills.companyId, ctx.companyId), eq(bills.id, nv.billId)));
    if (bill) {
      children.push(node('bill', bill.id, bill.number ? `Bill ${bill.number}` : 'Bill', bill.date, nv.amount ?? '0'));
    }
  }
  return node('vendor_credit', credit.id, 'Vendor Credit', credit.date, credit.total, children);
}

async function paycheckTree(ctx: ServiceContext, paycheckId: string): Promise<LinkedTransaction> {
  const [pc] = await ctx.db
    .select()
    .from(paychecks)
    .where(and(eq(paychecks.companyId, ctx.companyId), eq(paychecks.id, paycheckId)));
  if (!pc) throw notFound('Paycheck');

  const children: LinkedTransaction[] = [];
  if (pc.payRunId) {
    const [run] = await ctx.db
      .select()
      .from(payRuns)
      .where(and(eq(payRuns.companyId, ctx.companyId), eq(payRuns.id, pc.payRunId)));
    if (run) {
      const [agg] = await ctx.db
        .select({ total: sql<string>`COALESCE(SUM(${paychecks.netPay}), 0)` })
        .from(paychecks)
        .where(and(eq(paychecks.companyId, ctx.companyId), eq(paychecks.payRunId, run.id)));
      children.push(node('pay_run', run.id, 'Pay Run', run.payDate, agg?.total ?? '0'));
    }
  }
  return node('paycheck', pc.id, 'Paycheck', pc.payDate, pc.netPay, children);
}

async function expenseTree(ctx: ServiceContext, expenseId: string): Promise<LinkedTransaction> {
  const [exp] = await ctx.db
    .select()
    .from(expenses)
    .where(and(eq(expenses.companyId, ctx.companyId), eq(expenses.id, expenseId)));
  if (!exp) throw notFound('Expense');
  const label = exp.reference ? `Expense ${exp.reference}` : `Expense (${exp.method})`;
  return node('expense', exp.id, label, exp.date, exp.total);
}

async function salesReceiptTree(ctx: ServiceContext, receiptId: string): Promise<LinkedTransaction> {
  const [rec] = await ctx.db
    .select()
    .from(salesReceipts)
    .where(and(eq(salesReceipts.companyId, ctx.companyId), eq(salesReceipts.id, receiptId)));
  if (!rec) throw notFound('Sales receipt');
  return node('sales_receipt', rec.id, `Sales Receipt #${docRef(rec.refNumber, rec.receiptNumber)}`, rec.date, rec.total);
}

async function itemReceiptTree(ctx: ServiceContext, receiptId: string): Promise<LinkedTransaction> {
  const [rec] = await ctx.db
    .select()
    .from(itemReceipts)
    .where(and(eq(itemReceipts.companyId, ctx.companyId), eq(itemReceipts.id, receiptId)));
  if (!rec) throw notFound('Item receipt');

  const children: LinkedTransaction[] = [];
  if (rec.purchaseOrderId) {
    const [po] = await ctx.db
      .select({ id: purchaseOrders.id, number: sql<string>`COALESCE(NULLIF(${purchaseOrders.refNumber}, ''), CAST(${purchaseOrders.poNumber} AS TEXT))`, date: purchaseOrders.date, total: purchaseOrders.total })
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.companyId, ctx.companyId), eq(purchaseOrders.id, rec.purchaseOrderId)));
    if (po) children.push(node('purchase_order', po.id, `PO #${po.number}`, po.date, po.total));
  }
  if (rec.convertedBillId) {
    const [bill] = await ctx.db
      .select({ id: bills.id, number: bills.billNumber, date: bills.date, total: bills.total })
      .from(bills)
      .where(and(eq(bills.companyId, ctx.companyId), eq(bills.id, rec.convertedBillId)));
    if (bill) {
      children.push(node('bill', bill.id, bill.number ? `Bill ${bill.number}` : 'Bill', bill.date, bill.total));
    }
  }
  const label = rec.reference ? `Item Receipt ${rec.reference}` : 'Item Receipt';
  return node('item_receipt', rec.id, label, rec.date, rec.total, children);
}

// ---------------------------------------------------------------------------
// Public: buildLinkedTree (document root)
// ---------------------------------------------------------------------------

/** Build the linked-transactions tree for a document (root + 2 levels). */
export async function buildLinkedTree(
  ctx: ServiceContext,
  kind: LinkedRootKind,
  id: string,
): Promise<LinkedTransaction> {
  switch (kind) {
    case 'invoice':
      return invoiceTree(ctx, id);
    case 'bill':
      return billTree(ctx, id);
    case 'payment':
      return paymentTree(ctx, id);
    case 'bill_payment':
      return billPaymentTree(ctx, id);
    case 'credit_memo':
      return creditMemoTree(ctx, id);
    case 'vendor_credit':
      return vendorCreditTree(ctx, id);
    case 'deposit':
      return depositTree(ctx, id);
    case 'paycheck':
      return paycheckTree(ctx, id);
    case 'expense':
      return expenseTree(ctx, id);
    case 'sales_receipt':
      return salesReceiptTree(ctx, id);
    case 'item_receipt':
      return itemReceiptTree(ctx, id);
  }
}

// ---------------------------------------------------------------------------
// Public: entryHistory (journal entry root)
// ---------------------------------------------------------------------------

/** sourceRef prefix -> document kind (when the ref suffix IS the document id). */
const PREFIX_TO_KIND: Record<string, LinkedRootKind> = {
  invoice: 'invoice',
  'invoice-cogs': 'invoice',
  bill: 'bill',
  payment: 'payment',
  deposit: 'deposit',
  credit_memo: 'credit_memo',
  'creditmemo-cogs': 'credit_memo',
  vendor_credit: 'vendor_credit',
  paycheck: 'paycheck',
  expense: 'expense',
  salesreceipt: 'sales_receipt',
  sales_receipt: 'sales_receipt',
  item_receipt: 'item_receipt',
};

/**
 * Resolve a journal entry to its source document. Tries the sourceRef prefix
 * first; falls back to postedEntryId probes for refs that don't embed the
 * document id (payments use 'customer:<id>', bill payments 'vendor:<id>').
 */
async function resolveEntryDocument(
  ctx: ServiceContext,
  entry: { id: string; sourceRef: string | null },
): Promise<{ kind: LinkedRootKind; id: string } | null> {
  const ref = entry.sourceRef;
  if (ref && ref !== 'manual') {
    const idx = ref.indexOf(':');
    const prefix = idx === -1 ? ref : ref.slice(0, idx);
    const rest = idx === -1 ? '' : ref.slice(idx + 1);
    const kind = PREFIX_TO_KIND[prefix];
    if (kind && rest) return { kind, id: rest };
  }

  // Probe postedEntryId on documents whose sourceRef doesn't carry their id.
  const probes: Array<{ kind: LinkedRootKind; run: () => Promise<{ id: string } | undefined> }> = [
    {
      kind: 'payment',
      run: async () =>
        (
          await ctx.db
            .select({ id: paymentsReceived.id })
            .from(paymentsReceived)
            .where(and(eq(paymentsReceived.companyId, ctx.companyId), eq(paymentsReceived.postedEntryId, entry.id)))
        )[0],
    },
    {
      kind: 'bill_payment',
      run: async () =>
        (
          await ctx.db
            .select({ id: billPayments.id })
            .from(billPayments)
            .where(and(eq(billPayments.companyId, ctx.companyId), eq(billPayments.postedEntryId, entry.id)))
        )[0],
    },
    {
      kind: 'deposit',
      run: async () =>
        (
          await ctx.db
            .select({ id: deposits.id })
            .from(deposits)
            .where(and(eq(deposits.companyId, ctx.companyId), eq(deposits.postedEntryId, entry.id)))
        )[0],
    },
    {
      kind: 'item_receipt',
      run: async () =>
        (
          await ctx.db
            .select({ id: itemReceipts.id })
            .from(itemReceipts)
            .where(and(eq(itemReceipts.companyId, ctx.companyId), eq(itemReceipts.postedEntryId, entry.id)))
        )[0],
    },
  ];
  for (const probe of probes) {
    const hit = await probe.run();
    if (hit) return { kind: probe.kind, id: hit.id };
  }
  return null;
}

/**
 * Transaction history for a journal entry.
 *
 * Document-backed entries resolve to their source document and return its
 * linked tree. Manual entries return the entry itself as root with
 * reversal/replacement edges as children:
 *  - 'Reverses' / 'Reversed by' via sourceRef 'reversal:<id>'.
 *  - 'Replaces' / 'Replaced by' via journal.updateEntry audit rows
 *    (newValues.replacedBy old->new edges).
 */
export async function entryHistory(ctx: ServiceContext, entryId: string): Promise<LinkedTransaction> {
  const [entry] = await ctx.db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.id, entryId)));
  if (!entry) throw notFound('Journal entry');

  const doc = await resolveEntryDocument(ctx, entry);
  if (doc) return buildLinkedTree(ctx, doc.kind, doc.id);

  // Manual (or unresolvable) entry: reversal + replacement edges.
  const children: LinkedTransaction[] = [];

  // This entry reverses another (sourceRef 'reversal:<originalId>').
  if (entry.sourceRef?.startsWith('reversal:')) {
    const originalId = entry.sourceRef.slice('reversal:'.length);
    const [orig] = await ctx.db
      .select({ id: journalEntries.id, number: journalEntries.entryNumber, date: journalEntries.date })
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.id, originalId)));
    if (orig) {
      children.push(
        node('journal_entry', orig.id, `Reverses Entry #${orig.number}`, orig.date, await entryTotal(ctx, orig.id)),
      );
    }
  }

  // Entries that reverse this one.
  const reversals = await ctx.db
    .select({ id: journalEntries.id, number: journalEntries.entryNumber, date: journalEntries.date })
    .from(journalEntries)
    .where(
      and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.sourceRef, `reversal:${entryId}`)),
    )
    .orderBy(asc(journalEntries.entryNumber));
  for (const r of reversals) {
    children.push(
      node('journal_entry', r.id, `Reversed by Entry #${r.number}`, r.date, await entryTotal(ctx, r.id)),
    );
  }

  // Replacement edges from journal.updateEntry audit rows (old -> new).
  // Replaced by: audit row on THIS entry carrying newValues.replacedBy.
  const replacedByRows = await ctx.db
    .select({ newValues: auditLogs.newValues })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.companyId, ctx.companyId),
        eq(auditLogs.entityType, 'journal_entry'),
        eq(auditLogs.entityId, entryId),
        sql`${auditLogs.newValues}->>'replacedBy' IS NOT NULL`,
      ),
    )
    .orderBy(desc(auditLogs.createdAt));
  for (const r of replacedByRows) {
    const nv = (r.newValues ?? {}) as { replacedBy?: string };
    if (!nv.replacedBy) continue;
    const [next] = await ctx.db
      .select({ id: journalEntries.id, number: journalEntries.entryNumber, date: journalEntries.date })
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.id, nv.replacedBy)));
    if (next) {
      children.push(
        node('journal_entry', next.id, `Replaced by Entry #${next.number}`, next.date, await entryTotal(ctx, next.id)),
      );
    }
  }

  // Replaces: audit row on another entry whose newValues.replacedBy = this id.
  const replacesRows = await ctx.db
    .select({ entityId: auditLogs.entityId })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.companyId, ctx.companyId),
        eq(auditLogs.entityType, 'journal_entry'),
        sql`${auditLogs.newValues}->>'replacedBy' = ${entryId}`,
      ),
    );
  for (const r of replacesRows) {
    const [prev] = await ctx.db
      .select({ id: journalEntries.id, number: journalEntries.entryNumber, date: journalEntries.date })
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.id, r.entityId)));
    if (prev) {
      children.push(
        node('journal_entry', prev.id, `Replaces Entry #${prev.number}`, prev.date, await entryTotal(ctx, prev.id)),
      );
    }
  }

  return node(
    'journal_entry',
    entry.id,
    `Journal Entry #${entry.entryNumber}`,
    entry.date,
    await entryTotal(ctx, entry.id),
    children,
  );
}
