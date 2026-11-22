/**
 * Zod schemas for /api/vendor-credits — mirrors CreateVendorCreditInput.
 *
 * p1 purchases: a line is an Expenses-tab line (accountId + amount) or an Items-tab line
 * (itemId + quantity, with unitCost and/or amount — returned items). Both may carry Class and
 * Customer:Job. The credit has the vendor's Ref. No.
 */
import { z } from 'zod';
import { zDate, zDecimalPositive, zLenient, zLines, zMoneyPositive, zUuid } from './helpers';
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
    // lib/services/vendorCredits.ts updateVendorCredit: on an edit a blank rate keeps the credit's
    // saved rate, not today's list rate. No condition is needed here: the edit refuses a vendor
    // or currency change that would move the credit to another currency.
    .describe(
      "Home-currency units per 1 unit of the vendor currency, as decimal text such as \"1.10\"; on a new credit leave it out for the currency list's rate, and on an edit leaving it out keeps the saved rate.",
    ),
  /** Edits: the user confirmed QB's "this transaction has been reconciled" warning (reconciledEdits.ts). */
  allowReconciledEdit: z
    .boolean()
    .optional()
    .describe('Edits only: send true only after the app warned that this credit is reconciled, to save the change anyway.'),
});
export type CreateVendorCreditBody = z.infer<typeof createVendorCreditSchema>;

/**
 * POST /api/vendor-credits/:id — apply the credit to a bill, take an application off again, or
 * record a refund from the vendor.
 *
 * The route reads this body by hand, and its own checks answer first with the messages they always
 * gave. The schema is checked after them: it says what each field is, for agents (plan §6.3), and
 * refuses only a value the service could not use anyway (an id that is not text, an amount that is
 * not a number). Fields the handler converts or checks itself are zLenient, so what the route
 * accepts is unchanged.
 */
const vendorCreditAmount = z
  .union([z.string(), z.number()], { invalid_type_error: 'must be an amount' })
  .describe('Amount of the credit, as decimal text such as "125.00".');
const applicationDate = zLenient(z.union([z.string(), z.number()]).nullable()).describe(
  'Date it takes effect, YYYY-MM-DD; leave out for today. It can never be earlier than the credit or the bill.',
);

export const vendorCreditActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('apply').describe("apply: use the credit to pay part of one of the vendor's open bills."),
    billId: z.string().min(1).describe("Id of the vendor's open bill the credit pays."),
    amount: vendorCreditAmount.describe('Amount of the credit applied, as decimal text such as "125.00"; at most what is left on the credit and open on the bill.'),
    date: applicationDate,
  }),
  z.object({
    action: z.literal('unapply').describe('unapply: take back an amount applied to a bill earlier.'),
    billId: z.string().min(1).describe('Id of the bill the credit was applied to.'),
    amount: vendorCreditAmount.describe('Amount to take back, as decimal text such as "125.00"; at most what was applied to that bill.'),
    date: applicationDate.describe('Date it takes effect, YYYY-MM-DD; leave out for today. It can never be earlier than the day the credit was applied.'),
  }),
  z.object({
    action: z.literal('refund').describe('refund: record money the vendor paid back for the credit.'),
    bankAccountId: z.string().min(1).describe('Id of the bank or cash account the refund is deposited to (chart of accounts).'),
    amount: vendorCreditAmount.describe('Amount refunded, as decimal text such as "125.00"; at most what is left on the credit.'),
    date: zLenient(z.union([z.string(), z.number()]).nullable()).describe(
      "Date of the refund, YYYY-MM-DD; leave out for today. It can never be earlier than the credit's date.",
    ),
    memo: zLenient(z.string().nullable()).describe('Memo saved with the refund; leave out for none.'),
    exchangeRate: zLenient(z.union([z.string(), z.number()]).nullable()).describe(
      "Foreign-currency credits only: home-currency units per 1 unit on the refund day, as decimal text such as \"1.10\"; leave out for the currency list's rate.",
    ),
  }),
]);
