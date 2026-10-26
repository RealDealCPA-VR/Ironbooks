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
    accountId: zUuid.nullish(),
    itemId: zUuid.nullish(),
    quantity: zDecimalPositive.nullish(),
    unitCost: zMoneyPositive.nullish(),
    description: z.string().nullish(),
    amount: zMoneyPositive.nullish(),
    classId: zUuid.nullish(),
    customerId: zUuid.nullish(),
    jobId: zUuid.nullish(),
  })
  .refine((l) => Boolean(l.itemId) || Boolean(l.accountId), { message: 'Pick an account or an item.' })
  .refine((l) => Boolean(l.itemId) || l.amount != null, { message: 'Enter an amount.', path: ['amount'] })
  .refine((l) => !l.itemId || l.quantity != null, { message: 'Enter the quantity returned.', path: ['quantity'] })
  .refine((l) => !l.itemId || l.amount != null || l.unitCost != null, {
    message: 'Enter a cost or an amount for the item.',
    path: ['amount'],
  });

export const createVendorCreditSchema = z.object({
  vendorId: zUuid,
  date: zDate,
  memo: z.string().nullish(),
  refNumber: z.string().max(50).nullish(),
  lines: zLines(vendorCreditLineSchema),
  // p1 fx: the vendor's currency is used; a stated rate overrides the currency list's rate.
  currency: z.string().max(3).nullish(),
  exchangeRate: zDecimalPositive.nullish(),
});
export type CreateVendorCreditBody = z.infer<typeof createVendorCreditSchema>;
