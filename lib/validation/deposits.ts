/**
 * Zod schemas for /api/deposits — mirrors CreateDepositInput.
 */
import { z } from 'zod';
import { zDate, zDecimalPositive, zMoneyPositive, zUuid } from './helpers';

export const extraDepositLineSchema = z.object({
  accountId: zUuid,
  amount: zMoneyPositive,
  description: z.string().nullish(),
});

export const cashBackSchema = z.object({
  accountId: zUuid,
  amount: zMoneyPositive,
  memo: z.string().nullish(),
});

export const createDepositSchema = z
  .object({
    depositAccountId: zUuid,
    date: zDate,
    paymentIds: z.array(zUuid).optional(),
    salesReceiptIds: z.array(zUuid).optional(),
    invoicePaymentIds: z.array(zUuid).optional(),
    extraLines: z.array(extraDepositLineSchema).optional(),
    cashBack: cashBackSchema.nullish(),
    memo: z.string().nullish(),
    // p1 fx: foreign-currency bank account — home units per 1 unit (default: list rate)
    exchangeRate: zDecimalPositive.nullish(),
  })
  .refine(
    (d) =>
      (d.paymentIds?.length ?? 0) +
        (d.salesReceiptIds?.length ?? 0) +
        (d.invoicePaymentIds?.length ?? 0) +
        (d.extraLines?.length ?? 0) >
      0,
    { message: 'Provide at least one of paymentIds, salesReceiptIds, or extraLines.' },
  );
export type CreateDepositBody = z.infer<typeof createDepositSchema>;
