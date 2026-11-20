/**
 * Zod schemas for /api/transfers — mirrors CreateTransferInput.
 */
import { z } from 'zod';
import { zDate, zDecimalPositive, zMoney, zMoneyPositive, zUuid } from './helpers';

export const createTransferSchema = z
  .object({
    date: zDate.describe('Transfer date, YYYY-MM-DD.'),
    fromAccountId: zUuid.describe('Id of the bank, cash or card account the money leaves (chart of accounts).'),
    toAccountId: zUuid.describe('Id of the account the money goes to (chart of accounts); must differ from fromAccountId.'),
    amount: zMoneyPositive.describe("Amount moved, in the from account's currency, as decimal text above zero such as \"500.00\"."),
    memo: z.string().nullish().describe('Note saved with the transfer.'),
    // p1 fx: foreign-currency accounts (see lib/services/transfers.ts)
    exchangeRate: zDecimalPositive
      .nullish()
      .describe('Foreign-currency accounts only: home units per 1 unit, or between two currencies, to-currency units per 1 from-currency unit.'),
    toAmount: zMoneyPositive
      .nullish()
      .describe("Between two currencies only: the amount that arrived, in the to account's currency, as decimal text such as \"450.00\"."),
    homeAmount: zMoney
      .nullish()
      .describe('Foreign-currency accounts only: the home-currency value of the transfer, replacing the one the app works out.'),
    /** Edits: the user confirmed QB's "this transaction has been reconciled" warning (reconciledEdits.ts). */
    allowReconciledEdit: z
      .boolean()
      .optional()
      .describe('Edits only: send true only after the app warned that this transfer is reconciled with a statement, to save the change anyway.'),
  })
  .refine((t) => t.fromAccountId !== t.toAccountId, {
    message: 'From account and to account must be different.',
    path: ['toAccountId'],
  });
export type CreateTransferBody = z.infer<typeof createTransferSchema>;
