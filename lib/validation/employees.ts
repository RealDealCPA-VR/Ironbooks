/**
 * Zod schemas for /api/employees — mirrors CreateEmployeeInput /
 * UpdateEmployeeInput (lib/services/payroll.ts).
 */
import { z } from 'zod';
import { zDate, zDecimal, zUuid } from './helpers';

export const payTypeSchema = z.enum(['hourly', 'salary', 'commission']);

export const createEmployeeSchema = z.object({
  firstName: z.string({ required_error: 'firstName is required' }).min(1, 'First name is required.'),
  lastName: z.string({ required_error: 'lastName is required' }).min(1, 'Last name is required.'),
  email: z.string().nullish(),
  payType: payTypeSchema,
  payRate: zDecimal,
});
export type CreateEmployeeBody = z.infer<typeof createEmployeeSchema>;

export const updateEmployeeSchema = z.object({
  firstName: z.string().min(1, 'First name is required.').optional(),
  lastName: z.string().min(1, 'Last name is required.').optional(),
  email: z.string().nullish(),
  payType: payTypeSchema.optional(),
  payRate: zDecimal.optional(),
  /** 9-digit SSN (with or without dashes) to set; null/'' clears it. */
  ssn: z.string().nullish(),
  /** W-4 payroll info — shape is service-defined ({ filingStatus, ... }). */
  w4: z.record(z.unknown()).nullish(),
  /** Mailing address — shape is service-defined ({ line1, city, ... }). */
  address: z.record(z.unknown()).nullish(),
  isActive: z.boolean().optional(),
  phone: z.string().max(50).nullish(),
  hireDate: zDate.nullish(),
  releaseDate: zDate.nullish(),
  /** Default workers' comp class code (null clears it). */
  workersCompCodeId: zUuid.nullish(),
});
export type UpdateEmployeeBody = z.infer<typeof updateEmployeeSchema>;
