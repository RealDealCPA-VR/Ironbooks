/**
 * Zod schemas for /api/bills — mirrors CreateBillInput / BillLineInput
 * (lib/services/bills.ts). PATCH /api/bills/:id reuses the same shape
 * (updateBill is a full replace taking CreateBillInput).
 */
import { z } from 'zod';
import { zDate, zDecimal, zLines, zMoney, zUuid } from './helpers';
import { inventoryLineFields } from './inventorySites';

export const billLineSchema = z.object({
  accountId: zUuid
    .nullish()
    .describe('Id of the expense or asset account charged (chart of accounts); required unless itemId is given.'),
  itemId: zUuid
    .nullish()
    .describe('Id of the item bought (item list); inventory items are received into stock.'),
  description: z.string().nullish().describe('Text saved on the line.'),
  quantity: zDecimal.nullish().describe('Units bought as decimal text such as "2"; required above zero on item lines.'),
  unitCost: zDecimal.nullish().describe('Cost per unit on item lines, as decimal text such as "12.50".'),
  amount: zMoney
    .nullish()
    .describe('Line amount above zero as decimal text such as "125.00"; on item lines it defaults to quantity times unitCost.'),
  classId: zUuid.nullish().describe('Id of a class (class list) for reports by class.'),
  customerId: zUuid
    .nullish()
    .describe('Id of a customer (customer list) this cost is for, which makes the line billable to them.'),
  jobId: zUuid.nullish().describe("Id of one of that customer's jobs (job list), for job costing."),
  /** Advanced Inventory: receiving site/bin/serial/lot (inventory item lines only). */
  ...inventoryLineFields,
});

export const createBillSchema = z.object({
  vendorId: zUuid.describe('Id of the vendor who sent the bill (vendor list).'),
  /** Vendor's reference number (bills.bill_number is varchar(100)). */
  billNumber: z
    .string()
    .max(100, 'can be at most 100 characters')
    .nullish()
    .describe("The vendor's own bill or invoice number (at most 100 characters)."),
  date: zDate.describe('Bill date, YYYY-MM-DD.'),
  dueDate: zDate.nullish().describe('Date the bill is due, YYYY-MM-DD; leave out to work it out from the terms.'),
  /** Payment terms ('net_30', '2_10_net_30', …); default = the vendor's terms. */
  terms: z
    .string()
    .max(50)
    .nullish()
    .describe("Payment terms such as \"Net 30\"; leave out to use the vendor's terms."),
  memo: z.string().nullish().describe('Internal note saved with the bill.'),
  classId: zUuid.nullish().describe('Id of a class (class list) for reports by class.'),
  /** Multi-currency: transaction currency + home units per 1 unit (defaults from vendor / list). */
  currency: z
    .string()
    .max(3)
    .nullish()
    .describe("3-letter currency code of the bill such as \"EUR\"; leave out for the vendor's currency."),
  exchangeRate: zDecimal
    .nullish()
    .describe('Home-currency units per 1 unit of the bill currency, as decimal text such as "1.10"; leave out for the currency list rate.'),
  /** The user saw the duplicate vendor reference warning and chose to keep the number. */
  allowDuplicateNumber: z
    .boolean()
    .optional()
    .describe('Send true only after the app warned that this vendor already has a bill with this number, to save it anyway.'),
  lines: zLines(billLineSchema).describe('Bill lines, each an account or an item; at least one.'),
});
export type CreateBillBody = z.infer<typeof createBillSchema>;
