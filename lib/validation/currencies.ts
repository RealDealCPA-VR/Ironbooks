/**
 * Zod schema for POST /api/currencies/fx-adjustment — record an exchange gain or loss as one
 * balanced journal entry (lib/services/currencies.ts recordFxAdjustment).
 *
 * The route reads this body by hand, and its own checks answer first with the messages they always
 * gave; every field is checked there. The schema is checked after them and says what each field
 * is, for agents (describe_operation, plan §6.3), so what the route accepts is unchanged.
 */
import { z } from 'zod';

export const fxAdjustmentSchema = z.object({
  accountId: z
    .string()
    .min(1)
    .describe(
      'Id of the account (chart of accounts) being revalued; not Exchange Gain/Loss itself, which takes the other side. On a foreign-currency bank or card account only its home-currency value changes.',
    ),
  amount: z
    .union([z.string(), z.number()])
    .describe('Size of the gain or loss in home currency, above zero, as decimal text such as "37.50" (a minus sign is ignored: gain says which way it goes).'),
  gain: z
    .boolean()
    .describe('true for an exchange gain (Dr the account, Cr Exchange Gain/Loss); false for a loss (Dr Exchange Gain/Loss, Cr the account).'),
  date: z.string().min(1).describe('Date of the entry, YYYY-MM-DD.'),
  memo: z.string().nullish().describe('Description of the entry; leave out for "FX gain adjustment" or "FX loss adjustment".'),
});
