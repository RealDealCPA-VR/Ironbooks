/**
 * Purchase Orders service.
 *
 * A Purchase Order is a pre-purchase commitment sent to a vendor. It does NOT
 * post to the GL — POs are off-balance-sheet until goods/services are received
 * and a bill is created.
 *
 * Status flow:
 *   open  →  partial  (via convertToBill with per-line quantities — some qty unbilled)
 *   open / partial  →  closed   (via convertToBill once every line is fully billed,
 *                                or manually via updateStatus)
 *   open  →  void     (via updateStatus; blocked once anything has been billed)
 *
 * Conversion / partial billing:
 *   convertToBill(ctx, poId, opts?) bills the PO (default: every line's full
 *   remaining quantity; or per-line quantities via opts.lines). Item lines pass
 *   itemId/quantity/unitCost through to createBill so inventory items receive
 *   stock (perpetual inventory). purchaseOrderLines.quantityBilled tracks how
 *   much of each line has been pulled onto bills; multiple bills per PO are
 *   supported. Idempotency / over-billing is enforced by a guarded conditional
 *   UPDATE on quantityBilled inside the transaction. convertedBillId is stamped
 *   with the bill that completes (closes) the PO.
 */
import { assertAccountantMayConvert, assertDividingDateOpen } from './accountantCopy/guard';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { accounts, auditLogs, items, purchaseOrders, purchaseOrderLines, vendors } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { createBill } from '@/lib/services/bills';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { getReceivingSettings, poStatusFromLines } from './receivingLinks';
import { allocateDocNumber, renumberDoc } from './docNumbers';
import { assertFeatureOn } from '@/lib/featureGate';

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

export interface PurchaseOrderLineInput {
  /** Item being ordered — passes through to the bill (inventory items receive stock). */
  itemId?: string | null;
  /**
   * GL account to debit when the PO is billed (expense / asset).
   * Required unless itemId is set (item lines route via the item's accounts).
   */
  accountId?: string | null;
  description?: string | null;
  quantity: string | number;
  rate: string | number;
}

export interface CreatePurchaseOrderInput {
  /**
   * Document number typed by the user (alphanumeric, e.g. "INV-1001"). Blank = the next number
   * (QB: last number used with its trailing digits + 1). See lib/services/docNumbers.ts.
   */
  refNumber?: string | null;
  /** The user confirmed the "this number is already used" warning. */
  allowDuplicateNumber?: boolean | null;
  vendorId: string;
  date: Date;
  expectedDate?: Date | null;
  lines: PurchaseOrderLineInput[];
  memo?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// createPurchaseOrder
// ---------------------------------------------------------------------------

/**
 * Every account / item referenced by PO lines must belong to the current company. Returns the
 * text an item line's blank description defaults to (the item's description, else its name).
 */
async function assertPoLineRefsOwned(
  ctx: ServiceContext,
  lines: ReadonlyArray<{ accountId?: string | null; itemId?: string | null }>,
): Promise<Map<string, string>> {
  const acctIds = [...new Set(lines.map((l) => l.accountId).filter((x): x is string => !!x))];
  const itemIds = [...new Set(lines.map((l) => l.itemId).filter((x): x is string => !!x))];
  if (acctIds.length) {
    const found = await ctx.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(inArray(accounts.id, acctIds), eq(accounts.companyId, ctx.companyId)));
    if (found.length !== acctIds.length) throw validation('One of the lines uses an account that does not exist in this company.');
  }
  const itemText = new Map<string, string>();
  if (itemIds.length) {
    const found = await ctx.db
      .select({ id: items.id, name: items.name, description: items.description })
      .from(items)
      .where(and(inArray(items.id, itemIds), eq(items.companyId, ctx.companyId)));
    if (found.length !== itemIds.length) throw validation('One of the lines uses an item that does not exist in this company.');
    for (const it of found) itemText.set(it.id, it.description?.trim() || it.name);
  }
  return itemText;
}

/**
 * A PO line's description: the one typed, else (item lines) the item's description / name. QB
 * fills it from the item's purchase description — the vendor reads the printed P.O., which used
 * to show "—" for an item line left blank (the Item column is off by default).
 */
function poLineDescription(
  line: { itemId?: string | null; description?: string | null },
  itemText: Map<string, string>,
): string | null {
  const typed = line.description?.trim() ? line.description : null;
  if (typed) return typed;
  return line.itemId ? (itemText.get(line.itemId) ?? null) : (line.description ?? null);
}

export async function createPurchaseOrder(
  ctx: ServiceContext,
  input: CreatePurchaseOrderInput,
) {
  // Enforced here, not only on the API path: memorized POs and reorder-list POs are entered
  // without an HTTP request (QB has no purchase orders while "Use purchase orders" is off).
  await assertFeatureOn(ctx, 'purchaseOrdersEnabled');
  await assertDividingDateOpen(ctx, input.date); // Accountant's Copy (I1)
  if (!input.lines || input.lines.length === 0) {
    throw validation('A purchase order must have at least one line.');
  }

  // Verify vendor belongs to this company.
  const [vendor] = await ctx.db
    .select({ id: vendors.id })
    .from(vendors)
    .where(and(eq(vendors.id, input.vendorId), eq(vendors.companyId, ctx.companyId)));
  if (!vendor) throw notFound('Vendor');
  const itemText = await assertPoLineRefsOwned(ctx, input.lines);

  // Compute per-line amounts using safe decimal math.
  type ComputedLine = {
    itemId: string | null;
    accountId: string | null;
    description: string | null;
    quantity: string;
    rate: string;
    amount: string;
    lineOrder: number;
  };

  let total = Money.zero();
  const computedLines: ComputedLine[] = [];

  for (let i = 0; i < input.lines.length; i++) {
    const l = input.lines[i];
    // Quantity and rate are stored at 4 places (numeric(15,4)); the amount is worked out from the
    // stored values so an edit or Convert to Bill (qty x stored rate) gives the same amount.
    const qty = Money.of(Money.of(l.quantity).toFixed(4));
    const rate = Money.of(Money.of(l.rate).toFixed(4));
    if (qty.lessThanOrEqualTo(0)) throw validation(`Line ${i + 1}: quantity must be positive.`);
    if (rate.lessThan(0)) throw validation(`Line ${i + 1}: rate cannot be negative.`);
    if (!l.accountId && !l.itemId) {
      throw validation(`Line ${i + 1}: select an account or an item.`);
    }

    const amount = Money.round2(Money.mul(qty, rate));
    total = total.plus(amount);

    computedLines.push({
      itemId: l.itemId ?? null,
      accountId: l.accountId ?? null,
      description: poLineDescription(l, itemText),
      quantity: qty.toFixed(4),
      rate: rate.toFixed(4),
      amount: toAmountString(amount),
      lineOrder: i,
    });
  }

  const totalStr = toAmountString(total);

  return inTransaction(ctx, async (tx) => {
    const { refNumber, number: poNumber } = await allocateDocNumber(tx, 'purchase_order', input.refNumber, {
      allowDuplicate: input.allowDuplicateNumber === true,
    });

    const [po] = await tx.db
      .insert(purchaseOrders)
      .values({
        companyId: tx.companyId,
        vendorId: input.vendorId,
        poNumber,
        refNumber,
        date: input.date,
        expectedDate: input.expectedDate ?? null,
        status: 'open',
        total: totalStr,
        memo: input.memo ?? null,
      })
      .returning();

    await tx.db.insert(purchaseOrderLines).values(
      computedLines.map((cl) => ({
        purchaseOrderId: po.id,
        itemId: cl.itemId,
        accountId: cl.accountId,
        description: cl.description,
        quantity: cl.quantity,
        rate: cl.rate,
        amount: cl.amount,
        lineOrder: cl.lineOrder,
      })),
    );

    await writeAudit(tx, {
      action: 'create',
      entityType: 'purchase_order',
      entityId: po.id,
      newValues: { poNumber, vendorId: input.vendorId, total: totalStr },
    });

    return { ...po, lines: computedLines };
  });
}

// ---------------------------------------------------------------------------
// listPurchaseOrders
// ---------------------------------------------------------------------------

export async function listPurchaseOrders(
  ctx: ServiceContext,
  opts?: { vendorId?: string; status?: string },
) {
  const conditions = [eq(purchaseOrders.companyId, ctx.companyId)];
  if (opts?.vendorId) conditions.push(eq(purchaseOrders.vendorId, opts.vendorId));
  if (opts?.status) conditions.push(eq(purchaseOrders.status, opts.status as never));

  return ctx.db
    .select()
    .from(purchaseOrders)
    .where(and(...conditions))
    .orderBy(desc(purchaseOrders.date), asc(purchaseOrders.poNumber));
}

// ---------------------------------------------------------------------------
// getPurchaseOrder (header + lines)
// ---------------------------------------------------------------------------

export async function getPurchaseOrder(ctx: ServiceContext, id: string) {
  const [po] = await ctx.db
    .select()
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.companyId, ctx.companyId)));
  if (!po) throw notFound('Purchase order');

  const lines = await ctx.db
    .select()
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.purchaseOrderId, id))
    .orderBy(asc(purchaseOrderLines.lineOrder));

  return { ...po, lines };
}

// ---------------------------------------------------------------------------
// updatePurchaseOrder — edit a saved PO (D1). POs do not post to the GL.
// ---------------------------------------------------------------------------

export interface UpdatePurchaseOrderLineInput extends PurchaseOrderLineInput {
  /** Existing line id (omit for a new line). */
  id?: string | null;
}

export interface UpdatePurchaseOrderInput extends Omit<CreatePurchaseOrderInput, 'lines'> {
  lines: UpdatePurchaseOrderLineInput[];
}

/**
 * Edit an open or partly received/billed purchase order (QB lets you edit a PO until it is
 * closed). Lines that were already (partly) received or billed must stay on the PO with the same
 * item/account and a quantity no smaller than what was received/billed; untouched lines may be
 * removed and new lines added. The PO status is recomputed from the line quantities.
 */
export async function updatePurchaseOrder(ctx: ServiceContext, id: string, input: UpdatePurchaseOrderInput) {
  if (!input.lines || input.lines.length === 0) {
    throw validation('A purchase order must have at least one line.');
  }
  const [vendor] = await ctx.db
    .select({ id: vendors.id })
    .from(vendors)
    .where(and(eq(vendors.id, input.vendorId), eq(vendors.companyId, ctx.companyId)));
  if (!vendor) throw notFound('Vendor');
  const itemText = await assertPoLineRefsOwned(ctx, input.lines);

  return inTransaction(ctx, async (tx) => {
    const [po] = await tx.db
      .select()
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.companyId, tx.companyId)));
    if (!po) throw notFound('Purchase order');
    // Accountant's Copy (I1): both the order's date and the new one.
    await assertDividingDateOpen(tx, po.date);
    await assertDividingDateOpen(tx, input.date);
    if (po.status === 'void') throw new ServiceError('CONFLICT', 'Cannot edit a voided purchase order.');
    if (po.status === 'closed') {
      throw new ServiceError('CONFLICT', 'This purchase order is closed. Closed purchase orders cannot be edited.');
    }
    const renum = await renumberDoc(
      tx, 'purchase_order', id, { refNumber: po.refNumber, number: po.poNumber },
      input.refNumber, { allowDuplicate: input.allowDuplicateNumber === true },
    );
    const oldLines = await tx.db
      .select()
      .from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, id))
      .orderBy(asc(purchaseOrderLines.lineOrder));
    const oldById = new Map(oldLines.map((l) => [l.id, l]));
    const used = (l: (typeof oldLines)[number]) => Money.of(l.quantityBilled ?? '0').greaterThan(0);
    if (po.vendorId !== input.vendorId && oldLines.some(used)) {
      throw new ServiceError('CONFLICT', 'Items on this purchase order were already received or billed, so the vendor cannot change.');
    }

    // Validate + compute each line.
    let total = Money.zero();
    const keepIds = new Set<string>();
    const computed = input.lines.map((l, i) => {
      // Stored at 4 places; the amount is worked out from the stored values (see create).
      const qty = Money.of(Money.of(l.quantity).toFixed(4));
      const rate = Money.of(Money.of(l.rate).toFixed(4));
      if (qty.lessThanOrEqualTo(0)) throw validation(`Line ${i + 1}: quantity must be positive.`);
      if (rate.lessThan(0)) throw validation(`Line ${i + 1}: rate cannot be negative.`);
      if (!l.accountId && !l.itemId) throw validation(`Line ${i + 1}: select an account or an item.`);
      const prev = l.id ? oldById.get(l.id) : undefined;
      if (l.id && !prev) throw notFound(`Purchase order line ${l.id}`);
      if (prev) {
        keepIds.add(prev.id);
        if (used(prev)) {
          if ((prev.itemId ?? null) !== (l.itemId ?? null) || (prev.accountId ?? null) !== (l.accountId ?? null)) {
            throw validation(`Line ${i + 1}: this line was already received or billed — its item/account can't change.`);
          }
          if (qty.lessThan(Money.of(prev.quantityBilled))) {
            throw validation(
              `Line ${i + 1}: quantity can't be less than the ${Money.of(prev.quantityBilled).toFixed(2)} already received or billed.`,
            );
          }
        }
      }
      const amount = Money.round2(Money.mul(qty, rate));
      total = total.plus(amount);
      return {
        id: prev?.id ?? null,
        itemId: l.itemId ?? null,
        accountId: l.accountId ?? null,
        description: poLineDescription(l, itemText),
        quantity: qty.toFixed(4),
        rate: rate.toFixed(4),
        amount: toAmountString(amount),
        lineOrder: i,
      };
    });
    for (const l of oldLines) {
      if (!keepIds.has(l.id) && used(l)) {
        throw validation('A line that was already received or billed cannot be removed from the purchase order.');
      }
    }

    // Apply: delete removed lines, update kept ones, insert new ones.
    for (const l of oldLines) {
      if (!keepIds.has(l.id)) await tx.db.delete(purchaseOrderLines).where(eq(purchaseOrderLines.id, l.id));
    }
    for (const c of computed) {
      const values = {
        itemId: c.itemId,
        accountId: c.accountId,
        description: c.description,
        quantity: c.quantity,
        rate: c.rate,
        amount: c.amount,
        lineOrder: c.lineOrder,
      };
      if (c.id) {
        await tx.db.update(purchaseOrderLines).set(values).where(eq(purchaseOrderLines.id, c.id));
      } else {
        await tx.db.insert(purchaseOrderLines).values({ purchaseOrderId: id, ...values });
      }
    }

    const newLines = await tx.db
      .select()
      .from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, id))
      .orderBy(asc(purchaseOrderLines.lineOrder));
    const { enhancedReceiving } = await getReceivingSettings(tx);
    const status = poStatusFromLines(newLines, enhancedReceiving);

    const [updated] = await tx.db
      .update(purchaseOrders)
      .set({
        vendorId: input.vendorId,
        date: input.date,
        expectedDate: input.expectedDate ?? null,
        memo: input.memo ?? null,
        total: toAmountString(total),
        status,
        ...(renum ? { refNumber: renum.refNumber, poNumber: renum.number } : {}),
      })
      .where(eq(purchaseOrders.id, id))
      .returning();

    await writeAudit(tx, {
      action: 'update',
      entityType: 'purchase_order',
      entityId: id,
      oldValues: {
        vendorId: po.vendorId,
        refNumber: po.refNumber,
        date: po.date,
        expectedDate: po.expectedDate,
        memo: po.memo,
        total: po.total,
        status: po.status,
        lines: oldLines.map((l) => ({ id: l.id, itemId: l.itemId, accountId: l.accountId, quantity: l.quantity, rate: l.rate })),
      },
      newValues: {
        vendorId: input.vendorId,
        refNumber: renum?.refNumber ?? po.refNumber,
        duplicateNumber: renum?.duplicate || undefined,
        date: input.date,
        expectedDate: input.expectedDate ?? null,
        memo: input.memo ?? null,
        total: toAmountString(total),
        status,
        lines: computed,
      },
    });
    return { ...updated, lines: newLines };
  });
}

// ---------------------------------------------------------------------------
// updateStatus
// ---------------------------------------------------------------------------

export async function updateStatus(
  ctx: ServiceContext,
  id: string,
  status: 'open' | 'closed' | 'void',
) {
  // Read + write in ONE transaction: a void racing Convert to Bill must see the quantities the
  // conversion billed (and be refused) instead of voiding a PO that now has a bill.
  return inTransaction(ctx, (tx) => updateStatusInTx(tx, id, status));
}

async function updateStatusInTx(ctx: ServiceContext, id: string, status: 'open' | 'closed' | 'void') {
  const [po] = await ctx.db
    .select()
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.companyId, ctx.companyId)));
  if (!po) throw notFound('Purchase order');
  await assertDividingDateOpen(ctx, po.date); // Accountant's Copy (I1)

  // Close on a voided purchase order turned it back into a closed order (listed with its full
  // amount on the purchase order reports and its PDF). Only Undo of the void reopens it ('open').
  if (po.status === 'void') {
    if (status === 'void') return po; // idempotent
    if (status === 'closed') {
      throw new ServiceError('CONFLICT', 'This purchase order is void, so it cannot be closed.');
    }
  }

  if (po.status === 'closed' && status !== 'closed') {
    throw new ServiceError(
      'CONFLICT',
      'Cannot reopen a closed (converted) purchase order.',
    );
  }

  if (po.status === 'partial' && status === 'open') {
    throw new ServiceError(
      'CONFLICT',
      'Cannot mark a partially billed purchase order as open — its billed quantities already track the open balance.',
    );
  }

  if (po.status === 'partial' && status === 'void') {
    throw new ServiceError(
      'CONFLICT',
      'Cannot void a partially billed purchase order. Close it instead to stop further billing.',
    );
  }
  if (status === 'void' && po.status !== 'void') {
    // The status can lag the lines (manual status, receipts): never void a PO with billed or
    // received quantities.
    const [used] = await ctx.db
      .select({ id: purchaseOrderLines.id })
      .from(purchaseOrderLines)
      .where(and(eq(purchaseOrderLines.purchaseOrderId, id), sql`${purchaseOrderLines.quantityBilled} > 0`))
      .limit(1);
    if (used) {
      throw new ServiceError(
        'CONFLICT',
        'Items on this purchase order were already received or billed, so it cannot be voided. Close it instead to stop further billing.',
      );
    }
  }

  const [updated] = await ctx.db
    .update(purchaseOrders)
    .set({ status })
    .where(eq(purchaseOrders.id, id))
    .returning();

  await writeAudit(ctx, {
    action: 'update',
    entityType: 'purchase_order',
    entityId: id,
    oldValues: { status: po.status },
    newValues: { status },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// convertToBill
// ---------------------------------------------------------------------------

/** A per-line billing request for partial PO billing. */
export interface ConvertToBillLineInput {
  /** purchaseOrderLines.id to bill from. */
  lineId: string;
  /** Quantity to bill now (> 0 and ≤ the line's remaining unbilled quantity). */
  quantity: string | number;
}

export interface ConvertToBillOptions {
  /**
   * Per-line quantities to bill. Lines omitted from the array are not billed.
   * When undefined, every line is billed at its full remaining quantity
   * (legacy full-convert behaviour).
   */
  lines?: ConvertToBillLineInput[];
  /** Bill date — defaults to the PO date. */
  date?: Date;
  /** Vendor bill / reference number for the created bill. */
  billNumber?: string | null;
}

/**
 * Bill a purchase order (fully or partially) — atomically:
 * 1. Validate the PO is billable (not void, not closed) and resolve the billing
 *    plan: requested per-line quantities, or every line's remaining quantity.
 * 2. Inside ONE transaction:
 *    a. Claim each billed line via a guarded conditional UPDATE that increments
 *       quantityBilled only while quantityBilled + qty ≤ quantity. Zero rows
 *       back means a concurrent bill consumed the quantity — throw CONFLICT.
 *       This per-line quantity guard is the idempotency / over-billing guard
 *       (multiple bills per PO are now allowed, so the old single-shot
 *       convertedBillId claim no longer applies).
 *    b. Call `createBill` with the tx context (posts the A/P GL entry in the
 *       same transaction via a savepoint). Item lines pass itemId + quantity +
 *       unitCost through so inventory items receive stock perpetually.
 *    c. Recompute the PO status: 'closed' when every line is fully billed
 *       (stamping convertedBillId with the closing bill), else 'partial'.
 * Any failure rolls back the line claims, the bill, and the GL entry together,
 * so a crash mid-conversion can never leave a posted bill with stale PO
 * quantities (and re-running convert can never double-post A/P).
 */
export async function convertToBill(
  ctx: ServiceContext,
  poId: string,
  opts?: ConvertToBillOptions,
) {
  await assertAccountantMayConvert(ctx, 'Turning a purchase order into a bill'); // Accountant's Copy (I1)
  const [po] = await ctx.db
    .select()
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.companyId, ctx.companyId)));
  if (!po) throw notFound('Purchase order');

  if (po.status === 'closed') {
    throw new ServiceError('CONFLICT', 'Purchase order has already been fully billed.');
  }
  if (po.status === 'void') {
    throw new ServiceError('CONFLICT', 'Cannot convert a voided purchase order.');
  }

  const lines = await ctx.db
    .select()
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.purchaseOrderId, poId))
    .orderBy(asc(purchaseOrderLines.lineOrder));

  if (lines.length === 0) {
    throw validation('Purchase order has no lines to convert.');
  }

  const remainingOf = (l: (typeof lines)[number]) =>
    Money.of(l.quantity).minus(Money.of(l.quantityBilled ?? '0'));

  // --- Resolve the billing plan -------------------------------------------
  type PlanEntry = { line: (typeof lines)[number]; qty: ReturnType<typeof Money.of> };
  const plan: PlanEntry[] = [];

  if (opts?.lines && opts.lines.length > 0) {
    const lineById = new Map(lines.map((l) => [l.id, l]));
    const seen = new Set<string>();
    for (const [i, req] of opts.lines.entries()) {
      const line = lineById.get(req.lineId);
      if (!line) {
        throw validation(`Billing line ${i + 1}: purchase order line not found.`);
      }
      if (seen.has(req.lineId)) {
        throw validation(`Billing line ${i + 1}: duplicate purchase order line.`);
      }
      seen.add(req.lineId);

      const qty = Money.of(req.quantity);
      if (qty.lessThanOrEqualTo(0)) {
        throw validation(`Billing line ${i + 1}: quantity must be positive.`);
      }
      const remaining = remainingOf(line);
      if (qty.greaterThan(remaining)) {
        throw validation(
          `Billing line ${i + 1}: only ${remaining.toFixed(4)} remaining unbilled ` +
            `(ordered ${Money.of(line.quantity).toFixed(4)}, ` +
            `billed ${Money.of(line.quantityBilled ?? '0').toFixed(4)}).`,
        );
      }
      plan.push({ line, qty });
    }
  } else {
    // Default: bill the full remaining quantity of every line.
    for (const line of lines) {
      const remaining = remainingOf(line);
      if (remaining.greaterThan(0)) plan.push({ line, qty: remaining });
    }
  }

  if (plan.length === 0) {
    throw new ServiceError('CONFLICT', 'Purchase order has no unbilled quantity remaining.');
  }

  // --- Map the plan to bill lines (item passthrough → perpetual inventory) --
  const billLineInputs = plan.map(({ line, qty }, i) => {
    if (!line.itemId && !line.accountId) {
      throw validation(
        `Purchase order line ${i + 1} has no account or item; cannot convert to bill.`,
      );
    }
    const amount = toAmountString(Money.round2(Money.mul(qty, line.rate)));
    return line.itemId
      ? {
          // Item line: createBill routes the debit via the item (inventory items
          // go Dr Inventory Asset and receive stock in the same transaction).
          itemId: line.itemId,
          accountId: line.accountId ?? null,
          description: line.description ?? null,
          quantity: qty.toFixed(4),
          unitCost: line.rate,
          amount,
        }
      : {
          accountId: line.accountId,
          description: line.description ?? null,
          quantity: qty.toFixed(4),
          amount,
        };
  });

  return inTransaction(ctx, async (tx) => {
    // Re-check the status inside the transaction: the PO may have been voided or closed since it
    // was read (a void racing this conversion), and a void PO must never get a bill.
    const [cur] = await tx.db
      .select({ status: purchaseOrders.status })
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.companyId, tx.companyId)));
    if (!cur || cur.status === 'void') {
      throw new ServiceError('CONFLICT', 'Cannot convert a voided purchase order.');
    }
    if (cur.status === 'closed') {
      throw new ServiceError('CONFLICT', 'Purchase order has already been fully billed.');
    }
    // Claim each line's quantity with a guarded conditional UPDATE. If a
    // concurrent conversion already consumed the quantity, zero rows come back
    // and we bail without posting anything.
    for (const { line, qty } of plan) {
      const qtyStr = qty.toFixed(4);
      const claimed = await tx.db
        .update(purchaseOrderLines)
        .set({
          quantityBilled: sql`${purchaseOrderLines.quantityBilled} + ${qtyStr}::numeric`,
        })
        .where(
          and(
            eq(purchaseOrderLines.id, line.id),
            eq(purchaseOrderLines.purchaseOrderId, poId),
            sql`${purchaseOrderLines.quantityBilled} + ${qtyStr}::numeric <= ${purchaseOrderLines.quantity}`,
          ),
        )
        .returning({ id: purchaseOrderLines.id });
      if (claimed.length === 0) {
        throw new ServiceError(
          'CONFLICT',
          'Purchase order quantities were billed by another transaction. Reload and retry.',
        );
      }
    }

    // Passing the tx context means the bill + GL entry post inside this
    // transaction (createBill's own inTransaction becomes a savepoint).
    const bill = await createBill(tx, {
      vendorId: po.vendorId,
      billNumber: opts?.billNumber ?? null,
      date: opts?.date ?? po.date,
      // The PO's expected date is a DELIVERY date, not a payment due date: leave it blank so
      // createBill works the due date out from the vendor's terms (QB parity).
      dueDate: null,
      memo: po.memo,
      lines: billLineInputs,
    });

    // Recompute PO status from the post-claim line quantities. With enhanced receiving on, a
    // PO that still has received-but-unbilled item-receipt quantity stays 'partial'.
    const refreshed = await tx.db
      .select({
        quantity: purchaseOrderLines.quantity,
        quantityBilled: purchaseOrderLines.quantityBilled,
        quantityReceivedUnbilled: purchaseOrderLines.quantityReceivedUnbilled,
      })
      .from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, poId));
    const { enhancedReceiving } = await getReceivingSettings(tx);
    const fullyBilled = poStatusFromLines(refreshed, enhancedReceiving) === 'closed';
    const newStatus = fullyBilled ? ('closed' as const) : ('partial' as const);

    await tx.db
      .update(purchaseOrders)
      .set({
        status: newStatus,
        // Stamp the bill that completes the PO (legacy full-convert semantics);
        // earlier partial bills are linked via quantityBilled + the audit trail.
        ...(fullyBilled && !po.convertedBillId ? { convertedBillId: bill.id } : {}),
      })
      .where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.companyId, tx.companyId)));

    await writeAudit(tx, {
      action: 'update',
      entityType: 'purchase_order',
      entityId: poId,
      oldValues: { status: po.status },
      newValues: {
        status: newStatus,
        billId: bill.id,
        // billLineOrder: the bill line that billed it (createBill keeps the plan's order), so an
        // edit of the bill can move the PO's billed quantity with it (syncPoBillingForBillEdit).
        billedQuantities: plan.map(({ line, qty }, i) => ({
          lineId: line.id,
          quantity: qty.toFixed(4),
          billLineOrder: i,
        })),
      },
    });

    return bill;
  });
}

/**
 * A bill converted from a purchase order is being voided (call INSIDE voidBill's transaction):
 * give the PO lines back the quantities that bill claimed, so the PO can be billed again (QB
 * reopens the PO). The claim is read from convertToBill's audit row ({ billId, billedQuantities }),
 * which is written in the same transaction as the claim. A PO whose status the user set by hand
 * (e.g. closed early) keeps it; otherwise the status is recomputed from the lines.
 */
/** One purchase-order line quantity a bill holds (its conversion claim, net of later bill edits). */
export interface PoBillClaim {
  poId: string;
  lineId: string;
  /** The bill line (lineOrder) that bills it. */
  billLineOrder: number;
  quantity: ReturnType<typeof Money.zero>;
}

/**
 * The PO line quantities a bill holds: convertToBill's audit row ({ billId, billedQuantities }) plus
 * the signed adjustments a later edit of the bill recorded (syncPoBillingForBillEdit), netted per
 * PO line and bill line, in PO order. Rows written before billLineOrder was recorded map by their
 * position in the conversion (createBill keeps that order).
 */
export async function poClaimsForBill(ctx: ServiceContext, billId: string): Promise<PoBillClaim[]> {
  const rows = await ctx.db
    .select({ entityId: auditLogs.entityId, newValues: auditLogs.newValues })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.companyId, ctx.companyId),
        eq(auditLogs.entityType, 'purchase_order'),
        sql`${auditLogs.newValues}->>'billId' = ${billId}`,
        sql`${auditLogs.newValues}->'billedQuantities' IS NOT NULL`,
      ),
    )
    .orderBy(asc(auditLogs.createdAt));
  const net = new Map<string, PoBillClaim>();
  for (const row of rows) {
    const nv = (row.newValues ?? {}) as {
      billedQuantities?: Array<{ lineId?: string; quantity?: string; billLineOrder?: number }>;
    };
    (nv.billedQuantities ?? []).forEach((c, i) => {
      if (!row.entityId || !c.lineId) return;
      let qty;
      try {
        qty = Money.of(c.quantity ?? 0);
      } catch {
        return; // malformed history
      }
      const billLineOrder = Number.isInteger(c.billLineOrder) ? (c.billLineOrder as number) : i;
      const key = `${row.entityId}|${c.lineId}|${billLineOrder}`;
      const prev = net.get(key);
      net.set(key, { poId: row.entityId, lineId: c.lineId, billLineOrder, quantity: (prev?.quantity ?? Money.zero()).plus(qty) });
    });
  }
  return [...net.values()];
}

/**
 * A bill made from a purchase order is being edited (call INSIDE updateBill's transaction, with
 * the bill's saved lines and the new ones): the PO's billed quantity follows the bill. QB updates
 * the P.O.'s "Rcv'd" column when such a bill's quantity changes; the PO used to keep the original
 * claim (a bill cut from 10 to 6 units left the P.O. closed with 10 billed, so the 4 still owed
 * could never be billed, and its received figure overstated what came in).
 *
 * The PO line stays tied to the bill line that billed it: that line must stay on the bill with the
 * same item (its quantity, cost and account may change). The vendor can't change.
 */
export async function syncPoBillingForBillEdit(
  ctx: ServiceContext,
  input: {
    billId: string;
    vendorChanged: boolean;
    oldLines: ReadonlyArray<{ lineOrder: number; itemId: string | null; quantity: string }>;
    newLines: ReadonlyArray<{ itemId: string | null; quantity: string }>;
  },
): Promise<void> {
  const claims = (await poClaimsForBill(ctx, input.billId)).filter((c) => c.quantity.greaterThan(0));
  if (claims.length === 0) return;
  const poIds = [...new Set(claims.map((c) => c.poId))];
  const pos = await ctx.db
    .select()
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.companyId, ctx.companyId), inArray(purchaseOrders.id, poIds)));
  const poById = new Map(pos.map((p) => [p.id, p] as const));
  const label = (poId: string) => {
    const p = poById.get(poId);
    return p ? `purchase order #${p.refNumber || p.poNumber}` : 'a purchase order';
  };
  if (input.vendorChanged) {
    throw new ServiceError(
      'CONFLICT',
      `This bill was created from ${label(claims[0].poId)}, so its vendor can't change. Void it and enter the other vendor's bill instead.`,
    );
  }
  // 1. Validate every PO-linked line and work out how far each PO line's billed quantity moves.
  const oldByOrder = new Map(input.oldLines.map((l) => [l.lineOrder, l] as const));
  const deltas = new Map<string, Array<{ claim: PoBillClaim; delta: ReturnType<typeof Money.zero> }>>();
  for (const c of claims) {
    const before = oldByOrder.get(c.billLineOrder);
    const after = input.newLines[c.billLineOrder];
    if (!before || !after || (after.itemId ?? null) !== (before.itemId ?? null)) {
      throw new ServiceError(
        'CONFLICT',
        `Line ${c.billLineOrder + 1} of this bill was billed from ${label(c.poId)}. Keep it on the bill with the same item (you can change its quantity, cost or account); to remove or replace it, void the bill and create it from the purchase order again.`,
      );
    }
    const newQty = Money.of(after.quantity);
    if (newQty.equals(Money.of(before.quantity))) continue;
    const delta = newQty.minus(c.quantity);
    if (delta.isZero()) continue;
    const list = deltas.get(c.poId) ?? [];
    list.push({ claim: c, delta });
    deltas.set(c.poId, list);
  }
  if (deltas.size === 0) return;

  // 2. Move the counters (guarded: never past the ordered quantity or below zero) and re-derive
  //    the PO status; a status the user set by hand (closed early) is kept, as on a bill void.
  const { enhancedReceiving } = await getReceivingSettings(ctx);
  const linesOf = async (poId: string) =>
    ctx.db
      .select({
        quantity: purchaseOrderLines.quantity,
        quantityBilled: purchaseOrderLines.quantityBilled,
        quantityReceivedUnbilled: purchaseOrderLines.quantityReceivedUnbilled,
      })
      .from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, poId));
  for (const [poId, changes] of deltas) {
    const po = poById.get(poId);
    if (!po) continue;
    const derivedBefore = poStatusFromLines(await linesOf(poId), enhancedReceiving);
    for (const { claim: c, delta } of changes) {
      const d = delta.toFixed(4);
      const moved = await ctx.db
        .update(purchaseOrderLines)
        .set({ quantityBilled: sql`${purchaseOrderLines.quantityBilled} + ${d}::numeric` })
        .where(
          and(
            eq(purchaseOrderLines.id, c.lineId),
            eq(purchaseOrderLines.purchaseOrderId, c.poId),
            sql`${purchaseOrderLines.quantityBilled} + ${d}::numeric <= ${purchaseOrderLines.quantity}`,
            sql`${purchaseOrderLines.quantityBilled} + ${d}::numeric >= 0`,
          ),
        )
        .returning({ id: purchaseOrderLines.id });
      if (moved.length === 0) {
        const [pl] = await ctx.db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.id, c.lineId));
        const open = pl ? Money.of(pl.quantity).minus(Money.of(pl.quantityBilled ?? '0')) : Money.zero();
        throw validation(
          `Line ${c.billLineOrder + 1}: ${label(c.poId)} has ${c.quantity.plus(open).toFixed(2)} on order for this line that this bill can take (${c.quantity.toFixed(2)} billed here, ${open.toFixed(2)} not yet billed). Change the purchase order first to bill more.`,
        );
      }
    }
    const derivedAfter = poStatusFromLines(await linesOf(poId), enhancedReceiving);
    const status = po.status !== derivedBefore ? po.status : derivedAfter;
    await ctx.db
      .update(purchaseOrders)
      .set({
        status: status as never,
        ...(status !== 'closed' && po.convertedBillId === input.billId ? { convertedBillId: null } : {}),
        ...(status === 'closed' && !po.convertedBillId ? { convertedBillId: input.billId } : {}),
      })
      .where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.companyId, ctx.companyId)));
    // The signed adjustment, read back by poClaimsForBill (a later edit or the bill's void).
    await writeAudit(ctx, {
      action: 'update',
      entityType: 'purchase_order',
      entityId: poId,
      oldValues: { status: po.status },
      newValues: {
        status,
        reason: 'bill_edited',
        billId: input.billId,
        billedQuantities: changes.map(({ claim, delta }) => ({
          lineId: claim.lineId,
          quantity: delta.toFixed(4),
          billLineOrder: claim.billLineOrder,
        })),
      },
    });
  }
}

export async function releasePoBillingForBill(ctx: ServiceContext, billId: string): Promise<void> {
  // Net per PO line across the conversion and any later edits of the bill.
  const byPo = new Map<string, Array<{ lineId: string; quantity: string }>>();
  for (const c of await poClaimsForBill(ctx, billId)) {
    if (!c.quantity.greaterThan(0)) continue;
    const list = byPo.get(c.poId) ?? [];
    const same = list.find((x) => x.lineId === c.lineId);
    if (same) same.quantity = Money.of(same.quantity).plus(c.quantity).toFixed(4);
    else list.push({ lineId: c.lineId, quantity: c.quantity.toFixed(4) });
    byPo.set(c.poId, list);
  }
  for (const [poId, claims] of byPo) {
    const [po] = await ctx.db
      .select()
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.companyId, ctx.companyId)));
    if (!po || po.status === 'void') continue;

    const { enhancedReceiving } = await getReceivingSettings(ctx);
    const linesNow = async () =>
      ctx.db
        .select({
          quantity: purchaseOrderLines.quantity,
          quantityBilled: purchaseOrderLines.quantityBilled,
          quantityReceivedUnbilled: purchaseOrderLines.quantityReceivedUnbilled,
        })
        .from(purchaseOrderLines)
        .where(eq(purchaseOrderLines.purchaseOrderId, poId));
    // Status the lines imply before the release; a different stored status was set by hand.
    const derivedBefore = poStatusFromLines(await linesNow(), enhancedReceiving);

    for (const c of claims) {
      const qtyStr = Money.of(c.quantity!).toFixed(4);
      await ctx.db
        .update(purchaseOrderLines)
        .set({ quantityBilled: sql`GREATEST(${purchaseOrderLines.quantityBilled} - ${qtyStr}::numeric, 0)` })
        .where(and(eq(purchaseOrderLines.id, c.lineId!), eq(purchaseOrderLines.purchaseOrderId, poId)));
    }

    const derivedAfter = poStatusFromLines(await linesNow(), enhancedReceiving);
    const keepManualStatus = po.status !== derivedBefore;
    const newStatus = keepManualStatus ? po.status : derivedAfter;
    await ctx.db
      .update(purchaseOrders)
      .set({
        status: newStatus as never,
        ...(po.convertedBillId === billId ? { convertedBillId: null } : {}),
      })
      .where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.companyId, ctx.companyId)));
    await writeAudit(ctx, {
      action: 'update',
      entityType: 'purchase_order',
      entityId: poId,
      oldValues: { status: po.status },
      newValues: {
        status: newStatus,
        reason: 'bill_voided',
        voidedBillId: billId,
        releasedQuantities: claims.map((c) => ({ lineId: c.lineId, quantity: Money.of(c.quantity!).toFixed(4) })),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Item-receipt quantity links (QB "Receive Items" against a PO)
// ---------------------------------------------------------------------------
//
// Item receipts (lib/services/itemReceipts.ts) consume PO quantities through the
// SAME purchaseOrderLines.quantityBilled counter that convertToBill uses, so a
// quantity received on an item receipt can never be billed again from the PO
// (and vice versa). Receipts reference PO lines by ITEM (item_receipt_lines has
// no PO-line column), so claims are allocated greedily across the PO's lines for
// that item in lineOrder; releases (receipt void) walk the same lines in reverse.

/** A received-quantity request keyed by item (receipts link to POs by item). */
export interface ReceiptQuantityRequest {
  itemId: string;
  quantity: string | number;
}

/** Sum requests per item so multiple receipt lines for one item claim once. */
function aggregateByItem(
  requests: ReceiptQuantityRequest[],
): Map<string, ReturnType<typeof Money.zero>> {
  const byItem = new Map<string, ReturnType<typeof Money.zero>>();
  for (const r of requests) {
    const qty = Money.of(r.quantity);
    if (qty.lessThanOrEqualTo(0)) continue;
    const prev = byItem.get(r.itemId);
    byItem.set(r.itemId, prev ? prev.plus(qty) : qty);
  }
  return byItem;
}

/** Recompute open/partial/closed from line quantities after a claim or release. */
async function recomputePoStatusFromLines(
  ctx: ServiceContext,
  poId: string,
  prevStatus: string,
  reason: string,
): Promise<'open' | 'partial' | 'closed'> {
  const refreshed = await ctx.db
    .select({
      quantity: purchaseOrderLines.quantity,
      quantityBilled: purchaseOrderLines.quantityBilled,
      quantityReceivedUnbilled: purchaseOrderLines.quantityReceivedUnbilled,
    })
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.purchaseOrderId, poId));

  // Enhanced receiving keeps a fully received PO 'partial' until its receipts are billed.
  const { enhancedReceiving } = await getReceivingSettings(ctx);
  const newStatus = poStatusFromLines(refreshed, enhancedReceiving);

  if (newStatus !== prevStatus) {
    await ctx.db
      .update(purchaseOrders)
      .set({ status: newStatus })
      .where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.companyId, ctx.companyId)));
    await writeAudit(ctx, {
      action: 'update',
      entityType: 'purchase_order',
      entityId: poId,
      oldValues: { status: prevStatus },
      newValues: { status: newStatus, reason },
    });
  }
  return newStatus;
}

/**
 * Claim received quantities against a PO for an item receipt. Call INSIDE the
 * receipt's transaction. Validates the PO (exists, not void/closed, optional
 * vendor match) and that every requested item has enough remaining unbilled
 * quantity, then increments quantityBilled with the same guarded conditional
 * UPDATE convertToBill uses (zero rows back = concurrent consumer -> CONFLICT).
 */
export async function claimReceiptQuantities(
  ctx: ServiceContext,
  poId: string,
  requests: ReceiptQuantityRequest[],
  opts?: { vendorId?: string; sourceRef?: string },
): Promise<void> {
  const [po] = await ctx.db
    .select()
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.companyId, ctx.companyId)));
  if (!po) throw notFound('Purchase order');
  if (po.status === 'void') {
    throw new ServiceError('CONFLICT', 'Cannot receive against a voided purchase order.');
  }
  if (po.status === 'closed') {
    throw new ServiceError('CONFLICT', 'Cannot receive against a closed purchase order.');
  }
  if (opts?.vendorId && po.vendorId !== opts.vendorId) {
    throw validation('The purchase order belongs to a different vendor.');
  }

  const lines = await ctx.db
    .select()
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.purchaseOrderId, poId))
    .orderBy(asc(purchaseOrderLines.lineOrder));

  for (const [itemId, qty] of aggregateByItem(requests)) {
    const candidates = lines.filter((l) => l.itemId === itemId);
    if (candidates.length === 0) {
      throw validation(
        `Item ${itemId} is not on purchase order #${po.poNumber}. Remove the PO link or receive it without a PO.`,
      );
    }
    const remainingTotal = candidates.reduce(
      (sum, l) => sum.plus(Money.of(l.quantity).minus(Money.of(l.quantityBilled ?? '0'))),
      Money.zero(),
    );
    if (qty.greaterThan(remainingTotal)) {
      throw validation(
        `Only ${remainingTotal.toFixed(4)} of this item remain unreceived on purchase order #${po.poNumber}.`,
      );
    }

    // Greedy allocation across the PO's lines for this item (lineOrder).
    let left = qty;
    for (const line of candidates) {
      if (left.lessThanOrEqualTo(0)) break;
      const remaining = Money.of(line.quantity).minus(Money.of(line.quantityBilled ?? '0'));
      if (!remaining.greaterThan(0)) continue;
      const take = left.lessThanOrEqualTo(remaining) ? left : remaining;
      const takeStr = take.toFixed(4);
      const claimed = await ctx.db
        .update(purchaseOrderLines)
        .set({
          quantityBilled: sql`${purchaseOrderLines.quantityBilled} + ${takeStr}::numeric`,
          // Enhanced receiving: received on a receipt, not yet vendor-billed.
          quantityReceivedUnbilled: sql`${purchaseOrderLines.quantityReceivedUnbilled} + ${takeStr}::numeric`,
        })
        .where(
          and(
            eq(purchaseOrderLines.id, line.id),
            eq(purchaseOrderLines.purchaseOrderId, poId),
            sql`${purchaseOrderLines.quantityBilled} + ${takeStr}::numeric <= ${purchaseOrderLines.quantity}`,
          ),
        )
        .returning({ id: purchaseOrderLines.id });
      if (claimed.length === 0) {
        throw new ServiceError(
          'CONFLICT',
          'Purchase order quantities were consumed by another transaction. Reload and retry.',
        );
      }
      left = left.minus(take);
    }
    if (left.greaterThan(0)) {
      throw new ServiceError(
        'CONFLICT',
        'Purchase order quantities were consumed by another transaction. Reload and retry.',
      );
    }
  }

  await recomputePoStatusFromLines(ctx, poId, po.status, opts?.sourceRef ?? 'item_receipt_claim');
}

/**
 * Release previously claimed receipt quantities (item receipt void). Decrements
 * quantityBilled greedily across the PO's lines for each item (reverse
 * lineOrder), guarded so it can never go below zero, then recomputes the PO
 * status (a fully released PO returns to 'open').
 */
export async function releaseReceiptQuantities(
  ctx: ServiceContext,
  poId: string,
  requests: ReceiptQuantityRequest[],
  opts?: { sourceRef?: string },
): Promise<void> {
  const [po] = await ctx.db
    .select()
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.companyId, ctx.companyId)));
  if (!po) throw notFound('Purchase order');

  const lines = await ctx.db
    .select()
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.purchaseOrderId, poId))
    .orderBy(asc(purchaseOrderLines.lineOrder));

  for (const [itemId, qty] of aggregateByItem(requests)) {
    // Walk in reverse lineOrder — undo claims from the lines filled last.
    const candidates = lines.filter((l) => l.itemId === itemId).reverse();
    const billedTotal = candidates.reduce(
      (sum, l) => sum.plus(Money.of(l.quantityBilled ?? '0')),
      Money.zero(),
    );
    if (qty.greaterThan(billedTotal)) {
      throw new ServiceError(
        'CONFLICT',
        `Cannot release ${qty.toFixed(4)} of item ${itemId} from purchase order #${po.poNumber}: only ${billedTotal.toFixed(4)} is recorded as received/billed.`,
      );
    }

    let left = qty;
    for (const line of candidates) {
      if (left.lessThanOrEqualTo(0)) break;
      const billed = Money.of(line.quantityBilled ?? '0');
      if (!billed.greaterThan(0)) continue;
      const give = left.lessThanOrEqualTo(billed) ? left : billed;
      const giveStr = give.toFixed(4);
      const released = await ctx.db
        .update(purchaseOrderLines)
        .set({
          quantityBilled: sql`${purchaseOrderLines.quantityBilled} - ${giveStr}::numeric`,
          // Clamped: receipts entered before enhanced receiving carry no counter.
          quantityReceivedUnbilled: sql`GREATEST(${purchaseOrderLines.quantityReceivedUnbilled} - ${giveStr}::numeric, 0)`,
        })
        .where(
          and(
            eq(purchaseOrderLines.id, line.id),
            eq(purchaseOrderLines.purchaseOrderId, poId),
            sql`${purchaseOrderLines.quantityBilled} - ${giveStr}::numeric >= 0`,
          ),
        )
        .returning({ id: purchaseOrderLines.id });
      if (released.length === 0) {
        throw new ServiceError(
          'CONFLICT',
          'Purchase order quantities changed in another transaction. Reload and retry.',
        );
      }
      left = left.minus(give);
    }
    if (left.greaterThan(0)) {
      throw new ServiceError(
        'CONFLICT',
        'Purchase order quantities changed in another transaction. Reload and retry.',
      );
    }
  }

  await recomputePoStatusFromLines(ctx, poId, po.status, opts?.sourceRef ?? 'item_receipt_release');
}
