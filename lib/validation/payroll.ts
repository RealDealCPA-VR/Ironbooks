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
  kind: z.enum(['earning', 'tax', 'deduction', 'employer_contribution']),
  name: z.string().min(1, 'line name is required'),
  amount: zMoney,
  payrollItemId: zUuid.nullish(),
  /** Tax tracking type (lib/services/payrollTaxTracking.ts); normally taken from the item. */
  taxTracking: z.string().max(40).nullish(),
});

/**
 * Override one CALCULATED tax by its payroll item (never by a typed name). The item's tax
 * tracking type picks the computed line it replaces; 0 removes that tax from the check.
 */
export const taxOverrideSchema = z.object({
  payrollItemId: zUuid,
  amount: zMoney,
});

export const earningLineSchema = z.object({
  kind: z.enum(['regular', 'overtime', 'bonus', 'commission']),
  hours: zDecimal.nullish(),
  rate: zDecimal.nullish(),
  amount: zMoney.nullish(),
  payrollItemId: zUuid.nullish(),
});

export const runPaycheckSchema = z.object({
  employeeId: zUuid,
  payDate: zDate,
  periodStart: zDate.nullish(),
  periodEnd: zDate.nullish(),
  /** Ignored when `earnings` has lines; required by the service otherwise. */
  grossPay: zMoney.optional(),
  earnings: z.array(earningLineSchema).optional(),
  taxes: z.array(paycheckLineSchema).optional(),
  employerTaxes: z.array(paycheckLineSchema).optional(),
  deductions: z.array(paycheckLineSchema).optional(),
  taxOverrides: z.array(taxOverrideSchema).optional(),
  filingStatus: z.enum(['single', 'married', 'head_of_household']).optional(),
  periodsPerYear: z.number().int().positive('periodsPerYear must be a positive integer').optional(),
});
export type RunPaycheckBody = z.infer<typeof runPaycheckSchema>;

export const payRunEmployeeSchema = z.object({
  employeeId: zUuid,
  hours: zDecimal.nullish(),
  amount: zMoney.nullish(),
  deductions: z.array(paycheckLineSchema).optional(),
  timeEntryIds: z.array(zUuid).optional(),
});

export const createPayRunSchema = z.object({
  payDate: zDate,
  periodStart: zDate.nullish(),
  periodEnd: zDate.nullish(),
  memo: z.string().nullish(),
  periodsPerYear: z.number().int().positive('periodsPerYear must be a positive integer').optional(),
  employees: z
    .array(payRunEmployeeSchema, {
      required_error: 'employees must be a non-empty array',
      invalid_type_error: 'employees must be a non-empty array',
    })
    .min(1, 'employees must be a non-empty array'),
});
export type CreatePayRunBody = z.infer<typeof createPayRunSchema>;

/** PATCH /api/payroll/[id] — edit a paycheck (same fields as a new check, minus employee). */
export const editPaycheckSchema = runPaycheckSchema.omit({ employeeId: true });
export type EditPaycheckBody = z.infer<typeof editPaycheckSchema>;

const adjustmentLineSchema = z.object({
  kind: z.enum(['earning', 'tax', 'deduction', 'employer_contribution']),
  name: z.string().min(1, 'line name is required').max(255),
  amount: zMoney,
  payrollItemId: zUuid.nullish(),
});

/** POST /api/payroll/adjustments — YTD setup amounts or a liability adjustment. */
export const createAdjustmentSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ytd'),
    employeeId: zUuid,
    date: zDate,
    periodStart: zDate.nullish(),
    periodEnd: zDate.nullish(),
    memo: z.string().max(500).nullish(),
    lines: z.array(adjustmentLineSchema).min(1, 'enter at least one amount'),
    affectsAccounts: z.boolean().optional(),
    bankAccountId: zUuid.nullish(),
  }),
  z.object({
    type: z.literal('liability'),
    employeeId: zUuid,
    date: zDate,
    memo: z.string().max(500).nullish(),
    lines: z
      .array(adjustmentLineSchema.extend({ kind: z.enum(['tax', 'deduction', 'employer_contribution']) }))
      .min(1, 'enter at least one adjustment line'),
    affectsAccounts: z.boolean().optional(),
    offsetAccountId: zUuid.nullish(),
  }),
]);
export type CreateAdjustmentBody = z.infer<typeof createAdjustmentSchema>;

// A plain decimal ("0.034", 0.034): text such as "abc" or "NaN" used to reach the service, where it
// answered HTTP 500 or was stored as a NaN rate (review round 5).
const zRate = z.union([z.literal(''), zDecimal]).nullish();

/** POST /api/payroll/state-settings — create or replace SUI/SDI settings for a state + year. */
export const stateTaxSettingSchema = z.object({
  state: z.string().regex(/^[A-Za-z]{2}$/, 'state must be a two-letter code'),
  year: z.number().int().min(2000).max(2100),
  suiRate: zRate,
  suiWageBase: zRate,
  sdiRate: zRate,
  sdiWageBase: zRate,
  accountNumber: z.string().max(50).nullish(),
});

export const workersCompCodeSchema = z.object({
  code: z.string().min(1, 'class code is required').max(20),
  description: z.string().max(255).nullish(),
  ratePer100: zDecimal,
  isActive: z.boolean().optional(),
});
export const updateWorkersCompCodeSchema = workersCompCodeSchema.partial();
