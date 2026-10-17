/**
 * Zod schema for POST /api/registers/[accountId] — a transaction typed into a register.
 * Mirrors RegisterEntryInput (lib/services/registerEntry.ts).
 */
import { z } from 'zod';
import { zDate, zMoneyPositive, zUuid } from './helpers';

export const registerEntrySchema = z.object({
  date: zDate,
  number: z.string().max(40).nullish(),
  payee: z.string().max(255).nullish(),
  name: z.object({ type: z.enum(['customer', 'vendor', 'employee', 'other']), id: zUuid }).nullish(),
  otherAccountId: zUuid,
  memo: z.string().max(1000).nullish(),
  side: z.enum(['increase', 'decrease']),
  amount: zMoneyPositive,
  /** The user confirmed a check number that is already used on this bank account. */
  allowDuplicateNumber: z.boolean().optional(),
});
export type RegisterEntryBody = z.infer<typeof registerEntrySchema>;
