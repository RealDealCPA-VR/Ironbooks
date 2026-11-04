/**
 * Batch Delete/Void Transactions (QB Accountant → Batch Delete/Void) — wave2 accountant, I6.
 *
 * Lists transactions — posted ones from the ledger (mapped back to their source documents) plus
 * the non-posting estimates, sales orders and purchase orders — and voids or deletes the selected
 * ones ROW BY ROW through each document's own service, so every existing rule applies unchanged:
 * dependent links (payments applied to an invoice, a deposited payment, a bill with payments, a
 * reconciled line, an estimate already invoiced…) are refused with the service's message, closed
 * periods and the closing-date password are enforced, Accountant's Copy limits apply, and each
 * void / delete is audited by its service. A row may carry the version it was listed with
 * (record locking): a transaction someone changed since is refused, not voided blind.
 *
 * Void (every type) keeps the transaction on file with zero amounts. Delete (QB "Batch Delete")
 * is offered where QuickBooks offers it:
 *   - draft journal entries (never posted) are removed outright;
 *   - posted General Journal entries — unless reconciled, applied to invoices / bills, in a closed
 *     period without the password, or in an Accountant's Copy — are voided and hidden from the
 *     Journal (journal_entries.deleted_at; the ledger never removes a posted row);
 *   - estimates, sales orders and purchase orders through their delete services.
 * Every delete keeps a snapshot in the audit trail (entity 'batch_deleted_txn'), and Restore
 * re-creates the transaction from it through the normal create service (createManualEntry,
 * createEstimate, createSalesOrder, createPurchaseOrder) — so closing date, numbering and audit
 * apply again — and marks the snapshot restored.
 *
 * Every batch run is additionally audited as one 'batch_void' record listing what happened.
 */
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  accounts,
  auditLogs,
  billPayments,
  deposits,
  estimateLines,
  estimates,
  expenses,
  itemReceipts,
  items,
  journalEntries,
  journalEntryLines,
  paychecks,
  paymentsReceived,
  purchaseOrderLines,
  purchaseOrders,
  salesOrderLines,
  salesOrders,
  salesReceipts,
  transfers,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, ServiceError, inTransaction, notFound, validation, writeAudit } from '../_base';
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
import { voidTransfer } from '../transfers';
import { voidItemReceipt } from '../itemReceipts';
import { createEstimate, deleteEstimate, voidEstimate } from '../estimates';
import { createSalesOrder, deleteSalesOrder, voidSalesOrder } from '../salesOrders';
import { createPurchaseOrder, deletePurchaseOrder, voidPurchaseOrder } from '../purchaseOrders';
import { voidJournalEntry } from '../posting';
import { createManualEntry, voidEntry } from '../journal';
import { assertNotFifoTracked } from '../inventory';
import { reverseSourceMovements } from '../inventorySites';
import { refuseInAccountantCopy } from '../nonPostingDocs';
import { type VersionedEntity, assertCurrentVersion } from '../concurrency';
import { requirePermission } from '../access';
import { orphanedSalesTaxFixes, voidOrphanedSalesTaxFixes } from './salesTaxTools';
import type { AccessRef } from '@/lib/permissions/model';

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
  'transfer',
  'item_receipt',
  'inventory_adjustment',
  'estimate',
  'sales_order',
  'purchase_order',
] as const;
export type BatchTxnType = (typeof BATCH_TXN_TYPES)[number];

/** The area that owns each document type — voiding needs that area's delete right too (the route
 *  only guarantees accounting:delete). */
const VOID_AREA: Record<BatchTxnType, AccessRef> = {
  // prefsperms: the document's own activity (Invoices, Receive Payments, Pay Bills, …).
  invoice: 'customers.invoices',
  sales_receipt: 'customers.sales_receipts',
  credit_memo: 'customers.credit_memos',
  payment: 'customers.payments',
  bill: 'vendors.bills',
  bill_payment: 'vendors.pay_bills',
  vendor_credit: 'vendors.vendor_credits',
  check: 'banking.write_checks',
  deposit: 'banking.deposits',
  paycheck: 'payroll.paychecks',
  journal: 'accounting.journal_entries',
  transfer: 'accounting.transfers',
  // Receive Items / Adjust Quantity have no Delete activity: the whole Inventory area (fail closed).
  item_receipt: 'inventory',
  inventory_adjustment: 'inventory',
  estimate: 'customers.estimates',
  sales_order: 'customers.sales_orders',
  purchase_order: 'vendors.purchase_orders',
};

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
  transfer: 'Transfer',
  item_receipt: 'Item Receipt',
  inventory_adjustment: 'Inventory Adjustment',
  estimate: 'Estimate',
  sales_order: 'Sales Order',
  purchase_order: 'Purchase Order',
};

/** The record-locking entity of each type (lib/services/concurrency.ts); null = not versioned. */
const VERSION_ENTITY: Record<BatchTxnType, VersionedEntity | null> = {
  invoice: 'invoice',
  sales_receipt: 'sales_receipt',
  credit_memo: 'credit_memo',
  payment: 'payment_received',
  bill: 'bill',
  bill_payment: 'bill_payment',
  check: 'expense',
  deposit: 'deposit',
  vendor_credit: 'vendor_credit',
  paycheck: 'paycheck',
  journal: 'journal_entry',
  transfer: 'transfer',
  item_receipt: 'item_receipt',
  inventory_adjustment: 'journal_entry',
  estimate: 'estimate',
  sales_order: 'sales_order',
  purchase_order: 'purchase_order',
};

/** Types QuickBooks lets Batch Delete remove (the rest are voided). */
const DELETABLE: ReadonlySet<BatchTxnType> = new Set(['journal', 'estimate', 'sales_order', 'purchase_order']);

export interface BatchTxnRow {
  /** Stable selection key "<type>:<docId>". */
  key: string;
  type: BatchTxnType;
  typeLabel: string;
  docId: string;
  entryId: string | null;
  entryNumber: number | null;
  /** Document number of a non-posting document (estimate / order number). */
  refNumber?: string | null;
  date: string;
  description: string;
  amount: string;
  status: 'posted' | 'draft' | 'open' | 'void' | 'closed';
  /** Whether Delete (not only Void) is offered for this row. */
  canDelete: boolean;
  /** Record-locking version when listed (sent back with the selection). */
  version: string | null;
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
  transfer: 'transfer',
  item_receipt: 'item_receipt',
  item: 'inventory_adjustment',
};

/** sourceRef kinds of General Journal entries a user entered (deletable when posted). */
const GJ_KINDS = new Set(['manual']);

const kindOf = (sourceRef: string | null) => (sourceRef ?? 'manual').split(':')[0];

/** Current versions of the listed rows, per type, in bulk. */
async function versionsFor(ctx: ServiceContext, rows: BatchTxnRow[]): Promise<void> {
  const schema = await import('@/lib/db/schema');
  const map: Partial<Record<BatchTxnType, any>> = {
    invoice: schema.invoices,
    sales_receipt: schema.salesReceipts,
    credit_memo: schema.creditMemos,
    payment: schema.paymentsReceived,
    bill: schema.bills,
    bill_payment: schema.billPayments,
    check: schema.expenses,
    deposit: schema.deposits,
    vendor_credit: schema.vendorCredits,
    paycheck: schema.paychecks,
    journal: schema.journalEntries,
    transfer: schema.transfers,
    item_receipt: schema.itemReceipts,
    inventory_adjustment: schema.journalEntries,
    estimate: schema.estimates,
    sales_order: schema.salesOrders,
    purchase_order: schema.purchaseOrders,
  };
  const byType = new Map<BatchTxnType, BatchTxnRow[]>();
  for (const r of rows) (byType.get(r.type) ?? byType.set(r.type, []).get(r.type)!).push(r);
  for (const [type, list] of byType) {
    const table = map[type];
    if (!table?.updatedAt) continue;
    const ids = [...new Set(list.map((r) => r.docId))];
    const found = (await ctx.db
      .select({ id: table.id, v: table.updatedAt })
      .from(table)
      .where(and(eq(table.companyId, ctx.companyId), inArray(table.id, ids)))) as Array<{ id: string; v: Date | null }>;
    const v = new Map(found.map((f) => [f.id, f.v ? f.v.toISOString() : null]));
    for (const r of list) r.version = v.get(r.docId) ?? null;
  }
}

/** Posted (and draft journal) transactions plus estimates / orders in the range, newest first. */
export async function listBatchTransactions(
  ctx: ServiceContext,
  filter: { from?: Date; to?: Date; type?: BatchTxnType | null; limit?: number } = {},
): Promise<BatchTxnRow[]> {
  const limit = Math.min(filter.limit ?? 500, 2000);
  const nonPosting = filter.type === 'estimate' || filter.type === 'sales_order' || filter.type === 'purchase_order';
  const out: BatchTxnRow[] = [];

  if (!nonPosting) {
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
      .limit(limit);

    if (entries.length > 0) {
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
        [
          'transfer',
          await ctx.db
            .select({ id: transfers.id, entryId: transfers.postedEntryId })
            .from(transfers)
            .where(and(eq(transfers.companyId, ctx.companyId), inArray(transfers.postedEntryId, ids))),
        ],
        [
          'item_receipt',
          await ctx.db
            .select({ id: itemReceipts.id, entryId: itemReceipts.postedEntryId })
            .from(itemReceipts)
            .where(and(eq(itemReceipts.companyId, ctx.companyId), inArray(itemReceipts.postedEntryId, ids))),
        ],
      ];
      for (const [type, rows] of pointers) for (const r of rows) if (r.entryId) byEntry.set(r.entryId, { type, docId: r.id });

      for (const e of entries) {
        let mapped = byEntry.get(e.id);
        if (!mapped) {
          const [prefix, docId] = (e.sourceRef ?? 'manual').split(':');
          const type = PREFIX_TYPE[prefix];
          if (!type) continue; // secondary entries (COGS, refunds…) are voided with their document
          // Journal entries and inventory adjustments are keyed by the entry itself.
          mapped = { type, docId: type === 'journal' || type === 'inventory_adjustment' ? e.id : (docId ?? e.id) };
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
          canDelete: mapped.type === 'journal' && (e.status === 'draft' || GJ_KINDS.has(kindOf(e.sourceRef))),
          version: null,
        });
      }
    }
  }

  // Non-posting documents (QB lists estimates, sales orders and purchase orders here too).
  if (!filter.type || nonPosting) {
    const range = <T extends { date: any }>(t: T) => [
      ...(filter.from ? [gte(t.date, filter.from)] : []),
      ...(filter.to ? [lte(t.date, filter.to)] : []),
    ];
    if (!filter.type || filter.type === 'estimate') {
      const rows = await ctx.db
        .select({ id: estimates.id, n: estimates.estimateNumber, ref: estimates.refNumber, date: estimates.date, total: estimates.total, memo: estimates.memo, status: estimates.status })
        .from(estimates)
        .where(and(eq(estimates.companyId, ctx.companyId), ...range(estimates)))
        .orderBy(desc(estimates.date))
        .limit(limit);
      for (const r of rows) out.push(npRow('estimate', r.id, r.ref ?? String(r.n ?? ''), r.date, r.memo, r.total, String(r.status)));
    }
    if (!filter.type || filter.type === 'sales_order') {
      const rows = await ctx.db
        .select({ id: salesOrders.id, n: salesOrders.orderNumber, ref: salesOrders.refNumber, date: salesOrders.date, total: salesOrders.total, memo: salesOrders.memo, status: salesOrders.status })
        .from(salesOrders)
        .where(and(eq(salesOrders.companyId, ctx.companyId), ...range(salesOrders)))
        .orderBy(desc(salesOrders.date))
        .limit(limit);
      for (const r of rows) out.push(npRow('sales_order', r.id, r.ref ?? String(r.n ?? ''), r.date, r.memo, r.total, String(r.status)));
    }
    if (!filter.type || filter.type === 'purchase_order') {
      const rows = await ctx.db
        .select({ id: purchaseOrders.id, n: purchaseOrders.poNumber, ref: purchaseOrders.refNumber, date: purchaseOrders.date, total: purchaseOrders.total, memo: purchaseOrders.memo, status: purchaseOrders.status })
        .from(purchaseOrders)
        .where(and(eq(purchaseOrders.companyId, ctx.companyId), ...range(purchaseOrders)))
        .orderBy(desc(purchaseOrders.date))
        .limit(limit);
      for (const r of rows) out.push(npRow('purchase_order', r.id, r.ref ?? String(r.n ?? ''), r.date, r.memo, r.total, String(r.status)));
    }
  }

  // A document can own several entries that share its sourceRef (a sales receipt's COGS entry reuses
  // salesreceipt:<id>). List each document once, on the entry the document itself points to.
  const dupKeys = new Set<string>();
  const seenKeys = new Set<string>();
  for (const r of out) (seenKeys.has(r.key) ? dupKeys : seenKeys).add(r.key);
  let result = out;
  if (dupKeys.size > 0) {
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
    result = out.filter((r) => chosen.get(r.key) === r);
  }
  result.sort((a, b) => b.date.localeCompare(a.date));
  await versionsFor(ctx, result);
  return result;
}

function npRow(type: 'estimate' | 'sales_order' | 'purchase_order', id: string, ref: string, date: Date, memo: string | null, total: string, status: string): BatchTxnRow {
  return {
    key: `${type}:${id}`,
    type,
    typeLabel: BATCH_TXN_LABELS[type],
    docId: id,
    entryId: null,
    entryNumber: null,
    refNumber: ref || null,
    date: date.toISOString(),
    description: `${BATCH_TXN_LABELS[type]}${ref ? ` ${ref}` : ''}${memo ? ` — ${memo}` : ''}`,
    amount: toAmountString(total ?? '0'),
    status: status === 'void' ? 'void' : status === 'closed' ? 'closed' : 'open',
    canDelete: true,
    version: null,
  };
}

export interface BatchVoidResult {
  key: string;
  ok: boolean;
  action: 'void' | 'delete';
  error?: string;
}

// ---------------------------------------------------------------------------
// Inventory adjustment void
// ---------------------------------------------------------------------------

/**
 * Void an inventory quantity adjustment (QB: delete / void the Adjust Quantity/Value on Hand
 * transaction): its entry is voided (closing-date and reconciliation checks of voidJournalEntry),
 * the item's quantity goes back by the adjusted units and its value by the entry's inventory amount
 * (new average cost = remaining value / remaining quantity), and site / bin / serial / lot
 * movements recorded for it are reversed. Refused for FIFO-costed items (their cost layers would
 * no longer match) and when the stock it added has since been sold.
 */
export async function voidInventoryAdjustment(ctx: ServiceContext, entryId: string): Promise<void> {
  requirePermission(ctx, 'inventory', 'delete');
  await inTransaction(ctx, async (tx) => {
    const [entry] = await tx.db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, tx.companyId), eq(journalEntries.id, entryId)));
    if (!entry || kindOf(entry.sourceRef) !== 'item') throw notFound('Inventory adjustment');
    if (entry.status === 'void') return;
    const itemId = entry.sourceRef!.split(':')[1];
    // The adjustment's own audit row says how many units it moved.
    const [audit] = await tx.db
      .select({ oldValues: auditLogs.oldValues, newValues: auditLogs.newValues })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.companyId, tx.companyId),
          eq(auditLogs.entityType, 'item'),
          eq(auditLogs.entityId, itemId),
          sql`${auditLogs.newValues}->>'postedEntryId' = ${entryId}`,
        ),
      )
      .limit(1);
    const before = (audit?.oldValues ?? null) as { quantityOnHand?: string | null } | null;
    const after = (audit?.newValues ?? null) as { quantityOnHand?: string | null } | null;
    if (!before?.quantityOnHand || !after?.quantityOnHand) {
      throw new ServiceError('CONFLICT', 'This entry is not a quantity adjustment Batch Delete/Void can undo (for example an opening stock or value change). Open the item to change it.');
    }
    await assertNotFifoTracked(tx, itemId);
    const qtyChange = Money.of(after.quantityOnHand).minus(Money.of(before.quantityOnHand));
    const lines = await tx.db
      .select({ debit: journalEntryLines.debit, credit: journalEntryLines.credit, subtype: accounts.subtype })
      .from(journalEntryLines)
      .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
      .where(eq(journalEntryLines.journalEntryId, entryId));
    const valueChange = lines
      .filter((l) => String(l.subtype) === 'inventory')
      .reduce((s, l) => s.plus(Money.of(l.debit ?? 0)).minus(Money.of(l.credit ?? 0)), Money.zero());
    const [item] = await tx.db.select().from(items).where(and(eq(items.companyId, tx.companyId), eq(items.id, itemId)));
    if (!item) throw notFound('Item');
    const qoh = Money.of(item.quantityOnHand ?? 0);
    const avg = Money.of(item.averageCost ?? 0);
    const newQty = qoh.minus(qtyChange);
    if (newQty.isNegative()) {
      throw new ServiceError('CONFLICT', `The ${toAmountString(qtyChange)} units this adjustment added to ${item.name} have since been sold or used, so it can't be voided.`);
    }
    const newValue = qoh.times(avg).minus(valueChange);
    const newAvg = newQty.isZero() ? Money.zero() : newValue.div(newQty);
    await voidJournalEntry(tx, entryId);
    await reverseSourceMovements(tx, 'adjustment', entryId);
    await tx.db
      .update(items)
      .set({ quantityOnHand: newQty.toFixed(4), averageCost: (newAvg.isNegative() ? Money.zero() : newAvg).toFixed(4), updatedAt: new Date() })
      .where(eq(items.id, itemId));
    await writeAudit(tx, {
      action: 'void',
      entityType: 'inventory_adjustment',
      entityId: entryId,
      oldValues: { itemId, quantityOnHand: item.quantityOnHand, averageCost: item.averageCost },
      newValues: { quantityOnHand: newQty.toFixed(4), averageCost: newAvg.toFixed(4), quantityReversed: toAmountString(qtyChange), valueReversed: toAmountString(valueChange) },
    });
  });
}

// ---------------------------------------------------------------------------
// Delete with a restorable snapshot
// ---------------------------------------------------------------------------

/** Audit entity of a restorable Batch Delete snapshot. */
export const DELETED_SNAPSHOT_ENTITY = 'batch_deleted_txn';

interface DeletedSnapshot {
  type: 'journal' | 'estimate' | 'sales_order' | 'purchase_order';
  docId: string;
  label: string;
  date: string;
  amount: string;
  /** The create-service input that re-creates it (dates as ISO strings). */
  restore: Record<string, unknown>;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

async function snapshotFor(ctx: ServiceContext, type: DeletedSnapshot['type'], id: string): Promise<DeletedSnapshot> {
  if (type === 'journal') {
    const [e] = await ctx.db.select().from(journalEntries).where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.id, id)));
    if (!e) throw notFound('Journal entry');
    const lines = await ctx.db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, id));
    const amount = lines.reduce((s, l) => s.plus(Money.of(l.debit ?? 0)), Money.zero());
    return {
      type,
      docId: id,
      label: `Journal Entry #${e.entryNumber}${e.reference ? ` (${e.reference})` : ''} — ${e.description}`,
      date: e.date.toISOString(),
      amount: toAmountString(amount),
      restore: {
        date: e.date.toISOString(),
        description: e.description,
        reference: e.reference,
        isAdjusting: e.isAdjusting,
        lines: lines.map((l) => ({
          accountId: l.accountId,
          debit: l.debit,
          credit: l.credit,
          memo: l.memo,
          classId: l.classId,
          ...(l.entityType && l.entityId ? { entityType: l.entityType, entityId: l.entityId } : {}),
        })),
      },
    };
  }
  if (type === 'estimate') {
    const [h] = await ctx.db.select().from(estimates).where(and(eq(estimates.companyId, ctx.companyId), eq(estimates.id, id)));
    if (!h) throw notFound('Estimate');
    const lines = await ctx.db.select().from(estimateLines).where(eq(estimateLines.estimateId, id)).orderBy(estimateLines.lineOrder);
    return {
      type,
      docId: id,
      label: `Estimate ${h.refNumber ?? h.estimateNumber ?? ''}`.trim(),
      date: h.date.toISOString(),
      amount: toAmountString(h.total),
      restore: {
        refNumber: h.refNumber ?? null,
        allowDuplicateNumber: true,
        customerId: h.customerId,
        date: h.date.toISOString(),
        expirationDate: iso(h.expirationDate),
        memo: h.memo,
        taxRateId: h.taxRateId ?? null,
        shipTo: h.shipTo ?? null,
        customerMessageId: h.customerMessageId ?? null,
        lines: lines.map((l) => ({ itemId: l.itemId, description: l.description, quantity: l.quantity, rate: l.rate, taxable: l.taxable, salesTaxCodeId: l.salesTaxCodeId, classId: l.classId })),
      },
    };
  }
  if (type === 'sales_order') {
    const [h] = await ctx.db.select().from(salesOrders).where(and(eq(salesOrders.companyId, ctx.companyId), eq(salesOrders.id, id)));
    if (!h) throw notFound('Sales order');
    const lines = await ctx.db.select().from(salesOrderLines).where(eq(salesOrderLines.salesOrderId, id)).orderBy(salesOrderLines.lineOrder);
    return {
      type,
      docId: id,
      label: `Sales Order ${h.refNumber ?? h.orderNumber ?? ''}`.trim(),
      date: h.date.toISOString(),
      amount: toAmountString(h.total),
      restore: {
        refNumber: h.refNumber ?? null,
        allowDuplicateNumber: true,
        customerId: h.customerId,
        date: h.date.toISOString(),
        memo: h.memo,
        taxRateId: h.taxRateId ?? null,
        shipDate: iso(h.shipDate),
        shipVia: h.shipVia,
        fob: h.fob,
        trackingNumber: h.trackingNumber,
        shipTo: h.shipTo ?? null,
        poNumber: h.poNumber,
        customerMessageId: h.customerMessageId ?? null,
        lines: lines.map((l) => ({ itemId: l.itemId, description: l.description, quantity: l.quantity, rate: l.rate, taxable: l.taxable, salesTaxCodeId: l.salesTaxCodeId })),
      },
    };
  }
  const [h] = await ctx.db.select().from(purchaseOrders).where(and(eq(purchaseOrders.companyId, ctx.companyId), eq(purchaseOrders.id, id)));
  if (!h) throw notFound('Purchase order');
  const lines = await ctx.db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, id)).orderBy(purchaseOrderLines.lineOrder);
  return {
    type,
    docId: id,
    label: `Purchase Order ${h.refNumber ?? h.poNumber ?? ''}`.trim(),
    date: h.date.toISOString(),
    amount: toAmountString(h.total),
    restore: {
      refNumber: h.refNumber ?? null,
      allowDuplicateNumber: true,
      vendorId: h.vendorId,
      date: h.date.toISOString(),
      expectedDate: iso(h.expectedDate),
      memo: h.memo,
      shipTo: h.shipTo ?? null,
      shipToCustomerId: h.shipToCustomerId ?? null,
      lines: lines.map((l) => ({ itemId: l.itemId, accountId: l.accountId, description: l.description, quantity: l.quantity, rate: l.rate, customerId: l.customerId, jobId: l.jobId, classId: l.classId })),
    },
  };
}

/**
 * Delete a posted General Journal entry where QuickBooks allows it: a user-entered entry, not
 * applied to invoices / bills, not reconciled, not in a closed period (without the password), and
 * not in an Accountant's Copy. The ledger keeps every posted row, so it is voided (its amounts
 * reversed) and hidden from the Journal (deleted_at).
 */
async function deletePostedJournalEntry(ctx: ServiceContext, id: string): Promise<void> {
  await refuseInAccountantCopy(ctx, 'Deleting a journal entry', 'Void it instead.');
  await inTransaction(ctx, async (tx) => {
    // voidEntry: journal-screen entries only, no applications, Accountant's Copy, closed period,
    // reconciled lines.
    await voidEntry(tx, id);
    await tx.db
      .update(journalEntries)
      .set({ deletedAt: new Date() })
      .where(and(eq(journalEntries.companyId, tx.companyId), eq(journalEntries.id, id)));
  });
}

async function deleteOne(ctx: ServiceContext, type: BatchTxnType, id: string): Promise<void> {
  if (!DELETABLE.has(type)) {
    throw new ServiceError('CONFLICT', `${BATCH_TXN_LABELS[type]}s can't be deleted in a batch — void it instead (QuickBooks keeps them on file).`);
  }
  requirePermission(ctx, VOID_AREA[type], 'delete');
  if (type === 'journal') {
    const [entry] = await ctx.db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.id, id)));
    if (!entry || entry.deletedAt) throw notFound('Journal entry');
    if (entry.status === 'draft') {
      await deleteDraftEntry(ctx, entry);
      return;
    }
    if (!GJ_KINDS.has(kindOf(entry.sourceRef))) {
      throw new ServiceError('CONFLICT', 'Only General Journal entries you entered can be deleted; void this one instead.');
    }
    if (entry.status === 'void') throw new ServiceError('CONFLICT', 'This entry is already void.');
  }
  const snap = await snapshotFor(ctx, type as DeletedSnapshot['type'], id);
  await inTransaction(ctx, async (tx) => {
    if (type === 'journal') await deletePostedJournalEntry(tx, id);
    else if (type === 'estimate') await deleteEstimate(tx, id);
    else if (type === 'sales_order') await deleteSalesOrder(tx, id);
    else await deletePurchaseOrder(tx, id);
    if (type === 'journal') {
      // The Voided/Deleted report reads the journal entry's 'delete' audit row.
      await writeAudit(tx, {
        action: 'delete',
        entityType: 'journal_entry',
        entityId: id,
        oldValues: { ...snap.restore, status: 'posted', total: snap.amount },
      });
    }
    await writeAudit(tx, {
      action: 'delete',
      entityType: DELETED_SNAPSHOT_ENTITY,
      entityId: randomUUID(),
      oldValues: snap as unknown as Record<string, unknown>,
    });
  });
}

async function deleteDraftEntry(ctx: ServiceContext, entry: typeof journalEntries.$inferSelect): Promise<void> {
  const id = entry.id;
  const srcKind = kindOf(entry.sourceRef);
  if (!['manual', 'tax_agency', 'sales_tax_adj', 'adjusting'].includes(srcKind)) {
    throw new ServiceError('CONFLICT', 'This entry belongs to a document — void the document instead.');
  }
  if (srcKind === 'tax_agency' || srcKind === 'sales_tax_adj') requirePermission(ctx, 'sales_tax.pay', 'delete');
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
    case 'transfer':
      await voidTransfer(ctx, id);
      return 'void';
    case 'item_receipt':
      await voidItemReceipt(ctx, id);
      return 'void';
    case 'inventory_adjustment':
      await voidInventoryAdjustment(ctx, id);
      return 'void';
    case 'estimate':
      await voidEstimate(ctx, id);
      return 'void';
    case 'sales_order':
      await voidSalesOrder(ctx, id);
      return 'void';
    case 'purchase_order':
      await voidPurchaseOrder(ctx, id);
      return 'void';
    case 'journal': {
      const [entry] = await ctx.db
        .select()
        .from(journalEntries)
        .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.id, id)));
      if (!entry) throw notFound('Journal entry');
      if (entry.status === 'draft') {
        await deleteDraftEntry(ctx, entry);
        return 'delete';
      }
      const srcKind = kindOf(entry.sourceRef);
      if (!['manual', 'tax_agency', 'sales_tax_adj', 'adjusting'].includes(srcKind)) {
        throw new ServiceError('CONFLICT', 'This entry belongs to a document — void the document instead.');
      }
      if (srcKind === 'tax_agency' || srcKind === 'sales_tax_adj') requirePermission(ctx, 'sales_tax.pay', 'delete');
      await voidJournalEntry(ctx, id);
      return 'void';
    }
    default:
      throw new ServiceError('VALIDATION', `Unsupported transaction type ${type as string}.`);
  }
}

/**
 * Void — or, with action 'delete', delete where allowed — each selected transaction; one failure
 * never stops the batch. `versions` (key → the version it was listed with) refuses a transaction
 * someone changed since it was listed (record locking).
 */
export async function batchVoidTransactions(
  ctx: ServiceContext,
  keys: string[],
  opts: { action?: 'void' | 'delete'; versions?: Record<string, string | null | undefined> } = {},
): Promise<{ results: BatchVoidResult[]; succeeded: number; failed: number; salesTaxFixesVoided: number }> {
  const unique = [...new Set(keys ?? [])];
  const wanted = opts.action ?? 'void';
  if (unique.length === 0) throw new ServiceError('VALIDATION', 'Select at least one transaction.');
  if (unique.length > 500) throw new ServiceError('VALIDATION', 'Void at most 500 transactions at a time.');
  // Corrections already orphaned before this batch are not this batch's to clean up.
  const preexisting = new Set((await orphanedSalesTaxFixes(ctx)).map((o) => o.entryId));
  const results: BatchVoidResult[] = [];
  for (const key of unique) {
    const [type, id] = key.split(':') as [BatchTxnType, string];
    if (!BATCH_TXN_TYPES.includes(type) || !id) {
      results.push({ key, ok: false, action: wanted, error: 'Unknown transaction.' });
      continue;
    }
    try {
      const entity = VERSION_ENTITY[type];
      const expected = opts.versions?.[key];
      if (entity && expected) await assertCurrentVersion(ctx, entity, id, expected);
      if (wanted === 'delete') {
        await deleteOne(ctx, type, id);
        results.push({ key, ok: true, action: 'delete' });
      } else {
        const action = await voidOne(ctx, type, id);
        results.push({ key, ok: true, action });
      }
    } catch (err) {
      results.push({
        key,
        ok: false,
        action: wanted,
        error: err instanceof Error ? err.message : `Could not ${wanted} this transaction.`,
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
        action: wanted === 'delete' ? 'delete' : 'void',
        entityType: 'batch_void',
        entityId: randomUUID(),
        newValues: { action: wanted, results, succeeded, failed: results.length - succeeded, total: results.length, salesTaxFixesVoided },
      }),
    );
  }
  return { results, succeeded, failed: results.length - succeeded, salesTaxFixesVoided };
}

// ---------------------------------------------------------------------------
// Restore deleted transactions
// ---------------------------------------------------------------------------

export interface DeletedTxnRow {
  /** Snapshot id (pass to restoreDeletedTransactions). */
  id: string;
  type: DeletedSnapshot['type'];
  typeLabel: string;
  label: string;
  date: string;
  amount: string;
  deletedAt: string;
  deletedBy: string | null;
}

/** Transactions deleted by Batch Delete/Void that have not been restored yet, newest first. */
export async function listDeletedTransactions(ctx: ServiceContext): Promise<DeletedTxnRow[]> {
  const rows = await ctx.db
    .select({ entityId: auditLogs.entityId, action: auditLogs.action, oldValues: auditLogs.oldValues, at: auditLogs.createdAt, userId: auditLogs.userId })
    .from(auditLogs)
    .where(and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityType, DELETED_SNAPSHOT_ENTITY)))
    .orderBy(desc(auditLogs.createdAt));
  const restored = new Set(rows.filter((r) => r.action === 'create').map((r) => r.entityId));
  const out: DeletedTxnRow[] = [];
  for (const r of rows) {
    if (r.action !== 'delete' || restored.has(r.entityId)) continue;
    const s = r.oldValues as unknown as DeletedSnapshot | null;
    if (!s?.type) continue;
    if (!canSee(ctx, s.type)) continue;
    out.push({
      id: r.entityId,
      type: s.type,
      typeLabel: BATCH_TXN_LABELS[s.type],
      label: s.label,
      date: s.date,
      amount: s.amount,
      deletedAt: r.at.toISOString(),
      deletedBy: r.userId ?? null,
    });
  }
  return out;
}

function canSee(ctx: ServiceContext, type: BatchTxnType): boolean {
  try {
    requirePermission(ctx, VOID_AREA[type], 'view');
    return true;
  } catch {
    return false;
  }
}

const toDateOrNull = (v: unknown) => (typeof v === 'string' && v ? new Date(v) : null);

/** Re-create deleted transactions from their snapshots through the normal create services. */
export async function restoreDeletedTransactions(
  ctx: ServiceContext,
  ids: string[],
): Promise<{ results: Array<{ id: string; ok: boolean; newId?: string; error?: string }>; restored: number }> {
  const unique = [...new Set(ids ?? [])];
  if (unique.length === 0) throw validation('Select at least one deleted transaction.');
  if (unique.length > 500) throw validation('Restore at most 500 transactions at a time.');
  const results: Array<{ id: string; ok: boolean; newId?: string; error?: string }> = [];
  for (const id of unique) {
    try {
      const newId = await inTransaction(ctx, async (tx) => {
        const rows = await tx.db
          .select({ action: auditLogs.action, oldValues: auditLogs.oldValues })
          .from(auditLogs)
          .where(and(eq(auditLogs.companyId, tx.companyId), eq(auditLogs.entityType, DELETED_SNAPSHOT_ENTITY), eq(auditLogs.entityId, id)));
        const del = rows.find((r) => r.action === 'delete');
        if (!del) throw notFound('Deleted transaction');
        if (rows.some((r) => r.action === 'create')) throw new ServiceError('CONFLICT', 'This transaction was already restored.');
        const s = del.oldValues as unknown as DeletedSnapshot;
        requirePermission(tx, VOID_AREA[s.type], 'create');
        const r = s.restore as Record<string, any>;
        let created: { id: string };
        if (s.type === 'journal') {
          await refuseInAccountantCopy(tx, 'Restoring a deleted journal entry', 'Enter it again as a new journal entry.');
          created = (await createManualEntry(tx, {
            date: new Date(r.date),
            description: r.description,
            reference: r.reference ?? null,
            isAdjusting: Boolean(r.isAdjusting),
            lines: r.lines,
          } as never)) as { id: string };
        } else if (s.type === 'estimate') {
          created = (await createEstimate(tx, { ...r, date: new Date(r.date), expirationDate: toDateOrNull(r.expirationDate) } as never)) as { id: string };
        } else if (s.type === 'sales_order') {
          created = (await createSalesOrder(tx, { ...r, date: new Date(r.date), shipDate: toDateOrNull(r.shipDate) } as never)) as { id: string };
        } else {
          created = (await createPurchaseOrder(tx, { ...r, date: new Date(r.date), expectedDate: toDateOrNull(r.expectedDate) } as never)) as { id: string };
        }
        await writeAudit(tx, {
          action: 'create',
          entityType: DELETED_SNAPSHOT_ENTITY,
          entityId: id,
          newValues: { restored: true, type: s.type, from: s.docId, newId: created.id },
        });
        return created.id;
      });
      results.push({ id, ok: true, newId });
    } catch (err) {
      results.push({ id, ok: false, error: err instanceof Error ? err.message : 'Could not restore this transaction.' });
    }
  }
  return { results, restored: results.filter((r) => r.ok).length };
}
