/**
 * Zod schemas for /api/invoices — mirrors CreateInvoiceInput / InvoiceLineInput
 * (lib/services/invoices.ts) and BillableSelection (lib/services/billables.ts).
 */
import { z } from 'zod';
import { zDate, zDecimal, zDocNumber, zLenient, zLines, zMoney, zUuid } from './helpers';
import { inventoryLineFields } from './inventorySites';
import { creditLimitOverrideField, sendFlagFields, customerMessageField, shippingFields } from './sales';

export const invoiceLineSchema = z.object({
  itemId: zUuid.nullish().describe('Id of the item sold (item list); it supplies the income account and the price.'),
  accountId: zUuid
    .nullish()
    .describe("Id of the income account credited (chart of accounts); it overrides the item's account, and with neither the default sales income account is used."),
  description: z.string().nullish().describe('Text printed on the line.'),
  quantity: zDecimal.describe('Quantity sold as decimal text, such as "2" or "1.5".'),
  /** Omit on item lines to have the server price the line (advanced pricing). */
  rate: zDecimal
    .nullish()
    .describe('Price per unit as decimal text such as "125.00"; leave out on an item line to use the price the app works out.'),
  /** Defaults to true in the service. */
  taxable: z.boolean().optional().describe('Whether sales tax applies to the line; leave out for true.'),
  /** salesar (B9): the line's Sales Tax Code; the server sets `taxable` from it. */
  salesTaxCodeId: zUuid
    .nullish()
    .describe('Id of a Sales Tax Code list entry such as "Tax" or "Non"; when given it decides whether the line is taxable.'),
  taxRateId: zUuid
    .nullish()
    .describe('Id of a sales tax item (sales tax list) that taxes this line instead of the invoice-level one.'),
  classId: zUuid.nullish().describe("Id of a class (class list) for the line; leave out to use the invoice's class."),
  jobId: zUuid.nullish().describe("Id of a Customer:Job (job list) for the line; leave out to use the invoice's job."),
  /** Progress invoicing: the estimate line this line bills (round-tripped by the edit form).
   *  The service checks it belongs to an estimate for the same customer and item. */
  estimateLineId: zUuid
    .nullish()
    .describe("Id of the estimate line this line bills (progress invoicing); it must be on this customer's estimate for the same item."),
  /** Billable time & costs: the cost / time entry this line bills (round-tripped by the edit
   *  form). The service keeps it only when the invoice's old lines had it. */
  billableSource: z
    .object({
      kind: z
        .enum(['bill_line', 'expense_line', 'time_entry'])
        .describe('What the line bills: a bill line, a check or expense line, or a time entry.'),
      id: zUuid.describe('Id of that bill line, check or expense line, or time entry.'),
    })
    .nullish()
    .describe('On an edit, the billable cost or time this line already bills; send it back unchanged to keep the link.'),
  /** Advanced Inventory: site/bin/serial/lot the stock is sold from. */
  ...inventoryLineFields,
});

/** Optional billable time & costs pulled onto the invoice (route-level concern). */
export const billableSelectionSchema = z.object({
  billLineIds: z.array(zUuid).optional().describe("Ids of unbilled bill lines charged to this customer to add to the invoice."),
  expenseLineIds: z
    .array(zUuid)
    .optional()
    .describe('Ids of unbilled check or expense lines charged to this customer to add to the invoice.'),
  timeEntryIds: z.array(zUuid).optional().describe('Ids of unbilled time entries for this customer to add to the invoice.'),
  markupPercent: zDecimal
    .nullish()
    .describe('Markup added to the cost lines as a percentage in decimal text, such as "10" for 10%.'),
});
export type BillableSelectionBody = z.infer<typeof billableSelectionSchema>;

/** True when a billables selection actually selects at least one source row. */
export function hasBillableSelection(b: BillableSelectionBody | null | undefined): boolean {
  if (!b) return false;
  return (
    (b.billLineIds?.length ?? 0) + (b.expenseLineIds?.length ?? 0) + (b.timeEntryIds?.length ?? 0) >
    0
  );
}

const invoiceCoreFields = {
  customerId: zUuid.describe('Id of the customer billed (customer list).'),
  date: zDate.describe('Invoice date, YYYY-MM-DD.'),
  dueDate: zDate.nullish().describe('Date payment is due, YYYY-MM-DD; leave out to work it out from the terms.'),
  /** Payment terms (Terms list name/code); a blank due date is computed from them. */
  terms: z
    .string()
    .max(50)
    .nullish()
    .describe('Payment terms by name from the Terms list, such as "Net 30"; a blank due date is worked out from them.'),
  // Create fills a left-out tax item from the customer (applyCustomerTaxDefaults); an edit saves
  // `taxRateId ?? null`, so there leaving it out removes the tax. The text has to say both.
  taxRateId: zUuid
    .nullish()
    .describe(
      "Id of the sales tax item (sales tax list) charged on taxable lines; on a new invoice leave it out to use the customer's own tax item or send null for no tax, and on an edit send it again to keep it, because leaving it out removes the tax.",
    ),
  classId: zUuid.nullish().describe('Id of a class (class list) for reports by class; lines without their own class use it.'),
  jobId: zUuid
    .nullish()
    .describe("Id of one of the customer's jobs (job list) for job costing; lines without their own job use it."),
  salesRepId: zUuid.nullish().describe('Id of the sales rep (sales rep list) credited with the sale.'),
  discount: zMoney
    .nullish()
    .describe('Discount off the subtotal as decimal text: an amount such as "25.00", or a percentage such as "10" when discountType is percent.'),
  discountType: z
    .enum(['amount', 'percent'])
    .nullish()
    .describe('Whether discount is an amount or a percentage of the subtotal; leave out for amount.'),
  retainagePercent: zDecimal
    .nullish()
    .describe('Share of the total held back as retainage, as a percentage in decimal text such as "10".'),
  memo: z.string().nullish().describe('Internal note saved with the invoice.'),
  currency: z
    .string()
    .nullish()
    .describe("3-letter currency code such as \"EUR\"; leave out for the company's home currency."),
  exchangeRate: zDecimal
    .nullish()
    // resolveInvoiceCurrency (lib/services/invoices.ts): an edit that keeps the currency and leaves
    // the rate blank keeps the invoice's saved rate; an edit that changes the currency takes the
    // currency list's rate, like a new invoice.
    .describe(
      "Home-currency units per 1 unit of the invoice currency, as decimal text such as \"1.10\"; leave it out for the currency list's rate, except on an edit that keeps the currency, where leaving it out keeps the saved rate.",
    ),
  customFields: z
    .record(z.string())
    .nullish()
    .describe("Values of the company's invoice custom fields, keyed by field name."),
  // wave2 sales: shipping fields, send queues, credit-limit override
  ...shippingFields,
  ...sendFlagFields,
  ...customerMessageField,
  ...creditLimitOverrideField,
  /** Save even though a line bills more than 100% of its estimate line (PROGRESS_OVERBILL). */
  allowOverBilling: z
    .boolean()
    .optional()
    .describe('Send true only after the app warned that a line bills more than 100% of its estimate line, to save it anyway.'),
};

/**
 * POST /api/invoices body. `lines` may be empty ONLY when a non-empty
 * billables selection supplies the lines (createInvoiceWithBillables).
 */
export const createInvoiceBodySchema = z
  .object({
    ...invoiceCoreFields,
    status: z
      .enum(['draft', 'open'])
      .nullish()
      .describe('open (the default) posts the invoice now; draft saves it as pending, posting nothing until it is posted later.'),
    /** Typed invoice number (alphanumeric, e.g. "INV-1001"); blank = next number. */
    refNumber: zDocNumber.describe('Invoice number such as "INV-1001"; leave out or blank to use the next number.'),
    allowDuplicateNumber: z
      .boolean()
      .nullish()
      .describe('Send true only after the app warned that this invoice number is already used, to save it anyway.'),
    lines: z
      .array(invoiceLineSchema, {
        required_error: 'lines are required',
        invalid_type_error: 'lines must be an array',
      })
      .describe('Invoice lines; may be empty only when billables adds lines.'),
    billables: billableSelectionSchema
      .nullish()
      .describe("Unbilled costs and time of this customer to add to the invoice as lines."),
  })
  .superRefine((body, ctx) => {
    if (body.lines.length === 0 && !hasBillableSelection(body.billables)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lines'],
        message: 'lines must be a non-empty array',
      });
    }
  });
export type CreateInvoiceBody = z.infer<typeof createInvoiceBodySchema>;

/** PUT /api/invoices/:id — full replace; no draft status and no billables here. */
export const updateInvoiceSchema = z.object({
  ...invoiceCoreFields,
  /** Retyped invoice number (blank/omitted = keep the current number). */
  refNumber: zDocNumber.describe('New invoice number; leave out or blank to keep the current number.'),
  allowDuplicateNumber: z
    .boolean()
    .nullish()
    .describe('Send true only after the app warned that this invoice number is already used, to save it anyway.'),
  lines: zLines(invoiceLineSchema).describe('All lines of the invoice, replacing the saved ones; at least one.'),
});
export type UpdateInvoiceBody = z.infer<typeof updateInvoiceSchema>;

/**
 * POST /api/invoices/retainage — bill released retainage: a new invoice that moves the amount
 * from Retainage Receivable to A/R (lib/services/retainage.ts billRetainage).
 */
export const billRetainageSchema = z.object({
  customerId: zUuid.describe('Id of the customer whose held retainage is billed (customer list).'),
  date: zDate.describe('Date of the retainage invoice, YYYY-MM-DD.'),
  amount: zMoney
    .nullish()
    .describe('Retainage to bill, as decimal text such as "1500.00"; leave out to bill all retainage still held for the customer.'),
  dueDate: zDate.nullish().describe('Date payment is due, YYYY-MM-DD; leave out to work it out as on any new invoice.'),
  memo: z.string().max(4000).nullish().describe('Internal note saved with the invoice; leave out for "Retainage billed".'),
  refNumber: zDocNumber.describe('Invoice number such as "INV-1001"; leave out or blank to use the next number.'),
  allowDuplicateNumber: z
    .boolean()
    .nullish()
    .describe('Send true only after the app warned that this invoice number is already used, to save it anyway.'),
  classId: zUuid.nullish().describe('Id of a class (class list) for reports by class.'),
  overrideCreditLimit: z
    .boolean()
    .optional()
    .describe('Send true only after the app warned that this invoice puts the customer over their credit limit, to save it anyway.'),
});

/**
 * POST /api/invoices/batch — Batch Invoicing (wave2 sales C6): the same lines billed to many
 * customers (lib/services/batchInvoicing.ts createBatchInvoices).
 */
export const batchInvoicesSchema = z.object({
  customerIds: z
    .array(zUuid)
    .min(1, 'pick at least one customer')
    .describe('Ids of the customers to invoice (customer list); each gets its own invoice with the same lines.'),
  date: zDate.describe('Date of every invoice, YYYY-MM-DD.'),
  dueDate: zDate.nullish().describe("Date payment is due, YYYY-MM-DD; leave out to work it out from each customer's terms."),
  lines: zLines(invoiceLineSchema).describe('The lines every invoice gets; at least one.'),
  taxRateId: zUuid
    .nullish()
    .describe("Id of the sales tax item (sales tax list) for every invoice; it is used only when useCustomerTaxRate is false (send null there for no tax)."),
  useCustomerTaxRate: z
    .boolean()
    .optional()
    .describe("Leave out or true to tax each invoice with that customer's own tax item; false to use taxRateId for all of them."),
  memo: z.string().nullish().describe('Internal note saved with every invoice.'),
  classId: zUuid.nullish().describe('Id of a class (class list) for every invoice.'),
  toBePrinted: z.boolean().optional().describe('True to put every invoice in the queue of forms to print later.'),
  toBeEmailed: z.boolean().optional().describe('True to put every invoice in the queue of forms to email later.'),
  overrideCreditLimit: z
    .boolean()
    .optional()
    .describe('True also invoices customers this puts over their credit limit; without it they are skipped and listed in the answer.'),
});

/**
 * POST /api/invoices/:id/post — post a draft (pending) invoice to the books. The route reads the
 * body loosely (anything that is not an object, or no body, means no flags) and takes each flag
 * only when it is exactly true, so both are zLenient and the check refuses nothing it did not
 * take before. It says what the flags mean, for agents (describe_operation, plan §6.3).
 */
export const postDraftInvoiceSchema = z.preprocess(
  (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {}),
  z.object({
    overrideCreditLimit: zLenient(z.boolean()).describe(
      'Send true only after the app warned that posting this invoice puts the customer over their credit limit, to post it anyway.',
    ),
    allowOverBilling: zLenient(z.boolean()).describe(
      'Send true only after the app warned that a line bills more than 100% of its estimate line, to post it anyway.',
    ),
  }),
);
