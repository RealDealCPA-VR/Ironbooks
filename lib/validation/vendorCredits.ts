/**
 * Zod schemas for /api/vendor-credits — mirrors CreateVendorCreditInput.
 */
import { z } from 'zod';
import { zDate, zDecimalPositive, zLines, zMoneyPositive, zUuid } from './helpers';

export const vendorCreditLineSchema = z.object({
  accountId: zUuid,
  description: z.string().nullish(),
  amount: zMoneyPositive,
});

export const createVendorCreditSchema = z.object({
  vendorId: zUuid,
  date: zDate,
  memo: z.string().nullish(),
  lines: zLines(vendorCreditLineSchema),
  // p1 fx: the vendor's currency is used; a stated rate overrides the currency list's rate.
  currency: z.string().max(3).nullish(),
  exchangeRate: zDecimalPositive.nullish(),
});
export type CreateVendorCreditBody = z.infer<typeof createVendorCreditSchema>;
