/**
 * Zod schemas for /api/purchase-orders — mirrors CreatePurchaseOrderInput /
 * PurchaseOrderLineInput and the /:id action dispatch (convert / void / close)
 * (lib/services/purchaseOrders.ts).
 */
import { z } from 'zod';
import { zDate, zDecimal, zDocNumber, zLines, zUuid } from './helpers';

export const purchaseOrderLineSchema = z.object({
  itemId: zUuid.nullish(),
  /** Required by the service unless itemId is set. */
  accountId: zUuid.nullish(),
  description: z.string().nullish(),
  quantity: zDecimal,
  rate: zDecimal,
});

export const createPurchaseOrderSchema = z.object({
  vendorId: zUuid,
  /** Typed document number (e.g. "INV-1001"); blank = next number. */
  refNumber: zDocNumber,
  allowDuplicateNumber: z.boolean().nullish(),
  date: zDate,
  expectedDate: zDate.nullish(),
  memo: z.string().nullish(),
  lines: zLines(purchaseOrderLineSchema),
});
export type CreatePurchaseOrderBody = z.infer<typeof createPurchaseOrderSchema>;

/** Per-line partial billing request ({ lineId, quantity }). */
export const poBillLineSchema = z.object({
  lineId: zUuid,
  quantity: zDecimal,
});

/** POST /api/purchase-orders/:id — { action: 'convert' | 'void' | 'close', ... }. */
export const purchaseOrderActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('convert'),
    /** Omitted → bill the full remaining quantity of every line. */
    lines: zLines(poBillLineSchema).optional(),
    date: zDate.optional(),
    billNumber: z.string().nullish(),
  }),
  z.object({ action: z.literal('void') }),
  z.object({ action: z.literal('close') }),
]);
export type PurchaseOrderActionBody = z.infer<typeof purchaseOrderActionSchema>;
