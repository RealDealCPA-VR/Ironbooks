/**
 * Zod schemas for /api/vendors — mirrors lib/services/vendors.ts inputs.
 */
import { z } from 'zod';
import { zDate, zMoney, zUuid } from './helpers';

const zEmail = z.union([z.literal(''), z.string().max(255, 'can be at most 255 characters').email('is not a valid email address')]).nullish();

const vendorFieldsSchema = z.object({
  displayName: z.string().trim().min(1, 'displayName is required').max(255, 'can be at most 255 characters'),
  companyName: z.string().max(255, 'can be at most 255 characters').nullish(),
  email: zEmail,
  phone: z.string().max(50, 'can be at most 50 characters').nullish(),
  /** Free-form address map, e.g. { street, city, state, zip, country }. */
  address: z.record(z.string()).nullish(),
  terms: z.string().nullish(),
  /** Wave-2 lists: Terms list entry (wins over the legacy terms string). */
  termsId: zUuid.nullish(),
  is1099: z.boolean().optional(),
  taxId: z.string().nullish(),
  defaultExpenseAccountId: zUuid.nullish(),
  notes: z.string().nullish(),
  /** wave2 purchases: up to 3 pre-fill accounts, print-on-check name, our account no., currency. */
  prefillAccountIds: z.array(zUuid).max(3, 'at most 3 pre-fill accounts').nullish(),
  printOnCheckAs: z.string().max(255).nullish(),
  accountNumber: z.string().max(100).nullish(),
  currency: z.string().max(3).nullish(),
  /** B4: Vendor Type list entry (null clears it). */
  vendorTypeId: zUuid.nullish(),
});

/**
 * New vendor. QB's New Vendor window also takes an Opening Balance "as of" a date (default: the
 * company's today), recorded as a bill from the vendor — create only.
 */
export const createVendorSchema = vendorFieldsSchema.extend({
  openingBalance: zMoney.nullish(),
  openingBalanceDate: zDate.nullish(),
});
export type CreateVendorBody = z.infer<typeof createVendorSchema>;

export const updateVendorSchema = vendorFieldsSchema.partial();
export type UpdateVendorBody = z.infer<typeof updateVendorSchema>;
