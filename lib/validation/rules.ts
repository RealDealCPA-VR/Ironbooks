/**
 * Zod schema for POST /api/rules — a categorization rule that suggests an account for matching
 * bank feed lines (lib/services/rules.ts; the fuller bank rules are /api/bank-rules).
 *
 * The route reads this body by hand, and its own checks answer first with the messages they always
 * gave. The schema is checked after them: it says what each field is, for agents (describe_operation,
 * plan §6.3). The two fields the handler converts when they have another type are zLenient, so what
 * the route accepts is unchanged.
 */
import { z } from 'zod';
import { zLenient } from './helpers';

export const createRuleSchema = z.object({
  name: z.string().min(1).describe('Name of the rule, such as "Shell is fuel".'),
  matchField: z.enum(['description', 'payee', 'amount']).describe('Which part of the bank line the rule looks at: description, payee or amount.'),
  matchOperator: z.enum(['contains', 'equals', 'starts_with']).describe('How matchValue is compared: contains, equals or starts_with.'),
  matchValue: z.string().min(1).describe('The text (or, for amount, the amount as decimal text) the line must match.'),
  setAccountId: z.string().min(1).describe('Id of the account (chart of accounts) suggested for matching lines.'),
  setPayee: zLenient(z.string().nullable()).describe("Payee suggested for matching lines; leave out to keep each line's own."),
  priority: zLenient(z.number()).describe('Rules with a higher priority are checked first, and the first match wins; leave out for 0.'),
});
