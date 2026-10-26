/**
 * Memo-only edits of a banking document that keeps its posted entry (team banking, review 5).
 *
 * A ledger-neutral edit (postedEdit.planPostedEdit → 'unchanged') leaves the journal entry in
 * place — that is what lets a reconciled transfer or deposit get a new memo — and only re-titled
 * its header. The entry's LINES kept their old memos, so the register's Memo column (and every
 * report that shows line memos) still showed the text from before the edit. This copies each new
 * line's memo onto the entry line it is identical to: same account, side, amount, class and name.
 * Only the memo changes, which the ledger guards allow on a posted entry.
 */
import { eq } from 'drizzle-orm';
import { journalEntryLines } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { ServiceContext } from './_base';
import type { PostingLine } from './posting';

function keyOf(l: {
  accountId: string;
  debit?: string | number | null;
  credit?: string | number | null;
  classId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
}): string {
  const entity = l.entityType ? `${l.entityType}:${l.entityId ?? ''}` : '';
  return `${l.accountId}|${Money.round2(l.debit ?? 0).toFixed(2)}|${Money.round2(l.credit ?? 0).toFixed(2)}|${l.classId ?? ''}|${entity}`;
}

/** Give the kept entry `entryId` the memos of `lines` (the posting the edit would have made). */
export async function syncLineMemos(
  ctx: ServiceContext,
  entryId: string | null | undefined,
  lines: ReadonlyArray<PostingLine>,
): Promise<void> {
  if (!entryId) return;
  const old = await ctx.db
    .select({
      id: journalEntryLines.id,
      accountId: journalEntryLines.accountId,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
      classId: journalEntryLines.classId,
      entityType: journalEntryLines.entityType,
      entityId: journalEntryLines.entityId,
      memo: journalEntryLines.memo,
    })
    .from(journalEntryLines)
    .where(eq(journalEntryLines.journalEntryId, entryId));
  const used = new Set<string>();
  for (const l of lines) {
    const key = keyOf(l);
    const match = old.find((o) => !used.has(o.id) && keyOf(o) === key);
    if (!match) continue;
    used.add(match.id);
    const memo = l.memo ?? null;
    if ((match.memo ?? null) !== memo) {
      await ctx.db.update(journalEntryLines).set({ memo }).where(eq(journalEntryLines.id, match.id));
    }
  }
}
