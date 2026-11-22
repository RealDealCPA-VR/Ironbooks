/**
 * Zod schema for POST /api/command-bar — the Ctrl+K command bar's plain-English engine
 * (lib/services/commandBar.ts runCommand). Read-only: it never creates, posts or changes a record.
 */
import { z } from 'zod';
import { commandIntentSchema, resolveHintsSchema } from '@/lib/commands/intent';

export const commandBarSchema = z
  .object({
    text: z
      .string()
      .max(500)
      .optional()
      .describe('The command as typed, in plain English, such as "invoice Acme 500 for consulting"; send this or intent.'),
    intent: commandIntentSchema
      .optional()
      .describe('A pick from an earlier "Which one did you mean?" answer, sent back as it came, to run it again.'),
    hints: resolveHintsSchema
      .optional()
      .describe('With intent: what was picked from the "Which one did you mean?" list (the customer or vendor, items, accounts or form).'),
    allowAi: z
      .boolean()
      .optional()
      .describe("True lets the company's AI model try when the typed text is not understood; leave out to use only the built-in grammar."),
  })
  .refine((b) => !!b.text?.trim() || !!b.intent, { message: 'Type what you want to do.', path: ['text'] });
