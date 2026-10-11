/**
 * Zod schemas for /api/recurring (Memorized Transaction List) — mirrors CreateTemplateInput /
 * UpdateTemplateInput (lib/services/recurring.ts) and the /run trigger body.
 */
import { z } from 'zod';
import { zDate, zUuid } from './helpers';

export const recurringDocTypeSchema = z.enum([
  'invoice',
  'bill',
  'journal_entry',
  'expense',
  'check',
  'sales_receipt',
  'credit_memo',
  'deposit',
  'transfer',
  'purchase_order',
]);
export const recurringFrequencySchema = z.enum([
  'never',
  'daily',
  'weekly',
  'biweekly',
  'every_four_weeks',
  'semimonthly',
  'monthly',
  'bimonthly',
  'quarterly',
  'semiannually',
  'yearly',
]);
export const recurringModeSchema = z.enum(['automatic', 'remind', 'never']);

const zRemaining = z.number().int().min(0).max(9999).nullable();
const zDaysInAdvance = z.number().int().min(0).max(365);
const zGroup = z.string().trim().max(100).nullable();

export const createRecurringTemplateSchema = z.object({
  name: z.string({ required_error: 'name is required' }).trim().min(1, 'name is required').max(255),
  docType: recurringDocTypeSchema,
  frequency: recurringFrequencySchema,
  /** Defaults to "now" in the route when omitted. */
  nextRunDate: zDate.optional(),
  /** JSON payload matching the create-input of the docType — validated by the service. */
  template: z.record(z.unknown(), { required_error: 'template payload is required' }),
  /** Legacy: default true (auto-post on schedule); false = remind-only. `mode` wins. */
  autoEnter: z.boolean().optional(),
  mode: recurringModeSchema.optional(),
  groupName: zGroup.optional(),
  remaining: zRemaining.optional(),
  daysInAdvance: zDaysInAdvance.optional(),
});
export type CreateRecurringTemplateBody = z.infer<typeof createRecurringTemplateSchema>;

export const updateRecurringTemplateSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(255).optional(),
  frequency: recurringFrequencySchema.optional(),
  nextRunDate: zDate.nullable().optional(),
  mode: recurringModeSchema.optional(),
  groupName: zGroup.optional(),
  remaining: zRemaining.optional(),
  daysInAdvance: zDaysInAdvance.optional(),
  isActive: z.boolean().optional(),
  template: z.record(z.unknown()).optional(),
});
export type UpdateRecurringTemplateBody = z.infer<typeof updateRecurringTemplateSchema>;

/**
 * POST /api/recurring/run — { id, date? } enters one template now, { group } enters a memorized
 * group now, { asOf? } runs everything due.
 */
export const runRecurringSchema = z.object({
  id: zUuid.nullish(),
  date: zDate.nullish(),
  group: z.string().trim().min(1).max(100).nullish(),
  asOf: zDate.nullish(),
});
export type RunRecurringBody = z.infer<typeof runRecurringSchema>;
