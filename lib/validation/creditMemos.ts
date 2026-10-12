/**
 * Zod schemas for /api/credit-memos — mirrors CreateCreditMemoInput / CreditMemoLineInput.
 */
import { z } from 'zod';
import { zDate, zDecimal, zDocNumber, zLines, zUuid } from './helpers';
import { inventoryLineFields } from './inventorySites';
import { sendFlagFields } from './sales';

export const creditMemoLineSchema = z.object({
  itemId: zUuid.nullish(),
  description: z.string().nullish(),
  quantity: zDecimal,
  rate: zDecimal,
  accountId: zUuid.nullish(),
  /** Defaults to true in the service. */
  taxable: z.boolean().optional(),
  /** Inventory items only: true (default) restocks; false = damaged write-off. */
  restock: z.boolean().optional(),
  /** Advanced Inventory: site/bin/serial/lot returned goods go back to. */
  ...inventoryLineFields,
});

export const createCreditMemoSchema = z.object({
  customerId: zUuid,
  /** Typed document number (e.g. "INV-1001"); blank = next number. */
  refNumber: zDocNumber,
  allowDuplicateNumber: z.boolean().nullish(),
  date: zDate,
  taxRateId: zUuid.nullish(),
  memo: z.string().nullish(),
  lines: zLines(creditMemoLineSchema),
  ...sendFlagFields,
});
export type CreateCreditMemoBody = z.infer<typeof createCreditMemoSchema>;
