/**
 * Zod schemas for /api/bills — mirrors CreateBillInput / BillLineInput
 * (lib/services/bills.ts). PATCH /api/bills/:id reuses the same shape
 * (updateBill is a full replace taking CreateBillInput).
 */
import { z } from 'zod';
import { zDate, zDecimal, zLines, zMoney, zUuid } from './helpers';
import { inventoryLineFields } from './inventorySites';

export const billLineSchema = z.object({
  accountId: zUuid.nullish(),
  itemId: zUuid.nullish(),
  description: z.string().nullish(),
  quantity: zDecimal.nullish(),
  unitCost: zDecimal.nullish(),
  amount: zMoney.nullish(),
  classId: zUuid.nullish(),
  customerId: zUuid.nullish(),
  jobId: zUuid.nullish(),
  /** Advanced Inventory: receiving site/bin/serial/lot (inventory item lines only). */
  ...inventoryLineFields,
});

export const createBillSchema = z.object({
  vendorId: zUuid,
  /** Vendor's reference number (bills.bill_number is varchar(100)). */
  billNumber: z.string().max(100, 'can be at most 100 characters').nullish(),
  date: zDate,
  dueDate: zDate.nullish(),
  /** Payment terms ('net_30', '2_10_net_30', …); default = the vendor's terms. */
  terms: z.string().max(50).nullish(),
  memo: z.string().nullish(),
  classId: zUuid.nullish(),
  /** Multi-currency: transaction currency + home units per 1 unit (defaults from vendor / list). */
  currency: z.string().max(3).nullish(),
  exchangeRate: zDecimal.nullish(),
  /** The user saw the duplicate vendor reference warning and chose to keep the number. */
  allowDuplicateNumber: z.boolean().optional(),
  lines: zLines(billLineSchema),
});
export type CreateBillBody = z.infer<typeof createBillSchema>;
