/**
 * Zod schemas for /api/payroll and /api/payroll/pay-runs — mirror
 * RunPaycheckInput / EarningLineInput / PaycheckLineInput / CreatePayRunInput
 * (lib/services/payroll.ts).
 *
 * IMPORTANT: `taxes` / `employerTaxes` must keep the absent-vs-[] distinction —
 * an OMITTED array triggers auto-withholding in the service, an explicit []
 * means "no taxes". Both schemas therefore use plain `.optional()`.
 */
import { z } from 'zod';
import { zDate, zDecimal, zMoney, zUuid } from './helpers';

export const paycheckLineSchema = z.object({
  kind: z
    .enum(['earning', 'tax', 'deduction', 'employer_contribution'])
    .describe('What the line is: an earning, a tax withheld, a deduction, or an employer contribution.'),
  name: z.string().min(1, 'line name is required').describe('Name printed on the pay stub, such as "401(k)" or "Federal Withholding".'),
  amount: zMoney.describe('Amount of the line as decimal text, such as "125.00".'),
  payrollItemId: zUuid
    .nullish()
    .describe('Id of the payroll item (payroll item list) behind the line; it picks the accounts and whether a deduction is pre-tax.'),
  /** Tax tracking type (lib/services/payrollTaxTracking.ts); normally taken from the payroll item. */
  taxTracking: z
    .string()
    .max(40)
    .nullish()
    .describe('Tax tracking type of a tax line, normally taken from its payroll item; needed on a tax line without one.'),
});

/**
 * Override one CALCULATED tax by its payroll item (never by a typed name). The item's tax
 * tracking type picks the computed line it replaces; 0 removes that tax from the check.
 */
export const taxOverrideSchema = z.object({
  payrollItemId: zUuid.describe('Id of the tax payroll item (payroll item list) whose worked-out amount is replaced.'),
  amount: zMoney.describe('Tax amount to use instead, as decimal text such as "42.00"; "0" removes that tax from the check.'),
});

export const earningLineSchema = z.object({
  kind: z.enum(['regular', 'overtime', 'bonus', 'commission']).describe('Kind of pay on this line.'),
  hours: zDecimal.nullish().describe('Hours paid as decimal text such as "40"; used with rate when amount is left out.'),
  rate: zDecimal.nullish().describe('Pay per hour as decimal text such as "25.00"; used with hours when amount is left out.'),
  amount: zMoney.nullish().describe('Pay on this line as decimal text such as "1000.00"; leave out to work it out as hours times rate.'),
  payrollItemId: zUuid.nullish().describe('Id of the earning payroll item (payroll item list) whose expense account the wages post to.'),
});

export const runPaycheckSchema = z.object({
  employeeId: zUuid.describe('Id of the employee paid (employee list).'),
  payDate: zDate.describe('Date of the paycheck, YYYY-MM-DD.'),
  periodStart: zDate.nullish().describe('First day of the pay period, YYYY-MM-DD.'),
  periodEnd: zDate.nullish().describe('Last day of the pay period, YYYY-MM-DD.'),
  /** Ignored when `earnings` has lines; required by the service otherwise. */
  grossPay: zMoney
    .optional()
    .describe('Gross pay as one amount, as decimal text such as "2000.00"; required unless earnings has lines, and ignored when it does.'),
  earnings: z
    .array(earningLineSchema)
    .optional()
    .describe('Itemized earnings (regular, overtime, bonus, commission); gross pay is their total.'),
  taxes: z
    .array(paycheckLineSchema)
    .optional()
    .describe('Employee taxes withheld; leave out to have the app work them out, or send [] for no taxes.'),
  employerTaxes: z
    .array(paycheckLineSchema)
    .optional()
    .describe('Employer payroll taxes; leave out to have the app work them out, or send [] for none.'),
  deductions: z.array(paycheckLineSchema).optional().describe('Deductions from pay, such as 401(k) or health insurance.'),
  taxOverrides: z
    .array(taxOverrideSchema)
    .optional()
    .describe('Replacements for single worked-out taxes; only used when taxes and employerTaxes are left out.'),
  filingStatus: z
    .enum(['single', 'married', 'head_of_household'])
    .optional()
    .describe("Filing status for the worked-out withholding; leave out for the employee's W-4 status."),
  periodsPerYear: z
    .number()
    .int()
    .positive('periodsPerYear must be a positive integer')
    .optional()
    // resolvePeriodsPerYear (lib/services/payroll.ts): the value sent, else the check's stored
    // frequency on an edit, else the company pay period. 26 is only the biweekly preference.
    .describe(
      "Pay periods per year used to work out withholding, such as 52 weekly, 26 every two weeks, 24 twice a month or 12 monthly; leave out for the company's pay period (Preferences > Payroll & Employees), or on an edit for the frequency the check already has.",
    ),
});
export type RunPaycheckBody = z.infer<typeof runPaycheckSchema>;

export const payRunEmployeeSchema = z.object({
  employeeId: zUuid.describe('Id of the employee paid in this run (employee list).'),
  hours: zDecimal.nullish().describe('Hours paid for an hourly employee, as decimal text such as "80"; ignored when amount is given.'),
  amount: zMoney
    .nullish()
    .describe('Gross pay for this check as decimal text such as "2000.00", replacing hours times rate or the salary; required for commission employees.'),
  deductions: z.array(paycheckLineSchema).optional().describe('Deductions from this check, such as 401(k) or health insurance.'),
  timeEntryIds: z
    .array(zUuid)
    .optional()
    .describe('Ids of time entries paid by this check; for an hourly employee their hours are the hours paid.'),
});

export const createPayRunSchema = z.object({
  payDate: zDate.describe('Date of the paychecks, YYYY-MM-DD.'),
  periodStart: zDate.nullish().describe('First day of the pay period, YYYY-MM-DD.'),
  periodEnd: zDate.nullish().describe('Last day of the pay period, YYYY-MM-DD.'),
  memo: z.string().nullish().describe('Note saved with the pay run.'),
  periodsPerYear: z
    .number()
    .int()
    .positive('periodsPerYear must be a positive integer')
    .optional()
    .describe(
      "Pay periods per year used for salaries and withholding, such as 52 weekly, 26 every two weeks, 24 twice a month or 12 monthly; leave out for the company's pay period (Preferences > Payroll & Employees).",
    ),
  employees: z
    .array(payRunEmployeeSchema, {
      required_error: 'employees must be a non-empty array',
      invalid_type_error: 'employees must be a non-empty array',
    })
    .min(1, 'employees must be a non-empty array')
    .describe('One entry per employee paid in this run; at least one.'),
});
export type CreatePayRunBody = z.infer<typeof createPayRunSchema>;

/** PATCH /api/payroll/[id] — edit a paycheck (same fields as a new check, minus employee). */
export const editPaycheckSchema = runPaycheckSchema.omit({ employeeId: true });
export type EditPaycheckBody = z.infer<typeof editPaycheckSchema>;

const adjustmentLineSchema = z.object({
  kind: z
    .enum(['earning', 'tax', 'deduction', 'employer_contribution'])
    .describe('What the line is: an earning, a tax, a deduction, or an employer contribution.'),
  name: z.string().min(1, 'line name is required').max(255).describe('Name of the line, such as "Federal Withholding".'),
  amount: zMoney.describe('Amount of the line as decimal text, such as "125.00".'),
  payrollItemId: zUuid.nullish().describe('Id of the payroll item (payroll item list) behind the line.'),
});

/** POST /api/payroll/adjustments — YTD setup amounts or a liability adjustment. */
export const createAdjustmentSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ytd').describe('ytd records year-to-date payroll amounts paid before the company started using the app.'),
    employeeId: zUuid.describe('Id of the employee the amounts belong to (employee list).'),
    date: zDate.describe('Date of the amounts, YYYY-MM-DD.'),
    periodStart: zDate.nullish().describe('First day of the period the amounts cover, YYYY-MM-DD.'),
    periodEnd: zDate.nullish().describe('Last day of the period the amounts cover, YYYY-MM-DD.'),
    memo: z.string().max(500).nullish().describe('Note saved with the adjustment (at most 500 characters).'),
    lines: z.array(adjustmentLineSchema).min(1, 'enter at least one amount').describe('The amounts; at least one line.'),
    affectsAccounts: z.boolean().optional().describe('True also posts the amounts to the accounts; leave out to record them for payroll totals only.'),
    bankAccountId: zUuid.nullish().describe('Id of the bank account (chart of accounts) the net pay came from, when the amounts post to the accounts.'),
  }),
  z.object({
    type: z.literal('liability').describe('liability corrects a payroll tax or deduction amount the company owes.'),
    employeeId: zUuid.describe('Id of the employee the correction is for (employee list).'),
    date: zDate.describe('Date of the correction, YYYY-MM-DD.'),
    memo: z.string().max(500).nullish().describe('Note saved with the adjustment (at most 500 characters).'),
    lines: z
      .array(
        adjustmentLineSchema.extend({
          kind: z
            .enum(['tax', 'deduction', 'employer_contribution'])
            .describe('What the line corrects: a tax, a deduction, or an employer contribution.'),
        }),
      )
      .min(1, 'enter at least one adjustment line')
      .describe('The corrections, each a signed amount (positive raises what is owed, negative lowers it); at least one line.'),
    affectsAccounts: z.boolean().optional().describe('True also posts the correction to the accounts; leave out to change payroll totals only.'),
    offsetAccountId: zUuid
      .nullish()
      .describe('Id of the expense account (chart of accounts) that takes the other side when the correction posts; leave out for Payroll Tax Expense.'),
  }),
]);
export type CreateAdjustmentBody = z.infer<typeof createAdjustmentSchema>;

// A plain decimal ("0.034", 0.034): text such as "abc" or "NaN" used to reach the service, where it
// answered HTTP 500 or was stored as a NaN rate (review round 5).
const zRate = z.union([z.literal(''), zDecimal]).nullish();

/** POST /api/payroll/state-settings — create or replace SUI/SDI settings for a state + year. */
export const stateTaxSettingSchema = z.object({
  state: z.string().regex(/^[A-Za-z]{2}$/, 'state must be a two-letter code').describe('Two-letter state code, such as "CA".'),
  year: z.number().int().min(2000).max(2100).describe('Calendar year the settings apply to, such as 2026.'),
  suiRate: zRate.describe('State unemployment rate as a decimal fraction, such as "0.034" for 3.4%; blank clears it.'),
  suiWageBase: zRate.describe('Wages per employee per year that state unemployment tax applies to, as decimal text such as "7000"; blank clears it.'),
  sdiRate: zRate.describe('State disability rate as a decimal fraction, such as "0.011" for 1.1%; blank clears it.'),
  sdiWageBase: zRate.describe('Wages per employee per year that state disability tax applies to, as decimal text; blank clears it.'),
  accountNumber: z.string().max(50).nullish().describe("The company's state unemployment account number (at most 50 characters)."),
});

export const workersCompCodeSchema = z.object({
  code: z.string().min(1, 'class code is required').max(20).describe("Workers' compensation class code, such as \"8810\" (at most 20 characters)."),
  description: z.string().max(255).nullish().describe('What work the class code covers.'),
  ratePer100: zDecimal.describe('Premium rate per $100 of wages, as decimal text such as "0.45".'),
  isActive: z.boolean().optional().describe('False makes the class code inactive; true makes it active again.'),
});
export const updateWorkersCompCodeSchema = workersCompCodeSchema.partial();
