/**
 * Check-number sequencing + duplicate detection.
 *
 * nextCheckNumber — scans billPayments.reference, expenses.reference (checks only — card,
 *   cash and EFT references are not check numbers) and paychecks.checkNumber for the highest
 *   check number and returns the next one (lib/smartDefaults nextCheckNumberFrom: "1001A"
 *   counts as 1001, leading zeros are kept, gaps are not back-filled).
 *   Optionally filtered to a specific paymentAccountId so you get the next check number per
 *   bank account (a paycheck counts for the bank account its entry paid the net pay from).
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
import { type SQL, and, eq, isNull, ne, sql } from 'drizzle-orm';
import { billPayments, expenses, journalEntries, paychecks, paymentChecks } from '@/lib/db/schema';
import { type ServiceContext, ServiceError } from './_base';
import { getPreferences } from './company';
import { nextCheckNumberFrom } from '@/lib/smartDefaults';
import { duplicateNumberFixes } from '@/lib/errorFixes';


/**
 * SQL: the paycheck was paid from this bank account — its journal entry credits the account (the
 * net pay line). Paychecks are written on the Preferences > Payroll paycheck account (or the pay
 * run's), not always 1000 Checking: a company paying payroll from "Payroll Checking" had its
 * paychecks numbered, queued and duplicate-checked against 1000 Checking's check sequence.
 */
export function paycheckDrawnOnSql(paymentAccountId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM journal_entry_lines pc_jel WHERE pc_jel.journal_entry_id = ${paychecks.postedEntryId} AND pc_jel.account_id = ${paymentAccountId}::uuid AND COALESCE(pc_jel.credit, 0) > 0)`;
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
        eq(billPayments.method, 'check'),
        ...(paymentAccountId ? [eq(billPayments.paymentAccountId, paymentAccountId)] : []),
      ),
    );

  const expQuery = ctx.db
    .select({ reference: expenses.reference })
    .from(expenses)
    .where(
      and(
        eq(expenses.companyId, ctx.companyId),
        eq(expenses.method, 'check'),
        ...(paymentAccountId ? [eq(expenses.paymentAccountId, paymentAccountId)] : []),
      ),
    );

  // p1 purchases: Sales Tax Payment / Liability / refund checks (payment_checks).
  const pcQuery = ctx.db
    .select({ reference: paymentChecks.reference })
    .from(paymentChecks)
    .where(
      and(
        eq(paymentChecks.companyId, ctx.companyId),
        ...(paymentAccountId ? [eq(paymentChecks.paymentAccountId, paymentAccountId)] : []),
      ),
    );

  const [bpRefs, expRefs, payChkRefs] = await Promise.all([bpQuery, expQuery, pcQuery]);
  const allRefs = [
    ...bpRefs.map((r) => r.reference),
    ...expRefs.map((r) => r.reference),
    ...payChkRefs.map((r) => r.reference),
  ];

  const pcRefs = await ctx.db
    .select({ reference: paychecks.checkNumber })
    .from(paychecks)
    .where(and(eq(paychecks.companyId, ctx.companyId), ...(paymentAccountId ? [paycheckDrawnOnSql(paymentAccountId)] : [])));
  allRefs.push(...pcRefs.map((r) => r.reference));

  return nextCheckNumberFrom(allRefs);
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
  source: 'expense' | 'bill_payment' | 'paycheck' | 'payment_check';
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

  const chkRows = await ctx.db
    .select({ id: paymentChecks.id, date: paymentChecks.date, amount: paymentChecks.amount })
    .from(paymentChecks)
    .leftJoin(journalEntries, eq(paymentChecks.postedEntryId, journalEntries.id))
    .where(
      and(
        eq(paymentChecks.companyId, ctx.companyId),
        eq(paymentChecks.paymentAccountId, params.paymentAccountId),
        isNull(paymentChecks.voidedAt),
        sql`COALESCE(${journalEntries.status}, 'posted') <> 'void'`,
        sql`trim(${paymentChecks.reference}) = ${num}`,
        ...(ex?.source === 'payment_check' ? [ne(paymentChecks.id, ex.id)] : []),
      ),
    );
  out.push(...chkRows.map((r) => ({ source: 'payment_check' as const, ...r })));

  const pcRows = await ctx.db
    .select({ id: paychecks.id, date: paychecks.payDate, amount: paychecks.netPay })
    .from(paychecks)
    .where(
      and(
        eq(paychecks.companyId, ctx.companyId),
        isNull(paychecks.voidedAt),
        sql`trim(${paychecks.checkNumber}) = ${num}`,
        paycheckDrawnOnSql(params.paymentAccountId),
        ...(ex?.source === 'paycheck' ? [ne(paychecks.id, ex.id)] : []),
      ),
    );
  out.push(...pcRows.map((r) => ({ source: 'paycheck' as const, ...r })));
  return out;
}

/**
 * The number a check is written or printed with: the number the user typed (refused when it is
 * already used on the account, unless `allowDuplicate`), else the account's next number.
 * Call it INSIDE the transaction that stores the number: PGlite serializes transactions, so two
 * checks numbered at the same time see each other and never get the same next number.
 */
export async function allocateCheckNumber(
  tx: ServiceContext,
  params: {
    paymentAccountId: string;
    number?: string | null;
    exclude?: { source: CheckNumberUse['source']; id: string };
    allowDuplicate?: boolean;
    numberField?: string;
  },
): Promise<string> {
  const number = params.number?.trim() || (await nextCheckNumber(tx, params.paymentAccountId));
  await assertCheckNumberAvailable(tx, { ...params, number });
  return number;
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
    /** Request-body field holding the number, for the "use the next number" fix (default 'reference'). */
    numberField?: string;
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
    ).withFixes(
      duplicateNumberFixes({
        number: num,
        nextNumber: await nextCheckNumber(ctx, params.paymentAccountId),
        field: params.numberField ?? 'reference',
        overrideFlag: { path: 'allowDuplicateNumber', value: true },
        label: 'check number',
      }),
    );
  }
}
