/**
 * Estimate expiration helpers.
 *
 * expireOverdueEstimates — bulk-sets status='rejected' on estimates that
 *   are still open/draft/accepted, have an expirationDate before `asOf`, and
 *   have NOT been converted to an invoice (convertedInvoiceId IS NULL).
 *
 * listExpiringEstimates — returns estimates expiring within the next
 *   `withinDays` calendar days (still in an actionable status).
 *
 * Neither function touches the GL; estimates carry no journal impact until
 * converted to an invoice.
 */
import { and, eq, isNull, lt, lte, gte, inArray, sql } from 'drizzle-orm';
import { estimates, customers } from '@/lib/db/schema';
import { type ServiceContext, writeAudit } from './_base';

/** Statuses that can still expire (not already terminal). */
const EXPIRABLE_STATUSES = ['draft', 'open', 'accepted'] as const;

/**
 * Mark every estimate whose expirationDate < asOf and status is still
 * draft/open/accepted and has not been converted as status='rejected'.
 *
 * Returns the count of rows updated.
 */
export async function expireOverdueEstimates(
  ctx: ServiceContext,
  asOf: Date,
): Promise<number> {
  // Find candidates first so we can write audit rows.
  const candidates = await ctx.db
    .select({ id: estimates.id, status: estimates.status })
    .from(estimates)
    .where(
      and(
        eq(estimates.companyId, ctx.companyId),
        inArray(estimates.status, [...EXPIRABLE_STATUSES]),
        isNull(estimates.convertedInvoiceId),
        // expirationDate is set AND strictly before asOf
        sql`${estimates.expirationDate} IS NOT NULL`,
        lt(estimates.expirationDate, asOf),
      ),
    );

  if (candidates.length === 0) return 0;

  const ids = candidates.map((r) => r.id);

  await ctx.db
    .update(estimates)
    .set({ status: 'rejected', updatedAt: new Date() })
    .where(
      and(
        eq(estimates.companyId, ctx.companyId),
        inArray(estimates.id, ids),
      ),
    );

  // Write one audit row per expired estimate.
  for (const row of candidates) {
    await writeAudit(ctx, {
      action: 'update',
      entityType: 'estimate',
      entityId: row.id,
      oldValues: { status: row.status },
      newValues: { status: 'rejected', reason: 'auto-expired' },
    });
  }

  return candidates.length;
}

export interface ExpiringEstimate {
  id: string;
  companyId: string;
  customerId: string;
  customerName: string;
  estimateNumber: number;
  /** The estimate number users see (typed ref number, else the integer). */
  refNumber: string | null;
  status: string;
  total: string;
  expirationDate: Date;
}

/**
 * List estimates that are still in an actionable status and will expire
 * within the next `withinDays` calendar days (inclusive of today).
 */
export async function listExpiringEstimates(
  ctx: ServiceContext,
  withinDays: number,
): Promise<ExpiringEstimate[]> {
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() + withinDays);

  const rows = await ctx.db
    .select({
      id: estimates.id,
      companyId: estimates.companyId,
      customerId: estimates.customerId,
      customerName: customers.displayName,
      estimateNumber: estimates.estimateNumber,
      refNumber: estimates.refNumber,
      status: estimates.status,
      total: estimates.total,
      expirationDate: estimates.expirationDate,
    })
    .from(estimates)
    .innerJoin(customers, eq(estimates.customerId, customers.id))
    .where(
      and(
        eq(estimates.companyId, ctx.companyId),
        inArray(estimates.status, [...EXPIRABLE_STATUSES]),
        isNull(estimates.convertedInvoiceId),
        sql`${estimates.expirationDate} IS NOT NULL`,
        gte(estimates.expirationDate, now),
        lte(estimates.expirationDate, cutoff),
      ),
    );

  return rows.map((r) => ({
    ...r,
    expirationDate: r.expirationDate as Date,
  }));
}
