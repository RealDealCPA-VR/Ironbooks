/**
 * Zod schemas for /api/sales-orders — mirrors CreateSalesOrderInput /
 * SalesOrderLineInput and the /:id action dispatch (convert / status)
 * (lib/services/salesOrders.ts).
 */
import { z } from 'zod';
import { zDate, zDecimal, zDocNumber, zLines, zUuid } from './helpers';
import { sendFlagFields, customerMessageField, shippingFields } from './sales';

export const salesOrderLineSchema = z.object({
  /** Edit only: the existing line this row updates (keeps its invoiced quantity). */
  id: zUuid
    .nullish()
    .describe('Edits only: id of the saved order line this row updates, so its invoiced quantity is kept; leave out for a new line.'),
  itemId: zUuid.nullish().describe('Id of the item ordered (item list); it supplies the price and the income account.'),
  description: z.string().nullish().describe('Text printed on the line.'),
  quantity: zDecimal.describe('Quantity ordered as decimal text, such as "2" or "1.5".'),
  /** Omit on item lines to have the server price the line (advanced pricing). */
  rate: zDecimal
    .nullish()
    .describe('Price per unit as decimal text such as "125.00"; leave out on an item line to use the price the app works out.'),
  /** QB "Tax" column; defaults to true. */
  taxable: z.boolean().optional().describe('Whether sales tax applies to the line; leave out for true.'),
  /** salesar (B9): the line's Sales Tax Code; the server sets `taxable` from it. */
  salesTaxCodeId: zUuid
    .nullish()
    .describe('Id of a Sales Tax Code list entry such as "Tax" or "Non"; when given it decides whether the line is taxable.'),
});

export const createSalesOrderSchema = z.object({
  customerId: zUuid.describe('Id of the customer who placed the order (customer list).'),
  /** Typed document number (e.g. "INV-1001"); blank = next number. */
  refNumber: zDocNumber.describe('Sales order number such as "SO-1001"; leave out or blank to use the next number.'),
  allowDuplicateNumber: z
    .boolean()
    .nullish()
    .describe('Send true only after the app warned that this sales order number is already used, to save it anyway.'),
  date: zDate.describe('Order date, YYYY-MM-DD.'),
  memo: z.string().nullish().describe('Internal note saved with the order.'),
  /** Create: omitted → the customer's tax item; null → no tax. Edit: omitted or null → no tax. */
  taxRateId: zUuid
    .nullish()
    .describe(
      "Id of the sales tax item (sales tax list); on a new order leave it out to use the customer's own tax item or send null for no tax, and on an edit send it again to keep it, because leaving it out removes the tax.",
    ),
  lines: zLines(salesOrderLineSchema).describe('Order lines; at least one.'),
  ...shippingFields,
  ...sendFlagFields,
  ...customerMessageField,
});
export type CreateSalesOrderBody = z.infer<typeof createSalesOrderSchema>;

/** Per-line partial conversion request ({ lineId, quantity }). */
export const convertLineSchema = z.object({
  lineId: zUuid.describe('Id of the sales order line to invoice.'),
  quantity: zDecimal.describe('Quantity of that line to invoice now, as decimal text such as "2".'),
});

/** POST /api/sales-orders/:id — { action: 'convert' | 'status', ... }. */
export const salesOrderActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('convert').describe('convert turns the sales order into an invoice.'),
    /** Omitted → invoice the full remaining quantity of every line. */
    lines: zLines(convertLineSchema)
      .optional()
      .describe('The lines and quantities to invoice; leave out to invoice everything still open on the order.'),
    date: zDate.optional().describe('Invoice date, YYYY-MM-DD; leave out for today.'),
    overrideCreditLimit: z
      .boolean()
      .optional()
      .describe('Send true only after the app warned that the invoice puts the customer over their credit limit, to save it anyway.'),
  }),
  z.object({
    action: z.literal('status').describe('status changes the order status without invoicing.'),
    status: z.enum(['open', 'closed', 'void']).describe('New status of the sales order.'),
  }),
]);
export type SalesOrderActionBody = z.infer<typeof salesOrderActionSchema>;
