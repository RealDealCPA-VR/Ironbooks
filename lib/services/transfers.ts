/**
 * Transfers service — move money between two accounts.
 *
 * A transfer from account A to account B posts a balanced journal entry:
 *   Dr  toAccount    amount   (money arrives here)
 *   Cr  fromAccount  amount   (money leaves here)
 *
 * For asset accounts (debit-normal) this means:
 *   - toAccount balance increases  (debit increases asset)
 *   - fromAccount balance decreases (credit decreases asset)
 *
 * The posted entry id is stored on the transfer row for full GL traceability.
 *
 * wave2 D1: updateTransfer edits a saved transfer (memo-only edits keep the entry, so they work on
 * reconciled transfers; anything else is void + repost in one transaction) and voidTransfer
 * reverses it.
 */
import { and, desc, eq } from 'drizzle-orm';
import { accounts, transfers } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { postJournalEntry, voidJournalEntry, type PostingLine } from './posting';
import { planPostedEdit, retitleEntry } from './postedEdit';
import { assertHomeCurrencyAccounts } from './currencies';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateTransferInput {
  date: Date;
  fromAccountId: string;
  toAccountId: string;
  /** Decimal string or number — must be > 0. */
  amount: string | number;
  memo?: string | null;
}

function validateTransfer(input: CreateTransferInput): string {
  if (input.fromAccountId === input.toAccountId) {
    throw validation('From account and to account must be different.');
  }
  const amount = Money.of(input.amount);
  if (!amount.greaterThan(0)) {
    throw validation('Transfer amount must be greater than zero.');
  }
  return toAmountString(amount);
}

function transferLines(input: CreateTransferInput, amountStr: string): PostingLine[] {
  return [
    { accountId: input.toAccountId, debit: amountStr, memo: input.memo ?? null },
    { accountId: input.fromAccountId, credit: amountStr, memo: input.memo ?? null },
  ];
}

function transferDescription(input: CreateTransferInput): string {
  return input.memo ? `Transfer: ${input.memo}` : 'Transfer between accounts';
}

/** Both accounts must belong to this company. */
async function assertAccountsOwned(ctx: ServiceContext, input: CreateTransferInput) {
  for (const id of [input.fromAccountId, input.toAccountId]) {
    const [row] = await ctx.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, id)));
    if (!row) throw notFound('Account');
  }
  await assertHomeCurrencyAccounts(ctx, [input.fromAccountId, input.toAccountId], 'Transfers');
}

// ---------------------------------------------------------------------------
// createTransfer
// ---------------------------------------------------------------------------

export async function createTransfer(ctx: ServiceContext, input: CreateTransferInput) {
  const amountStr = validateTransfer(input);
  await assertAccountsOwned(ctx, input);

  return inTransaction(ctx, async (tx) => {
    // Post the journal entry: Dr toAccount, Cr fromAccount.
    const entry = await postJournalEntry(tx, {
      date: input.date,
      description: transferDescription(input),
      lines: transferLines(input, amountStr),
    });

    // Insert the transfer record.
    const [transfer] = await tx.db
      .insert(transfers)
      .values({
        companyId: tx.companyId,
        date: input.date,
        fromAccountId: input.fromAccountId,
        toAccountId: input.toAccountId,
        amount: amountStr,
        memo: input.memo ?? null,
        postedEntryId: entry.id,
      })
      .returning();

    await writeAudit(tx, {
      action: 'create',
      entityType: 'transfer',
      entityId: transfer.id,
      newValues: {
        fromAccountId: input.fromAccountId,
        toAccountId: input.toAccountId,
        amount: amountStr,
        postedEntryId: entry.id,
      },
    });

    return transfer;
  });
}

// ---------------------------------------------------------------------------
// updateTransfer / voidTransfer (D1)
// ---------------------------------------------------------------------------

export async function updateTransfer(ctx: ServiceContext, id: string, input: CreateTransferInput) {
  const amountStr = validateTransfer(input);
  await assertAccountsOwned(ctx, input);
  const [existing] = await ctx.db
    .select()
    .from(transfers)
    .where(and(eq(transfers.companyId, ctx.companyId), eq(transfers.id, id)));
  if (!existing) throw notFound('Transfer');
  if (existing.voidedAt) throw new ServiceError('CONFLICT', 'This transfer is void and cannot be edited.');

  return inTransaction(ctx, async (tx) => {
    const lines = transferLines(input, amountStr);
    const plan = await planPostedEdit(tx, {
      entryId: existing.postedEntryId,
      date: input.date,
      lines,
      what: 'transfer',
    });
    let entryId = existing.postedEntryId;
    if (plan === 'repost') {
      if (existing.postedEntryId) await voidJournalEntry(tx, existing.postedEntryId);
      const entry = await postJournalEntry(tx, {
        date: input.date,
        description: transferDescription(input),
        lines,
      });
      entryId = entry.id;
    } else {
      await retitleEntry(tx, entryId, { description: transferDescription(input) });
    }
    const [updated] = await tx.db
      .update(transfers)
      .set({
        date: input.date,
        fromAccountId: input.fromAccountId,
        toAccountId: input.toAccountId,
        amount: amountStr,
        memo: input.memo ?? null,
        postedEntryId: entryId,
      })
      .where(eq(transfers.id, id))
      .returning();
    await writeAudit(tx, {
      action: 'update',
      entityType: 'transfer',
      entityId: id,
      oldValues: {
        date: existing.date,
        fromAccountId: existing.fromAccountId,
        toAccountId: existing.toAccountId,
        amount: existing.amount,
        memo: existing.memo,
        postedEntryId: existing.postedEntryId,
      },
      newValues: {
        date: input.date,
        fromAccountId: input.fromAccountId,
        toAccountId: input.toAccountId,
        amount: amountStr,
        memo: input.memo ?? null,
        ledger: plan === 'unchanged' ? 'unchanged' : 'reposted',
        postedEntryId: entryId,
      },
    });
    return updated;
  });
}

export async function voidTransfer(ctx: ServiceContext, id: string) {
  const [existing] = await ctx.db
    .select()
    .from(transfers)
    .where(and(eq(transfers.companyId, ctx.companyId), eq(transfers.id, id)));
  if (!existing) throw notFound('Transfer');
  if (existing.voidedAt) return existing; // idempotent
  return inTransaction(ctx, async (tx) => {
    if (existing.postedEntryId) await voidJournalEntry(tx, existing.postedEntryId);
    const [updated] = await tx.db
      .update(transfers)
      .set({ voidedAt: new Date() })
      .where(eq(transfers.id, id))
      .returning();
    await writeAudit(tx, {
      action: 'void',
      entityType: 'transfer',
      entityId: id,
      oldValues: { amount: existing.amount, postedEntryId: existing.postedEntryId },
      newValues: { voided: true },
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// listTransfers
// ---------------------------------------------------------------------------

export async function listTransfers(ctx: ServiceContext) {
  return ctx.db
    .select()
    .from(transfers)
    .where(eq(transfers.companyId, ctx.companyId))
    .orderBy(desc(transfers.date), desc(transfers.createdAt));
}

// ---------------------------------------------------------------------------
// getTransfer
// ---------------------------------------------------------------------------

export async function getTransfer(ctx: ServiceContext, id: string) {
  const [row] = await ctx.db
    .select()
    .from(transfers)
    .where(and(eq(transfers.companyId, ctx.companyId), eq(transfers.id, id)));
  if (!row) throw notFound('Transfer');
  return row;
}
