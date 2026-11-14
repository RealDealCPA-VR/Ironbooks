/**
 * "What the AI posted" — every bank-feed line the AI posted on its own (auto-apply,
 * lib/services/aiCategorizer.ts autoApplyBankSuggestions), newest first, each with one-click Undo.
 *
 * Undo is Bank Review's Unmatch (lib/services/bankCategorize.ts unmatch): the entry the AI made is
 * voided and the line goes back to "For review". The AI never posts that line again (the
 * ai_auto_applied row stays, and auto-apply skips lines it posted before).
 */
import { and, desc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { accounts, aiAutoApplied, bankAccounts, bankTransactions, journalEntries } from '@/lib/db/schema';
import { ServiceError, notFound, type ServiceContext } from './_base';
import { unmatch } from './bankCategorize';

export interface AiPostRow {
  id: string;
  bankTransactionId: string;
  /** When the AI posted it. */
  postedAt: string;
  /** The bank line. */
  date: string;
  description: string;
  amount: string;
  bankAccount: string;
  /** Where the AI put it. */
  accountCode: string;
  accountName: string;
  /** 0..1 as a decimal string. */
  confidence: string;
  /**
   * 'posted' = still in the books as the AI posted it; 'changed' = the person edited the entry or
   * matched the line to something else (the line is still posted, just not the AI's way);
   * 'undone' = the line is back in review.
   */
  state: 'posted' | 'changed' | 'undone';
}

const bankLedger = alias(accounts, 'bank_ledger');

export async function listAiPosts(ctx: ServiceContext, opts: { limit?: number; id?: string } = {}): Promise<AiPostRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const rows = await ctx.db
    .select({
      id: aiAutoApplied.id,
      bankTransactionId: aiAutoApplied.bankTransactionId,
      journalEntryId: aiAutoApplied.journalEntryId,
      postedAt: aiAutoApplied.createdAt,
      confidence: aiAutoApplied.confidence,
      entryStatus: journalEntries.status,
      date: bankTransactions.date,
      description: bankTransactions.description,
      payee: bankTransactions.payee,
      amount: bankTransactions.amount,
      matched: bankTransactions.matched,
      matchedEntryId: bankTransactions.matchedEntryId,
      bankName: bankAccounts.bankName,
      bankLedgerName: bankLedger.name,
      accountCode: accounts.code,
      accountName: accounts.name,
    })
    .from(aiAutoApplied)
    .innerJoin(journalEntries, eq(journalEntries.id, aiAutoApplied.journalEntryId))
    .innerJoin(bankTransactions, eq(bankTransactions.id, aiAutoApplied.bankTransactionId))
    .innerJoin(bankAccounts, eq(bankAccounts.id, bankTransactions.bankAccountId))
    .innerJoin(bankLedger, eq(bankLedger.id, bankAccounts.accountId))
    .innerJoin(accounts, eq(accounts.id, aiAutoApplied.accountId))
    .where(opts.id ? and(eq(aiAutoApplied.companyId, ctx.companyId), eq(aiAutoApplied.id, opts.id)) : eq(aiAutoApplied.companyId, ctx.companyId))
    .orderBy(desc(aiAutoApplied.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    bankTransactionId: r.bankTransactionId,
    postedAt: r.postedAt.toISOString(),
    date: r.date.toISOString().slice(0, 10),
    description: r.description || r.payee || '',
    amount: r.amount,
    bankAccount: r.bankLedgerName || r.bankName,
    accountCode: r.accountCode,
    accountName: r.accountName,
    confidence: r.confidence,
    state:
      r.entryStatus === 'posted' && r.matched && r.matchedEntryId === r.journalEntryId
        ? 'posted'
        : r.matched && r.matchedEntryId
          ? 'changed'
          : 'undone',
  }));
}

/** Undo one AI post: Bank Review's Unmatch on its line (voids the AI's entry). */
export async function undoAiPost(ctx: ServiceContext, id: string): Promise<AiPostRow> {
  const [row] = await ctx.db
    .select({ id: aiAutoApplied.id, bankTransactionId: aiAutoApplied.bankTransactionId })
    .from(aiAutoApplied)
    .where(and(eq(aiAutoApplied.id, id), eq(aiAutoApplied.companyId, ctx.companyId)));
  if (!row) throw notFound('AI post');
  const [current] = await listAiPosts(ctx, { id });
  if (current?.state === 'changed') {
    throw new ServiceError('CONFLICT', 'You changed this one since the AI posted it, so it is left as you set it. Use Unmatch in Bank Review to send it back to review.');
  }
  if (current?.state !== 'posted') throw new ServiceError('CONFLICT', 'This one is already undone.');
  await unmatch(ctx, row.bankTransactionId);
  return { ...current, state: 'undone' };
}
