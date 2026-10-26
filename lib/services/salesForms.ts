/**
 * Sales forms: PDFs, email and the print/email queues (wave2 sales, C7/C8).
 *
 *  - `renderSalesFormPdf(kind, id)` renders any A/R form — invoice, estimate, sales receipt,
 *    credit memo/refund, sales order — or a customer statement, with shipping details (B6).
 *    Every form prints with its form template (B11): the explicit `templateId` when given, else
 *    the form's default template, else the built-in layout (resolveFormTemplate).
 *  - `emailSalesForm` sends it as a PDF attachment through `sendMail` (lib/services/email.ts),
 *    which enforces SMTP configuration and the company network policy (lib/net/guard.ts). A
 *    successful send clears the form's "to be emailed" flag and stamps `lastEmailedAt`.
 *  - `setSendFlags` / `listSendQueue` / `markPrinted` / `sendQueuedEmails` implement QB's
 *    "To be printed" / "To be e-mailed" checkboxes and the batch Print Forms / Send Forms queues.
 *
 * Every mutation writes an audit row (and so reaches the transaction log).
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  creditMemos,
  customers,
  estimates,
  invoices,
  salesOrders,
  salesReceipts,
} from '@/lib/db/schema';
import { type ServiceContext, ServiceError, inTransaction, notFound, validation, writeAudit } from './_base';
import { getInvoice } from './invoices';
import { getEstimate } from './estimates';
import { getSalesReceipt } from './salesReceipts';
import { getCreditMemo } from './creditMemos';
import { getSalesOrder } from './salesOrders';
import { customerStatement } from './statements';
import { getCompany } from './company';
import { Money } from '@/lib/money';
import { docRef } from './docNumbers';
import { isConfigured, sendMail } from './email';
import { renderEstimatePdf } from '@/lib/pdf/estimate';
import { renderSalesReceiptPdf } from '@/lib/pdf/salesReceipt';
import { renderCreditMemoPdf } from '@/lib/pdf/creditMemo';
import { renderSalesOrderPdf } from '@/lib/pdf/salesOrder';
import type { SalesShippingInfo } from '@/lib/pdf/salesForm';
import { addressToLines, buildInvoicePdf, buildStatementPdf, companyLetterhead } from '@/lib/pdf/forms';
import { resolveFormTemplate } from './formTemplates';

export const SALES_FORM_KINDS = ['invoice', 'estimate', 'sales_receipt', 'credit_memo', 'sales_order'] as const;
export type SalesFormKind = (typeof SALES_FORM_KINDS)[number];

export const FORM_LABEL: Record<SalesFormKind, string> = {
  invoice: 'Invoice',
  estimate: 'Estimate',
  sales_receipt: 'Sales Receipt',
  credit_memo: 'Credit Memo',
  sales_order: 'Sales Order',
};

export function isSalesFormKind(v: unknown): v is SalesFormKind {
  return typeof v === 'string' && (SALES_FORM_KINDS as readonly string[]).includes(v);
}

function iso(d: Date | string | null | undefined): string {
  if (!d) return '';
  const x = d instanceof Date ? d : new Date(d);
  return Number.isNaN(x.getTime()) ? '' : x.toISOString().slice(0, 10);
}

function shippingOf(doc: {
  shipDate?: Date | null;
  shipVia?: string | null;
  fob?: string | null;
  trackingNumber?: string | null;
  shipTo?: Record<string, string> | null;
  poNumber?: string | null;
}): SalesShippingInfo | null {
  const info: SalesShippingInfo = {
    shipDate: doc.shipDate ? iso(doc.shipDate) : null,
    shipVia: doc.shipVia ?? null,
    fob: doc.fob ?? null,
    trackingNumber: doc.trackingNumber ?? null,
    shipTo: doc.shipTo ?? null,
    poNumber: doc.poNumber ?? null,
  };
  const any =
    info.shipDate || info.shipVia || info.fob || info.trackingNumber || info.poNumber ||
    (info.shipTo && Object.values(info.shipTo).some((v) => v && String(v).trim()));
  return any ? info : null;
}

async function customerInfo(ctx: ServiceContext, customerId: string | null) {
  if (!customerId) return { name: 'Walk-in customer', email: null as string | null, billToLines: [] as string[] };
  const [row] = await ctx.db
    .select({ displayName: customers.displayName, email: customers.email, billingAddress: customers.billingAddress })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, customerId)));
  return { name: row?.displayName ?? 'Customer', email: row?.email ?? null, billToLines: addressToLines(row?.billingAddress) };
}

export interface RenderedForm {
  bytes: Uint8Array;
  filename: string;
  /** e.g. "Invoice #12" */
  title: string;
  customerId: string | null;
  customerName: string;
  customerEmail: string | null;
  /** Plain-text summary for the email body. */
  summary: string[];
}

/** A document number made safe for a download filename (alphanumeric numbers may contain / etc.). */
const fileSafe = (ref: string) => ref.replace(/[^A-Za-z0-9._-]+/g, '-');

/**
 * Render one sales form as a PDF (scoped to the company; NOT_FOUND otherwise), with its form
 * template (B11): `templateId` when given (must be this company's template for the same form —
 * NOT_FOUND / VALIDATION otherwise), else the form's default template, else the built-in layout.
 */
export async function renderSalesForm(
  ctx: ServiceContext,
  kind: SalesFormKind,
  id: string,
  templateId?: string | null,
): Promise<RenderedForm> {
  const [letterhead, resolved] = await Promise.all([
    companyLetterhead(ctx),
    resolveFormTemplate(ctx, kind, templateId),
  ]);
  // Invoices and estimates always print through the template renderer (the built-in layout is
  // its default design). Sales receipts, credit memos and sales orders keep their built-in
  // layout unless a template (explicit or default) exists.
  const template = { design: resolved.design, logo: resolved.logo };
  const customTemplate = resolved.templateId ? template : null;
  const lineOf = (l: { description: string | null; quantity: string; rate: string; amount: string }) => ({
    description: l.description ?? '',
    quantity: l.quantity,
    rate: l.rate,
    amount: l.amount,
  });

  switch (kind) {
    case 'invoice': {
      const inv = await getInvoice(ctx, id);
      const cust = await customerInfo(ctx, inv.customerId);
      // The same invoice PDF as Print / the invoice PDF route (lib/pdf/forms.ts): the invoice's
      // currency, terms, memo, item names and "don't print zero-amount items" — this path used to
      // build its own copy that printed a foreign-currency invoice in dollars.
      const { bytes } = await buildInvoicePdf(ctx, id, templateId);
      const title = `${inv.isStatementCharge ? 'Statement Charge' : 'Invoice'} #${docRef(inv.refNumber, inv.invoiceNumber)}`;
      return {
        bytes,
        filename: `invoice-${fileSafe(docRef(inv.refNumber, inv.invoiceNumber))}.pdf`,
        title,
        customerId: inv.customerId,
        customerName: cust.name,
        customerEmail: cust.email,
        summary: [`Total: ${inv.total}`, `Balance due: ${inv.balanceDue}`, ...(inv.dueDate ? [`Due: ${iso(inv.dueDate)}`] : [])],
      };
    }
    case 'estimate': {
      const est = await getEstimate(ctx, id);
      const cust = await customerInfo(ctx, est.customerId);
      const bytes = await renderEstimatePdf({
        company: letterhead,
        billToLines: cust.billToLines,
        customerName: cust.name,
        estimate: {
          number: docRef(est.refNumber, est.estimateNumber),
          date: iso(est.date),
          expirationDate: est.expirationDate ? iso(est.expirationDate) : null,
          subtotal: est.subtotal,
          taxAmount: est.taxAmount,
          total: est.total,
          memo: est.memo ?? null,
        },
        shipTo: est.shipTo ?? null,
        lines: est.lines.map(lineOf),
      }, template);
      return {
        bytes,
        filename: `estimate-${fileSafe(docRef(est.refNumber, est.estimateNumber))}.pdf`,
        title: `Estimate #${docRef(est.refNumber, est.estimateNumber)}`,
        customerId: est.customerId,
        customerName: cust.name,
        customerEmail: cust.email,
        summary: [`Total: ${est.total}`, ...(est.expirationDate ? [`Valid until: ${iso(est.expirationDate)}`] : [])],
      };
    }
    case 'sales_receipt': {
      const r = await getSalesReceipt(ctx, id);
      const cust = await customerInfo(ctx, r.customerId);
      const bytes = await renderSalesReceiptPdf({
        company: letterhead,
        billToLines: cust.billToLines,
        customerName: cust.name,
        receipt: {
          number: docRef(r.refNumber, r.receiptNumber),
          date: iso(r.date),
          method: r.method,
          reference: r.reference,
          subtotal: r.subtotal,
          tax: r.taxAmount,
          total: r.total,
          memo: r.memo,
        },
        lines: r.lines.map(lineOf),
        shipping: shippingOf(r),
      }, customTemplate);
      return {
        bytes,
        filename: `sales-receipt-${fileSafe(docRef(r.refNumber, r.receiptNumber))}.pdf`,
        title: `Sales Receipt #${docRef(r.refNumber, r.receiptNumber)}`,
        customerId: r.customerId,
        customerName: cust.name,
        customerEmail: cust.email,
        summary: [`Total paid: ${r.total}`],
      };
    }
    case 'credit_memo': {
      const m = await getCreditMemo(ctx, id);
      const cust = await customerInfo(ctx, m.customerId);
      const bytes = await renderCreditMemoPdf({
        company: letterhead,
        billToLines: cust.billToLines,
        customerName: cust.name,
        memo: {
          number: docRef(m.refNumber, m.memoNumber),
          date: iso(m.date),
          subtotal: m.subtotal,
          tax: m.taxAmount,
          total: m.total,
          remaining: m.unapplied,
          refunded: m.refundedAmount,
          memo: m.memo,
        },
        lines: m.lines.map(lineOf),
      }, customTemplate);
      return {
        bytes,
        filename: `credit-memo-${fileSafe(docRef(m.refNumber, m.memoNumber))}.pdf`,
        title: `Credit Memo #${docRef(m.refNumber, m.memoNumber)}`,
        customerId: m.customerId,
        customerName: cust.name,
        customerEmail: cust.email,
        summary: [`Credit total: ${m.total}`, `Credit remaining: ${m.unapplied}`],
      };
    }
    case 'sales_order': {
      const o = await getSalesOrder(ctx, id);
      const cust = await customerInfo(ctx, o.customerId);
      const bytes = await renderSalesOrderPdf({
        company: letterhead,
        billToLines: cust.billToLines,
        customerName: cust.name,
        order: { number: docRef(o.refNumber, o.orderNumber), date: iso(o.date), status: o.status, total: o.total, memo: o.memo },
        lines: o.lines.map((l) => {
          // Decimal, not float: 2.5 ordered - 1.2 invoiced printed "1.2999999999999998".
          const invoiced = Money.of(l.quantityInvoiced ?? 0);
          const backordered = Money.of(l.quantity).minus(invoiced);
          const note =
            invoiced.greaterThan(0) && backordered.greaterThan(0) ? ` (backordered: ${backordered.toDecimalPlaces(4).toString()})` : '';
          return { ...lineOf(l), description: `${l.description ?? ''}${note}` };
        }),
        shipping: shippingOf(o),
      }, customTemplate);
      return {
        bytes,
        filename: `sales-order-${fileSafe(docRef(o.refNumber, o.orderNumber))}.pdf`,
        title: `Sales Order #${docRef(o.refNumber, o.orderNumber)}`,
        customerId: o.customerId,
        customerName: cust.name,
        customerEmail: cust.email,
        summary: [`Order total: ${o.total}`],
      };
    }
  }
}

/** Render a customer statement (balance-forward) PDF. */
export async function renderCustomerStatement(
  ctx: ServiceContext,
  customerId: string,
  range?: { from?: Date; to?: Date },
  templateId?: string | null,
): Promise<RenderedForm> {
  const stmt = await customerStatement(ctx, customerId, range);
  // B11: the default statement template (else the built-in layout), with the company letterhead.
  const bytes = await buildStatementPdf(ctx, stmt, templateId);
  return {
    bytes,
    filename: `statement-${stmt.customer.displayName.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}.pdf`,
    title: 'Statement',
    customerId,
    customerName: stmt.customer.displayName,
    customerEmail: stmt.customer.email,
    summary: [`Balance due: ${stmt.closingBalance}`],
  };
}

const NOT_CONFIGURED =
  'Email is not set up yet. Ask your administrator to add the SMTP settings, then try again.';

async function deliver(ctx: ServiceContext, form: RenderedForm, to?: string | null) {
  const company = await getCompany(ctx);
  const companyName = company?.name ?? 'Your Company';
  const recipient = (to && to.trim()) || form.customerEmail;
  if (!recipient) {
    throw validation(
      `There is no email address for ${form.customerName}. Type one in, or add it to the customer record.`,
    );
  }
  await sendMail(
    {
      to: recipient,
      subject: `${form.title} from ${companyName}`,
      text: [
        `Dear ${form.customerName},`,
        '',
        `Please find attached ${form.title} from ${companyName}.`,
        ...form.summary,
        '',
        'Thank you for your business.',
        companyName,
      ].join('\n'),
      attachments: [{ filename: form.filename, content: Buffer.from(form.bytes), contentType: 'application/pdf' }],
    },
    ctx,
  );
  return recipient;
}

const TABLE = {
  invoice: invoices,
  estimate: estimates,
  sales_receipt: salesReceipts,
  credit_memo: creditMemos,
  sales_order: salesOrders,
} as const;

/**
 * Email one sales form to the customer (or `to`). Clears its "to be emailed" flag. The PDF prints
 * with `templateId` when given, else the form's default template (B11).
 */
export async function emailSalesForm(
  ctx: ServiceContext,
  kind: SalesFormKind,
  id: string,
  to?: string | null,
  templateId?: string | null,
): Promise<{ ok: true; to: string }> {
  if (!isConfigured()) throw new ServiceError('VALIDATION', NOT_CONFIGURED);
  const form = await renderSalesForm(ctx, kind, id, templateId);
  const recipient = await deliver(ctx, form, to);
  const t = TABLE[kind];
  await inTransaction(ctx, async (tx) => {
    await tx.db
      .update(t)
      .set({ toBeEmailed: false, lastEmailedAt: new Date() } as never)
      .where(and(eq(t.companyId, tx.companyId), eq(t.id, id)));
    await writeAudit(tx, {
      action: 'update',
      entityType: kind,
      entityId: id,
      newValues: { action: 'emailed', to: recipient },
    });
  });
  return { ok: true, to: recipient };
}

/** Email a customer statement (balance-forward, optional date range). */
export async function emailCustomerStatement(
  ctx: ServiceContext,
  customerId: string,
  opts?: { from?: Date; to?: Date; email?: string | null },
): Promise<{ ok: true; to: string }> {
  if (!isConfigured()) throw new ServiceError('VALIDATION', NOT_CONFIGURED);
  const form = await renderCustomerStatement(ctx, customerId, { from: opts?.from, to: opts?.to });
  const recipient = await deliver(ctx, form, opts?.email);
  await writeAudit(ctx, {
    action: 'update',
    entityType: 'customer',
    entityId: customerId,
    newValues: { action: 'statement_emailed', to: recipient },
  });
  return { ok: true, to: recipient };
}

/** Set the "to be printed" / "to be emailed" flags of a form. */
export async function setSendFlags(
  ctx: ServiceContext,
  kind: SalesFormKind,
  id: string,
  flags: { toBePrinted?: boolean; toBeEmailed?: boolean },
) {
  const t = TABLE[kind];
  const set: Record<string, boolean> = {};
  if (flags.toBePrinted !== undefined) set.toBePrinted = flags.toBePrinted;
  if (flags.toBeEmailed !== undefined) set.toBeEmailed = flags.toBeEmailed;
  if (Object.keys(set).length === 0) throw validation('Nothing to change.');
  return inTransaction(ctx, async (tx) => {
    const rows = await tx.db
      .update(t)
      .set(set as never)
      .where(and(eq(t.companyId, tx.companyId), eq(t.id, id)))
      .returning({ id: t.id });
    if (rows.length === 0) throw notFound(FORM_LABEL[kind]);
    await writeAudit(tx, { action: 'update', entityType: kind, entityId: id, newValues: set });
    return { id, ...set };
  });
}

export interface QueueItem {
  kind: SalesFormKind;
  id: string;
  number: string;
  date: string;
  customerId: string | null;
  customerName: string;
  customerEmail: string | null;
  total: string;
}

/** Forms waiting to be printed or emailed (QB Print Forms / Send Forms). */
export async function listSendQueue(ctx: ServiceContext, mode: 'print' | 'email'): Promise<QueueItem[]> {
  const out: QueueItem[] = [];
  const flagCol = (t: (typeof TABLE)[SalesFormKind]) => (mode === 'print' ? t.toBePrinted : t.toBeEmailed);

  const push = (
    kind: SalesFormKind,
    rows: Array<{ id: string; num: number; ref: string | null; date: Date; customerId: string | null; total: string; status?: string | null }>,
  ) => {
    for (const r of rows) {
      if (r.status === 'void') continue;
      out.push({
        kind,
        id: r.id,
        number: docRef(r.ref, r.num),
        date: iso(r.date),
        customerId: r.customerId,
        customerName: '',
        customerEmail: null,
        total: r.total,
      });
    }
  };
  push(
    'invoice',
    await ctx.db
      .select({ id: invoices.id, num: invoices.invoiceNumber, ref: invoices.refNumber, date: invoices.date, customerId: invoices.customerId, total: invoices.total, status: invoices.status })
      .from(invoices)
      .where(and(eq(invoices.companyId, ctx.companyId), eq(flagCol(invoices), true))),
  );
  push(
    'estimate',
    await ctx.db
      .select({ id: estimates.id, num: estimates.estimateNumber, ref: estimates.refNumber, date: estimates.date, customerId: estimates.customerId, total: estimates.total, status: estimates.status })
      .from(estimates)
      .where(and(eq(estimates.companyId, ctx.companyId), eq(flagCol(estimates), true))),
  );
  push(
    'sales_receipt',
    await ctx.db
      .select({ id: salesReceipts.id, num: salesReceipts.receiptNumber, ref: salesReceipts.refNumber, date: salesReceipts.date, customerId: salesReceipts.customerId, total: salesReceipts.total, status: salesReceipts.status })
      .from(salesReceipts)
      .where(and(eq(salesReceipts.companyId, ctx.companyId), eq(flagCol(salesReceipts), true))),
  );
  push(
    'credit_memo',
    await ctx.db
      .select({ id: creditMemos.id, num: creditMemos.memoNumber, ref: creditMemos.refNumber, date: creditMemos.date, customerId: creditMemos.customerId, total: creditMemos.total, status: creditMemos.status })
      .from(creditMemos)
      .where(and(eq(creditMemos.companyId, ctx.companyId), eq(flagCol(creditMemos), true))),
  );
  push(
    'sales_order',
    await ctx.db
      .select({ id: salesOrders.id, num: salesOrders.orderNumber, ref: salesOrders.refNumber, date: salesOrders.date, customerId: salesOrders.customerId, total: salesOrders.total, status: salesOrders.status })
      .from(salesOrders)
      .where(and(eq(salesOrders.companyId, ctx.companyId), eq(flagCol(salesOrders), true))),
  );

  const custIds = [...new Set(out.map((o) => o.customerId).filter(Boolean) as string[])];
  if (custIds.length > 0) {
    const custs = await ctx.db
      .select({ id: customers.id, name: customers.displayName, email: customers.email })
      .from(customers)
      .where(and(eq(customers.companyId, ctx.companyId), inArray(customers.id, custIds)))
      .orderBy(asc(customers.displayName));
    const byId = new Map(custs.map((c) => [c.id, c]));
    for (const o of out) {
      const c = o.customerId ? byId.get(o.customerId) : undefined;
      o.customerName = c?.name ?? 'Walk-in customer';
      o.customerEmail = c?.email ?? null;
    }
  } else {
    for (const o of out) o.customerName = 'Walk-in customer';
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
}

/** Mark queued forms as printed (clears "to be printed"). */
export async function markPrinted(ctx: ServiceContext, items: Array<{ kind: SalesFormKind; id: string }>) {
  let count = 0;
  for (const it of items) {
    if (!isSalesFormKind(it.kind)) throw validation(`Unknown form type "${String(it.kind)}".`);
    await setSendFlags(ctx, it.kind, it.id, { toBePrinted: false });
    count += 1;
  }
  return { count };
}

/** Send every queued email form; one failure never stops the rest. */
export async function sendQueuedEmails(
  ctx: ServiceContext,
  items: Array<{ kind: SalesFormKind; id: string; to?: string | null }>,
) {
  if (!isConfigured()) throw new ServiceError('VALIDATION', NOT_CONFIGURED);
  const sent: Array<{ kind: SalesFormKind; id: string; to: string }> = [];
  const failed: Array<{ kind: SalesFormKind; id: string; error: string }> = [];
  for (const it of items) {
    if (!isSalesFormKind(it.kind)) {
      failed.push({ kind: it.kind, id: it.id, error: 'Unknown form type.' });
      continue;
    }
    try {
      const r = await emailSalesForm(ctx, it.kind, it.id, it.to);
      sent.push({ kind: it.kind, id: it.id, to: r.to });
    } catch (err) {
      if (err instanceof ServiceError && err.code === 'FORBIDDEN') throw err;
      failed.push({ kind: it.kind, id: it.id, error: err instanceof Error ? err.message : 'Could not send.' });
    }
  }
  return { sent, failed };
}
