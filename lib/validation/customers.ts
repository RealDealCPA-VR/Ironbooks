/**
 * Zod schemas for /api/customers — mirrors lib/services/customers.ts inputs.
 */
import { z } from 'zod';
import { zDate, zMoney, zUuid } from './helpers';

export const customerAddressSchema = z.object({
  line1: z.string().optional(),
  line2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zip: z.string().optional(),
  country: z.string().optional(),
});

/** A named ship-to address (QB Enterprise: several per customer, one default). */
export const shipToAddressSchema = customerAddressSchema.extend({
  name: z.string().max(41).optional(),
  isDefault: z.boolean().optional(),
});

/** '' and null both mean "no email"; otherwise must be structurally valid. */
const zEmail = z.union([z.literal(''), z.string().email('is not a valid email address')]).nullish();

const customerFieldsSchema = z.object({
  displayName: z.string().trim().min(1, 'displayName is required'),
  companyName: z.string().nullish(),
  email: zEmail,
  phone: z.string().nullish(),
  billingAddress: customerAddressSchema.nullish(),
  shippingAddress: customerAddressSchema.nullish(),
  shipToAddresses: z.array(shipToAddressSchema).max(50).nullish(),
  terms: z.string().nullish(),
  creditLimit: zMoney.nullish(),
  taxable: z.boolean().optional(),
  taxRateId: zUuid.nullish(),
  parentId: zUuid.nullish(),
  notes: z.string().nullish(),
  /** Wave-2 lists: Terms list entry, Sales Tax Code, resale number, exemption reason. */
  termsId: zUuid.nullish(),
  salesTaxCodeId: zUuid.nullish(),
  resaleNumber: z.string().max(50).nullish(),
  taxExemptionReason: z.string().max(100).nullish(),
  /** B12: the customer's price level (null clears it). */
  priceLevelId: zUuid.nullish(),
  /** B4: Customer Type list entry (null clears it). */
  customerTypeId: zUuid.nullish(),
});

/**
 * New customer. QB's New Customer window also takes an Opening Balance "as of" a date (default:
 * the company's today), recorded as an invoice to the customer — create only.
 */
export const createCustomerSchema = customerFieldsSchema.extend({
  openingBalance: zMoney.nullish(),
  openingBalanceDate: zDate.nullish(),
});
export type CreateCustomerBody = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = customerFieldsSchema.partial();
export type UpdateCustomerBody = z.infer<typeof updateCustomerSchema>;
