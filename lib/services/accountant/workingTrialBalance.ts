/**
 * Working Trial Balance (QB Accountant → Working Trial Balance) — wave2 accountant, I8.
 *
 * Per account, for a period: Beginning balance | Transactions | Adjustments | Ending balance, plus
 * the accountant's Workpaper Reference and Notes. Amounts are debit-positive (credit balances are
 * negative), the same convention as QB's WTB, so every column sums to zero — the books balance by
 * construction (all figures come from the same posted ledger rows as the Trial Balance).
 *
 * "Adjustments" = adjusting journal entries in the period: entries posted from this screen
 * ("Make adjustments", sourceRef 'adjusting:wtb') and any entry whose sourceRef starts with
 * 'adjusting'. TODO(wave2 foundation): when the foundation package's journal-entry "adjusting"
 * flag lands, also treat entries with that flag as adjustments (isAdjustingSql below).
 */
import { and, eq, gte, lt, lte, sql } from 'drizzle-orm';
import { accounts, journalEntries, journalEntryLines, workingTbNotes } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, inTransaction, notFound, validation, writeAudit } from '../_base';
import { postJournalEntry, type PostingLine } from '../posting';

/** SQL predicate: the entry is an adjusting entry. */
const isAdjustingSql = sql`COALESCE(${journalEntries.sourceRef}, '') LIKE 'adjusting%'`;

export interface WtbRow {
  accountId: string;
  code: string;
  name: string;
  type: string;
  beginning: string;
  transactions: string;
  adjustments: string;
  ending: string;
  workpaperRef: string | null;
  note: string | null;
}

export interface WorkingTrialBalance {
  from: string;
  to: string;
  rows: WtbRow[];
  totals: { beginning: string; transactions: string; adjustments: string; ending: string };
  balanced: boolean;
}

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function sums(
  ctx: ServiceContext,
  conds: ReturnType<typeof and>[],
): Promise<Map<string, ReturnType<typeof Money.zero>>> {
  const rows = await ctx.db
    .select({
      accountId: journalEntryLines.accountId,
      net: sql<string>`COALESCE(SUM(COALESCE(${journalEntryLines.debit}, 0) - COALESCE(${journalEntryLines.credit}, 0)), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.status, 'posted'), ...conds))
    .groupBy(journalEntryLines.accountId);
  return new Map(rows.map((r) => [r.accountId, Money.of(r.net)]));
}

export async function workingTrialBalance(
  ctx: ServiceContext,
  range: { from: Date; to: Date },
): Promise<WorkingTrialBalance> {
  if (!(range.from instanceof Date) || !(range.to instanceof Date) || range.from > range.to) {
    throw validation('Choose a valid period (from must be on or before to).');
  }
  const begin = await sums(ctx, [lt(journalEntries.date, range.from)]);
  const txns = await sums(ctx, [
    gte(journalEntries.date, range.from),
    lte(journalEntries.date, range.to),
    sql`NOT (${isAdjustingSql})`,
  ]);
  const adj = await sums(ctx, [gte(journalEntries.date, range.from), lte(journalEntries.date, range.to), isAdjustingSql]);

  const acctRows = await ctx.db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type, isActive: accounts.isActive })
    .from(accounts)
    .where(eq(accounts.companyId, ctx.companyId));
  const notes = await ctx.db
    .select()
    .from(workingTbNotes)
    .where(and(eq(workingTbNotes.companyId, ctx.companyId), eq(workingTbNotes.periodEnd, isoDay(range.to))));
  const noteBy = new Map(notes.map((n) => [n.accountId, n]));

  const z = Money.zero();
  let tb = z, tt = z, ta = z, te = z;
  const rows: WtbRow[] = [];
  for (const a of acctRows) {
    const b = begin.get(a.id) ?? z;
    const t = txns.get(a.id) ?? z;
    const j = adj.get(a.id) ?? z;
    const e = b.plus(t).plus(j);
    const n = noteBy.get(a.id);
    if (b.isZero() && t.isZero() && j.isZero() && !n && !a.isActive) continue;
    if (b.isZero() && t.isZero() && j.isZero() && !n) continue;
    tb = tb.plus(b);
    tt = tt.plus(t);
    ta = ta.plus(j);
    te = te.plus(e);
    rows.push({
      accountId: a.id,
      code: a.code,
      name: a.name,
      type: a.type,
      beginning: toAmountString(b),
      transactions: toAmountString(t),
      adjustments: toAmountString(j),
      ending: toAmountString(e),
      workpaperRef: n?.workpaperRef ?? null,
      note: n?.note ?? null,
    });
  }
  rows.sort((x, y) => x.code.localeCompare(y.code));
  return {
    from: isoDay(range.from),
    to: isoDay(range.to),
    rows,
    totals: {
      beginning: toAmountString(tb),
      transactions: toAmountString(tt),
      adjustments: toAmountString(ta),
      ending: toAmountString(te),
    },
    balanced: tb.isZero() && tt.isZero() && ta.isZero() && te.isZero(),
  };
}

/** Save the workpaper reference / note for an account at a period end (empty both = clear). */
export async function saveWtbNote(
  ctx: ServiceContext,
  input: { accountId: string; periodEnd: string; workpaperRef?: string | null; note?: string | null },
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.periodEnd ?? '')) throw validation('periodEnd must be YYYY-MM-DD.');
  const [acct] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, input.accountId)));
  if (!acct) throw notFound('Account');
  const ref = input.workpaperRef?.trim() || null;
  const note = input.note?.trim() || null;
  if (ref && ref.length > 100) throw validation('Workpaper reference is limited to 100 characters.');
  return inTransaction(ctx, async (tx) => {
    const [existing] = await tx.db
      .select()
      .from(workingTbNotes)
      .where(
        and(
          eq(workingTbNotes.companyId, tx.companyId),
          eq(workingTbNotes.accountId, input.accountId),
          eq(workingTbNotes.periodEnd, input.periodEnd),
        ),
      );
    let row;
    if (existing) {
      [row] = await tx.db
        .update(workingTbNotes)
        .set({ workpaperRef: ref, note, updatedAt: new Date(), createdBy: tx.userId })
        .where(eq(workingTbNotes.id, existing.id))
        .returning();
    } else {
      [row] = await tx.db
        .insert(workingTbNotes)
        .values({ companyId: tx.companyId, accountId: input.accountId, periodEnd: input.periodEnd, workpaperRef: ref, note, createdBy: tx.userId })
        .returning();
    }
    await writeAudit(tx, {
      action: existing ? 'update' : 'create',
      entityType: 'working_tb_note',
      entityId: row.id,
      oldValues: existing ? { workpaperRef: existing.workpaperRef, note: existing.note } : undefined,
      newValues: { accountId: input.accountId, periodEnd: input.periodEnd, workpaperRef: ref, note },
    });
    return row;
  });
}

/** "Make Adjustments": post an adjusting journal entry (counted in the Adjustments column). */
export async function postAdjustingEntry(
  ctx: ServiceContext,
  input: { date: Date; description: string; reference?: string | null; lines: PostingLine[] },
) {
  if (!input.description?.trim()) throw validation('Description is required.');
  return postJournalEntry(ctx, {
    date: input.date,
    description: input.description.trim(),
    reference: input.reference ?? null,
    sourceRef: 'adjusting:wtb',
    lines: input.lines,
  });
}
