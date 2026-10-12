/**
 * Zod schemas for /api/mileage — mirrors LogMilesInput (lib/services/mileage.ts).
 */
import { z } from 'zod';
import { zDate, zDecimal, zUuid } from './helpers';

export const logMilesSchema = z.object({
  employeeId: zUuid.nullish(),
  customerId: zUuid.nullish(),
  jobId: zUuid.nullish(),
  /** Defaults to "now" in the route when omitted. */
  date: zDate.optional(),
  miles: zDecimal,
  ratePerMile: zDecimal.nullish(),
  purpose: z.string().nullish(),
  /** Defaults to false. */
  billable: z.boolean().optional(),
  /** Vehicle list entry + optional odometer readings (wave-2 lists). */
  vehicleId: zUuid.nullish(),
  odometerStart: zDecimal.nullish(),
  odometerEnd: zDecimal.nullish(),
  /** Vehicle driven (Mileage by Vehicle report). */
  vehicle: z.string().max(100).nullish(),
});
export type LogMilesBody = z.infer<typeof logMilesSchema>;
