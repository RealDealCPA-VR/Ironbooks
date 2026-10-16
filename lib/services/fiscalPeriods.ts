/**
 * Fiscal periods & period close. Closing a period locks it: the posting engine refuses to post or
 * void entries dated within a closed period (prevents editing prior, reported-on books).
 *
 * Also enforces the company-level closing date (QB "Set Closing Date" + password): postings
 * dated on/before companies.settings.closingDate are blocked unless the request carried a
 * valid closing-date password (ctx.closingDateOverride, set by getServerContext from the
 * x-closing-password header — see lib/services/company.ts setClosingDate).
 */
import { closedPeriodFixes, nextDay } from '@/lib/errorFixes';
import { and, eq, lte, gte } from 'drizzle-orm';
import { companies, fiscalPeriods } from '@/lib/db/schema';
import { type ServiceContext, ServiceError, notFound, writeAudit } from './_base';
import { assertWrite } from './rbac';
import { activeCopy, assertDividingDateOpen } from './accountantCopy/guard';

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
  /**
   * `sourceRef`: the posting's source (Accountant's Copy rules, I1).
   * `movable: false` when the date cannot simply be changed (e.g. the ORIGINAL date of a
   * transaction being edited or voided): the "move to the first open date" fix is then omitted.
   */
  opts: { sourceRef?: string | null; movable?: boolean } = {},
): Promise<PeriodCheck> {
  // Accountant's Copy dividing date (I1): checked first — the closing-date password never bypasses it.
  await assertDividingDateOpen(ctx, date, opts);
  const movable = opts.movable !== false;
  // Calendar-day comparison (UTC, like the closing-date check below): a period closed through
  // 12-31 is stored at 12-31T00:00Z, and a posting at 12-31T23:59:59Z (the year-end closing entry,
  // anything dated with a time of day) is still on that closed day.
  const dayStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayEnd = new Date(dayStart.getTime() + 86_400_000 - 1);
  const closed = await ctx.db
    .select({ id: fiscalPeriods.id })
    .from(fiscalPeriods)
    .where(
      and(
        eq(fiscalPeriods.companyId, ctx.companyId),
        eq(fiscalPeriods.isClosed, true),
        lte(fiscalPeriods.periodStart, dayEnd),
        gte(fiscalPeriods.periodEnd, dayStart),
      ),
    )
    .limit(1);
  if (closed.length) {
    throw new ServiceError(
      'PERIOD_CLOSED',
      `The accounting period containing ${date.toISOString().slice(0, 10)} is closed. Reopen it under Fiscal Periods to post.`,
    ).withFixes(
      closedPeriodFixes({
        reason: 'fiscalPeriod',
        firstOpenDate: movable ? await firstOpenDate(ctx, date) : null,
      }),
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
          { closingDate },
        ).withFixes(
          closingDateFixes(movable ? await firstOpenDate(ctx, date) : null),
        );
      }
      return { closingDateException: closingDate };
    }
  }
  return { closingDateException: null };
}

/**
 * First date on or after `from` that can be posted without a password: after the company closing
 * date and outside every closed fiscal period ('YYYY-MM-DD'; null when none is found within 50
 * consecutive closed periods). Used for the "Move the date to the first open date" fix.
 */
export async function firstOpenDate(ctx: ServiceContext, from: Date): Promise<string | null> {
  const [company] = await ctx.db
    .select({ settings: companies.settings })
    .from(companies)
    .where(eq(companies.id, ctx.companyId));
  const closingDate = (company?.settings as Record<string, unknown> | null)?.closingDate;
  let candidate = from.toISOString().slice(0, 10);
  if (typeof closingDate === 'string' && closingDate && candidate <= closingDate) candidate = nextDay(closingDate);
  // Accountant's Copy (I1): the client can only post AFTER the dividing date, so the suggested
  // date is past it too; in the accountant's copy only dates on or before it can post, so a
  // later date is no fix at all.
  const copy = await activeCopy(ctx.db, ctx.companyId);
  if (copy?.side === 'client' && candidate <= copy.dividingDate) candidate = nextDay(copy.dividingDate);
  const usable = (d: string) => !(copy?.side === 'accountant' && d > copy.dividingDate);
  const periods = await ctx.db
    .select({ start: fiscalPeriods.periodStart, end: fiscalPeriods.periodEnd })
    .from(fiscalPeriods)
    .where(and(eq(fiscalPeriods.companyId, ctx.companyId), eq(fiscalPeriods.isClosed, true)));
  const ranges = periods.map((p) => ({
    start: p.start.toISOString().slice(0, 10),
    end: p.end.toISOString().slice(0, 10),
  }));
  for (let i = 0; i <= 50; i++) {
    const hit = ranges.find((r) => r.start <= candidate && candidate <= r.end);
    if (!hit) return usable(candidate) ? candidate : null;
    candidate = nextDay(hit.end);
  }
  return null;
}

/** Closing-date lock fixes: move the date (when possible) or enter the closing-date password. */
function closingDateFixes(openDate: string | null) {
  return closedPeriodFixes({ reason: 'closingDate', firstOpenDate: openDate });
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
