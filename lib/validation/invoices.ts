/**
 * Zod schemas for /api/invoices — mirrors CreateInvoiceInput / InvoiceLineInput
 * (lib/services/invoices.ts) and BillableSelection (lib/services/billables.ts).
 */
import { z } from 'zod';
import { zDate, zDecimal, zLines, zMoney, zUuid } from './helpers';
import { inventoryLineFields } from './inventorySites';
import { creditLimitOverrideField, sendFlagFields, shippingFields } from './sales';

export const invoiceLineSchema = z.object({
  itemId: zUuid.nullish(),
  accountId: zUuid.nullish(),
  description: z.string().nullish(),
  quantity: zDecimal,
  /** Omit on item lines to have the server price the line (advanced pricing). */
  rate: zDecimal.nullish(),
  /** Defaults to true in the service. */
  taxable: z.boolean().optional(),
  taxRateId: zUuid.nullish(),
  classId: zUuid.nullish(),
  jobId: zUuid.nullish(),
  /** Advanced Inventory: site/bin/serial/lot the stock is sold from. */
  ...inventoryLineFields,
});

/** Optional billable time & costs pulled onto the invoice (route-level concern). */
export const billableSelectionSchema = z.object({
  billLineIds: z.array(zUuid).optional(),
  expenseLineIds: z.array(zUuid).optional(),
  timeEntryIds: z.array(zUuid).optional(),
  markupPercent: zDecimal.nullish(),
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
  customerId: zUuid,
  date: zDate,
  dueDate: zDate.nullish(),
  taxRateId: zUuid.nullish(),
  classId: zUuid.nullish(),
  jobId: zUuid.nullish(),
  salesRepId: zUuid.nullish(),
  discount: zMoney.nullish(),
  discountType: z.enum(['amount', 'percent']).nullish(),
  retainagePercent: zDecimal.nullish(),
  memo: z.string().nullish(),
  currency: z.string().nullish(),
  exchangeRate: zDecimal.nullish(),
  customFields: z.record(z.string()).nullish(),
  // wave2 sales: shipping fields, send queues, credit-limit override
  ...shippingFields,
  ...sendFlagFields,
  ...creditLimitOverrideField,
};

/**
 * POST /api/invoices body. `lines` may be empty ONLY when a non-empty
 * billables selection supplies the lines (createInvoiceWithBillables).
 */
export const createInvoiceBodySchema = z
  .object({
    ...invoiceCoreFields,
    status: z.enum(['draft', 'open']).nullish(),
    lines: z.array(invoiceLineSchema, {
      required_error: 'lines are required',
      invalid_type_error: 'lines must be an array',
    }),
    billables: billableSelectionSchema.nullish(),
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
  lines: zLines(invoiceLineSchema),
});
export type UpdateInvoiceBody = z.infer<typeof updateInvoiceSchema>;
