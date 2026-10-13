/**
 * Zod schemas for Advanced Inventory (team inventory): sites, bins, per-site reorder points,
 * inventory transfers, site adjustments, landed cost, plus `inventoryLineFields` — the optional
 * site/bin/serial/lot fields every inventory-affecting document line accepts (spread into the
 * invoice / sales receipt / credit memo / bill / item receipt line schemas).
 */
import { z } from 'zod';
import { zDate, zDecimal, zDecimalPositive, zLines, zMoney, zUuid } from './helpers';

/** Optional Advanced Inventory detail on a document line (mirrors InventoryLineDetail). */
export const inventoryLineFields = {
  siteId: zUuid.nullish(),
  binId: zUuid.nullish(),
  serialNumbers: z.array(z.string().max(100)).max(10000).nullish(),
  lotNumber: z.string().max(100).nullish(),
  lotExpiration: zDate.nullish(),
};

export const createSiteSchema = z.object({
  name: z.string({ required_error: 'name is required' }).trim().min(1, 'Site name is required.'),
  code: z.string().max(50).nullish(),
  address: z.record(z.string()).nullish(),
  notes: z.string().nullish(),
  isDefault: z.boolean().optional(),
});

export const updateSiteSchema = z.object({
  name: z.string().trim().min(1, 'Site name cannot be empty.').optional(),
  code: z.string().max(50).nullish(),
  address: z.record(z.string()).nullish(),
  notes: z.string().nullish(),
  isActive: z.boolean().optional(),
  /** true makes this the company's default site. */
  isDefault: z.literal(true).optional(),
});

export const createBinSchema = z.object({
  siteId: zUuid,
  name: z.string({ required_error: 'name is required' }).trim().min(1, 'Bin name is required.'),
});

export const updateBinSchema = z.object({
  name: z.string().trim().min(1).optional(),
  isActive: z.boolean().optional(),
});

/** PUT /api/inventory-sites/reorder-points — set/clear one item's reorder point at one site. */
export const siteReorderPointSchema = z.object({
  itemId: zUuid,
  siteId: zUuid,
  reorderPoint: z.union([zDecimal, z.literal('')]).nullish(),
  maxQuantity: z.union([zDecimal, z.literal('')]).nullish(),
});

export const inventoryTransferLineSchema = z.object({
  itemId: zUuid,
  // Quantities are stored at 4dp: a sub-precision value would round to zero.
  quantity: zDecimalPositive.refine((v) => Number(v) >= 0.00005, { message: 'must be at least 0.0001' }),
  fromBinId: zUuid.nullish(),
  toBinId: zUuid.nullish(),
  serialNumbers: z.array(z.string().max(100)).max(10000).nullish(),
  lotNumber: z.string().max(100).nullish(),
});

export const createInventoryTransferSchema = z.object({
  date: zDate,
  fromSiteId: zUuid,
  toSiteId: zUuid,
  memo: z.string().nullish(),
  lines: zLines(inventoryTransferLineSchema),
});

/** POST /api/inventory-sites/adjust — QB "Adjust Quantity on Hand" at a site. */
export const siteAdjustmentSchema = z.object({
  itemId: zUuid,
  /** Positive = add stock; negative = remove. */
  quantityChange: zDecimal,
  /** Required when adding stock. */
  unitCost: zDecimal.nullish(),
  date: zDate,
  memo: z.string().nullish(),
  /** p1 purchases: QB Adjustment Account (default "Inventory Adjustments"), Class, Customer:Job. */
  adjustmentAccountId: zUuid.nullish(),
  classId: zUuid.nullish(),
  customerId: zUuid.nullish(),
  jobId: zUuid.nullish(),
  ...inventoryLineFields,
});

export const landedCostSchema = z.object({
  billId: zUuid,
  billLineId: zUuid,
  /** Defaults to the line's unallocated remainder. */
  amount: zMoney.nullish(),
  method: z.enum(['quantity', 'value', 'weight']),
  /** Item receipts to spread the charge across (all their inventory lines). */
  itemReceiptIds: z.array(zUuid).min(1, 'Select at least one item receipt.'),
  date: zDate.nullish(),
  memo: z.string().nullish(),
});

/** Optional Advanced Inventory fields on assembly build / unbuild / finalize-pending requests. */
export const buildSiteFieldsSchema = z.object({
  ...inventoryLineFields,
  components: z
    .array(
      z.object({
        componentItemId: zUuid,
        binId: zUuid.nullish(),
        serialNumbers: z.array(z.string().max(100)).max(10000).nullish(),
        lotNumber: z.string().max(100).nullish(),
      }),
    )
    .nullish(),
  date: zDate.nullish(),
});
