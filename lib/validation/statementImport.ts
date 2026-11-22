/**
 * Zod schemas for reading a bank statement file before it is imported (/api/import/extract,
 * /api/import/statement-assist; lib/services/statementImport.ts). Neither one imports or saves
 * anything: the review screen shows the result and the person still imports.
 *
 * SERVER ONLY: it imports the statement service for its size limit.
 */
import { z } from 'zod';
import { MAX_STATEMENT_BYTES } from '@/lib/services/statementImport';

/** POST /api/import/extract — read a statement file (Excel, PDF or a picture). */
export const extractStatementSchema = z.object({
  bankAccountId: z.string().uuid().describe('Id of the bank or credit card account the statement is for (bank account list).'),
  filename: z
    .string()
    .min(1)
    .max(255)
    .describe('File name with its extension (.xlsx, .pdf, .png or .jpg); the extension decides how the file is read.'),
  // base64 of at most MAX_STATEMENT_BYTES (4 chars per 3 bytes).
  data: z
    .string()
    .min(1)
    .max(Math.ceil(MAX_STATEMENT_BYTES / 3) * 4 + 4)
    .describe(`The file's bytes as base64 text, at most ${Math.round(MAX_STATEMENT_BYTES / (1024 * 1024))} MB before encoding.`),
});

/** POST /api/import/statement-assist — "Fix with AI" on the statement review screen. */
export const statementAssistSchema = z.object({
  bankAccountId: z.string().uuid().describe('Id of the bank or credit card account the statement is for (bank account list).'),
  text: z
    .string()
    .max(200_000)
    .default('')
    .describe('Text read from the statement file, which the AI checks the rows against; leave out for none.'),
  rows: z
    .array(
      z.object({
        date: z.string().max(20).describe('Date of the row as read, such as "2026-03-14".'),
        description: z.string().max(500).describe('Description of the row as read.'),
        amount: z.string().max(30).describe('Amount of the row as decimal text, negative for money out, such as "-42.10".'),
      }),
    )
    .max(1500)
    .describe('The rows on the review screen now, at most 1,500.'),
  openingBalance: z.string().max(30).nullable().describe('Opening balance of the statement as decimal text, or null when it is not known.'),
  closingBalance: z.string().max(30).nullable().describe('Closing balance of the statement as decimal text, or null when it is not known.'),
  instruction: z
    .string()
    .max(1000)
    .nullable()
    .optional()
    .describe('What the person asked the AI to fix, in their own words; leave out for a general check.'),
});
