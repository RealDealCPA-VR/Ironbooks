/**
 * Expense Reports service.
 *
 * Workflow:
 *   createReport  → status "draft"  (no GL impact)
 *   submitReport  → status "submitted"
 *   approveAndReimburse → status "reimbursed" + posts GL:
 *
 *     Dr  <line.accountId>  (each expense account)   amount
 *     Cr  1000 Checking                               total
 *
 * The total is computed from the sum of all line amounts.
 * postedEntryId is stored on the expense_reports row after posting.
 */
import { and, desc, eq } from 'drizzle-orm';
import type Decimal from 'decimal.js';
import { MAX_LEDGER_AMOUNT, Money, toAmountString } from '@/lib/money';
import { accounts, employees, expenseReports, expenseReportLines } from '@/lib/db/schema';
import {
  type ServiceContext,
  ServiceError,
  assertRefInCompany,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { assertNotControlLineAccount, postJournalEntry } from './posting';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExpenseLineInput {
  accountId: string;
  date?: Date | null;
  description?: string | null;
  amount: string | number;
}

export interface CreateReportInput {
  employeeId: string;
  title?: string | null;
  lines: ExpenseLineInput[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Today's local calendar day at UTC midnight. */
function todayCalendarDay(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

/**
 * A line amount: a finite decimal rounded to cents. "NaN" / "Infinity" parse as decimals but are
 * not amounts (NaN used to be stored as the line amount and the report total).
 */
function lineAmount(raw: string | number, lineNo: number): Decimal {
  let d: Decimal;
  try {
    d = Money.of(typeof raw === 'string' ? raw.trim() : raw);
  } catch {
    throw validation(`Line ${lineNo}: the amount is not a number.`);
  }
  if (!d.isFinite()) throw validation(`Line ${lineNo}: the amount is not a number.`);
  const r = Money.round2(d);
  if (r.abs().greaterThan(MAX_LEDGER_AMOUNT)) throw validation(`Line ${lineNo}: the amount is larger than the books can hold.`);
  return r;
}

/** Resolve Checking account (code 1000) id scoped to company. */
async function checkingAccountId(ctx: ServiceContext): Promise<string> {
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '1000')));
  if (!row) throw notFound('Account with code 1000 (Checking)');
  return row.id;
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * Create a new expense report in "draft" status.
 * Total is computed from the provided lines. No GL entry is posted.
 */
export async function createReport(ctx: ServiceContext, input: CreateReportInput) {
  if (!input.employeeId) throw validation('employeeId is required.');
  if (!input.lines || input.lines.length === 0) throw validation('At least one expense line is required.');

  // Verify employee belongs to this company.
  const [emp] = await ctx.db
    .select({ id: employees.id })
    .from(employees)
    .where(and(eq(employees.companyId, ctx.companyId), eq(employees.id, input.employeeId)));
  if (!emp) throw notFound('Employee');

  // Validate line amounts and compute total. Each line is rounded to cents FIRST and the total is
  // the sum of the stored lines, so the report total always equals its lines (and the
  // reimbursement, which re-adds the stored lines).
  let total = Money.zero();
  const amounts: string[] = [];
  for (const [i, line] of input.lines.entries()) {
    if (!line.accountId) throw validation(`Line ${i + 1}: accountId is required.`);
    // The account must belong to THIS company (never store another company's account id).
    await assertRefInCompany(ctx, accounts, line.accountId, `Line ${i + 1}: Account`);
    const [acct] = await ctx.db
      .select({ type: accounts.type, subtype: accounts.subtype, name: accounts.name })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, line.accountId)));
    // A/R and A/P need a customer / vendor name and non-posting accounts take no amounts: the
    // reimbursement could never post, so refuse the line now rather than at approval.
    assertNotControlLineAccount(acct, `Line ${i + 1}`);
    if (acct.subtype === 'non_posting') {
      throw validation(`Line ${i + 1}: "${acct.name}" is a non-posting account and cannot hold an expense.`);
    }
    const amt = lineAmount(line.amount, i + 1);
    if (amt.isNegative()) throw validation(`Line ${i + 1}: amount cannot be negative.`);
    if (amt.isZero()) throw validation(`Line ${i + 1}: amount must be greater than zero.`);
    total = total.plus(amt);
    amounts.push(toAmountString(amt));
  }
  if (total.greaterThan(MAX_LEDGER_AMOUNT)) throw validation('The report total is larger than the books can hold.');

  return inTransaction(ctx, async (tx) => {
    const [report] = await tx.db
      .insert(expenseReports)
      .values({
        companyId: tx.companyId,
        employeeId: input.employeeId,
        title: input.title?.trim() ?? null,
        status: 'draft',
        total: toAmountString(total),
      })
      .returning();

    // Insert lines.
    await tx.db.insert(expenseReportLines).values(
      input.lines.map((line, idx) => ({
        expenseReportId: report.id,
        accountId: line.accountId,
        date: line.date ?? null,
        description: line.description?.trim() ?? null,
        amount: amounts[idx],
        lineOrder: idx,
      })),
    );

    await writeAudit(tx, {
      action: 'create',
      entityType: 'expense_report',
      entityId: report.id,
      newValues: { employeeId: input.employeeId, total: toAmountString(total), status: 'draft' },
    });

    return report;
  });
}

/** List all expense reports for the active company, ordered newest first. */
export async function listReports(ctx: ServiceContext) {
  return ctx.db
    .select()
    .from(expenseReports)
    .where(eq(expenseReports.companyId, ctx.companyId))
    .orderBy(desc(expenseReports.createdAt));
}

/** Get a single expense report with its lines. */
export async function getReport(ctx: ServiceContext, id: string) {
  const [report] = await ctx.db
    .select()
    .from(expenseReports)
    .where(and(eq(expenseReports.companyId, ctx.companyId), eq(expenseReports.id, id)));
  if (!report) throw notFound('Expense report');

  const lines = await ctx.db
    .select()
    .from(expenseReportLines)
    .where(eq(expenseReportLines.expenseReportId, id))
    .orderBy(expenseReportLines.lineOrder);

  return { ...report, lines };
}

/**
 * Submit an expense report for approval.
 * Allowed transition: draft → submitted.
 */
export async function submitReport(ctx: ServiceContext, id: string) {
  const [report] = await ctx.db
    .select()
    .from(expenseReports)
    .where(and(eq(expenseReports.companyId, ctx.companyId), eq(expenseReports.id, id)));
  if (!report) throw notFound('Expense report');
  if (report.status !== 'draft') {
    throw validation(`Cannot submit a report with status "${report.status}". Only draft reports can be submitted.`);
  }

  // Conditional on the status so a concurrent submit/approve can't move the report twice.
  const [updated] = await ctx.db
    .update(expenseReports)
    .set({ status: 'submitted', submittedAt: new Date() })
    .where(and(eq(expenseReports.id, id), eq(expenseReports.companyId, ctx.companyId), eq(expenseReports.status, 'draft')))
    .returning();
  if (!updated) {
    throw new ServiceError('CONFLICT', 'This expense report was changed by another request. Reload and try again.');
  }

  await writeAudit(ctx, {
    action: 'update',
    entityType: 'expense_report',
    entityId: id,
    oldValues: { status: 'draft' },
    newValues: { status: 'submitted' },
  });

  return updated;
}

/**
 * Approve and reimburse an expense report.
 * Allowed transition: submitted → reimbursed.
 *
 * Posts GL:
 *   Dr  <line.accountId>  (expense)   per-line amount
 *   Cr  1000 Checking                 total reimbursement
 *
 * Stores postedEntryId on the report row.
 */
export async function approveAndReimburse(ctx: ServiceContext, id: string) {
  const [report] = await ctx.db
    .select()
    .from(expenseReports)
    .where(and(eq(expenseReports.companyId, ctx.companyId), eq(expenseReports.id, id)));
  if (!report) throw notFound('Expense report');
  if (report.status !== 'submitted') {
    throw validation(`Cannot reimburse a report with status "${report.status}". Only submitted reports can be reimbursed.`);
  }

  const lines = await ctx.db
    .select()
    .from(expenseReportLines)
    .where(eq(expenseReportLines.expenseReportId, id))
    .orderBy(expenseReportLines.lineOrder);

  if (lines.length === 0) throw validation('Cannot reimburse an expense report with no lines.');

  // Re-compute total from lines as the authoritative source.
  let total = Money.zero();
  for (const line of lines) {
    total = total.plus(Money.of(line.amount));
  }
  if (total.isZero()) throw validation('Total reimbursement amount is zero.');

  const checkingId = await checkingAccountId(ctx);

  return inTransaction(ctx, async (tx) => {
    // Claim the report first (conditional on 'submitted') so two concurrent approvals can never
    // both post a reimbursement; the loser gets CONFLICT and its transaction rolls back.
    const [claimed] = await tx.db
      .update(expenseReports)
      .set({ status: 'reimbursed' })
      .where(and(eq(expenseReports.id, id), eq(expenseReports.companyId, tx.companyId), eq(expenseReports.status, 'submitted')))
      .returning({ id: expenseReports.id });
    if (!claimed) {
      throw new ServiceError('CONFLICT', 'This expense report was already reimbursed or changed by another request.');
    }

    // Build posting lines: one debit per expense line, one credit to Checking.
    const postingLines: Array<{
      accountId: string;
      debit?: string;
      credit?: string;
      memo?: string | null;
    }> = lines.map((line) => ({
      accountId: line.accountId,
      debit: toAmountString(Money.of(line.amount)),
      memo: line.description ?? null,
    }));

    postingLines.push({
      accountId: checkingId,
      credit: toAmountString(total),
      memo: `Reimbursement — ${report.title ?? report.id.slice(0, 8)}`,
    });

    const entry = await postJournalEntry(tx, {
      // Today's calendar day on this computer at UTC midnight (the stored-date convention);
      // `new Date()` is the current instant, already tomorrow in the evening west of UTC.
      date: todayCalendarDay(),
      description: `Expense reimbursement — ${report.title ?? report.id.slice(0, 8)}`,
      reference: report.id.slice(0, 8),
      sourceRef: `expense_report:${report.id}`,
      lines: postingLines,
    });

    // Update report: status → reimbursed, total (recalculated), postedEntryId, approvedBy.
    const [updated] = await tx.db
      .update(expenseReports)
      .set({
        status: 'reimbursed',
        total: toAmountString(total),
        postedEntryId: entry.id,
        approvedBy: tx.userId ?? null,
      })
      .where(eq(expenseReports.id, id))
      .returning();

    await writeAudit(tx, {
      action: 'update',
      entityType: 'expense_report',
      entityId: id,
      oldValues: { status: 'submitted' },
      newValues: { status: 'reimbursed', postedEntryId: entry.id, total: toAmountString(total) },
    });

    // Return report with lines.
    return { ...updated, lines };
  });
}
