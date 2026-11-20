/**
 * Zod schemas for /api/budgets — mirror the inline input types of
 * createBudget / setBudgetLine (lib/services/budgets.ts).
 */
import { z } from 'zod';
import { zDecimal, zUuid } from './helpers';

export const createBudgetSchema = z.object({
  name: z
    .string({ required_error: 'name is required' })
    .trim()
    .min(1, 'Budget name is required')
    .describe('Name of the budget, such as "2026 Operating Budget".'),
  /** The route historically coerced (Number(body.fiscalYear)); keep that. */
  fiscalYear: z.coerce
    .number({ invalid_type_error: 'fiscalYear must be a number' })
    .int('fiscalYear must be an integer')
    .describe('Fiscal year the budget covers, named by the calendar year it ends in, such as 2026.'),
  /** 'profit_loss' (default) or 'balance_sheet'. */
  kind: z
    .enum(['profit_loss', 'balance_sheet'])
    .optional()
    .describe('profit_loss (the default) budgets income and expense accounts; balance_sheet budgets balance sheet accounts.'),
  /** Create a Forecast instead of a budget. */
  isForecast: z.boolean().optional().describe('True creates a forecast instead of a budget.'),
});
export type CreateBudgetBody = z.infer<typeof createBudgetSchema>;

/** PATCH /api/budgets/:id — upsert one budget line (budgetId comes from the URL). */
export const setBudgetLineSchema = z.object({
  accountId: zUuid.describe('Id of the account budgeted (chart of accounts); it must suit the budget kind.'),
  month: z.coerce
    .number({ invalid_type_error: 'month must be a number' })
    .int('month must be an integer')
    .describe('Calendar month of the amount, 1 for January to 12 for December.'),
  /** Service wants a decimal string. */
  amount: zDecimal
    .transform((v) => String(v))
    .describe('Budgeted amount for that month as decimal text, such as "1500.00"; it replaces the amount saved before.'),
  /** Optional Customer:Job (budgets by Customer:Job). */
  customerId: zUuid.nullish().describe('Id of a customer or job (customer list) when budgeting by Customer:Job.'),
  /** Optional class. */
  classId: zUuid.nullish().describe('Id of a class (class list) when budgeting by class.'),
});
export type SetBudgetLineBody = z.infer<typeof setBudgetLineSchema>;

/** POST /api/budgets/:id/fill-from-actuals — QB "Create budget from previous year's actual data". */
export const fillBudgetSchema = z.object({
  /** The fiscal year whose actuals fill the budget (default: the year before the budget's). */
  fiscalYear: z.coerce
    .number()
    .int()
    .min(2000)
    .max(2100)
    .nullish()
    .describe("Fiscal year whose actual amounts fill the budget; leave out for the year before the budget's."),
  classId: zUuid.nullish().describe('Id of a class (class list) to take the actual amounts of that class only.'),
  customerId: zUuid.nullish().describe('Id of a customer or job (customer list) to take the actual amounts of that Customer:Job only.'),
});

/** POST /api/budgets/:id/copy — copy a budget / forecast into another year, +/- a percentage. */
export const copyBudgetSchema = z.object({
  name: z.string().trim().min(1, 'Give the new budget a name').max(255).describe('Name of the new budget (at most 255 characters).'),
  fiscalYear: z.coerce.number().int().min(2000).max(2100).describe('Fiscal year of the new budget, such as 2027.'),
  isForecast: z.boolean().optional().describe('True makes the copy a forecast instead of a budget.'),
  percent: z
    .union([z.string().max(20), z.number()])
    .nullish()
    .describe('Change applied to every amount as a percentage, such as "5" for 5% more or "-10" for 10% less; leave out to copy as is.'),
});

/** POST /api/budgets/:id/adjust — Adjust Row Amounts by a percentage. */
export const adjustBudgetSchema = z.object({
  percent: z
    .union([z.string().max(20), z.number()])
    .describe('Change applied to the amounts as a percentage, such as "5" for 5% more or "-10" for 10% less.'),
  fromMonth: z.coerce
    .number()
    .int()
    .min(1)
    .max(12)
    .nullish()
    .describe('Calendar month (1 to 12) from which the change starts within the fiscal year; leave out for the whole year.'),
  accountIds: z
    .array(zUuid)
    .max(2000)
    .nullish()
    .describe('Ids of the accounts whose rows change (chart of accounts); leave out for every row.'),
  classId: zUuid.nullish().describe('Id of a class (class list) to change only that class\'s rows.'),
  customerId: zUuid.nullish().describe("Id of a customer or job (customer list) to change only that Customer:Job's rows."),
});
