/**
 * QuickBooks list fields on sales forms (team salesar):
 *
 *  - Customer Message (B8): the message picked at the foot of an invoice, sales receipt, credit
 *    memo, estimate or sales order (Customer Message list), stored on the document and printed.
 *  - Sales Tax Code per line (B9): every sales line carries the code it was saved with ("Tax",
 *    "Non", "OOS", ...). The server decides taxability from the code, never from a bare flag:
 *      1. a non-taxable customer ("Non" customer) → every line is non-taxable;
 *      2. a code the line states → its taxable flag;
 *      3. otherwise the item's code (an item whose code is non-taxable is never taxed — an API
 *         caller can no longer tax a "Non" item by sending taxable: true), else the item's own
 *         taxable flag;
 *      4. a line with no item keeps the taxable flag it was sent.
 *  - Payment Method (B7): received payments and sales receipts name the Payment Method list entry
 *    ("Visa", "E-Check"); the stored `method` is always that entry's type, so deposits and reports
 *    that group by type keep working.
 *
 * Kept free of document-service imports so every sales service can use it without cycles.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { customerMessages, items, paymentMethods, salesTaxCodes } from '@/lib/db/schema';
import { type ServiceContext, notFound, validation } from './_base';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Customer Message (B8)
// ---------------------------------------------------------------------------

/**
 * The customer message to store on a sales form: `id` undefined keeps `prev` (an edit from a
 * client that does not send the field), null / '' clears it. The entry must be this company's; a
 * newly picked one must be active (a document keeps an entry made inactive after it was saved).
 */
export async function resolveCustomerMessage(
  ctx: ServiceContext,
  id: string | null | undefined,
  prev: string | null = null,
): Promise<string | null> {
  if (id === undefined) return prev;
  if (!id) return null;
  if (!UUID_RE.test(id)) throw validation('Customer message does not exist in this company.');
  const [row] = await ctx.db
    .select({ id: customerMessages.id, isActive: customerMessages.isActive })
    .from(customerMessages)
    .where(and(eq(customerMessages.companyId, ctx.companyId), eq(customerMessages.id, id)));
  if (!row) throw validation('Customer message does not exist in this company.');
  if (!row.isActive && id !== prev) throw validation('That customer message is inactive. Pick another one, or make it active on the Customer Message list.');
  return row.id;
}

/** The text of a stored customer message (for printing), or null. */
export async function customerMessageText(ctx: ServiceContext, id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  const [row] = await ctx.db
    .select({ message: customerMessages.message })
    .from(customerMessages)
    .where(and(eq(customerMessages.companyId, ctx.companyId), eq(customerMessages.id, id)));
  return row?.message ?? null;
}

// ---------------------------------------------------------------------------
// Sales Tax Code per line (B9)
// ---------------------------------------------------------------------------

export interface TaxCodedLine {
  itemId?: string | null;
  taxable?: boolean | null;
  /** The line's Sales Tax Code: undefined / null = decided from the item (see the module notes). */
  salesTaxCodeId?: string | null;
}

export interface CustomerTaxCode {
  /** false = the customer's tax code is non-taxable. */
  taxable: boolean;
  /** The customer's own Sales Tax Code, when set. */
  salesTaxCodeId: string | null;
}

/**
 * Apply the Sales Tax Code rules to sales lines: each returned line has `taxable` and
 * `salesTaxCodeId` set as the document will store them. Throws VALIDATION for a code that is not
 * this company's.
 */
export async function applyLineTaxCodes<L extends TaxCodedLine>(
  ctx: ServiceContext,
  lines: L[],
  customer: CustomerTaxCode | null,
): Promise<L[]> {
  const stated = [...new Set(lines.map((l) => l.salesTaxCodeId).filter((x): x is string => !!x))];
  const itemIds = [...new Set(lines.map((l) => l.itemId).filter((x): x is string => !!x && UUID_RE.test(x)))];
  if (stated.length === 0 && itemIds.length === 0 && customer?.taxable !== false) {
    return lines.map((l) => ({ ...l, salesTaxCodeId: null }));
  }
  for (const id of stated) if (!UUID_RE.test(id)) throw validation('Sales tax code does not exist in this company.');
  const codes = new Map(
    (
      await ctx.db
        .select({ id: salesTaxCodes.id, taxable: salesTaxCodes.taxable })
        .from(salesTaxCodes)
        .where(eq(salesTaxCodes.companyId, ctx.companyId))
    ).map((c) => [c.id, c] as const),
  );
  for (const id of stated) if (!codes.has(id)) throw validation('Sales tax code does not exist in this company.');
  const itemRows = itemIds.length
    ? await ctx.db
        .select({ id: items.id, taxable: items.taxable, salesTaxCodeId: items.salesTaxCodeId })
        .from(items)
        .where(and(eq(items.companyId, ctx.companyId), inArray(items.id, itemIds)))
    : [];
  const itemById = new Map(itemRows.map((r) => [r.id, r] as const));
  const customerCode = customer?.salesTaxCodeId ? codes.get(customer.salesTaxCodeId) : undefined;

  return lines.map((l) => {
    const own = l.salesTaxCodeId ? codes.get(l.salesTaxCodeId)! : undefined;
    // 1. A non-taxable customer: nothing on the form is taxed.
    if (customer && !customer.taxable) {
      const code = own && !own.taxable ? own.id : customerCode && !customerCode.taxable ? customerCode.id : null;
      return { ...l, taxable: false, salesTaxCodeId: code };
    }
    // 2. The code the line states.
    if (own) return { ...l, taxable: own.taxable, salesTaxCodeId: own.id };
    // 3. The item's code, else its taxable flag.
    const item = l.itemId ? itemById.get(l.itemId) : undefined;
    if (item) {
      const itemCode = item.salesTaxCodeId ? codes.get(item.salesTaxCodeId) : undefined;
      if (itemCode) {
        if (!itemCode.taxable) return { ...l, taxable: false, salesTaxCodeId: itemCode.id };
        const taxable = l.taxable !== false;
        return { ...l, taxable, salesTaxCodeId: taxable ? itemCode.id : null };
      }
      if (item.taxable === false) return { ...l, taxable: false, salesTaxCodeId: null };
    }
    // 4. A line without an item (or a taxable item without a code): the flag it was sent.
    return { ...l, taxable: l.taxable !== false, salesTaxCodeId: null };
  });
}

/**
 * The code to store on a computed line: the line's resolved code when the service kept its
 * taxability (a payment / sales tax / subtotal line is always non-taxable and stores no code).
 */
export function storedLineTaxCode(
  inputLine: { taxable?: boolean | null; salesTaxCodeId?: string | null } | undefined,
  computedTaxable: boolean,
): string | null {
  if (!inputLine?.salesTaxCodeId) return null;
  return (inputLine.taxable !== false) === computedTaxable ? inputLine.salesTaxCodeId : null;
}

// ---------------------------------------------------------------------------
// Payment Method (B7)
// ---------------------------------------------------------------------------

export type PaymentMethodType = 'cash' | 'check' | 'credit_card' | 'ach' | 'bank_transfer' | 'other';

/**
 * The Payment Method list entry and type to store on a received payment / sales receipt.
 *  - `paymentMethodId` given: this company's entry (a newly picked one must be active); the type
 *    stored is the entry's type, whatever `method` says.
 *  - null / '': no list entry; `method` (or the previous type) is the type.
 *  - undefined (a client that does not send it): an edit keeps the previous entry while the type
 *    does not change; a new document names no entry.
 */
export async function resolvePaymentMethod(
  ctx: ServiceContext,
  input: { paymentMethodId?: string | null; method?: PaymentMethodType | null },
  prev?: { paymentMethodId: string | null; method: PaymentMethodType },
): Promise<{ paymentMethodId: string | null; method: PaymentMethodType }> {
  const id = input.paymentMethodId;
  if (id === undefined) {
    const method = (input.method ?? prev?.method ?? 'check') as PaymentMethodType;
    const keep = prev && prev.paymentMethodId && method === prev.method ? prev.paymentMethodId : null;
    return { paymentMethodId: keep, method };
  }
  if (!id) return { paymentMethodId: null, method: (input.method ?? prev?.method ?? 'check') as PaymentMethodType };
  if (!UUID_RE.test(id)) throw validation('Payment method does not exist in this company.');
  const [row] = await ctx.db
    .select({ id: paymentMethods.id, type: paymentMethods.type, isActive: paymentMethods.isActive, name: paymentMethods.name })
    .from(paymentMethods)
    .where(and(eq(paymentMethods.companyId, ctx.companyId), eq(paymentMethods.id, id)));
  if (!row) throw notFound('Payment method');
  if (!row.isActive && id !== prev?.paymentMethodId) {
    throw validation(`"${row.name}" is inactive on the Payment Method list. Pick another payment method, or make it active.`);
  }
  return { paymentMethodId: row.id, method: row.type as PaymentMethodType };
}

/** Names of Payment Method list entries by id (for lists, deposits and reports). */
export async function paymentMethodNames(ctx: ServiceContext, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (unique.length === 0) return new Map();
  const rows = await ctx.db
    .select({ id: paymentMethods.id, name: paymentMethods.name })
    .from(paymentMethods)
    .where(and(eq(paymentMethods.companyId, ctx.companyId), inArray(paymentMethods.id, unique)));
  return new Map(rows.map((r) => [r.id, r.name]));
}
