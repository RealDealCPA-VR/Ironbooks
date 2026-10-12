/**
 * Zod schemas for /api/transfers — mirrors CreateTransferInput.
 */
import { z } from 'zod';
import { zDate, zDecimalPositive, zMoney, zMoneyPositive, zUuid } from './helpers';

export const createTransferSchema = z
  .object({
    date: zDate,
    fromAccountId: zUuid,
    toAccountId: zUuid,
    amount: zMoneyPositive,
    memo: z.string().nullish(),
    // p1 fx: foreign-currency accounts (see lib/services/transfers.ts)
    exchangeRate: zDecimalPositive.nullish(),
    toAmount: zMoneyPositive.nullish(),
    homeAmount: zMoney.nullish(),
  })
  .refine((t) => t.fromAccountId !== t.toAccountId, {
    message: 'From account and to account must be different.',
    path: ['toAccountId'],
  });
export type CreateTransferBody = z.infer<typeof createTransferSchema>;
