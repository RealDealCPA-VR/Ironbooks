/**
 * wave2 sales — zod field groups shared by the A/R document schemas (invoices, sales receipts,
 * sales orders, estimates, credit memos): shipping fields (QB "Ship Date / Via / FOB / Tracking #
 * / Ship To / P.O. No."), the to-be-printed / to-be-emailed queue flags, and the credit-limit
 * override acknowledgement.
 */
import { z } from 'zod';
import { zDate, zDecimal, zUuid } from './helpers';

const shortText = z.string().max(100).nullish();

/** Ship-to snapshot: free-form address lines (line1, line2, city, state, zip, country …). */
export const zShipTo = z
  .record(z.string().max(255))
  .nullish()
  .describe(
    'Ship-to address as named text lines such as line1, line2, city, state, zip and country (each at most 255 characters).',
  );

export const shippingFields = {
  shipDate: zDate.nullish().describe('Date the goods ship, YYYY-MM-DD.'),
  shipVia: shortText.describe('How the goods ship, such as "UPS Ground" (at most 100 characters).'),
  fob: shortText.describe('FOB point printed on the form, such as "Origin" (at most 100 characters).'),
  trackingNumber: shortText.describe('Carrier tracking number (at most 100 characters).'),
  shipTo: zShipTo,
  poNumber: shortText.describe("The customer's own purchase order number (at most 100 characters)."),
};

export const sendFlagFields = {
  toBePrinted: z.boolean().optional().describe('True to put the form in the queue of forms to print later.'),
  toBeEmailed: z.boolean().optional().describe('True to put the form in the queue of forms to email later.'),
};

/** salesar (B8): the Customer Message list entry printed at the foot of a sales form. */
export const customerMessageField = {
  customerMessageId: zUuid
    .nullish()
    .describe('Id of a Customer Message list entry printed at the foot of the form; on an edit, leave out to keep it.'),
};

/** The user saw the "over credit limit" warning and chose to save anyway. */
export const creditLimitOverrideField = {
  overrideCreditLimit: z
    .boolean()
    .optional()
    .describe(
      'Send true only after the app warned that this sale puts the customer over their credit limit, to save it anyway.',
    ),
  /** Warn (NEGATIVE_STOCK, with fixes) when an inventory line sells more than is on hand. */
  checkStock: z
    .boolean()
    .optional()
    .describe(
      'True asks the app to warn and stop when an inventory line sells more than is on hand; send false after that warning to sell anyway.',
    ),
};

/** POST/PUT statement charge (wave2 sales C5). */
export const statementChargeSchema = z.object({
  customerId: zUuid.describe('Id of the customer charged (customer list).'),
  date: zDate.describe('Date of the charge, YYYY-MM-DD.'),
  itemId: zUuid.nullish().describe('Id of the item charged (item list); the item also supplies the income account.'),
  accountId: zUuid
    .nullish()
    .describe("Id of the income account credited (chart of accounts); leave out to use the item's account or Sales Income."),
  description: z.string().max(4000).nullish().describe('Text shown on the charge and the customer statement.'),
  quantity: zDecimal.nullish().describe('Quantity as decimal text such as "1"; leave out for 1.'),
  rate: zDecimal.describe('Price per unit as decimal text such as "125.00"; the charge is quantity times rate.'),
  dueDate: zDate
    .nullish()
    .describe("Date the charge is due, YYYY-MM-DD; leave out to work it out from the customer's terms."),
  classId: zUuid.nullish().describe('Id of a class (class list) for reports by class.'),
  jobId: zUuid.nullish().describe("Id of one of the customer's jobs (job list) for job costing."),
  overrideCreditLimit: z
    .boolean()
    .optional()
    .describe(
      'Send true only after the app warned that this charge puts the customer over their credit limit, to save it anyway.',
    ),
});
