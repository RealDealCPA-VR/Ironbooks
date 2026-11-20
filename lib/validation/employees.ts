/**
 * Zod schemas for /api/employees — mirrors CreateEmployeeInput /
 * UpdateEmployeeInput (lib/services/payroll.ts).
 */
import { z } from 'zod';
import { zDate, zDecimal, zUuid } from './helpers';

export const payTypeSchema = z.enum(['hourly', 'salary', 'commission']);

export const createEmployeeSchema = z.object({
  firstName: z
    .string({ required_error: 'firstName is required' })
    .min(1, 'First name is required.')
    .describe("Employee's first name."),
  lastName: z
    .string({ required_error: 'lastName is required' })
    .min(1, 'Last name is required.')
    .describe("Employee's last name."),
  email: z.string().nullish().describe("Employee's email address."),
  payType: payTypeSchema.describe('How the employee is paid: by the hour, a yearly salary, or commission.'),
  payRate: zDecimal.describe(
    'Pay rate as decimal text: the hourly wage for hourly employees, such as "25.00", or the yearly salary for salaried ones.',
  ),
});
export type CreateEmployeeBody = z.infer<typeof createEmployeeSchema>;

export const updateEmployeeSchema = z.object({
  firstName: z.string().min(1, 'First name is required.').optional().describe("Employee's first name."),
  lastName: z.string().min(1, 'Last name is required.').optional().describe("Employee's last name."),
  email: z.string().nullish().describe("Employee's email address."),
  payType: payTypeSchema.optional().describe('How the employee is paid: by the hour, a yearly salary, or commission.'),
  payRate: zDecimal
    .optional()
    .describe('Pay rate as decimal text: the hourly wage for hourly employees, or the yearly salary for salaried ones.'),
  /** 9-digit SSN (with or without dashes) to set; null/'' clears it. */
  ssn: z.string().nullish().describe('Social Security number, 9 digits with or without dashes; blank or null clears it.'),
  /** W-4 payroll info — shape is service-defined ({ filingStatus, ... }). */
  w4: z
    .record(z.unknown())
    .nullish()
    .describe('W-4 withholding details such as filingStatus, dependents and extraWithholding.'),
  /** Mailing address — shape is service-defined ({ line1, city, ... }). */
  address: z
    .record(z.unknown())
    .nullish()
    .describe('Mailing address as named lines: line1, line2, city, state and zip.'),
  isActive: z.boolean().optional().describe('False makes the employee inactive, and inactive employees cannot be paid; true makes them active again.'),
  phone: z.string().max(50).nullish().describe('Phone number (at most 50 characters).'),
  hireDate: zDate.nullish().describe('Date the employee was hired, YYYY-MM-DD.'),
  releaseDate: zDate.nullish().describe('Date the employee left, YYYY-MM-DD.'),
  /** Default workers' comp class code (null clears it). */
  workersCompCodeId: zUuid
    .nullish()
    .describe("Id of the employee's usual workers' compensation class code (workers' comp list); null clears it."),
});
export type UpdateEmployeeBody = z.infer<typeof updateEmployeeSchema>;
