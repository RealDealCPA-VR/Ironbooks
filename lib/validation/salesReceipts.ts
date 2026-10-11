/**
 * Zod schemas for /api/sales-receipts — mirrors CreateSalesReceiptInput.
 */
import { z } from 'zod';
import { zDate, zDecimal, zLines, zUuid } from './helpers';
import { inventoryLineFields } from './inventorySites';

export const salesReceiptLineSchema = z.object({
  itemId: zUuid.nullish(),
  accountId: zUuid.nullish(),
  description: z.string().nullish(),
  quantity: zDecimal,
  /** Omit on item lines to have the server price the line (advanced pricing). */
  rate: zDecimal.nullish(),
  /** Defaults to true (matches prior route behavior). */
  taxable: z.boolean().default(true),
  taxRateId: zUuid.nullish(),
  /** Advanced Inventory: site/bin/serial/lot the stock is sold from. */
  ...inventoryLineFields,
});

export const createSalesReceiptSchema = z.object({
  /** Optional — walk-in / counter sales have no customer. */
  customerId: zUuid.nullish(),
  date: zDate,
  taxRateId: zUuid.nullish(),
  depositAccountId: zUuid.nullish(),
  /** Defaults to 'cash' in the service. */
  method: z
    .enum(['cash', 'check', 'credit_card', 'ach', 'bank_transfer', 'other'], {
      errorMap: () => ({
        message: 'method must be cash, check, credit_card, ach, bank_transfer, or other',
      }),
    })
    .nullish(),
  reference: z.string().nullish(),
  memo: z.string().nullish(),
  classId: zUuid.nullish(),
  lines: zLines(salesReceiptLineSchema),
});
export type CreateSalesReceiptBody = z.infer<typeof createSalesReceiptSchema>;
