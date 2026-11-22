/**
 * Zod schemas for /api/payroll-items — mirrors CreatePayrollItemInput /
 * UpdatePayrollItemInput (lib/services/payrollItems.ts).
 */
import { z } from 'zod';
import { zDecimal, zUuid } from './helpers';

export const payrollItemKindSchema = z.enum([
  'earning',
  'tax',
  'deduction',
  'employer_contribution',
  'garnishment',
]);

export const payrollCalcBasisSchema = z.enum(['fixed', 'percent']);

/** The tax tracking types, in words (lib/services/payrollTaxTracking.ts). */
const TAX_TRACKING_WORDS =
  'QB tax tracking type, which decides the W-2 box and 941 line: for a tax, federal_withholding, social_security, medicare, ' +
  'state_withholding, sdi or local_tax; for an employer contribution, employer_social_security, employer_medicare, futa, sui, ' +
  'workers_comp, employer_health, employer_hsa, employer_retirement or other; for a deduction, none, 401k, 403b, 457b, ' +
  'simple_ira, roth_401k, roth_403b, roth_457b, section125, hsa or dependent_care. It must fit the kind';

export const createPayrollItemSchema = z.object({
  name: z
    .string({ required_error: 'name is required' })
    .min(1, 'name is required')
    .describe('Name of the payroll item, such as "Salary" or "401(k) employee"; unique in the company.'),
  kind: payrollItemKindSchema.describe('earning, tax (withheld from the check), deduction, employer_contribution or garnishment.'),
  pretax: z
    .boolean()
    .optional()
    .describe('Deductions only: true when it comes out before tax; leave out to work it out from taxTracking (or the name).'),
  /** QB tax tracking type (lib/services/payrollTaxTracking.ts); checked against the kind by the service. */
  taxTracking: z
    .string()
    .max(40)
    .nullish()
    .describe(`${TAX_TRACKING_WORDS}. Leave out to work it out from the name; a tax item must end up with one.`),
  expenseAccountId: zUuid
    .nullish()
    .describe('Id of the expense account (chart of accounts) the item posts to; needed for an earning and an employer contribution.'),
  liabilityAccountId: zUuid
    .nullish()
    .describe('Id of the liability account (chart of accounts) the item is owed in until paid; needed for a tax, deduction, garnishment and employer contribution.'),
  calcBasis: payrollCalcBasisSchema
    .nullish()
    .describe('How defaultRate is read: fixed (an amount) or percent (a percentage, such as "6.2" for 6.2%); leave out for none.'),
  defaultRate: zDecimal
    .nullish()
    .describe('Amount or percentage that pay runs fill in, as decimal text such as "50.00" or "6"; leave out for none.'),
});
export type CreatePayrollItemBody = z.infer<typeof createPayrollItemSchema>;

export const updatePayrollItemSchema = z.object({
  name: z.string().min(1, 'name is required').optional().describe('New name of the payroll item; leave out to keep the name.'),
  pretax: z
    .boolean()
    .optional()
    .describe('Deductions only: true when it comes out before tax; leave out to keep it.'),
  /** QB tax tracking type (lib/services/payrollTaxTracking.ts); checked against the kind by the service. */
  taxTracking: z
    .string()
    .max(40)
    .nullish()
    .describe(`${TAX_TRACKING_WORDS} the item already has. Leave out to keep it.`),
  expenseAccountId: zUuid
    .nullish()
    .describe('Id of the expense account (chart of accounts) the item posts to; leave out to keep it. Null clears it where the kind does not need one.'),
  liabilityAccountId: zUuid
    .nullish()
    .describe('Id of the liability account (chart of accounts) the item is owed in; leave out to keep it. Null clears it where the kind does not need one.'),
  calcBasis: payrollCalcBasisSchema
    .nullish()
    .describe('How defaultRate is read: fixed (an amount) or percent (a percentage, such as "6.2" for 6.2%); leave out to keep it, or send null to clear it.'),
  defaultRate: zDecimal
    .nullish()
    .describe('Amount or percentage that pay runs fill in, as decimal text; leave out to keep it, or send null to clear it.'),
  isActive: z
    .boolean()
    .optional()
    .describe('False makes the item inactive; true makes it active again. Leave out to keep it.'),
});
export type UpdatePayrollItemBody = z.infer<typeof updatePayrollItemSchema>;
