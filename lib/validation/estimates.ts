/**
 * Zod schemas for /api/estimates — mirrors CreateEstimateInput / EstimateLineInput.
 */
import { z } from 'zod';
import { zDate, zDecimal, zDocNumber, zLines, zUuid } from './helpers';
import { sendFlagFields, customerMessageField, zShipTo } from './sales';

export const estimateLineSchema = z.object({
  /** Edit only: the saved estimate line this row updates (keeps its id). */
  id: zUuid.nullish(),
  itemId: zUuid.nullish(),
  description: z.string().nullish(),
  quantity: zDecimal,
  /** Omit on item lines to have the server price the line (advanced pricing). */
  rate: zDecimal.nullish(),
  /** Defaults to true in the service. */
  taxable: z.boolean().optional(),
  /** salesar (B9): the line's Sales Tax Code; the server sets `taxable` from it. */
  salesTaxCodeId: zUuid.nullish(),
  /** Class carried onto the invoice lines billed from this estimate line. */
  classId: zUuid.nullish(),
});

export const createEstimateSchema = z.object({
  customerId: zUuid,
  /** Typed document number (e.g. "INV-1001"); blank = next number. */
  refNumber: zDocNumber,
  allowDuplicateNumber: z.boolean().nullish(),
  date: zDate,
  expirationDate: zDate.nullish(),
  taxRateId: zUuid.nullish(),
  memo: z.string().nullish(),
  shipTo: zShipTo,
  lines: zLines(estimateLineSchema),
  ...sendFlagFields,
  ...customerMessageField,
});
export type CreateEstimateBody = z.infer<typeof createEstimateSchema>;
