/**
 * Zod schemas for /api/credit-memos — mirrors CreateCreditMemoInput / CreditMemoLineInput.
 */
import { z } from 'zod';
import { zDate, zDecimal, zDocNumber, zLenient, zLines, zUuid } from './helpers';
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

/**
 * POST /api/credit-memos/:id — apply the credit to an invoice, refund it, or undo one application.
 *
 * The route reads this body by hand, and its own checks answer first with the messages they always
 * gave. The schema is checked after them: it says what each field is, for agents (plan §6.3), and
 * refuses only a value the service could not use anyway (an id that is not text, an amount that is
 * not a number). Fields the handler converts or checks itself are zLenient, so what the route
 * accepts is unchanged.
 */
const creditAmount = z
  .union([z.string(), z.number()], { invalid_type_error: 'must be an amount' })
  .describe('Amount of the credit used, as decimal text such as "125.00"; at most what is left on the credit memo.');

export const creditMemoActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('apply').describe("apply: use the credit to pay one of the customer's open invoices."),
    invoiceId: z.string().min(1).describe("Id of the customer's open invoice the credit pays."),
    amount: creditAmount,
    date: zLenient(z.string().nullable()).describe(
      "Date of the application, YYYY-MM-DD; leave out to date it on the later of the credit memo's and the invoice's dates.",
    ),
  }),
  z.object({
    action: z.literal('refund').describe('refund: pay the credit back to the customer from a bank account.'),
    bankAccountId: z.string().min(1).describe('Id of the bank or cash account the refund is paid from (chart of accounts), in the home currency.'),
    amount: creditAmount,
    date: zLenient(z.string().nullable()).describe('Date of the refund, YYYY-MM-DD; leave out for today.'),
    memo: zLenient(z.string().nullable()).describe('Memo saved with the refund; leave out for none.'),
  }),
  z.object({
    action: z.literal('unapply').describe('unapply: undo one earlier application of this credit memo.'),
    applicationId: z.string().min(1).describe('Id of the application to undo (GET /api/credit-memos/:id, applications).'),
  }),
]);
