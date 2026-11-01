/**
 * Zod schemas for /api/credit-memos — mirrors CreateCreditMemoInput / CreditMemoLineInput.
 */
import { z } from 'zod';
import { zDate, zDecimal, zDocNumber, zLines, zUuid } from './helpers';
import { inventoryLineFields } from './inventorySites';
import { sendFlagFields, customerMessageField } from './sales';

export const creditMemoLineSchema = z.object({
  itemId: zUuid.nullish(),
  description: z.string().nullish(),
  quantity: zDecimal,
  /** Omit on item lines to price server-side (price rules / price level; lib/services/pricing.ts). */
  rate: zDecimal.nullish(),
  accountId: zUuid.nullish(),
  /** Defaults to true in the service. */
  taxable: z.boolean().optional(),
  /** salesar (B9): the line's Sales Tax Code; the server sets `taxable` from it. */
  salesTaxCodeId: zUuid.nullish(),
  /** Inventory items only: true (default) restocks; false = damaged write-off. */
  restock: z.boolean().optional(),
  /** Class and Customer:Job of the line (default: the memo's). */
  classId: zUuid.nullish(),
  jobId: zUuid.nullish(),
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
  /** Class and Customer:Job of the memo (job costing, P&L by class). Edit: omitted = kept. */
  classId: zUuid.nullish(),
  jobId: zUuid.nullish(),
  lines: zLines(creditMemoLineSchema),
  ...sendFlagFields,
  ...customerMessageField,
});
export type CreateCreditMemoBody = z.infer<typeof createCreditMemoSchema>;
