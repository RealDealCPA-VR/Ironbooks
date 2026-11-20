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
const zReorderPoint = z
  .union([zDecimal, z.literal('')])
  .nullish()
  .describe('Quantity on hand at which to reorder, as decimal text such as "20"; blank or null clears it.');

export const createItemSchema = z.object({
  name: z
    .string({ required_error: 'name is required' })
    .trim()
    .min(1, 'Item name is required.')
    .describe('Name of the item as it appears on forms and lists.'),
  sku: z.string().nullish().describe('Stock keeping unit or part number.'),
  /** Defaults to 'service' in the service. */
  type: itemTypeSchema.optional().describe('Kind of item; leave out for service, and use inventory for stock that is counted.'),
  description: z.string().nullish().describe('Text that fills the description of sales lines.'),
  salesPrice: zDecimal.nullish().describe('Selling price per unit as decimal text, such as "125.00".'),
  purchaseCost: zDecimal.nullish().describe('Cost per unit on purchases, as decimal text such as "60.00".'),
  incomeAccountId: zUuid.nullish().describe('Id of the income account credited when the item is sold (chart of accounts).'),
  expenseAccountId: zUuid
    .nullish()
    .describe('Id of the expense or cost of goods sold account debited when the item is bought or sold from stock (chart of accounts).'),
  assetAccountId: zUuid
    .nullish()
    .describe('Id of the inventory asset account that holds the stock value (chart of accounts); inventory items only.'),
  /** Defaults to true in the service. */
  taxable: z.boolean().optional().describe('Whether sales tax applies when the item is sold; leave out for true.'),
  unitOfMeasure: z.string().nullish().describe('Unit shown on forms, such as "hr", "box" or "ea".'),
  /** Advanced Inventory: scan code (unique per company). */
  barcode: z.string().max(100).nullish().describe('Barcode or scan code, unique within the company (at most 100 characters).'),
  /** Advanced Inventory: serial/lot tracking for inventory items. */
  trackingMode: z
    .enum(['none', 'serial', 'lot'])
    .optional()
    .describe('Inventory items only: track units by serial number, by lot, or not at all (the default).'),
  /** Unit weight (landed cost by weight). */
  weight: zDecimal.nullish().describe('Weight of one unit as decimal text, used to share landed costs by weight.'),
  /** Route-level: forwarded to setReorderPoint after creation. */
  reorderPoint: zReorderPoint,
  /** Wave-2 lists: preferred vendor, sales tax code, unit of measure set. */
  preferredVendorId: zUuid.nullish().describe('Id of the vendor (vendor list) the item is usually bought from.'),
  salesTaxCodeId: zUuid
    .nullish()
    .describe('Id of a Sales Tax Code list entry such as "Tax" or "Non"; when given it decides whether the item is taxable.'),
  uomSetId: zUuid.nullish().describe('Id of a unit of measure set; line quantities convert to its base unit.'),
  /** Wave-2 lists: opening quantity on hand (inventory items; posts vs Opening Balance Equity). */
  openingQuantity: zDecimal
    .nullish()
    .describe('Inventory items only: quantity already on hand, as decimal text such as "40"; its value posts against Opening Balance Equity.'),
  openingValue: zDecimal
    .nullish()
    .describe('Total value of the opening quantity as decimal text such as "800.00"; give this or openingUnitCost.'),
  openingUnitCost: zDecimal
    .nullish()
    .describe('Cost per unit of the opening quantity as decimal text such as "20.00"; give this or openingValue.'),
  openingAsOf: zDate.nullish().describe('Date of the opening quantity, YYYY-MM-DD; leave out for today.'),
  /**
   * Costing of the opening stock: 'average' (default — the item stays average-cost, like stock
   * received on a bill) or 'fifo' (opens a FIFO cost layer, making the item FIFO-tracked).
   */
  openingCosting: z
    .enum(['average', 'fifo'])
    .nullish()
    .describe('average (the default) keeps the item at average cost; fifo opens a first-in first-out cost layer for the opening stock.'),
});
export type CreateItemBody = z.infer<typeof createItemSchema>;

export const updateItemSchema = z.object({
  name: z.string().trim().min(1, 'Item name is required.').optional().describe('New name of the item.'),
  sku: z.string().nullish().describe('Stock keeping unit or part number.'),
  type: itemTypeSchema.optional().describe('Kind of item.'),
  description: z.string().nullish().describe('Text that fills the description of sales lines.'),
  salesPrice: zDecimal.nullish().describe('Selling price per unit as decimal text, such as "125.00".'),
  purchaseCost: zDecimal.nullish().describe('Cost per unit on purchases, as decimal text such as "60.00".'),
  incomeAccountId: zUuid.nullish().describe('Id of the income account credited when the item is sold (chart of accounts).'),
  expenseAccountId: zUuid
    .nullish()
    .describe('Id of the expense or cost of goods sold account debited when the item is bought or sold from stock (chart of accounts).'),
  assetAccountId: zUuid
    .nullish()
    .describe('Id of the inventory asset account that holds the stock value (chart of accounts); inventory items only.'),
  taxable: z.boolean().optional().describe('Whether sales tax applies when the item is sold.'),
  unitOfMeasure: z.string().nullish().describe('Unit shown on forms, such as "hr", "box" or "ea".'),
  isActive: z.boolean().optional().describe('False makes the item inactive (hidden from pick lists); true makes it active again.'),
  barcode: z.string().max(100).nullish().describe('Barcode or scan code, unique within the company (at most 100 characters).'),
  trackingMode: z
    .enum(['none', 'serial', 'lot'])
    .optional()
    .describe('Inventory items only: track units by serial number, by lot, or not at all.'),
  weight: zDecimal.nullish().describe('Weight of one unit as decimal text, used to share landed costs by weight.'),
  /** Route-level: forwarded to setReorderPoint when the key is present. */
  reorderPoint: zReorderPoint,
  preferredVendorId: zUuid.nullish().describe('Id of the vendor (vendor list) the item is usually bought from.'),
  salesTaxCodeId: zUuid
    .nullish()
    .describe('Id of a Sales Tax Code list entry such as "Tax" or "Non"; when given it decides whether the item is taxable.'),
  uomSetId: zUuid.nullish().describe('Id of a unit of measure set; line quantities convert to its base unit.'),
});
export type UpdateItemBody = z.infer<typeof updateItemSchema>;
