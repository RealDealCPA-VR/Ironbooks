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
  // purchbank: QB Customer:Job and Class columns (carried onto the bill)
  customerId: zUuid.nullish(),
  jobId: zUuid.nullish(),
  classId: zUuid.nullish(),
});

/** purchbank: P.O. Ship To address (each line at most 255 characters). */
export const poShipToSchema = z.object({
  name: z.string().max(255).nullish(),
  line1: z.string().max(255).nullish(),
  line2: z.string().max(255).nullish(),
  city: z.string().max(255).nullish(),
  state: z.string().max(255).nullish(),
  zip: z.string().max(255).nullish(),
  country: z.string().max(255).nullish(),
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
  /** purchbank: typed Ship To (null = the company address; omitted on an edit = kept). */
  shipTo: poShipToSchema.nullish(),
  /** purchbank: drop ship to this customer (their shipping address when none is typed). */
  shipToCustomerId: zUuid.nullish(),
});
export type CreatePurchaseOrderBody = z.infer<typeof createPurchaseOrderSchema>;

/** PATCH /api/purchase-orders/:id — full edit; existing lines carry their id. */
export const updatePurchaseOrderSchema = createPurchaseOrderSchema.extend({
  lines: zLines(purchaseOrderLineSchema.extend({ id: zUuid.nullish() })),
});

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
    /** The user confirmed QB's "this vendor already has a bill with that reference number" warning. */
    allowDuplicateNumber: z.boolean().optional(),
  }),
  z.object({ action: z.literal('void') }),
  z.object({ action: z.literal('close') }),
]);
export type PurchaseOrderActionBody = z.infer<typeof purchaseOrderActionSchema>;
