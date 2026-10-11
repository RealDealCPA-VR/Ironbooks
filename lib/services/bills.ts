/**
 * Bills (Accounts Payable) service.
 *
 * A Bill records an obligation to pay a vendor for goods or services received.
 * The posting pattern is the A/P mirror of an Invoice:
 *
 *   Dr  <expense / asset account>   (one line per bill line)
 *   Cr  Accounts Payable  2000      (consolidated total)
 *
 * Item lines (QB "Items tab"): a line may reference an item instead of a GL
 * account. For inventory-type items the debit is routed to the item's inventory
 * asset account (item.assetAccountId ?? code 1300) — Dr Inventory / Cr A/P — and
 * stock is received in the SAME transaction:
 *   - FIFO-tracked items (any inventoryLayers rows) get a new cost layer.
 *   - average-cost items get a weighted-average cost update.
 * The bill's own journal entry already carries the inventory debit, so the stock
 * side only updates quantityOnHand/averageCost/layers (no second GL posting —
 * calling fifo.receiveStock here would double-post Dr Inventory).
 * Non-inventory items route to line.accountId ?? item.expenseAccountId.
 *
 * All GL mutations go through `postJournalEntry`; `voidBill` delegates to
 * `voidJournalEntry`, reverses any stock received, and flips the status to 'void'.
 *
 * `updateBill` (QB "edit any saved transaction", mirror of updateInvoice) is
 * allowed while the bill has no payments or vendor credits applied: it voids
 * the original journal entry (period check on the OLD date), reverses the stock
 * received from item lines, replaces the lines, re-posts the GL (period check on
 * the NEW date), and re-receives stock — all inside one transaction.
 */
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { accounts, bills, billLines, inventoryLayers, items, vendors } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { postJournalEntry, voidJournalEntry } from '@/lib/services/posting';
import {
  type DocumentInventoryLine,
  type InventoryLineDetail,
  attachInventoryDetails,
  postDocumentInventory,
  reverseDocumentInventory,
} from './inventorySites';
import { assertNoActiveLandedCost } from './landedCost';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

export interface BillLineInput extends InventoryLineDetail {
  /** GL account to debit (expense or asset). Required unless itemId is set. */
  accountId?: string | null;
  /** Item being purchased; routes the debit and (for inventory items) receives stock. */
  itemId?: string | null;
  description?: string | null;
  /** Units purchased. Required (> 0) for item lines; informational otherwise. */
  quantity?: string | number | null;
  /** Per-unit cost for item lines. Provide unitCost or amount (or both). */
  unitCost?: string | number | null;
  /** The dollar amount for this line (must be > 0). Defaults to quantity * unitCost for item lines. */
  amount?: string | number | null;
  /** Class/department dimension — carried onto the GL debit line for P&L-by-class. */
  classId?: string | null;
  /** Billable customer (+ optional job) — makes the line available for invoice passthrough. */
  customerId?: string | null;
  jobId?: string | null;
}

export interface CreateBillInput {
  vendorId: string;
  billNumber?: string | null;
  date: Date;
  dueDate?: Date | null;
  memo?: string | null;
  classId?: string | null;
  lines: BillLineInput[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the Accounts Payable account (code '2000') for this company. */
async function resolveApAccount(ctx: ServiceContext): Promise<string> {
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '2000')));
  if (!row) {
    throw new ServiceError(
      'NOT_FOUND',
      'Accounts Payable account (code 2000) not found. Ensure the default chart of accounts is seeded.',
    );
  }
  return row.id;
}

/** Resolve an account id by code, scoped to the company. Throws NOT_FOUND. */
async function accountIdByCode(ctx: ServiceContext, code: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
  if (!row) throw notFound(`Account with code ${code}`);
  return row.id;
}

/** True when the item has ever had FIFO cost layers (mirrors inventory.assertNotFifoTracked). */
async function isFifoTracked(ctx: ServiceContext, itemId: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ id: inventoryLayers.id })
    .from(inventoryLayers)
    .where(
      and(eq(inventoryLayers.companyId, ctx.companyId), eq(inventoryLayers.itemId, itemId)),
    )
    .limit(1);
  return Boolean(row);
}

// ---------------------------------------------------------------------------
// prepareBill — shared validation + line resolution for create/update
// ---------------------------------------------------------------------------

type ResolvedLine = {
  itemId: string | null;
  accountId: string;
  description: string | null;
  quantity: string; // 4dp
  amount: string; // 2dp
  /** Per-unit cost (4dp Decimal) — only set for inventory item lines. */
  unitCost: ReturnType<typeof Money.zero> | null;
  isInventory: boolean;
  classId: string | null;
  customerId: string | null;
  jobId: string | null;
};

interface PreparedBill {
  vendor: { id: string; name: string };
  resolvedLines: ResolvedLine[];
  totalStr: string;
  apAccountId: string;
}

/**
 * Validate a bill input (vendor ownership, line shapes) and resolve each line to
 * { debit account, amount, qty, unitCost } using Money (no JS floats). Read-only.
 */
async function prepareBill(ctx: ServiceContext, input: CreateBillInput): Promise<PreparedBill> {
  // --- Validate vendor belongs to this company ---
  const [vendor] = await ctx.db
    .select({ id: vendors.id, name: vendors.displayName })
    .from(vendors)
    .where(and(eq(vendors.id, input.vendorId), eq(vendors.companyId, ctx.companyId)));
  if (!vendor) throw notFound('Vendor');

  // --- Validate lines ---
  if (!input.lines || input.lines.length === 0) {
    throw validation('A bill must have at least one line.');
  }

  // Pre-load referenced items (debit routing + inventory typing).
  const itemIds = [
    ...new Set(input.lines.filter((l) => l.itemId).map((l) => l.itemId as string)),
  ];
  const itemMap = new Map<
    string,
    {
      type: string;
      name: string;
      assetAccountId: string | null;
      expenseAccountId: string | null;
    }
  >();
  if (itemIds.length > 0) {
    const itemRows = await ctx.db
      .select({
        id: items.id,
        type: items.type,
        name: items.name,
        assetAccountId: items.assetAccountId,
        expenseAccountId: items.expenseAccountId,
      })
      .from(items)
      .where(and(eq(items.companyId, ctx.companyId), inArray(items.id, itemIds)));
    for (const r of itemRows) itemMap.set(r.id, r);
    for (const id of itemIds) {
      if (!itemMap.has(id)) throw notFound(`Item ${id}`);
    }
  }

  const resolvedLines: ResolvedLine[] = [];
  let total = Money.zero();

  // Lazily resolved 1300 fallback (only needed when an inventory item lacks assetAccountId).
  let defaultInventoryAcctId: string | null = null;

  for (const [i, line] of input.lines.entries()) {
    if (line.itemId) {
      const item = itemMap.get(line.itemId)!;
      const qty = Money.of(line.quantity ?? 0);
      if (qty.lessThanOrEqualTo(0)) {
        throw validation(`Line ${i + 1}: quantity must be greater than zero for item lines.`);
      }
      if (line.unitCost == null && line.amount == null) {
        throw validation(`Line ${i + 1}: provide a unit cost or an amount for item lines.`);
      }

      // amount = explicit amount, else qty * unitCost; unitCost = explicit, else amount / qty.
      const amount =
        line.amount != null
          ? Money.round2(line.amount)
          : Money.round2(qty.times(Money.of(line.unitCost!)));
      if (!amount.greaterThan(0)) {
        throw validation(`Line ${i + 1}: amount must be greater than zero.`);
      }
      const unitCost =
        line.unitCost != null ? Money.of(line.unitCost) : amount.dividedBy(qty);
      if (unitCost.isNegative()) {
        throw validation(`Line ${i + 1}: unit cost cannot be negative.`);
      }

      const isInventory = item.type === 'inventory';
      let accountId: string;
      if (isInventory) {
        // Dr Inventory Asset (item account or 1300 fallback) / Cr A/P.
        if (item.assetAccountId) {
          accountId = item.assetAccountId;
        } else {
          defaultInventoryAcctId ??= await accountIdByCode(ctx, '1300');
          accountId = defaultInventoryAcctId;
        }
      } else {
        const routed = line.accountId ?? item.expenseAccountId;
        if (!routed) {
          throw validation(
            `Line ${i + 1}: item "${item.name}" has no expense account — set one on the item or pass an accountId.`,
          );
        }
        accountId = routed;
      }

      resolvedLines.push({
        itemId: line.itemId,
        accountId,
        description: line.description ?? item.name,
        quantity: qty.toFixed(4),
        amount: toAmountString(amount),
        unitCost: isInventory ? unitCost : null,
        isInventory,
        classId: line.classId ?? input.classId ?? null,
        customerId: line.customerId ?? null,
        jobId: line.jobId ?? null,
      });
      total = total.plus(amount);
    } else {
      if (!line.accountId) {
        throw validation(`Line ${i + 1}: select an account or an item.`);
      }
      const amt = Money.of(line.amount ?? 0);
      if (!amt.greaterThan(0)) {
        throw validation(`Line ${i + 1}: amount must be greater than zero.`);
      }
      resolvedLines.push({
        itemId: null,
        accountId: line.accountId,
        description: line.description ?? null,
        quantity: line.quantity != null ? toAmountString(line.quantity) : '1.0000',
        amount: toAmountString(amt),
        unitCost: null,
        isInventory: false,
        classId: line.classId ?? input.classId ?? null,
        customerId: line.customerId ?? null,
        jobId: line.jobId ?? null,
      });
      total = total.plus(amt);
    }
  }

  // Resolve A/P account up front (read-only; no need to hold a tx lock).
  const apAccountId = await resolveApAccount(ctx);

  return { vendor, resolvedLines, totalStr: toAmountString(total), apAccountId };
}

// ---------------------------------------------------------------------------
// Stock subledger helpers (the GL side lives on the bill's own journal entry)
// ---------------------------------------------------------------------------

/**
 * Receive stock for inventory item lines (same transaction as the bill posting).
 * The bill's journal entry already debited the inventory asset account, so this
 * step only moves the quantity/cost subledger:
 *   FIFO-tracked items  → new cost layer at the line's unit cost.
 *   average-cost items  → weighted-average cost update.
 */
async function receiveResolvedStock(
  tx: ServiceContext,
  billId: string,
  date: Date,
  resolvedLines: ResolvedLine[],
  reason: string,
) {
  for (const line of resolvedLines) {
    if (!line.isInventory || !line.itemId || !line.unitCost) continue;

    // Reload inside the tx so multiple lines for the same item compound correctly.
    const [item] = await tx.db
      .select()
      .from(items)
      .where(and(eq(items.companyId, tx.companyId), eq(items.id, line.itemId)));
    if (!item) throw notFound(`Item ${line.itemId}`);

    const qty = Money.of(line.quantity);
    const currentQty = Money.of(item.quantityOnHand ?? '0');
    const newQty = currentQty.plus(qty);

    if (await isFifoTracked(tx, line.itemId)) {
      await tx.db.insert(inventoryLayers).values({
        companyId: tx.companyId,
        itemId: line.itemId,
        date,
        quantityRemaining: qty.toFixed(4),
        unitCost: line.unitCost.toFixed(4),
        sourceRef: `bill:${billId}`,
      });
      await tx.db
        .update(items)
        .set({ quantityOnHand: newQty.toFixed(4), updatedAt: new Date() })
        .where(eq(items.id, line.itemId));
    } else {
      const currentAvg = Money.of(item.averageCost ?? '0');
      const newAvg = newQty.isZero()
        ? line.unitCost
        : currentQty.times(currentAvg).plus(qty.times(line.unitCost)).dividedBy(newQty);
      await tx.db
        .update(items)
        .set({
          quantityOnHand: newQty.toFixed(4),
          averageCost: newAvg.toFixed(4),
          updatedAt: new Date(),
        })
        .where(eq(items.id, line.itemId));
    }

    await writeAudit(tx, {
      action: 'update',
      entityType: 'item',
      entityId: line.itemId,
      oldValues: {
        quantityOnHand: item.quantityOnHand,
        averageCost: item.averageCost,
      },
      newValues: {
        quantityOnHand: newQty.toFixed(4),
        unitCost: line.unitCost.toFixed(4),
        reason: `${reason}:${billId}`,
      },
    });
  }
}

/**
 * Reverse any stock received via the bill's inventory item lines (as currently
 * saved in bill_lines). The matching GL reversal must already have happened via
 * voidJournalEntry; this step pulls the quantity/cost back out of the subledger.
 */
async function reverseReceivedStock(tx: ServiceContext, billId: string, reason: string) {
  const lines = await tx.db
    .select()
    .from(billLines)
    .where(eq(billLines.billId, billId))
    .orderBy(asc(billLines.lineOrder));

  for (const line of lines) {
    if (!line.itemId) continue;
    const [item] = await tx.db
      .select()
      .from(items)
      .where(and(eq(items.companyId, tx.companyId), eq(items.id, line.itemId)));
    if (!item || item.type !== 'inventory') continue;

    const qty = Money.of(line.quantity);
    if (qty.lessThanOrEqualTo(0)) continue;
    const unitCost = Money.of(line.amount).dividedBy(qty);

    const currentQty = Money.of(item.quantityOnHand ?? '0');
    if (currentQty.lessThan(qty)) {
      throw new ServiceError(
        'CONFLICT',
        `Cannot reverse this bill's receipt: only ${currentQty.toFixed(4)} of "${item.name}" remain on hand (the received stock has already been consumed).`,
      );
    }
    const newQty = currentQty.minus(qty);

    if (await isFifoTracked(tx, line.itemId)) {
      // Remove the received quantity from layers — prefer layers at this bill's
      // unit cost (the ones this bill created), newest first, then fall back to
      // FIFO (oldest-first) for any remainder.
      const layers = await tx.db
        .select()
        .from(inventoryLayers)
        .where(
          and(
            eq(inventoryLayers.companyId, tx.companyId),
            eq(inventoryLayers.itemId, line.itemId),
          ),
        )
        .orderBy(asc(inventoryLayers.date), asc(inventoryLayers.createdAt));
      const available = layers.filter((l) => Money.of(l.quantityRemaining).greaterThan(0));
      const costKey = unitCost.toFixed(4);
      const ordered = [
        ...available.filter((l) => Money.of(l.unitCost).toFixed(4) === costKey).reverse(),
        ...available.filter((l) => Money.of(l.unitCost).toFixed(4) !== costKey),
      ];

      let remaining = qty;
      for (const layer of ordered) {
        if (remaining.lessThanOrEqualTo(0)) break;
        const layerQty = Money.of(layer.quantityRemaining);
        const take = remaining.lessThanOrEqualTo(layerQty) ? remaining : layerQty;
        await tx.db
          .update(inventoryLayers)
          .set({ quantityRemaining: layerQty.minus(take).toFixed(4) })
          .where(eq(inventoryLayers.id, layer.id));
        remaining = remaining.minus(take);
      }
      if (remaining.greaterThan(0)) {
        throw new ServiceError(
          'CONFLICT',
          `Cannot reverse this bill's receipt: FIFO layers for "${item.name}" no longer hold the received quantity.`,
        );
      }
      await tx.db
        .update(items)
        .set({ quantityOnHand: newQty.toFixed(4), updatedAt: new Date() })
        .where(eq(items.id, line.itemId));
    } else {
      // Reverse the weighted-average receipt: back the line's value out of the pool.
      const currentAvg = Money.of(item.averageCost ?? '0');
      const remainingValue = currentQty.times(currentAvg).minus(qty.times(unitCost));
      const newAvg = newQty.isZero()
        ? Money.zero()
        : remainingValue.lessThan(0)
          ? Money.zero()
          : remainingValue.dividedBy(newQty);
      await tx.db
        .update(items)
        .set({
          quantityOnHand: newQty.toFixed(4),
          averageCost: newAvg.toFixed(4),
          updatedAt: new Date(),
        })
        .where(eq(items.id, line.itemId));
    }

    await writeAudit(tx, {
      action: 'update',
      entityType: 'item',
      entityId: line.itemId,
      oldValues: {
        quantityOnHand: item.quantityOnHand,
        averageCost: item.averageCost,
      },
      newValues: {
        quantityOnHand: newQty.toFixed(4),
        reason: `${reason}:${billId}`,
      },
    });
  }
}

/** Advanced Inventory lines (site/bin/serial/lot) for a bill — lineOrder = input index. */
function billInventoryLines(input: CreateBillInput, prep: PreparedBill): DocumentInventoryLine[] {
  return prep.resolvedLines.map((line, idx) => {
    const src = input.lines[idx];
    return {
      lineOrder: idx,
      itemId: line.isInventory ? line.itemId : null,
      quantity: line.quantity,
      siteId: src?.siteId,
      binId: src?.binId,
      serialNumbers: src?.serialNumbers,
      lotNumber: src?.lotNumber,
      lotExpiration: src?.lotExpiration,
    };
  });
}

/** Build the GL posting lines for a prepared bill: Dr per line, Cr A/P total. */
function buildPostingLines(prep: PreparedBill, billNumber: string | null, billId: string) {
  return [
    // Debit lines (one per bill line)
    ...prep.resolvedLines.map((line) => ({
      accountId: line.accountId,
      debit: line.amount,
      memo: line.description,
      classId: line.classId,
    })),
    // Credit line — Accounts Payable
    {
      accountId: prep.apAccountId,
      credit: prep.totalStr,
      memo: `Bill ${billNumber ?? billId} — ${prep.vendor.name}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// createBill
// ---------------------------------------------------------------------------

export async function createBill(ctx: ServiceContext, input: CreateBillInput) {
  const prep = await prepareBill(ctx, input);
  const { resolvedLines, totalStr } = prep;

  return inTransaction(ctx, async (tx) => {
    // --- Insert the bill header ---
    const [bill] = await tx.db
      .insert(bills)
      .values({
        companyId: tx.companyId,
        vendorId: input.vendorId,
        billNumber: input.billNumber ?? null,
        date: input.date,
        dueDate: input.dueDate ?? null,
        memo: input.memo ?? null,
        status: 'open',
        classId: input.classId ?? null,
        total: totalStr,
        amountPaid: '0.00',
        amountCredited: '0.00',
        balanceDue: totalStr,
      })
      .returning();

    // --- Insert bill lines ---
    await tx.db.insert(billLines).values(
      resolvedLines.map((line, idx) => ({
        billId: bill.id,
        accountId: line.accountId,
        itemId: line.itemId,
        description: line.description,
        quantity: line.quantity,
        amount: line.amount,
        classId: line.classId,
        customerId: line.customerId,
        jobId: line.jobId,
        lineOrder: idx,
      })),
    );

    // --- Post to the GL ---
    const entry = await postJournalEntry(tx, {
      date: input.date,
      description: `Bill ${input.billNumber ? `#${input.billNumber}` : bill.id}`,
      reference: input.billNumber ?? null,
      sourceRef: `bill:${bill.id}`,
      lines: buildPostingLines(prep, input.billNumber ?? null, bill.id),
    });

    // --- Store the journal entry reference on the bill ---
    const [updated] = await tx.db
      .update(bills)
      .set({ postedEntryId: entry.id, updatedAt: new Date() })
      .where(eq(bills.id, bill.id))
      .returning();

    // --- Receive stock for inventory item lines (same transaction) ---
    await receiveResolvedStock(tx, bill.id, input.date, resolvedLines, 'bill_receipt');
    await postDocumentInventory(tx, {
      sourceType: 'bill',
      sourceId: bill.id,
      date: input.date,
      direction: 'in',
      lines: billInventoryLines(input, prep),
      memo: `Bill ${input.billNumber ?? ''}`.trim(),
    });

    await writeAudit(tx, {
      action: 'create',
      entityType: 'bill',
      entityId: bill.id,
      newValues: { ...updated, linesCount: input.lines.length, total: totalStr },
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// updateBill
// ---------------------------------------------------------------------------

/**
 * Edit a saved bill in place (mirror of updateInvoice).
 *
 * Allowed only while NO payments and NO vendor credits have been applied
 * (amountPaid == 0 && amountCredited == 0) and both accounting periods are
 * open — voidJournalEntry enforces the OLD entry's date, postJournalEntry
 * enforces the NEW date.
 *
 * All inside ONE transaction:
 *   1. Void the existing journal entry.
 *   2. Reverse stock received from inventory item lines.
 *   3. Replace the bill lines and update the header in place (createdAt kept).
 *   4. Re-post the GL entry and re-receive stock from the new lines.
 *   5. Audit trail records old and new values.
 */
export async function updateBill(ctx: ServiceContext, id: string, input: CreateBillInput) {
  // Pre-check outside the transaction for a fast, friendly error.
  const [existing] = await ctx.db
    .select()
    .from(bills)
    .where(and(eq(bills.id, id), eq(bills.companyId, ctx.companyId)));
  if (!existing) throw notFound('Bill');
  if (existing.status === 'void') {
    throw new ServiceError('CONFLICT', 'Cannot edit a voided bill.');
  }
  if (existing.amountPaid && Money.gt(existing.amountPaid, 0)) {
    throw new ServiceError(
      'CONFLICT',
      'Cannot edit a bill that has payments applied. Unapply payments first.',
    );
  }
  if (existing.amountCredited && Money.gt(existing.amountCredited, 0)) {
    throw new ServiceError(
      'CONFLICT',
      'Cannot edit a bill that has vendor credits applied. Unapply vendor credits first.',
    );
  }

  // Validate + resolve the new document (read-only).
  const prep = await prepareBill(ctx, input);

  return inTransaction(ctx, async (tx) => {
    // Re-load inside the transaction to close the read-then-write race.
    const [bill] = await tx.db
      .select()
      .from(bills)
      .where(and(eq(bills.id, id), eq(bills.companyId, tx.companyId)));
    if (!bill) throw notFound('Bill');
    if (bill.status === 'void') {
      throw new ServiceError('CONFLICT', 'Cannot edit a voided bill.');
    }
    if (bill.amountPaid && Money.gt(bill.amountPaid, 0)) {
      throw new ServiceError(
        'CONFLICT',
        'Cannot edit a bill that has payments applied. Unapply payments first.',
      );
    }
    if (bill.amountCredited && Money.gt(bill.amountCredited, 0)) {
      throw new ServiceError(
        'CONFLICT',
        'Cannot edit a bill that has vendor credits applied. Unapply vendor credits first.',
      );
    }

    // Landed cost allocated from this bill's charge lines must be voided first.
    await assertNoActiveLandedCost(tx, { billId: id });

    // Snapshot old lines for the audit trail BEFORE replacing them.
    const oldLines = await tx.db
      .select()
      .from(billLines)
      .where(eq(billLines.billId, id))
      .orderBy(asc(billLines.lineOrder));

    // 1) Void the original journal entry (assertPeriodOpen runs on its date).
    if (bill.postedEntryId) {
      await voidJournalEntry(tx, bill.postedEntryId);
    }

    // 2) Reverse stock received from the OLD item lines (reads old lines — must
    //    precede the delete).
    await reverseReceivedStock(tx, id, 'bill_edit');
    await reverseDocumentInventory(tx, 'bill', id);

    // 3) Replace lines.
    await tx.db.delete(billLines).where(eq(billLines.billId, id));
    await tx.db.insert(billLines).values(
      prep.resolvedLines.map((line, idx) => ({
        billId: id,
        accountId: line.accountId,
        itemId: line.itemId,
        description: line.description,
        quantity: line.quantity,
        amount: line.amount,
        classId: line.classId,
        customerId: line.customerId,
        jobId: line.jobId,
        lineOrder: idx,
      })),
    );

    // 4) Re-post the GL entry (assertPeriodOpen runs on the new date) and
    //    update the header in place — createdAt is intentionally NOT touched.
    const entry = await postJournalEntry(tx, {
      date: input.date,
      description: `Bill ${input.billNumber ? `#${input.billNumber}` : id}`,
      reference: input.billNumber ?? null,
      sourceRef: `bill:${id}`,
      lines: buildPostingLines(prep, input.billNumber ?? null, id),
    });

    const [updated] = await tx.db
      .update(bills)
      .set({
        vendorId: input.vendorId,
        billNumber: input.billNumber ?? null,
        date: input.date,
        dueDate: input.dueDate ?? null,
        memo: input.memo ?? null,
        classId: input.classId ?? null,
        status: 'open',
        total: prep.totalStr,
        amountPaid: '0.00',
        amountCredited: '0.00',
        balanceDue: prep.totalStr,
        postedEntryId: entry.id,
        updatedAt: new Date(),
      })
      .where(eq(bills.id, id))
      .returning();

    // 5) Re-receive stock for the NEW inventory item lines.
    await receiveResolvedStock(tx, id, input.date, prep.resolvedLines, 'bill_edit_receipt');
    await postDocumentInventory(tx, {
      sourceType: 'bill',
      sourceId: id,
      date: input.date,
      direction: 'in',
      lines: billInventoryLines(input, prep),
      memo: `Bill ${input.billNumber ?? ''}`.trim(),
      carryForward: true,
    });

    // 6) Audit trail with old + new values.
    await writeAudit(tx, {
      action: 'update',
      entityType: 'bill',
      entityId: id,
      oldValues: {
        vendorId: bill.vendorId,
        billNumber: bill.billNumber,
        date: bill.date,
        dueDate: bill.dueDate,
        memo: bill.memo,
        total: bill.total,
        postedEntryId: bill.postedEntryId,
        lines: oldLines.map((l) => ({
          accountId: l.accountId,
          itemId: l.itemId,
          description: l.description,
          quantity: l.quantity,
          amount: l.amount,
        })),
      },
      newValues: {
        vendorId: input.vendorId,
        billNumber: input.billNumber ?? null,
        date: input.date,
        dueDate: input.dueDate ?? null,
        memo: input.memo ?? null,
        total: prep.totalStr,
        postedEntryId: entry.id,
        lines: prep.resolvedLines.map((l) => ({
          accountId: l.accountId,
          itemId: l.itemId,
          description: l.description,
          quantity: l.quantity,
          amount: l.amount,
        })),
      },
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// listBills
// ---------------------------------------------------------------------------

export async function listBills(
  ctx: ServiceContext,
  opts?: { vendorId?: string; status?: string },
) {
  const conditions = [eq(bills.companyId, ctx.companyId)];
  if (opts?.vendorId) conditions.push(eq(bills.vendorId, opts.vendorId));
  if (opts?.status) conditions.push(eq(bills.status, opts.status as never));

  return ctx.db
    .select()
    .from(bills)
    .where(and(...conditions))
    .orderBy(desc(bills.date), asc(bills.createdAt));
}

// ---------------------------------------------------------------------------
// getBill (header + lines)
// ---------------------------------------------------------------------------

export async function getBill(ctx: ServiceContext, id: string) {
  const [bill] = await ctx.db
    .select()
    .from(bills)
    .where(and(eq(bills.id, id), eq(bills.companyId, ctx.companyId)));
  if (!bill) throw notFound('Bill');

  const lines = await ctx.db
    .select()
    .from(billLines)
    .where(eq(billLines.billId, id))
    .orderBy(asc(billLines.lineOrder));

  return { ...bill, lines: await attachInventoryDetails(ctx, 'bill', id, lines) };
}

// ---------------------------------------------------------------------------
// voidBill
// ---------------------------------------------------------------------------

export async function voidBill(ctx: ServiceContext, id: string) {
  // Fetch the bill and verify company ownership.
  const [bill] = await ctx.db
    .select()
    .from(bills)
    .where(and(eq(bills.id, id), eq(bills.companyId, ctx.companyId)));
  if (!bill) throw notFound('Bill');

  if (bill.status === 'void') {
    // Idempotent — already voided.
    return bill;
  }

  if (bill.amountPaid && Money.gt(bill.amountPaid, 0)) {
    throw new ServiceError(
      'CONFLICT',
      'Cannot void a bill that has payments applied. Unapply payments first.',
    );
  }

  if (bill.amountCredited && Money.gt(bill.amountCredited, 0)) {
    throw new ServiceError(
      'CONFLICT',
      'Cannot void a bill that has vendor credits applied. Unapply vendor credits first.',
    );
  }

  return inTransaction(ctx, async (tx) => {
    // Landed cost allocated from this bill's charge lines must be voided first.
    await assertNoActiveLandedCost(tx, { billId: id });

    // Reverse the GL entry.
    if (bill.postedEntryId) {
      await voidJournalEntry(tx, bill.postedEntryId);
    }

    // Reverse any stock received via inventory item lines. The JE void above
    // already restored the GL (Dr A/P / Cr Inventory at the bill's cost); this
    // step pulls the quantity/cost back out of the subledger (and out of its site).
    await reverseReceivedStock(tx, id, 'bill_void');
    await reverseDocumentInventory(tx, 'bill', id);

    // Flip bill status to void and zero balanceDue.
    const [updated] = await tx.db
      .update(bills)
      .set({ status: 'void', balanceDue: '0.00', updatedAt: new Date() })
      .where(eq(bills.id, id))
      .returning();

    await writeAudit(tx, {
      action: 'void',
      entityType: 'bill',
      entityId: id,
      oldValues: { status: bill.status },
      newValues: { status: 'void' },
    });

    return updated;
  });
}
