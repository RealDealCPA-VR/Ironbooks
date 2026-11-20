/**
 * Zod schemas for /api/customers — mirrors lib/services/customers.ts inputs.
 */
import { z } from 'zod';
import { zDate, zMoney, zUuid } from './helpers';

export const customerAddressSchema = z.object({
  line1: z.string().optional().describe('First street line.'),
  line2: z.string().optional().describe('Second street line.'),
  city: z.string().optional().describe('City.'),
  state: z.string().optional().describe('State or province.'),
  zip: z.string().optional().describe('ZIP or postal code.'),
  country: z.string().optional().describe('Country.'),
});

/** A named ship-to address (QB Enterprise: several per customer, one default). */
export const shipToAddressSchema = customerAddressSchema.extend({
  name: z.string().max(41).optional().describe('Name of this ship-to address, such as "Warehouse" (at most 41 characters).'),
  isDefault: z.boolean().optional().describe('True makes this the default ship-to address on sales forms.'),
});

/** '' and null both mean "no email"; otherwise must be structurally valid. */
const zEmail = z
  .union([z.literal(''), z.string().email('is not a valid email address')])
  .nullish()
  .describe('Email address; blank or null means none.');

const customerFieldsSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(1, 'displayName is required')
    .describe('Name the customer is listed and found by; must be unique among customers.'),
  companyName: z.string().nullish().describe("The customer's company name."),
  email: zEmail,
  phone: z.string().nullish().describe('Phone number.'),
  billingAddress: customerAddressSchema.nullish().describe('Address printed on invoices and statements.'),
  shippingAddress: customerAddressSchema.nullish().describe('Main shipping address.'),
  shipToAddresses: z
    .array(shipToAddressSchema)
    .max(50)
    .nullish()
    .describe('Named ship-to addresses (at most 50), one of them marked as the default.'),
  terms: z.string().nullish().describe('Payment terms as text, such as "Net 30"; termsId wins when both are given.'),
  creditLimit: zMoney.nullish().describe('Credit limit as decimal text such as "5000.00"; sales that go over it ask for confirmation.'),
  taxable: z.boolean().optional().describe('Whether sales to this customer are taxed; a salesTaxCodeId decides it when given.'),
  taxRateId: zUuid.nullish().describe("Id of the customer's usual sales tax item (sales tax list)."),
  parentId: zUuid.nullish().describe('Id of the parent customer (customer list), making this a sub-customer.'),
  notes: z.string().nullish().describe('Free notes about the customer.'),
  /** Wave-2 lists: Terms list entry, Sales Tax Code, resale number, exemption reason. */
  termsId: zUuid.nullish().describe('Id of a Terms list entry; it wins over the terms text.'),
  salesTaxCodeId: zUuid
    .nullish()
    .describe('Id of a Sales Tax Code list entry such as "Tax" or "Non"; when given it decides whether the customer is taxable.'),
  resaleNumber: z.string().max(50).nullish().describe('Resale certificate number for a tax-exempt customer (at most 50 characters).'),
  taxExemptionReason: z.string().max(100).nullish().describe('Why the customer is exempt from sales tax (at most 100 characters).'),
  /** B12: the customer's price level (null clears it). */
  priceLevelId: zUuid.nullish().describe('Id of the price level (price level list) used on this customer\'s sales forms; null clears it.'),
  /** B4: Customer Type list entry (null clears it). */
  customerTypeId: zUuid.nullish().describe('Id of a Customer Type list entry; null clears it.'),
});

/**
 * New customer. QB's New Customer window also takes an Opening Balance "as of" a date (default:
 * the company's today), recorded as an invoice to the customer — create only.
 */
export const createCustomerSchema = customerFieldsSchema.extend({
  openingBalance: zMoney
    .nullish()
    .describe('Amount the customer already owes, as decimal text such as "1200.00"; recorded as an invoice.'),
  openingBalanceDate: zDate.nullish().describe('Date of the opening balance, YYYY-MM-DD; leave out for today.'),
});
export type CreateCustomerBody = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = customerFieldsSchema.partial();
export type UpdateCustomerBody = z.infer<typeof updateCustomerSchema>;
