/**
 * Zod schemas for the accountant tools (/api/accountant/*) — wave2 accountant.
 * Mirror the service inputs in lib/services/accountant/*.
 */
import { z } from 'zod';
import { zDate, zLines, zMoneyPositive, zUuid } from './helpers';
import { postingLineSchema } from './journal';

export const salesTaxAdjustmentSchema = z.object({
  date: zDate,
  agencyId: zUuid,
  amount: zMoneyPositive,
  direction: z.enum(['reduce', 'increase'], { errorMap: () => ({ message: "direction must be 'reduce' or 'increase'" }) }),
  adjustmentAccountId: zUuid,
  reason: z.enum(['discount', 'rounding', 'penalty', 'interest', 'other']),
  memo: z.string().nullish(),
  reference: z.string().nullish(),
});

export const fixSalesTaxSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('link'),
    lineId: zUuid,
    agencyId: zUuid,
    kind: z.enum(['payment', 'adjustment', 'collected']),
    note: z.string().nullish(),
  }),
  z.object({ action: z.literal('unlink'), lineId: zUuid }),
  z.object({ action: z.literal('reclassify'), lineId: zUuid, agencyId: zUuid, date: zDate.nullish() }),
  z.object({ action: z.literal('undo_fix'), entryId: zUuid }),
]);

export const reclassifySchema = z
  .object({
    lineIds: z.array(zUuid).min(1, 'select at least one line').max(2000),
    newAccountId: zUuid.nullish(),
    /** null clears the class; omit to keep it. */
    newClassId: zUuid.nullable().optional(),
  })
  .refine((v) => Boolean(v.newAccountId) || v.newClassId !== undefined, {
    message: 'Choose a new account and/or a new class.',
    path: ['newAccountId'],
  });

export const writeOffSchema = z.object({
  invoiceIds: z.array(zUuid).min(1, 'select at least one invoice').max(500),
  date: zDate,
  badDebtAccountId: zUuid,
  memo: z.string().nullish(),
});

const batchRowSchema = z.object({
  date: z.string().default(''),
  ref: z.string().optional(),
  name: z.string().optional(),
  account: z.string().default(''),
  amount: z.string().optional(),
  debit: z.string().optional(),
  credit: z.string().optional(),
  memo: z.string().optional(),
  className: z.string().optional(),
  dueDate: z.string().optional(),
});

export const batchEnterSchema = z.object({
  type: z.enum(['check', 'deposit', 'cc_charge', 'cc_credit', 'invoice', 'credit_memo', 'bill', 'bill_credit', 'journal']),
  bankAccountId: zUuid.nullish(),
  rows: z.array(batchRowSchema).min(1, 'enter at least one row').max(1000),
  mode: z.enum(['all', 'row']).optional(),
  validateOnly: z.boolean().optional(),
});

export const batchVoidSchema = z.object({
  keys: z.array(z.string().regex(/^[a-z_]+:[0-9a-f-]{36}$/i, 'invalid transaction key')).min(1).max(500),
});

export const wtbNoteSchema = z.object({
  accountId: zUuid,
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'periodEnd must be YYYY-MM-DD'),
  workpaperRef: z.string().max(100).nullish(),
  note: z.string().max(4000).nullish(),
});

export const adjustingEntrySchema = z.object({
  date: zDate,
  description: z.string().trim().min(1, 'description is required'),
  reference: z.string().nullish(),
  lines: zLines(postingLineSchema),
});

export const listChangesReviewSchema = z.object({
  auditLogIds: z.array(zUuid).min(1).max(5000),
  reviewed: z.boolean(),
});

export const clientReviewActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('task_status'),
    taskKey: z.string().min(1),
    status: z.enum(['not_started', 'in_progress', 'completed']),
    note: z.string().nullish(),
  }),
  z.object({
    action: z.literal('snapshot'),
    asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'asOf must be YYYY-MM-DD'),
    note: z.string().nullish(),
  }),
  z.object({ action: z.literal('apply_customer_credit'), refType: z.enum(['payment', 'credit_memo']), refId: zUuid }),
  z.object({ action: z.literal('apply_vendor_credit'), refId: zUuid }),
]);

