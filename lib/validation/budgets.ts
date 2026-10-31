/**
 * Zod schemas for /api/budgets — mirror the inline input types of
 * createBudget / setBudgetLine (lib/services/budgets.ts).
 */
import { z } from 'zod';
import { zDecimal, zUuid } from './helpers';

export const createBudgetSchema = z.object({
  name: z.string({ required_error: 'name is required' }).trim().min(1, 'Budget name is required'),
  /** The route historically coerced (Number(body.fiscalYear)); keep that. */
  fiscalYear: z.coerce
    .number({ invalid_type_error: 'fiscalYear must be a number' })
    .int('fiscalYear must be an integer'),
  /** 'profit_loss' (default) or 'balance_sheet'. */
  kind: z.enum(['profit_loss', 'balance_sheet']).optional(),
  /** Create a Forecast instead of a budget. */
  isForecast: z.boolean().optional(),
});
export type CreateBudgetBody = z.infer<typeof createBudgetSchema>;

/** PATCH /api/budgets/:id — upsert one budget line (budgetId comes from the URL). */
export const setBudgetLineSchema = z.object({
  accountId: zUuid,
  month: z.coerce
    .number({ invalid_type_error: 'month must be a number' })
    .int('month must be an integer'),
  /** Service wants a decimal string. */
  amount: zDecimal.transform((v) => String(v)),
  /** Optional Customer:Job (budgets by Customer:Job). */
  customerId: zUuid.nullish(),
  /** Optional class. */
  classId: zUuid.nullish(),
});
export type SetBudgetLineBody = z.infer<typeof setBudgetLineSchema>;

/** POST /api/budgets/:id/fill-from-actuals — QB "Create budget from previous year's actual data". */
export const fillBudgetSchema = z.object({
  /** The fiscal year whose actuals fill the budget (default: the year before the budget's). */
  fiscalYear: z.coerce.number().int().min(2000).max(2100).nullish(),
  classId: zUuid.nullish(),
  customerId: zUuid.nullish(),
});

/** POST /api/budgets/:id/copy — copy a budget / forecast into another year, +/- a percentage. */
export const copyBudgetSchema = z.object({
  name: z.string().trim().min(1, 'Give the new budget a name').max(255),
  fiscalYear: z.coerce.number().int().min(2000).max(2100),
  isForecast: z.boolean().optional(),
  percent: z.union([z.string().max(20), z.number()]).nullish(),
});

/** POST /api/budgets/:id/adjust — Adjust Row Amounts by a percentage. */
export const adjustBudgetSchema = z.object({
  percent: z.union([z.string().max(20), z.number()]),
  fromMonth: z.coerce.number().int().min(1).max(12).nullish(),
  accountIds: z.array(zUuid).max(2000).nullish(),
  classId: zUuid.nullish(),
  customerId: zUuid.nullish(),
});
