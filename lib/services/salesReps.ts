/**
 * Sales reps & commission tracking service.
 *
 * Sales reps are master data (no GL impact). Commissions are a report computed
 * on demand by summing invoice totals per rep over a date range and applying
 * each rep's commissionRate.
 *
 * Conventions:
 *  - Every query is scoped by ctx.companyId (multi-tenant safety).
 *  - Every mutation emits an audit_logs row via writeAudit.
 *  - Deactivation is soft-delete (isActive = false).
 *  - commissionRate is stored as a decimal fraction, e.g. 0.05 = 5%.
 */
import { and, asc, eq, gte, isNotNull, lte, sql } from 'drizzle-orm';
import { invoices, salesReps } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, inTransaction, notFound, validation, writeAudit } from './_base';
import { assertClosedPeriodEdit } from './postedEdit';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface CreateSalesRepInput {
  name: string;
  email?: string | null;
  /** Decimal fraction, e.g. 0.05 for 5% commission. */
  commissionRate: string | number;
}

export interface UpdateSalesRepInput {
  name?: string;
  email?: string | null;
  commissionRate?: string | number;
}

export interface CommissionReportRow {
  repId: string;
  name: string;
  salesTotal: string;
  commissionRate: string;
  commission: string;
}

export interface CommissionReport {
  rows: CommissionReportRow[];
  totals: {
    salesTotal: string;
    commission: string;
  };
}

export interface DateRange {
  from?: Date;
  to?: Date;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function assertValidEmail(email: string) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw validation(`"${email}" is not a valid email address.`);
  }
}

function validateCreateInput(input: CreateSalesRepInput) {
  if (!input.name?.trim()) {
    throw validation('Sales rep name is required.');
  }
  if (input.email?.trim()) {
    assertValidEmail(input.email.trim());
  }
  const rate = Money.of(input.commissionRate);
  if (rate.isNegative() || rate.greaterThan(1)) {
    throw validation('commissionRate must be between 0 and 1 (e.g. 0.05 for 5%).');
  }
}

// ---------------------------------------------------------------------------
// List / read
// ---------------------------------------------------------------------------

export async function listSalesReps(
  ctx: ServiceContext,
  options: { includeInactive?: boolean } = {},
) {
  const { includeInactive = false } = options;
  const conds = [eq(salesReps.companyId, ctx.companyId)];
  if (!includeInactive) conds.push(eq(salesReps.isActive, true));

  return ctx.db
    .select()
    .from(salesReps)
    .where(and(...conds))
    .orderBy(asc(salesReps.name));
}

export async function getSalesRep(ctx: ServiceContext, id: string) {
  const [row] = await ctx.db
    .select()
    .from(salesReps)
    .where(and(eq(salesReps.id, id), eq(salesReps.companyId, ctx.companyId)));
  if (!row) throw notFound('Sales rep');
  return row;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createSalesRep(ctx: ServiceContext, input: CreateSalesRepInput) {
  validateCreateInput(input);

  const [row] = await ctx.db
    .insert(salesReps)
    .values({
      companyId: ctx.companyId,
      name: input.name.trim(),
      email: input.email?.trim() ?? null,
      commissionRate: toAmountString(input.commissionRate),
    })
    .returning();

  await writeAudit(ctx, {
    action: 'create',
    entityType: 'sales_rep',
    entityId: row.id,
    newValues: { name: row.name, email: row.email, commissionRate: row.commissionRate },
  });

  return row;
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateSalesRep(
  ctx: ServiceContext,
  id: string,
  input: UpdateSalesRepInput,
) {
  const existing = await getSalesRep(ctx, id);

  if (input.name !== undefined && !input.name.trim()) {
    throw validation('Sales rep name cannot be empty.');
  }
  if (input.email?.trim()) {
    assertValidEmail(input.email.trim());
  }
  if (input.commissionRate !== undefined) {
    const rate = Money.of(input.commissionRate);
    if (rate.isNegative() || rate.greaterThan(1)) {
      throw validation('commissionRate must be between 0 and 1 (e.g. 0.05 for 5%).');
    }
  }

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name.trim();
  if ('email' in input) patch.email = input.email?.trim() ?? null;
  if (input.commissionRate !== undefined)
    patch.commissionRate = toAmountString(input.commissionRate);

  if (Object.keys(patch).length === 0) return existing;

  const [updated] = await ctx.db
    .update(salesReps)
    .set(patch)
    .where(and(eq(salesReps.id, id), eq(salesReps.companyId, ctx.companyId)))
    .returning();

  await writeAudit(ctx, {
    action: 'update',
    entityType: 'sales_rep',
    entityId: id,
    oldValues: { name: existing.name, email: existing.email, commissionRate: existing.commissionRate },
    newValues: patch,
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Deactivate
// ---------------------------------------------------------------------------

export async function deactivateSalesRep(ctx: ServiceContext, id: string) {
  const existing = await getSalesRep(ctx, id);
  if (!existing.isActive) return existing;

  const [updated] = await ctx.db
    .update(salesReps)
    .set({ isActive: false })
    .where(and(eq(salesReps.id, id), eq(salesReps.companyId, ctx.companyId)))
    .returning();

  await writeAudit(ctx, {
    action: 'delete',
    entityType: 'sales_rep',
    entityId: id,
    oldValues: { isActive: true },
    newValues: { isActive: false },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Assign rep to invoice
// ---------------------------------------------------------------------------

export async function assignRepToInvoice(
  ctx: ServiceContext,
  input: { invoiceId: string; salesRepId: string | null },
) {
  return inTransaction(ctx, async (tx) => assignRepToInvoiceTx(tx, input));
}

async function assignRepToInvoiceTx(ctx: ServiceContext, input: { invoiceId: string; salesRepId: string | null }) {
  // Verify the invoice belongs to this company.
  const [inv] = await ctx.db
    .select({ id: invoices.id, date: invoices.date, postedEntryId: invoices.postedEntryId, salesRepId: invoices.salesRepId })
    .from(invoices)
    .where(and(eq(invoices.id, input.invoiceId), eq(invoices.companyId, ctx.companyId)));
  if (!inv) throw notFound('Invoice');
  if ((inv.salesRepId ?? null) === input.salesRepId) {
    const [same] = await ctx.db.select().from(invoices).where(eq(invoices.id, inv.id));
    return same;
  }
  // Closing date: changing the rep changes a closed-period invoice (and its commission), so it
  // needs the closing date password like any other edit (and is listed as an exception).
  await assertClosedPeriodEdit(ctx, { entryId: inv.postedEntryId, what: 'invoice sales rep', date: inv.date });

  // If assigning a rep, verify they belong to this company and are active.
  if (input.salesRepId !== null) {
    const rep = await getSalesRep(ctx, input.salesRepId);
    if (!rep.isActive) throw validation('Cannot assign an inactive sales rep to an invoice.');
  }

  const [updated] = await ctx.db
    .update(invoices)
    .set({ salesRepId: input.salesRepId, updatedAt: new Date() })
    .where(and(eq(invoices.id, input.invoiceId), eq(invoices.companyId, ctx.companyId)))
    .returning();

  await writeAudit(ctx, {
    action: 'update',
    entityType: 'invoice',
    entityId: input.invoiceId,
    newValues: { salesRepId: input.salesRepId },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Commission report
// ---------------------------------------------------------------------------

export async function commissionReport(
  ctx: ServiceContext,
  range?: DateRange,
): Promise<CommissionReport> {
  // Aggregate invoice totals per rep for invoices that have a salesRepId set.
  const conds = [
    eq(invoices.companyId, ctx.companyId),
    isNotNull(invoices.salesRepId),
    // Void/draft invoices must not earn commission.
    sql`${invoices.status} NOT IN ('void', 'draft')`,
  ];
  if (range?.from) conds.push(gte(invoices.date, range.from));
  if (range?.to) conds.push(lte(invoices.date, range.to));

  const rows = await ctx.db
    .select({
      repId: invoices.salesRepId,
      salesTotal: sql<string>`COALESCE(SUM(${invoices.total}), 0)`,
    })
    .from(invoices)
    .where(and(...conds))
    .groupBy(invoices.salesRepId);

  // Fetch all active+inactive reps that have sales in the period.
  const repIds = rows.map((r) => r.repId).filter(Boolean) as string[];
  if (repIds.length === 0) {
    return { rows: [], totals: { salesTotal: '0.00', commission: '0.00' } };
  }

  // Fetch rep details for the IDs that appear in results.
  const allReps = await ctx.db
    .select()
    .from(salesReps)
    .where(eq(salesReps.companyId, ctx.companyId));

  const repById = new Map(allReps.map((r) => [r.id, r]));

  let totalSales = Money.zero();
  let totalCommission = Money.zero();

  const reportRows: CommissionReportRow[] = rows
    .filter((r) => r.repId !== null)
    .map((r) => {
      const rep = repById.get(r.repId!);
      if (!rep) return null;
      const sales = Money.of(r.salesTotal);
      const rate = Money.of(rep.commissionRate);
      const commission = Money.round2(sales.times(rate));
      totalSales = totalSales.plus(sales);
      totalCommission = totalCommission.plus(commission);
      return {
        repId: rep.id,
        name: rep.name,
        salesTotal: toAmountString(sales),
        commissionRate: rep.commissionRate,
        commission: toAmountString(commission),
      };
    })
    .filter((r): r is CommissionReportRow => r !== null)
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    rows: reportRows,
    totals: {
      salesTotal: toAmountString(totalSales),
      commission: toAmountString(totalCommission),
    },
  };
}
