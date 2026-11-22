/**
 * Zod schemas for the bank feed review actions (/api/bank-transactions/categorize, match, unmatch,
 * exclude; lib/services/bankCategorize.ts), linking a bank account (/api/bank-accounts) and loading
 * the sample feed (/api/demo-feed).
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

/**
 * POST /api/bank-accounts — link a bank or credit card account to its account in the chart of
 * accounts, so its feed lines and reconciliations have a home (lib/services/bankAccounts.ts
 * createBankAccount). The route passes the body to the service, which checks every field with its
 * own words ("Bank name is required."), so every field here is zLenient: the check refuses nothing
 * and says what each field is, for agents.
 */
export const createBankAccountSchema = z.object({
  accountId: zLenient(zUuid).describe(
    'Required. Id of the account (chart of accounts) to link: a bank, credit card or other balance-sheet account that has no link yet; not Accounts Receivable, Accounts Payable, Undeposited Funds or an inventory account.',
  ),
  bankName: zLenient(z.string().max(255)).describe('Required. Name of the bank or card issuer, such as "First National" (at most 255 characters).'),
  accountNumber: zLenient(z.string().max(100).nullable()).describe(
    'The full account number at the bank (at most 100 characters); leave out for none. A masked number such as "••••6789" cannot be saved.',
  ),
});

/** POST /api/demo-feed — load made-up sample lines into the feed of a bank account, for trying the bank feed. */
export const loadDemoFeedSchema = z.object({
  bankAccountId: z
    .string({ invalid_type_error: 'must be the id of a bank account' })
    .min(1)
    .describe(
      'Id of the linked bank account (GET /api/bank-accounts lists them) whose feed gets the sample lines. They are made up, and they land in the real feed of that account.',
    ),
});
