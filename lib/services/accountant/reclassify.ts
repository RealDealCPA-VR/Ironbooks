/**
 * Reclassify Transactions (QB Accountant Center → Reclassify Transactions) — wave2 accountant, I3.
 *
 * Pick an account and a date range, select lines, and move them to another account and/or class.
 * Like QuickBooks, the change is made IN PLACE on the posted lines (no extra entries clutter the
 * register), so it runs as a sanctioned ledger rewrite (`allowLedgerRewrite(tx, 'reclassify')`)
 * inside ONE transaction:
 *
 *  - only the line's account / class change — debits and credits never do, so every entry stays
 *    balanced and the trial balance total is unchanged (the deferred DB balance check still runs
 *    at COMMIT for every touched entry, and accounts.balance moves via the ledger triggers);
 *  - every touched entry is audited (old/new account + class per line) → audit trail +
 *    transaction log;
 *  - closed periods are refused (closing-date password override is honoured and recorded as a
 *    Closing Date Exception);
 *  - control accounts with sub-ledgers (bank, A/R, A/P, credit card, inventory, Undeposited
 *    Funds, sales tax, payroll liabilities, retainage) can be neither source nor target — those
 *    balances are tied to documents and reconciliations;
 *  - when ALL of an entry's lines on the old account are moved, the source document's lines on
 *    that account are re-pointed too (invoice, sales receipt, credit memo, bill, check/expense),
 *    so editing the document later re-posts to the new account instead of undoing the fix.
 *
 * Class-only changes need no rewrite flag (class is not a guarded ledger column).
 */
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import {
  accounts,
  bankAccounts,
  billLines,
  classes,
  creditMemoLines,
  expenseLines,
  invoiceLines,
  journalEntries,
  journalEntryLines,
  reconciliationItems,
  reconciliations,
  salesReceiptLines,
  taxAgencies,
} from '@/lib/db/schema';
import { toAmountString } from '@/lib/money';
import { type ServiceContext, ServiceError, inTransaction, notFound, validation, writeAudit } from '../_base';
import { allowLedgerRewrite } from '../posting';
import { assertPeriodOpen, recordClosingDateException } from '../fiscalPeriods';

const CONTROL_SUBTYPES = new Set([
  'checking',
  'savings',
  'accounts_receivable',
  'accounts_payable',
  'credit_card',
  'inventory',
]);
const CONTROL_CODES = new Set(['1050', '1200', '1250', '1300', '2000', '2050', '2100', '2200', '2300']);

/** Accounts that cannot be reclassified from/to (sub-ledger / reconciliation controlled). */
export async function controlAccountIds(ctx: ServiceContext): Promise<Set<string>> {
  const rows = await ctx.db
    .select({ id: accounts.id, code: accounts.code, subtype: accounts.subtype })
    .from(accounts)
    .where(eq(accounts.companyId, ctx.companyId));
  const ids = new Set(
    rows.filter((a) => CONTROL_SUBTYPES.has(a.subtype as string) || CONTROL_CODES.has(a.code)).map((a) => a.id),
  );
  const banks = await ctx.db
    .select({ id: bankAccounts.accountId })
    .from(bankAccounts)
    .where(eq(bankAccounts.companyId, ctx.companyId));
  for (const b of banks) ids.add(b.id);
  const ag = await ctx.db
    .select({ id: taxAgencies.liabilityAccountId })
    .from(taxAgencies)
    .where(eq(taxAgencies.companyId, ctx.companyId));
  for (const a of ag) if (a.id) ids.add(a.id);
  return ids;
}

export interface ReclassifyLineRow {
  lineId: string;
  entryId: string;
  entryNumber: number;
  date: string;
  description: string;
  sourceRef: string | null;
  /** Human label of the source document kind ('Invoice', 'Bill', 'Check', 'Journal', …). */
  sourceType: string;
  memo: string | null;
  debit: string | null;
  credit: string | null;
  classId: string | null;
  className: string | null;
}

const SOURCE_LABELS: Record<string, string> = {
  invoice: 'Invoice',
  salesreceipt: 'Sales Receipt',
  credit_memo: 'Credit Memo',
  bill: 'Bill',
  expense: 'Check / Expense',
  vendor_credit: 'Bill Credit',
  deposit: 'Deposit',
  payment: 'Payment',
  paycheck: 'Paycheck',
};

export function sourceTypeOf(sourceRef: string | null): string {
  if (!sourceRef) return 'Journal Entry';
  const prefix = sourceRef.split(':')[0];
  return SOURCE_LABELS[prefix] ?? 'Journal Entry';
}

/** Lines posted to `accountId` in the date range (QB's left/right panes). */
export async function listReclassifyLines(
  ctx: ServiceContext,
  input: { accountId: string; from?: Date; to?: Date; sourceType?: string | null },
): Promise<{ lines: ReclassifyLineRow[]; isControlAccount: boolean }> {
  const [acct] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, input.accountId)));
  if (!acct) throw notFound('Account');
  const conds = [
    eq(journalEntries.companyId, ctx.companyId),
    eq(journalEntries.status, 'posted'),
    eq(journalEntryLines.accountId, input.accountId),
  ];
  if (input.from) conds.push(gte(journalEntries.date, input.from));
  if (input.to) conds.push(lte(journalEntries.date, input.to));
  const rows = await ctx.db
    .select({
      lineId: journalEntryLines.id,
      entryId: journalEntries.id,
      entryNumber: journalEntries.entryNumber,
      date: journalEntries.date,
      description: journalEntries.description,
      sourceRef: journalEntries.sourceRef,
      memo: journalEntryLines.memo,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
      classId: journalEntryLines.classId,
      className: classes.name,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .leftJoin(classes, eq(journalEntryLines.classId, classes.id))
    .where(and(...conds))
    .orderBy(journalEntries.date, journalEntries.entryNumber)
    .limit(2000);
  const control = await controlAccountIds(ctx);
  const lines = rows
    .map((r) => ({
      lineId: r.lineId,
      entryId: r.entryId,
      entryNumber: r.entryNumber,
      date: r.date.toISOString(),
      description: r.description,
      sourceRef: r.sourceRef,
      sourceType: sourceTypeOf(r.sourceRef),
      memo: r.memo,
      debit: r.debit,
      credit: r.credit,
      classId: r.classId,
      className: r.className ?? null,
    }))
    .filter((r) => !input.sourceType || r.sourceType === input.sourceType);
  return { lines, isControlAccount: control.has(input.accountId) };
}

export interface ReclassifyInput {
  lineIds: string[];
  /** New account (omit to keep). */
  newAccountId?: string | null;
  /** New class: a class id, null to clear, undefined to keep. */
  newClassId?: string | null;
}

export interface ReclassifyResult {
  linesChanged: number;
  entriesChanged: number;
  documentsUpdated: number;
}

export async function reclassifyLines(ctx: ServiceContext, input: ReclassifyInput): Promise<ReclassifyResult> {
  const lineIds = [...new Set(input.lineIds ?? [])];
  if (lineIds.length === 0) throw validation('Select at least one line to reclassify.');
  if (lineIds.length > 2000) throw validation('Reclassify at most 2,000 lines at a time.');
  const changeAccount = Boolean(input.newAccountId);
  const changeClass = input.newClassId !== undefined;
  if (!changeAccount && !changeClass) throw validation('Choose a new account and/or a new class.');

  const control = await controlAccountIds(ctx);
  if (changeAccount) {
    const [target] = await ctx.db
      .select({ id: accounts.id, isActive: accounts.isActive })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, input.newAccountId!)));
    if (!target) throw notFound('New account');
    if (!target.isActive) throw validation('The new account is inactive.');
    if (control.has(target.id)) {
      throw validation(
        'That account is tied to a sub-ledger (bank, receivables, payables, credit card, inventory, sales tax or payroll) and cannot be a reclassify target.',
      );
    }
  }
  if (changeClass && input.newClassId) {
    const [cls] = await ctx.db
      .select({ id: classes.id })
      .from(classes)
      .where(and(eq(classes.companyId, ctx.companyId), eq(classes.id, input.newClassId)));
    if (!cls) throw notFound('Class');
  }

  return inTransaction(ctx, async (tx) => {
    const lines = await tx.db
      .select({
        id: journalEntryLines.id,
        accountId: journalEntryLines.accountId,
        classId: journalEntryLines.classId,
        debit: journalEntryLines.debit,
        credit: journalEntryLines.credit,
        entryId: journalEntries.id,
        status: journalEntries.status,
        date: journalEntries.date,
        entryNumber: journalEntries.entryNumber,
        description: journalEntries.description,
        sourceRef: journalEntries.sourceRef,
      })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
      .where(and(eq(journalEntries.companyId, tx.companyId), inArray(journalEntryLines.id, lineIds)));
    if (lines.length !== lineIds.length) throw notFound('One or more selected lines');
    for (const l of lines) {
      if (l.status !== 'posted') {
        throw new ServiceError('CONFLICT', `Entry #${l.entryNumber} is not posted (void or draft) and cannot be reclassified.`);
      }
      if (changeAccount && control.has(l.accountId)) {
        throw validation(
          `Entry #${l.entryNumber}: lines on bank, receivable, payable, credit card, inventory, sales tax or payroll accounts cannot be reclassified.`,
        );
      }
    }

    if (changeAccount) {
      const [cleared] = await tx.db
        .select({ id: reconciliationItems.id })
        .from(reconciliationItems)
        .innerJoin(reconciliations, eq(reconciliationItems.reconciliationId, reconciliations.id))
        .where(
          and(
            inArray(reconciliationItems.journalEntryLineId, lineIds),
            eq(reconciliationItems.isCleared, true),
            eq(reconciliations.status, 'completed'),
          ),
        )
        .limit(1);
      if (cleared) {
        throw new ServiceError('CONFLICT', 'A selected line was cleared in a completed reconciliation and cannot be moved.');
      }
    }

    // Closed periods (and closing-date exceptions) per distinct entry.
    const byEntry = new Map<string, typeof lines>();
    for (const l of lines) byEntry.set(l.entryId, [...(byEntry.get(l.entryId) ?? []), l]);
    const checks = new Map<string, Awaited<ReturnType<typeof assertPeriodOpen>>>();
    for (const [entryId, ls] of byEntry) checks.set(entryId, await assertPeriodOpen(tx, ls[0].date));

    // Which (entry, account) slices are moved COMPLETELY? Only those sync their source document.
    const fullSlices = new Set<string>();
    for (const [entryId, ls] of byEntry) {
      const counts = await tx.db
        .select({ accountId: journalEntryLines.accountId, n: sql<number>`COUNT(*)` })
        .from(journalEntryLines)
        .where(eq(journalEntryLines.journalEntryId, entryId))
        .groupBy(journalEntryLines.accountId);
      for (const c of counts) {
        const selected = ls.filter((l) => l.accountId === c.accountId).length;
        if (selected > 0 && selected === Number(c.n)) fullSlices.add(`${entryId}|${c.accountId}`);
      }
    }

    if (changeAccount) await allowLedgerRewrite(tx, 'reclassify');

    const set: Partial<{ accountId: string; classId: string | null }> = {};
    if (changeAccount) set.accountId = input.newAccountId!;
    if (changeClass) set.classId = input.newClassId ?? null;
    await tx.db.update(journalEntryLines).set(set).where(inArray(journalEntryLines.id, lineIds));
    await tx.db
      .update(journalEntries)
      .set({ updatedAt: new Date() })
      .where(inArray(journalEntries.id, [...byEntry.keys()]));

    // Keep source documents in step when an entry's whole slice on the old account moved.
    let documentsUpdated = 0;
    for (const [entryId, ls] of byEntry) {
      const ref = ls[0].sourceRef;
      if (!ref) continue;
      const [prefix, docId] = ref.split(':');
      if (!docId || !/^[0-9a-f-]{36}$/i.test(docId)) continue;
      for (const oldAccountId of new Set(ls.map((l) => l.accountId))) {
        if (!fullSlices.has(`${entryId}|${oldAccountId}`)) continue;
        const acctSet = changeAccount ? { accountId: input.newAccountId! } : {};
        const clsSet = changeClass ? { classId: input.newClassId ?? null } : {};
        let updated: Array<{ id: string }> = [];
        if (prefix === 'invoice') {
          updated = await tx.db
            .update(invoiceLines)
            .set({ ...acctSet, ...clsSet })
            .where(and(eq(invoiceLines.invoiceId, docId), eq(invoiceLines.accountId, oldAccountId)))
            .returning({ id: invoiceLines.id });
        } else if (prefix === 'salesreceipt') {
          updated = await tx.db
            .update(salesReceiptLines)
            .set({ ...acctSet, ...clsSet })
            .where(and(eq(salesReceiptLines.salesReceiptId, docId), eq(salesReceiptLines.accountId, oldAccountId)))
            .returning({ id: salesReceiptLines.id });
        } else if (prefix === 'bill') {
          updated = await tx.db
            .update(billLines)
            .set({ ...acctSet, ...clsSet })
            .where(and(eq(billLines.billId, docId), eq(billLines.accountId, oldAccountId)))
            .returning({ id: billLines.id });
        } else if (prefix === 'expense') {
          updated = await tx.db
            .update(expenseLines)
            .set({ ...acctSet, ...clsSet })
            .where(and(eq(expenseLines.expenseId, docId), eq(expenseLines.accountId, oldAccountId)))
            .returning({ id: expenseLines.id });
        } else if (prefix === 'credit_memo' && changeAccount) {
          updated = await tx.db
            .update(creditMemoLines)
            .set({ accountId: input.newAccountId! })
            .where(and(eq(creditMemoLines.creditMemoId, docId), eq(creditMemoLines.accountId, oldAccountId)))
            .returning({ id: creditMemoLines.id });
        }
        if (updated.length > 0) documentsUpdated += 1;
      }
    }

    for (const [entryId, ls] of byEntry) {
      await writeAudit(tx, {
        action: 'update',
        entityType: 'journal_entry',
        entityId: entryId,
        oldValues: {
          reclassify: ls.map((l) => ({ lineId: l.id, accountId: l.accountId, classId: l.classId })),
        },
        newValues: {
          reclassify: ls.map((l) => ({
            lineId: l.id,
            accountId: changeAccount ? input.newAccountId : l.accountId,
            classId: changeClass ? (input.newClassId ?? null) : l.classId,
            debit: l.debit ? toAmountString(l.debit) : null,
            credit: l.credit ? toAmountString(l.credit) : null,
          })),
          entryNumber: ls[0].entryNumber,
        },
      });
      await recordClosingDateException(tx, checks.get(entryId)!, {
        entryId,
        operation: 'reclassify',
        transactionDate: ls[0].date,
        entryNumber: ls[0].entryNumber,
        description: ls[0].description,
        sourceRef: ls[0].sourceRef,
      });
    }

    return { linesChanged: lines.length, entriesChanged: byEntry.size, documentsUpdated };
  });
}
