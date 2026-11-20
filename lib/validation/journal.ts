/**
 * Zod schemas for /api/journal-entries — mirrors ManualEntryInput / PostingLine.
 * Debit-xor-credit and balance enforcement stay in postJournalEntry.
 */
import { z } from 'zod';
import { zDate, zLines, zMoney, zUuid } from './helpers';

export const postingLineSchema = z.object({
  accountId: zUuid.describe('Id of the account this line posts to (chart of accounts).'),
  debit: zMoney.nullish().describe('Debit amount as decimal text such as "125.00"; give a debit or a credit on each line, not both.'),
  credit: zMoney.nullish().describe('Credit amount as decimal text such as "125.00"; give a debit or a credit on each line, not both.'),
  memo: z.string().nullish().describe('Text saved on the line.'),
  classId: zUuid.nullish().describe('Id of a class (class list) for reports by class.'),
  /** QB "Name" column (customer / vendor / employee / other) — required on A/R and A/P lines. */
  entityType: z
    .enum(['customer', 'vendor', 'employee', 'other'])
    .nullish()
    .describe('Which list the name on the line is from (other means the Other Names list); required on receivable and payable lines.'),
  entityId: zUuid
    .nullish()
    .describe('Id of the customer, vendor, employee or Other Names entry named on the line; goes with entityType.'),
});

export const createJournalEntrySchema = z.object({
  date: zDate.describe('Entry date, YYYY-MM-DD.'),
  description: z.string().trim().min(1, 'description is required').describe('What the entry is for, such as "Record March depreciation".'),
  /** QB "Entry No." — journal_entries.reference is varchar(100). */
  reference: z
    .string()
    .trim()
    .max(100, 'Entry No. can be at most 100 characters.')
    .nullish()
    .describe('Entry number (at most 100 characters); on an edit, leave out to keep it or send null to clear it.'),
  lines: zLines(postingLineSchema).describe('The entry lines; total debits must equal total credits.'),
  /** QB "Adjusting Entry" checkbox. */
  isAdjusting: z.boolean().optional().describe('True marks the entry as an adjusting entry.'),
  /** Edits: the user confirmed QB's "this transaction has been reconciled" warning (reconciledEdits.ts). */
  allowReconciledEdit: z
    .boolean()
    .optional()
    .describe('Edits only: send true only after the app warned that this entry is reconciled with a statement, to save the change anyway.'),
});
export type CreateJournalEntryBody = z.infer<typeof createJournalEntrySchema>;

/**
 * PATCH /api/journal-entries/:id — the same body as a new entry (the edit re-posts it). An
 * omitted `reference` keeps the entry's number; `null` clears it.
 */
export const updateJournalEntrySchema = createJournalEntrySchema;
export type UpdateJournalEntryBody = z.infer<typeof updateJournalEntrySchema>;
