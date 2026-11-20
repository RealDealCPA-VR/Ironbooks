/**
 * What an agent may do with a bank statement and a reconciliation (AGENT_ACCESS.md), run by
 * lib/agent/actions.ts like every other action.
 *
 * The flow is the bookkeeper's own, through the same services the Banking and Reconcile windows use:
 *
 *   1. import_statement_lines  the lines of a statement go into the bank feed. They must tie out to
 *                              the statement's opening and closing balance, as in the app. Nothing
 *                              is posted by this: the lines wait for review.
 *   2. categorize_bank_line    a line that is not in the books yet is entered (posts to the ledger);
 *      match_bank_line         a line that already is, is linked to that entry (posts nothing);
 *      exclude_bank_line       a line that does not belong is set aside.
 *   3. start_reconciliation    for a statement date and ending balance; set_cleared ticks the lines
 *      … finish_reconciliation the statement shows; finishing is only possible at a difference of 0.00.
 *
 * Three kinds of action, by what they do to the books:
 *
 *  - 'read':    looks only.
 *  - 'prepare': puts statement lines in the feed, or works on a reconciliation that is still in
 *               progress. Nothing reaches the ledger, and a person can discard all of it. An agent
 *               in Propose mode may do these itself, so it can lay the work out for a person; in a
 *               reconciliation only one it started.
 *  - 'write':   posts to the ledger or closes a reconciliation. Post mode enters it; Propose mode
 *               queues it for a person.
 *
 * Never from an agent: bank suggestions that would ask an AI service, automatic posting of a whole
 * feed, and paying a credit card balance from the reconcile window.
 */
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { reconciliations, bankAccounts } from '@/lib/db/schema';
import { tieOut } from '@/lib/statements/parse';
import { type ServiceContext, ServiceError, notFound, validation } from '@/lib/services/_base';
import { importTransactions, parseRows } from '@/lib/services/import';
import { categorize, excludeTransaction, matchTransaction, restoreExcluded, unmatch } from '@/lib/services/bankCategorize';
import { suggestForAccount } from '@/lib/services/bankSuggest';
import {
  addStatementAdjustments,
  cancelReconciliation,
  completeReconciliation,
  getProgress,
  setClearedMany,
  startReconciliation,
  undoLastReconciliation,
  updateStatement,
} from '@/lib/services/reconcile';
import { zMoney, zUuid } from '@/lib/validation/helpers';
import { type AgentActionDef, registerAgentActions } from './actions';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const zDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date as YYYY-MM-DD');
/** A signed amount as text: "-45.10" (money out of the account), "1200.00" (money in). */
const zSigned = z.string().regex(/^-?\d{1,13}(\.\d{1,2})?$/, 'must be an amount like -45.10 or 1200.00');
const money = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : String(v ?? '');
};
const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'string' ? v.slice(0, 10) : null);

async function bankLabel(ctx: ServiceContext, bankAccountId: string): Promise<string> {
  const [row] = await ctx.db.select({ name: bankAccounts.bankName }).from(bankAccounts).where(and(eq(bankAccounts.id, bankAccountId), eq(bankAccounts.companyId, ctx.companyId)));
  return row?.name ?? 'a bank account';
}

/**
 * The reconciliation an action works on. An agent in Propose mode only works on one it started:
 * a session a person has open is theirs.
 */
async function reconciliationFor(ctx: ServiceContext, id: string) {
  const [row] = await ctx.db
    .select({ id: reconciliations.id, status: reconciliations.status, agentId: reconciliations.agentId, bankAccountId: reconciliations.bankAccountId, statementDate: reconciliations.statementDate })
    .from(reconciliations)
    .innerJoin(bankAccounts, eq(bankAccounts.id, reconciliations.bankAccountId))
    .where(and(eq(reconciliations.id, id), eq(bankAccounts.companyId, ctx.companyId)));
  if (!row) throw notFound('Reconciliation');
  if (ctx.agent && ctx.agent.mode === 'propose' && !ctx.userId && row.agentId !== ctx.agent.id) {
    throw new ServiceError('FORBIDDEN', 'That reconciliation was started by someone else. In Propose mode you can only work on a reconciliation you started.');
  }
  return row;
}

const progressOf = (p: Any) => ({ reconciliation_id: p.reconciliationId, statement_balance: p.statementBalance, cleared_balance: p.clearedBalance, difference: p.difference });

const statementLine = z
  .object({ date: zDay, description: z.string().trim().max(500), amount: zSigned, payee: z.string().trim().max(255).nullish() })
  .strict();

export const AGENT_BANKING_ACTIONS: AgentActionDef<Any>[] = [
  {
    name: 'bank_feed_suggestions',
    kind: 'read',
    route: { path: '/api/bank-transactions/suggestions', method: 'GET' },
    schema: z.object({ bankAccountId: zUuid }).strict(),
    describe: () => 'Suggested accounts for bank feed lines',
    // The company's own rules and its history only: no AI service is asked, and nothing is saved.
    run: async (ctx, i) => ({
      suggestions: (await suggestForAccount(ctx, i.bankAccountId, { ai: false, localModel: false })).map((s) => ({
        bank_transaction_id: s.bankTransactionId, account_id: s.accountId, account: s.accountName, payee: s.payee, confidence: s.confidence, reason: s.reason, rule: s.ruleName,
      })),
    }),
  },
  {
    name: 'import_statement_lines',
    kind: 'prepare',
    route: { path: '/api/import', method: 'POST' },
    schema: z
      .object({
        bankAccountId: zUuid,
        kind: z.enum(['bank', 'card']),
        openingBalance: zSigned,
        closingBalance: zSigned,
        acknowledgeDifference: z.boolean().optional(),
        filename: z.string().trim().max(200).nullish(),
        rows: z.array(statementLine).min(1).max(5000),
      })
      .strict(),
    describe: async (ctx, i) => `Import ${i.rows.length} statement line(s) into ${await bankLabel(ctx, i.bankAccountId)} (${i.openingBalance} to ${i.closingBalance})`,
    run: async (ctx, i) => {
      // The app's own rule (app/api/import/route.ts): the lines must add up to the change between
      // the statement's opening and closing balance, or the difference must be acknowledged.
      const normalized = parseRows(i.rows);
      const t = tieOut(normalized, i.openingBalance, i.closingBalance, i.kind);
      if (!t.ok && i.acknowledgeDifference !== true) {
        throw validation(
          t.difference === null ? 'The statement balances are missing, so the lines cannot be tied out.' : `The lines are off from the statement by ${t.difference}. Check for a missing or doubled line, or a wrong sign.`,
          { tieOut: t },
        );
      }
      const summary = await importTransactions(ctx, {
        bankAccountId: i.bankAccountId,
        fileType: 'rows',
        content: '',
        rows: i.rows,
        filename: i.filename ?? 'statement lines from an agent',
        statementCheck: { tieOut: t, acknowledgedDifference: !t.ok },
        // Staging only. Entering the lines is a separate, deliberate step (categorize_bank_line).
        skipAutoPost: true,
      });
      return { lines_read: summary.parsed, added_to_feed: summary.imported, already_there: summary.skippedDupes, errors: summary.errors, tied_out: t.ok, difference: t.ok ? '0.00' : t.difference };
    },
  },
  {
    name: 'categorize_bank_line',
    kind: 'write',
    route: { path: '/api/bank-transactions/categorize', method: 'POST' },
    schema: z
      .object({ bankTransactionId: zUuid, accountId: zUuid, payee: z.string().trim().max(255).nullish(), memo: z.string().trim().max(500).nullish(), classId: zUuid.nullish() })
      .strict(),
    describe: (_ctx, i) => `Enter bank feed line ${i.bankTransactionId} to an account`,
    run: async (ctx, i) => {
      const out = await categorize(ctx, { bankTransactionId: i.bankTransactionId, accountId: i.accountId, payee: i.payee ?? null, memo: i.memo ?? null, classId: i.classId ?? null, source: 'user' });
      return { bank_transaction_id: out.transaction?.id ?? i.bankTransactionId, matched: true, journal_entry_id: out.entry?.id ?? null, date: day(out.entry?.date) };
    },
  },
  {
    name: 'match_bank_line',
    kind: 'write',
    route: { path: '/api/bank-transactions/match', method: 'POST' },
    schema: z.object({ bankTransactionId: zUuid, journalEntryId: zUuid }).strict(),
    describe: (_ctx, i) => `Match bank feed line ${i.bankTransactionId} to an entry already in the books`,
    run: async (ctx, i) => {
      const out = await matchTransaction(ctx, i.bankTransactionId, i.journalEntryId);
      return { bank_transaction_id: out.transaction?.id ?? i.bankTransactionId, matched: true, journal_entry_id: out.entry?.id ?? i.journalEntryId };
    },
  },
  {
    name: 'unmatch_bank_line',
    kind: 'write',
    route: { path: '/api/bank-transactions/unmatch', method: 'POST' },
    schema: z.object({ bankTransactionId: zUuid }).strict(),
    describe: (_ctx, i) => `Undo the match of bank feed line ${i.bankTransactionId}`,
    run: async (ctx, i) => {
      const row = (await unmatch(ctx, i.bankTransactionId)) as Any;
      return { bank_transaction_id: row?.id ?? i.bankTransactionId, matched: row?.matched === true };
    },
  },
  {
    name: 'exclude_bank_line',
    kind: 'prepare',
    route: { path: '/api/bank-transactions/exclude', method: 'POST' },
    schema: z.object({ bankTransactionId: zUuid, restore: z.boolean().optional() }).strict(),
    describe: (_ctx, i) => `${i.restore ? 'Put back' : 'Set aside'} bank feed line ${i.bankTransactionId}`,
    run: async (ctx, i) => {
      const row = (i.restore ? await restoreExcluded(ctx, i.bankTransactionId) : await excludeTransaction(ctx, i.bankTransactionId)) as Any;
      return { bank_transaction_id: row?.id ?? i.bankTransactionId, excluded: row?.excluded === true };
    },
  },
  {
    name: 'start_reconciliation',
    kind: 'prepare',
    route: { path: '/api/reconciliations', method: 'POST' },
    schema: z.object({ bankAccountId: zUuid, statementDate: zDay, statementBalance: zSigned }).strict(),
    describe: async (ctx, i) => `Start reconciling ${await bankLabel(ctx, i.bankAccountId)} to the statement of ${i.statementDate} (${money(i.statementBalance)})`,
    run: async (ctx, i) => {
      const row = await startReconciliation(ctx, { bankAccountId: i.bankAccountId, statementDate: i.statementDate, statementBalance: i.statementBalance });
      return { ...progressOf(await getProgress(ctx, row.id)), statement_date: day(row.statementDate), status: row.status };
    },
  },
  {
    name: 'set_cleared',
    kind: 'prepare',
    route: { path: '/api/reconciliations/[id]', method: 'PATCH' },
    schema: z.object({ reconciliationId: zUuid, journalEntryLineIds: z.array(zUuid).min(1).max(20000), isCleared: z.boolean() }).strict(),
    describe: (_ctx, i) => `${i.isCleared ? 'Mark' : 'Unmark'} ${i.journalEntryLineIds.length} line(s) as cleared`,
    run: async (ctx, i) => {
      await reconciliationFor(ctx, i.reconciliationId);
      return progressOf(await setClearedMany(ctx, i.reconciliationId, i.journalEntryLineIds, i.isCleared));
    },
  },
  {
    name: 'update_reconciliation_statement',
    kind: 'prepare',
    route: { path: '/api/reconciliations/[id]', method: 'PATCH' },
    schema: z
      .object({ reconciliationId: zUuid, statementDate: zDay.optional(), statementBalance: zSigned.optional() })
      .strict()
      .refine((v) => v.statementDate !== undefined || v.statementBalance !== undefined, 'Give the statement date, the statement balance, or both.'),
    describe: () => 'Correct the statement date or ending balance of a reconciliation',
    run: async (ctx, i) => {
      await reconciliationFor(ctx, i.reconciliationId);
      await updateStatement(ctx, i.reconciliationId, { statementBalance: i.statementBalance, statementDate: i.statementDate });
      return progressOf(await getProgress(ctx, i.reconciliationId));
    },
  },
  {
    name: 'add_statement_adjustments',
    kind: 'write',
    route: { path: '/api/reconciliations/[id]', method: 'PATCH' },
    schema: z
      .object({
        reconciliationId: zUuid,
        serviceCharge: z.object({ amount: zMoney, accountId: zUuid }).strict().nullish(),
        interestEarned: z.object({ amount: zMoney, accountId: zUuid }).strict().nullish(),
      })
      .strict()
      .refine((v) => Boolean(v.serviceCharge || v.interestEarned), 'Give a service charge, interest earned, or both.'),
    describe: (_ctx, i) => `Enter the statement's ${[i.serviceCharge && `service charge ${money(i.serviceCharge.amount)}`, i.interestEarned && `interest ${money(i.interestEarned.amount)}`].filter(Boolean).join(' and ')}`,
    run: async (ctx, i) => {
      await reconciliationFor(ctx, i.reconciliationId);
      return progressOf(await addStatementAdjustments(ctx, i.reconciliationId, { serviceCharge: i.serviceCharge ?? null, interestEarned: i.interestEarned ?? null }));
    },
  },
  {
    name: 'finish_reconciliation',
    kind: 'write',
    route: { path: '/api/reconciliations/[id]', method: 'PATCH' },
    schema: z.object({ reconciliationId: zUuid }).strict(),
    describe: async (ctx, i) => {
      const row = await reconciliationFor(ctx, i.reconciliationId);
      return `Finish reconciling ${await bankLabel(ctx, row.bankAccountId)} to the statement of ${day(row.statementDate)}`;
    },
    // Only at a difference of exactly 0.00. An agent never forces it shut with an adjustment.
    run: async (ctx, i) => {
      const row = await completeReconciliation(ctx, i.reconciliationId);
      return { reconciliation_id: row.id, status: row.status, statement_date: day(row.statementDate), statement_balance: row.statementBalance };
    },
  },
  {
    name: 'cancel_reconciliation',
    kind: 'write',
    route: { path: '/api/reconciliations/[id]', method: 'DELETE' },
    schema: z.object({ reconciliationId: zUuid }).strict(),
    describe: () => 'Cancel a reconciliation in progress (its cleared marks are dropped)',
    run: async (ctx, i) => {
      await cancelReconciliation(ctx, i.reconciliationId);
      return { reconciliation_id: i.reconciliationId, cancelled: true };
    },
  },
  {
    name: 'undo_last_reconciliation',
    kind: 'write',
    route: { path: '/api/reconciliations/undo', method: 'POST' },
    schema: z.object({ bankAccountId: zUuid, expectStatementDate: zDay.nullish() }).strict(),
    describe: async (ctx, i) => `Undo the last finished reconciliation of ${await bankLabel(ctx, i.bankAccountId)}`,
    run: async (ctx, i) => {
      const row = await undoLastReconciliation(ctx, i.bankAccountId, i.expectStatementDate ?? null);
      return { reconciliation_id: row.id, status: row.status, statement_date: day(row.statementDate) };
    },
  },
];

registerAgentActions(AGENT_BANKING_ACTIONS);
