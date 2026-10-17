/**
 * Zod schemas for /api/items — mirrors CreateItemInput / UpdateItemInput
 * (lib/services/items.ts) plus the route-level `reorderPoint` extra that is
 * forwarded to inventory.setReorderPoint ('' / null clears it).
 */
import { z } from 'zod';
import { zDate, zDecimal, zUuid } from './helpers';

export const itemTypeSchema = z.enum([
  'service',
  'inventory',
  'non_inventory',
  'bundle',
  'other_charge',
  'discount',
  'subtotal',
  'payment',
  'sales_tax',
]);

/** Reorder point: decimal, or ''/null to clear. */
const zReorderPoint = z.union([zDecimal, z.literal('')]).nullish();

export const createItemSchema = z.object({
  name: z.string({ required_error: 'name is required' }).trim().min(1, 'Item name is required.'),
  sku: z.string().nullish(),
  /** Defaults to 'service' in the service. */
  type: itemTypeSchema.optional(),
  description: z.string().nullish(),
  salesPrice: zDecimal.nullish(),
  purchaseCost: zDecimal.nullish(),
  incomeAccountId: zUuid.nullish(),
  expenseAccountId: zUuid.nullish(),
  assetAccountId: zUuid.nullish(),
  /** Defaults to true in the service. */
  taxable: z.boolean().optional(),
  unitOfMeasure: z.string().nullish(),
  /** Advanced Inventory: scan code (unique per company). */
  barcode: z.string().max(100).nullish(),
  /** Advanced Inventory: serial/lot tracking for inventory items. */
  trackingMode: z.enum(['none', 'serial', 'lot']).optional(),
  /** Unit weight (landed cost by weight). */
  weight: zDecimal.nullish(),
  /** Route-level: forwarded to setReorderPoint after creation. */
  reorderPoint: zReorderPoint,
  /** Wave-2 lists: preferred vendor, sales tax code, unit of measure set. */
  preferredVendorId: zUuid.nullish(),
  salesTaxCodeId: zUuid.nullish(),
  uomSetId: zUuid.nullish(),
  /** Wave-2 lists: opening quantity on hand (inventory items; posts vs Opening Balance Equity). */
  openingQuantity: zDecimal.nullish(),
  openingValue: zDecimal.nullish(),
  openingUnitCost: zDecimal.nullish(),
  openingAsOf: zDate.nullish(),
  /**
   * Costing of the opening stock: 'average' (default — the item stays average-cost, like stock
   * received on a bill) or 'fifo' (opens a FIFO cost layer, making the item FIFO-tracked).
   */
  openingCosting: z.enum(['average', 'fifo']).nullish(),
});
export type CreateItemBody = z.infer<typeof createItemSchema>;

export const updateItemSchema = z.object({
  name: z.string().trim().min(1, 'Item name is required.').optional(),
  sku: z.string().nullish(),
  type: itemTypeSchema.optional(),
  description: z.string().nullish(),
  salesPrice: zDecimal.nullish(),
  purchaseCost: zDecimal.nullish(),
  incomeAccountId: zUuid.nullish(),
  expenseAccountId: zUuid.nullish(),
  assetAccountId: zUuid.nullish(),
  taxable: z.boolean().optional(),
  unitOfMeasure: z.string().nullish(),
  isActive: z.boolean().optional(),
  barcode: z.string().max(100).nullish(),
  trackingMode: z.enum(['none', 'serial', 'lot']).optional(),
  weight: zDecimal.nullish(),
  /** Route-level: forwarded to setReorderPoint when the key is present. */
  reorderPoint: zReorderPoint,
  preferredVendorId: zUuid.nullish(),
  salesTaxCodeId: zUuid.nullish(),
  uomSetId: zUuid.nullish(),
});
export type UpdateItemBody = z.infer<typeof updateItemSchema>;
