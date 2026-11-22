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
  'estimate',
  'sales_order',
  'vendor_credit',
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

const MODE_WORDS =
  'automatic enters the transaction on its own when due; remind puts it on the Reminders list for a person to enter; never enters it only when someone chooses Enter Now';

export const createRecurringTemplateSchema = z.object({
  name: z
    .string({ required_error: 'name is required' })
    .trim()
    .min(1, 'name is required')
    .max(255)
    .describe('Name of the memorized transaction, such as "Monthly rent".'),
  docType: recurringDocTypeSchema.describe('Kind of transaction it enters, such as invoice, bill, check or journal_entry.'),
  frequency: recurringFrequencySchema.describe('How often it is entered, such as monthly or quarterly; never for only when someone chooses Enter Now.'),
  /** Defaults to "now" in the route when omitted. */
  nextRunDate: zDate.optional().describe('Date of the next scheduled entry, YYYY-MM-DD; leave out for today.'),
  /** JSON payload matching the create-input of the docType — validated by the service. */
  template: z
    .record(z.unknown(), { required_error: 'template payload is required' })
    .describe('The transaction to memorize: the same body that creates a transaction of docType (such as the invoices.create body); each entry is dated on its scheduled date.'),
  /** Legacy: default true (auto-post on schedule); false = remind-only. `mode` wins. */
  autoEnter: z.boolean().optional().describe('Older form of mode: true is automatic, false is remind. Not used when mode is given.'),
  mode: recurringModeSchema.optional().describe(`${MODE_WORDS}. Leave out for automatic (or what autoEnter says).`),
  groupName: zGroup.optional().describe('Memorized transaction group it belongs to, so a whole group can be entered at once; leave out for none.'),
  remaining: zRemaining.optional().describe('How many more times it is entered, 0 to 9999 (it is made inactive at 0); leave out or null for no limit.'),
  daysInAdvance: zDaysInAdvance.optional().describe('Days before the scheduled date it is entered or reminded, 0 to 365; leave out for 0.'),
});
export type CreateRecurringTemplateBody = z.infer<typeof createRecurringTemplateSchema>;

export const updateRecurringTemplateSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(255).optional().describe('New name of the memorized transaction; leave out to keep the name.'),
  frequency: recurringFrequencySchema.optional().describe('How often it is entered, such as monthly; leave out to keep it.'),
  nextRunDate: zDate.nullable().optional().describe('Date of the next scheduled entry, YYYY-MM-DD; leave out to keep it, or send null for no next date.'),
  mode: recurringModeSchema.optional().describe(`${MODE_WORDS}. Leave out to keep it.`),
  groupName: zGroup.optional().describe('Memorized transaction group it belongs to; leave out to keep it, or send null to take it out of its group.'),
  remaining: zRemaining.optional().describe('How many more times it is entered, 0 to 9999; leave out to keep it, or send null for no limit.'),
  daysInAdvance: zDaysInAdvance.optional().describe('Days before the scheduled date it is entered or reminded, 0 to 365; leave out to keep it.'),
  isActive: z.boolean().optional().describe('False makes it inactive; true makes it active again. Leave out to keep it.'),
  template: z
    .record(z.unknown())
    .optional()
    .describe('The memorized transaction, replacing the saved one: the same body that creates a transaction of its kind; leave out to keep it.'),
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
