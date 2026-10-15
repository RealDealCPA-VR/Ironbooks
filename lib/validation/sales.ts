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
export const zShipTo = z.record(z.string().max(255)).nullish();

export const shippingFields = {
  shipDate: zDate.nullish(),
  shipVia: shortText,
  fob: shortText,
  trackingNumber: shortText,
  shipTo: zShipTo,
  poNumber: shortText,
};

export const sendFlagFields = {
  toBePrinted: z.boolean().optional(),
  toBeEmailed: z.boolean().optional(),
};

/** The user saw the "over credit limit" warning and chose to save anyway. */
export const creditLimitOverrideField = {
  overrideCreditLimit: z.boolean().optional(),
  /** Warn (NEGATIVE_STOCK, with fixes) when an inventory line sells more than is on hand. */
  checkStock: z.boolean().optional(),
};

/** POST/PUT statement charge (wave2 sales C5). */
export const statementChargeSchema = z.object({
  customerId: zUuid,
  date: zDate,
  itemId: zUuid.nullish(),
  accountId: zUuid.nullish(),
  description: z.string().max(4000).nullish(),
  quantity: zDecimal.nullish(),
  rate: zDecimal,
  dueDate: zDate.nullish(),
  classId: zUuid.nullish(),
  jobId: zUuid.nullish(),
  overrideCreditLimit: z.boolean().optional(),
});
