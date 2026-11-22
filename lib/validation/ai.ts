/**
 * Zod schemas for the AI routes that take a body (/api/ai/*). None of them needs a pay-per-use
 * key: they run on the AI the company set up (a plan sign-in or a model on this computer), or on
 * the app's own learned categorizer.
 */
import { z } from 'zod';
import { zLenient } from './helpers';

/** POST /api/ai/recurring — memorize a detected recurring bill or expense (lib/services/aiRecurring.ts). */
export const memorizeSuggestionSchema = z.object({
  docType: z.enum(['bill', 'expense']).describe('What the source document is: a bill or an expense (check or card charge).'),
  sourceDocId: z.string().uuid().describe('Id of the bill or expense to memorize, from GET /api/ai/recurring (suggestions).'),
  frequency: z.enum(['weekly', 'monthly', 'quarterly', 'yearly']).describe('How often it recurs.'),
  nextRunDate: z
    .string()
    .refine((s) => !isNaN(new Date(s).getTime()), 'invalid date')
    .describe('Date it is next due, YYYY-MM-DD.'),
  name: z.string().trim().min(1).max(255).describe('Name of the memorized transaction, such as "Office rent".'),
  autoEnter: z
    .boolean()
    .optional()
    .describe('True enters it on its own when due; leave out (or false) to only remind a person.'),
});

/** POST /api/ai/bank-suggestions — the learned categorizer's actions on bank feed lines. */
export const bankSuggestionActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z
      .literal('auto-apply')
      .describe("auto-apply: add every waiting line whose suggestion is at least as sure as the company's auto-apply threshold."),
    bankAccountId: z.string().uuid().describe('Id of the bank or card account (bank account list) whose waiting lines are added.'),
  }),
  z.object({
    action: z.literal('llm').describe("llm: ask the company's AI for a second opinion on one line; nothing is posted."),
    bankTransactionId: z.string().uuid().describe('Id of the bank feed line to ask about.'),
  }),
]);

/** POST /api/ai/assistant — one question to the in-app assistant (read-only report tools). */
export const assistantMessageSchema = z.object({
  message: z.string().trim().min(1).max(4000).describe('The question, in plain words (at most 4,000 characters).'),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']).describe('Who said it: user or assistant.'),
        content: z.string().max(8000).describe('What was said.'),
      }),
    )
    .max(40)
    .default([])
    .describe('The conversation so far, oldest first, at most 40 turns; leave out to start a new one.'),
});

/**
 * POST /api/ai/posts — undo one entry the AI posted from the bank feed (lib/services/aiPosts.ts
 * undoAiPost). The route checks both fields itself; this says what they are, for agents.
 */
export const undoAiPostSchema = z.object({
  action: z.literal('undo').describe("undo: Bank Review's Unmatch on the line: the entry the AI posted is voided and the line goes back to review."),
  id: z.string().describe('Id of the AI post to undo (GET /api/ai/posts lists them, posts[].id); one you changed since is left as you set it.'),
});

/** Debit and credit: the route turns any value into text with String(), and the posting checks it. */
const lineAmount = () => zLenient(z.union([z.string(), z.number()]).nullable());

/**
 * POST /api/errors/:id/apply — apply a correction the AI suggested for a possible error (the :id is
 * the error, from GET /api/errors; lib/services/llmCorrector.ts applyCorrection). The route checks
 * the correction id and the shape of an edited entry itself, and reads the rest loosely, so this
 * refuses only a value the service could not use: a correctionId that is not text (such as 5) gets
 * past the route's own check, and is now answered 400 with this schema's message instead of
 * reaching the service. Nothing that could be applied is refused.
 */
export const applyCorrectionSchema = z.object({
  correctionId: z
    .string()
    .min(1)
    .describe("Id of the correction to apply: one of the error's suggestions (POST /api/errors/:id/analyze makes one and answers it)."),
  approved: zLenient(z.boolean()).describe(
    'Send true to post the correcting journal entry (the closing date applies); a correction that carries an entry is refused without it. A correction with no entry is only marked applied.',
  ),
  entry: z
    .object({
      date: z.string().describe('Date of the correcting entry, YYYY-MM-DD.'),
      description: z.string().describe('Description of the correcting entry.'),
      lines: z
        .array(
          z.object({
            accountId: z.string().describe('Id of the account (chart of accounts) of the line.'),
            debit: lineAmount().describe('Debit amount as decimal text such as "125.00"; leave out on a credit line.'),
            credit: lineAmount().describe('Credit amount as decimal text such as "125.00"; leave out on a debit line.'),
            memo: zLenient(z.string().nullable()).describe('Memo of the line; leave out for none.'),
            entityType: zLenient(z.enum(['customer', 'vendor', 'employee', 'other']).nullable()).describe(
              'Kind of name on the line (customer, vendor, employee or other); needed on an A/R or A/P line.',
            ),
            entityId: zLenient(z.string().nullable()).describe('Id of that customer, vendor, employee or other name.'),
          }),
        )
        .describe('The lines of the entry; debits and credits must balance.'),
    })
    .nullish()
    .describe("The correcting entry as you reviewed it, posted instead of the AI's suggested one; leave out to use the suggestion."),
});
