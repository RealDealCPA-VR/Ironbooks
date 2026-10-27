/**
 * Changing a transaction after it was reconciled (QB: "The transaction you are editing has been
 * reconciled. Changing it will make your next reconciliation not balance. Change it anyway?").
 *
 * QuickBooks lets you change the amount or account of a reconciled transaction after that
 * warning, keeps it reconciled at its new amount, and lists the change on the Previous
 * Reconciliation Discrepancy report (reconciled amount, type of change, effect of change). An edit
 * that changes the ledger voids the document's entry and posts a new one (postedEdit.ts), so here:
 *
 *  1. prepareReconciledRepost — before the old entry is voided. Finds its lines that are cleared in
 *     a COMPLETED reconciliation. When the edit keeps each such line exactly (same account and
 *     amount — e.g. only the expense account of a check changed) nothing is asked. Otherwise the
 *     edit needs the user's confirmation (`allowReconciledEdit`, the "Change it anyway" fix) or it
 *     is refused with the warning. It then records one 'pending' reconciliation_changes row per
 *     reconciled line, stamped with the current transaction id: that row is what lets
 *     posting.voidJournalEntry void this one entry (isReconciledRepostArmed). A rolled-back edit
 *     takes its rows with it, so nothing stays armed.
 *  2. carryReconciledLines — after the new entry is posted. Each reconciled line's mark moves to the
 *     new entry's line on the same bank / card account (the transaction stays reconciled in the
 *     same reconciliation). The row records the new amount and the effect; a line that left the
 *     account (moved to another bank) is a 'removed' change.
 *
 * The reconciled balance stays the statement balance (bankAccounts.lastReconciledBalance), so the
 * next reconciliation still starts where the bank statement does; the difference shows as the
 * beginning-balance discrepancy (reconcile.getReconcileInfo) and on the discrepancy report.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import {
  accounts,
  bankAccounts,
  journalEntries,
  journalEntryLines,
  reconciliationChanges,
  reconciliationItems,
  reconciliations,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, ServiceError } from './_base';
import type { PostingLine } from './posting';
import { foreignCode, homeCode } from './fxLines';

/** The fix the warning offers: save again with the confirmation flag. */
export function reconciledEditFixes() {
  return [
    {
      id: 'reconciled-edit-confirm',
      kind: 'retry' as const,
      label: 'Change it anyway',
      patch: [{ op: 'set' as const, path: 'allowReconciledEdit', value: true }],
      hint: 'The change is listed on the Previous Reconciliation Discrepancy report.',
    },
  ];
}

interface ReconciledLine {
  lineId: string;
  accountId: string;
  debit: string | null;
  credit: string | null;
  foreignAmount: string | null;
  reconciliationId: string;
  bankAccountId: string;
  glType: string;
  currency: string | null;
  date: Date;
  entryNumber: number | null;
  description: string | null;
  sourceRef: string | null;
}

async function reconciledLinesOf(ctx: ServiceContext, entryId: string): Promise<ReconciledLine[]> {
  return ctx.db
    .select({
      lineId: journalEntryLines.id,
      accountId: journalEntryLines.accountId,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
      foreignAmount: journalEntryLines.foreignAmount,
      reconciliationId: reconciliationItems.reconciliationId,
      bankAccountId: reconciliations.bankAccountId,
      glType: accounts.type,
      currency: accounts.currency,
      date: journalEntries.date,
      entryNumber: journalEntries.entryNumber,
      description: journalEntries.description,
      sourceRef: journalEntries.sourceRef,
    })
    .from(reconciliationItems)
    .innerJoin(reconciliations, eq(reconciliationItems.reconciliationId, reconciliations.id))
    .innerJoin(journalEntryLines, eq(reconciliationItems.journalEntryLineId, journalEntryLines.id))
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
    .where(
      and(
        eq(journalEntryLines.journalEntryId, entryId),
        eq(journalEntries.companyId, ctx.companyId),
        eq(reconciliationItems.isCleared, true),
        eq(reconciliations.status, 'completed'),
      ),
    );
}

/**
 * A line's amount in statement terms (bank / asset: money in +, money out -; card / liability:
 * charge +, payment -), in the account's own currency for a foreign-currency account (as reconciled).
 */
function statementAmount(
  l: { debit?: string | number | null; credit?: string | number | null; foreignAmount?: string | number | null },
  glType: string,
  foreign: boolean,
): Decimal {
  const d = Money.of(l.debit ?? 0);
  const c = Money.of(l.credit ?? 0);
  let debit = d;
  let credit = c;
  if (foreign && l.foreignAmount != null && String(l.foreignAmount).trim() !== '') {
    const f = Money.of(l.foreignAmount).abs();
    if (d.greaterThan(0)) debit = f;
    else credit = f;
  }
  return glType === 'liability' ? credit.minus(debit) : debit.minus(credit);
}

function sameSideAndAmount(
  a: { debit?: string | number | null; credit?: string | number | null },
  b: { debit?: string | number | null; credit?: string | number | null },
): boolean {
  return Money.round2(a.debit ?? 0).equals(Money.round2(b.debit ?? 0)) && Money.round2(a.credit ?? 0).equals(Money.round2(b.credit ?? 0));
}

/**
 * True when this transaction armed the void of `entryId` (prepareReconciledRepost ran for it in
 * the same database transaction). posting.voidJournalEntry lets such an entry go although it has
 * reconciled lines.
 */
export async function isReconciledRepostArmed(ctx: ServiceContext, entryId: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ id: reconciliationChanges.id })
    .from(reconciliationChanges)
    .where(
      and(
        eq(reconciliationChanges.companyId, ctx.companyId),
        eq(reconciliationChanges.oldEntryId, entryId),
        eq(reconciliationChanges.changeType, 'pending'),
        sql`${reconciliationChanges.txId} = txid_current()::text`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Call before voiding a document's entry to re-post it (see the module header). `lines` is the
 * posting the edit will make. Throws CONFLICT with the QB warning (details.reconciledEdit) when a
 * reconciled line changes and the user has not confirmed. No-op for an entry with no reconciled
 * lines, and when this transaction already prepared the entry.
 */
export async function prepareReconciledRepost(
  ctx: ServiceContext,
  params: {
    entryId: string | null | undefined;
    lines: ReadonlyArray<PostingLine>;
    what: string;
    allowReconciledEdit?: boolean | null;
  },
): Promise<void> {
  if (!params.entryId) return;
  const reconciled = await reconciledLinesOf(ctx, params.entryId);
  if (reconciled.length === 0) return;
  if (await isReconciledRepostArmed(ctx, params.entryId)) return;

  // Does the edit keep every reconciled line as it is (same account, same side and amount — in the
  // account's own currency too, for a foreign-currency account)?
  const home = await homeCode(ctx);
  const pool = [...params.lines];
  const preserved = reconciled.every((r) => {
    const foreign = !!foreignCode(r.currency, home);
    const i = pool.findIndex(
      (n) =>
        n.accountId === r.accountId &&
        sameSideAndAmount(n, r) &&
        (!foreign || statementAmount(n, r.glType, true).equals(statementAmount(r, r.glType, true))),
    );
    if (i < 0) return false;
    pool.splice(i, 1);
    return true;
  });
  if (!preserved && !params.allowReconciledEdit) {
    throw new ServiceError(
      'CONFLICT',
      `This ${params.what} has been reconciled. If you change its amount or account, the beginning balance of your next reconciliation won't match your bank statement, and the change is listed on the Previous Reconciliation Discrepancy report. Change it anyway?`,
      { reconciledEdit: true, entryId: params.entryId },
    ).withFixes(reconciledEditFixes());
  }

  await ctx.db.insert(reconciliationChanges).values(
    reconciled.map((r) => ({
      companyId: ctx.companyId,
      reconciliationId: r.reconciliationId,
      bankAccountId: r.bankAccountId,
      oldEntryId: params.entryId!,
      oldLineId: r.lineId,
      transactionDate: r.date,
      entryNumber: r.entryNumber,
      description: r.description,
      sourceRef: r.sourceRef ? r.sourceRef.slice(0, 100) : null,
      reconciledAmount: toAmountString(statementAmount(r, r.glType, !!foreignCode(r.currency, home))),
      changeType: 'pending',
      txId: sql<string>`txid_current()::text`,
      createdBy: ctx.userId,
    })),
  );
}

/**
 * Call after posting the edited document's new entry: moves the reconciled marks prepared for
 * `oldEntryId` onto `newEntryId`'s lines and records what changed. No-op when nothing was prepared.
 */
export async function carryReconciledLines(
  ctx: ServiceContext,
  params: { oldEntryId: string | null | undefined; newEntryId: string | null | undefined },
): Promise<void> {
  if (!params.oldEntryId) return;
  const pending = await ctx.db
    .select({
      id: reconciliationChanges.id,
      reconciliationId: reconciliationChanges.reconciliationId,
      bankAccountId: reconciliationChanges.bankAccountId,
      reconciledAmount: reconciliationChanges.reconciledAmount,
      glAccountId: bankAccounts.accountId,
      glType: accounts.type,
      currency: accounts.currency,
    })
    .from(reconciliationChanges)
    .innerJoin(bankAccounts, eq(reconciliationChanges.bankAccountId, bankAccounts.id))
    .innerJoin(accounts, eq(bankAccounts.accountId, accounts.id))
    .where(
      and(
        eq(reconciliationChanges.companyId, ctx.companyId),
        eq(reconciliationChanges.oldEntryId, params.oldEntryId),
        eq(reconciliationChanges.changeType, 'pending'),
        sql`${reconciliationChanges.txId} = txid_current()::text`,
      ),
    );
  if (pending.length === 0) return;
  const newLines = params.newEntryId
    ? await ctx.db
        .select({
          id: journalEntryLines.id,
          accountId: journalEntryLines.accountId,
          debit: journalEntryLines.debit,
          credit: journalEntryLines.credit,
          foreignAmount: journalEntryLines.foreignAmount,
        })
        .from(journalEntryLines)
        .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
        .where(and(eq(journalEntryLines.journalEntryId, params.newEntryId), eq(journalEntries.companyId, ctx.companyId)))
    : [];
  const home = await homeCode(ctx);
  const used = new Set<string>();
  for (const p of pending) {
    const foreign = !!foreignCode(p.currency, home);
    const old = Money.of(p.reconciledAmount);
    const candidates = newLines.filter((l) => l.accountId === p.glAccountId && !used.has(l.id));
    // Prefer the line on the same side (a check stays money out), then any line on the account.
    const match =
      candidates.find((l) => statementAmount(l, p.glType, foreign).isNegative() === old.isNegative()) ?? candidates[0];
    if (match) {
      used.add(match.id);
      const amount = statementAmount(match, p.glType, foreign);
      const effect = Money.round2(amount.minus(old));
      await ctx.db.insert(reconciliationItems).values({
        reconciliationId: p.reconciliationId,
        journalEntryLineId: match.id,
        isCleared: true,
        clearedDate: new Date(),
      });
      await ctx.db
        .update(reconciliationChanges)
        .set({
          newEntryId: params.newEntryId ?? null,
          newLineId: match.id,
          newAmount: toAmountString(amount),
          effect: toAmountString(effect),
          changeType: effect.isZero() ? 'unchanged' : 'amount',
          txId: null,
        })
        .where(eq(reconciliationChanges.id, p.id));
    } else {
      await ctx.db
        .update(reconciliationChanges)
        .set({
          newEntryId: params.newEntryId ?? null,
          newAmount: '0.00',
          effect: toAmountString(old.negated()),
          changeType: 'removed',
          txId: null,
        })
        .where(eq(reconciliationChanges.id, p.id));
    }
  }
}

/** Line ids of a reconciliation that were carried onto it by a later edit (not reconciled as such). */
export async function carriedLineIds(ctx: ServiceContext, reconciliationIds: string[]): Promise<Set<string>> {
  if (reconciliationIds.length === 0) return new Set();
  const rows = await ctx.db
    .select({ lineId: reconciliationChanges.newLineId })
    .from(reconciliationChanges)
    .where(
      and(
        eq(reconciliationChanges.companyId, ctx.companyId),
        inArray(reconciliationChanges.reconciliationId, reconciliationIds),
      ),
    );
  return new Set(rows.map((r) => r.lineId).filter((x): x is string => !!x));
}
