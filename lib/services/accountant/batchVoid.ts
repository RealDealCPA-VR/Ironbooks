/**
 * Batch Delete/Void Transactions (QB Accountant → Batch Delete/Void) — wave2 accountant, I6.
 *
 * Lists posted transactions (from the ledger, mapped back to their source documents) and voids
 * the selected ones ROW BY ROW through each document's own void service, so every existing rule
 * applies unchanged: dependent links (payments applied to an invoice, a deposited payment, a bill
 * with payments, a reconciled line…) are refused with the service's message, closed periods are
 * enforced, and each void is audited by its service. Draft journal entries (never posted) can be
 * deleted outright. Posted rows are never deleted — the ledger forbids it; voiding keeps history.
 *
 * Every batch run is additionally audited as one 'batch_void' record listing what happened.
 */
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  billPayments,
  deposits,
  expenses,
  journalEntries,
  journalEntryLines,
  paychecks,
  paymentsReceived,
  salesReceipts,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, ServiceError, inTransaction, notFound, writeAudit } from '../_base';
import { voidInvoice } from '../invoices';
import { voidSalesReceipt } from '../salesReceipts';
import { voidCreditMemo } from '../creditMemos';
import { voidPayment } from '../payments';
import { voidBill } from '../bills';
import { voidBillPayment } from '../billPayments';
import { voidExpense } from '../expenses';
import { voidDeposit } from '../deposits';
import { voidVendorCredit } from '../vendorCredits';
import { voidPaycheck } from '../payroll';
import { voidJournalEntry } from '../posting';
import { requirePermission } from '../access';
import { orphanedSalesTaxFixes, voidOrphanedSalesTaxFixes } from './salesTaxTools';
import type { Area } from '@/lib/permissions/model';

/** The area that owns each document type — voiding needs that area's delete right too (the route
 *  only guarantees accounting:delete). */
const VOID_AREA: Record<BatchTxnType, Area> = {
  invoice: 'customers',
  sales_receipt: 'customers',
  credit_memo: 'customers',
  payment: 'customers',
  bill: 'vendors',
  bill_payment: 'vendors',
  vendor_credit: 'vendors',
  check: 'banking',
  deposit: 'banking',
  paycheck: 'payroll',
  journal: 'accounting',
};

export const BATCH_TXN_TYPES = [
  'invoice',
  'sales_receipt',
  'credit_memo',
  'payment',
  'bill',
  'bill_payment',
  'check',
  'deposit',
  'vendor_credit',
  'paycheck',
  'journal',
] as const;
export type BatchTxnType = (typeof BATCH_TXN_TYPES)[number];

export const BATCH_TXN_LABELS: Record<BatchTxnType, string> = {
  invoice: 'Invoice',
  sales_receipt: 'Sales Receipt',
  credit_memo: 'Credit Memo',
  payment: 'Customer Payment',
  bill: 'Bill',
  bill_payment: 'Bill Payment',
  check: 'Check / Expense',
  deposit: 'Deposit',
  vendor_credit: 'Bill Credit',
  paycheck: 'Paycheck',
  journal: 'Journal Entry',
};

export interface BatchTxnRow {
  /** Stable selection key "<type>:<docId>". */
  key: string;
  type: BatchTxnType;
  typeLabel: string;
  docId: string;
  entryId: string | null;
  entryNumber: number | null;
  date: string;
  description: string;
  amount: string;
  status: 'posted' | 'draft';
}

const PREFIX_TYPE: Record<string, BatchTxnType> = {
  invoice: 'invoice',
  salesreceipt: 'sales_receipt',
  credit_memo: 'credit_memo',
  bill: 'bill',
  expense: 'check',
  vendor_credit: 'vendor_credit',
  manual: 'journal',
  tax_agency: 'journal',
  sales_tax_adj: 'journal',
  adjusting: 'journal',
};

/** Posted (and draft journal) transactions in the range, newest first. */
export async function listBatchTransactions(
  ctx: ServiceContext,
  filter: { from?: Date; to?: Date; type?: BatchTxnType | null; limit?: number } = {},
): Promise<BatchTxnRow[]> {
  const conds = [eq(journalEntries.companyId, ctx.companyId), sql`${journalEntries.status} IN ('posted', 'draft')`];
  if (filter.from) conds.push(gte(journalEntries.date, filter.from));
  if (filter.to) conds.push(lte(journalEntries.date, filter.to));
  const entries = await ctx.db
    .select({
      id: journalEntries.id,
      entryNumber: journalEntries.entryNumber,
      date: journalEntries.date,
      description: journalEntries.description,
      sourceRef: journalEntries.sourceRef,
      status: journalEntries.status,
      // Fully qualified: drizzle renders bare column names here, and an unqualified "id" inside the
      // subquery would bind to journal_entry_lines.id (always 0).
      amount: sql<string>`COALESCE((SELECT SUM(jel.debit) FROM journal_entry_lines jel WHERE jel.journal_entry_id = "journal_entries"."id"), 0)`,
    })
    .from(journalEntries)
    .where(and(...conds))
    .orderBy(sql`${journalEntries.date} DESC`, sql`${journalEntries.entryNumber} DESC`)
    .limit(Math.min(filter.limit ?? 500, 2000));
  if (entries.length === 0) return [];

  // Documents that point at their entry (their sourceRef is not "<type>:<docId>").
  const ids = entries.map((e) => e.id);
  const byEntry = new Map<string, { type: BatchTxnType; docId: string }>();
  const pointers: Array<[BatchTxnType, Array<{ id: string; entryId: string | null }>]> = [
    [
      'payment',
      await ctx.db
        .select({ id: paymentsReceived.id, entryId: paymentsReceived.postedEntryId })
        .from(paymentsReceived)
        .where(and(eq(paymentsReceived.companyId, ctx.companyId), inArray(paymentsReceived.postedEntryId, ids))),
    ],
    [
      'bill_payment',
      await ctx.db
        .select({ id: billPayments.id, entryId: billPayments.postedEntryId })
        .from(billPayments)
        .where(and(eq(billPayments.companyId, ctx.companyId), inArray(billPayments.postedEntryId, ids))),
    ],
    [
      'deposit',
      await ctx.db
        .select({ id: deposits.id, entryId: deposits.postedEntryId })
        .from(deposits)
        .where(and(eq(deposits.companyId, ctx.companyId), inArray(deposits.postedEntryId, ids))),
    ],
    [
      'check',
      await ctx.db
        .select({ id: expenses.id, entryId: expenses.postedEntryId })
        .from(expenses)
        .where(and(eq(expenses.companyId, ctx.companyId), inArray(expenses.postedEntryId, ids))),
    ],
    [
      'paycheck',
      await ctx.db
        .select({ id: paychecks.id, entryId: paychecks.postedEntryId })
        .from(paychecks)
        .where(and(eq(paychecks.companyId, ctx.companyId), inArray(paychecks.postedEntryId, ids))),
    ],
  ];
  for (const [type, rows] of pointers) for (const r of rows) if (r.entryId) byEntry.set(r.entryId, { type, docId: r.id });

  const out: BatchTxnRow[] = [];
  for (const e of entries) {
    let mapped = byEntry.get(e.id);
    if (!mapped) {
      const [prefix, docId] = (e.sourceRef ?? 'manual').split(':');
      const type = PREFIX_TYPE[prefix];
      if (!type) continue; // secondary entries (COGS, refunds, inventory…) are voided with their document
      mapped = { type, docId: type === 'journal' ? e.id : (docId ?? e.id) };
    }
    if (filter.type && mapped.type !== filter.type) continue;
    out.push({
      key: `${mapped.type}:${mapped.docId}`,
      type: mapped.type,
      typeLabel: BATCH_TXN_LABELS[mapped.type],
      docId: mapped.docId,
      entryId: e.id,
      entryNumber: e.entryNumber,
      date: e.date.toISOString(),
      description: e.description,
      amount: toAmountString(e.amount),
      status: e.status === 'draft' ? 'draft' : 'posted',
    });
  }
  // A document can own several entries that share its sourceRef (a sales receipt's COGS entry reuses
  // salesreceipt:<id>). List each document once, on the entry the document itself points to.
  const dupKeys = new Set<string>();
  const seenKeys = new Set<string>();
  for (const r of out) (seenKeys.has(r.key) ? dupKeys : seenKeys).add(r.key);
  if (dupKeys.size === 0) return out;
  const receiptIds = out.filter((r) => dupKeys.has(r.key) && r.type === 'sales_receipt').map((r) => r.docId);
  const primary = new Map<string, string>();
  if (receiptIds.length > 0) {
    const heads = await ctx.db
      .select({ id: salesReceipts.id, entryId: salesReceipts.postedEntryId })
      .from(salesReceipts)
      .where(and(eq(salesReceipts.companyId, ctx.companyId), inArray(salesReceipts.id, [...new Set(receiptIds)])));
    for (const h of heads) if (h.entryId) primary.set(`sales_receipt:${h.id}`, h.entryId);
  }
  const chosen = new Map<string, BatchTxnRow>();
  for (const r of out) {
    const cur = chosen.get(r.key);
    if (!cur) chosen.set(r.key, r);
    else if (primary.get(r.key) === r.entryId) chosen.set(r.key, r);
  }
  return out.filter((r) => chosen.get(r.key) === r);
}

export interface BatchVoidResult {
  key: string;
  ok: boolean;
  action: 'void' | 'delete';
  error?: string;
}

async function voidOne(ctx: ServiceContext, type: BatchTxnType, id: string): Promise<'void' | 'delete'> {
  requirePermission(ctx, VOID_AREA[type] ?? 'accounting', 'delete');
  switch (type) {
    case 'invoice':
      await voidInvoice(ctx, id);
      return 'void';
    case 'sales_receipt':
      await voidSalesReceipt(ctx, id);
      return 'void';
    case 'credit_memo':
      await voidCreditMemo(ctx, id);
      return 'void';
    case 'payment':
      await voidPayment(ctx, id);
      return 'void';
    case 'bill':
      await voidBill(ctx, id);
      return 'void';
    case 'bill_payment':
      await voidBillPayment(ctx, id);
      return 'void';
    case 'check':
      await voidExpense(ctx, id);
      return 'void';
    case 'deposit':
      await voidDeposit(ctx, id);
      return 'void';
    case 'vendor_credit':
      await voidVendorCredit(ctx, id);
      return 'void';
    case 'paycheck':
      await voidPaycheck(ctx, id);
      return 'void';
    case 'journal': {
      const [entry] = await ctx.db
        .select()
        .from(journalEntries)
        .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.id, id)));
      if (!entry) throw notFound('Journal entry');
      if (entry.sourceRef && !['manual', 'tax_agency', 'sales_tax_adj', 'adjusting'].includes(entry.sourceRef.split(':')[0])) {
        throw new ServiceError('CONFLICT', 'This entry belongs to a document — void the document instead.');
      }
      const srcKind = entry.sourceRef?.split(':')[0];
      if (srcKind === 'tax_agency' || srcKind === 'sales_tax_adj') requirePermission(ctx, 'sales_tax', 'delete');
      if (entry.status === 'draft') {
        // Never posted → no ledger impact; deleting it is safe (QB "delete").
        await inTransaction(ctx, async (tx) => {
          const lines = await tx.db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, id));
          const total = lines.reduce((sum, l) => sum.plus(Money.of(l.debit ?? '0')), Money.zero());
          await tx.db.delete(journalEntryLines).where(eq(journalEntryLines.journalEntryId, id));
          await tx.db.delete(journalEntries).where(eq(journalEntries.id, id));
          await writeAudit(tx, {
            action: 'delete',
            entityType: 'journal_entry',
            entityId: id,
            oldValues: {
              entryNumber: entry.entryNumber,
              date: entry.date,
              description: entry.description,
              status: 'draft',
              total: toAmountString(total),
              lines,
            },
          });
        });
        return 'delete';
      }
      await voidJournalEntry(ctx, id);
      return 'void';
    }
    default:
      throw new ServiceError('VALIDATION', `Unsupported transaction type ${type as string}.`);
  }
}

/** Void (or delete, for drafts) each selected transaction; one failure never stops the batch. */
export async function batchVoidTransactions(
  ctx: ServiceContext,
  keys: string[],
): Promise<{ results: BatchVoidResult[]; succeeded: number; failed: number; salesTaxFixesVoided: number }> {
  const unique = [...new Set(keys ?? [])];
  if (unique.length === 0) throw new ServiceError('VALIDATION', 'Select at least one transaction.');
  if (unique.length > 500) throw new ServiceError('VALIDATION', 'Void at most 500 transactions at a time.');
  // Corrections already orphaned before this batch are not this batch's to clean up.
  const preexisting = new Set((await orphanedSalesTaxFixes(ctx)).map((o) => o.entryId));
  const results: BatchVoidResult[] = [];
  for (const key of unique) {
    const [type, id] = key.split(':') as [BatchTxnType, string];
    if (!BATCH_TXN_TYPES.includes(type) || !id) {
      results.push({ key, ok: false, action: 'void', error: 'Unknown transaction.' });
      continue;
    }
    try {
      const action = await voidOne(ctx, type, id);
      results.push({ key, ok: true, action });
    } catch (err) {
      results.push({
        key,
        ok: false,
        action: 'void',
        error: err instanceof Error ? err.message : 'Could not void this transaction.',
      });
    }
  }
  const succeeded = results.filter((r) => r.ok).length;
  let salesTaxFixesVoided = 0;
  if (succeeded > 0) {
    // A voided check/bill that had been "counted as a tax payment" (Fix Sales Tax) must take its
    // correcting entry with it, or the agency would show a payment that never happened.
    // Only corrections orphaned by this batch are voided. That is the same check/bill the user was
    // allowed to void, so no separate Sales Tax right is needed.
    salesTaxFixesVoided = await voidOrphanedSalesTaxFixes(ctx, preexisting);
    await inTransaction(ctx, (tx) =>
      writeAudit(tx, {
        action: 'void',
        entityType: 'batch_void',
        entityId: randomUUID(),
        newValues: { results, succeeded, failed: results.length - succeeded, total: results.length, salesTaxFixesVoided },
      }),
    );
  }
  return { results, succeeded, failed: results.length - succeeded, salesTaxFixesVoided };
}
