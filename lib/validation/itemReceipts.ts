/**
 * Zod schemas for /api/item-receipts — mirrors CreateItemReceiptInput /
 * ItemReceiptLineInput / ConvertReceiptToBillOptions (lib/services/itemReceipts.ts).
 */
import { z } from 'zod';
import { zDate, zDecimal, zLines, zUuid } from './helpers';
import { inventoryLineFields } from './inventorySites';

export const itemReceiptLineSchema = z.object({
  itemId: zUuid.describe('Id of the item received (item list).'),
  description: z.string().nullish().describe('Text saved on the line.'),
  quantity: zDecimal.describe('Units received as decimal text above zero, such as "10".'),
  unitCost: zDecimal.describe('Cost per unit as decimal text, such as "12.50"; the line amount is quantity times unitCost.'),
  /** Advanced Inventory: receiving site/bin/serial/lot. */
  ...inventoryLineFields,
});

export const createItemReceiptSchema = z.object({
  vendorId: zUuid.describe('Id of the vendor who delivered the items (vendor list).'),
  date: zDate.describe('Date the items arrived, YYYY-MM-DD.'),
  reference: z
    .string()
    .max(100, 'can be at most 100 characters')
    .nullish()
    .describe("The vendor's packing slip or reference number (at most 100 characters)."),
  memo: z.string().nullish().describe('Internal note saved with the receipt.'),
  purchaseOrderId: zUuid
    .nullish()
    .describe("Id of the vendor's purchase order being received; every line's item must be on it with enough left to receive."),
  lines: zLines(itemReceiptLineSchema).describe('The items received; at least one line.'),
});
export type CreateItemReceiptBody = z.infer<typeof createItemReceiptSchema>;

/** POST /api/item-receipts/:id — { action: 'convert' | 'void', ... }. */
export const itemReceiptActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('convert').describe('convert turns the item receipt into a bill once the vendor bill arrives.'),
    billNumber: z
      .string()
      .max(100, 'can be at most 100 characters')
      .nullish()
      .describe("The vendor's bill number; leave out to use the receipt's reference."),
    date: zDate.optional().describe("Bill date, YYYY-MM-DD; leave out for the receipt's date."),
    dueDate: zDate.nullish().describe('Date the bill is due, YYYY-MM-DD.'),
    /** The user confirmed QB's "this vendor already has a bill with that reference number" warning. */
    allowDuplicateNumber: z
      .boolean()
      .optional()
      .describe('Send true only after the app warned that this vendor already has a bill with this number, to save it anyway.'),
  }),
  z.object({ action: z.literal('void').describe('void cancels the item receipt and takes the items back out of stock.') }),
]);
export type ItemReceiptActionBody = z.infer<typeof itemReceiptActionSchema>;
