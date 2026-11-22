/**
 * Zod schema for PATCH /api/reconciliations/:id — work on a reconciliation in progress
 * (lib/services/reconcile.ts).
 *
 * The route reads this body by hand, and its own checks answer first with the messages they always
 * gave. The schema is checked after them: it says what each field is, for agents (describe_operation,
 * plan §6.3), and refuses only a value the service could not use anyway (a line id that is not
 * text). Fields the handler passes on unchecked are zLenient (the service checks them), so what the
 * route accepts is unchanged.
 */
import { z } from 'zod';
import { zLenient, zUuid } from './helpers';

const statementAdjustment = (what: string) =>
  zLenient(
    z
      .object({
        amount: z.union([z.string(), z.number()]).describe(`Amount of the ${what}, as decimal text above zero such as "12.00".`),
        accountId: zUuid.describe(`Id of the account (chart of accounts) the ${what} posts to.`),
      })
      .nullable(),
  );

const isCleared = z.boolean().describe('true marks as cleared (on the statement); false takes the mark off.');

export const reconciliationUpdateSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('complete').describe('complete: finish the reconciliation; the difference must be zero unless adjust is true.'),
    adjust: zLenient(z.boolean()).describe(
      'true first posts a difference that is left to Reconciliation Discrepancies (QB "Enter Adjustment"), then finishes; leave out to finish only when the difference is zero.',
    ),
  }),
  z.object({
    action: z.literal('setClearedMany').describe('setClearedMany: mark or unmark many lines at once (Mark All / Unmark All).'),
    journalEntryLineIds: z
      .array(zLenient(z.string()))
      .describe('Ids of the entry lines of this account to mark or unmark (GET /api/reconciliations/:id lists them).'),
    isCleared,
  }),
  z.object({
    action: z.literal('toggleCleared').describe('toggleCleared: mark or unmark one line.'),
    journalEntryLineId: z.string().min(1).describe('Id of the entry line to mark or unmark (GET /api/reconciliations/:id lists them).'),
    isCleared,
  }),
  z.object({
    action: z.literal('updateStatement').describe('updateStatement: correct the statement ending balance and/or date; send at least one.'),
    statementBalance: zLenient(z.union([z.string(), z.number()]).nullable()).describe(
      'Ending balance on the statement, as decimal text such as "10432.18"; leave out to keep it.',
    ),
    statementDate: zLenient(z.string().nullable()).describe('Ending date of the statement, YYYY-MM-DD; leave out to keep it.'),
  }),
  z.object({
    action: z
      .literal('adjustments')
      .describe('adjustments: enter the service charge and/or interest the statement shows; they are posted and marked cleared. Send at least one.'),
    serviceCharge: statementAdjustment('service charge').describe('The bank service charge on the statement; leave out for none.'),
    interestEarned: statementAdjustment('interest earned').describe('The interest earned on the statement; leave out for none.'),
    exchangeRate: zLenient(z.union([z.string(), z.number()]).nullable()).describe(
      "Foreign-currency accounts only: home-currency units per 1 unit of the account's currency, as decimal text; leave out for the currency list's rate.",
    ),
  }),
]);
