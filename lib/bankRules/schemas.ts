/**
 * Request-body schemas for the bank rules API (team bankrules). Values are validated again in
 * the services (lib/services/bankRules.ts) — these only reject malformed shapes early.
 *
 * The .describe() texts are what agents read (describe_operation, plan §6.3). ruleUpdateSchema is
 * ruleBodySchema with every field optional, so each text says what leaving the field out does on
 * a new rule and on an edit (updateBankRule keeps the saved value for a field left out).
 */
import { z } from 'zod';
import { RULE_DIRECTIONS, RULE_FIELDS, RULE_MODES, RULE_OPERATORS } from './core';

const uuid = z.string().uuid();
const optUuid = z
  .union([uuid, z.literal(''), z.null()])
  .optional()
  .transform((v) => v || null);
const optText = z.string().max(255).nullable().optional();
const amount = z
  .union([z.string().max(20), z.number(), z.null()])
  .optional()
  .transform((v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim()));

export const splitSchema = z.object({
  accountId: uuid.describe('Id of the account (chart of accounts) that gets this share.'),
  classId: optUuid.describe("Id of a class (class list) for this share; leave out to use the line's or the rule's class."),
  percent: z
    .union([z.string().max(12), z.number()])
    .transform((v) => String(v).trim())
    .describe('Share of the amount as a percentage, such as "60" or "33.33"; the shares add up to 100.'),
});

export const ruleBodySchema = z.object({
  name: z.string().max(255).describe('Name of the rule, such as "Fuel - Shell" (at most 255 characters); on an edit, leave out to keep it.'),
  matchField: z
    .enum(RULE_FIELDS as unknown as [string, ...string[]])
    .optional()
    .describe(
      'Which part of the bank line the rule looks at: description (the default on a new rule), payee, any (description or payee) or amount; on an edit, leave out to keep it.',
    ),
  matchOperator: z
    .enum(RULE_OPERATORS as unknown as [string, ...string[]])
    .optional()
    .describe(
      'How matchValue is compared: contains (the default on a new rule), starts_with, equals, or pattern (* stands for any text, ? for one character); on an edit, leave out to keep it.',
    ),
  matchValue: optText.describe(
    'Text the bank line must match (at most 255 characters); leave out for no text condition, but a rule needs at least one condition. On an edit, leave out to keep it.',
  ),
  bankAccountId: optUuid.describe(
    'Id of the bank or card account (bank account list) the rule is for; leave out or null for every account. On an edit, leave out to keep it, or send null for every account.',
  ),
  direction: z
    .enum(RULE_DIRECTIONS as unknown as [string, ...string[]])
    .optional()
    .describe('any (the default on a new rule), in (money in only) or out (money out only); on an edit, leave out to keep it.'),
  amountMin: amount.describe(
    'Smallest amount a matching line may have, as decimal text such as "10.00"; leave out for no minimum. On an edit, leave out to keep it, or send null to clear it.',
  ),
  amountMax: amount.describe(
    'Largest amount a matching line may have, as decimal text such as "500.00"; leave out for no maximum. On an edit, leave out to keep it, or send null to clear it.',
  ),
  setAccountId: optUuid.describe(
    'Id of the account (chart of accounts) matching lines go to; needed unless splits are given. On an edit, leave out to keep it.',
  ),
  setClassId: optUuid.describe(
    'Id of a class (class list) for the lines the rule fills in; leave out for none. On an edit, leave out to keep it, or send null to clear it.',
  ),
  setPayee: optText.describe(
    "Payee the rule puts on matching lines (at most 255 characters); leave out to keep each line's own payee. On an edit, leave out to keep it.",
  ),
  setMemo: optText.describe('Memo the rule puts on matching lines (at most 255 characters); leave out for none. On an edit, leave out to keep it.'),
  splits: z
    .array(splitSchema)
    .max(20)
    .nullable()
    .optional()
    .describe(
      'Split matching lines across accounts by percentage (at most 20 shares adding up to 100); when given, setAccountId is not used. On an edit, leave out to keep them, or send null to remove them.',
    ),
  mode: z
    .enum(RULE_MODES as unknown as [string, ...string[]])
    .optional()
    .describe(
      'suggest (the default on a new rule) only fills in matching lines for a person to review; auto adds them to the register on their own. On an edit, leave out to keep it.',
    ),
  enabled: z.boolean().optional().describe('False turns the rule off; on a new rule leave out for on, and on an edit leave out to keep it.'),
  priority: z
    .number()
    .int()
    .min(-1_000_000, 'Priority is too small.')
    .max(1_000_000, 'Priority is too large.')
    .optional()
    .describe('Whole number: rules with a higher priority are checked first. On a new rule leave out to check it first; on an edit, leave out to keep its place.'),
});

export const ruleUpdateSchema = ruleBodySchema.partial().extend({
  expectedUpdatedAt: z
    .string()
    .max(40)
    .nullable()
    .optional()
    .describe(
      "The rule's updatedAt as you last read it: when someone saved the rule since, the save is refused so you can read it again. Leave out to save without that check.",
    ),
});

export const ruleTestSchema = ruleBodySchema.extend({
  id: uuid.nullable().optional().describe('Id of the saved rule this draft edits, so the test does not count that rule as another rule; leave out for a new rule.'),
  name: z.string().max(255).optional().default('').describe('Name of the draft rule; leave out for none.'),
  days: z.number().int().min(1).max(3650).optional().describe('How many days of recent bank lines to check, 1 to 3650; leave out for 365.'),
});

export const reorderSchema = z.object({
  orderedIds: z.array(uuid).max(5000).describe('Ids of the rules in the order they are checked, first to last.'),
});

const offerFields = {
  pattern: z
    .string()
    .min(1)
    .max(255)
    .describe('The text the offer is about, as the offer gave it (ruleOffer.pattern in the categorize answer, or GET /api/bank-rules/offers).'),
  accountId: uuid.describe('Id of the account the offer would categorize to, as the offer gave it.'),
  direction: z.enum(['in', 'out']).describe('in for money in, out for money out, as the offer gave it.'),
};

export const offerActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('accept').describe('accept: save the offer as a rule.'),
    ...offerFields,
    mode: z
      .enum(['suggest', 'auto'])
      .optional()
      .describe('suggest (the default) only fills in matching lines for review; auto adds them to the register on their own.'),
  }),
  z.object({
    action: z.literal('dismiss').describe('dismiss: never offer this rule again.'),
    ...offerFields,
  }),
]);

const bulkItemSchema = z.object({
  bankTransactionId: uuid.describe('Id of the bank feed line to add.'),
  accountId: optUuid.describe('Id of the account (chart of accounts) the line goes to; needed unless splits are given.'),
  classId: optUuid.describe('Id of a class (class list) for the line; leave out for none.'),
  payee: optText.describe("Payee for the line; leave out to keep the line's own."),
  memo: optText.describe('Memo for the line; leave out for none.'),
  splits: z.array(splitSchema).max(20).nullable().optional().describe('Split the line across accounts by percentage (shares adding up to 100).'),
  exchangeRate: z
    .string()
    .max(30)
    .nullable()
    .optional()
    .describe("Foreign-currency accounts only: home-currency units per 1 unit, as decimal text; leave out for the currency list's rate."),
});

const bulkExchangeRate = z
  .string()
  .max(30)
  .nullable()
  .optional()
  .describe("Foreign-currency accounts only: home-currency units per 1 unit for every line, as decimal text; leave out for the currency list's rate.");

export const bulkAcceptSchema = z.union([
  z.object({
    bankAccountId: uuid.describe('Id of the bank or card account (bank account list) whose suggestions are accepted.'),
    allHighConfidence: z.literal(true).describe('true: add every line whose suggestion is at least minConfidence sure.'),
    minConfidence: z
      .number()
      .min(50)
      .max(100)
      .optional()
      .describe('Lowest confidence accepted, 50 to 100 percent; leave out for 90.'),
    exchangeRate: bulkExchangeRate,
  }),
  z.object({
    items: z.array(bulkItemSchema).min(1).max(1000).describe('The lines to add and where each goes, 1 to 1000.'),
    exchangeRate: bulkExchangeRate,
  }),
]);

/** POST /api/bank-rules/run — post every waiting line whose first matching rule adds it automatically. */
export const runRulesSchema = z.object({
  bankAccountId: z.string().uuid().describe('Id of the bank or card account (bank account list) whose waiting lines the auto rules post.'),
});
