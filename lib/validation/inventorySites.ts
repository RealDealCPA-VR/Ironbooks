/**
 * Zod schemas for Advanced Inventory (team inventory): sites, bins, per-site reorder points,
 * inventory transfers (and their void), site adjustments, landed cost (and its void), plus
 * `inventoryLineFields` — the optional
 * site/bin/serial/lot fields every inventory-affecting document line accepts (spread into the
 * invoice / sales receipt / credit memo / bill / item receipt line schemas).
 */
import { z } from 'zod';
import { zDate, zDecimal, zDecimalPositive, zLines, zMoney, zUuid } from './helpers';

/** Optional Advanced Inventory detail on a document line (mirrors InventoryLineDetail). */
export const inventoryLineFields = {
  siteId: zUuid
    .nullish()
    .describe("Id of the inventory site (site list) the stock moves at; leave out for the company's default site."),
  binId: zUuid.nullish().describe('Id of a bin within that site (bin list), when the company uses bins.'),
  serialNumbers: z
    .array(z.string().max(100))
    .max(10000)
    .nullish()
    .describe('Serial numbers of the units, one per unit; needed only for serial-tracked items.'),
  lotNumber: z.string().max(100).nullish().describe('Lot number of the units; needed only for lot-tracked items.'),
  lotExpiration: zDate
    .nullish()
    .describe('Expiration date of the lot, YYYY-MM-DD; used only when stock is received.'),
};

export const createSiteSchema = z.object({
  name: z
    .string({ required_error: 'name is required' })
    .trim()
    .min(1, 'Site name is required.')
    .describe('Name of the inventory site, such as "Main Warehouse".'),
  code: z.string().max(50).nullish().describe('Short code for the site (at most 50 characters).'),
  address: z.record(z.string()).nullish().describe('Site address as named text lines such as line1, city, state and zip.'),
  notes: z.string().nullish().describe('Free notes about the site.'),
  isDefault: z.boolean().optional().describe("True makes this the company's default site."),
});

export const updateSiteSchema = z.object({
  name: z.string().trim().min(1, 'Site name cannot be empty.').optional().describe('New name of the site.'),
  code: z.string().max(50).nullish().describe('Short code for the site (at most 50 characters).'),
  address: z.record(z.string()).nullish().describe('Site address as named text lines such as line1, city, state and zip.'),
  notes: z.string().nullish().describe('Free notes about the site.'),
  isActive: z.boolean().optional().describe('False makes the site inactive; true makes it active again.'),
  /** true makes this the company's default site. */
  isDefault: z.literal(true).optional().describe("Send true to make this the company's default site."),
});

export const createBinSchema = z.object({
  siteId: zUuid.describe('Id of the inventory site (site list) the bin belongs to.'),
  name: z
    .string({ required_error: 'name is required' })
    .trim()
    .min(1, 'Bin name is required.')
    .describe('Name of the bin, such as "A-01".'),
});

export const updateBinSchema = z.object({
  name: z.string().trim().min(1).optional().describe('New name of the bin.'),
  isActive: z.boolean().optional().describe('False makes the bin inactive; true makes it active again.'),
});

/** PUT /api/inventory-sites/reorder-points — set/clear one item's reorder point at one site. */
export const siteReorderPointSchema = z.object({
  itemId: zUuid.describe('Id of the inventory item (item list).'),
  siteId: zUuid.describe('Id of the inventory site (site list).'),
  reorderPoint: z
    .union([zDecimal, z.literal('')])
    .nullish()
    .describe('Quantity at which to reorder at this site, as decimal text; blank or null clears it.'),
  maxQuantity: z
    .union([zDecimal, z.literal('')])
    .nullish()
    .describe('Most stock to hold at this site, as decimal text; blank or null clears it.'),
});

export const inventoryTransferLineSchema = z.object({
  itemId: zUuid.describe('Id of the inventory item moved (item list).'),
  // Quantities are stored at 4dp: a sub-precision value would round to zero.
  quantity: zDecimalPositive
    .refine((v) => Number(v) >= 0.00005, { message: 'must be at least 0.0001' })
    .describe('Quantity moved, as decimal text above zero such as "5".'),
  fromBinId: zUuid.nullish().describe('Id of the bin the stock leaves (bin list), when the sending site uses bins.'),
  toBinId: zUuid.nullish().describe('Id of the bin the stock arrives in (bin list), when the receiving site uses bins.'),
  serialNumbers: z
    .array(z.string().max(100))
    .max(10000)
    .nullish()
    .describe('Serial numbers of the units moved, one per unit; needed only for serial-tracked items.'),
  lotNumber: z.string().max(100).nullish().describe('Lot number of the units moved; needed only for lot-tracked items.'),
});

export const createInventoryTransferSchema = z.object({
  date: zDate.describe('Date of the transfer, YYYY-MM-DD.'),
  fromSiteId: zUuid.describe('Id of the site the stock leaves (site list).'),
  toSiteId: zUuid.describe('Id of the site the stock arrives at (site list).'),
  memo: z.string().nullish().describe('Note saved with the transfer.'),
  lines: zLines(inventoryTransferLineSchema).describe('The items and quantities moved; at least one line.'),
});

/** POST /api/inventory-sites/adjust — QB "Adjust Quantity on Hand" at a site. */
export const siteAdjustmentSchema = z.object({
  itemId: zUuid.describe('Id of the inventory item adjusted (item list).'),
  /** Positive = add stock; negative = remove. */
  quantityChange: zDecimal.describe('Change in quantity on hand as decimal text: positive adds stock, such as "5", negative removes it, such as "-2".'),
  /** Required when adding stock. */
  unitCost: zDecimal.nullish().describe('Cost per unit of stock added, as decimal text such as "12.50"; required when adding stock.'),
  date: zDate.describe('Date of the adjustment, YYYY-MM-DD.'),
  memo: z.string().nullish().describe('Note saved with the adjustment, such as the reason.'),
  /** p1 purchases: QB Adjustment Account (default "Inventory Adjustments"), Class, Customer:Job. */
  adjustmentAccountId: zUuid
    .nullish()
    .describe('Id of the account that takes the other side of the adjustment (chart of accounts); leave out for Inventory Adjustments.'),
  classId: zUuid.nullish().describe('Id of a class (class list) for reports by class.'),
  customerId: zUuid.nullish().describe('Id of a customer (customer list) the adjustment is for, for job costing.'),
  jobId: zUuid.nullish().describe("Id of one of that customer's jobs (job list), for job costing."),
  ...inventoryLineFields,
});

export const landedCostSchema = z.object({
  billId: zUuid.describe('Id of the bill that carries the freight, duty or other landed cost.'),
  billLineId: zUuid.describe('Id of the line on that bill whose amount is spread over the received items.'),
  /** Defaults to the line's unallocated remainder. */
  amount: zMoney.nullish().describe('Amount to spread as decimal text such as "125.00"; leave out for what is left on the bill line.'),
  method: z
    .enum(['quantity', 'value', 'weight'])
    .describe('How the cost is shared between the received items: by quantity, by value or by item weight.'),
  /** Item receipts to spread the charge across (all their inventory lines). */
  itemReceiptIds: z
    .array(zUuid)
    .min(1, 'Select at least one item receipt.')
    .describe('Ids of the item receipts whose inventory lines share the cost; at least one.'),
  date: zDate.nullish().describe('Date of the allocation, YYYY-MM-DD.'),
  memo: z.string().nullish().describe('Note saved with the allocation.'),
});

/** Optional Advanced Inventory fields on assembly build / unbuild / finalize-pending requests. */
export const buildSiteFieldsSchema = z.object({
  ...inventoryLineFields,
  components: z
    .array(
      z.object({
        componentItemId: zUuid.describe('Id of the component item (item list) this detail is for.'),
        binId: zUuid.nullish().describe('Id of the bin the component is taken from (bin list).'),
        serialNumbers: z
          .array(z.string().max(100))
          .max(10000)
          .nullish()
          .describe('Serial numbers of the component units used, one per unit; serial-tracked components only.'),
        lotNumber: z.string().max(100).nullish().describe('Lot number of the component units used; lot-tracked components only.'),
      }),
    )
    .nullish()
    .describe('Bin, serial and lot detail for the components used, one entry per component item.'),
  date: zDate.nullish().describe('Date of the build, YYYY-MM-DD.'),
});

/**
 * POST /api/inventory-transfers/:id — void a transfer between sites. The route checks the action
 * itself; this says what it does, for agents (describe_operation, plan §6.3).
 */
export const voidInventoryTransferSchema = z.object({
  action: z
    .literal('void')
    .describe(
      'void: put the stock back at the site it came from. The transfer stays on file marked void; refused once the receiving site no longer holds the stock.',
    ),
});

/**
 * POST /api/landed-cost/:id — void a landed-cost allocation. The route checks the action itself;
 * this says what it does, for agents.
 */
export const voidLandedCostSchema = z.object({
  action: z
    .literal('void')
    .describe(
      "void: reverse the allocation's entries and cost changes exactly. The allocation stays on file marked void; refused once the stock it revalued has been sold or moved since (record a value adjustment instead).",
    ),
});
