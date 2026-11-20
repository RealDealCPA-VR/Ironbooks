/**
 * Zod schemas for /api/vendors — mirrors lib/services/vendors.ts inputs.
 */
import { z } from 'zod';
import { zDate, zMoney, zUuid } from './helpers';

const zEmail = z
  .union([z.literal(''), z.string().max(255, 'can be at most 255 characters').email('is not a valid email address')])
  .nullish()
  .describe('Email address (at most 255 characters); blank or null means none.');

const vendorFieldsSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(1, 'displayName is required')
    .max(255, 'can be at most 255 characters')
    .describe('Name the vendor is listed and found by; must be unique among vendors (at most 255 characters).'),
  companyName: z.string().max(255, 'can be at most 255 characters').nullish().describe("The vendor's company name."),
  email: zEmail,
  phone: z.string().max(50, 'can be at most 50 characters').nullish().describe('Phone number (at most 50 characters).'),
  /** Free-form address map, e.g. { street, city, state, zip, country }. */
  address: z
    .record(z.string())
    .nullish()
    .describe('Address as named text lines, such as street, city, state, zip and country.'),
  terms: z.string().nullish().describe('Payment terms as text, such as "Net 30"; termsId wins when both are given.'),
  /** Wave-2 lists: Terms list entry (wins over the legacy terms string). */
  termsId: zUuid.nullish().describe('Id of a Terms list entry; it wins over the terms text.'),
  is1099: z.boolean().optional().describe('True when the vendor gets a 1099 form at year end.'),
  taxId: z.string().nullish().describe("The vendor's tax id (EIN or SSN) for 1099 reporting."),
  defaultExpenseAccountId: zUuid
    .nullish()
    .describe('Id of the expense account (chart of accounts) new bills and checks for this vendor start with.'),
  notes: z.string().nullish().describe('Free notes about the vendor.'),
  /** wave2 purchases: up to 3 pre-fill accounts, print-on-check name, our account no., currency. */
  prefillAccountIds: z
    .array(zUuid)
    .max(3, 'at most 3 pre-fill accounts')
    .nullish()
    .describe('Ids of up to 3 accounts (chart of accounts) that pre-fill the lines of new bills and checks for this vendor.'),
  printOnCheckAs: z.string().max(255).nullish().describe('Name printed on checks to this vendor, when it differs from displayName.'),
  accountNumber: z.string().max(100).nullish().describe("Your account number with the vendor (at most 100 characters)."),
  currency: z
    .string()
    .max(3)
    .nullish()
    .describe("3-letter code of the currency the vendor bills in, such as \"EUR\"; leave out for the home currency."),
  /** B4: Vendor Type list entry (null clears it). */
  vendorTypeId: zUuid.nullish().describe('Id of a Vendor Type list entry; null clears it.'),
});

/**
 * New vendor. QB's New Vendor window also takes an Opening Balance "as of" a date (default: the
 * company's today), recorded as a bill from the vendor — create only.
 */
export const createVendorSchema = vendorFieldsSchema.extend({
  openingBalance: zMoney
    .nullish()
    .describe('Amount you already owe the vendor, as decimal text such as "800.00"; recorded as a bill.'),
  openingBalanceDate: zDate.nullish().describe('Date of the opening balance, YYYY-MM-DD; leave out for today.'),
});
export type CreateVendorBody = z.infer<typeof createVendorSchema>;

export const updateVendorSchema = vendorFieldsSchema.partial();
export type UpdateVendorBody = z.infer<typeof updateVendorSchema>;
