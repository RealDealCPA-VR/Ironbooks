/**
 * Zod schemas for the AI routes that take a body (/api/ai/*). None of them needs a pay-per-use
 * key: they run on the AI the company set up (a plan sign-in or a model on this computer), or on
 * the app's own learned categorizer.
 */
import { z } from 'zod';

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
