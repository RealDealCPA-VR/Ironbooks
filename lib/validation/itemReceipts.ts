/**
 * Zod schemas for /api/item-receipts — mirrors CreateItemReceiptInput /
 * ItemReceiptLineInput / ConvertReceiptToBillOptions (lib/services/itemReceipts.ts).
 */
import { z } from 'zod';
import { zDate, zDecimal, zLines, zUuid } from './helpers';
import { inventoryLineFields } from './inventorySites';

export const itemReceiptLineSchema = z.object({
  itemId: zUuid,
  description: z.string().nullish(),
  quantity: zDecimal,
  unitCost: zDecimal,
  /** Advanced Inventory: receiving site/bin/serial/lot. */
  ...inventoryLineFields,
});

export const createItemReceiptSchema = z.object({
  vendorId: zUuid,
  date: zDate,
  reference: z.string().max(100, 'can be at most 100 characters').nullish(),
  memo: z.string().nullish(),
  purchaseOrderId: zUuid.nullish(),
  lines: zLines(itemReceiptLineSchema),
});
export type CreateItemReceiptBody = z.infer<typeof createItemReceiptSchema>;

/** POST /api/item-receipts/:id — { action: 'convert' | 'void', ... }. */
export const itemReceiptActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('convert'),
    billNumber: z.string().max(100, 'can be at most 100 characters').nullish(),
    date: zDate.optional(),
    dueDate: zDate.nullish(),
  }),
  z.object({ action: z.literal('void') }),
]);
export type ItemReceiptActionBody = z.infer<typeof itemReceiptActionSchema>;
