/**
 * Posting engine — the single, validated path that turns business events into balanced
 * double-entry journal entries. Invoices, bills, payments, deposits, payroll, etc. all post
 * through `postJournalEntry`. This is the one place that validates debits == credits up front.
 *
 * Defence in depth (drizzle/0017_team_ledger.sql): the DATABASE independently enforces the same
 * invariants, so no code path can leave the books out of balance:
 *  - a deferred constraint trigger rejects, at COMMIT, any posted entry that is unbalanced, has
 *    fewer than two lines, or has a malformed line;
 *  - `accounts.balance` is maintained ONLY by triggers from posted journal lines and entry status
 *    transitions (this module no longer applies balance deltas itself), and direct writes of it
 *    are refused unless they equal the ledger-derived value;
 *  - lines of posted/void entries are immutable except inside a sanctioned rewrite
 *    (`allowLedgerRewrite`, used only by condense, account merge and company restore).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Money, toAmountString } from '@/lib/money';
import {
  accounts,
  journalEntries,
  journalEntryLines,
  reconciliationItems,
  reconciliations,
} from '@/lib/db/schema';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { assertPeriodOpen } from './fiscalPeriods';

export interface PostingLine {
  accountId: string;
  /** Provide exactly one of debit/credit (the other 0/empty). */
  debit?: string | number | null;
  credit?: string | number | null;
  memo?: string | null;
  /** Optional class/department dimension for class-based reporting. */
  classId?: string | null;
}

export interface PostJournalEntryInput {
  date: Date;
  description: string;
  reference?: string | null;
  /** 'posted' affects balances; 'draft' does not. Defaults to 'posted'. */
  status?: 'draft' | 'posted';
  lines: PostingLine[];
  /** Optional: link source document for traceability (e.g. "invoice:<id>"). */
  sourceRef?: string;
}

const DEBIT_NORMAL = new Set(['asset', 'expense']);

/** Signed change to an account's natural balance for a single line. */
export function balanceDelta(
  accountType: string,
  debit: string | number | null | undefined,
  credit: string | number | null | undefined,
) {
  const d = Money.of(debit);
  const c = Money.of(credit);
  return DEBIT_NORMAL.has(accountType) ? d.minus(c) : c.minus(d);
}

/** Validate that lines are well-formed and balanced. Throws ServiceError on failure. */
export function assertBalanced(lines: PostingLine[]): { totalDebit: string; totalCredit: string } {
  if (!lines || lines.length < 2) {
    throw validation('A journal entry needs at least two lines.');
  }
  let totalDebit = Money.zero();
  let totalCredit = Money.zero();
  for (const [i, line] of lines.entries()) {
    // Round each line to 2dp BEFORE summing — this is exactly how lines are persisted,
    // so the balance check matches the stored ledger rather than the raw inputs.
    const d = Money.round2(line.debit);
    const c = Money.round2(line.credit);
    if (d.isNegative() || c.isNegative()) {
      throw validation(`Line ${i + 1}: debit/credit cannot be negative.`);
    }
    if (d.greaterThan(0) && c.greaterThan(0)) {
      throw validation(`Line ${i + 1}: a line cannot have both a debit and a credit.`);
    }
    if (d.isZero() && c.isZero()) {
      throw validation(`Line ${i + 1}: a line must have a debit or a credit.`);
    }
    totalDebit = totalDebit.plus(d);
    totalCredit = totalCredit.plus(c);
  }
  // Exact equality of the 2dp totals (no sub-cent tolerance) — a rounded entry that does
  // not net to zero must never persist. Callers must pre-allocate pennies (see money.allocate).
  if (!Money.eq(totalDebit, totalCredit)) {
    throw new ServiceError(
      'UNBALANCED',
      `Entry is out of balance: debits ${toAmountString(totalDebit)} ≠ credits ${toAmountString(
        totalCredit,
      )}.`,
      { totalDebit: toAmountString(totalDebit), totalCredit: toAmountString(totalCredit) },
    );
  }
  return { totalDebit: toAmountString(totalDebit), totalCredit: toAmountString(totalCredit) };
}

async function nextEntryNumber(ctx: ServiceContext): Promise<number> {
  const [row] = await ctx.db
    .select({ max: sql<number>`COALESCE(MAX(${journalEntries.entryNumber}), 0)` })
    .from(journalEntries)
    .where(eq(journalEntries.companyId, ctx.companyId));
  return (row?.max ?? 0) + 1;
}

/** Create a balanced journal entry. If posted, the DB trigger updates cached account balances. */
export async function postJournalEntry(ctx: ServiceContext, input: PostJournalEntryInput) {
  assertBalanced(input.lines);
  await assertPeriodOpen(ctx, input.date); // refuse to post into a closed period
  const status = input.status ?? 'posted';

  // Verify every referenced account belongs to this company and load its type.
  const accountIds = [...new Set(input.lines.map((l) => l.accountId))];
  const accountRows = await ctx.db
    .select({ id: accounts.id, type: accounts.type })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), inArray(accounts.id, accountIds)));
  const typeById = new Map(accountRows.map((a) => [a.id, a.type]));
  for (const id of accountIds) {
    if (!typeById.has(id)) throw notFound(`Account ${id}`);
  }

  return inTransaction(ctx, async (tx) => {
    const entryNumber = await nextEntryNumber(tx);
    const [entry] = await tx.db
      .insert(journalEntries)
      .values({
        companyId: tx.companyId,
        entryNumber,
        date: input.date,
        description: input.description,
        reference: input.reference ?? null,
        status,
        sourceRef: input.sourceRef ?? null,
        createdBy: tx.userId ?? '00000000-0000-0000-0000-000000000000',
      })
      .returning();

    // Canonical 2dp line values. accounts.balance is updated by the database trigger from
    // exactly these stored rows (no TypeScript-side delta, so nothing can be applied twice).
    const normalizedLines = input.lines.map((l) => ({
      accountId: l.accountId,
      debit: l.debit != null && Money.gt(l.debit, 0) ? toAmountString(l.debit) : null,
      credit: l.credit != null && Money.gt(l.credit, 0) ? toAmountString(l.credit) : null,
      memo: l.memo ?? null,
      classId: l.classId ?? null,
    }));

    await tx.db.insert(journalEntryLines).values(
      normalizedLines.map((l) => ({ journalEntryId: entry.id, ...l })),
    );

    await writeAudit(tx, {
      action: 'create',
      entityType: 'journal_entry',
      entityId: entry.id,
      newValues: { entryNumber, description: input.description, lines: input.lines },
    });

    return entry;
  });
}

/** Void a posted entry: mark void (the DB trigger reverses its balance impact). */
export async function voidJournalEntry(ctx: ServiceContext, entryId: string) {
  return inTransaction(ctx, async (tx) => {
    const [entry] = await tx.db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.id, entryId), eq(journalEntries.companyId, tx.companyId)));
    if (!entry) throw notFound('Journal entry');
    if (entry.status === 'void') return entry;
    await assertPeriodOpen(tx, entry.date); // cannot void an entry in a closed period

    const lines = await tx.db
      .select()
      .from(journalEntryLines)
      .where(eq(journalEntryLines.journalEntryId, entryId));

    // Guard: a line that was cleared in a COMPLETED reconciliation must not be voided.
    // The next reconciliation seeds its opening from bankAccounts.lastReconciledBalance,
    // which still includes the line — voiding it would silently corrupt that opening
    // balance with no detection or repair path.
    const lineIds = lines.map((l) => l.id);
    if (lineIds.length > 0) {
      const [reconciled] = await tx.db
        .select({ id: reconciliationItems.id })
        .from(reconciliationItems)
        .innerJoin(
          reconciliations,
          eq(reconciliationItems.reconciliationId, reconciliations.id),
        )
        .where(
          and(
            inArray(reconciliationItems.journalEntryLineId, lineIds),
            eq(reconciliationItems.isCleared, true),
            eq(reconciliations.status, 'completed'),
          ),
        )
        .limit(1);
      if (reconciled) {
        throw new ServiceError(
          'CONFLICT',
          'This entry contains lines cleared in a completed bank reconciliation and cannot be voided. Undo the reconciliation first.',
        );
      }
    }

    // Flipping the status to 'void' reverses the entry's balance impact via the database
    // trigger (bka_je_sync_balances) — no TypeScript balance arithmetic here.
    const [updated] = await tx.db
      .update(journalEntries)
      .set({ status: 'void', voidedAt: new Date(), updatedAt: new Date() })
      .where(eq(journalEntries.id, entryId))
      .returning();

    await writeAudit(tx, {
      action: 'void',
      entityType: 'journal_entry',
      entityId: entryId,
      oldValues: { status: entry.status },
      newValues: { status: 'void' },
    });
    return updated;
  });
}

/**
 * Sanctioned ledger rewrite. Sets the transaction-local flag `bka.allow_ledger_rewrite` that
 * lets the current transaction delete / re-point / back-fill lines of posted entries (see the
 * immutability guards in drizzle/0017_team_ledger.sql). The deferred balance check still runs
 * at COMMIT for every entry whose header or lines the rewrite touched, so a rewrite can never
 * leave an unbalanced entry behind. It does NOT exempt moving an account with journal lines to
 * another company (that is refused unconditionally, since it touches no entry).
 *
 * WHITELIST — only these flows may call it: condense (summarize closed history), account merge
 * (re-point lines between same-type accounts) and company restore (re-insert a backup's ledger).
 * Must be called inside a transaction (`SET LOCAL` semantics: it ends with the transaction).
 */
export async function allowLedgerRewrite(
  ctx: Pick<ServiceContext, 'db'>,
  reason: 'condense' | 'merge' | 'restore',
): Promise<void> {
  await ctx.db.execute(
    // The txid binds the flag to THIS transaction: the guards ignore it anywhere else, even if a
    // session-level set_config were left behind.
    sql`SELECT set_config('bka.allow_ledger_rewrite', 'on', true),
               set_config('bka.ledger_rewrite_txid', txid_current()::text, true),
               set_config('bka.ledger_rewrite_reason', ${reason}, true)`,
  );
}
