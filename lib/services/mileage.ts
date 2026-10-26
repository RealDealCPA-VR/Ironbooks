/**
 * Mileage tracking service — reimbursable / billable mileage log.
 *
 * Mileage is a pure log + deduction tracker. No GL impact by default (deductions are
 * computed from the IRS rate, not posted as journal entries; the caller may choose to
 * attach a GL post separately if reimbursing via payroll or expense report).
 *
 * Functions:
 *   listMileage    — list logs for the company, optionally filtered by customer.
 *   logMiles       — create a new mileage log row.
 *   deleteMileage  — hard-delete a log row (no GL reversal needed).
 *   mileageSummary — total miles + total deductible amount, optionally by date range,
 *                    grouped by customer and job.
 */
import { and, asc, between, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { Money, toAmountString } from '@/lib/money';
import { mileageLogs, customers, employees, jobs, vehicles } from '@/lib/db/schema';
import { irsMileageRateFor } from './mileageRates';
import {
  type ServiceContext,
  ServiceError,
  assertRefInCompany,
  notFound,
  validation,
  writeAudit,
} from './_base';

/**
 * Default rate when a trip has none: the IRS business mileage rate for the TRIP's year
 * (lib/services/mileageRates.ts) — 2024 67¢, 2025 70¢, 2026 72.5¢. A single hard-coded 67¢ logged
 * every 2025 / 2026 trip below the IRS rate.
 */
export { irsMileageRateFor } from './mileageRates';
/** @deprecated The 2024 rate; use irsMileageRateFor(date). */
export const DEFAULT_RATE_PER_MILE = '0.67';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MileageLog {
  id: string;
  companyId: string;
  employeeId: string | null;
  customerId: string | null;
  jobId: string | null;
  date: Date;
  miles: string;
  ratePerMile: string;
  /** miles * ratePerMile, rounded to 2dp */
  amount: string;
  purpose: string | null;
  billable: boolean;
  createdAt: Date;
  /** Denormalized display names (null when not linked). */
  customerName: string | null;
  jobName: string | null;
  /** Vehicle list (wave-2 lists) + optional odometer readings. */
  vehicleId: string | null;
  vehicleName: string | null;
  odometerStart: string | null;
  odometerEnd: string | null;
}

export interface LogMilesInput {
  employeeId?: string | null;
  customerId?: string | null;
  jobId?: string | null;
  date: Date;
  miles: number | string;
  ratePerMile?: number | string | null;
  purpose?: string | null;
  billable?: boolean;
  /** Vehicle list entry the trip was driven in. */
  vehicleId?: string | null;
  /** Odometer readings; when both are given, miles must equal end − start. */
  odometerStart?: number | string | null;
  odometerEnd?: number | string | null;
  /** Vehicle driven (Mileage by Vehicle report). */
  vehicle?: string | null;
}

export interface MileageSummaryGroup {
  customerId: string | null;
  customerName: string | null;
  jobId: string | null;
  jobName: string | null;
  totalMiles: string;
  totalAmount: string;
}

export interface MileageSummary {
  totalMiles: string;
  totalAmount: string;
  groups: MileageSummaryGroup[];
  from?: string;
  to?: string;
}

// ---------------------------------------------------------------------------
// listMileage
// ---------------------------------------------------------------------------

export async function listMileage(
  ctx: ServiceContext,
  opts: { customerId?: string; vehicleId?: string; id?: string } = {},
): Promise<MileageLog[]> {
  const conds = [eq(mileageLogs.companyId, ctx.companyId)];
  if (opts.id) conds.push(eq(mileageLogs.id, opts.id));
  if (opts.customerId) conds.push(eq(mileageLogs.customerId, opts.customerId));
  if (opts.vehicleId) conds.push(eq(mileageLogs.vehicleId, opts.vehicleId));

  const rows = await ctx.db
    .select({
      id: mileageLogs.id,
      companyId: mileageLogs.companyId,
      employeeId: mileageLogs.employeeId,
      customerId: mileageLogs.customerId,
      jobId: mileageLogs.jobId,
      date: mileageLogs.date,
      miles: mileageLogs.miles,
      ratePerMile: mileageLogs.ratePerMile,
      purpose: mileageLogs.purpose,
      billable: mileageLogs.billable,
      createdAt: mileageLogs.createdAt,
      customerName: customers.displayName,
      jobName: jobs.name,
      vehicleId: mileageLogs.vehicleId,
      vehicleName: vehicles.name,
      odometerStart: mileageLogs.odometerStart,
      odometerEnd: mileageLogs.odometerEnd,
    })
    .from(mileageLogs)
    .leftJoin(customers, and(eq(mileageLogs.customerId, customers.id), eq(customers.companyId, ctx.companyId)))
    .leftJoin(jobs, and(eq(mileageLogs.jobId, jobs.id), eq(jobs.companyId, ctx.companyId)))
    .leftJoin(vehicles, and(eq(mileageLogs.vehicleId, vehicles.id), eq(vehicles.companyId, ctx.companyId)))
    .where(and(...conds))
    .orderBy(desc(mileageLogs.date), desc(mileageLogs.createdAt));

  return rows.map((r) => ({
    ...r,
    amount: toAmountString(Money.mul(r.miles, r.ratePerMile)),
    customerName: r.customerName ?? null,
    jobName: r.jobName ?? null,
    vehicleId: r.vehicleId ?? null,
    vehicleName: r.vehicleName ?? null,
    odometerStart: r.odometerStart ?? null,
    odometerEnd: r.odometerEnd ?? null,
  }));
}

// ---------------------------------------------------------------------------
// logMiles
// ---------------------------------------------------------------------------

export async function logMiles(ctx: ServiceContext, input: LogMilesInput): Promise<MileageLog> {
  const miles = Money.of(input.miles);
  if (miles.lessThanOrEqualTo(0)) {
    throw validation('miles must be greater than zero.');
  }

  if (!(input.date instanceof Date) || isNaN(input.date.getTime())) {
    throw validation('A valid trip date is required.');
  }
  const rate = Money.of(
    input.ratePerMile != null && input.ratePerMile !== '' ? input.ratePerMile : irsMileageRateFor(input.date),
  );
  if (rate.lessThan(0)) {
    throw validation('ratePerMile cannot be negative.');
  }

  // If a customerId is supplied, verify it belongs to this company.
  if (input.customerId) {
    const [c] = await ctx.db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.id, input.customerId), eq(customers.companyId, ctx.companyId)));
    if (!c) throw notFound('Customer');
  }

  // If a jobId is supplied, verify it belongs to this company.
  if (input.jobId) {
    const [j] = await ctx.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.id, input.jobId), eq(jobs.companyId, ctx.companyId)));
    if (!j) throw notFound('Job');
  }

  if (input.employeeId) await assertRefInCompany(ctx, employees, input.employeeId, 'Employee');

  if (input.vehicleId) {
    const [v] = await ctx.db
      .select({ id: vehicles.id, isActive: vehicles.isActive })
      .from(vehicles)
      .where(and(eq(vehicles.id, input.vehicleId), eq(vehicles.companyId, ctx.companyId)));
    if (!v) throw notFound('Vehicle');
    if (!v.isActive) throw validation('That vehicle is inactive.');
  }
  const odoStart = input.odometerStart != null && input.odometerStart !== '' ? Money.of(input.odometerStart) : null;
  const odoEnd = input.odometerEnd != null && input.odometerEnd !== '' ? Money.of(input.odometerEnd) : null;
  if ((odoStart && odoStart.isNegative()) || (odoEnd && odoEnd.isNegative())) {
    throw validation('Odometer readings cannot be negative.');
  }
  if (odoStart && odoEnd) {
    if (odoEnd.lessThan(odoStart)) throw validation('The ending odometer reading is lower than the starting one.');
    if (!odoEnd.minus(odoStart).toDecimalPlaces(1).eq(miles.toDecimalPlaces(1))) {
      throw validation(`The odometer readings add up to ${odoEnd.minus(odoStart).toFixed(1)} miles, not ${miles.toFixed(1)}.`);
    }
  }

  const [row] = await ctx.db
    .insert(mileageLogs)
    .values({
      companyId: ctx.companyId,
      employeeId: input.employeeId ?? null,
      customerId: input.customerId ?? null,
      jobId: input.jobId ?? null,
      date: input.date,
      miles: toAmountString(miles),
      ratePerMile: rate.toFixed(4),
      purpose: input.purpose ?? null,
      billable: input.billable ?? false,
      vehicleId: input.vehicleId ?? null,
      odometerStart: odoStart ? odoStart.toFixed(1) : null,
      odometerEnd: odoEnd ? odoEnd.toFixed(1) : null,
      vehicle: input.vehicle?.trim() || null,
    })
    .returning();

  await writeAudit(ctx, {
    action: 'create',
    entityType: 'mileage_log',
    entityId: row.id,
    newValues: { miles: row.miles, ratePerMile: row.ratePerMile, date: row.date },
  });

  // Fetch the new row with its joins (only that row — not the company's whole mileage log).
  const [created] = await listMileage(ctx, { id: row.id });
  if (!created) throw new ServiceError('INTERNAL', 'Failed to reload mileage log after insert.');
  return created;
}

// ---------------------------------------------------------------------------
// deleteMileage
// ---------------------------------------------------------------------------

export async function deleteMileage(ctx: ServiceContext, id: string): Promise<{ deleted: boolean }> {
  // Verify ownership before delete.
  const [existing] = await ctx.db
    .select({ id: mileageLogs.id })
    .from(mileageLogs)
    .where(and(eq(mileageLogs.id, id), eq(mileageLogs.companyId, ctx.companyId)));

  if (!existing) throw notFound('Mileage log');

  await ctx.db
    .delete(mileageLogs)
    .where(and(eq(mileageLogs.id, id), eq(mileageLogs.companyId, ctx.companyId)));

  await writeAudit(ctx, {
    action: 'delete',
    entityType: 'mileage_log',
    entityId: id,
    oldValues: { id },
  });

  return { deleted: true };
}

// ---------------------------------------------------------------------------
// mileageSummary
// ---------------------------------------------------------------------------

export async function mileageSummary(
  ctx: ServiceContext,
  range?: { from?: Date; to?: Date },
): Promise<MileageSummary> {
  const conds = [eq(mileageLogs.companyId, ctx.companyId)];
  if (range?.from) conds.push(gte(mileageLogs.date, range.from));
  if (range?.to) conds.push(lte(mileageLogs.date, range.to));

  // Pull raw rows with customer / job names for grouping.
  const rows = await ctx.db
    .select({
      customerId: mileageLogs.customerId,
      jobId: mileageLogs.jobId,
      miles: mileageLogs.miles,
      ratePerMile: mileageLogs.ratePerMile,
      customerName: customers.displayName,
      jobName: jobs.name,
    })
    .from(mileageLogs)
    .leftJoin(customers, and(eq(mileageLogs.customerId, customers.id), eq(customers.companyId, ctx.companyId)))
    .leftJoin(jobs, and(eq(mileageLogs.jobId, jobs.id), eq(jobs.companyId, ctx.companyId)))
    .where(and(...conds));

  // Aggregate totals and groups in-process (PGlite DECIMAL SUM quirks).
  let totalMiles = Money.zero();
  let totalAmount = Money.zero();

  // Key: `${customerId ?? 'null'}:${jobId ?? 'null'}`
  const groupMap = new Map<
    string,
    {
      customerId: string | null;
      customerName: string | null;
      jobId: string | null;
      jobName: string | null;
      miles: ReturnType<typeof Money.zero>;
      amount: ReturnType<typeof Money.zero>;
    }
  >();

  for (const r of rows) {
    const mi = Money.of(r.miles);
    const amt = Money.mul(r.miles, r.ratePerMile);
    totalMiles = totalMiles.plus(mi);
    totalAmount = totalAmount.plus(amt);

    const key = `${r.customerId ?? 'null'}:${r.jobId ?? 'null'}`;
    const existing = groupMap.get(key);
    if (existing) {
      existing.miles = existing.miles.plus(mi);
      existing.amount = existing.amount.plus(amt);
    } else {
      groupMap.set(key, {
        customerId: r.customerId,
        customerName: r.customerName ?? null,
        jobId: r.jobId,
        jobName: r.jobName ?? null,
        miles: mi,
        amount: Money.of(amt),
      });
    }
  }

  const groups: MileageSummaryGroup[] = [...groupMap.values()].map((g) => ({
    customerId: g.customerId,
    customerName: g.customerName,
    jobId: g.jobId,
    jobName: g.jobName,
    totalMiles: toAmountString(g.miles),
    totalAmount: toAmountString(g.amount),
  }));

  // Sort: named customers first, then by customerName, then jobName.
  groups.sort((a, b) => {
    const ca = a.customerName ?? '￿';
    const cb = b.customerName ?? '￿';
    if (ca !== cb) return ca.localeCompare(cb);
    const ja = a.jobName ?? '￿';
    const jb = b.jobName ?? '￿';
    return ja.localeCompare(jb);
  });

  return {
    totalMiles: toAmountString(totalMiles),
    totalAmount: toAmountString(totalAmount),
    groups,
    from: range?.from?.toISOString(),
    to: range?.to?.toISOString(),
  };
}
