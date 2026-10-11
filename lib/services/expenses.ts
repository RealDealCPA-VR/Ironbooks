/**
 * Expenses service — QB "Write Checks" / "Enter Credit Card Charges" (direct non-bill spend).
 *
 * An expense records money leaving a payment account WITHOUT going through A/P:
 *
 *   method 'check' | 'cash' (bank/cash payment account):
 *     Dr  each expense line account
 *     Cr  payment account                       — classic Write Checks
 *
 *   method 'credit_card' (credit-card liability payment account):
 *     Dr  each expense line account
 *     Cr  credit-card liability                 — QB "Enter Credit Card Charge"
 *
 *   credit-card CREDIT (refund flag, or negative line total):
 *     Dr  credit-card liability
 *     Cr  each expense line account             — QB "Enter Credit Card Credit"
 *
 * All GL writes go through postJournalEntry with sourceRef "expense:<id>" so every
 * expense is traceable to its journal entry. Check-number sequencing reuses
 * lib/services/checkNumbers (scans billPayments.reference + expenses.reference).
 *
 * Print queue: a method='check' expense saved with toPrint=true has NO check number
 * yet — it sits in the Print Checks queue until markExpensePrinted stamps a number
 * and clears the flag (QB "To be printed" checks).
 *
 * Multi-tenant safety: every query is scoped by ctx.companyId.
 * Money: all arithmetic uses Money/toAmountString — never JS floats.
 */
import { isBankAccount, isCreditCardAccount } from '@/lib/accountTypes';
import { and, desc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import { Money, toAmountString } from '@/lib/money';
import {
  accounts,
  classes,
  customers,
  expenseLines,
  expenses,
  jobs,
  journalEntries,
  vendors,
} from '@/lib/db/schema';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { postJournalEntry, voidJournalEntry, type PostingLine } from './posting';
import { nextCheckNumber } from './checkNumbers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExpenseMethod = 'check' | 'cash' | 'credit_card';

export interface ExpenseLineInput {
  accountId: string;
  description?: string | null;
  /** Decimal string/number. Positive normally; all-negative lines flip into a CC credit. */
  amount: string | number;
  classId?: string | null;
  /** Billable customer (and optional job) for job costing. */
  customerId?: string | null;
  jobId?: string | null;
}

export interface CreateExpenseInput {
  /** Either a vendor or a free-text payee name (at least one required). */
  vendorId?: string | null;
  payeeName?: string | null;
  date: Date;
  method: ExpenseMethod;
  /** Check number (method='check'). Auto-assigned from the sequence when omitted, unless toPrint. */
  reference?: string | null;
  /** Funding account — bank/cash asset for check/cash, credit-card liability for credit_card. */
  paymentAccountId: string;
  memo?: string | null;
  lines: ExpenseLineInput[];
  /** Queue this check for Print Checks; number is stamped at print time. method='check' only. */
  toPrint?: boolean;
  /** Credit-card credit (vendor refund): Dr CC liability / Cr expense lines. method='credit_card' only. */
  isRefund?: boolean;
}

// ---------------------------------------------------------------------------
// createExpense
// ---------------------------------------------------------------------------

export async function createExpense(ctx: ServiceContext, input: CreateExpenseInput) {
  // ── payee ─────────────────────────────────────────────────────────────────
  let payeeDisplay = input.payeeName?.trim() || '';
  if (input.vendorId) {
    const [vendor] = await ctx.db
      .select({ id: vendors.id, name: vendors.displayName })
      .from(vendors)
      .where(and(eq(vendors.id, input.vendorId), eq(vendors.companyId, ctx.companyId)));
    if (!vendor) throw notFound('Vendor');
    if (!payeeDisplay) payeeDisplay = vendor.name;
  }
  if (!payeeDisplay) {
    throw validation('A vendor or a payee name is required.');
  }

  if (!['check', 'cash', 'credit_card'].includes(input.method)) {
    throw validation(`Unsupported expense method '${input.method}'.`);
  }

  // ── payment account: ownership + type fit for the method ────────────────
  const [payAcct] = await ctx.db
    .select({ id: accounts.id, type: accounts.type, subtype: accounts.subtype, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.id, input.paymentAccountId), eq(accounts.companyId, ctx.companyId)));
  if (!payAcct) throw notFound('Payment account');

  // QB parity: checks and cash expenses come from a Bank account (lib/accountTypes.ts).
  const isBankish = isBankAccount(payAcct);
  const isCreditCard = isCreditCardAccount(payAcct);

  if (input.method === 'credit_card') {
    if (!isCreditCard) {
      throw validation('Credit card charges must use a credit-card liability account as the payment account.');
    }
  } else if (!isBankish) {
    throw validation('Checks and cash expenses must be paid from a bank/cash account.');
  }

  // ── lines: presence, sign consistency, dimension ownership ───────────────
  if (!input.lines || input.lines.length === 0) {
    throw validation('At least one expense line is required.');
  }

  let total = Money.zero();
  let sawNegative = false;
  let sawPositive = false;
  for (const [i, line] of input.lines.entries()) {
    const amt = Money.round2(line.amount);
    if (amt.isZero()) throw validation(`Line ${i + 1}: amount cannot be zero.`);
    if (amt.isNegative()) sawNegative = true;
    else sawPositive = true;
    total = total.plus(amt);
  }
  if (sawNegative && sawPositive) {
    throw validation('Mixed positive and negative line amounts are not supported. Enter a charge or a credit, not both.');
  }

  // Negative total (or explicit flag) = credit-card credit.
  const isRefund = Boolean(input.isRefund) || sawNegative;
  if (isRefund && input.method !== 'credit_card') {
    throw validation('Refunds/credits are only supported for the credit_card method. Record a vendor refund check as a deposit.');
  }
  const absTotal = total.abs();
  if (absTotal.isZero()) throw validation('Expense total must be non-zero.');
  const totalStr = toAmountString(absTotal);

  // Validate line GL accounts belong to the company and are not the payment account.
  const lineAccountIds = [...new Set(input.lines.map((l) => l.accountId))];
  const acctRows = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), inArray(accounts.id, lineAccountIds)));
  const ownedAccountIds = new Set(acctRows.map((a) => a.id));
  for (const id of lineAccountIds) {
    if (!ownedAccountIds.has(id)) throw notFound(`Account ${id}`);
    if (id === input.paymentAccountId) {
      throw validation('An expense line cannot post to the payment account itself. Use a transfer instead.');
    }
  }

  // Validate optional dimensions (class / billable customer / job) belong to the company.
  await assertDimensionsOwned(ctx, input.lines);

  // ── check-number handling ─────────────────────────────────────────────────
  const toPrint = Boolean(input.toPrint) && input.method === 'check';
  let reference = input.reference?.trim() || null;
  if (input.method !== 'check') {
    // keep whatever reference the user typed (e.g. CC slip number)
  } else if (toPrint) {
    reference = null; // number is stamped at print time
  } else if (!reference) {
    reference = await nextCheckNumber(ctx, input.paymentAccountId);
  }

  // ── transaction: insert expense + lines, post GL, link entry ─────────────
  return inTransaction(ctx, async (tx) => {
    const [expense] = await tx.db
      .insert(expenses)
      .values({
        companyId: tx.companyId,
        vendorId: input.vendorId ?? null,
        payeeName: payeeDisplay,
        date: input.date,
        method: input.method,
        reference,
        paymentAccountId: input.paymentAccountId,
        total: isRefund ? toAmountString(absTotal.negated()) : totalStr,
        memo: input.memo?.trim() || null,
        toPrint,
      })
      .returning();

    const lineRows = input.lines.map((l, i) => ({
      expenseId: expense.id,
      accountId: l.accountId,
      description: l.description?.trim() || null,
      amount: toAmountString(Money.round2(l.amount)),
      classId: l.classId ?? null,
      customerId: l.customerId ?? null,
      jobId: l.jobId ?? null,
      lineOrder: i,
    }));
    await tx.db.insert(expenseLines).values(lineRows);

    // GL lines. Charge: Dr expense lines / Cr payment. Credit: Dr payment / Cr expense lines.
    const glLines: PostingLine[] = input.lines.map((l) => {
      const abs = toAmountString(Money.round2(l.amount).abs());
      return {
        accountId: l.accountId,
        ...(isRefund ? { credit: abs } : { debit: abs }),
        memo: l.description?.trim() || null,
        classId: l.classId ?? null,
      };
    });
    glLines.push({
      accountId: input.paymentAccountId,
      ...(isRefund ? { debit: totalStr } : { credit: totalStr }),
      memo: isRefund
        ? `Credit card credit — ${payeeDisplay}`
        : `${methodLabel(input.method)} — ${payeeDisplay}`,
    });

    const entry = await postJournalEntry(tx, {
      date: input.date,
      description: isRefund
        ? `Credit card credit — ${payeeDisplay}`
        : `${methodLabel(input.method)} — ${payeeDisplay}`,
      reference,
      sourceRef: `expense:${expense.id}`,
      lines: glLines,
    });

    const [updated] = await tx.db
      .update(expenses)
      .set({ postedEntryId: entry.id })
      .where(eq(expenses.id, expense.id))
      .returning();

    await writeAudit(tx, {
      action: 'create',
      entityType: 'expense',
      entityId: expense.id,
      newValues: {
        payee: payeeDisplay,
        method: input.method,
        reference,
        paymentAccountId: input.paymentAccountId,
        total: updated.total,
        isRefund,
        toPrint,
        postedEntryId: entry.id,
        lines: lineRows.map(({ expenseId: _e, ...rest }) => rest),
      },
    });

    return updated;
  });
}

function methodLabel(method: ExpenseMethod): string {
  switch (method) {
    case 'check':
      return 'Check';
    case 'cash':
      return 'Cash expense';
    case 'credit_card':
      return 'Credit card charge';
  }
}

async function assertDimensionsOwned(ctx: ServiceContext, lines: ExpenseLineInput[]) {
  const classIds = [...new Set(lines.map((l) => l.classId).filter((x): x is string => !!x))];
  const customerIds = [...new Set(lines.map((l) => l.customerId).filter((x): x is string => !!x))];
  const jobIds = [...new Set(lines.map((l) => l.jobId).filter((x): x is string => !!x))];

  for (const id of classIds) {
    const [row] = await ctx.db
      .select({ id: classes.id })
      .from(classes)
      .where(and(eq(classes.id, id), eq(classes.companyId, ctx.companyId)));
    if (!row) throw notFound(`Class ${id}`);
  }
  for (const id of customerIds) {
    const [row] = await ctx.db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.id, id), eq(customers.companyId, ctx.companyId)));
    if (!row) throw notFound(`Customer ${id}`);
  }
  for (const id of jobIds) {
    const [row] = await ctx.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.companyId, ctx.companyId)));
    if (!row) throw notFound(`Job ${id}`);
  }
}

// ---------------------------------------------------------------------------
// getExpense
// ---------------------------------------------------------------------------

export async function getExpense(ctx: ServiceContext, id: string) {
  const [expense] = await ctx.db
    .select()
    .from(expenses)
    .where(and(eq(expenses.id, id), eq(expenses.companyId, ctx.companyId)));
  if (!expense) throw notFound('Expense');

  const lines = await ctx.db
    .select()
    .from(expenseLines)
    .where(eq(expenseLines.expenseId, id))
    .orderBy(expenseLines.lineOrder);

  return { ...expense, lines };
}

// ---------------------------------------------------------------------------
// listExpenses
// ---------------------------------------------------------------------------

export interface ListExpensesOptions {
  vendorId?: string;
  method?: ExpenseMethod;
  paymentAccountId?: string;
  /** Only checks queued for printing (method='check', toPrint=true, not void). */
  toPrint?: boolean;
  includeVoided?: boolean;
  dateFrom?: Date;
  dateTo?: Date;
  limit?: number;
  offset?: number;
}

/** List expenses newest-first with the vendor display name joined in. */
export async function listExpenses(ctx: ServiceContext, opts?: ListExpensesOptions) {
  const conditions = [eq(expenses.companyId, ctx.companyId)];
  if (opts?.vendorId) conditions.push(eq(expenses.vendorId, opts.vendorId));
  if (opts?.method) conditions.push(eq(expenses.method, opts.method));
  if (opts?.paymentAccountId) conditions.push(eq(expenses.paymentAccountId, opts.paymentAccountId));
  if (opts?.toPrint) {
    conditions.push(eq(expenses.toPrint, true));
    conditions.push(eq(expenses.method, 'check'));
  }
  if (!opts?.includeVoided) conditions.push(isNull(expenses.voidedAt));
  if (opts?.dateFrom) conditions.push(gte(expenses.date, opts.dateFrom));
  if (opts?.dateTo) conditions.push(lte(expenses.date, opts.dateTo));

  const rows = await ctx.db
    .select({
      expense: expenses,
      vendorName: vendors.displayName,
      paymentAccountName: accounts.name,
    })
    .from(expenses)
    .leftJoin(vendors, eq(expenses.vendorId, vendors.id))
    .leftJoin(accounts, eq(expenses.paymentAccountId, accounts.id))
    .where(and(...conditions))
    .orderBy(desc(expenses.date), desc(expenses.createdAt))
    .limit(opts?.limit ?? 200)
    .offset(opts?.offset ?? 0);

  return rows.map((r) => ({
    ...r.expense,
    vendorName: r.vendorName ?? null,
    paymentAccountName: r.paymentAccountName ?? null,
  }));
}

/** The Print Checks queue: check expenses awaiting a printed number. */
export async function listPrintQueue(ctx: ServiceContext, paymentAccountId?: string) {
  return listExpenses(ctx, { toPrint: true, paymentAccountId });
}

// ---------------------------------------------------------------------------
// markExpensePrinted
// ---------------------------------------------------------------------------

/**
 * Stamp a printed check: assign the check number, clear the print flag, and
 * propagate the number onto the journal entry reference for traceability.
 */
export async function markExpensePrinted(
  ctx: ServiceContext,
  input: { expenseId: string; checkNumber?: string },
) {
  const [expense] = await ctx.db
    .select()
    .from(expenses)
    .where(and(eq(expenses.id, input.expenseId), eq(expenses.companyId, ctx.companyId)));
  if (!expense) throw notFound('Expense');
  if (expense.voidedAt) throw new ServiceError('CONFLICT', 'This expense is void and cannot be printed.');
  if (expense.method !== 'check') throw validation('Only check expenses can be printed.');
  if (!expense.toPrint) throw new ServiceError('CONFLICT', 'This check is not in the print queue.');

  const checkNumber =
    input.checkNumber?.trim() || (await nextCheckNumber(ctx, expense.paymentAccountId));

  return inTransaction(ctx, async (tx) => {
    const [updated] = await tx.db
      .update(expenses)
      .set({ toPrint: false, reference: checkNumber })
      .where(eq(expenses.id, expense.id))
      .returning();

    if (expense.postedEntryId) {
      await tx.db
        .update(journalEntries)
        .set({ reference: checkNumber, updatedAt: new Date() })
        .where(
          and(
            eq(journalEntries.id, expense.postedEntryId),
            eq(journalEntries.companyId, tx.companyId),
          ),
        );
    }

    await writeAudit(tx, {
      action: 'update',
      entityType: 'expense',
      entityId: expense.id,
      oldValues: { toPrint: true, reference: expense.reference },
      newValues: { toPrint: false, reference: checkNumber },
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// voidExpense
// ---------------------------------------------------------------------------

/** Void an expense: reverse its GL impact via voidJournalEntry and stamp voidedAt. */
export async function voidExpense(ctx: ServiceContext, id: string) {
  const [expense] = await ctx.db
    .select()
    .from(expenses)
    .where(and(eq(expenses.id, id), eq(expenses.companyId, ctx.companyId)));
  if (!expense) throw notFound('Expense');
  if (expense.voidedAt) {
    throw new ServiceError('CONFLICT', 'This expense is already void.');
  }

  return inTransaction(ctx, async (tx) => {
    if (expense.postedEntryId) {
      await voidJournalEntry(tx, expense.postedEntryId);
    }

    const [updated] = await tx.db
      .update(expenses)
      .set({ voidedAt: new Date(), toPrint: false })
      .where(eq(expenses.id, id))
      .returning();

    await writeAudit(tx, {
      action: 'void',
      entityType: 'expense',
      entityId: id,
      oldValues: { voidedAt: null },
      newValues: { voidedAt: updated.voidedAt },
    });

    return updated;
  });
}
