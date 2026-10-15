/**
 * Shared rules for editing a SAVED purchase / banking document that already posted to the GL
 * (QB "edit any saved transaction" for checks, bill payments, vendor credits, deposits,
 * transfers, item receipts).
 *
 * The sanctioned edit pattern (the same one updateBill / updateInvoice use) is:
 *   void the document's journal entry (voidJournalEntry: closing date + reconciliation guards)
 *   -> rewrite the document -> post a fresh entry (postJournalEntry: closing date on the NEW date)
 * all inside ONE transaction, so the books are never observed half-edited.
 *
 * Two refinements live here:
 *  1. When the edit does not change the ledger at all (same date and the same multiset of
 *     account / debit / credit / class lines) the entry is left untouched and only the
 *     document header changes. That is what lets a user fix the memo or payee of a check that
 *     has already been cleared in a bank reconciliation.
 *     Even a ledger-neutral edit of a transaction dated on/before the closing date needs the
 *     closing-date password (QB: any change to a closed-period transaction), and is recorded on
 *     the Closing Date Exception report — see assertClosedPeriodEdit.
 *  2. A ledger-changing edit of an entry that has a line cleared in a COMPLETED reconciliation
 *     is refused up front with a plain-language message (QB warns; we block).
 */
import { and, eq, inArray } from 'drizzle-orm';
import {
  journalEntries,
  journalEntryLines,
  reconciliationItems,
  reconciliations,
} from '@/lib/db/schema';
import { Money } from '@/lib/money';
import { type ServiceContext, ServiceError } from './_base';
import type { PostingLine } from './posting';
import { assertPeriodOpen, recordClosingDateException } from './fiscalPeriods';

/** Canonical key of a posting line (2dp amounts, nulls normalised). */
function lineKey(l: {
  accountId: string;
  debit?: string | number | null;
  credit?: string | number | null;
  classId?: string | null;
}): string {
  const d = Money.round2(l.debit ?? 0);
  const c = Money.round2(l.credit ?? 0);
  return `${l.accountId}|${d.toFixed(2)}|${c.toFixed(2)}|${l.classId ?? ''}`;
}

/** True when two sets of posting lines are the same multiset (order-insensitive). */
export function sameLedgerLines(a: PostingLine[], b: PostingLine[]): boolean {
  if (a.length !== b.length) return false;
  const ka = a.map(lineKey).sort();
  const kb = b.map(lineKey).sort();
  return ka.every((k, i) => k === kb[i]);
}

function sameDay(a: Date, b: Date): boolean {
  return new Date(a).toISOString().slice(0, 10) === new Date(b).toISOString().slice(0, 10);
}

/** True when any line of the entry is cleared in a COMPLETED reconciliation. */
export async function entryHasReconciledLines(ctx: ServiceContext, entryId: string): Promise<boolean> {
  const lines = await ctx.db
    .select({ id: journalEntryLines.id })
    .from(journalEntryLines)
    .where(eq(journalEntryLines.journalEntryId, entryId));
  if (lines.length === 0) return false;
  const [hit] = await ctx.db
    .select({ id: reconciliationItems.id })
    .from(reconciliationItems)
    .innerJoin(reconciliations, eq(reconciliationItems.reconciliationId, reconciliations.id))
    .where(
      and(
        inArray(
          reconciliationItems.journalEntryLineId,
          lines.map((l) => l.id),
        ),
        eq(reconciliationItems.isCleared, true),
        eq(reconciliations.status, 'completed'),
      ),
    )
    .limit(1);
  return Boolean(hit);
}

export type EditPlan = 'unchanged' | 'repost';

/**
 * Decide how to apply an edit to a document whose GL entry is `entryId`:
 *  - 'unchanged' : the new posting is identical (same date + same lines) -> keep the entry.
 *  - 'repost'    : void + repost. Throws CONFLICT when the entry has reconciled lines.
 * A missing / already-void entry always means 'repost' (nothing to compare against).
 */
export async function planPostedEdit(
  ctx: ServiceContext,
  params: { entryId: string | null | undefined; date: Date; lines: PostingLine[]; what: string },
): Promise<EditPlan> {
  if (!params.entryId) return 'repost';
  const [entry] = await ctx.db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.id, params.entryId), eq(journalEntries.companyId, ctx.companyId)));
  if (!entry || entry.status !== 'posted') return 'repost';

  const old = await ctx.db
    .select()
    .from(journalEntryLines)
    .where(eq(journalEntryLines.journalEntryId, entry.id));
  const oldLines: PostingLine[] = old.map((l) => ({
    accountId: l.accountId,
    debit: l.debit,
    credit: l.credit,
    classId: l.classId,
  }));
  if (sameDay(entry.date, params.date) && sameLedgerLines(oldLines, params.lines)) {
    // The entry stays, so voidJournalEntry's period check never runs: check it here.
    await assertClosedPeriodEdit(ctx, { entryId: entry.id, what: params.what });
    return 'unchanged';
  }

  if (await entryHasReconciledLines(ctx, entry.id)) {
    throw new ServiceError(
      'CONFLICT',
      `This ${params.what} was cleared in a completed bank reconciliation, so its amount, accounts and date can't be changed. ` +
        'You can still change the memo, payee or number. To change the amount, undo that reconciliation first (Reconcile > Undo last reconciliation).',
    );
  }
  return 'repost';
}

/** Update an entry header's description/reference (allowed on posted entries). */
export async function retitleEntry(
  ctx: ServiceContext,
  entryId: string | null | undefined,
  patch: { description?: string; reference?: string | null },
): Promise<void> {
  if (!entryId) return;
  await ctx.db
    .update(journalEntries)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(journalEntries.id, entryId), eq(journalEntries.companyId, ctx.companyId)));
}

/**
 * Closing-date lock for an edit that keeps the posted journal entry (memo, payee, number,
 * customer:job, line description). QB requires the closing-date password for ANY change to a
 * transaction dated on/before the closing date, and lists it on the Closing Date Exception report.
 * Throws PERIOD_CLOSED without a valid password; records the exception when the password was used.
 * Call inside the edit's transaction.
 */
export async function assertClosedPeriodEdit(
  ctx: ServiceContext,
  params: { entryId: string | null | undefined; what: string; date?: Date },
): Promise<void> {
  let date = params.date;
  let entryNumber: number | null = null;
  let description: string | null = null;
  let sourceRef: string | null = null;
  let knownSource = false;
  if (params.entryId) {
    const [entry] = await ctx.db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.id, params.entryId), eq(journalEntries.companyId, ctx.companyId)));
    if (entry) {
      date = entry.date;
      entryNumber = entry.entryNumber ?? null;
      description = entry.description ?? null;
      sourceRef = entry.sourceRef ?? null;
      knownSource = true;
    }
  }
  if (!date) return;
  const check = await assertPeriodOpen(ctx, date, knownSource ? { sourceRef } : {});
  if (params.entryId) {
    await recordClosingDateException(ctx, check, {
      entryId: params.entryId,
      operation: 'edit',
      transactionDate: date,
      entryNumber,
      description: description ?? `Edited ${params.what}`,
      sourceRef,
    });
  }
}
