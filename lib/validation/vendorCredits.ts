/**
 * Zod schemas for /api/vendor-credits — mirrors CreateVendorCreditInput.
 *
 * p1 purchases: a line is an Expenses-tab line (accountId + amount) or an Items-tab line
 * (itemId + quantity, with unitCost and/or amount — returned items). Both may carry Class and
 * Customer:Job. The credit has the vendor's Ref. No.
 */
import { z } from 'zod';
import { zDate, zDecimalPositive, zLines, zMoneyPositive, zUuid } from './helpers';
import { inventoryLineFields } from './inventorySites';

export const vendorCreditLineSchema = z
  .object({
    // Items tab: site / bin / serial numbers / lot of the units returned (Advanced Inventory).
    ...inventoryLineFields,
    accountId: zUuid
      .nullish()
      .describe('Id of the expense or asset account the credit reduces (chart of accounts); give an account or an item.'),
    itemId: zUuid.nullish().describe('Id of the item returned to the vendor (item list); give an item or an account.'),
    quantity: zDecimalPositive.nullish().describe('Units returned as decimal text above zero such as "2"; required on item lines.'),
    unitCost: zMoneyPositive.nullish().describe('Cost per unit returned, as decimal text above zero such as "12.50".'),
    description: z.string().nullish().describe('Text saved on the line.'),
    amount: zMoneyPositive
      .nullish()
      .describe('Line amount as decimal text above zero such as "125.00"; required on account lines, and on item lines unless unitCost is given.'),
    classId: zUuid.nullish().describe('Id of a class (class list) for reports by class.'),
    customerId: zUuid.nullish().describe('Id of a customer (customer list) this credit is for, for job costing.'),
    jobId: zUuid.nullish().describe("Id of one of that customer's jobs (job list), for job costing."),
  })
  .refine((l) => Boolean(l.itemId) || Boolean(l.accountId), { message: 'Pick an account or an item.' })
  .refine((l) => Boolean(l.itemId) || l.amount != null, { message: 'Enter an amount.', path: ['amount'] })
  .refine((l) => !l.itemId || l.quantity != null, { message: 'Enter the quantity returned.', path: ['quantity'] })
  .refine((l) => !l.itemId || l.amount != null || l.unitCost != null, {
    message: 'Enter a cost or an amount for the item.',
    path: ['amount'],
  });

export const createVendorCreditSchema = z.object({
  vendorId: zUuid.describe('Id of the vendor who gave the credit (vendor list).'),
  date: zDate.describe('Credit date, YYYY-MM-DD.'),
  memo: z.string().nullish().describe('Internal note saved with the credit.'),
  refNumber: z.string().max(50).nullish().describe("The vendor's reference number for the credit (at most 50 characters)."),
  lines: zLines(vendorCreditLineSchema).describe('Credit lines, each an account or an item returned; at least one.'),
  // p1 fx: the vendor's currency is used; a stated rate overrides the currency list's rate.
  currency: z
    .string()
    .max(3)
    .nullish()
    .describe("3-letter currency code such as \"EUR\"; leave out for the vendor's currency, which it must match."),
  exchangeRate: zDecimalPositive
    .nullish()
    .describe('Home-currency units per 1 unit of the vendor currency, as decimal text such as "1.10"; leave out for the currency list rate.'),
  /** Edits: the user confirmed QB's "this transaction has been reconciled" warning (reconciledEdits.ts). */
  allowReconciledEdit: z
    .boolean()
    .optional()
    .describe('Edits only: send true only after the app warned that this credit is reconciled, to save the change anyway.'),
});
export type CreateVendorCreditBody = z.infer<typeof createVendorCreditSchema>;
