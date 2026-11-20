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

export const priceLevelSchema = z.object({
  name: z.string().trim().min(1, 'name is required'),
  type: z.enum(['fixed_percent', 'per_item']),
  percent: zDecimal.nullish(),
  rounding: zRounding.nullish(),
  isActive: z.boolean().optional(),
});

export const priceLevelItemsSchema = z.object({
  items: z.array(z.object({ itemId: zUuid, price: zDecimal })),
});

const adjustmentSchema = z.object({
  basis: z.enum(['price', 'cost']).default('price'),
  method: z.enum(['percent', 'amount', 'fixed']),
  direction: z.enum(['increase', 'decrease']).default('decrease'),
  value: zDecimal.transform((v) => String(v)),
});

export const priceRuleSchema = z.object({
  name: z.string().trim().min(1, 'name is required'),
  description: z.string().nullish(),
  isActive: z.boolean().optional(),
  priority: z.number().int().min(0).max(100000).optional(),
  conditions: z
    .object({
      itemIds: z.array(zUuid).optional(),
      itemTypes: z.array(z.string()).optional(),
      itemCustomField: z.object({ name: z.string(), value: z.string() }).nullish(),
      customerIds: z.array(zUuid).optional(),
      customerTypeIds: z.array(zUuid).optional(),
      jobIds: z.array(zUuid).optional(),
      classIds: z.array(zUuid).optional(),
      salesRepIds: z.array(zUuid).optional(),
    })
    .optional(),
  adjustment: adjustmentSchema,
  tiers: z
    .array(z.object({ minQuantity: zDecimal.transform((v) => String(v)), adjustment: adjustmentSchema }))
    .nullish(),
  rounding: zRounding.nullish(),
  startDate: zDay.nullish().or(z.literal('')),
  endDate: zDay.nullish().or(z.literal('')),
  minQuantity: zDecimal.nullish().or(z.literal('')),
});

export const customerPricingAssignSchema = z.object({
  customerTypeId: zUuid.nullish(),
  priceLevelId: zUuid.nullish(),
});

export const typeListSchema = z.object({
  name: z.string().trim().min(1, 'name is required'),
  parentId: zUuid.nullish(),
  isActive: z.boolean().optional(),
});

export const vendorTypeAssignSchema = z.object({
  vendorId: zUuid,
  vendorTypeId: zUuid.nullable(),
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
