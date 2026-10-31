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

/**
 * Header-only edits whose new posting is not rebuilt (bill payments, item receipts): change the
 * memo of the kept entry's lines that still carry the old text. Each rename takes the first line
 * not already renamed whose memo is `from` (and, when given, whose debit / credit is the amount),
 * so two lines with the same text and amount each get their own new memo.
 */
export async function renameLineMemos(
  ctx: ServiceContext,
  entryId: string | null | undefined,
  renames: ReadonlyArray<{ from: string | null; to: string | null; debit?: string | number | null; credit?: string | number | null }>,
): Promise<void> {
  if (!entryId) return;
  const pending = renames.filter((r) => (r.from ?? null) !== (r.to ?? null));
  if (pending.length === 0) return;
  const old = await ctx.db
    .select({ id: journalEntryLines.id, debit: journalEntryLines.debit, credit: journalEntryLines.credit, memo: journalEntryLines.memo })
    .from(journalEntryLines)
    .where(eq(journalEntryLines.journalEntryId, entryId));
  const used = new Set<string>();
  for (const r of pending) {
    const match = old.find(
      (o) =>
        !used.has(o.id) &&
        (o.memo ?? null) === (r.from ?? null) &&
        (r.debit == null || Money.round2(o.debit ?? 0).equals(Money.round2(r.debit))) &&
        (r.credit == null || Money.round2(o.credit ?? 0).equals(Money.round2(r.credit))),
    );
    if (!match) continue;
    used.add(match.id);
    await ctx.db.update(journalEntryLines).set({ memo: r.to ?? null }).where(eq(journalEntryLines.id, match.id));
  }
}
