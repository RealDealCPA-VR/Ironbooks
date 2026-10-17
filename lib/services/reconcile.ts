/**
 * Bank Reconciliation service.
 *
 * The reconciliation workflow follows the standard accounting practice:
 *   1. startReconciliation  — open a session against a bank statement.
 *   2. listClearable        — show un-cleared GL lines for the bank account.
 *   3. toggleCleared        — mark / un-mark individual lines as cleared.
 *   4. getProgress          — compare cleared balance to statement balance.
 *   5. completeReconciliation — finalize when difference ≤ $0.01.
 *
 * No journal entries are created by reconciliation itself; it is purely a
 * matching / confirmation step.  The GL lines being reconciled were already
 * posted by other services (invoices, expenses, transfers, etc.).
 */
import { assertReconciliationDateOpen } from './accountantCopy/guard';
import { and, desc, eq, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { onOrBeforeDay } from './journal';
import {
  accounts,
  bankAccounts,
  journalEntries,
  journalEntryLines,
  reconciliationItems,
  reconciliations,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { postJournalEntry } from './posting';
import { accountNumberFor, maskForContext } from './access';
import { payCreditCard } from './liabilityPayments';
import { accountCreditSql, accountDebitSql, foreignCurrencyOfAccount, nz } from './fxLedger';
import { currencyRate, toHome } from './exchangeRates';
import { foreignCode, homeCode } from './fxLines';

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

export interface StartReconciliationInput {
  bankAccountId: string;
  statementDate: Date;
  /** The ending balance shown on the bank statement (positive = asset balance). */
  statementBalance: string | number;
}

export interface ClearableLine {
  journalEntryLineId: string;
  journalEntryId: string;
  date: Date;
  description: string;
  /**
   * Debit (money in) / credit (money out) in the ACCOUNT's currency — for a foreign-currency
   * account that is the amount on the statement (p1 fx), not the home value.
   */
  debit: string | null;
  credit: string | null;
  memo: string | null;
  isCleared: boolean;
  /** Home-currency debit / credit (same as debit / credit for a home-currency account). */
  homeDebit?: string | null;
  homeCredit?: string | null;
}

export interface ReconciliationProgress {
  reconciliationId: string;
  statementBalance: string;
  /** Sum of natural-side amounts for all lines currently marked cleared. */
  clearedBalance: string;
  /** statementBalance − clearedBalance.  Should be 0.00 to complete. */
  difference: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Load a reconciliation row, enforcing company scope. */
async function loadReconciliation(ctx: ServiceContext, reconciliationId: string) {
  // reconciliations does not carry companyId directly — scope via bankAccounts.
  const [row] = await ctx.db
    .select({
      id: reconciliations.id,
      bankAccountId: reconciliations.bankAccountId,
      statementDate: reconciliations.statementDate,
      statementBalance: reconciliations.statementBalance,
      reconciledBalance: reconciliations.reconciledBalance,
      status: reconciliations.status,
      createdBy: reconciliations.createdBy,
      createdAt: reconciliations.createdAt,
      completedAt: reconciliations.completedAt,
      // also pull the GL account id and companyId for scope check
      companyId: bankAccounts.companyId,
      glAccountId: bankAccounts.accountId,
    })
    .from(reconciliations)
    .innerJoin(bankAccounts, eq(reconciliations.bankAccountId, bankAccounts.id))
    .where(eq(reconciliations.id, reconciliationId));

  if (!row) throw notFound('Reconciliation');
  if (row.companyId !== ctx.companyId) throw notFound('Reconciliation');
  return row;
}

/** Compute the sum of cleared line amounts (natural balance direction for the bank account's GL type). */
async function computeClearedBalance(
  ctx: ServiceContext,
  reconciliationId: string,
): Promise<ReturnType<typeof Money.zero>> {
  // Seed with the opening (prior-reconciled) balance. The bank-reconciliation identity is
  //   openingBalance + clearedMovementsThisPeriod = statementEndingBalance,
  // so the cleared total must include the carried-forward balance, not just this period's
  // movements. lastReconciledBalance is null/absent for a first reconciliation (opening 0).
  // The join to accounts pulls the GL type so liability (credit-card) accounts can be
  // accumulated on their natural side (credit − debit) instead of the asset side.
  let cleared = Money.zero();
  let glType: string | null = null;
  let foreign = false;
  const [recon] = await ctx.db
    .select({
      opening: bankAccounts.lastReconciledBalance,
      glType: accounts.type,
      glAccountId: accounts.id,
    })
    .from(reconciliations)
    .innerJoin(bankAccounts, eq(reconciliations.bankAccountId, bankAccounts.id))
    .innerJoin(accounts, eq(bankAccounts.accountId, accounts.id))
    .where(eq(reconciliations.id, reconciliationId));
  if (recon) {
    glType = recon.glType;
    if (recon.opening != null) cleared = Money.of(recon.opening);
    // p1 fx: a foreign-currency account reconciles in its own currency.
    foreign = !!(await foreignCurrencyOfAccount(ctx, recon.glAccountId));
  }

  // Pull every cleared item for this reconciliation.
  const items = await ctx.db
    .select({
      debit: accountDebitSql(foreign),
      credit: accountCreditSql(foreign),
    })
    .from(reconciliationItems)
    .innerJoin(
      journalEntryLines,
      eq(reconciliationItems.journalEntryLineId, journalEntryLines.id),
    )
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(reconciliationItems.reconciliationId, reconciliationId),
        eq(reconciliationItems.isCleared, true),
        // A line cleared in this (in-progress) session whose entry was voided afterwards is no
        // longer in the account — it must not count toward the cleared balance (voidJournalEntry
        // only blocks voids of lines in COMPLETED reconciliations).
        eq(journalEntries.status, 'posted'),
      ),
    );

  // For a bank (asset) account the natural-side amount is debit − credit; for a
  // liability account (credit card) charges are CREDITS, so the natural side is
  // credit − debit. Both keep the cleared total in positive statement terms
  // (positive = balance held / amount owed), matching how users type the
  // statement ending balance.
  const isLiability = glType === 'liability';
  for (const item of items) {
    const d = Money.of(item.debit);
    const c = Money.of(item.credit);
    cleared = isLiability ? cleared.plus(c).minus(d) : cleared.plus(d).minus(c);
  }
  return cleared;
}

// ---------------------------------------------------------------------------
// Public service functions
// ---------------------------------------------------------------------------

/**
 * List all reconciliations for this company, joined to bankAccounts so the caller
 * gets bankName and accountNumber for display purposes. Most-recent first.
 */
export async function listReconciliations(ctx: ServiceContext) {
  const rows = await ctx.db
    .select({
      id: reconciliations.id,
      bankAccountId: reconciliations.bankAccountId,
      statementDate: reconciliations.statementDate,
      statementBalance: reconciliations.statementBalance,
      reconciledBalance: reconciliations.reconciledBalance,
      status: reconciliations.status,
      createdBy: reconciliations.createdBy,
      createdAt: reconciliations.createdAt,
      completedAt: reconciliations.completedAt,
      bankName: bankAccounts.bankName,
      accountNumber: bankAccounts.accountNumber,
    })
    .from(reconciliations)
    .innerJoin(bankAccounts, eq(reconciliations.bankAccountId, bankAccounts.id))
    .where(eq(bankAccounts.companyId, ctx.companyId))
    .orderBy(desc(reconciliations.createdAt));
  // Full account numbers only for roles with "view full bank / account numbers".
  return maskForContext(ctx, rows);
}

/**
 * Open a new reconciliation session for a bank account.
 * Throws CONFLICT if there is already an in-progress session for this bank account.
 */
export async function startReconciliation(
  ctx: ServiceContext,
  input: StartReconciliationInput,
): Promise<typeof reconciliations.$inferSelect> {
  // The one-session-per-account check runs in the same transaction as the insert, so two starts
  // at once cannot open two in-progress sessions.
  return inTransaction(ctx, (tx) => startReconciliationInTx(tx, input));
}

async function startReconciliationInTx(
  ctx: ServiceContext,
  input: StartReconciliationInput,
): Promise<typeof reconciliations.$inferSelect> {
  if (!input.bankAccountId?.trim()) throw validation('bankAccountId is required.');
  if (!input.statementDate) throw validation('statementDate is required.');
  if (input.statementBalance == null) throw validation('statementBalance is required.');

  // Verify the bank account belongs to this company.
  const [bankAcct] = await ctx.db
    .select()
    .from(bankAccounts)
    .where(
      and(
        eq(bankAccounts.id, input.bankAccountId),
        eq(bankAccounts.companyId, ctx.companyId),
      ),
    );
  if (!bankAcct) throw notFound('Bank account');
  await assertReconciliationDateOpen(ctx, input.statementDate); // Accountant's Copy (I1)

  // Guard: only one in_progress reconciliation per bank account at a time.
  const [existing] = await ctx.db
    .select({ id: reconciliations.id })
    .from(reconciliations)
    .innerJoin(bankAccounts, eq(reconciliations.bankAccountId, bankAccounts.id))
    .where(
      and(
        eq(reconciliations.bankAccountId, input.bankAccountId),
        eq(bankAccounts.companyId, ctx.companyId),
        eq(reconciliations.status, 'in_progress'),
      ),
    );
  if (existing) {
    throw new ServiceError(
      'CONFLICT',
      `Bank account already has an in-progress reconciliation (id: ${existing.id}).`,
    );
  }

  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .insert(reconciliations)
      .values({
        bankAccountId: input.bankAccountId,
        statementDate: input.statementDate,
        statementBalance: toAmountString(input.statementBalance),
        status: 'in_progress',
        createdBy: tx.userId ?? '00000000-0000-0000-0000-000000000000',
      })
      .returning();

    await writeAudit(tx, {
      action: 'create',
      entityType: 'reconciliation',
      entityId: row.id,
      newValues: {
        bankAccountId: input.bankAccountId,
        statementDate: input.statementDate,
        statementBalance: toAmountString(input.statementBalance),
      },
    });

    return row;
  });
}

/**
 * List all posted journal entry lines on the bank account's GL account that
 * occurred on or before `asOf` and have not yet been cleared in any *completed*
 * reconciliation. Lines cleared in the current in-progress session are included
 * (with isCleared = true) so the UI can show their current toggle state.
 *
 * @param reconciliationId  Optional: when provided, isCleared reflects the
 *                          current session's state.  Without it every line shows
 *                          isCleared = false.
 */
export async function listClearable(
  ctx: ServiceContext,
  bankAccountId: string,
  asOf: Date,
  reconciliationId?: string,
): Promise<ClearableLine[]> {
  // Verify bank account belongs to this company.
  const [bankAcct] = await ctx.db
    .select({ accountId: bankAccounts.accountId, companyId: bankAccounts.companyId })
    .from(bankAccounts)
    .where(
      and(
        eq(bankAccounts.id, bankAccountId),
        eq(bankAccounts.companyId, ctx.companyId),
      ),
    );
  if (!bankAcct) throw notFound('Bank account');

  const glAccountId = bankAcct.accountId;
  const foreign = !!(await foreignCurrencyOfAccount(ctx, glAccountId));

  // Fetch all posted lines on the GL account up to asOf that are not yet
  // permanently cleared (i.e. cleared in a completed reconciliation).
  //
  // A line is "permanently cleared" when a reconciliation_items row exists for it
  // pointing to a completed reconciliation.  We exclude those from the list.
  const rows = await ctx.db
    .select({
      journalEntryLineId: journalEntryLines.id,
      journalEntryId: journalEntryLines.journalEntryId,
      date: journalEntries.date,
      description: journalEntries.description,
      debit: accountDebitSql(foreign),
      credit: accountCreditSql(foreign),
      homeDebit: journalEntryLines.debit,
      homeCredit: journalEntryLines.credit,
      memo: journalEntryLines.memo,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(journalEntryLines.accountId, glAccountId),
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        ne(journalEntries.status, 'void'),
        // Whole statement day: entries carrying a time of day belong to their own day.
        onOrBeforeDay(asOf),
      ),
    );

  // If a reconciliationId is given, fetch the current session's cleared state.
  const clearedSet = new Set<string>();
  if (reconciliationId) {
    const sessionItems = await ctx.db
      .select({ lineId: reconciliationItems.journalEntryLineId })
      .from(reconciliationItems)
      .where(
        and(
          eq(reconciliationItems.reconciliationId, reconciliationId),
          eq(reconciliationItems.isCleared, true),
        ),
      );
    for (const si of sessionItems) clearedSet.add(si.lineId);
  }

  // Identify lines permanently cleared by a *completed* reconciliation so we
  // can omit them (they are already reconciled and should not appear again).
  const lineIds = rows.map((r) => r.journalEntryLineId);
  const permanentlyClearedIds = new Set<string>();
  if (lineIds.length > 0) {
    const completed = await ctx.db
      .select({ lineId: reconciliationItems.journalEntryLineId })
      .from(reconciliationItems)
      .innerJoin(
        reconciliations,
        eq(reconciliationItems.reconciliationId, reconciliations.id),
      )
      .where(
        and(
          // Scope to the lines under consideration — without this the query is an
          // unbounded cross-company scan of every cleared item ever recorded.
          inArray(reconciliationItems.journalEntryLineId, lineIds),
          eq(reconciliations.status, 'completed'),
          eq(reconciliationItems.isCleared, true),
        ),
      );
    for (const c of completed) permanentlyClearedIds.add(c.lineId);
  }

  return rows
    .filter((r) => !permanentlyClearedIds.has(r.journalEntryLineId))
    // A Home Currency Adjustment line changes only the home value of a foreign account — it is
    // never on the bank's statement, so it is not offered for clearing (p1 fx).
    .filter((r) => !foreign || nz(r.debit) != null || nz(r.credit) != null)
    .map((r) => ({
      journalEntryLineId: r.journalEntryLineId,
      journalEntryId: r.journalEntryId,
      date: r.date,
      description: r.description,
      debit: foreign ? nz(r.debit) : r.debit,
      credit: foreign ? nz(r.credit) : r.credit,
      memo: r.memo,
      isCleared: clearedSet.has(r.journalEntryLineId),
      homeDebit: r.homeDebit,
      homeCredit: r.homeCredit,
    }));
}

/**
 * Mark or un-mark a journal entry line as cleared within a reconciliation session.
 * Uses an upsert so calling with isCleared=true twice is idempotent.
 */
export async function toggleCleared(
  ctx: ServiceContext,
  reconciliationId: string,
  journalEntryLineId: string,
  isCleared: boolean,
): Promise<void> {
  // Check-then-insert in one transaction: two clicks at once must not insert two rows for the
  // same line (each would count toward the cleared balance).
  return inTransaction(ctx, (tx) => toggleClearedInTx(tx, reconciliationId, journalEntryLineId, isCleared));
}

async function toggleClearedInTx(
  ctx: ServiceContext,
  reconciliationId: string,
  journalEntryLineId: string,
  isCleared: boolean,
): Promise<void> {
  const recon = await loadReconciliation(ctx, reconciliationId);
  if (recon.status !== 'in_progress') {
    throw validation('Cannot modify a reconciliation that is not in_progress.');
  }

  // Verify the journal entry line is on the correct bank GL account and
  // belongs to this company.
  const [line] = await ctx.db
    .select({
      id: journalEntryLines.id,
      accountId: journalEntryLines.accountId,
      companyId: journalEntries.companyId,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(journalEntryLines.id, journalEntryLineId),
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntryLines.accountId, recon.glAccountId),
      ),
    );
  if (!line) throw notFound('Journal entry line');

  // Manual upsert: check for an existing row and INSERT or UPDATE accordingly.
  // We cannot use onConflictDoUpdate because reconciliation_items does not define
  // a named UNIQUE constraint in the Drizzle schema (schema.ts is read-only), and
  // PGlite rejects ON CONFLICT on ad-hoc column lists without an underlying index.
  const [existing] = await ctx.db
    .select({ id: reconciliationItems.id })
    .from(reconciliationItems)
    .where(
      and(
        eq(reconciliationItems.reconciliationId, reconciliationId),
        eq(reconciliationItems.journalEntryLineId, journalEntryLineId),
      ),
    );

  if (existing) {
    // Every row for the line (a file may still hold a duplicate written before this check ran
    // in a transaction), so the toggle never leaves a stale cleared copy behind.
    await ctx.db
      .update(reconciliationItems)
      .set({ isCleared, clearedDate: isCleared ? new Date() : null })
      .where(
        and(
          eq(reconciliationItems.reconciliationId, reconciliationId),
          eq(reconciliationItems.journalEntryLineId, journalEntryLineId),
        ),
      );
  } else {
    await ctx.db.insert(reconciliationItems).values({
      reconciliationId,
      journalEntryLineId,
      isCleared,
      clearedDate: isCleared ? new Date() : null,
    });
  }
}

/**
 * Return the current reconciliation progress: statement balance, cleared balance,
 * and the difference that must reach 0.00 to complete.
 */
export async function getProgress(
  ctx: ServiceContext,
  reconciliationId: string,
): Promise<ReconciliationProgress> {
  const recon = await loadReconciliation(ctx, reconciliationId);
  const clearedBalance = await computeClearedBalance(ctx, reconciliationId);
  const statementBalance = Money.of(recon.statementBalance);
  const difference = statementBalance.minus(clearedBalance);

  return {
    reconciliationId,
    statementBalance: toAmountString(statementBalance),
    clearedBalance: toAmountString(clearedBalance),
    difference: toAmountString(difference),
  };
}

/**
 * Cancel (abandon) an in-progress reconciliation session.
 *
 * Hard-deletes the session's reconciliation_items and the reconciliations row
 * itself, so the cleared toggles from this session are discarded and the bank
 * account can start a fresh session. Only in_progress sessions can be cancelled —
 * completed reconciliations are permanent.
 */
export async function cancelReconciliation(
  ctx: ServiceContext,
  reconciliationId: string,
): Promise<void> {
  // Status check + delete in one transaction: a cancel racing the completion must not delete a
  // session that was just completed.
  await inTransaction(ctx, (tx) => cancelReconciliationInTx(tx, reconciliationId));
}

async function cancelReconciliationInTx(ctx: ServiceContext, reconciliationId: string): Promise<void> {
  const recon = await loadReconciliation(ctx, reconciliationId);
  if (recon.status !== 'in_progress') {
    throw validation(`Only an in-progress reconciliation can be cancelled (status: ${recon.status}).`);
  }

  await inTransaction(ctx, async (tx) => {
    await tx.db
      .delete(reconciliationItems)
      .where(eq(reconciliationItems.reconciliationId, reconciliationId));
    await tx.db.delete(reconciliations).where(eq(reconciliations.id, reconciliationId));

    await writeAudit(tx, {
      action: 'delete',
      entityType: 'reconciliation',
      entityId: reconciliationId,
      oldValues: {
        status: 'in_progress',
        bankAccountId: recon.bankAccountId,
        statementDate: recon.statementDate,
        statementBalance: recon.statementBalance,
      },
      newValues: { cancelled: true },
    });
  });
}

export interface UpdateStatementInput {
  statementBalance?: string | number;
  statementDate?: Date;
}

/**
 * Correct the statement balance and/or statement date of an in-progress
 * reconciliation (e.g. the user mistyped the ending balance when starting).
 */
export async function updateStatement(
  ctx: ServiceContext,
  reconciliationId: string,
  input: UpdateStatementInput,
): Promise<typeof reconciliations.$inferSelect> {
  const recon = await loadReconciliation(ctx, reconciliationId);
  if (recon.status !== 'in_progress') {
    throw validation('Cannot modify a reconciliation that is not in_progress.');
  }
  if (input.statementBalance == null && !input.statementDate) {
    throw validation('Provide statementBalance and/or statementDate to update.');
  }
  await assertReconciliationDateOpen(ctx, input.statementDate ?? recon.statementDate); // Accountant's Copy (I1)

  return inTransaction(ctx, async (tx) => {
    const [updated] = await tx.db
      .update(reconciliations)
      .set({
        ...(input.statementBalance != null
          ? { statementBalance: toAmountString(input.statementBalance) }
          : {}),
        ...(input.statementDate ? { statementDate: input.statementDate } : {}),
      })
      .where(eq(reconciliations.id, reconciliationId))
      .returning();

    await writeAudit(tx, {
      action: 'update',
      entityType: 'reconciliation',
      entityId: reconciliationId,
      oldValues: {
        statementBalance: recon.statementBalance,
        statementDate: recon.statementDate,
      },
      newValues: {
        statementBalance: updated.statementBalance,
        statementDate: updated.statementDate,
      },
    });

    return updated;
  });
}

/**
 * Finalize the reconciliation.
 *
 * Requirements:
 *   - Status must be in_progress.
 *   - |difference| ≤ $0.01 (one cent tolerance for rounding).
 *
 * On success:
 *   - reconciliations row is set to status = 'completed', completedAt = now.
 *   - bankAccounts.lastReconciledDate and lastReconciledBalance are updated.
 */
export async function completeReconciliation(
  ctx: ServiceContext,
  reconciliationId: string,
): Promise<typeof reconciliations.$inferSelect> {
  // Status check, cleared balance and completion in one transaction: a completion racing a
  // cancel (or another completion) sees the session's current state.
  return inTransaction(ctx, (tx) => completeReconciliationInTx(tx, reconciliationId));
}

async function completeReconciliationInTx(
  ctx: ServiceContext,
  reconciliationId: string,
): Promise<typeof reconciliations.$inferSelect> {
  const recon = await loadReconciliation(ctx, reconciliationId);

  if (recon.status !== 'in_progress') {
    throw validation(`Reconciliation is already ${recon.status}.`);
  }
  await assertReconciliationDateOpen(ctx, recon.statementDate); // Accountant's Copy (I1)

  const clearedBalance = await computeClearedBalance(ctx, reconciliationId);
  const statementBalance = Money.of(recon.statementBalance);
  const difference = statementBalance.minus(clearedBalance).abs();

  if (!Money.equalWithinCent(difference, Money.zero())) {
    throw new ServiceError(
      'VALIDATION',
      `Cannot complete: difference is ${toAmountString(statementBalance.minus(clearedBalance))}. ` +
        `Statement balance ${toAmountString(statementBalance)} ≠ cleared balance ${toAmountString(clearedBalance)}.`,
      {
        statementBalance: toAmountString(statementBalance),
        clearedBalance: toAmountString(clearedBalance),
        difference: toAmountString(statementBalance.minus(clearedBalance)),
      },
    );
  }

  return inTransaction(ctx, async (tx) => {
    const now = new Date();

    // A line cleared in this session whose entry was voided before completion was never part of
    // the reconciled balance (computeClearedBalance skips it) — un-clear it, so the completed
    // session's report and the discrepancy report don't count it as reconciled-then-voided.
    const voidedCleared = await tx.db
      .select({ id: reconciliationItems.id })
      .from(reconciliationItems)
      .innerJoin(journalEntryLines, eq(reconciliationItems.journalEntryLineId, journalEntryLines.id))
      .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
      .where(
        and(
          eq(reconciliationItems.reconciliationId, reconciliationId),
          eq(reconciliationItems.isCleared, true),
          ne(journalEntries.status, 'posted'),
        ),
      );
    if (voidedCleared.length) {
      await tx.db
        .update(reconciliationItems)
        .set({ isCleared: false, clearedDate: null })
        .where(inArray(reconciliationItems.id, voidedCleared.map((r) => r.id)));
    }

    const [updated] = await tx.db
      .update(reconciliations)
      .set({
        status: 'completed',
        reconciledBalance: toAmountString(clearedBalance),
        completedAt: now,
      })
      .where(eq(reconciliations.id, reconciliationId))
      .returning();

    // Stamp the bank account with the last-reconciled metadata.
    await tx.db
      .update(bankAccounts)
      .set({
        lastReconciledDate: recon.statementDate,
        lastReconciledBalance: toAmountString(statementBalance),
        updatedAt: now,
      })
      .where(eq(bankAccounts.id, recon.bankAccountId));

    await writeAudit(tx, {
      action: 'update',
      entityType: 'reconciliation',
      entityId: reconciliationId,
      oldValues: { status: 'in_progress' },
      newValues: {
        status: 'completed',
        reconciledBalance: toAmountString(clearedBalance),
        completedAt: now,
      },
    });

    return updated;
  });
}

// ===========================================================================
// Reconciliation completion features:
//   - getReconcileInfo        — beginning balance + discrepancy detection
//   - addStatementAdjustments — service charge / interest earned (auto-cleared)
//   - undoLastReconciliation  — revert the most recent completed session
//   - getReconciliationReport — summary + detail + per-session discrepancies
//   - reconciliationDiscrepancies — company-wide voided-after-reconcile report
//   - payCreditCardBalance    — pay a credit card after reconciling it
// ===========================================================================

/** Natural-side amount of a GL line in statement terms (asset: Dr−Cr, liability: Cr−Dr). */
function naturalAmount(
  glType: string | null,
  debit: string | null,
  credit: string | null,
) {
  const d = Money.of(debit);
  const c = Money.of(credit);
  return glType === 'liability' ? c.minus(d) : d.minus(c);
}

export interface ReconcileInfo {
  bankAccountId: string;
  bankName: string;
  accountNumber: string;
  glAccountId: string;
  glAccountName: string;
  glAccountCode: string;
  glType: string;
  /** True when the linked GL account is a liability (credit card) account. */
  isCreditCard: boolean;
  lastReconciledDate: Date | null;
  /** Carried-forward beginning balance (last statement balance; "0.00" when never reconciled). */
  beginningBalance: string;
  /** Beginning balance recomputed from still-posted cleared items of completed sessions. */
  recomputedBalance: string;
  /** beginningBalance − recomputedBalance. Non-zero ⇒ a reconciled transaction was voided/changed. */
  discrepancy: string;
  /** p1 fx: the account's currency (null = home); all balances above are in it. */
  currency?: string | null;
  homeCurrency?: string | null;
}

/**
 * Begin-Reconciliation info for a bank account: the carried-forward beginning
 * balance, the last reconciled date, and a beginning-balance discrepancy check
 * (the QB "Locate Discrepancies" detection). The discrepancy compares the
 * stamped lastReconciledBalance against the sum of cleared items from completed
 * sessions whose journal entries are still posted — if a reconciled transaction
 * was voided (historically, before posting.ts gained its guard), they differ.
 */
export async function getReconcileInfo(
  ctx: ServiceContext,
  bankAccountId: string,
): Promise<ReconcileInfo> {
  const [ba] = await ctx.db
    .select({
      id: bankAccounts.id,
      bankName: bankAccounts.bankName,
      accountNumber: bankAccounts.accountNumber,
      lastReconciledDate: bankAccounts.lastReconciledDate,
      lastReconciledBalance: bankAccounts.lastReconciledBalance,
      glAccountId: bankAccounts.accountId,
      glAccountName: accounts.name,
      glAccountCode: accounts.code,
      glType: accounts.type,
    })
    .from(bankAccounts)
    .innerJoin(accounts, eq(bankAccounts.accountId, accounts.id))
    .where(
      and(eq(bankAccounts.id, bankAccountId), eq(bankAccounts.companyId, ctx.companyId)),
    );
  if (!ba) throw notFound('Bank account');
  const currency = await foreignCurrencyOfAccount(ctx, ba.glAccountId);
  const foreign = !!currency;

  // Recompute the cleared balance from completed sessions, counting only lines
  // whose journal entry is still 'posted' (voided lines drop out — that is the
  // discrepancy we are detecting).
  const rows = await ctx.db
    .select({
      debit: accountDebitSql(foreign),
      credit: accountCreditSql(foreign),
      jeStatus: journalEntries.status,
    })
    .from(reconciliationItems)
    .innerJoin(reconciliations, eq(reconciliationItems.reconciliationId, reconciliations.id))
    .innerJoin(journalEntryLines, eq(reconciliationItems.journalEntryLineId, journalEntryLines.id))
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(reconciliations.bankAccountId, bankAccountId),
        eq(reconciliations.status, 'completed'),
        eq(reconciliationItems.isCleared, true),
      ),
    );

  let recomputed = Money.zero();
  for (const r of rows) {
    if (r.jeStatus !== 'posted') continue;
    recomputed = recomputed.plus(naturalAmount(ba.glType, r.debit, r.credit));
  }

  const beginning = Money.of(ba.lastReconciledBalance ?? 0);

  return {
    bankAccountId: ba.id,
    bankName: ba.bankName,
    accountNumber: accountNumberFor(ctx, ba.accountNumber),
    glAccountId: ba.glAccountId,
    glAccountName: ba.glAccountName,
    glAccountCode: ba.glAccountCode,
    glType: ba.glType,
    isCreditCard: ba.glType === 'liability',
    lastReconciledDate: ba.lastReconciledDate,
    beginningBalance: toAmountString(beginning),
    recomputedBalance: toAmountString(recomputed),
    discrepancy: toAmountString(beginning.minus(recomputed)),
    currency,
    homeCurrency: await homeCode(ctx),
  };
}

export interface StatementAdjustmentsInput {
  /** Bank fee on the statement: Dr expense / Cr bank, dated the statement date. */
  serviceCharge?: { amount: string | number; accountId: string } | null;
  /** Interest the bank paid: Dr bank / Cr income, dated the statement date. */
  interestEarned?: { amount: string | number; accountId: string } | null;
  /** p1 fx: foreign-currency account — home units per 1 unit (default: the currency list's rate). */
  exchangeRate?: string | number | null;
}

/** Insert an auto-cleared reconciliation item for the bank-side line of a new entry. */
async function autoClearBankLine(
  ctx: ServiceContext,
  reconciliationId: string,
  journalEntryId: string,
  glAccountId: string,
): Promise<void> {
  const [line] = await ctx.db
    .select({ id: journalEntryLines.id })
    .from(journalEntryLines)
    .where(
      and(
        eq(journalEntryLines.journalEntryId, journalEntryId),
        eq(journalEntryLines.accountId, glAccountId),
      ),
    );
  if (!line) throw notFound('Bank journal entry line');
  await ctx.db.insert(reconciliationItems).values({
    reconciliationId,
    journalEntryLineId: line.id,
    isCleared: true,
    clearedDate: new Date(),
  });
}

/**
 * Record statement-only adjustments (bank service charge and/or interest earned)
 * during an in-progress reconciliation. Each adjustment posts a journal entry
 * dated the statement date (sourceRef "reconciliation:<id>") and its bank-side
 * line is automatically cleared into the current session, so the reconciliation
 * still balances against the statement.
 *
 * Sign note: the same posting works for credit-card (liability) accounts — a
 * finance charge credits the CC account, increasing the amount owed, which is
 * how it appears on the card statement.
 */
export async function addStatementAdjustments(
  ctx: ServiceContext,
  reconciliationId: string,
  input: StatementAdjustmentsInput,
): Promise<ReconciliationProgress> {
  const recon = await loadReconciliation(ctx, reconciliationId);
  if (recon.status !== 'in_progress') {
    throw validation('Adjustments can only be added to an in-progress reconciliation.');
  }
  if (!input.serviceCharge && !input.interestEarned) {
    throw validation('Provide a service charge and/or interest earned amount.');
  }
  // p1 fx: on a foreign-currency account the statement amounts are in the account's currency;
  // post their home value at the stated rate (else the currency list's rate).
  const adjCurrency = await foreignCurrencyOfAccount(ctx, recon.glAccountId);
  const adjFx = adjCurrency ? await currencyRate(ctx, adjCurrency, input.exchangeRate) : null;
  const homeOf = (amtStr: string) => (adjFx ? toAmountString(toHome(amtStr, adjFx.rate)) : amtStr);
  const fxEntry = adjFx ? { currency: adjFx.currency, exchangeRate: adjFx.rate.toFixed(8) } : {};

  if (input.serviceCharge) {
    const amt = Money.of(input.serviceCharge.amount);
    if (!amt.greaterThan(0)) throw validation('Service charge amount must be greater than zero.');
    if (!input.serviceCharge.accountId) {
      throw validation('serviceCharge.accountId (expense account) is required.');
    }
    const amtStr = toAmountString(amt);
    const homeStr = homeOf(amtStr);
    const entry = await postJournalEntry(ctx, {
      date: recon.statementDate,
      description: 'Bank service charge',
      sourceRef: `reconciliation:${reconciliationId}`,
      lines: [
        { accountId: input.serviceCharge.accountId, debit: homeStr },
        { accountId: recon.glAccountId, credit: homeStr, ...(adjFx ? { foreignAmount: amtStr } : {}) },
      ],
      ...fxEntry,
    });
    await autoClearBankLine(ctx, reconciliationId, entry.id, recon.glAccountId);
  }

  if (input.interestEarned) {
    const amt = Money.of(input.interestEarned.amount);
    if (!amt.greaterThan(0)) throw validation('Interest earned amount must be greater than zero.');
    if (!input.interestEarned.accountId) {
      throw validation('interestEarned.accountId (income account) is required.');
    }
    const amtStr = toAmountString(amt);
    const homeStr = homeOf(amtStr);
    const entry = await postJournalEntry(ctx, {
      date: recon.statementDate,
      description: 'Interest earned',
      sourceRef: `reconciliation:${reconciliationId}`,
      lines: [
        { accountId: recon.glAccountId, debit: homeStr, ...(adjFx ? { foreignAmount: amtStr } : {}) },
        { accountId: input.interestEarned.accountId, credit: homeStr },
      ],
      ...fxEntry,
    });
    await autoClearBankLine(ctx, reconciliationId, entry.id, recon.glAccountId);
  }

  return getProgress(ctx, reconciliationId);
}

/**
 * Undo the most recent COMPLETED reconciliation for a bank account
 * (QB Banking ▸ Reconcile ▸ Undo Last Reconciliation).
 *
 * - The session row is kept with status 'undone' (audit record; its items stay
 *   attached so the past-reconciliation report remains readable). Every query
 *   that treats items as "permanently cleared" filters on status = 'completed',
 *   so the lines become clearable again immediately.
 * - bankAccounts.lastReconciledDate/Balance roll back to the previous completed
 *   session's statement values, or null when there is none.
 *
 * Throws CONFLICT when an in-progress session exists (cancel it first) and
 * NOT_FOUND when the account has no completed reconciliation to undo.
 */
export async function undoLastReconciliation(
  ctx: ServiceContext,
  bankAccountId: string,
): Promise<typeof reconciliations.$inferSelect> {
  const [ba] = await ctx.db
    .select({ id: bankAccounts.id })
    .from(bankAccounts)
    .where(
      and(eq(bankAccounts.id, bankAccountId), eq(bankAccounts.companyId, ctx.companyId)),
    );
  if (!ba) throw notFound('Bank account');

  const [inProgress] = await ctx.db
    .select({ id: reconciliations.id })
    .from(reconciliations)
    .where(
      and(
        eq(reconciliations.bankAccountId, bankAccountId),
        eq(reconciliations.status, 'in_progress'),
      ),
    );
  if (inProgress) {
    throw new ServiceError(
      'CONFLICT',
      'Cancel the in-progress reconciliation before undoing the last completed one.',
    );
  }

  const completed = await ctx.db
    .select()
    .from(reconciliations)
    .where(
      and(
        eq(reconciliations.bankAccountId, bankAccountId),
        eq(reconciliations.status, 'completed'),
      ),
    )
    .orderBy(desc(reconciliations.completedAt))
    .limit(2);
  if (completed.length === 0) {
    throw notFound('Completed reconciliation');
  }
  const [latest, previous] = completed;
  await assertReconciliationDateOpen(ctx, latest.statementDate); // Accountant's Copy (I1)

  return inTransaction(ctx, async (tx) => {
    const now = new Date();

    const [undone] = await tx.db
      .update(reconciliations)
      .set({ status: 'undone' })
      .where(eq(reconciliations.id, latest.id))
      .returning();

    await tx.db
      .update(bankAccounts)
      .set({
        lastReconciledDate: previous?.statementDate ?? null,
        lastReconciledBalance: previous?.statementBalance ?? null,
        updatedAt: now,
      })
      .where(eq(bankAccounts.id, bankAccountId));

    await writeAudit(tx, {
      action: 'update',
      entityType: 'reconciliation',
      entityId: latest.id,
      oldValues: {
        status: 'completed',
        statementDate: latest.statementDate,
        statementBalance: latest.statementBalance,
        reconciledBalance: latest.reconciledBalance,
      },
      newValues: {
        status: 'undone',
        restoredLastReconciledDate: previous?.statementDate ?? null,
        restoredLastReconciledBalance: previous?.statementBalance ?? null,
      },
    });

    return undone;
  });
}

export interface ReconciliationReportLine {
  lineId: string;
  journalEntryId: string;
  entryNumber: number;
  date: Date;
  description: string;
  memo: string | null;
  debit: string | null;
  credit: string | null;
  /** Natural-side signed amount in statement terms (positive = increases the statement balance). */
  amount: string;
  /** True when the journal entry was voided AFTER being cleared — a discrepancy. */
  isVoided: boolean;
}

export interface ReconciliationReport {
  id: string;
  bankAccountId: string;
  bankName: string;
  accountNumber: string;
  glAccountName: string;
  glAccountCode: string;
  glType: string;
  status: string;
  statementDate: Date;
  statementBalance: string;
  reconciledBalance: string | null;
  createdAt: Date;
  completedAt: Date | null;
  /** Statement balance of the previous completed session ("0.00" for the first). */
  beginningBalance: string;
  /** Net cleared movement this session (sum of natural-side amounts). */
  clearedTotal: string;
  /** beginningBalance + clearedTotal. */
  clearedBalance: string;
  /** statementBalance − clearedBalance. */
  difference: string;
  /** Money-in lines (deposits/credits for a bank; charges for a credit card). */
  depositsCount: number;
  depositsTotal: string;
  /** Money-out lines (checks/payments for a bank; payments/credits for a credit card). */
  paymentsCount: number;
  paymentsTotal: string;
  lines: ReconciliationReportLine[];
  /** Cleared lines whose journal entry is now void (reconciliation discrepancies). */
  discrepancies: ReconciliationReportLine[];
  /** p1 fx: the account's currency (null = home); every amount above is in it. */
  currency?: string | null;
}

/**
 * Full report for one reconciliation session: summary numbers + the cleared
 * transaction detail + discrepancies (cleared lines whose journal entry has
 * since been voided). Works for completed, undone, and in-progress sessions.
 */
export async function getReconciliationReport(
  ctx: ServiceContext,
  reconciliationId: string,
): Promise<ReconciliationReport> {
  const recon = await loadReconciliation(ctx, reconciliationId);

  const [meta] = await ctx.db
    .select({
      bankName: bankAccounts.bankName,
      accountNumber: bankAccounts.accountNumber,
      glAccountName: accounts.name,
      glAccountCode: accounts.code,
      glType: accounts.type,
    })
    .from(bankAccounts)
    .innerJoin(accounts, eq(bankAccounts.accountId, accounts.id))
    .where(eq(bankAccounts.id, recon.bankAccountId));
  if (!meta) throw notFound('Bank account');
  const reportCurrency = await foreignCurrencyOfAccount(ctx, recon.glAccountId);
  const reportForeign = !!reportCurrency;

  // Beginning balance = statement balance of the previous completed session
  // (the session completed immediately before this one).
  const anchor = recon.completedAt ?? new Date();
  const [prev] = await ctx.db
    .select({ statementBalance: reconciliations.statementBalance })
    .from(reconciliations)
    .where(
      and(
        eq(reconciliations.bankAccountId, recon.bankAccountId),
        eq(reconciliations.status, 'completed'),
        ne(reconciliations.id, recon.id),
        lt(reconciliations.completedAt, anchor),
      ),
    )
    .orderBy(desc(reconciliations.completedAt))
    .limit(1);
  const beginning = Money.of(prev?.statementBalance ?? 0);

  // Cleared lines for this session.
  const rows = await ctx.db
    .select({
      lineId: journalEntryLines.id,
      journalEntryId: journalEntryLines.journalEntryId,
      entryNumber: journalEntries.entryNumber,
      date: journalEntries.date,
      description: journalEntries.description,
      memo: journalEntryLines.memo,
      debit: accountDebitSql(reportForeign),
      credit: accountCreditSql(reportForeign),
      jeStatus: journalEntries.status,
    })
    .from(reconciliationItems)
    .innerJoin(journalEntryLines, eq(reconciliationItems.journalEntryLineId, journalEntryLines.id))
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(reconciliationItems.reconciliationId, reconciliationId),
        eq(reconciliationItems.isCleared, true),
      ),
    );

  rows.sort((a, b) => a.date.getTime() - b.date.getTime() || a.entryNumber - b.entryNumber);

  let clearedTotal = Money.zero();
  let depositsTotal = Money.zero();
  let paymentsTotal = Money.zero();
  let depositsCount = 0;
  let paymentsCount = 0;

  // An in-progress session counts only still-posted lines (as getProgress / complete do); a
  // completed session reports what was reconciled, flagging later-voided legacy lines.
  const countVoided = recon.status !== 'in_progress';
  const lines: ReconciliationReportLine[] = rows.map((r) => {
    const amount = naturalAmount(meta.glType, r.debit, r.credit);
    if (r.jeStatus === 'posted' || countVoided) {
      clearedTotal = clearedTotal.plus(amount);
      if (amount.greaterThanOrEqualTo(0)) {
        depositsCount += 1;
        depositsTotal = depositsTotal.plus(amount);
      } else {
        paymentsCount += 1;
        paymentsTotal = paymentsTotal.plus(amount.abs());
      }
    }
    return {
      lineId: r.lineId,
      journalEntryId: r.journalEntryId,
      entryNumber: r.entryNumber,
      date: r.date,
      description: r.description,
      memo: r.memo,
      debit: r.debit,
      credit: r.credit,
      amount: toAmountString(amount),
      isVoided: r.jeStatus === 'void',
    };
  });

  const clearedBalance = beginning.plus(clearedTotal);
  const statementBalance = Money.of(recon.statementBalance);

  return {
    id: recon.id,
    bankAccountId: recon.bankAccountId,
    bankName: meta.bankName,
    accountNumber: accountNumberFor(ctx, meta.accountNumber),
    glAccountName: meta.glAccountName,
    glAccountCode: meta.glAccountCode,
    glType: meta.glType,
    status: recon.status,
    statementDate: recon.statementDate,
    statementBalance: toAmountString(statementBalance),
    reconciledBalance: recon.reconciledBalance,
    createdAt: recon.createdAt,
    completedAt: recon.completedAt,
    beginningBalance: toAmountString(beginning),
    clearedTotal: toAmountString(clearedTotal),
    clearedBalance: toAmountString(clearedBalance),
    difference: toAmountString(statementBalance.minus(clearedBalance)),
    depositsCount,
    depositsTotal: toAmountString(depositsTotal),
    paymentsCount,
    paymentsTotal: toAmountString(paymentsTotal),
    lines,
    discrepancies: lines.filter((l) => l.isVoided),
    currency: reportCurrency,
  };
}

export interface DiscrepancyRow {
  reconciliationId: string;
  statementDate: Date;
  bankAccountId: string;
  bankName: string;
  accountNumber: string;
  journalEntryId: string;
  entryNumber: number;
  date: Date;
  description: string;
  debit: string | null;
  credit: string | null;
  /** Natural-side signed amount that the void removed from the reconciled balance. */
  amount: string;
  voidedAt: Date | null;
}

/**
 * Reconciliation Discrepancy report: every line that was cleared in a COMPLETED
 * reconciliation but whose journal entry is now void (i.e. it was voided after
 * being reconciled — possible historically, before posting.ts gained its guard).
 * Optionally filtered to one bank account.
 */
export async function reconciliationDiscrepancies(
  ctx: ServiceContext,
  bankAccountId?: string,
): Promise<DiscrepancyRow[]> {
  const conditions = [
    eq(bankAccounts.companyId, ctx.companyId),
    eq(reconciliations.status, 'completed'),
    eq(reconciliationItems.isCleared, true),
    eq(journalEntries.status, 'void'),
  ];
  if (bankAccountId) conditions.push(eq(reconciliations.bankAccountId, bankAccountId));

  const rows = await ctx.db
    .select({
      reconciliationId: reconciliations.id,
      statementDate: reconciliations.statementDate,
      bankAccountId: bankAccounts.id,
      bankName: bankAccounts.bankName,
      accountNumber: bankAccounts.accountNumber,
      glType: accounts.type,
      journalEntryId: journalEntries.id,
      entryNumber: journalEntries.entryNumber,
      date: journalEntries.date,
      description: journalEntries.description,
      // p1 fx: in the account's own currency for a foreign-currency account (as reconciled).
      debit: sql<string | null>`CASE WHEN ${accounts.currency} IS NOT NULL AND ${journalEntryLines.debit} IS NOT NULL THEN COALESCE(${journalEntryLines.foreignAmount}, ${journalEntryLines.debit}) ELSE ${journalEntryLines.debit} END`,
      credit: sql<string | null>`CASE WHEN ${accounts.currency} IS NOT NULL AND ${journalEntryLines.credit} IS NOT NULL THEN COALESCE(${journalEntryLines.foreignAmount}, ${journalEntryLines.credit}) ELSE ${journalEntryLines.credit} END`,
      voidedAt: journalEntries.voidedAt,
    })
    .from(reconciliationItems)
    .innerJoin(reconciliations, eq(reconciliationItems.reconciliationId, reconciliations.id))
    .innerJoin(bankAccounts, eq(reconciliations.bankAccountId, bankAccounts.id))
    .innerJoin(accounts, eq(bankAccounts.accountId, accounts.id))
    .innerJoin(journalEntryLines, eq(reconciliationItems.journalEntryLineId, journalEntryLines.id))
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(...conditions))
    .orderBy(desc(reconciliations.statementDate));

  return rows.map((r) => ({
    reconciliationId: r.reconciliationId,
    statementDate: r.statementDate,
    bankAccountId: r.bankAccountId,
    bankName: r.bankName,
    accountNumber: accountNumberFor(ctx, r.accountNumber),
    journalEntryId: r.journalEntryId,
    entryNumber: r.entryNumber,
    date: r.date,
    description: r.description,
    debit: r.debit,
    credit: r.credit,
    amount: toAmountString(naturalAmount(r.glType, r.debit, r.credit)),
    voidedAt: r.voidedAt,
  }));
}

/**
 * Pay a foreign-currency credit card's statement balance (amount in the card's currency): the card
 * line carries that amount plus its home value at the stated / list rate; the payment account must
 * be in the card's currency or the home currency.
 */
async function payForeignCreditCard(
  ctx: ServiceContext,
  recon: { id: string; glAccountId: string; statementBalance: string },
  cardName: string,
  cardCurrency: string,
  input: PayCreditCardBalanceInput,
) {
  const amt = Money.round2(input.amount ?? recon.statementBalance);
  if (!amt.greaterThan(0)) throw validation('Payment amount must be greater than zero.');
  if (!input.paymentAccountId) throw validation('paymentAccountId is required.');
  if (input.paymentAccountId === recon.glAccountId) {
    throw validation('Payment account must be different from the credit card account.');
  }
  const [pay] = await ctx.db
    .select({ id: accounts.id, currency: accounts.currency, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, input.paymentAccountId)));
  if (!pay) throw notFound('Payment account');
  const home = await homeCode(ctx);
  const payCur = foreignCode(pay.currency, home);
  if (payCur && payCur !== cardCurrency) {
    throw validation(
      `"${pay.name}" is a ${payCur} account. Pay this ${cardCurrency} card from a ${cardCurrency} account or a home-currency account.`,
    );
  }
  const sourceRef = `cc-payment:${recon.id}`;
  const [existing] = await ctx.db
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.sourceRef, sourceRef),
        eq(journalEntries.status, 'posted'),
      ),
    );
  if (existing) {
    throw new ServiceError('CONFLICT', 'A credit card payment for this reconciliation has already been recorded.');
  }
  const fx = await currencyRate(ctx, cardCurrency, input.exchangeRate);
  const amtStr = toAmountString(amt);
  const homeStr = toAmountString(toHome(amt, fx.rate));
  if (!Money.gt(homeStr, 0)) throw validation('This amount is too small to convert to your home currency.');
  return postJournalEntry(ctx, {
    date: input.date ?? new Date(),
    description: input.memo?.trim() ? input.memo.trim() : `Credit card payment — ${cardName}`,
    sourceRef,
    currency: fx.currency,
    exchangeRate: fx.rate.toFixed(8),
    lines: [
      { accountId: recon.glAccountId, debit: homeStr, foreignAmount: amtStr },
      { accountId: input.paymentAccountId, credit: homeStr, ...(payCur ? { foreignAmount: amtStr } : {}) },
    ],
  });
}

export interface PayCreditCardBalanceInput {
  /** GL account (bank/checking asset) the payment is drawn from. */
  paymentAccountId: string;
  /** Defaults to the reconciliation's statement (ending) balance. */
  amount?: string | number;
  /** Defaults to today. */
  date?: Date;
  memo?: string | null;
  /** p1 fx: foreign-currency card — home units per 1 unit (default: the currency list's rate). */
  exchangeRate?: string | number | null;
}

/**
 * QB "Write a check for the balance" step after completing a credit-card
 * reconciliation: posts Dr CC liability / Cr bank for the statement balance via
 * payCreditCard (sourceRef "cc-payment:<reconciliationId>", duplicate-guarded).
 */
export async function payCreditCardBalance(
  ctx: ServiceContext,
  reconciliationId: string,
  input: PayCreditCardBalanceInput,
) {
  const recon = await loadReconciliation(ctx, reconciliationId);
  if (recon.status !== 'completed') {
    throw validation('Pay Credit Card is only available after the reconciliation is completed.');
  }

  const [gl] = await ctx.db
    .select({ type: accounts.type, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.id, recon.glAccountId), eq(accounts.companyId, ctx.companyId)));
  if (!gl) throw notFound('Credit card GL account');
  if (gl.type !== 'liability') {
    throw validation('This reconciliation is not for a credit card (liability) account.');
  }

  // p1 fx: a foreign-currency card's statement balance is in the card's currency.
  const cardCurrency = await foreignCurrencyOfAccount(ctx, recon.glAccountId);
  if (cardCurrency) return payForeignCreditCard(ctx, recon, gl.name, cardCurrency, input);

  return payCreditCard(ctx, {
    creditCardAccountId: recon.glAccountId,
    paymentAccountId: input.paymentAccountId,
    amount: input.amount ?? recon.statementBalance,
    date: input.date ?? new Date(),
    reconciliationId,
    memo: input.memo ?? `Credit card payment — ${gl.name}`,
  });
}
