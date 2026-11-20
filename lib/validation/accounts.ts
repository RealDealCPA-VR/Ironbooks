/**
 * Zod schemas for /api/accounts — mirrors lib/services/accounts.ts inputs.
 * Subtype / QB account-type normalization (blank -> per-type default, enum check,
 * type <-> subtype consistency) stays in the service.
 */
import { z } from 'zod';
import { zDate, zMoney, zUuid } from './helpers';

const zBaseType = z.enum(['asset', 'liability', 'equity', 'revenue', 'expense'], {
  errorMap: () => ({ message: 'type must be asset, liability, equity, revenue, or expense' }),
});

export const createAccountSchema = z
  .object({
    /** Blank = assign the next free number (unless Preferences require account numbers). */
    code: z
      .string()
      .trim()
      .max(50)
      .default('')
      .describe('Account number such as "6100"; blank gives the next free number unless the company requires numbers.'),
    name: z.string().trim().min(1, 'name is required').describe('Account name, such as "Office Supplies".'),
    /** Base class. Optional when qbType is given. */
    type: zBaseType.optional().describe('Base class of the account; may be left out when qbType is given.'),
    /** QuickBooks account type, e.g. "bank", "other_current_asset" (lib/accountTypes.ts). */
    qbType: z
      .string()
      .trim()
      .max(40)
      .nullish()
      .describe('Detailed account type such as bank, other_current_asset, fixed_asset, credit_card, income or expense; it wins over type.'),
    /** Blank is allowed — the service maps it to a sensible per-type default. */
    subtype: z.string().default('').describe('Detail subtype such as "checking"; blank uses the default for the type.'),
    parentId: zUuid.nullish().describe('Id of the parent account (chart of accounts), making this a subaccount.'),
    openingBalance: zMoney
      .nullish()
      .describe('Balance the account already had, as decimal text such as "2500.00"; posted against Opening Balance Equity.'),
    openingBalanceDate: zDate.optional().describe('Date of the opening balance, YYYY-MM-DD; leave out for today.'),
    description: z.string().nullish().describe('Free description of the account.'),
    taxLine: z.string().trim().max(40).nullish().describe('Key of the income tax form line this account maps to.'),
  })
  .refine((v) => Boolean(v.type || v.qbType), {
    message: 'Pick an account type.',
    path: ['qbType'],
  });
export type CreateAccountBody = z.infer<typeof createAccountSchema>;

export const updateAccountSchema = z.object({
  name: z.string().trim().min(1, 'name cannot be empty').optional().describe('New account name.'),
  subtype: z.string().optional().describe('Detail subtype such as "checking".'),
  qbType: z.string().trim().max(40).optional().describe('Detailed account type such as bank, other_current_asset or expense.'),
  parentId: zUuid
    .nullable()
    .optional()
    .describe('Id of the parent account (chart of accounts); null makes it a top-level account.'),
  description: z.string().nullable().optional().describe('Free description of the account; null clears it.'),
  isActive: z.boolean().optional().describe('False makes the account inactive; true makes it active again.'),
  taxLine: z
    .string()
    .trim()
    .max(40)
    .nullable()
    .optional()
    .describe('Key of the income tax form line this account maps to; null clears it.'),
});
export type UpdateAccountBody = z.infer<typeof updateAccountSchema>;

export const incomeTaxFormSchema = z.object({
  form: z
    .enum(['1120', '1120S', '1065', 'SCHC'])
    .nullable()
    .describe('Income tax form the company files (SCHC is Schedule C); null clears it.'),
});
