/** Request bodies for the guided month-end close API (app/api/month-end-close/**). */
import { z } from 'zod';
import { MONTH_END_STEP_KEYS } from '@/lib/services/monthEndClose';

const zPeriodEnd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date (YYYY-MM-DD)');
const zVersion = z
  .string()
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)), 'version must be a timestamp')
  .nullable()
  .optional();

export const monthEndStepSchema = z
  .object({
    periodEnd: zPeriodEnd,
    stepKey: z.enum(MONTH_END_STEP_KEYS as [string, ...string[]]),
    action: z.enum(['review', 'unreview', 'skip', 'unskip']),
    note: z.string().max(1000).nullable().optional(),
    reason: z.string().max(500).nullable().optional(),
    version: zVersion,
  })
  .strict();

export const monthEndScanSchema = z.object({ periodEnd: zPeriodEnd }).strict();

export const monthEndCloseSchema = z
  .object({
    periodEnd: zPeriodEnd,
    /** string = set / replace the closing-date password, null = remove it, omitted = keep it. */
    password: z.string().max(200).nullable().optional(),
    version: zVersion,
  })
  .strict();
