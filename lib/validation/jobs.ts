/**
 * Zod schemas for /api/jobs — mirrors CreateJobInput / UpdateJobInput
 * (lib/services/jobs.ts).
 */
import { z } from 'zod';
import { zDate, zDecimal, zUuid } from './helpers';

export const createJobSchema = z.object({
  name: z.string({ required_error: 'name is required' }).min(1, 'Job name is required.').describe('Name of the job, such as "Kitchen remodel".'),
  customerId: zUuid.nullish().describe('Id of the customer the job is for (customer list); leave out for a job with no customer yet.'),
  budget: zDecimal.nullish().describe('Budgeted amount of the job as decimal text such as "25000.00"; leave out for no budget.'),
  startDate: zDate.nullish().describe('Date the job starts, YYYY-MM-DD; leave out for none.'),
  endDate: zDate.nullish().describe('Date the job is expected to end, YYYY-MM-DD, not before startDate; leave out for none.'),
  /** B4: Job Type list entry. */
  jobTypeId: zUuid.nullish().describe('Id of a Job Type list entry (such as "Residential") for reports by job type; leave out for none.'),
});
export type CreateJobBody = z.infer<typeof createJobSchema>;

/** PATCH — UpdateJobInput is Partial<CreateJobInput> & { status?: string }. */
export const updateJobSchema = z.object({
  name: z.string().min(1, 'Job name is required.').optional().describe('New name of the job; leave out to keep the name.'),
  customerId: zUuid.nullish().describe('Id of the customer the job is for (customer list); leave out to keep it, or send null to clear it.'),
  budget: zDecimal.nullish().describe('Budgeted amount as decimal text such as "25000.00"; leave out to keep it, or send null to clear it.'),
  startDate: zDate.nullish().describe('Date the job starts, YYYY-MM-DD; leave out to keep it, or send null to clear it.'),
  endDate: zDate.nullish().describe('Date the job is expected to end, YYYY-MM-DD; leave out to keep it, or send null to clear it.'),
  status: z.string().optional().describe('Job status text, such as "active" or "inactive"; leave out to keep it.'),
  /** B4: Job Type list entry (null clears it). */
  jobTypeId: zUuid.nullish().describe('Id of a Job Type list entry; leave out to keep it, or send null to clear it.'),
});
export type UpdateJobBody = z.infer<typeof updateJobSchema>;

/** POST /api/job-type-assign — set (or clear) a job's Job Type. */
export const assignJobTypeSchema = z.object({
  jobId: zUuid.describe('Id of the job (job list).'),
  jobTypeId: zUuid.nullable().describe('Id of the Job Type list entry to give the job, or null to clear its job type.'),
});
