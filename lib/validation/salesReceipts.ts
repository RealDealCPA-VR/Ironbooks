/**
 * Zod schemas for /api/sales-receipts — mirrors CreateSalesReceiptInput.
 */
import { z } from 'zod';
import { zDate, zDecimal, zDocNumber, zLines, zUuid } from './helpers';
import { inventoryLineFields } from './inventorySites';
import { sendFlagFields, customerMessageField, shippingFields } from './sales';

export const salesReceiptLineSchema = z.object({
  itemId: zUuid.nullish().describe('Id of the item sold (item list); it supplies the income account and the price.'),
  accountId: zUuid
    .nullish()
    .describe("Id of the income account credited (chart of accounts); it overrides the item's income account."),
  description: z.string().nullish().describe('Text printed on the line.'),
  quantity: zDecimal.describe('Quantity sold as decimal text, such as "2" or "1.5".'),
  /** Omit on item lines to have the server price the line (advanced pricing). */
  rate: zDecimal
    .nullish()
    .describe('Price per unit as decimal text such as "125.00"; leave out on an item line to use the price the app works out.'),
  /** Defaults to true (matches prior route behavior). */
  taxable: z.boolean().default(true).describe('Whether sales tax applies to the line; leave out for true.'),
  /** salesar (B9): the line's Sales Tax Code; the server sets `taxable` from it. */
  salesTaxCodeId: zUuid
    .nullish()
    .describe('Id of a Sales Tax Code list entry such as "Tax" or "Non"; when given it decides whether the line is taxable.'),
  taxRateId: zUuid
    .nullish()
    .describe('Id of a sales tax item (sales tax list) that taxes this line instead of the receipt-level one.'),
  /** Advanced Inventory: site/bin/serial/lot the stock is sold from. */
  ...inventoryLineFields,
});

export const createSalesReceiptSchema = z.object({
  /** Optional — walk-in / counter sales have no customer. */
  customerId: zUuid.nullish().describe('Id of the customer (customer list); leave out for a walk-in sale.'),
  /** Typed document number (e.g. "INV-1001"); blank = next number. */
  refNumber: zDocNumber.describe('Sales receipt number such as "SR-1001"; leave out or blank to use the next number.'),
  allowDuplicateNumber: z
    .boolean()
    .nullish()
    .describe('Send true only after the app warned that this sales receipt number is already used, to save it anyway.'),
  /** Edits: QB's "this transaction has been reconciled" warning confirmed. */
  allowReconciledEdit: z
    .boolean()
    .nullish()
    .describe('Edits only: send true only after the app warned that this receipt is reconciled with a bank statement, to save the change anyway.'),
  date: zDate.describe('Sale date, YYYY-MM-DD.'),
  // Same schema for create and edit: create fills a left-out tax item from the customer, an edit
  // saves `taxRateId ?? null` (lib/services/salesReceipts.ts), so the text has to say both.
  taxRateId: zUuid
    .nullish()
    .describe(
      "Id of the sales tax item (sales tax list) charged on taxable lines; on a new sales receipt leave it out to use the customer's own tax item or send null for no tax, and on an edit send it again to keep it, because leaving it out removes the tax.",
    ),
  depositAccountId: zUuid
    .nullish()
    .describe('Id of the bank account the money goes to (chart of accounts); leave out to hold it in Undeposited Funds.'),
  /** Defaults to 'cash' in the service. */
  method: z
    .enum(['cash', 'check', 'credit_card', 'ach', 'bank_transfer', 'other'], {
      errorMap: () => ({
        message: 'method must be cash, check, credit_card, ach, bank_transfer, or other',
      }),
    })
    .nullish()
    .describe('How the customer paid; leave out for cash, or for the type of the payment method given.'),
  /** salesar (B7): Payment Method list entry; its type is stored as the method. */
  paymentMethodId: zUuid
    .nullish()
    .describe('Id of a Payment Method list entry such as "Visa"; its type becomes the method.'),
  reference: z.string().nullish().describe('Check number, card authorization or other payment reference.'),
  memo: z.string().nullish().describe('Internal note saved with the receipt.'),
  classId: zUuid.nullish().describe('Id of a class (class list) for reports by class.'),
  lines: zLines(salesReceiptLineSchema).describe('Sales receipt lines; at least one.'),
  ...shippingFields,
  ...sendFlagFields,
  ...customerMessageField,
});
export type CreateSalesReceiptBody = z.infer<typeof createSalesReceiptSchema>;
