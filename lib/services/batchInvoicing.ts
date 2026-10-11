/**
 * Batch Invoicing + Statement Charges (wave2 sales, C5/C6).
 *
 * Batch Invoicing (QB "Batch Invoice"): the same item lines billed to a group of customers in
 * one step. Every invoice goes through `createInvoice`, so each one posts its own balanced A/R
 * entry, relieves inventory, honours price levels/rules, and is audited like any invoice. Each
 * customer is processed in its own transaction: one customer that cannot be invoiced (e.g. over
 * their credit limit without an override) is reported back and skipped — it never blocks or
 * half-posts the others.
 *
 * Statement Charges (QB "Enter Statement Charges"): a single-line charge entered in the
 * customer's register that appears on statements and in A/R aging without a printed invoice.
 * Stored as an A/R invoice flagged `isStatementCharge`, so it is aged, collected through Receive
 * Payments, edited (void/repost) and voided exactly like an invoice — and shows on statements
 * as a "Statement charge".
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { customers, invoiceLines, invoices, items } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import { type ServiceContext, ServiceError, notFound, validation } from './_base';
import {
  type CreateInvoiceInput,
  type InvoiceLineInput,
  createInvoice,
  getInvoice,
  updateInvoice,
} from './invoices';

const DAY_MS = 86_400_000;

/** Due date from a customer's terms code ('net_30', 'due_on_receipt', '2_10_net_30', …). */
export function dueDateFromTerms(date: Date, terms: string | null | undefined): Date | null {
  if (!terms) return null;
  const t = terms.toLowerCase();
  if (t.includes('receipt')) return new Date(date);
  const m = /net[\s_]*(\d+)/.exec(t);
  if (!m) return null;
  return new Date(date.getTime() + Number(m[1]) * DAY_MS);
}

// ---------------------------------------------------------------------------
// Batch invoicing (C6)
// ---------------------------------------------------------------------------

export interface BatchInvoiceInput {
  customerIds: string[];
  date: Date;
  /** Explicit due date for every invoice; otherwise each customer's terms decide. */
  dueDate?: Date | null;
  lines: InvoiceLineInput[];
  /**
   * 'customer' (default): each customer's own tax rate (none when they are tax-exempt);
   * a tax-rate id: that rate for everyone; null: no tax.
   */
  taxRateId?: string | null;
  useCustomerTaxRate?: boolean;
  memo?: string | null;
  classId?: string | null;
  toBePrinted?: boolean;
  toBeEmailed?: boolean;
  /** Bill customers who would go over their credit limit anyway (recorded in the audit). */
  overrideCreditLimit?: boolean;
}

export interface BatchInvoiceResult {
  created: Array<{ customerId: string; customerName: string; invoiceId: string; invoiceNumber: number; total: string }>;
  skipped: Array<{ customerId: string; customerName: string; reason: string; code: string }>;
}

export async function createBatchInvoices(
  ctx: ServiceContext,
  input: BatchInvoiceInput,
): Promise<BatchInvoiceResult> {
  const ids = [...new Set(input.customerIds)];
  if (ids.length === 0) throw validation('Pick at least one customer to invoice.');
  if (ids.length > 500) throw validation('Batch invoicing is limited to 500 customers at a time.');
  if (!input.lines || input.lines.length === 0) throw validation('Add at least one line to bill.');

  const rows = await ctx.db
    .select({
      id: customers.id,
      displayName: customers.displayName,
      terms: customers.terms,
      taxable: customers.taxable,
      taxRateId: customers.taxRateId,
      isActive: customers.isActive,
    })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), inArray(customers.id, ids)));
  const byId = new Map(rows.map((r) => [r.id, r]));

  const result: BatchInvoiceResult = { created: [], skipped: [] };
  for (const id of ids) {
    const cust = byId.get(id);
    if (!cust) {
      result.skipped.push({ customerId: id, customerName: '(unknown)', reason: 'Customer not found.', code: 'NOT_FOUND' });
      continue;
    }
    if (!cust.isActive) {
      result.skipped.push({ customerId: id, customerName: cust.displayName, reason: 'Customer is inactive.', code: 'VALIDATION' });
      continue;
    }
    const useCustomerRate = input.useCustomerTaxRate !== false && input.taxRateId === undefined;
    const taxRateId = useCustomerRate ? (cust.taxable ? cust.taxRateId : null) : (input.taxRateId ?? null);
    const invoiceInput: CreateInvoiceInput = {
      customerId: id,
      date: input.date,
      dueDate: input.dueDate ?? dueDateFromTerms(input.date, cust.terms),
      lines: input.lines.map((l) => ({ ...l, taxable: cust.taxable ? l.taxable : false })),
      taxRateId,
      classId: input.classId ?? null,
      memo: input.memo ?? null,
      toBePrinted: input.toBePrinted,
      toBeEmailed: input.toBeEmailed,
      overrideCreditLimit: input.overrideCreditLimit,
    };
    try {
      const inv = await createInvoice(ctx, invoiceInput);
      result.created.push({
        customerId: id,
        customerName: cust.displayName,
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        total: inv.total,
      });
    } catch (err) {
      if (err instanceof ServiceError && err.code !== 'FORBIDDEN') {
        const warning = (err.details as { warning?: string } | undefined)?.warning;
        result.skipped.push({
          customerId: id,
          customerName: cust.displayName,
          reason: err.message,
          code: warning ?? err.code,
        });
        continue;
      }
      throw err;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Statement charges (C5)
// ---------------------------------------------------------------------------

export interface StatementChargeInput {
  customerId: string;
  date: Date;
  /** Optional product/service item (supplies the income account). */
  itemId?: string | null;
  /** Income account when there is no item (defaults to the item's / 4000 Sales Income). */
  accountId?: string | null;
  description?: string | null;
  quantity?: string | number | null;
  /** Unit price; the charge amount is quantity x rate. */
  rate: string | number;
  dueDate?: Date | null;
  classId?: string | null;
  jobId?: string | null;
  overrideCreditLimit?: boolean;
}

function chargeToInvoiceInput(input: StatementChargeInput, terms: string | null): CreateInvoiceInput {
  const qty = input.quantity ?? 1;
  if (!Money.of(qty).greaterThan(0)) throw validation('Quantity must be greater than zero.');
  if (!Money.of(input.rate).greaterThan(0)) throw validation('The charge amount must be greater than zero.');
  return {
    customerId: input.customerId,
    date: input.date,
    dueDate: input.dueDate ?? dueDateFromTerms(input.date, terms) ?? input.date,
    classId: input.classId ?? null,
    jobId: input.jobId ?? null,
    memo: input.description ?? null,
    overrideCreditLimit: input.overrideCreditLimit,
    isStatementCharge: true,
    lines: [
      {
        itemId: input.itemId ?? null,
        accountId: input.accountId ?? null,
        description: input.description ?? null,
        quantity: qty,
        rate: input.rate,
        // Statement charges are not taxed (QB: they carry no sales tax).
        taxable: false,
      },
    ],
  };
}

async function customerTerms(ctx: ServiceContext, customerId: string): Promise<string | null> {
  const [c] = await ctx.db
    .select({ terms: customers.terms })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, customerId)));
  if (!c) throw notFound('Customer');
  return c.terms ?? null;
}

export async function createStatementCharge(ctx: ServiceContext, input: StatementChargeInput) {
  const terms = await customerTerms(ctx, input.customerId);
  return createInvoice(ctx, chargeToInvoiceInput(input, terms));
}

/** Edit a statement charge (void + re-post through updateInvoice; payments stay applied). */
export async function updateStatementCharge(ctx: ServiceContext, id: string, input: StatementChargeInput) {
  const existing = await getInvoice(ctx, id);
  if (!existing.isStatementCharge) throw notFound('Statement charge');
  const terms = await customerTerms(ctx, input.customerId);
  const { isStatementCharge: _flag, ...rest } = chargeToInvoiceInput(input, terms);
  return updateInvoice(ctx, id, rest);
}

/** A customer's register of statement charges (newest last). */
export async function listStatementCharges(ctx: ServiceContext, opts?: { customerId?: string }) {
  const conds = [eq(invoices.companyId, ctx.companyId), eq(invoices.isStatementCharge, true)];
  if (opts?.customerId) conds.push(eq(invoices.customerId, opts.customerId));
  const rows = await ctx.db
    .select({
      id: invoices.id,
      customerId: invoices.customerId,
      customerName: customers.displayName,
      invoiceNumber: invoices.invoiceNumber,
      date: invoices.date,
      dueDate: invoices.dueDate,
      status: invoices.status,
      total: invoices.total,
      balanceDue: invoices.balanceDue,
      memo: invoices.memo,
    })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(and(...conds))
    .orderBy(asc(invoices.date), asc(invoices.invoiceNumber));
  if (rows.length === 0) return [];
  const lines = await ctx.db
    .select({
      invoiceId: invoiceLines.invoiceId,
      itemId: invoiceLines.itemId,
      itemName: items.name,
      accountId: invoiceLines.accountId,
      description: invoiceLines.description,
      quantity: invoiceLines.quantity,
      rate: invoiceLines.rate,
    })
    .from(invoiceLines)
    .leftJoin(items, eq(items.id, invoiceLines.itemId))
    .where(inArray(invoiceLines.invoiceId, rows.map((r) => r.id)));
  const lineBy = new Map(lines.map((l) => [l.invoiceId, l]));
  return rows.map((r) => ({ ...r, line: lineBy.get(r.id) ?? null }));
}
