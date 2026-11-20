/**
 * Zod schemas for /api/credit-memos — mirrors CreateCreditMemoInput / CreditMemoLineInput.
 */
import { z } from 'zod';
import { zDate, zDecimal, zDocNumber, zLines, zUuid } from './helpers';
import { inventoryLineFields } from './inventorySites';
import { sendFlagFields, customerMessageField } from './sales';

export const creditMemoLineSchema = z.object({
  itemId: zUuid.nullish().describe('Id of the item credited or returned (item list); it supplies the price and the income account.'),
  description: z.string().nullish().describe('Text printed on the line.'),
  quantity: zDecimal.describe('Quantity credited or returned as decimal text, such as "2" or "1.5".'),
  /** Omit on item lines to price server-side (price rules / price level; lib/services/pricing.ts). */
  rate: zDecimal
    .nullish()
    .describe('Price per unit as decimal text such as "125.00"; leave out on an item line to use the price the app works out.'),
  accountId: zUuid
    .nullish()
    .describe("Id of the income account the credit reduces (chart of accounts); it overrides the item's income account."),
  /** Defaults to true in the service. */
  taxable: z.boolean().optional().describe('Whether sales tax is credited back on the line; leave out for true.'),
  /** salesar (B9): the line's Sales Tax Code; the server sets `taxable` from it. */
  salesTaxCodeId: zUuid
    .nullish()
    .describe('Id of a Sales Tax Code list entry such as "Tax" or "Non"; when given it decides whether the line is taxable.'),
  /** Inventory items only: true (default) restocks; false = damaged write-off. */
  restock: z
    .boolean()
    .optional()
    .describe('Inventory items only: true (the default) puts the returned units back in stock, false writes them off as damaged.'),
  /** Class and Customer:Job of the line (default: the memo's). */
  classId: zUuid.nullish().describe("Id of a class (class list) for the line; leave out to use the credit memo's class."),
  jobId: zUuid.nullish().describe("Id of a Customer:Job (job list) for the line; leave out to use the credit memo's job."),
  /** Advanced Inventory: site/bin/serial/lot returned goods go back to. */
  ...inventoryLineFields,
});

export const createCreditMemoSchema = z.object({
  customerId: zUuid.describe('Id of the customer credited (customer list).'),
  /** Typed document number (e.g. "INV-1001"); blank = next number. */
  refNumber: zDocNumber.describe('Credit memo number such as "CM-1001"; leave out or blank to use the next number.'),
  allowDuplicateNumber: z
    .boolean()
    .nullish()
    .describe('Send true only after the app warned that this credit memo number is already used, to save it anyway.'),
  date: zDate.describe('Credit memo date, YYYY-MM-DD.'),
  // Same schema for create and edit: create fills a left-out tax item from the customer, an edit
  // saves `taxRateId ?? null` (lib/services/creditMemos.ts), so the text has to say both.
  taxRateId: zUuid
    .nullish()
    .describe(
      "Id of the sales tax item (sales tax list) credited back on taxable lines; on a new credit memo leave it out to use the customer's own tax item or send null for no tax, and on an edit send it again to keep it, because leaving it out removes the tax.",
    ),
  memo: z.string().nullish().describe('Internal note saved with the credit memo.'),
  /** Class and Customer:Job of the memo (job costing, P&L by class). Edit: omitted = kept. */
  classId: zUuid.nullish().describe('Id of a class (class list) for reports by class; on an edit, leave out to keep it.'),
  jobId: zUuid
    .nullish()
    .describe("Id of one of the customer's jobs (job list) for job costing; on an edit, leave out to keep it."),
  lines: zLines(creditMemoLineSchema).describe('Credit memo lines; at least one.'),
  ...sendFlagFields,
  ...customerMessageField,
});
export type CreateCreditMemoBody = z.infer<typeof createCreditMemoSchema>;
