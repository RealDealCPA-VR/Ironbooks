/**
 * Zod schemas for PATCH /api/reconciliations/:id — work on a reconciliation in progress — and
 * POST /api/reconciliations/:id/pay — pay the card after one (lib/services/reconcile.ts).
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

/**
 * POST /api/reconciliations/:id/pay — QB "Write a check for the balance" after a credit card
 * reconciliation is completed (lib/services/reconcile.ts payCreditCardBalance): Dr the card, Cr the
 * bank, once per reconciliation. The route checks paymentAccountId itself; the service checks the
 * rest with its own messages, so those fields are zLenient. The one change is for a
 * paymentAccountId that is not text (such as 5): it gets past the route's own check, and is now
 * answered 400 with this schema's message, before the service's "Choose the account to pay from."
 * and before its Write Checks permission check (which answered 403 first). Nothing that could be
 * paid is refused.
 */
export const payCreditCardBalanceSchema = z.object({
  paymentAccountId: z
    .string({ invalid_type_error: 'must be the id of a bank account' })
    .min(1)
    .describe('Id of the bank account (chart of accounts) the payment comes out of.'),
  amount: zLenient(z.union([z.string(), z.number()]).nullable()).describe(
    "Amount paid to the card, as decimal text such as \"512.40\"; leave out to pay the reconciliation's statement ending balance.",
  ),
  date: zLenient(z.string().nullable()).describe('Date of the payment, YYYY-MM-DD; leave out for today.'),
  memo: zLenient(z.string().nullable()).describe('Description of the payment entry; leave out for "Credit card payment — <card name>".'),
  exchangeRate: zLenient(z.union([z.string(), z.number()]).nullable()).describe(
    "Foreign-currency cards only: home-currency units per 1 unit of the card's currency, as decimal text such as \"1.10\"; leave out for the currency list's rate.",
  ),
});
