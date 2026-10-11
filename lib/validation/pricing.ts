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

export const quoteSchema = z.object({
  customerId: zUuid.nullish(),
  date: zDate,
  classId: zUuid.nullish(),
  salesRepId: zUuid.nullish(),
  jobId: zUuid.nullish(),
  lines: z
    .array(
      z.object({
        itemId: zUuid,
        quantity: zDecimal,
        classId: zUuid.nullish(),
        jobId: zUuid.nullish(),
      }),
    )
    .max(500, 'At most 500 lines per quote.'),
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
  salesOrderId: zUuid,
  lines: z.array(z.object({ lineId: zUuid, quantity: zDecimal })).nullish(),
});

export const batchInvoiceSchema = z.object({
  date: zDate.nullish(),
  selections: zLines(fulfillmentSelectionSchema),
});

// ---- Receiving ---------------------------------------------------------------

export const receivingSettingsSchema = z.object({
  enhancedReceiving: z.boolean().optional(),
  varianceMode: z.enum(['inventory', 'ppv']).optional(),
  ppvAccountId: zUuid.nullish(),
});

export const receiptBillSchema = z.object({
  /** true = compute variances + the journal entry without saving. */
  preview: z.boolean().optional(),
  vendorId: zUuid,
  billNumber: z.string().nullish(),
  date: zDate,
  dueDate: zDate.nullish(),
  memo: z.string().nullish(),
  lines: zLines(
    z.object({
      receiptLineId: zUuid,
      quantity: zDecimal,
      unitCost: zDecimal,
      closeLine: z.boolean().optional(),
    }),
  ),
});
