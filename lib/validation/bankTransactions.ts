/**
 * Zod schemas for the bank feed review actions (/api/bank-transactions/categorize, match, unmatch,
 * exclude; lib/services/bankCategorize.ts).
 *
 * These routes read their body by hand, and their own checks answer first with the messages they
 * always gave. The schema is checked after them: it says what each field is, for agents
 * (describe_operation, plan §6.3), and refuses only a value the service could not use anyway (an
 * id that is not text). A field the handler ignores or converts when it has another type is
 * zLenient, so what each route accepts is unchanged.
 */
import { z } from 'zod';
import { zLenient, zUuid } from './helpers';
import { splitSchema } from '@/lib/bankRules/schemas';

const bankLineId = z
  .string({ invalid_type_error: 'must be the id of a bank feed line' })
  .min(1)
  .describe('Id of the bank feed line (GET /api/bank-transactions?bankAccountId=… lists them).');

/** POST /api/bank-transactions/categorize — add a feed line to the register (QB "Add"). */
export const categorizeBankLineSchema = z.object({
  bankTransactionId: bankLineId,
  accountId: zLenient(zUuid.nullable()).describe(
    'Id of the account (chart of accounts) the line goes to, such as an expense or income account; needed unless splits are given. It cannot be the bank account the line came from.',
  ),
  payee: zLenient(z.string().max(255).nullable()).describe("Payee for the entry (at most 255 characters); leave out to keep the line's own."),
  memo: zLenient(z.string().nullable()).describe('Memo for the entry; leave out for none.'),
  exchangeRate: zLenient(z.union([z.string(), z.number()]).nullable()).describe(
    "Foreign-currency bank or card accounts only: home-currency units per 1 unit of the account's currency, as decimal text such as \"1.10\"; leave out for the currency list's rate.",
  ),
  classId: zLenient(zUuid.nullable()).describe('Id of a class (class list) for the entry; leave out for none.'),
  splits: zLenient(splitSchema.array().max(20).nullable()).describe(
    'Split the line across accounts by percentage (at most 20 shares adding up to 100); when given, accountId is not used.',
  ),
});

/** POST /api/bank-transactions/match — link a feed line to an entry already in the books (QB "Match"). */
export const matchBankLineSchema = z.object({
  bankTransactionId: bankLineId,
  journalEntryId: z
    .string({ invalid_type_error: 'must be the id of a journal entry' })
    .min(1)
    .describe(
      'Id of the posted entry the line is matched to (GET /api/bank-transactions/matches?bankAccountId=… lists the candidates); nothing new is posted.',
    ),
});

/** POST /api/bank-transactions/unmatch — undo an add or a match. */
export const unmatchBankLineSchema = z.object({
  bankTransactionId: bankLineId.describe(
    'Id of the bank feed line to put back in the review list: an entry the add posted is voided, an entry it was matched to stays as it is.',
  ),
});

/** POST /api/bank-transactions/exclude — leave a feed line out of review, or bring it back. */
export const excludeBankLineSchema = z.object({
  bankTransactionId: bankLineId,
  restore: zLenient(z.boolean()).describe('true puts an excluded line back in the review list; leave out to exclude the line (a duplicate or a personal charge).'),
});
