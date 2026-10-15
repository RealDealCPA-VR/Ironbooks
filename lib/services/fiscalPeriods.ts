/**
 * Fiscal periods & period close. Closing a period locks it: the posting engine refuses to post or
 * void entries dated within a closed period (prevents editing prior, reported-on books).
 *
 * Also enforces the company-level closing date (QB "Set Closing Date" + password): postings
 * dated on/before companies.settings.closingDate are blocked unless the request carried a
 * valid closing-date password (ctx.closingDateOverride, set by getServerContext from the
 * x-closing-password header — see lib/services/company.ts setClosingDate).
 */
import { and, eq, lte, gte } from 'drizzle-orm';
import { companies, fiscalPeriods } from '@/lib/db/schema';
import { type ServiceContext, ServiceError, notFound, writeAudit } from './_base';
import { assertWrite } from './rbac';
import { assertDividingDateOpen } from './accountantCopy/guard';

export async function listPeriods(ctx: ServiceContext) {
  return ctx.db
    .select()
    .from(fiscalPeriods)
    .where(eq(fiscalPeriods.companyId, ctx.companyId));
}

export async function closePeriod(
  ctx: ServiceContext,
  input: { periodStart: Date; periodEnd: Date },
) {
  assertWrite(ctx); // reject viewers before the insert (writeAudit runs after it)
  const [row] = await ctx.db
    .insert(fiscalPeriods)
    .values({
      companyId: ctx.companyId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      isClosed: true,
      closedAt: new Date(),
      closedBy: ctx.userId,
    })
    .returning();
  await writeAudit(ctx, {
    action: 'update',
    entityType: 'fiscal_period',
    entityId: row.id,
    newValues: { periodStart: input.periodStart, periodEnd: input.periodEnd, isClosed: true },
  });
  return row;
}

export async function reopenPeriod(ctx: ServiceContext, id: string) {
  assertWrite(ctx); // reject viewers before the update (writeAudit runs after it)
  const [existing] = await ctx.db
    .select()
    .from(fiscalPeriods)
    .where(and(eq(fiscalPeriods.id, id), eq(fiscalPeriods.companyId, ctx.companyId)));
  if (!existing) throw notFound('Fiscal period');
  const [row] = await ctx.db
    .update(fiscalPeriods)
    .set({ isClosed: false, closedAt: null, closedBy: null })
    .where(eq(fiscalPeriods.id, id))
    .returning();
  await writeAudit(ctx, {
    action: 'update',
    entityType: 'fiscal_period',
    entityId: id,
    oldValues: { isClosed: true },
    newValues: { isClosed: false },
  });
  return row;
}

/** Result of assertPeriodOpen: set when the closing-date password override was what let it pass. */
export interface PeriodCheck {
  /** The company closing date ('YYYY-MM-DD') this request bypassed with the password, else null. */
  closingDateException: string | null;
}

/**
 * Throw PERIOD_CLOSED if `date` falls within a closed period for this company, or on/before
 * the company closing date without a valid closing-date password for this request.
 * Called by the posting engine before posting or voiding.
 *
 * When the request's closing-date password (ctx.closingDateOverride) is what allows a date on or
 * before the closing date, the result carries `closingDateException` so the caller can record it
 * with `recordClosingDateException` inside its transaction (Closing Date Exception report, J11).
 */
export async function assertPeriodOpen(
  ctx: ServiceContext,
  date: Date,
  opts: { sourceRef?: string | null } = {},
): Promise<PeriodCheck> {
  // Accountant's Copy dividing date (I1): checked first — the closing-date password never bypasses it.
  await assertDividingDateOpen(ctx, date, opts);
  const closed = await ctx.db
    .select({ id: fiscalPeriods.id })
    .from(fiscalPeriods)
    .where(
      and(
        eq(fiscalPeriods.companyId, ctx.companyId),
        eq(fiscalPeriods.isClosed, true),
        lte(fiscalPeriods.periodStart, date),
        gte(fiscalPeriods.periodEnd, date),
      ),
    )
    .limit(1);
  if (closed.length) {
    throw new ServiceError(
      'PERIOD_CLOSED',
      `The accounting period containing ${date.toISOString().slice(0, 10)} is closed. Reopen it under Fiscal Periods to post.`,
    );
  }

  // Company-level closing date (QB Set Closing Date). A verified closing-date password for
  // this request (ctx.closingDateOverride) bypasses the lock, exactly like QBD's password prompt.
  const [company] = await ctx.db
    .select({ settings: companies.settings })
    .from(companies)
    .where(eq(companies.id, ctx.companyId));
  const closingDate = (company?.settings as Record<string, unknown> | null)?.closingDate;
  if (typeof closingDate === 'string' && closingDate) {
    const dateStr = date.toISOString().slice(0, 10);
    if (dateStr <= closingDate) {
      if (!ctx.closingDateOverride) {
        throw new ServiceError(
          'PERIOD_CLOSED',
          `The books are closed through ${closingDate}. Transactions dated on or before the closing date require the closing-date password (or clear the closing date in Settings).`,
        );
      }
      return { closingDateException: closingDate };
    }
  }
  return { closingDateException: null };
}

/**
 * Audit a closing-date password override (QB Closing Date Exception report). Call inside the
 * same transaction as the change, after it succeeded, with the result of assertPeriodOpen.
 * No-op when no exception occurred.
 */
export async function recordClosingDateException(
  ctx: ServiceContext,
  check: PeriodCheck,
  info: {
    entryId: string;
    operation: 'post' | 'void' | 'reclassify' | string;
    transactionDate: Date;
    entryNumber?: number | null;
    description?: string | null;
    sourceRef?: string | null;
  },
): Promise<void> {
  if (!check.closingDateException) return;
  await writeAudit(ctx, {
    action: 'update',
    entityType: 'closing_date_exception',
    entityId: info.entryId,
    newValues: {
      operation: info.operation,
      closingDate: check.closingDateException,
      transactionDate: info.transactionDate.toISOString().slice(0, 10),
      entryNumber: info.entryNumber ?? null,
      description: info.description ?? null,
      sourceRef: info.sourceRef ?? null,
    },
  });
}
