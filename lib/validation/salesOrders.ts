/**
 * Zod schemas for /api/sales-orders — mirrors CreateSalesOrderInput /
 * SalesOrderLineInput and the /:id action dispatch (convert / status)
 * (lib/services/salesOrders.ts).
 */
import { z } from 'zod';
import { zDate, zDecimal, zLines, zUuid } from './helpers';

export const salesOrderLineSchema = z.object({
  itemId: zUuid.nullish(),
  description: z.string().nullish(),
  quantity: zDecimal,
  /** Omit on item lines to have the server price the line (advanced pricing). */
  rate: zDecimal.nullish(),
});

export const createSalesOrderSchema = z.object({
  customerId: zUuid,
  date: zDate,
  memo: z.string().nullish(),
  lines: zLines(salesOrderLineSchema),
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
  }),
  z.object({
    action: z.literal('status'),
    status: z.enum(['open', 'closed', 'void']),
  }),
]);
export type SalesOrderActionBody = z.infer<typeof salesOrderActionSchema>;
