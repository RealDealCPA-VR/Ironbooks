/**
 * Zod schemas for /api/estimates — mirrors CreateEstimateInput / EstimateLineInput.
 */
import { z } from 'zod';
import { zDate, zDecimal, zLines, zUuid } from './helpers';

export const estimateLineSchema = z.object({
  itemId: zUuid.nullish(),
  description: z.string().nullish(),
  quantity: zDecimal,
  /** Omit on item lines to have the server price the line (advanced pricing). */
  rate: zDecimal.nullish(),
  /** Defaults to true in the service. */
  taxable: z.boolean().optional(),
});

export const createEstimateSchema = z.object({
  customerId: zUuid,
  date: zDate,
  expirationDate: zDate.nullish(),
  taxRateId: zUuid.nullish(),
  memo: z.string().nullish(),
  lines: zLines(estimateLineSchema),
});
export type CreateEstimateBody = z.infer<typeof createEstimateSchema>;
