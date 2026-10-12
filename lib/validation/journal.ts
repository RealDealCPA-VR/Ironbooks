/**
 * Zod schemas for /api/journal-entries — mirrors ManualEntryInput / PostingLine.
 * Debit-xor-credit and balance enforcement stay in postJournalEntry.
 */
import { z } from 'zod';
import { zDate, zLines, zMoney, zUuid } from './helpers';

export const postingLineSchema = z.object({
  accountId: zUuid,
  debit: zMoney.nullish(),
  credit: zMoney.nullish(),
  memo: z.string().nullish(),
  classId: zUuid.nullish(),
  /** QB "Name" column (customer / vendor / employee / other) — required on A/R and A/P lines. */
  entityType: z.enum(['customer', 'vendor', 'employee', 'other']).nullish(),
  entityId: zUuid.nullish(),
});

export const createJournalEntrySchema = z.object({
  date: zDate,
  description: z.string().trim().min(1, 'description is required'),
  reference: z.string().nullish(),
  lines: zLines(postingLineSchema),
  /** QB "Adjusting Entry" checkbox. */
  isAdjusting: z.boolean().optional(),
});
export type CreateJournalEntryBody = z.infer<typeof createJournalEntrySchema>;
