/**
 * Zod schemas for /api/vendors — mirrors lib/services/vendors.ts inputs.
 */
import { z } from 'zod';
import { zUuid } from './helpers';

const zEmail = z.union([z.literal(''), z.string().email('is not a valid email address')]).nullish();

export const createVendorSchema = z.object({
  displayName: z.string().trim().min(1, 'displayName is required'),
  companyName: z.string().nullish(),
  email: zEmail,
  phone: z.string().nullish(),
  /** Free-form address map, e.g. { street, city, state, zip, country }. */
  address: z.record(z.string()).nullish(),
  terms: z.string().nullish(),
  /** Wave-2 lists: Terms list entry (wins over the legacy terms string). */
  termsId: zUuid.nullish(),
  is1099: z.boolean().optional(),
  taxId: z.string().nullish(),
  defaultExpenseAccountId: zUuid.nullish(),
  notes: z.string().nullish(),
});
export type CreateVendorBody = z.infer<typeof createVendorSchema>;

export const updateVendorSchema = createVendorSchema.partial();
export type UpdateVendorBody = z.infer<typeof updateVendorSchema>;
