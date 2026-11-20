/**
 * Zod schemas for /api/mileage — mirrors LogMilesInput (lib/services/mileage.ts).
 */
import { z } from 'zod';
import { zDate, zDecimal, zUuid } from './helpers';

export const logMilesSchema = z.object({
  employeeId: zUuid.nullish().describe('Id of the employee who drove (employee list).'),
  customerId: zUuid.nullish().describe('Id of the customer the trip was for (customer list).'),
  jobId: zUuid.nullish().describe("Id of one of that customer's jobs (job list)."),
  /** Defaults to "now" in the route when omitted. */
  date: zDate.optional().describe('Date of the trip, YYYY-MM-DD; leave out for today.'),
  miles: zDecimal.describe('Miles driven as decimal text, such as "42.5"; must equal odometerEnd minus odometerStart when both are given.'),
  ratePerMile: zDecimal
    .nullish()
    .describe("Rate per mile as decimal text such as \"0.70\"; leave out for the IRS business rate of the trip's year."),
  purpose: z.string().nullish().describe('Why the trip was made.'),
  /** Defaults to false. */
  billable: z.boolean().optional().describe('Whether the mileage can be billed to the customer; leave out for false.'),
  /** Vehicle list entry + optional odometer readings (wave-2 lists). */
  vehicleId: zUuid.nullish().describe('Id of the vehicle driven (vehicle list).'),
  odometerStart: zDecimal.nullish().describe('Odometer reading at the start of the trip, as decimal text.'),
  odometerEnd: zDecimal.nullish().describe('Odometer reading at the end of the trip, as decimal text.'),
  /** Vehicle driven (Mileage by Vehicle report). */
  vehicle: z.string().max(100).nullish().describe('Name of the vehicle driven as free text, shown in the Mileage by Vehicle report (at most 100 characters).'),
});
export type LogMilesBody = z.infer<typeof logMilesSchema>;
