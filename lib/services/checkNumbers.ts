/**
 * Check-number sequencing + duplicate detection.
 *
 * nextCheckNumber — scans billPayments.reference, expenses.reference (checks) and
 *   paychecks.checkNumber for the highest numeric value and returns max+1 as a string.
 *   Optionally filtered to a specific paymentAccountId so you get the next check number per
 *   bank account (paychecks are drawn on 1000 Checking, so they count for that account).
 *
 * reserveCheckNumber — alias for nextCheckNumber; returns the next available number without
 *   mutating any state (callers embed it in their own document as the reference field).
 *
 * findDuplicateCheckNumbers / assertCheckNumberAvailable — QB "Duplicate check number"
 *   warning (A3). Saving a check whose number is already used on the same bank account is
 *   refused with a CONFLICT (details.duplicateNumber = true) unless the caller passes the
 *   explicit override the user confirmed (allowDuplicateNumber).
 *
 * These functions never write: storing the chosen number is the job of the owning service.
 */
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { accounts, billPayments, expenses, paychecks } from '@/lib/db/schema';
import { type ServiceContext, ServiceError } from './_base';
import { getPreferences } from './company';

/** Parse a string reference as a non-negative integer. Returns null if non-numeric. */
function parseRef(ref: string | null | undefined): number | null {
  if (!ref) return null;
  const trimmed = ref.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = parseInt(trimmed, 10);
  return isNaN(n) ? null : n;
}

/** Paychecks are paid from 1000 Checking: they share that account's check sequence. */
async function paychecksDrawOn(ctx: ServiceContext, paymentAccountId?: string): Promise<boolean> {
  if (!paymentAccountId) return true;
  const [row] = await ctx.db
    .select({ code: accounts.code })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, paymentAccountId)));
  return row?.code === '1000';
}

/**
 * Return the next available check number as a string.
 *
 * Scans numeric reference values across bill payments, check expenses and printed paychecks
 * for this company (optionally scoped to a paymentAccountId) and returns max + 1. If no numeric
 * references exist, returns "1001" (a sensible starting point for a new checkbook).
 */
export async function nextCheckNumber(
  ctx: ServiceContext,
  paymentAccountId?: string,
): Promise<string> {
  // We fetch raw varchar values and parse in JS so we stay compatible with PGlite builds that
  // may not support REGEXP_MATCHES.
  const bpQuery = ctx.db
    .select({ reference: billPayments.reference })
    .from(billPayments)
    .where(
      and(
        eq(billPayments.companyId, ctx.companyId),
        ...(paymentAccountId ? [eq(billPayments.paymentAccountId, paymentAccountId)] : []),
      ),
    );

  const expQuery = ctx.db
    .select({ reference: expenses.reference })
    .from(expenses)
    .where(
      and(
        eq(expenses.companyId, ctx.companyId),
        ...(paymentAccountId ? [eq(expenses.paymentAccountId, paymentAccountId)] : []),
      ),
    );

  const [bpRefs, expRefs] = await Promise.all([bpQuery, expQuery]);
  const allRefs = [...bpRefs.map((r) => r.reference), ...expRefs.map((r) => r.reference)];

  if (await paychecksDrawOn(ctx, paymentAccountId)) {
    const pcRefs = await ctx.db
      .select({ reference: paychecks.checkNumber })
      .from(paychecks)
      .where(eq(paychecks.companyId, ctx.companyId));
    allRefs.push(...pcRefs.map((r) => r.reference));
  }

  let max = 0;
  for (const ref of allRefs) {
    const n = parseRef(ref);
    if (n !== null && n > max) max = n;
  }

  return String(max > 0 ? max + 1 : 1001);
}

/**
 * Alias for nextCheckNumber — returns the next available check number without reserving it
 * (stateless; idempotent).
 */
export async function reserveCheckNumber(
  ctx: ServiceContext,
  paymentAccountId?: string,
): Promise<string> {
  return nextCheckNumber(ctx, paymentAccountId);
}

export interface CheckNumberUse {
  source: 'expense' | 'bill_payment' | 'paycheck';
  id: string;
  date: Date;
  amount: string;
}

/**
 * Every non-void check on `paymentAccountId` that already uses `number` (exact, trimmed match).
 * `exclude` skips the document being edited.
 */
export async function findDuplicateCheckNumbers(
  ctx: ServiceContext,
  params: {
    paymentAccountId: string;
    number: string | null | undefined;
    exclude?: { source: CheckNumberUse['source']; id: string };
  },
): Promise<CheckNumberUse[]> {
  const num = (params.number ?? '').trim();
  if (!num) return [];
  const ex = params.exclude;
  const out: CheckNumberUse[] = [];

  const expRows = await ctx.db
    .select({ id: expenses.id, date: expenses.date, amount: expenses.total })
    .from(expenses)
    .where(
      and(
        eq(expenses.companyId, ctx.companyId),
        eq(expenses.paymentAccountId, params.paymentAccountId),
        eq(expenses.method, 'check'),
        isNull(expenses.voidedAt),
        sql`trim(${expenses.reference}) = ${num}`,
        ...(ex?.source === 'expense' ? [ne(expenses.id, ex.id)] : []),
      ),
    );
  out.push(...expRows.map((r) => ({ source: 'expense' as const, ...r })));

  const bpRows = await ctx.db
    .select({ id: billPayments.id, date: billPayments.date, amount: billPayments.amount })
    .from(billPayments)
    .where(
      and(
        eq(billPayments.companyId, ctx.companyId),
        eq(billPayments.paymentAccountId, params.paymentAccountId),
        eq(billPayments.method, 'check'),
        isNull(billPayments.voidedAt),
        sql`trim(${billPayments.reference}) = ${num}`,
        ...(ex?.source === 'bill_payment' ? [ne(billPayments.id, ex.id)] : []),
      ),
    );
  out.push(...bpRows.map((r) => ({ source: 'bill_payment' as const, ...r })));

  if (await paychecksDrawOn(ctx, params.paymentAccountId)) {
    const pcRows = await ctx.db
      .select({ id: paychecks.id, date: paychecks.payDate, amount: paychecks.netPay })
      .from(paychecks)
      .where(
        and(
          eq(paychecks.companyId, ctx.companyId),
          isNull(paychecks.voidedAt),
          sql`trim(${paychecks.checkNumber}) = ${num}`,
          ...(ex?.source === 'paycheck' ? [ne(paychecks.id, ex.id)] : []),
        ),
      );
    out.push(...pcRows.map((r) => ({ source: 'paycheck' as const, ...r })));
  }
  return out;
}

/**
 * QB duplicate check-number warning, enforced server-side: throws CONFLICT with
 * details { duplicateNumber: true, number, matches } unless `allowDuplicate` is set
 * (the user saw the warning and chose to keep the number).
 */
export async function assertCheckNumberAvailable(
  ctx: ServiceContext,
  params: {
    paymentAccountId: string;
    number: string | null | undefined;
    exclude?: { source: CheckNumberUse['source']; id: string };
    allowDuplicate?: boolean;
  },
): Promise<void> {
  if (params.allowDuplicate) return;
  // Preferences > Checking: "Warn about duplicate check numbers" off accepts the duplicate silently.
  if (!(await getPreferences(ctx)).warnDuplicateCheckNumbers) return;
  const matches = await findDuplicateCheckNumbers(ctx, params);
  if (matches.length > 0) {
    const num = (params.number ?? '').trim();
    throw new ServiceError(
      'CONFLICT',
      `Check number ${num} is already used on this bank account. Use a different number, or confirm that you want to keep the duplicate.`,
      { duplicateNumber: true, number: num, matches },
    );
  }
}
