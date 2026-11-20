/**
 * Zod schemas for /api/time-entries — mirrors TimeEntryInput / TimeEntryUpdate
 * (lib/services/timeTracking.ts) and the /bill body.
 */
import { z } from 'zod';
import { zDate, zDecimal, zUuid } from './helpers';

export const createTimeEntrySchema = z.object({
  employeeId: zUuid.nullish().describe('Id of the employee who did the work (employee list).'),
  customerId: zUuid.nullish().describe('Id of the customer the work was for (customer list).'),
  jobId: zUuid.nullish().describe("Id of one of that customer's jobs (job list)."),
  serviceItemId: zUuid.nullish().describe('Id of the service item (item list) the time is billed as.'),
  date: zDate.describe('Date the work was done, YYYY-MM-DD.'),
  hours: zDecimal.describe('Hours worked as decimal text, such as "1.5".'),
  /** Defaults to true. */
  billable: z.boolean().optional().describe('Whether the time can be billed to the customer; leave out for true.'),
  rate: zDecimal
    .nullish()
    .describe("Hourly billing rate as decimal text such as \"95.00\"; leave out to use the employee's billing rate or the service item's price."),
  description: z.string().nullish().describe('What was done; it fills the invoice line when the time is billed.'),
});
export type CreateTimeEntryBody = z.infer<typeof createTimeEntrySchema>;

/** PATCH — absent keys stay absent so the service only touches provided fields. */
export const updateTimeEntrySchema = z.object({
  employeeId: zUuid.nullish().describe('Id of the employee who did the work (employee list).'),
  customerId: zUuid.nullish().describe('Id of the customer the work was for (customer list).'),
  jobId: zUuid.nullish().describe("Id of one of that customer's jobs (job list)."),
  serviceItemId: zUuid.nullish().describe('Id of the service item (item list) the time is billed as.'),
  date: zDate.optional().describe('Date the work was done, YYYY-MM-DD.'),
  hours: zDecimal.optional().describe('Hours worked as decimal text, such as "1.5".'),
  billable: z.boolean().optional().describe('Whether the time can be billed to the customer.'),
  rate: zDecimal
    .nullish()
    .describe("Hourly billing rate as decimal text such as \"95.00\"; null uses the employee's billing rate or the service item's price."),
  description: z.string().nullish().describe('What was done.'),
});
export type UpdateTimeEntryBody = z.infer<typeof updateTimeEntrySchema>;

/** POST /api/time-entries/bill — bill unbilled time for one customer. */
export const billTimeSchema = z.object({
  customerId: zUuid.describe('Id of the customer whose unbilled billable time is put on a new invoice.'),
});
export type BillTimeBody = z.infer<typeof billTimeSchema>;
