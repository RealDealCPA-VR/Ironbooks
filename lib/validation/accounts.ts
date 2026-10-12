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
    code: z.string().trim().min(1, 'code is required'),
    name: z.string().trim().min(1, 'name is required'),
    /** Base class. Optional when qbType is given. */
    type: zBaseType.optional(),
    /** QuickBooks account type, e.g. "bank", "other_current_asset" (lib/accountTypes.ts). */
    qbType: z.string().trim().max(40).nullish(),
    /** Blank is allowed — the service maps it to a sensible per-type default. */
    subtype: z.string().default(''),
    parentId: zUuid.nullish(),
    openingBalance: zMoney.nullish(),
    openingBalanceDate: zDate.optional(),
    description: z.string().nullish(),
    taxLine: z.string().trim().max(40).nullish(),
  })
  .refine((v) => Boolean(v.type || v.qbType), {
    message: 'Pick an account type.',
    path: ['qbType'],
  });
export type CreateAccountBody = z.infer<typeof createAccountSchema>;

export const updateAccountSchema = z.object({
  name: z.string().trim().min(1, 'name cannot be empty').optional(),
  subtype: z.string().optional(),
  qbType: z.string().trim().max(40).optional(),
  parentId: zUuid.nullable().optional(),
  description: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
  taxLine: z.string().trim().max(40).nullable().optional(),
});
export type UpdateAccountBody = z.infer<typeof updateAccountSchema>;

export const incomeTaxFormSchema = z.object({
  form: z.enum(['1120', '1120S', '1065', 'SCHC']).nullable(),
});
