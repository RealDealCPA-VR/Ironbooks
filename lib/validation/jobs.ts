/**
 * Zod schemas for /api/jobs — mirrors CreateJobInput / UpdateJobInput
 * (lib/services/jobs.ts).
 */
import { z } from 'zod';
import { zDate, zDecimal, zUuid } from './helpers';

export const createJobSchema = z.object({
  name: z.string({ required_error: 'name is required' }).min(1, 'Job name is required.'),
  customerId: zUuid.nullish(),
  budget: zDecimal.nullish(),
  startDate: zDate.nullish(),
  endDate: zDate.nullish(),
  /** B4: Job Type list entry. */
  jobTypeId: zUuid.nullish(),
});
export type CreateJobBody = z.infer<typeof createJobSchema>;

/** PATCH — UpdateJobInput is Partial<CreateJobInput> & { status?: string }. */
export const updateJobSchema = z.object({
  name: z.string().min(1, 'Job name is required.').optional(),
  customerId: zUuid.nullish(),
  budget: zDecimal.nullish(),
  startDate: zDate.nullish(),
  endDate: zDate.nullish(),
  status: z.string().optional(),
  /** B4: Job Type list entry (null clears it). */
  jobTypeId: zUuid.nullish(),
});
export type UpdateJobBody = z.infer<typeof updateJobSchema>;
