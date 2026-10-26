/**
 * Time Tracking service — internal billable time → invoice (QB-parity feature).
 *
 * Time entries are stored in `timeEntries`. When entries are billable and have
 * a customerId they can be gathered and billed through `billTimeToInvoice`, which
 * calls `createInvoice` from the invoices service (the only GL writer for A/R).
 *
 * Rules:
 *  - No direct GL posting; GL happens only through createInvoice.
 *  - All queries are scoped to ctx.companyId.
 *  - Rate fallback: entry.rate → service item salesPrice → 0.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { Money, toAmountString } from '@/lib/money';
import { timeEntries, customers, items, employees, jobs } from '@/lib/db/schema';
import {
  type ServiceContext,
  ServiceError,
  assertRefInCompany,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { createInvoice } from './invoices';
import { assertAccountantMayBillCosts } from './accountantCopy/guard';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TimeEntryInput {
  employeeId?: string | null;
  customerId?: string | null;
  jobId?: string | null;
  serviceItemId?: string | null;
  date: Date;
  hours: string | number;
  billable?: boolean;
  rate?: string | number | null;
  description?: string | null;
}

export interface TimeEntryUpdate {
  employeeId?: string | null;
  customerId?: string | null;
  jobId?: string | null;
  serviceItemId?: string | null;
  date?: Date;
  hours?: string | number;
  billable?: boolean;
  rate?: string | number | null;
  description?: string | null;
}

export interface ListTimeEntriesFilter {
  customerId?: string;
  billable?: boolean;
  invoiced?: boolean;
}

// ---------------------------------------------------------------------------
// listTimeEntries
// ---------------------------------------------------------------------------

export async function listTimeEntries(ctx: ServiceContext, filter: ListTimeEntriesFilter = {}) {
  const rows = await ctx.db
    .select()
    .from(timeEntries)
    .where(eq(timeEntries.companyId, ctx.companyId))
    .orderBy(timeEntries.date);

  return rows.filter((r) => {
    if (filter.customerId !== undefined && r.customerId !== filter.customerId) return false;
    if (filter.billable !== undefined && r.billable !== filter.billable) return false;
    if (filter.invoiced !== undefined) {
      const isInvoiced = r.invoicedInvoiceId !== null;
      if (isInvoiced !== filter.invoiced) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// createTimeEntry
// ---------------------------------------------------------------------------

/** Employee / job / service item ids from the payload must belong to this company. */
async function assertTimeRefsOwned(
  ctx: ServiceContext,
  refs: Pick<TimeEntryInput, 'employeeId' | 'jobId' | 'serviceItemId'>,
) {
  if (refs.employeeId) await assertRefInCompany(ctx, employees, refs.employeeId, 'Employee');
  if (refs.jobId) await assertRefInCompany(ctx, jobs, refs.jobId, 'Job');
  if (refs.serviceItemId) await assertRefInCompany(ctx, items, refs.serviceItemId, 'Service item');
}

export async function createTimeEntry(ctx: ServiceContext, input: TimeEntryInput) {
  const hours = Money.of(input.hours);
  if (hours.lessThanOrEqualTo(0)) throw validation('Hours must be greater than zero.');

  // Verify customer belongs to company if supplied.
  if (input.customerId) {
    const [cust] = await ctx.db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, input.customerId)));
    if (!cust) throw notFound('Customer');
  }
  await assertTimeRefsOwned(ctx, input);

  const rate = input.rate != null ? toAmountString(input.rate) : null;

  const [entry] = await ctx.db
    .insert(timeEntries)
    .values({
      companyId: ctx.companyId,
      employeeId: input.employeeId ?? null,
      customerId: input.customerId ?? null,
      jobId: input.jobId ?? null,
      serviceItemId: input.serviceItemId ?? null,
      date: input.date,
      hours: toAmountString(hours),
      billable: input.billable ?? true,
      rate,
      description: input.description ?? null,
    })
    .returning();

  await writeAudit(ctx, {
    action: 'create',
    entityType: 'time_entry',
    entityId: entry.id,
    newValues: { hours: entry.hours, customerId: entry.customerId, billable: entry.billable },
  });

  return entry;
}

// ---------------------------------------------------------------------------
// updateTimeEntry
// ---------------------------------------------------------------------------

export async function updateTimeEntry(
  ctx: ServiceContext,
  id: string,
  update: TimeEntryUpdate,
) {
  const [existing] = await ctx.db
    .select()
    .from(timeEntries)
    .where(and(eq(timeEntries.companyId, ctx.companyId), eq(timeEntries.id, id)));
  if (!existing) throw notFound('Time entry');

  if (existing.invoicedInvoiceId) {
    throw new ServiceError('CONFLICT', 'Cannot edit a time entry that has already been invoiced.');
  }

  if (update.hours !== undefined) {
    const h = Money.of(update.hours);
    if (h.lessThanOrEqualTo(0)) throw validation('Hours must be greater than zero.');
  }

  if (update.customerId !== undefined && update.customerId !== null) {
    const [cust] = await ctx.db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, update.customerId)));
    if (!cust) throw notFound('Customer');
  }
  await assertTimeRefsOwned(ctx, update);

  const patch: Partial<typeof timeEntries.$inferInsert> = {};
  if (update.employeeId !== undefined) patch.employeeId = update.employeeId;
  if (update.customerId !== undefined) patch.customerId = update.customerId;
  if (update.jobId !== undefined) patch.jobId = update.jobId;
  if (update.serviceItemId !== undefined) patch.serviceItemId = update.serviceItemId;
  if (update.date !== undefined) patch.date = update.date;
  if (update.hours !== undefined) patch.hours = toAmountString(update.hours);
  if (update.billable !== undefined) patch.billable = update.billable;
  if (update.rate !== undefined) patch.rate = update.rate != null ? toAmountString(update.rate) : null;
  if (update.description !== undefined) patch.description = update.description;

  const [updated] = await ctx.db
    .update(timeEntries)
    .set(patch)
    .where(and(eq(timeEntries.companyId, ctx.companyId), eq(timeEntries.id, id)))
    .returning();

  await writeAudit(ctx, {
    action: 'update',
    entityType: 'time_entry',
    entityId: id,
    oldValues: existing,
    newValues: patch,
  });

  return updated;
}

// ---------------------------------------------------------------------------
// deleteTimeEntry
// ---------------------------------------------------------------------------

export async function deleteTimeEntry(ctx: ServiceContext, id: string) {
  const [existing] = await ctx.db
    .select()
    .from(timeEntries)
    .where(and(eq(timeEntries.companyId, ctx.companyId), eq(timeEntries.id, id)));
  if (!existing) throw notFound('Time entry');

  if (existing.invoicedInvoiceId) {
    throw new ServiceError('CONFLICT', 'Cannot delete a time entry that has already been invoiced.');
  }

  await ctx.db
    .delete(timeEntries)
    .where(and(eq(timeEntries.companyId, ctx.companyId), eq(timeEntries.id, id)));

  await writeAudit(ctx, {
    action: 'delete',
    entityType: 'time_entry',
    entityId: id,
    oldValues: existing,
  });

  return { deleted: true };
}

// ---------------------------------------------------------------------------
// billTimeToInvoice
// ---------------------------------------------------------------------------

/**
 * Gather all unbilled (invoicedInvoiceId IS NULL) billable time entries for a
 * customer, create an invoice via createInvoice (which posts the GL entry), then
 * stamp invoicedInvoiceId on each entry.
 *
 * Rate resolution order per entry:
 *   1. entry.rate (if set)
 *   2. service item salesPrice (if serviceItemId set)
 *   3. 0
 */
export async function billTimeToInvoice(
  ctx: ServiceContext,
  { customerId }: { customerId: string },
) {
  await assertAccountantMayBillCosts(ctx); // Accountant's Copy (I1): the time-entry links can't travel back
  // Verify customer.
  const [cust] = await ctx.db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, customerId)));
  if (!cust) throw notFound('Customer');

  // Fetch unbilled billable entries for this customer.
  const entries = await ctx.db
    .select()
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.companyId, ctx.companyId),
        eq(timeEntries.customerId, customerId),
        eq(timeEntries.billable, true),
        isNull(timeEntries.invoicedInvoiceId),
      ),
    )
    .orderBy(timeEntries.date);

  if (entries.length === 0) {
    throw new ServiceError('VALIDATION', 'No unbilled billable time entries for this customer.');
  }

  // Resolve service item prices for any entries that reference one.
  const itemIds = [...new Set(entries.map((e) => e.serviceItemId).filter(Boolean) as string[])];
  const itemPriceMap = new Map<string, string | null>();
  if (itemIds.length > 0) {
    const itemRows = await ctx.db
      .select({ id: items.id, salesPrice: items.salesPrice })
      .from(items)
      .where(and(eq(items.companyId, ctx.companyId)));
    for (const r of itemRows) {
      if (itemIds.includes(r.id)) itemPriceMap.set(r.id, r.salesPrice);
    }
  }

  // Build invoice lines: one line per time entry.
  const lines = entries.map((e) => {
    let resolvedRate: string | number = '0';
    if (e.rate != null && Money.gt(e.rate, 0)) {
      resolvedRate = e.rate;
    } else if (e.serviceItemId) {
      const itemPrice = itemPriceMap.get(e.serviceItemId);
      if (itemPrice != null) resolvedRate = itemPrice;
    }

    return {
      itemId: e.serviceItemId ?? null,
      description: e.description ?? `Time entry — ${e.date.toISOString().slice(0, 10)}`,
      quantity: e.hours,
      rate: resolvedRate,
      taxable: false as const,
      // The invoice line remembers its time entry (an invoice edit that removes it unbills it).
      billableSource: { kind: 'time_entry' as const, id: e.id },
    };
  });

  // Refuse to bill a fully un-priced batch — it would silently post a $0 invoice. (Mixed
  // batches still bill; this guards the degenerate all-zero case identified by the audit.)
  const subtotal = lines.reduce(
    (sum, l) => sum.plus(Money.mul(l.quantity, l.rate)),
    Money.zero(),
  );
  if (!subtotal.greaterThan(0)) {
    throw new ServiceError(
      'VALIDATION',
      'These time entries have no rate (and no priced service item). Set a rate before billing.',
    );
  }

  // Create the invoice and stamp the billed entries in ONE transaction, so a failure can't
  // leave a posted invoice with time entries still flagged unbilled (double-billing risk).
  return inTransaction(ctx, async (tx) => {
    const invoice = await createInvoice(tx, {
      customerId,
      date: new Date(),
      lines,
    });
    // Re-check "still unbilled" in the UPDATE and count the rows: the entries were read before
    // this transaction, so a concurrent biller may have invoiced them since. Any shortfall rolls
    // back this invoice instead of billing the same hours twice.
    const stamped = await tx.db
      .update(timeEntries)
      .set({ invoicedInvoiceId: invoice.id })
      .where(
        and(
          eq(timeEntries.companyId, ctx.companyId),
          inArray(timeEntries.id, entries.map((e) => e.id)),
          isNull(timeEntries.invoicedInvoiceId),
        ),
      )
      .returning({ id: timeEntries.id });
    if (stamped.length !== entries.length) {
      throw new ServiceError('CONFLICT', 'One or more time entries were already invoiced.');
    }
    return invoice;
  });
}

// ---------------------------------------------------------------------------
// markTimeEntriesPaidInPayroll  (payroll-suite: time -> payroll link)
// ---------------------------------------------------------------------------

/**
 * Tag prefix appended to a time entry's description when its hours were pulled
 * into a paycheck. `time_entries` has no paycheck FK (schema is frozen), so the
 * link is recorded as a `[payroll:<paycheckId>]` marker in the description plus
 * an audit-trail row per entry. Payroll's "unpaid time" query excludes entries
 * whose description contains this tag.
 */
export const PAYROLL_PAID_TAG = '[payroll:';

/**
 * Mark time entries as consumed by a paycheck. Each entry gets the
 * `[payroll:<paycheckId>]` tag appended to its description and an audit row
 * (action 'update', entityType 'time_entry') recording the paycheck id.
 * Entries already carrying a payroll tag are rejected (double-pay guard).
 */
export async function markTimeEntriesPaidInPayroll(
  ctx: ServiceContext,
  entryIds: string[],
  paycheckId: string,
) {
  // Check "not paid yet" in the same transaction as the tagging (no double-pay between two runs).
  return inTransaction(ctx, (tx) => markTimeEntriesPaidInPayrollInTx(tx, entryIds, paycheckId));
}

async function markTimeEntriesPaidInPayrollInTx(
  ctx: ServiceContext,
  entryIds: string[],
  paycheckId: string,
) {
  const ids = [...new Set(entryIds)];
  if (ids.length === 0) return [];

  const rows = await ctx.db
    .select()
    .from(timeEntries)
    .where(and(eq(timeEntries.companyId, ctx.companyId), inArray(timeEntries.id, ids)));
  if (rows.length !== ids.length) throw notFound('Time entry');

  const already = rows.find((r) => (r.description ?? '').includes(PAYROLL_PAID_TAG));
  if (already) {
    throw new ServiceError(
      'CONFLICT',
      'One or more time entries were already used on a paycheck.',
    );
  }

  const tag = `${PAYROLL_PAID_TAG}${paycheckId}]`;

  return inTransaction(ctx, async (tx) => {
    const updated: Array<typeof timeEntries.$inferSelect> = [];
    for (const row of rows) {
      const description = row.description ? `${row.description} ${tag}` : tag;
      const [u] = await tx.db
        .update(timeEntries)
        .set({ description })
        .where(and(eq(timeEntries.companyId, tx.companyId), eq(timeEntries.id, row.id)))
        .returning();
      updated.push(u);
      await writeAudit(tx, {
        action: 'update',
        entityType: 'time_entry',
        entityId: row.id,
        oldValues: { description: row.description },
        newValues: { description, usedInPaycheckId: paycheckId },
      });
    }
    return updated;
  });
}
