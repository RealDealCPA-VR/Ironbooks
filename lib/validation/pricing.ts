/**
 * Zod schemas for advanced pricing (/api/pricing/*, /api/type-lists/*), the sales-order
 * fulfillment worksheet (/api/fulfillment) and enhanced receiving (/api/receiving/*).
 * Mirrors lib/services/pricing.ts, typeLists.ts, fulfillment.ts and receiving.ts inputs.
 */
import { z } from 'zod';
import { ROUNDING_MODES } from '@/lib/pricingShared';
import { zDate, zDecimal, zLines, zUuid } from './helpers';

const zDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date');
const zRounding = z.enum(ROUNDING_MODES);

// ---- Pricing -----------------------------------------------------------------

/** POST /api/pricing/quote — looks prices up only; nothing is saved (the document re-prices on save). */
export const quoteSchema = z.object({
  customerId: zUuid.nullish().describe('Id of the customer the document is for (customer list); their price level and type pick the rules.'),
  date: zDate.describe('Date of the document, YYYY-MM-DD; price rules with start and end dates use it.'),
  classId: zUuid.nullish().describe('Id of the class of the document (class list), for price rules limited to classes.'),
  salesRepId: zUuid.nullish().describe('Id of the sales rep of the document (sales rep list), for price rules limited to sales reps.'),
  jobId: zUuid.nullish().describe('Id of the Customer:Job of the document (job list), for price rules limited to jobs.'),
  /** A foreign-currency document: quotes come back in its currency (its rate, else the list's). */
  currency: z
    .string()
    .trim()
    .max(3)
    .nullish()
    .describe("3-letter currency code of the document such as \"EUR\"; prices come back in it; leave out for the home currency."),
  exchangeRate: z
    .union([z.string(), z.number()])
    .nullish()
    .describe('Home-currency units per 1 unit of the document currency, as decimal text such as "1.10"; leave out for the currency list\'s rate.'),
  lines: z
    .array(
      z.object({
        itemId: zUuid.describe('Id of the item to price (item list).'),
        quantity: zDecimal.describe('Quantity on the line as decimal text, such as "2"; quantity-break rules use it.'),
        classId: zUuid.nullish().describe("Id of the line's class (class list); leave out to use the document's class."),
        jobId: zUuid.nullish().describe("Id of the line's Customer:Job (job list); leave out to use the document's job."),
      }),
    )
    .max(500, 'At most 500 lines per quote.')
    .describe('The lines to price, at most 500.'),
});

export const pricingSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  conflictMode: z.enum(['lowest', 'priority']).optional(),
  defaultRounding: zRounding.optional(),
});

const ROUNDING_WORDS = `${ROUNDING_MODES.join(', ')} (none rounds to the cent)`;

// Create (POST) and edit (PUT) take the same full body: an edit replaces the level's settings, so a
// field left out on an edit goes back to its default (lib/services/pricing.ts normalizeLevel).
export const priceLevelSchema = z.object({
  name: z.string().trim().min(1, 'name is required').describe('Name of the price level, such as "Wholesale".'),
  type: z
    .enum(['fixed_percent', 'per_item'])
    .describe('fixed_percent: every price moves by percent; per_item: a price per item, set with PUT /api/pricing/levels/:id/items.'),
  percent: zDecimal
    .nullish()
    .describe('fixed_percent only: signed percentage as decimal text, "-10" for 10% off or "5" for 5% more; leave out for 0, on an edit too.'),
  rounding: zRounding
    .nullish()
    .describe(`fixed_percent only: how the new prices are rounded, ${ROUNDING_WORDS}; leave out for the company's default rounding, on an edit too.`),
  isActive: z
    .boolean()
    .optional()
    .describe('False makes the level inactive; on a new level leave out for active, and on an edit leave out to keep it.'),
});

export const priceLevelItemsSchema = z.object({
  items: z
    .array(
      z.object({
        itemId: zUuid.describe('Id of the item (item list), at most once in the list.'),
        price: zDecimal.describe('Price of the item at this level, as decimal text such as "19.99"; not negative.'),
      }),
    )
    .describe("All item prices of the per_item level, replacing the saved ones; an item not listed sells at its own price."),
});

const adjustmentSchema = z.object({
  basis: z.enum(['price', 'cost']).default('price').describe("What the change starts from: price (the item's sales price, the default) or cost."),
  method: z.enum(['percent', 'amount', 'fixed']).describe('percent or amount changes the basis by value; fixed sets the price to value.'),
  direction: z.enum(['increase', 'decrease']).default('decrease').describe('increase or decrease (the default); not used with fixed.'),
  value: zDecimal
    .transform((v) => String(v))
    .describe('The percentage, amount or fixed price, as decimal text such as "10"; not negative, and a percent decrease at most 100.'),
});

// Create (POST) and edit (PUT) take the same full body: an edit replaces the whole rule, so a field
// left out on an edit goes back to its default (lib/services/pricing.ts normalizeRule).
export const priceRuleSchema = z.object({
  name: z.string().trim().min(1, 'name is required').describe('Name of the price rule, such as "Contractors 10% off lumber".'),
  description: z.string().nullish().describe('Longer description of the rule; leave out for none.'),
  isActive: z.boolean().optional().describe('False turns the rule off; leave out for on, on an edit too.'),
  priority: z
    .number()
    .int()
    .min(0)
    .max(100000)
    .optional()
    .describe('Whole number 0 to 100000; a lower number is a higher priority when rules compete. Leave out for 100, on an edit too.'),
  conditions: z
    .object({
      itemIds: z.array(zUuid).optional().describe('Only these items (item list).'),
      itemTypes: z.array(z.string()).optional().describe('Only items of these types, such as "inventory" or "service".'),
      itemCustomField: z
        .object({
          name: z.string().describe('Name of the item custom field.'),
          value: z.string().describe('Value the field must have.'),
        })
        .nullish()
        .describe('Only items whose custom field has this value.'),
      customerIds: z.array(zUuid).optional().describe('Only these customers (customer list).'),
      customerTypeIds: z.array(zUuid).optional().describe('Only customers of these customer types.'),
      jobIds: z.array(zUuid).optional().describe('Only these Customer:Jobs (job list).'),
      classIds: z.array(zUuid).optional().describe('Only documents of these classes (class list).'),
      salesRepIds: z.array(zUuid).optional().describe('Only documents of these sales reps.'),
    })
    .optional()
    .describe('Which sales the rule applies to; every list given must match, and an empty or missing list matches everything. Leave out for every sale.'),
  adjustment: adjustmentSchema.describe('How the rule changes the price.'),
  tiers: z
    .array(
      z.object({
        minQuantity: zDecimal.transform((v) => String(v)).describe('Quantity from which this tier applies, as decimal text above zero; each tier its own.'),
        adjustment: adjustmentSchema.describe('How the price changes from that quantity on.'),
      }),
    )
    .nullish()
    .describe('Quantity breaks: from each minQuantity on, its adjustment replaces the main one; leave out for none.'),
  rounding: zRounding
    .nullish()
    .describe(`How the new price is rounded: ${ROUNDING_WORDS}; leave out for the company's default rounding.`),
  startDate: zDay.nullish().or(z.literal('')).describe('First day the rule applies, YYYY-MM-DD; leave out or blank for no start.'),
  endDate: zDay.nullish().or(z.literal('')).describe('Last day the rule applies, YYYY-MM-DD, not before startDate; leave out or blank for no end.'),
  minQuantity: zDecimal
    .nullish()
    .or(z.literal(''))
    .describe('Smallest quantity on the line for the rule to apply, as decimal text; leave out or blank for any quantity.'),
});

export const customerPricingAssignSchema = z.object({
  customerTypeId: zUuid
    .nullish()
    .describe("Id of the customer type (customer type list) to give the customer; leave out to keep it, or send null to clear it."),
  priceLevelId: zUuid
    .nullish()
    .describe("Id of the price level to give the customer; leave out to keep it, or send null to clear it."),
});

// Create (POST /api/type-lists/:kind) and edit (PUT /api/type-lists/:kind/:id) take the same body;
// an edit saves name and parentId as sent (lib/services/typeLists.ts updateType).
export const typeListSchema = z.object({
  name: z.string().trim().min(1, 'name is required').describe('Name of the customer or vendor type, such as "Retail"; unique in its list.'),
  parentId: zUuid
    .nullish()
    .describe('Id of the type this one is a subtype of, in the same list; leave out for a top-level type. On an edit, leaving it out makes it top-level.'),
  isActive: z
    .boolean()
    .optional()
    .describe('False makes the type inactive; on a new type leave out for active, and on an edit leave out to keep it.'),
});

export const vendorTypeAssignSchema = z.object({
  vendorId: zUuid.describe('Id of the vendor (vendor list).'),
  vendorTypeId: zUuid.nullable().describe('Id of the vendor type (vendor type list) to give the vendor, or null to clear it.'),
});

// ---- Fulfillment -------------------------------------------------------------

export const fulfillmentSelectionSchema = z.object({
  salesOrderId: zUuid.describe('Id of an open sales order (sales order list) to invoice.'),
  lines: z
    .array(
      z.object({
        lineId: zUuid.describe('Id of a line of that sales order.'),
        quantity: zDecimal.describe(
          'Quantity of that line to invoice now, as decimal text such as "2"; at most what is still open on the line and, for stock items, what is in stock.',
        ),
      }),
    )
    .nullish()
    .describe("The lines and quantities to invoice; leave out to invoice what each line can ship from stock."),
});

/** POST /api/fulfillment — one invoice per selected sales order (lib/services/fulfillment.ts). */
export const batchInvoiceSchema = z.object({
  date: zDate.nullish().describe('Date of the invoices, YYYY-MM-DD; leave out for today.'),
  selections: zLines(fulfillmentSelectionSchema).describe('The sales orders to invoice, one invoice each; at least one.'),
});

// ---- Receiving ---------------------------------------------------------------

export const receivingSettingsSchema = z.object({
  enhancedReceiving: z
    .boolean()
    .optional()
    .describe('True turns on enhanced receiving, where receiving items and billing for them are separate steps.'),
  varianceMode: z
    .enum(['inventory', 'ppv'])
    .optional()
    .describe("Where a bill's price difference from the receipt cost goes: into the item's cost (inventory) or a purchase price variance account (ppv)."),
  ppvAccountId: zUuid.nullish().describe('Id of the purchase price variance expense account (chart of accounts) used with ppv.'),
});

export const receiptBillSchema = z.object({
  /** true = compute variances + the journal entry without saving. */
  preview: z.boolean().optional().describe('True works out the variances and the entry and shows them without saving anything.'),
  vendorId: zUuid.describe('Id of the vendor whose received items are billed (vendor list).'),
  billNumber: z.string().nullish().describe("The vendor's own bill number."),
  date: zDate.describe('Bill date, YYYY-MM-DD.'),
  dueDate: zDate.nullish().describe('Date the bill is due, YYYY-MM-DD.'),
  memo: z.string().nullish().describe('Internal note saved with the bill.'),
  /** The user confirmed QB's "this vendor already has a bill with that reference number" warning. */
  allowDuplicateNumber: z
    .boolean()
    .optional()
    .describe('Send true only after the app warned that this vendor already has a bill with this number, to save it anyway.'),
  lines: zLines(
    z.object({
      receiptLineId: zUuid.describe('Id of the open item receipt line being billed.'),
      quantity: zDecimal.describe('Quantity the vendor bills as decimal text, at most what is still open on the line; may be "0" with closeLine.'),
      unitCost: zDecimal.describe("The vendor's cost per unit on the bill, as decimal text such as \"12.50\"."),
      closeLine: z
        .boolean()
        .optional()
        .describe('True writes off any quantity left unbilled on the receipt line, because the vendor will never bill it.'),
    }),
  ).describe('The received lines billed; at least one.'),
});
