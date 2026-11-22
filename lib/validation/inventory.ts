/**
 * Zod schemas for the inventory quantity and value changes (/api/inventory adjust and cogs,
 * /api/inventory/physical-count, /api/inventory/value-adjust, /api/fifo receive and consume;
 * lib/services/inventorySiteOps.ts and inventoryOps.ts).
 *
 * These routes read their body by hand, and their own checks answer first with the messages they
 * always gave. The schema is checked after them: it says what each field is, for agents
 * (describe_operation, plan §6.3), and refuses only a value the service could not use anyway (an
 * id or a date that is not text, a quantity that is not a number). A field the handler ignores or
 * converts when it has another type is zLenient, and one it turns into text is zAsText, so what
 * each route accepts is unchanged.
 */
import { z } from 'zod';
import { zAsText, zLenient, zUuid } from './helpers';

const itemId = z
  .string({ invalid_type_error: 'must be the id of an item' })
  .min(1)
  .describe('Id of the inventory item (item list).');
const day = (what: string) =>
  z.string({ invalid_type_error: 'must be a date (YYYY-MM-DD)' }).min(1).describe(`${what}, YYYY-MM-DD.`);
const quantity = z.union([z.string(), z.number()], { invalid_type_error: 'must be a number' });

/** The account, class and Customer:Job of the adjustment entry (QB Adjust Quantity / Value). */
const adjustmentEntryFields = {
  adjustmentAccountId: zLenient(zUuid.nullable()).describe(
    'Id of the account that takes the other side of the adjustment (chart of accounts); leave out for Inventory Adjustments.',
  ),
  classId: zLenient(zUuid.nullable()).describe('Id of a class (class list) for reports by class; leave out for none.'),
  customerId: zLenient(zUuid.nullable()).describe('Id of a customer (customer list) the adjustment is for, for job costing; leave out for none.'),
  jobId: zLenient(zUuid.nullable()).describe("Id of one of that customer's jobs (job list), for job costing; leave out for none."),
};

/** Advanced Inventory: where the stock moves (siteFields in app/api/inventory/route.ts). */
const siteFields = {
  siteId: zLenient(zUuid.nullable()).describe("Id of the inventory site (site list) the stock moves at; leave out for the company's default site."),
  binId: zLenient(zUuid.nullable()).describe('Id of a bin within that site (bin list), when the company uses bins.'),
  serialNumbers: zLenient(z.array(z.string())).describe('Serial numbers of the units, one per unit; needed only for serial-tracked items.'),
  lotNumber: zLenient(z.string().nullable()).describe('Lot number of the units; needed only for lot-tracked items.'),
  lotExpiration: zLenient(z.string().nullable()).describe('Expiration date of the lot, YYYY-MM-DD; used only when stock is added.'),
};

/** POST /api/inventory — QB Adjust Quantity on Hand ('adjust'), or relieve stock at cost ('cogs'). */
export const inventoryActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('adjust').describe('adjust: change the quantity on hand (QB Adjust Quantity on Hand).'),
    itemId,
    quantityChange: quantity.describe('Change in quantity on hand as decimal text: positive adds stock, such as "5", negative removes it, such as "-2".'),
    unitCost: zLenient(z.union([z.string(), z.number()]).nullable()).describe(
      'Cost per unit of stock added, as decimal text such as "12.50"; required when quantityChange adds stock, not used when it removes stock.',
    ),
    date: day('Date of the adjustment'),
    memo: zLenient(z.string().nullable()).describe('Note saved with the adjustment, such as the reason; leave out for none.'),
    ...adjustmentEntryFields,
    ...siteFields,
  }),
  z.object({
    action: z.literal('cogs').describe('cogs: take stock out at cost and post it to Cost of Goods Sold (Dr COGS, Cr Inventory Asset).'),
    itemId,
    // The route reads it as String(quantity), so whatever it is sent is checked as that text.
    quantity: zAsText(quantity).describe('Quantity taken out, as decimal text such as "3" (a minus sign is ignored).'),
    date: day('Date the stock is taken out'),
    memo: zLenient(z.string().nullable()).describe('Note saved with the entry; leave out for "Cost of goods sold".'),
    ...adjustmentEntryFields,
    ...siteFields,
  }),
]);

/** POST /api/inventory/physical-count — record a count; the difference posts as an adjustment. */
export const physicalCountSchema = z.object({
  itemId,
  countedQty: quantity.describe('Quantity counted on the shelf, as decimal text such as "42"; the quantity on hand becomes this.'),
  date: day('Date of the count'),
  ...adjustmentEntryFields,
});

/** POST /api/inventory/value-adjust — revalue the stock of an item (QB Adjust Total Value). */
export const valueAdjustSchema = z.object({
  itemId,
  newTotalValue: zLenient(z.union([z.string(), z.number()]).nullable()).describe(
    'New total value of the stock on hand, as decimal text such as "1250.00"; send exactly one of newTotalValue and newUnitCost.',
  ),
  newUnitCost: zLenient(z.union([z.string(), z.number()]).nullable()).describe(
    'New cost per unit of the stock on hand, as decimal text such as "12.50"; send exactly one of newTotalValue and newUnitCost.',
  ),
  date: day('Date of the value adjustment'),
  reason: zLenient(z.string().nullable()).describe('Why the value changes, saved with the entry; leave out for none.'),
  ...adjustmentEntryFields,
});

/**
 * POST /api/fifo — receive stock as a new FIFO cost layer, or take stock out at FIFO cost
 * (lib/services/inventorySiteOps.ts adjustQuantityAtSite, costing 'fifo'). The route checks the
 * action, the item, the quantity, the cost and the date itself; the site and entry fields it reads
 * by type, as POST /api/inventory does.
 */
export const fifoActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z
      .literal('receive')
      .describe(
        'receive: add stock as a new FIFO cost layer at unitCost (Dr Inventory Asset, Cr the adjustment account). The first receive starts FIFO costing for the item.',
      ),
    itemId,
    quantity: quantity.describe('Quantity added, as decimal text such as "10".'),
    unitCost: quantity.describe('Cost per unit of the stock added, as decimal text such as "4.25"; it is the cost of the new layer.'),
    date: day('Date the stock is received'),
    memo: zLenient(z.string().nullable()).describe('Note saved with the entry; leave out for "Inventory adjustment (add)".'),
    ...adjustmentEntryFields,
    ...siteFields,
  }),
  z.object({
    action: z
      .literal('consume')
      .describe('consume: take stock out at FIFO cost, oldest layers first, and post that cost (Dr Cost of Goods Sold, Cr Inventory Asset).'),
    itemId,
    // The route reads it as String(quantity), so whatever it is sent is checked as that text.
    quantity: zAsText(quantity).describe('Quantity taken out, as decimal text such as "3" (a minus sign is ignored).'),
    date: day('Date the stock is taken out'),
    memo: zLenient(z.string().nullable()).describe('Note saved with the entry; leave out for "Inventory adjustment (remove)".'),
    ...adjustmentEntryFields,
    adjustmentAccountId: adjustmentEntryFields.adjustmentAccountId.describe(
      "Id of the account the cost of the stock taken out posts to (chart of accounts); leave out for the item's Cost of Goods Sold account.",
    ),
    ...siteFields,
  }),
]);
