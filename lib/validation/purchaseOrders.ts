/**
 * Zod schemas for /api/purchase-orders — mirrors CreatePurchaseOrderInput /
 * PurchaseOrderLineInput and the /:id action dispatch (convert / void / close)
 * (lib/services/purchaseOrders.ts).
 */
import { z } from 'zod';
import { zDate, zDecimal, zDocNumber, zLines, zUuid } from './helpers';

export const purchaseOrderLineSchema = z.object({
  itemId: zUuid.nullish().describe('Id of the item ordered (item list); inventory items are received into stock when billed.'),
  /** Required by the service unless itemId is set. */
  accountId: zUuid
    .nullish()
    .describe('Id of the expense or asset account charged when the order is billed (chart of accounts); required unless itemId is given.'),
  description: z.string().nullish().describe('Text printed on the line.'),
  quantity: zDecimal.describe('Quantity ordered as decimal text, such as "10".'),
  rate: zDecimal.describe('Cost per unit as decimal text, such as "12.50".'),
  // purchbank: QB Customer:Job and Class columns (carried onto the bill)
  customerId: zUuid
    .nullish()
    .describe('Id of a customer (customer list) this purchase is for; carried onto the bill so it can be billed to them.'),
  jobId: zUuid.nullish().describe("Id of one of that customer's jobs (job list); carried onto the bill."),
  classId: zUuid.nullish().describe('Id of a class (class list); carried onto the bill.'),
});

/** purchbank: P.O. Ship To address (each line at most 255 characters). */
export const poShipToSchema = z.object({
  name: z.string().max(255).nullish().describe('Name on the ship-to address.'),
  line1: z.string().max(255).nullish().describe('First street line.'),
  line2: z.string().max(255).nullish().describe('Second street line.'),
  city: z.string().max(255).nullish().describe('City.'),
  state: z.string().max(255).nullish().describe('State or province.'),
  zip: z.string().max(255).nullish().describe('ZIP or postal code.'),
  country: z.string().max(255).nullish().describe('Country.'),
});

export const createPurchaseOrderSchema = z.object({
  vendorId: zUuid.describe('Id of the vendor the order goes to (vendor list).'),
  /** Typed document number (e.g. "INV-1001"); blank = next number. */
  refNumber: zDocNumber.describe('Purchase order number such as "PO-1001"; leave out or blank to use the next number.'),
  allowDuplicateNumber: z
    .boolean()
    .nullish()
    .describe('Send true only after the app warned that this purchase order number is already used, to save it anyway.'),
  date: zDate.describe('Order date, YYYY-MM-DD.'),
  expectedDate: zDate.nullish().describe('Date the goods are expected, YYYY-MM-DD.'),
  memo: z.string().nullish().describe('Internal note saved with the order.'),
  lines: zLines(purchaseOrderLineSchema).describe('Order lines; at least one.'),
  /** purchbank: typed Ship To (null = the company address; omitted on an edit = kept). */
  shipTo: poShipToSchema
    .nullish()
    .describe("Where the vendor ships the goods; null ships to the company's address, and on an edit leaving it out keeps it."),
  /** purchbank: drop ship to this customer (their shipping address when none is typed). */
  shipToCustomerId: zUuid
    .nullish()
    .describe("Id of a customer (customer list) to drop ship to; their shipping address is used when shipTo is not given."),
});
export type CreatePurchaseOrderBody = z.infer<typeof createPurchaseOrderSchema>;

/** PATCH /api/purchase-orders/:id — full edit; existing lines carry their id. */
export const updatePurchaseOrderSchema = createPurchaseOrderSchema.extend({
  lines: zLines(
    purchaseOrderLineSchema.extend({
      id: zUuid.nullish().describe('Id of the saved order line this row updates; leave out for a new line.'),
    }),
  ).describe('All lines of the order, replacing the saved ones; at least one.'),
});

/** Per-line partial billing request ({ lineId, quantity }). */
export const poBillLineSchema = z.object({
  lineId: zUuid.describe('Id of the purchase order line to bill.'),
  quantity: zDecimal.describe('Quantity of that line to bill now, as decimal text such as "5".'),
});

/** POST /api/purchase-orders/:id — { action: 'convert' | 'void' | 'close', ... }. */
export const purchaseOrderActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('convert').describe('convert turns the purchase order into a bill.'),
    /** Omitted → bill the full remaining quantity of every line. */
    lines: zLines(poBillLineSchema)
      .optional()
      .describe('The lines and quantities to bill; leave out to bill everything still open on the order.'),
    date: zDate.optional().describe('Bill date, YYYY-MM-DD; leave out for today.'),
    billNumber: z.string().nullish().describe("The vendor's own bill number."),
    /** The user confirmed QB's "this vendor already has a bill with that reference number" warning. */
    allowDuplicateNumber: z
      .boolean()
      .optional()
      .describe('Send true only after the app warned that this vendor already has a bill with this number, to save it anyway.'),
  }),
  z.object({ action: z.literal('void').describe('void cancels the purchase order.') }),
  z.object({ action: z.literal('close').describe('close marks the purchase order as finished, leaving what is open unbilled.') }),
]);
export type PurchaseOrderActionBody = z.infer<typeof purchaseOrderActionSchema>;
