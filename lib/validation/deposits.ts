/**
 * Zod schemas for /api/deposits — mirrors CreateDepositInput.
 */
import { z } from 'zod';
import { zDate, zDecimalPositive, zMoneyPositive, zUuid } from './helpers';

export const extraDepositLineSchema = z.object({
  accountId: zUuid.describe('Id of the account credited by this line (chart of accounts), such as an owner contribution equity account.'),
  amount: zMoneyPositive.describe('Amount deposited on this line, as decimal text above zero such as "500.00".'),
  description: z.string().nullish().describe('Text saved on the line.'),
  /** QB "Received From": the customer / vendor / employee / Other Name the money came from. */
  entityType: z
    .enum(['customer', 'vendor', 'employee', 'other'])
    .nullish()
    .describe('Which list the payer is on (other means the Other Names list); goes with entityId.'),
  entityId: zUuid.nullish().describe('Id of the customer, vendor, employee or Other Names entry the money came from.'),
});

export const cashBackSchema = z.object({
  accountId: zUuid.describe('Id of the account that receives the cash kept out of the deposit (chart of accounts), such as Petty Cash.'),
  amount: zMoneyPositive.describe('Cash kept out of the deposit, as decimal text above zero such as "50.00".'),
  memo: z.string().nullish().describe('Note saved with the cash back.'),
});

export const createDepositSchema = z
  .object({
    depositAccountId: zUuid.describe('Id of the bank account the money goes into (chart of accounts); not Undeposited Funds.'),
    date: zDate.describe('Deposit date, YYYY-MM-DD.'),
    paymentIds: z
      .array(zUuid)
      .optional()
      .describe('Ids of received customer payments waiting in Undeposited Funds to include.'),
    salesReceiptIds: z
      .array(zUuid)
      .optional()
      .describe('Ids of sales receipts waiting in Undeposited Funds to include.'),
    invoicePaymentIds: z
      .array(zUuid)
      .optional()
      .describe('Ids of invoices whose payment lines are waiting in Undeposited Funds to include.'),
    extraLines: z
      .array(extraDepositLineSchema)
      .optional()
      .describe('Other money deposited that is not waiting in Undeposited Funds, such as an owner contribution or a refund.'),
    cashBack: cashBackSchema.nullish().describe('Cash kept out of the deposit, which lowers the amount that reaches the bank.'),
    memo: z.string().nullish().describe('Internal note saved with the deposit.'),
    // p1 fx: foreign-currency bank account — home units per 1 unit (default: list rate)
    exchangeRate: zDecimalPositive
      .nullish()
      .describe('Foreign-currency bank accounts only: home-currency units per 1 unit of the account currency, as decimal text such as "1.10".'),
    /** Edits: the user confirmed QB's "this transaction has been reconciled" warning (reconciledEdits.ts). */
    allowReconciledEdit: z
      .boolean()
      .optional()
      .describe('Edits only: send true only after the app warned that this deposit is reconciled with a bank statement, to save the change anyway.'),
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
