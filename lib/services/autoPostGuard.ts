/**
 * The one safety check every AUTOMATIC or bulk posting of bank-feed lines goes through: the AI's
 * auto-post (aiCategorizer.autoApplyBankSuggestions), "add automatically" bank rules
 * (bankSuggest.runAutoRules), "Add all suggested" (bankCategorize.categorizeSuggested) and
 * "accept all high-confidence" (bankSuggest.bulkAccept). A line is left for the person when it
 * may already be in the books or the person already said no to posting it:
 *
 *  - it was posted before and undone (an entry made from it is now void, or the AI posted it
 *    before): an Unmatch is the person's "no" and must stick;
 *  - it is dated on or before imported QuickBooks history (GL import, IIF or open-items import):
 *    that money is in the ledger already;
 *  - it may match an entry already in the books: a Bank Review match candidate, or any posted
 *    entry of the same amount on this bank account within ±120 days that no line of THIS feed is
 *    matched to yet (a check written weeks before it cleared; the other side of a transfer
 *    already booked from the other account's feed).
 */
import { and, eq, gte, inArray, isNotNull, like, lte, or, sql } from 'drizzle-orm';
import { aiAutoApplied, bankAccounts, bankTransactions, journalEntries, journalEntryLines } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { ServiceContext } from './_base';

const WIDE_DAYS = 120;
const DAY = 24 * 60 * 60 * 1000;

export const BLOCK_REASONS = {
  undone: 'Posted before and undone; it waits for you.',
  history: 'Dated on or before your imported QuickBooks history; it may already be in the books.',
  match: 'It may match a transaction already entered; review the match in Bank Review.',
} as const;

/** The last day of imported QuickBooks history (never later than today), or null. */
export async function historyCutover(ctx: Pick<ServiceContext, 'db' | 'companyId'>): Promise<Date | null> {
  const [cut] = await ctx.db
    .select({ last: sql<Date | null>`max(${journalEntries.date})` })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        or(like(journalEntries.sourceRef, 'qbgl:%'), like(journalEntries.sourceRef, 'iif:%'), like(journalEntries.sourceRef, 'qbopen:%')),
        // The GL import's variance / suspense entry is dated at the report's period end, which can
        // be after the last real transaction (or in the future): it is not history.
        sql`${journalEntries.sourceRef} NOT LIKE 'qbgl:variance%'`,
      ),
    );
  return cut?.last ? new Date(Math.min(new Date(cut.last).getTime(), Date.now())) : null;
}

/**
 * Lines (of one bank account) that must NOT be posted automatically, with the reason. Lines not
 * in the map are safe to post.
 */
export async function autoPostBlockers(
  ctx: ServiceContext,
  bankAccountId: string,
  lineIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (lineIds.length === 0) return out;
  const [ba] = await ctx.db
    .select({ accountId: bankAccounts.accountId })
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, bankAccountId), eq(bankAccounts.companyId, ctx.companyId)));
  if (!ba) return new Map(lineIds.map((id) => [id, BLOCK_REASONS.match]));
  const lines = await ctx.db
    .select({ id: bankTransactions.id, date: bankTransactions.date, amount: bankTransactions.amount })
    .from(bankTransactions)
    .where(and(eq(bankTransactions.companyId, ctx.companyId), eq(bankTransactions.bankAccountId, bankAccountId), inArray(bankTransactions.id, lineIds)));

  // 1. Posted before and undone.
  const refs = lines.map((l) => `bank_transaction:${l.id}`);
  const undone = new Set<string>();
  if (refs.length) {
    for (const r of await ctx.db
      .select({ ref: journalEntries.sourceRef })
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.status, 'void'), inArray(journalEntries.sourceRef, refs)))) {
      if (r.ref) undone.add(r.ref.slice('bank_transaction:'.length));
    }
    for (const r of await ctx.db
      .select({ id: aiAutoApplied.bankTransactionId })
      .from(aiAutoApplied)
      .where(and(eq(aiAutoApplied.companyId, ctx.companyId), inArray(aiAutoApplied.bankTransactionId, lines.map((l) => l.id))))) {
      undone.add(r.id);
    }
  }

  // 2. Imported history.
  const cutover = await historyCutover(ctx);

  // 3. May match an entry already in the books: Bank Review's own candidates…
  const { suggestMatchesForAccount } = await import('./bankCategorize');
  const candidates = await suggestMatchesForAccount(ctx, bankAccountId, { bankTransactionIds: lines.map((l) => l.id) });
  // …and any same-amount posted entry on this bank account in a wide window that no line of this
  // feed is matched to (weeks-late checks; a transfer already booked from the other feed).
  const sameAmount = new Set<string>();
  const pending = lines.filter((l) => !undone.has(l.id) && !(cutover && l.date.getTime() <= cutover.getTime()) && !(candidates[l.id] ?? []).length);
  if (pending.length) {
    const from = new Date(Math.min(...pending.map((l) => l.date.getTime())) - WIDE_DAYS * DAY);
    const to = new Date(Math.max(...pending.map((l) => l.date.getTime())) + WIDE_DAYS * DAY);
    const gl = await ctx.db
      .select({ entryId: journalEntries.id, date: journalEntries.date, debit: journalEntryLines.debit, credit: journalEntryLines.credit })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
      .where(
        and(
          eq(journalEntries.companyId, ctx.companyId),
          eq(journalEntries.status, 'posted'),
          eq(journalEntryLines.accountId, ba.accountId),
          gte(journalEntries.date, from),
          lte(journalEntries.date, to),
        ),
      );
    const takenHere = new Set(
      (
        await ctx.db
          .select({ id: bankTransactions.matchedEntryId })
          .from(bankTransactions)
          .where(and(eq(bankTransactions.companyId, ctx.companyId), eq(bankTransactions.bankAccountId, bankAccountId), isNotNull(bankTransactions.matchedEntryId)))
      ).map((r) => r.id),
    );
    for (const l of pending) {
      const amt = Money.of(l.amount);
      const want = Money.abs(amt);
      const deposit = !Money.isNegative(amt);
      const hit = gl.some(
        (g) =>
          !takenHere.has(g.entryId) &&
          Math.abs(g.date.getTime() - l.date.getTime()) <= WIDE_DAYS * DAY &&
          Money.of((deposit ? g.debit : g.credit) ?? '0').equals(want),
      );
      if (hit) sameAmount.add(l.id);
    }
  }

  for (const l of lines) {
    if (undone.has(l.id)) out.set(l.id, BLOCK_REASONS.undone);
    else if (cutover && l.date.getTime() <= cutover.getTime()) out.set(l.id, BLOCK_REASONS.history);
    else if ((candidates[l.id] ?? []).length > 0 || sameAmount.has(l.id)) out.set(l.id, BLOCK_REASONS.match);
  }
  // Ids not on this account's feed are never posted from here.
  for (const id of lineIds) if (!lines.some((l) => l.id === id)) out.set(id, BLOCK_REASONS.match);
  return out;
}
