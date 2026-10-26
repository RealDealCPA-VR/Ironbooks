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
import { and, asc, desc, eq, inArray, ne, notInArray, sql } from 'drizzle-orm';
import type Decimal from 'decimal.js';
import { accounts, bills, billLines, classes, customers, inventoryLayers, items, jobs, loanPayments, vendors } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type DiscountInfo, discountFor, dueDateFromTerms } from './billTerms';
import { computeDiscount, computeDueDate, dueDateFromTermsList, findTermsRef, type TermsLike, type TermsRow } from './lists/terms';
import { duplicateNumberFixes } from '@/lib/errorFixes';
import { getPreferences } from './company';
import { homeAmounts, resolveDocumentCurrency } from './currencies';
import { postJournalEntry, voidJournalEntry } from '@/lib/services/posting';
import {
  type DocumentInventoryLine,
  type InventoryLineDetail,
  attachInventoryDetails,
  postDocumentInventory,
  reverseDocumentInventory,
} from './inventorySites';
import { assertNoActiveLandedCost } from './landedCost';
import { valueRemainderAfter } from './inventory';
import { layerRoundingTolerance, purchaseLayerRefs, takeFromDocumentLayers } from './fifo';
import {
  type ServiceContext,
  ServiceError,
  assertRefInCompany,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { billHasReceiptLinks, releaseReceiptBilling } from './receivingLinks';
import { assertRedateAfterVendorCreditSteps, clearSettledForeignApplications } from './vendorCreditsFx';

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
  /** Explicit due date; when omitted it is computed from the terms (bill terms, else vendor terms). */
  dueDate?: Date | null;
  /** Payment terms ('net_30', '2_10_net_30', …); defaults to the vendor's terms. */
  terms?: string | null;
  memo?: string | null;
  classId?: string | null;
  /** Transaction currency (defaults to the vendor's currency; null/home = no conversion). */
  currency?: string | null;
  /** Home-currency units per 1 transaction-currency unit (defaults to the currency list rate). */
  exchangeRate?: string | number | null;
  /**
   * QB duplicate vendor reference warning (A4): when true, refuse (CONFLICT, details
   * { duplicateNumber: true }) a bill number already used on another open bill from the same
   * vendor. User-facing routes set it unless the user confirmed the duplicate; internal callers
   * (PO / receipt conversion, recurring) leave it off.
   */
  checkDuplicateNumber?: boolean;
  lines: BillLineInput[];
}

/** Other non-void bills from the same vendor that already use this vendor reference number. */
export async function findDuplicateBillNumbers(
  ctx: ServiceContext,
  params: { vendorId: string; billNumber: string | null | undefined; excludeId?: string },
) {
  const num = (params.billNumber ?? '').trim();
  if (!num) return [];
  return ctx.db
    .select({ id: bills.id, date: bills.date, total: bills.total, billNumber: bills.billNumber })
    .from(bills)
    .where(
      and(
        eq(bills.companyId, ctx.companyId),
        eq(bills.vendorId, params.vendorId),
        ne(bills.status, 'void'),
        sql`lower(trim(${bills.billNumber})) = ${num.toLowerCase()}`,
        ...(params.excludeId ? [ne(bills.id, params.excludeId)] : []),
      ),
    );
}

async function assertBillNumberAvailable(ctx: ServiceContext, input: CreateBillInput, excludeId?: string) {
  if (!input.checkDuplicateNumber) return;
  // Preferences > Bills: "Warn about duplicate bill numbers from same vendor" off accepts it silently.
  if (!(await getPreferences(ctx)).warnDuplicateBillNumbers) return;
  const matches = await findDuplicateBillNumbers(ctx, {
    vendorId: input.vendorId,
    billNumber: input.billNumber,
    excludeId,
  });
  if (matches.length > 0) {
    const num = (input.billNumber ?? '').trim();
    throw new ServiceError(
      'CONFLICT',
      `This vendor already has a bill with reference number ${num}. Check that this is not the same bill entered twice, or confirm to keep the duplicate.`,
      { duplicateNumber: true, number: num, matches },
    ).withFixes(
      // A vendor's own reference number has no "next" value: offer keeping it (existing override).
      duplicateNumberFixes({
        number: num,
        nextNumber: null,
        field: 'billNumber',
        overrideFlag: { path: 'allowDuplicateNumber', value: true },
        label: 'reference number',
      }),
    );
  }
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

/**
 * Per-unit cost an item line stocks its units at. QB recalculates the cost from the amount when
 * the amount is typed over qty x cost, so a line whose amount differs from round2(qty x unit
 * cost) is costed at amount / qty — the value its entry debits to the inventory account (the FIFO
 * layer / average cost then equal the GL, and a void takes out exactly what the line added).
 * A consistent line keeps the cost typed (more precise than amount / qty).
 */
export function purchaseUnitCost(
  qty: Decimal,
  typedUnitCost: string | number | null | undefined,
  amount: Decimal,
): Decimal {
  if (typedUnitCost == null || (typeof typedUnitCost === 'string' && typedUnitCost.trim() === '')) {
    return amount.dividedBy(qty);
  }
  const typed = Money.of(typedUnitCost);
  return Money.round2(qty.times(typed)).equals(Money.round2(amount)) ? typed : amount.dividedBy(qty);
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
  amount: string; // 2dp, transaction currency
  /** Home-currency amount posted to the GL (== amount for home-currency bills). */
  homeAmount: string;
  /** Per-unit cost in HOME currency (Decimal) — only set for inventory item lines. */
  unitCost: ReturnType<typeof Money.zero> | null;
  isInventory: boolean;
  classId: string | null;
  customerId: string | null;
  jobId: string | null;
};

interface PreparedBill {
  vendor: { id: string; name: string };
  resolvedLines: ResolvedLine[];
  /** Bill total in the transaction currency. */
  totalStr: string;
  /** A/P credit in home currency (anchor; == totalStr for home-currency bills). */
  homeTotalStr: string;
  currency: string | null;
  rate: Decimal;
  terms: string | null;
  dueDate: Date | null;
  apAccountId: string;
}

/**
 * Validate a bill input (vendor ownership, line shapes) and resolve each line to
 * { debit account, amount, qty, unitCost } using Money (no JS floats). Read-only.
 */
async function prepareBill(ctx: ServiceContext, input: CreateBillInput): Promise<PreparedBill> {
  // --- Validate vendor belongs to this company ---
  const [vendorRow] = await ctx.db
    .select({
      id: vendors.id,
      name: vendors.displayName,
      terms: vendors.terms,
      currency: vendors.currency,
    })
    .from(vendors)
    .where(and(eq(vendors.id, input.vendorId), eq(vendors.companyId, ctx.companyId)));
  if (!vendorRow) throw notFound('Vendor');
  const vendor = { id: vendorRow.id, name: vendorRow.name };

  // --- Currency (vendor's currency by default) ---
  const fx = await resolveDocumentCurrency(ctx, {
    currency: input.currency,
    exchangeRate: input.exchangeRate,
    vendorCurrency: vendorRow.currency,
  });

  // --- Terms + due date (explicit due date wins) ---
  const terms = (input.terms ?? vendorRow.terms ?? null) || null;
  // B5: the Terms list (standard / date-driven) decides; legacy free text falls back to the parser.
  const dueDate = input.dueDate ?? (await dueDateFromTermsList(ctx, terms, input.date));

  // --- Validate lines ---
  if (!input.lines || input.lines.length === 0) {
    throw validation('A bill must have at least one line.');
  }

  // Class (bill and line) and billable customer:job must belong to this company.
  const refs: Array<[typeof classes | typeof customers | typeof jobs, Array<string | null | undefined>, string]> = [
    [classes, [input.classId, ...input.lines.map((l) => l.classId)], 'Class'],
    [customers, input.lines.map((l) => l.customerId), 'Customer'],
    [jobs, input.lines.map((l) => l.jobId), 'Job'],
  ];
  for (const [table, ids, label] of refs) {
    for (const id of new Set(ids.filter((v): v is string => !!v))) await assertRefInCompany(ctx, table, id, label);
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
      const unitCost = purchaseUnitCost(qty, line.unitCost, amount);
      if (unitCost.isNegative() || (line.unitCost != null && Money.of(line.unitCost).isNegative())) {
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
        homeAmount: toAmountString(amount),
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
        homeAmount: toAmountString(amt),
        unitCost: null,
        isInventory: false,
        classId: line.classId ?? input.classId ?? null,
        customerId: line.customerId ?? null,
        jobId: line.jobId ?? null,
      });
      total = total.plus(amt);
    }
  }

  // Home-currency amounts: one anchor (round2(total x rate)) penny-allocated across the lines,
  // so the entry balances exactly. Inventory cost is carried in home currency.
  const home = homeAmounts(
    resolvedLines.map((l) => l.amount),
    fx.rate,
  );
  if (fx.currency) {
    resolvedLines.forEach((l, i) => {
      if (!home.lines[i].greaterThan(0)) {
        throw validation(`Line ${i + 1}: the amount is too small to convert to your home currency.`);
      }
      l.homeAmount = toAmountString(home.lines[i]);
      if (l.isInventory) l.unitCost = home.lines[i].dividedBy(Money.of(l.quantity));
    });
  }

  // Resolve A/P account up front (read-only; no need to hold a tx lock).
  const apAccountId = await resolveApAccount(ctx);

  return {
    vendor,
    resolvedLines,
    totalStr: toAmountString(total),
    homeTotalStr: toAmountString(home.total),
    currency: fx.currency,
    rate: fx.rate,
    terms,
    dueDate,
    apAccountId,
  };
}

// ---------------------------------------------------------------------------
// Stock subledger helpers (the GL side lives on the bill's own journal entry)
// ---------------------------------------------------------------------------

/** One purchased inventory line for the stock subledger (unit cost in HOME currency). */
export interface PurchasedStockLine {
  itemId: string | null;
  isInventory: boolean;
  quantity: string | number;
  unitCost: ReturnType<typeof Money.zero> | null;
  /** The HOME amount the document posted for the line (default round2(quantity × unitCost)). */
  homeAmount?: string | ReturnType<typeof Money.zero> | null;
}

/**
 * Receive stock for purchased inventory item lines (same transaction as the document's posting).
 * Shared by bills and by checks / credit-card charges with an Items tab. The document's own
 * journal entry already debited the inventory asset account, so this step only moves the
 * quantity/cost subledger:
 *   FIFO-tracked items  -> new cost layer at the line's unit cost (layer sourceRef = `sourceRef`).
 *   average-cost items  -> weighted-average cost update.
 */
export async function receivePurchasedStock(
  tx: ServiceContext,
  sourceRef: string,
  date: Date,
  lines: PurchasedStockLine[],
  reason: string,
) {
  for (const line of lines) {
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
        sourceRef,
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
      // The cents the 4dp average cannot represent stay on record and leave with the last unit.
      const posted = line.homeAmount != null ? Money.of(line.homeAmount) : Money.round2(qty.times(line.unitCost));
      await tx.db
        .update(items)
        .set({
          quantityOnHand: newQty.toFixed(4),
          averageCost: newAvg.toFixed(4),
          ...valueRemainderAfter(item, currentQty, newQty, newAvg, posted),
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
        reason,
      },
    });
  }
}

/** A previously received line to pull back out (HOME-currency line amount). */
export interface ReceivedStockLine {
  itemId: string | null;
  quantity: string | number;
  homeAmount: string | number | Decimal;
}

/**
 * Reverse stock received by purchased item lines. The matching GL reversal must already have
 * happened via voidJournalEntry; this step pulls the quantity/cost back out of the subledger.
 * `docLabel` is used in the plain-language error ("this bill's", "this check's").
 */
export async function reversePurchasedStock(
  tx: ServiceContext,
  lines: ReceivedStockLine[],
  reason: string,
  docLabel = "this bill's",
  /**
   * inventory_layers.source_ref the document's receipt tagged its FIFO layers with (bill:<id>,
   * expense:<id>). Default: derived from the reason's trailing document id.
   */
  layerSourceRef?: string,
) {
  const ownRefs = layerSourceRef ? [layerSourceRef] : purchaseLayerRefs(reason);
  for (const line of lines) {
    if (!line.itemId) continue;
    const [item] = await tx.db
      .select()
      .from(items)
      .where(and(eq(items.companyId, tx.companyId), eq(items.id, line.itemId)));
    if (!item || item.type !== 'inventory') continue;

    const qty = Money.of(line.quantity);
    if (qty.lessThanOrEqualTo(0)) continue;
    const unitCost = Money.of(line.homeAmount).dividedBy(qty);

    const currentQty = Money.of(item.quantityOnHand ?? '0');
    if (currentQty.lessThan(qty)) {
      throw new ServiceError(
        'CONFLICT',
        `Cannot reverse ${docLabel} receipt: only ${currentQty.toFixed(4)} of "${item.name}" remain on hand (the received stock has already been consumed).`,
      );
    }
    const newQty = currentQty.minus(qty);

    const fifoTracked = await isFifoTracked(tx, line.itemId);
    // The document's own layers (tagged with its sourceRef when received): exactly what it added,
    // or a CONFLICT when its units were sold / revalued since (fifo.ts takeFromDocumentLayers).
    const own = fifoTracked
      ? await takeFromDocumentLayers(tx, {
          itemId: line.itemId,
          itemName: item.name,
          sourceRefs: ownRefs,
          qty,
          expectedValue: Money.of(line.homeAmount),
          unitCost,
          action: `reverse ${docLabel} receipt`,
        })
      : null;
    if (own) {
      await tx.db
        .update(items)
        .set({ quantityOnHand: newQty.toFixed(4), updatedAt: new Date() })
        .where(eq(items.id, line.itemId));
    } else if (fifoTracked) {
      // Older data (layers not tagged with their document): prefer layers at this document's unit
      // cost, newest first, then fall back to FIFO (oldest-first).
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
          `Cannot reverse ${docLabel} receipt: FIFO layers for "${item.name}" no longer hold the received quantity.`,
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
      // The voided entry takes the line's full amount off the inventory account. When the stock
      // left is worth less than that (written down, or sold at a lower average since), the GL
      // would go below the item's value — refuse rather than clamp the average and split them.
      if (remainingValue.lessThan(layerRoundingTolerance(currentQty).negated())) {
        throw new ServiceError(
          'CONFLICT',
          `Cannot reverse ${docLabel} receipt: the "${item.name}" on hand are valued at ${toAmountString(Money.round2(currentQty.times(currentAvg)))}, less than the ${toAmountString(line.homeAmount)} it added (their cost was written down or the units sold since). Reverse the value adjustment or those sales first.`,
        );
      }
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
          // The reversal took the line's home amount off the GL.
          ...valueRemainderAfter(item, currentQty, newQty, newAvg, Money.of(line.homeAmount).negated()),
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
        reason,
      },
    });
  }
}

/** Receive stock for a bill's resolved inventory lines. */
async function receiveResolvedStock(
  tx: ServiceContext,
  billId: string,
  date: Date,
  resolvedLines: ResolvedLine[],
  reason: string,
) {
  await receivePurchasedStock(tx, `bill:${billId}`, date, resolvedLines, `${reason}:${billId}`);
}

/**
 * Reverse any stock received via the bill's inventory item lines (as currently saved in
 * bill_lines), at the HOME-currency cost they were received at.
 */
async function reverseReceivedStock(tx: ServiceContext, billId: string, reason: string) {
  const [bill] = await tx.db
    .select({ exchangeRate: bills.exchangeRate, currency: bills.currency })
    .from(bills)
    .where(eq(bills.id, billId));
  const lines = await tx.db
    .select()
    .from(billLines)
    .where(eq(billLines.billId, billId))
    .orderBy(asc(billLines.lineOrder));
  const home = homeAmounts(
    lines.map((l) => l.amount),
    bill?.currency ? (bill.exchangeRate ?? 1) : 1,
  );
  await reversePurchasedStock(
    tx,
    lines.map((l, i) => ({ itemId: l.itemId, quantity: l.quantity, homeAmount: home.lines[i] })),
    `${reason}:${billId}`,
  );
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
      debit: line.homeAmount,
      memo: line.description,
      classId: line.classId,
    })),
    // Credit line — Accounts Payable (home currency)
    {
      accountId: prep.apAccountId,
      credit: prep.homeTotalStr,
      memo: `Bill ${billNumber ?? billId} — ${prep.vendor.name}`,
      controlLine: true,
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
    // Duplicate vendor-reference check INSIDE the transaction: PGlite serializes transactions, so
    // a double-clicked Save (or two users entering the same bill) sees the first bill instead of
    // both passing the check and saving the bill twice.
    await assertBillNumberAvailable(tx, input);
    // --- Insert the bill header ---
    const [bill] = await tx.db
      .insert(bills)
      .values({
        companyId: tx.companyId,
        vendorId: input.vendorId,
        billNumber: input.billNumber ?? null,
        date: input.date,
        dueDate: prep.dueDate,
        terms: prep.terms,
        memo: input.memo ?? null,
        status: 'open',
        classId: input.classId ?? null,
        currency: prep.currency,
        exchangeRate: prep.currency ? prep.rate.toFixed(8) : null,
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
/** A bill written by the Loan Manager "Set up payment" (its split must stay in step with the loan). */
async function assertNotLoanBill(ctx: ServiceContext, billId: string) {
  const [link] = await ctx.db
    .select({ id: loanPayments.id })
    .from(loanPayments)
    .where(and(eq(loanPayments.companyId, ctx.companyId), eq(loanPayments.billId, billId)))
    .limit(1);
  if (link) {
    throw new ServiceError(
      'CONFLICT',
      'This bill is a Loan Manager payment. To change it, void it and set up the loan payment again.',
    );
  }
}

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
  await assertNotLoanBill(ctx, id);
  // p1 fx: never move a bill after the dated vendor-credit steps recorded against it.
  await assertRedateAfterVendorCreditSteps(ctx, { billId: id }, input.date);
  if (await billHasReceiptLinks(ctx, id)) {
    throw new ServiceError(
      'CONFLICT',
      'This bill was entered against item receipts. Void it and enter the bill for the received items again.',
    );
  }

  // Validate + resolve the new document (read-only).
  const prep = await prepareBill(ctx, input);

  return inTransaction(ctx, async (tx) => {
    // Duplicate vendor-reference check in the same transaction as the save (see createBill).
    await assertBillNumberAvailable(tx, input, id);
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

    // Billable lines already pulled onto a customer invoice keep that link (so they are not
    // offered for billing again) when the edit leaves them financially unchanged; changing one
    // is refused, as for checks/expenses (expenses.ts).
    const billedLinkByNewIdx = new Map<number, string>();
    const billedOld = oldLines.filter((l) => l.billedInvoiceId);
    if (billedOld.length) {
      const sameCurrency = (prep.currency ?? null) === (bill.currency ?? null);
      for (const o of billedOld) {
        const idx = prep.resolvedLines.findIndex(
          (n, i) =>
            !billedLinkByNewIdx.has(i) &&
            n.accountId === o.accountId &&
            (n.itemId ?? null) === (o.itemId ?? null) &&
            Money.eq(n.amount, o.amount) &&
            Money.eq(n.quantity, o.quantity) &&
            (n.customerId ?? null) === (o.customerId ?? null) &&
            (n.jobId ?? null) === (o.jobId ?? null),
        );
        if (!sameCurrency || idx === -1) {
          throw new ServiceError(
            'CONFLICT',
            'A line of this bill was already billed to a customer on an invoice. Remove it from that invoice before changing its amount, account, item, quantity, customer or job.',
          );
        }
        billedLinkByNewIdx.set(idx, o.billedInvoiceId!);
      }
    }

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
        billedInvoiceId: billedLinkByNewIdx.get(idx) ?? null,
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
        dueDate: prep.dueDate,
        terms: prep.terms,
        memo: input.memo ?? null,
        classId: input.classId ?? null,
        currency: prep.currency,
        exchangeRate: prep.currency ? prep.rate.toFixed(8) : null,
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
        dueDate: prep.dueDate,
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
// listBillsToPay — Pay Bills screen (due-date + discount filters, D5)
// ---------------------------------------------------------------------------

export interface BillToPay {
  id: string;
  vendorId: string;
  vendorName: string | null;
  billNumber: string | null;
  date: Date;
  dueDate: Date | null;
  terms: string | null;
  total: string;
  amountPaid: string;
  amountCredited: string;
  balanceDue: string;
  status: string;
  currency: string | null;
  exchangeRate: string | null;
  /** Last day of the early-payment discount window (null when the terms have none). */
  discountDate: Date | null;
  discountPercent: number;
  /** Suggested discount on the open balance when paid on `asOf` ('0.00' when none). */
  suggestedDiscount: string;
  discountAvailable: boolean;
  overdue: boolean;
}

/** Pay Bills discount from a Terms list entry (same shape as billTerms.discountFor). */
function listDiscount(row: TermsRow, bill: { date: Date; balanceDue: string | number }, asOf: Date): DiscountInfo {
  const r = computeDiscount(row as TermsLike, bill.date, asOf, bill.balanceDue);
  if (!r.discountDate) {
    return { discountDate: null, discountPercent: 0, suggestedDiscount: '0.00', available: false };
  }
  return {
    discountDate: r.discountDate,
    discountPercent: Number(r.percent),
    suggestedDiscount: r.amount ?? '0.00',
    available: r.eligible,
  };
}

/**
 * Open bills for Pay Bills (QB "Show bills: due on or before … / show all bills" plus the
 * "discount available" filter). The due date falls back to the terms when none was stored.
 */
export async function listBillsToPay(
  ctx: ServiceContext,
  opts?: {
    vendorId?: string;
    /** Only bills due on/before this date (bills with no due date are kept). */
    dueOnOrBefore?: Date;
    /** Only bills whose early-payment discount is still available on `asOf`. */
    discountAvailableOnly?: boolean;
    /** Payment date used for the discount suggestion (default: today). */
    asOf?: Date;
  },
): Promise<BillToPay[]> {
  const conditions = [
    eq(bills.companyId, ctx.companyId),
    notInArray(bills.status, ['void', 'paid', 'draft'] as never[]),
    sql`${bills.balanceDue} > 0`,
  ];
  if (opts?.vendorId) conditions.push(eq(bills.vendorId, opts.vendorId));
  const rows = await ctx.db
    .select({ bill: bills, vendorName: vendors.displayName, vendorTerms: vendors.terms })
    .from(bills)
    .leftJoin(vendors, eq(bills.vendorId, vendors.id))
    .where(and(...conditions))
    .orderBy(asc(bills.dueDate), asc(bills.date));

  const asOf = opts?.asOf ?? new Date();
  const todayKey = asOf.toISOString().slice(0, 10);
  const out: BillToPay[] = [];
  // Terms list rows by reference (B5/C3), resolved once per distinct terms string.
  const termsCache = new Map<string, TermsRow | null>();
  const termsRow = async (ref: string | null) => {
    if (!ref) return null;
    if (!termsCache.has(ref)) termsCache.set(ref, await findTermsRef(ctx, ref));
    return termsCache.get(ref) ?? null;
  };
  for (const { bill, vendorName, vendorTerms } of rows) {
    const terms = bill.terms ?? vendorTerms ?? null;
    const row = await termsRow(terms);
    const dueDate = bill.dueDate ?? (row ? computeDueDate(row as TermsLike, bill.date) : dueDateFromTerms(bill.date, terms));
    if (opts?.dueOnOrBefore && dueDate) {
      if (dueDate.toISOString().slice(0, 10) > opts.dueOnOrBefore.toISOString().slice(0, 10)) continue;
    }
    const d = row ? listDiscount(row, bill, asOf) : discountFor({ date: bill.date, terms, balanceDue: bill.balanceDue, total: bill.total }, asOf);
    if (opts?.discountAvailableOnly && !(d.available && Money.gt(d.suggestedDiscount, 0))) continue;
    out.push({
      id: bill.id,
      vendorId: bill.vendorId,
      vendorName: vendorName ?? null,
      billNumber: bill.billNumber,
      date: bill.date,
      dueDate,
      terms,
      total: bill.total,
      amountPaid: bill.amountPaid,
      amountCredited: bill.amountCredited,
      balanceDue: bill.balanceDue,
      status: bill.status,
      currency: bill.currency ?? null,
      exchangeRate: bill.exchangeRate ?? null,
      discountDate: d.discountDate,
      discountPercent: d.discountPercent,
      suggestedDiscount: d.suggestedDiscount,
      discountAvailable: d.available && Money.gt(d.suggestedDiscount, 0),
      overdue: dueDate ? dueDate.toISOString().slice(0, 10) < todayKey : false,
    });
  }
  return out;
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
  // Load + validate in the same transaction as the void: a second concurrent void then sees the
  // bill already void (idempotent) instead of releasing its PO / receipt quantities again.
  return inTransaction(ctx, (tx) => voidBillInTx(tx, id));
}

async function voidBillInTx(ctx: ServiceContext, id: string) {
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

    // p1 fx: settled (applied, then unapplied) foreign vendor-credit applications go with the bill.
    await clearSettledForeignApplications(tx, { billId: id });

    // Reverse the GL entry.
    if (bill.postedEntryId) {
      await voidJournalEntry(tx, bill.postedEntryId);
    }

    // Reverse any stock received via inventory item lines. The JE void above
    // already restored the GL (Dr A/P / Cr Inventory at the bill's cost); this
    // step pulls the quantity/cost back out of the subledger (and out of its site).
    await reverseReceivedStock(tx, id, 'bill_void');
    await reverseDocumentInventory(tx, 'bill', id);

    // Bills entered against item receipts: put the received quantities back to "awaiting bill"
    // and unwind any inventory cost adjustments made by price variances (GL reversed above).
    await releaseReceiptBilling(tx, id);

    // Bills converted from a purchase order: the PO gets the quantities back (it reopens).
    // Imported lazily: purchaseOrders.ts imports this module (createBill).
    const { releasePoBillingForBill } = await import('./purchaseOrders');
    await releasePoBillingForBill(tx, id);

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
