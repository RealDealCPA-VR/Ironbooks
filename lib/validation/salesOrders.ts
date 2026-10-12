/**
 * Zod schemas for /api/sales-orders — mirrors CreateSalesOrderInput /
 * SalesOrderLineInput and the /:id action dispatch (convert / status)
 * (lib/services/salesOrders.ts).
 */
import { z } from 'zod';
import { zDate, zDecimal, zDocNumber, zLines, zUuid } from './helpers';
import { sendFlagFields, shippingFields } from './sales';

export const salesOrderLineSchema = z.object({
  /** Edit only: the existing line this row updates (keeps its invoiced quantity). */
  id: zUuid.nullish(),
  itemId: zUuid.nullish(),
  description: z.string().nullish(),
  quantity: zDecimal,
  /** Omit on item lines to have the server price the line (advanced pricing). */
  rate: zDecimal.nullish(),
  /** QB "Tax" column; defaults to true. */
  taxable: z.boolean().optional(),
});

export const createSalesOrderSchema = z.object({
  customerId: zUuid,
  /** Typed document number (e.g. "INV-1001"); blank = next number. */
  refNumber: zDocNumber,
  allowDuplicateNumber: z.boolean().nullish(),
  date: zDate,
  memo: z.string().nullish(),
  /** Omitted → the customer's tax item; null → no tax. */
  taxRateId: zUuid.nullish(),
  lines: zLines(salesOrderLineSchema),
  ...shippingFields,
  ...sendFlagFields,
});
export type CreateSalesOrderBody = z.infer<typeof createSalesOrderSchema>;

/** Per-line partial conversion request ({ lineId, quantity }). */
export const convertLineSchema = z.object({
  lineId: zUuid,
  quantity: zDecimal,
});

/** POST /api/sales-orders/:id — { action: 'convert' | 'status', ... }. */
export const salesOrderActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('convert'),
    /** Omitted → invoice the full remaining quantity of every line. */
    lines: zLines(convertLineSchema).optional(),
    date: zDate.optional(),
    overrideCreditLimit: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('status'),
    status: z.enum(['open', 'closed', 'void']),
  }),
]);
export type SalesOrderActionBody = z.infer<typeof salesOrderActionSchema>;
