/**
 * Zod schema for POST /api/registers/[accountId] — a transaction typed into a register.
 * Mirrors RegisterEntryInput (lib/services/registerEntry.ts).
 */
import { z } from 'zod';
import { zDate, zMoneyPositive, zUuid } from './helpers';

export const registerEntrySchema = z.object({
  date: zDate.describe('Transaction date, YYYY-MM-DD.'),
  number: z
    .string()
    .max(40)
    .nullish()
    .describe('Number column: a check number (blank uses the next one), card reference or entry number; deposits and transfers take none.'),
  payee: z
    .string()
    .max(255)
    .nullish()
    .describe('Payee or description; on checks and card entries a vendor or Other Name with exactly this name is linked.'),
  name: z
    .object({
      type: z
        .enum(['customer', 'vendor', 'employee', 'other'])
        .describe('Which list the name is from (other means the Other Names list).'),
      id: zUuid.describe('Id of the customer, vendor, employee or Other Names entry.'),
    })
    .nullish()
    .describe('The payee picked from a name list; it wins over matching the payee text.'),
  otherAccountId: zUuid.describe("Id of the account on the other side of the entry (chart of accounts), the register's Account column."),
  memo: z.string().max(1000).nullish().describe('Note saved with the transaction (at most 1000 characters).'),
  side: z
    .enum(['increase', 'decrease'])
    .describe("Whether the amount raises or lowers this register account's balance, as the two amount columns do."),
  amount: zMoneyPositive.describe('Amount as decimal text above zero, such as "125.00".'),
  /** The user confirmed a check number that is already used on this bank account. */
  allowDuplicateNumber: z
    .boolean()
    .optional()
    .describe('Send true only after the app warned that this check number is already used on the account, to keep it.'),
});
export type RegisterEntryBody = z.infer<typeof registerEntrySchema>;
