/**
 * Zod schemas for /api/estimates — mirrors CreateEstimateInput / EstimateLineInput.
 */
import { z } from 'zod';
import { zDate, zDecimal, zDocNumber, zLenient, zLines, zUuid } from './helpers';
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

/**
 * POST /api/estimates/:id — convert, progress-bill or void the estimate.
 *
 * The route reads this body by hand, and its own checks answer first with the messages they always
 * gave. The schema is checked after them: it says what each field is, for agents (plan §6.3), and
 * the fields are zLenient because the handler converts any value it gets, so what the route
 * accepts is unchanged.
 */
const amountText = z.union([z.string(), z.number()]).nullable();
const overrideCreditLimit = zLenient(z.boolean()).describe(
  'Send true only after the app warned that the invoice puts the customer over their credit limit, to save it anyway.',
);

export const estimateActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('convert').describe('convert: turn the whole estimate into one invoice.'),
    overrideCreditLimit,
  }),
  z.object({
    action: z
      .literal('progress')
      .describe('progress: bill part of the estimate on a new invoice (QB progress invoicing); send percent, remaining or lines.'),
    percent: zLenient(amountText).describe('Percentage of every line to bill, such as "25"; send this, remaining or lines.'),
    remaining: zLenient(z.boolean()).describe('true bills everything not billed yet; send this, percent or lines.'),
    lines: zLenient(
      z.array(
        z.object({
          lineId: z.string().describe('Id of the estimate line (GET /api/estimates/:id, lines).'),
          percent: zLenient(amountText).describe('Percentage of the line to bill, such as "50"; send one of percent, quantity and amount.'),
          quantity: zLenient(amountText).describe('Quantity of the line to bill, as decimal text such as "2"; send one of percent, quantity and amount.'),
          amount: zLenient(amountText).describe('Amount of the line to bill, as decimal text such as "500.00"; send one of percent, quantity and amount.'),
        }),
      ),
    ).describe('Bill only these estimate lines, each by percentage, quantity or amount; send this, percent or remaining.'),
    lineAmounts: zLenient(
      z.array(
        z.object({
          lineId: z.string().describe('Id of the estimate line.'),
          amount: amountText.describe('Amount of the line to bill, as decimal text such as "500.00".'),
        }),
      ),
    ).describe('Older form of lines, by amount only; use lines instead.'),
    date: zLenient(z.union([z.string(), z.number()]).nullable()).describe('Date of the invoice, YYYY-MM-DD; leave out for today.'),
    overrideCreditLimit,
    allowOverBilling: zLenient(z.boolean()).describe(
      'Send true only after the app answered PROGRESS_OVERBILL (a line would be billed over 100%), to bill it anyway.',
    ),
  }),
  z.object({
    action: z.literal('void').describe('void: void the estimate (QB Edit > Void Estimate).'),
  }),
]);
