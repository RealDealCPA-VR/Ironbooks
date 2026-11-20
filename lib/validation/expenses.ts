/**
 * Zod schemas for /api/expenses — mirrors CreateExpenseInput / ExpenseLineInput.
 */
import { z } from 'zod';
import { zDate, zDecimal, zLines, zMoney, zUuid } from './helpers';
import { inventoryLineFields } from './inventorySites';

export const expenseLineSchema = z
  .object({
    /** Expenses tab: GL account. Items tab: optional override for non-inventory items. */
    accountId: zUuid
      .nullish()
      .describe('Id of the expense or asset account charged (chart of accounts); required unless itemId is given.'),
    /** Items tab (wave2 D2). */
    itemId: zUuid.nullish().describe('Id of the item bought (item list); inventory items are received into stock.'),
    quantity: zDecimal.nullish().describe('Units bought as decimal text above zero such as "2"; item lines only.'),
    unitCost: zDecimal.nullish().describe('Cost per unit on item lines, as decimal text such as "12.50".'),
    description: z.string().nullish().describe('Text saved on the line.'),
    /** Positive normally; all-negative lines flip into a credit-card credit. */
    amount: zMoney
      .nullish()
      .describe('Line amount as decimal text such as "125.00"; required on account lines, and when every line is negative the charge becomes a card credit.'),
    classId: zUuid.nullish().describe('Id of a class (class list) for reports by class.'),
    customerId: zUuid
      .nullish()
      .describe('Id of a customer (customer list) this cost is for, which makes the line billable to them.'),
    jobId: zUuid.nullish().describe("Id of one of that customer's jobs (job list), for job costing."),
    /** Advanced Inventory: receiving site/bin/serial/lot (inventory item lines only). */
    ...inventoryLineFields,
  })
  .refine((l) => Boolean(l.accountId) || Boolean(l.itemId), {
    message: 'Pick an account or an item.',
    path: ['accountId'],
  })
  .refine((l) => Boolean(l.itemId) || (l.amount !== undefined && l.amount !== null), {
    message: 'amount is required',
    path: ['amount'],
  });

export const createExpenseSchema = z
  .object({
    vendorId: zUuid.nullish().describe('Id of the vendor paid (vendor list); give a vendorId, an otherNameId or a payeeName.'),
    /** B3: payee from the Other Names list (instead of a vendor). */
    otherNameId: zUuid
      .nullish()
      .describe('Id of the payee from the Other Names list, used instead of a vendor (never both).'),
    payeeName: z
      .string()
      .max(255, 'can be at most 255 characters')
      .nullish()
      .describe('Payee name typed as text, when the payee is on no list (at most 255 characters).'),
    date: zDate.describe('Date of the check, cash payment or card charge, YYYY-MM-DD.'),
    method: z
      .enum(['check', 'cash', 'credit_card'], {
        errorMap: () => ({ message: "method must be 'check', 'cash', or 'credit_card'" }),
      })
      .describe('check writes a check, cash records a cash payment, credit_card records a card charge.'),
    reference: z
      .string()
      .max(100, 'can be at most 100 characters')
      .nullish()
      .describe('Check number or other reference; for a check, leave out to use the next check number unless toPrint is true.'),
    paymentAccountId: zUuid.describe(
      'Id of the account the money comes from (chart of accounts): a bank or cash account, or a credit card account for card charges.',
    ),
    memo: z.string().nullish().describe('Internal note saved with the transaction.'),
    toPrint: z
      .boolean()
      .optional()
      .describe('Checks only: true puts the check in the print queue, and its number is given when it is printed.'),
    isRefund: z
      .boolean()
      .optional()
      .describe('Credit card only: true records a refund or credit from the vendor instead of a charge.'),
    /** Multi-currency (defaults from the payment account / vendor). */
    currency: z
      .string()
      .max(3)
      .nullish()
      .describe("3-letter currency code such as \"EUR\"; leave out for the payment account's or vendor's currency."),
    exchangeRate: zDecimal
      .nullish()
      .describe('Home-currency units per 1 unit of the transaction currency, as decimal text such as "1.10"; leave out for the currency list rate.'),
    /** The user saw the duplicate check-number warning and chose to keep the number. */
    allowDuplicateNumber: z
      .boolean()
      .optional()
      .describe('Send true only after the app warned that this check number is already used on the account, to keep it.'),
    /** Edits: the user confirmed QB's "this transaction has been reconciled" warning (reconciledEdits.ts). */
    allowReconciledEdit: z
      .boolean()
      .optional()
      .describe('Edits only: send true only after the app warned that this transaction is reconciled with a statement, to save the change anyway.'),
    lines: zLines(expenseLineSchema).describe('What was bought, each line an account or an item; at least one.'),
  })
  .refine((e) => Boolean(e.vendorId) || Boolean(e.otherNameId) || Boolean(e.payeeName?.trim()), {
    message: 'Provide a vendorId, an otherNameId or a payeeName.',
    path: ['payeeName'],
  })
  .refine((e) => !(e.vendorId && e.otherNameId), {
    message: 'Pick either a vendor or an Other Names entry as the payee, not both.',
    path: ['otherNameId'],
  });
export type CreateExpenseBody = z.infer<typeof createExpenseSchema>;
