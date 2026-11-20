/**
 * Zod schemas for /api/estimates — mirrors CreateEstimateInput / EstimateLineInput.
 */
import { z } from 'zod';
import { zDate, zDecimal, zDocNumber, zLines, zUuid } from './helpers';
import { sendFlagFields, customerMessageField, zShipTo } from './sales';

export const estimateLineSchema = z.object({
  /** Edit only: the saved estimate line this row updates (keeps its id). */
  id: zUuid.nullish().describe('Edits only: id of the saved estimate line this row updates; leave out for a new line.'),
  itemId: zUuid.nullish().describe('Id of the item quoted (item list); it supplies the price and the income account.'),
  description: z.string().nullish().describe('Text printed on the line.'),
  quantity: zDecimal.describe('Quantity quoted as decimal text, such as "2" or "1.5".'),
  /** Omit on item lines to have the server price the line (advanced pricing). */
  rate: zDecimal
    .nullish()
    .describe('Price per unit as decimal text such as "125.00"; leave out on an item line to use the price the app works out.'),
  /** Defaults to true in the service. */
  taxable: z.boolean().optional().describe('Whether sales tax applies to the line; leave out for true.'),
  /** salesar (B9): the line's Sales Tax Code; the server sets `taxable` from it. */
  salesTaxCodeId: zUuid
    .nullish()
    .describe('Id of a Sales Tax Code list entry such as "Tax" or "Non"; when given it decides whether the line is taxable.'),
  /** Class carried onto the invoice lines billed from this estimate line. */
  classId: zUuid.nullish().describe('Id of a class (class list) carried onto the invoice lines billed from this line.'),
});

export const createEstimateSchema = z.object({
  customerId: zUuid.describe('Id of the customer the estimate is for (customer list).'),
  /** Typed document number (e.g. "INV-1001"); blank = next number. */
  refNumber: zDocNumber.describe('Estimate number such as "EST-1001"; leave out or blank to use the next number.'),
  allowDuplicateNumber: z
    .boolean()
    .nullish()
    .describe('Send true only after the app warned that this estimate number is already used, to save it anyway.'),
  date: zDate.describe('Estimate date, YYYY-MM-DD.'),
  expirationDate: zDate.nullish().describe('Date the estimate expires, YYYY-MM-DD.'),
  // Same schema for create and edit: create fills a left-out tax item from the customer, an edit
  // saves `taxRateId ?? null` (lib/services/estimates.ts), so the text has to say both.
  taxRateId: zUuid
    .nullish()
    .describe(
      "Id of the sales tax item (sales tax list) charged on taxable lines; on a new estimate leave it out to use the customer's own tax item or send null for no tax, and on an edit send it again to keep it, because leaving it out removes the tax.",
    ),
  memo: z.string().nullish().describe('Internal note saved with the estimate.'),
  shipTo: zShipTo.describe(
    "Ship-to address as named text lines such as line1, city, state and zip; leave out on a new estimate for the customer's default ship-to.",
  ),
  lines: zLines(estimateLineSchema).describe('Estimate lines; at least one.'),
  ...sendFlagFields,
  ...customerMessageField,
});
export type CreateEstimateBody = z.infer<typeof createEstimateSchema>;
