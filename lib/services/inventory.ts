/**
 * Inventory service — adjustments, COGS recording, valuation, and low-stock queries.
 *
 * GL impact for inventory events:
 *   Adjust quantity up (qty+) — QB Adjust Quantity/Value on Hand:
 *     Dr 1300 Inventory Asset      qty * unitCost
 *     Cr Adjustment Account        qty * unitCost
 *
 *   Adjust quantity down / write-off (qty-):
 *     Dr Adjustment Account        qty * averageCost
 *     Cr 1300 Inventory Asset      qty * averageCost
 *
 *   p1 purchases: the Adjustment Account is the user's pick (QB requires one); it defaults to
 *   "Inventory Adjustments" (an expense account, created when missing). The adjustment line
 *   carries the Class and the Customer:Job (as the line's Name). Equity is never the offset.
 *
 *   recordCOGS (triggered by sales):
 *     Dr 5000 COGS                 qty * averageCost
 *     Cr 1300 Inventory Asset      qty * averageCost
 *
 * averageCost is maintained as a weighted average: updated on positive receipts only.
 */
import { and, asc, eq, exists, inArray, sql } from 'drizzle-orm';
import { onOrBeforeDay } from './journal';
import Decimal from 'decimal.js';
import {
  items,
  accounts,
  classes,
  customers,
  jobs,
  inventoryLayers,
  salesOrders,
  salesOrderLines,
  purchaseOrders,
  purchaseOrderLines,
  journalEntries,
  journalEntryLines,
  invoiceLines,
  salesReceiptLines,
  creditMemoLines,
  bills,
  billLines,
  expenses,
  expenseLines,
  itemReceiptLines,
  itemReceiptBillLines,
  vendorCreditLines,
} from '@/lib/db/schema';
import { Money, type MoneyInput, toAmountString } from '@/lib/money';
import { MAX_DATE_YEAR, MIN_DATE_YEAR, parseDateInput } from '@/lib/validation/helpers';
import { homeAmounts } from './currencies';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';

// ---------------------------------------------------------------------------
// Input checks shared by the inventory services (quantities, costs, dates typed by the user)
// ---------------------------------------------------------------------------

/**
 * A quantity / cost / value as typed by the user (string or number): a plain VALIDATION error
 * (HTTP 400) for anything that is not a finite number, instead of the MoneyParseError /
 * NaN that used to surface as an HTTP 500 deep inside a costing path.
 */
export function inventoryNumber(value: unknown, label: string): Decimal {
  let d: Decimal;
  try {
    d = Money.of(value as MoneyInput);
  } catch {
    throw validation(`${label} must be a number (got "${String(value)}").`);
  }
  if (!d.isFinite()) throw validation(`${label} must be a number (got "${String(value)}").`);
  return d;
}

/**
 * A transaction date: a Date, or a date string parsed like every zod-validated route (`zDate`:
 * a real calendar day in years 1900–9999 — "2026-02-30" is refused, not rolled over to March).
 * Anything else is a VALIDATION error instead of the RangeError ("Invalid time value") an
 * Invalid Date throws when it reaches the database.
 */
export function inventoryDate(value: unknown, label = 'date'): Date {
  const bad = () =>
    validation(`${label}: "${String(value)}" is not a valid date (a real calendar day in years ${MIN_DATE_YEAR}-${MAX_DATE_YEAR}).`);
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw bad();
    const y = value.getUTCFullYear();
    if (y < MIN_DATE_YEAR || y > MAX_DATE_YEAR) throw bad();
    return value;
  }
  if (typeof value === 'string') {
    const d = parseDateInput(value);
    if (d) return d;
  }
  throw bad();
}

/**
 * Guard against costing-method mixing. The average-cost paths in this module (adjustInventory,
 * recordCOGS) must never operate on an item that is tracked under FIFO (fifo.ts is the only code
 * that maintains inventoryLayers). Doing so silently diverges quantityOnHand/GL from the FIFO
 * layer valuation and values COGS at a null/zero averageCost. Route FIFO items through fifo.ts.
 */
export async function assertNotFifoTracked(ctx: ServiceContext, itemId: string): Promise<void> {
  const [row] = await ctx.db
    .select({ cnt: sql<number>`count(*)` })
    .from(inventoryLayers)
    .where(and(eq(inventoryLayers.companyId, ctx.companyId), eq(inventoryLayers.itemId, itemId)));
  if (Number(row?.cnt ?? 0) > 0) {
    throw validation(
      'This item is FIFO-tracked; use the FIFO receive/consume endpoints rather than average-cost adjustments.',
    );
  }
}
import { assertNotControlLineAccount, postJournalEntry } from './posting';
import { averageAfter, takeAccountantCost } from './accountantCopy/inventoryCost';

// ---------------------------------------------------------------------------
// Adjustment Account / Class / Customer:Job (QB Adjust Quantity/Value on Hand) — p1 purchases
// ---------------------------------------------------------------------------

/**
 * Today's calendar day on this computer, at UTC midnight — the convention every stored document
 * date uses. Used where an inventory posting has no date of its own (a build without one, merge
 * rounding): `new Date()` is the current UTC instant, which in the evening west of UTC is already
 * tomorrow's date (and on Dec 31, next year).
 */
export function todayCalendarDay(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

/** QB's default adjustment account name. */
export const INVENTORY_ADJUSTMENTS_ACCOUNT_NAME = 'Inventory Adjustments';

/** Optional QB adjustment fields shared by the average-cost and FIFO adjustment paths. */
export interface AdjustmentDimensions {
  /** Offset account; default "Inventory Adjustments" (expense, created when missing). */
  adjustmentAccountId?: string | null;
  classId?: string | null;
  /** Customer (or the job's customer) — the adjustment line's Name, for job costing. */
  customerId?: string | null;
  jobId?: string | null;
}

/**
 * Get-or-create the "Inventory Adjustments" expense account (QB's default Adjustment Account).
 * An existing account with that name is reused; otherwise one is created with the first free
 * code from 5950.
 */
export async function ensureInventoryAdjustmentAccount(ctx: ServiceContext): Promise<string> {
  const rows = await ctx.db
    .select({ id: accounts.id, name: accounts.name, code: accounts.code, type: accounts.type })
    .from(accounts)
    .where(eq(accounts.companyId, ctx.companyId));
  const existing = rows.find(
    (r) => r.type === 'expense' && r.name.trim().toLowerCase() === INVENTORY_ADJUSTMENTS_ACCOUNT_NAME.toLowerCase(),
  );
  if (existing) return existing.id;
  const used = new Set(rows.map((r) => r.code));
  let code = 5950;
  while (used.has(String(code))) code++;
  return inTransaction(ctx, async (tx) => {
    const [created] = await tx.db
      .insert(accounts)
      .values({
        companyId: tx.companyId,
        code: String(code),
        name: INVENTORY_ADJUSTMENTS_ACCOUNT_NAME,
        type: 'expense',
        subtype: 'cost_of_goods_sold',
        balance: '0',
      })
      .returning();
    await writeAudit(tx, { action: 'create', entityType: 'account', entityId: created.id, newValues: created });
    return created.id;
  });
}

/**
 * The adjustment account to post to: the user's pick (must belong to the company, not be A/R /
 * A/P and not be an inventory asset), else the default "Inventory Adjustments".
 */
export async function resolveAdjustmentAccount(ctx: ServiceContext, accountId?: string | null): Promise<string> {
  if (!accountId) return ensureInventoryAdjustmentAccount(ctx);
  const [acct] = await ctx.db
    .select({ id: accounts.id, type: accounts.type, subtype: accounts.subtype, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, accountId)));
  if (!acct) throw notFound('Adjustment account');
  assertNotControlLineAccount(acct, 'Adjustment account');
  if (acct.type === 'asset' && acct.subtype === 'inventory') {
    throw validation(`"${acct.name}" is an inventory asset account. Pick the account the adjustment is charged to, such as Inventory Adjustments.`);
  }
  return acct.id;
}

/** Validate Class / Customer:Job and return them as posting-line fields for the adjustment line. */
export async function adjustmentPostingFields(
  ctx: ServiceContext,
  dims: AdjustmentDimensions,
): Promise<{ classId?: string; entityType?: 'customer'; entityId?: string }> {
  const out: { classId?: string; entityType?: 'customer'; entityId?: string } = {};
  if (dims.classId) {
    const [c] = await ctx.db
      .select({ id: classes.id })
      .from(classes)
      .where(and(eq(classes.companyId, ctx.companyId), eq(classes.id, dims.classId)));
    if (!c) throw notFound('Class');
    out.classId = c.id;
  }
  let customerId = dims.customerId ?? null;
  if (dims.jobId) {
    const [j] = await ctx.db
      .select({ id: jobs.id, customerId: jobs.customerId })
      .from(jobs)
      .where(and(eq(jobs.companyId, ctx.companyId), eq(jobs.id, dims.jobId)));
    if (!j) throw notFound('Job');
    if (customerId && j.customerId && j.customerId !== customerId) {
      throw validation('That job belongs to a different customer.');
    }
    customerId = customerId ?? j.customerId;
  }
  if (customerId) {
    const [c] = await ctx.db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, customerId)));
    if (!c) throw notFound('Customer');
    out.entityType = 'customer';
    out.entityId = c.id;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Resolve an account id by code for the current company. Throws NOT_FOUND. */
async function accountIdByCode(ctx: ServiceContext, code: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
  if (!row) throw notFound(`Account with code ${code}`);
  return row.id;
}

/** Load an item scoped to the company. Throws NOT_FOUND. */
async function loadItem(ctx: ServiceContext, itemId: string) {
  const [row] = await ctx.db
    .select()
    .from(items)
    .where(and(eq(items.companyId, ctx.companyId), eq(items.id, itemId)));
  if (!row) throw notFound('Item');
  return row;
}

/**
 * Precondition guard for physical inventory counts: the item must be a stock-
 * tracked ('inventory') item and must NOT be FIFO-tracked (physical counts are
 * an average-cost operation — they value the delta at averageCost and do not
 * touch inventoryLayers). Throws VALIDATION otherwise.
 */
export async function assertPhysicalCountable(ctx: ServiceContext, itemId: string): Promise<void> {
  const item = await loadItem(ctx, itemId);
  if (item.type !== 'inventory') {
    throw validation(
      `Physical counts can only be recorded for inventory-type items; "${item.name}" is type "${item.type}".`,
    );
  }
  await assertNotFifoTracked(ctx, itemId);
}

// ---------------------------------------------------------------------------
// setReorderPoint
// ---------------------------------------------------------------------------

/**
 * Set (or clear) an item's reorder point — the threshold that drives the
 * reorder report and low-stock alerts. Pass null to clear it.
 */
export async function setReorderPoint(
  ctx: ServiceContext,
  itemId: string,
  reorderPoint: string | number | null,
) {
  const before = await loadItem(ctx, itemId);

  let stored: string | null = null;
  if (reorderPoint != null && reorderPoint !== '') {
    let value: Decimal;
    try {
      value = Money.of(reorderPoint);
    } catch {
      throw validation(`reorderPoint must be a number (got "${reorderPoint}").`);
    }
    if (value.isNegative()) throw validation('reorderPoint cannot be negative.');
    stored = value.toFixed(4);
  }

  const [row] = await ctx.db
    .update(items)
    .set({ reorderPoint: stored, updatedAt: new Date() })
    .where(and(eq(items.companyId, ctx.companyId), eq(items.id, itemId)))
    .returning();

  await writeAudit(ctx, {
    action: 'update',
    entityType: 'item',
    entityId: itemId,
    oldValues: { reorderPoint: before.reorderPoint },
    newValues: { reorderPoint: stored },
  });

  return row;
}

// ---------------------------------------------------------------------------
// adjustInventory
// ---------------------------------------------------------------------------

export interface AdjustInventoryInput extends AdjustmentDimensions {
  itemId: string;
  /** Positive = receiving stock; negative = removing/writing off stock. */
  quantityChange: string | number;
  /**
   * Unit cost for the received units. Required for positive adjustments (receiving).
   * Ignored for negative adjustments (uses current averageCost).
   */
  unitCost?: string | number | null;
  date: Date;
  memo?: string | null;
}

/**
 * Value relieved when an average-cost item goes from `oldQty` to `newQty` units on hand: its book
 * value before minus after (each rounded to the cent, as inventoryValuation reports it). Unlike
 * round2(qty × avg) this telescopes over successive removals, so selling out clears the item's
 * inventory value to exactly zero (QB relieves the last unit at the value that remains).
 */
export function bookValueRelief(oldQty: Decimal, newQty: Decimal, avg: Decimal): Decimal {
  return Money.round2(oldQty.times(avg)).minus(Money.round2(newQty.times(avg)));
}

/**
 * Book value of one FIFO cost layer: quantity × unit cost rounded to the cent. An item's FIFO
 * value is the SUM of its layers' values (fifo.ts fifoValuation lists them so), and
 * fifo.ts takeFromLayers relieves each layer's value before minus after under the same rule, so
 * the inventory GL ties to the valuation reports. Every report that values layers uses this
 * (or fifoLayerValueSql), never round2(SUM(qty × cost)).
 */
export function fifoLayerValue(qty: Decimal | string, unitCost: Decimal | string): Decimal {
  return Money.round2(Money.of(qty).times(Money.of(unitCost)));
}

/** SQL aggregate of fifoLayerValue over the selected inventory_layers rows. */
export function fifoLayerValueSql() {
  return sql<string>`COALESCE(SUM(ROUND(${inventoryLayers.quantityRemaining} * ${inventoryLayers.unitCost}, 2)), 0)`;
}

/** The item fields behind an average-cost item's value remainder (schema items.valueRemainder). */
export interface ValueRemainderFields {
  averageCost: string | null;
  valueRemainder: string | null;
  valueRemainderAvg: string | null;
}

/**
 * The cents the inventory GL still carries for an average-cost item beyond its book value
 * round2(qty × averageCost) — recorded by the receipts the 4dp average cannot represent exactly
 * (3000 units for $1000: average 0.3333, book value 999.90, GL 1000.00). Zero when a path that
 * does not record remainders re-derived the average since (the stamp no longer matches).
 */
export function carriedValueRemainder(item: ValueRemainderFields): Decimal {
  if (item.valueRemainderAvg == null) return Money.zero();
  if (!Money.of(item.valueRemainderAvg).equals(Money.of(item.averageCost ?? '0'))) return Money.zero();
  return Money.of(item.valueRemainder ?? '0');
}

/**
 * Remainder fields to store after an average-cost receipt (or its reversal) moved the item from
 * `oldQty` to `newQty` and re-derived the average as `newAvg` (stored to 4dp), while the
 * document posted `posted` to the inventory account: what the GL carries beyond the new book value.
 */
export function valueRemainderAfter(
  item: ValueRemainderFields,
  oldQty: Decimal,
  newQty: Decimal,
  newAvg: Decimal,
  posted: Decimal,
): { valueRemainder: string; valueRemainderAvg: string } {
  const stored = Money.of(newAvg.toFixed(4));
  const oldBook = Money.round2(oldQty.times(Money.of(item.averageCost ?? '0')));
  const newBook = Money.round2(newQty.times(stored));
  const remainder = carriedValueRemainder(item).plus(Money.round2(posted)).minus(newBook.minus(oldBook));
  return { valueRemainder: toAmountString(remainder), valueRemainderAvg: stored.toFixed(4) };
}

/**
 * Value relieved when an average-cost removal takes the item to zero: its book value plus the
 * remainder the GL still carries for it, so selling out clears the inventory GL to exactly $0
 * (QB relieves the last unit at the value that remains). Falls back to the book value when that
 * would not leave a positive amount (a $0 / negative relief cannot be posted as a removal).
 */
export function sellOutRelief(
  item: ValueRemainderFields,
  newQty: Decimal,
  atBookValue: Decimal,
): { relief: Decimal; remainderRelieved: boolean } {
  if (!newQty.isZero()) return { relief: atBookValue, remainderRelieved: false };
  const carried = carriedValueRemainder(item);
  const withRemainder = atBookValue.plus(carried);
  if (carried.isZero() || !withRemainder.greaterThan(0)) return { relief: atBookValue, remainderRelieved: false };
  return { relief: withRemainder, remainderRelieved: true };
}

export async function adjustInventory(ctx: ServiceContext, input: AdjustInventoryInput) {
  const qtyChange = inventoryNumber(input.quantityChange, 'Quantity');
  if (qtyChange.isZero()) throw validation('quantityChange cannot be zero.');
  input = { ...input, date: inventoryDate(input.date) };

  await assertNotFifoTracked(ctx, input.itemId);
  const item = await loadItem(ctx, input.itemId);

  const currentQty = Money.of(item.quantityOnHand ?? '0');
  const currentAvgCost = Money.of(item.averageCost ?? '0');

  // --- Validate removal ---
  if (qtyChange.isNegative()) {
    const absQty = qtyChange.abs();
    if (absQty.greaterThan(currentQty)) {
      throw validation(
        `Cannot remove ${absQty.toFixed(4)} units; only ${currentQty.toFixed(4)} on hand.`,
      );
    }
    if (currentAvgCost.isZero() && !currentQty.isZero()) {
      // Allow zero-cost adjustments but warn via memo; do not block.
    }
  }

  // --- Determine GL amounts ---
  let glAmount: Decimal;
  let newQty: Decimal;
  let newAvgCost: Decimal;
  // The item's value remainder after this adjustment (undefined = unchanged).
  let remainder: { valueRemainder: string; valueRemainderAvg: string | null } | undefined;

  if (qtyChange.greaterThan(0)) {
    // Receiving stock
    if (input.unitCost == null) {
      throw validation('unitCost is required when receiving stock (quantityChange > 0).');
    }
    const unitCost = inventoryNumber(input.unitCost, 'Unit cost');
    if (unitCost.isNegative()) throw validation('unitCost cannot be negative.');

    // Weighted-average cost: (oldQty * oldAvgCost + newQty * newCost) / (oldQty + newQty)
    const oldValue = currentQty.times(currentAvgCost);
    const newValue = qtyChange.times(unitCost);
    newQty = currentQty.plus(qtyChange);
    newAvgCost = newQty.isZero()
      ? unitCost
      : oldValue.plus(newValue).dividedBy(newQty);
    glAmount = Money.round2(qtyChange.times(unitCost));
    // What the 4dp average cannot represent of this receipt stays on record for the sell-out.
    remainder = valueRemainderAfter(item, currentQty, newQty, newAvgCost, glAmount);
  } else {
    // Removing stock — value at current average cost (or, in an Accountant's Copy import, at the
    // cost the accountant's file used; the average is then re-derived from what is left).
    newQty = currentQty.plus(qtyChange); // qtyChange is negative
    const atAverage = bookValueRelief(currentQty, newQty, currentAvgCost);
    const accountantCost = takeAccountantCost(input.itemId);
    // Removing the last units also relieves the value remainder (the GL then holds exactly $0).
    const sellOut = sellOutRelief(item, newQty, atAverage);
    glAmount = accountantCost ? Money.round2(accountantCost) : sellOut.relief;
    if (accountantCost && !glAmount.equals(atAverage)) {
      newAvgCost = averageAfter(currentQty, currentAvgCost, newQty, glAmount.negated());
      remainder = { valueRemainder: '0.00', valueRemainderAvg: null }; // average re-derived
    } else {
      newAvgCost = currentAvgCost; // average cost unchanged on removals
      if (!accountantCost && sellOut.remainderRelieved) remainder = { valueRemainder: '0.00', valueRemainderAvg: newAvgCost.toFixed(4) };
    }
  }

  return inTransaction(ctx, async (tx) => {
    // Resolve GL accounts
    // Inventory Asset is either item.assetAccountId or code 1300
    const inventoryAccountId = item.assetAccountId ?? (await accountIdByCode(tx, '1300'));
    // QB Adjust Quantity/Value on Hand: the user's Adjustment Account (default Inventory
    // Adjustments) offsets the inventory change, with Class and Customer:Job on that line.
    const offsetAccountId = await resolveAdjustmentAccount(tx, input.adjustmentAccountId);
    const dims = await adjustmentPostingFields(tx, input);

    // Build posting lines
    let postingLines: Array<{
      accountId: string;
      debit?: string;
      credit?: string;
      memo?: string | null;
      classId?: string;
      entityType?: 'customer';
      entityId?: string;
    }>;

    if (qtyChange.greaterThan(0)) {
      // Dr Inventory Asset, Cr Adjustment Account
      postingLines = [
        {
          accountId: inventoryAccountId,
          debit: toAmountString(glAmount),
          memo: input.memo ?? 'Inventory adjustment',
        },
        {
          accountId: offsetAccountId,
          credit: toAmountString(glAmount),
          memo: input.memo ?? 'Inventory adjustment',
          ...dims,
        },
      ];
    } else {
      // Dr Adjustment Account, Cr Inventory Asset
      postingLines = [
        {
          accountId: offsetAccountId,
          debit: toAmountString(glAmount),
          memo: input.memo ?? 'Inventory adjustment',
          ...dims,
        },
        {
          accountId: inventoryAccountId,
          credit: toAmountString(glAmount),
          memo: input.memo ?? 'Inventory removal',
        },
      ];
    }

    const entry = await postJournalEntry(tx, {
      date: input.date,
      description: input.memo ?? `Inventory adjustment — ${item.name}`,
      lines: postingLines,
      sourceRef: `item:${input.itemId}`,
    });

    // Update item quantities and average cost
    await tx.db
      .update(items)
      .set({
        quantityOnHand: newQty.toFixed(4),
        averageCost: newAvgCost.toFixed(4),
        ...(remainder ?? {}),
        updatedAt: new Date(),
      })
      .where(eq(items.id, input.itemId));

    await writeAudit(tx, {
      action: 'update',
      entityType: 'item',
      entityId: input.itemId,
      oldValues: {
        quantityOnHand: item.quantityOnHand,
        averageCost: item.averageCost,
      },
      newValues: {
        quantityOnHand: newQty.toFixed(4),
        averageCost: newAvgCost.toFixed(4),
        postedEntryId: entry.id,
      },
    });

    return {
      item: { id: input.itemId, quantityOnHand: newQty.toFixed(4), averageCost: newAvgCost.toFixed(4) },
      entry,
      glAmount: toAmountString(glAmount),
    };
  });
}

// ---------------------------------------------------------------------------
// recordCOGS — convenience helper called during sales (e.g. from invoices)
// ---------------------------------------------------------------------------

export interface RecordCOGSInput {
  itemId: string;
  quantity: string | number;
  date: Date;
  memo?: string | null;
  /** Class of the sale (P&L by Class): carried onto the COGS line. */
  classId?: string | null;
}

/**
 * The COGS account an inventory item's sale posts to: the item's own COGS account
 * (items.expenseAccountId, QB "COGS Account") when it is an active expense account of the
 * company, else 5000 Cost of Goods Sold. Used by every COGS posting (average cost, FIFO, returns).
 */
export async function cogsAccountForItem(
  ctx: ServiceContext,
  item: { expenseAccountId?: string | null },
): Promise<string> {
  if (item.expenseAccountId) {
    const [acct] = await ctx.db
      .select({ id: accounts.id, type: accounts.type, isActive: accounts.isActive })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, item.expenseAccountId)));
    if (acct && acct.isActive && String(acct.type) === 'expense') return acct.id;
  }
  return accountIdByCode(ctx, '5000');
}

export async function recordCOGS(ctx: ServiceContext, input: RecordCOGSInput) {
  const qty = inventoryNumber(input.quantity, 'Quantity');
  if (qty.lessThanOrEqualTo(0)) throw validation('quantity must be positive for COGS recording.');

  await assertNotFifoTracked(ctx, input.itemId);
  const item = await loadItem(ctx, input.itemId);
  const currentQty = Money.of(item.quantityOnHand ?? '0');
  const avgCost = Money.of(item.averageCost ?? '0');

  if (qty.greaterThan(currentQty)) {
    throw validation(
      `Cannot record COGS for ${qty.toFixed(4)} units; only ${currentQty.toFixed(4)} on hand.`,
    );
  }

  const newQty = currentQty.minus(qty);
  // Accountant's Copy import: the cost the accountant's file used (null otherwise). The average is
  // re-derived from what is left so the item's value stays equal to the ledger.
  const accountantCost = takeAccountantCost(input.itemId);
  const atAverage = bookValueRelief(currentQty, newQty, avgCost);
  // Selling the last units also relieves the value remainder (the GL then holds exactly $0).
  const sellOut = sellOutRelief(item, newQty, atAverage);
  const cogsAmount = accountantCost ? Money.round2(accountantCost) : sellOut.relief;
  const newAvgCost =
    accountantCost && !cogsAmount.equals(atAverage)
      ? averageAfter(currentQty, avgCost, newQty, cogsAmount.negated())
      : avgCost;
  const remainder = !newAvgCost.equals(avgCost)
    ? { valueRemainder: '0.00', valueRemainderAvg: null } // average re-derived (Accountant's Copy cost)
    : !accountantCost && sellOut.remainderRelieved
      ? { valueRemainder: '0.00', valueRemainderAvg: avgCost.toFixed(4) }
      : undefined;

  return inTransaction(ctx, async (tx) => {
    const inventoryAccountId = item.assetAccountId ?? (await accountIdByCode(tx, '1300'));
    const cogsAccountId = await cogsAccountForItem(tx, item);

    // Dr COGS, Cr Inventory Asset
    const entry = await postJournalEntry(tx, {
      date: input.date,
      description: input.memo ?? 'Cost of goods sold',
      lines: [
        {
          accountId: cogsAccountId,
          debit: toAmountString(cogsAmount),
          memo: input.memo ?? 'COGS',
          ...(input.classId ? { classId: input.classId } : {}),
        },
        {
          accountId: inventoryAccountId,
          credit: toAmountString(cogsAmount),
          memo: input.memo ?? 'COGS — inventory reduction',
        },
      ],
      sourceRef: `item:${input.itemId}`,
    });

    await tx.db
      .update(items)
      .set({
        quantityOnHand: newQty.toFixed(4),
        ...(newAvgCost.equals(avgCost) ? {} : { averageCost: newAvgCost.toFixed(4) }),
        ...(remainder ?? {}),
        updatedAt: new Date(),
      })
      .where(eq(items.id, input.itemId));

    await writeAudit(tx, {
      action: 'update',
      entityType: 'item',
      entityId: input.itemId,
      oldValues: { quantityOnHand: item.quantityOnHand, ...(newAvgCost.equals(avgCost) ? {} : { averageCost: item.averageCost }) },
      newValues: {
        quantityOnHand: newQty.toFixed(4),
        ...(newAvgCost.equals(avgCost) ? {} : { averageCost: newAvgCost.toFixed(4) }),
        postedEntryId: entry.id,
      },
    });

    return {
      item: { id: input.itemId, quantityOnHand: newQty.toFixed(4), averageCost: newAvgCost.toFixed(4) },
      entry,
      cogsAmount: toAmountString(cogsAmount),
    };
  });
}

// ---------------------------------------------------------------------------
// inventoryValuation
// ---------------------------------------------------------------------------

export interface InventoryValuationRow {
  id: string;
  name: string;
  sku: string | null;
  quantityOnHand: string;
  /** For FIFO items this is the effective unit cost (layer value / layer qty). */
  averageCost: string;
  totalValue: string;
  costingMethod: 'fifo' | 'average';
}

export interface InventoryValuationResult {
  items: InventoryValuationRow[];
  grandTotal: string;
}

/**
 * Inventory valuation covering both costing methods so the grand total ties to
 * the GL inventory asset account (QB Inventory Valuation Summary: Asset Value = what the
 * balance sheet carries):
 *   - FIFO-tracked items (those with inventoryLayers rows) are valued from
 *     their remaining layers: SUM(quantityRemaining * unitCost).
 *   - Average-cost items are valued at quantityOnHand * averageCost plus the value remainder the
 *     GL still carries for them (the cents a 4dp average cannot show — 3000 units for $1000.00
 *     are worth 1000.00, not 3000 x 0.3333 = 999.90).
 * Inventory-type items only (services/bundles/non-inventory items carry no stock value). An
 * inactive item is still listed while it holds stock or value — making an item inactive does
 * not take its stock off the balance sheet.
 */
export async function inventoryValuation(ctx: ServiceContext): Promise<InventoryValuationResult> {
  const rows = await ctx.db
    .select({
      id: items.id,
      name: items.name,
      sku: items.sku,
      isActive: items.isActive,
      quantityOnHand: items.quantityOnHand,
      averageCost: items.averageCost,
      valueRemainder: items.valueRemainder,
      valueRemainderAvg: items.valueRemainderAvg,
    })
    .from(items)
    .where(and(eq(items.companyId, ctx.companyId), eq(items.type, 'inventory')));

  // Aggregate remaining FIFO layers per item. Any item with layer rows is
  // FIFO-tracked (same detection assertNotFifoTracked uses).
  const layerAgg = await ctx.db
    .select({
      itemId: inventoryLayers.itemId,
      layerQty: sql<string>`COALESCE(SUM(${inventoryLayers.quantityRemaining}), 0)`,
      layerValue: fifoLayerValueSql(),
    })
    .from(inventoryLayers)
    .where(eq(inventoryLayers.companyId, ctx.companyId))
    .groupBy(inventoryLayers.itemId);
  const fifoByItem = new Map(layerAgg.map((r) => [r.itemId, r]));

  let grandTotal = Money.zero();
  const valuationRows: InventoryValuationRow[] = [];
  for (const r of rows) {
    const fifo = fifoByItem.get(r.id);

    if (fifo) {
      const qty = Money.of(fifo.layerQty ?? '0');
      const total = Money.round2(Money.of(fifo.layerValue ?? '0'));
      if (!r.isActive && qty.isZero() && total.isZero()) continue;
      const effectiveUnitCost = qty.isZero() ? Money.zero() : total.dividedBy(qty);
      grandTotal = grandTotal.plus(total);
      valuationRows.push({
        id: r.id,
        name: r.name,
        sku: r.sku ?? null,
        quantityOnHand: qty.toFixed(4),
        averageCost: effectiveUnitCost.toFixed(4),
        totalValue: toAmountString(total),
        costingMethod: 'fifo' as const,
      });
      continue;
    }

    const qty = Money.of(r.quantityOnHand ?? '0');
    const avg = Money.of(r.averageCost ?? '0');
    const total = Money.round2(qty.times(avg)).plus(carriedValueRemainder(r));
    if (!r.isActive && qty.isZero() && total.isZero()) continue;
    grandTotal = grandTotal.plus(total);
    valuationRows.push({
      id: r.id,
      name: r.name,
      sku: r.sku ?? null,
      quantityOnHand: qty.toFixed(4),
      averageCost: avg.toFixed(4),
      totalValue: toAmountString(total),
      costingMethod: 'average' as const,
    });
  }

  return {
    items: valuationRows,
    grandTotal: toAmountString(grandTotal),
  };
}

// ---------------------------------------------------------------------------
// lowStock
// ---------------------------------------------------------------------------

export async function lowStock(ctx: ServiceContext) {
  const rows = await ctx.db
    .select()
    .from(items)
    .where(and(eq(items.companyId, ctx.companyId), eq(items.isActive, true)));

  return rows.filter((r) => {
    if (r.reorderPoint == null) return false;
    const qty = Money.of(r.quantityOnHand ?? '0');
    const reorder = Money.of(r.reorderPoint);
    return qty.lessThanOrEqualTo(reorder);
  });
}

// ---------------------------------------------------------------------------
// Sales-order stock commitment + stock status by item
// ---------------------------------------------------------------------------

/**
 * Quantity committed to open sales orders for one item:
 *   SUM(max(quantity - quantityInvoiced, 0)) over SO lines whose order is
 *   'open' or 'partial'. Closed/void orders no longer commit stock.
 */
export async function committedQuantity(ctx: ServiceContext, itemId: string): Promise<string> {
  const [row] = await ctx.db
    .select({
      committed: sql<string>`COALESCE(SUM(GREATEST(${salesOrderLines.quantity} - ${salesOrderLines.quantityInvoiced}, 0)), 0)`,
    })
    .from(salesOrderLines)
    .innerJoin(salesOrders, eq(salesOrderLines.salesOrderId, salesOrders.id))
    .where(
      and(
        eq(salesOrders.companyId, ctx.companyId),
        eq(salesOrderLines.itemId, itemId),
        inArray(salesOrders.status, ['open', 'partial']),
      ),
    );
  return Money.of(row?.committed ?? '0').toFixed(4);
}

export interface StockStatusRow {
  id: string;
  name: string;
  sku: string | null;
  quantityOnHand: string;
  /** Open SO line quantity not yet invoiced. */
  committed: string;
  /** onHand - committed. */
  available: string;
  /** Open PO line quantity not yet billed/received onto a bill. */
  onPO: string;
  reorderPoint: string | null;
  /**
   * Suggested order quantity: when (available + onPO) has fallen to or below
   * the reorder point, suggests restocking to 2x the reorder point (the same
   * heuristic as the reorder report); otherwise '0.0000'.
   */
  suggestedOrder: string;
}

export interface StockStatusResult {
  rows: StockStatusRow[];
  /** Count of rows where available <= 0 or below reorder point. */
  attentionCount: number;
}

/**
 * QB "Inventory Stock Status by Item": on-hand, committed (open sales orders),
 * available, on purchase order, reorder point, and a suggested order quantity
 * for every active inventory item.
 */
export async function stockStatus(ctx: ServiceContext): Promise<StockStatusResult> {
  const itemRows = await ctx.db
    .select({
      id: items.id,
      name: items.name,
      sku: items.sku,
      quantityOnHand: items.quantityOnHand,
      reorderPoint: items.reorderPoint,
    })
    .from(items)
    .where(
      and(eq(items.companyId, ctx.companyId), eq(items.isActive, true), eq(items.type, 'inventory')),
    );

  const committedRows = await ctx.db
    .select({
      itemId: salesOrderLines.itemId,
      committed: sql<string>`COALESCE(SUM(GREATEST(${salesOrderLines.quantity} - ${salesOrderLines.quantityInvoiced}, 0)), 0)`,
    })
    .from(salesOrderLines)
    .innerJoin(salesOrders, eq(salesOrderLines.salesOrderId, salesOrders.id))
    .where(
      and(eq(salesOrders.companyId, ctx.companyId), inArray(salesOrders.status, ['open', 'partial'])),
    )
    .groupBy(salesOrderLines.itemId);
  const committedByItem = new Map(committedRows.map((r) => [r.itemId, r.committed]));

  const onPoRows = await ctx.db
    .select({
      itemId: purchaseOrderLines.itemId,
      onPO: sql<string>`COALESCE(SUM(GREATEST(${purchaseOrderLines.quantity} - ${purchaseOrderLines.quantityBilled}, 0)), 0)`,
    })
    .from(purchaseOrderLines)
    .innerJoin(purchaseOrders, eq(purchaseOrderLines.purchaseOrderId, purchaseOrders.id))
    .where(
      and(
        eq(purchaseOrders.companyId, ctx.companyId),
        inArray(purchaseOrders.status, ['open', 'partial']),
      ),
    )
    .groupBy(purchaseOrderLines.itemId);
  const onPoByItem = new Map(onPoRows.map((r) => [r.itemId, r.onPO]));

  let attentionCount = 0;
  const rows: StockStatusRow[] = itemRows
    .map((r) => {
      const onHand = Money.of(r.quantityOnHand ?? '0');
      const committed = Money.of(committedByItem.get(r.id) ?? '0');
      const available = onHand.minus(committed);
      const onPO = Money.of(onPoByItem.get(r.id) ?? '0');

      let suggested = Money.zero();
      let needsAttention = available.lessThanOrEqualTo(0) && committed.greaterThan(0);
      if (r.reorderPoint != null) {
        const reorder = Money.of(r.reorderPoint);
        if (available.plus(onPO).lessThanOrEqualTo(reorder)) {
          const target = reorder.times(2).minus(available.plus(onPO));
          suggested = target.greaterThan(0) ? target : Money.zero();
          needsAttention = true;
        }
      }
      if (needsAttention) attentionCount += 1;

      return {
        id: r.id,
        name: r.name,
        sku: r.sku ?? null,
        quantityOnHand: onHand.toFixed(4),
        committed: committed.toFixed(4),
        available: available.toFixed(4),
        onPO: onPO.toFixed(4),
        reorderPoint: r.reorderPoint == null ? null : Money.of(r.reorderPoint).toFixed(4),
        suggestedOrder: suggested.toFixed(4),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return { rows, attentionCount };
}

// ---------------------------------------------------------------------------
// As-of-date valuation + valuation detail (GL-derived)
// ---------------------------------------------------------------------------
//
// An item's inventory VALUE at any past date is reconstructed from the posted lines on the
// inventory asset accounts, attributed to items by the document that posted them
// (loadItemGlMovements):
//   - `item:<id>` entries (adjustments, FIFO receipts / consumption, physical counts, value
//     adjustments, landed cost, opening stock): the item named in the tag.
//   - COGS / restock entries posted per line (`invoice-cogs:` + reference cogs:<lineOrder>,
//     `salesreceipt:` / `creditmemo-cogs:` + reference = the line id): that line's item.
//   - `assembly_build:` / `assembly_unbuild:<id>:<fromItem>:<toItem>`: credit -> from, debit -> to.
//   - Purchase documents (`bill:`, `expense:`, `item_receipt:`, `vendor_credit:`): each inventory
//     item line's POSTED home amount (bill / check lines: homeAmounts over the document's lines,
//     exactly as they were posted; receipt line amounts; receive-items price variance
//     capitalized; vendor-credit return cost). A line without an item on an inventory account
//     (e.g. freight coded to Inventory Asset) is not attributed to any item.
//   valueAsOf = SUM(attributed debit - credit) over entries dated <= asOf.
//   Document lines are found with joins from the entries in scope (never id lists — a statement
//   can carry at most 65535 bind parameters).
//
// Documented approximations:
//   - QUANTITY as of a past date is approximated as valueAsOf / currentUnitCost
//     (current averageCost for average items; remaining-layer effective cost
//     for FIFO items). It is exact whenever the unit cost has not changed
//     since the as-of date, and is reported null when the current cost is $0.
//   - Entries and lines with no item detail (manual journal entries on an inventory account,
//     expense-tab lines coded to it, condensed summaries, imported GL history) are not attributed
//     to any item, so the per-item values then no longer add up to the GL balance.

interface ItemGlMovement {
  entryId: string;
  entryNumber: number;
  date: Date;
  description: string;
  debit: Decimal;
  credit: Decimal;
}

/**
 * Load all posted inventory-asset GL movements attributed to items (see the module notes above),
 * grouped by item id, optionally limited to entries dated <= asOf. Only items in
 * `itemAccountById` are returned, and only value on each item's own inventory asset account.
 */
async function loadItemGlMovements(
  ctx: ServiceContext,
  itemAccountById: Map<string, string | null>,
  asOf?: Date,
): Promise<Map<string, ItemGlMovement[]>> {
  // Every inventory item's asset account (attribution needs all of them, not only the report's).
  const allItems = await ctx.db
    .select({ id: items.id, assetAccountId: items.assetAccountId })
    .from(items)
    .where(and(eq(items.companyId, ctx.companyId), eq(items.type, 'inventory')));
  const accountOf = await inventoryAccountMap(ctx, allItems);
  const invAccounts = [...new Set([...accountOf.values()].filter((v): v is string => !!v))];
  if (invAccounts.length === 0) return new Map();

  const conditions = [
    eq(journalEntries.companyId, ctx.companyId),
    eq(journalEntries.status, 'posted'),
    inArray(journalEntryLines.accountId, invAccounts),
  ];
  // Whole as-of day (the trial balance / balance sheet bound): entries with a time of day count.
  if (asOf) conditions.push(onOrBeforeDay(asOf));

  const lines = await ctx.db
    .select({
      entryId: journalEntries.id,
      entryNumber: journalEntries.entryNumber,
      date: journalEntries.date,
      description: journalEntries.description,
      sourceRef: journalEntries.sourceRef,
      reference: journalEntries.reference,
      createdAt: journalEntries.createdAt,
      accountId: journalEntryLines.accountId,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(...conditions))
    .orderBy(asc(journalEntries.date), asc(journalEntries.createdAt));

  // --- Document line detail for the per-line COGS and purchase sources ----------------------
  // Every lookup is a JOIN from the entries in scope to the document lines (matched on the
  // entry's sourceRef / reference), never an id list built from the history: a statement can
  // carry at most 65535 bind parameters, which a busy company passes in a year or two.
  const entryConds = [
    eq(journalEntries.companyId, ctx.companyId),
    eq(journalEntries.status, 'posted'),
    // Correlated (index on journal_entry_lines.journal_entry_id), so it stays a semi-join however
    // many entries touch the inventory accounts.
    exists(
      ctx.db
        .select({ one: sql`1` })
        .from(journalEntryLines)
        .where(and(eq(journalEntryLines.journalEntryId, journalEntries.id), inArray(journalEntryLines.accountId, invAccounts))),
    ),
  ];
  if (asOf) entryConds.push(onOrBeforeDay(asOf));
  const refLike = (prefix: string) => sql`${journalEntries.sourceRef} LIKE ${`${prefix}%`}`;

  // Per-line COGS / restock entries -> the item of the line they were posted for.
  const entryItem = new Map<string, string>();
  const cogsSources = await Promise.all([
    // Invoices: sourceRef invoice-cogs:<invoiceId>, reference cogs:<lineOrder>.
    ctx.db
      .select({ entryId: journalEntries.id, itemId: invoiceLines.itemId })
      .from(journalEntries)
      .innerJoin(
        invoiceLines,
        and(
          sql`${journalEntries.sourceRef} = 'invoice-cogs:' || ${invoiceLines.invoiceId}::text`,
          sql`${journalEntries.reference} = 'cogs:' || ${invoiceLines.lineOrder}::text`,
        ),
      )
      .where(and(...entryConds, refLike('invoice-cogs:'))),
    // Sales receipts: sourceRef salesreceipt:<receiptId>, reference = the receipt line id.
    ctx.db
      .select({ entryId: journalEntries.id, itemId: salesReceiptLines.itemId })
      .from(journalEntries)
      .innerJoin(
        salesReceiptLines,
        and(
          sql`${journalEntries.sourceRef} = 'salesreceipt:' || ${salesReceiptLines.salesReceiptId}::text`,
          sql`${journalEntries.reference} = ${salesReceiptLines.id}::text`,
        ),
      )
      .where(and(...entryConds, refLike('salesreceipt:'))),
    // Credit memo restocks: sourceRef creditmemo-cogs:<memoId>, reference = the memo line id.
    ctx.db
      .select({ entryId: journalEntries.id, itemId: creditMemoLines.itemId })
      .from(journalEntries)
      .innerJoin(
        creditMemoLines,
        and(
          sql`${journalEntries.sourceRef} = 'creditmemo-cogs:' || ${creditMemoLines.creditMemoId}::text`,
          sql`${journalEntries.reference} = ${creditMemoLines.id}::text`,
        ),
      )
      .where(and(...entryConds, refLike('creditmemo-cogs:'))),
  ]);
  for (const rows of cogsSources) for (const r of rows) if (r.itemId) entryItem.set(r.entryId, r.itemId);

  // Purchase documents -> the posted HOME amount of each inventory item line (entry id -> item ->
  // signed value). Lines without an item (an expense-tab line on an inventory account) are left
  // unattributed, like manual journal entries.
  const purchaseValue = new Map<string, Map<string, Decimal>>();
  const addPurchase = (entryId: string, itemId: string | null, amount: Decimal) => {
    if (!itemId || !accountOf.has(itemId) || amount.isZero()) return;
    const m = purchaseValue.get(entryId) ?? new Map<string, Decimal>();
    m.set(itemId, (m.get(itemId) ?? Money.zero()).plus(amount));
    purchaseValue.set(entryId, m);
  };
  /**
   * Bills and checks post one debit per line at its home amount: homeAmounts over ALL the
   * document's lines in line order (one anchor penny-allocated), exactly as prepareBill /
   * prepareExpense posted it (and as their stock reversal re-derives it).
   */
  const addPostedLines = (
    rows: Array<{
      entryId: string;
      currency: string | null;
      rate: string | null;
      itemId: string | null;
      accountId: string;
      amount: string;
      lineOrder: number;
    }>,
  ) => {
    const byDoc = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byDoc.get(r.entryId);
      if (list) list.push(r);
      else byDoc.set(r.entryId, [r]);
    }
    for (const [entryId, docLines] of byDoc) {
      docLines.sort((a, b) => a.lineOrder - b.lineOrder);
      const head = docLines[0];
      const home = homeAmounts(
        docLines.map((l) => Money.of(l.amount).abs()),
        head.currency ? (head.rate ?? 1) : 1,
      );
      docLines.forEach((l, i) => {
        if (l.itemId && accountOf.get(l.itemId) === l.accountId) addPurchase(entryId, l.itemId, home.lines[i]);
      });
    }
  };
  const [billRows, varianceRows, expenseRows, receiptRows, creditRows] = await Promise.all([
    ctx.db
      .select({
        entryId: journalEntries.id,
        currency: bills.currency,
        rate: bills.exchangeRate,
        itemId: billLines.itemId,
        accountId: billLines.accountId,
        amount: billLines.amount,
        lineOrder: billLines.lineOrder,
      })
      .from(journalEntries)
      .innerJoin(bills, sql`${journalEntries.sourceRef} = 'bill:' || ${bills.id}::text`)
      .innerJoin(billLines, eq(billLines.billId, bills.id))
      .where(and(...entryConds, refLike('bill:'))),
    // Receive-items bills: the price variance capitalized into each item (home, signed).
    ctx.db
      .select({ entryId: journalEntries.id, itemId: itemReceiptBillLines.itemId, amount: itemReceiptBillLines.inventoryVariance })
      .from(journalEntries)
      .innerJoin(itemReceiptBillLines, sql`${journalEntries.sourceRef} = 'bill:' || ${itemReceiptBillLines.billId}::text`)
      .where(and(...entryConds, refLike('bill:'), eq(itemReceiptBillLines.companyId, ctx.companyId))),
    ctx.db
      .select({
        entryId: journalEntries.id,
        currency: expenses.currency,
        rate: expenses.exchangeRate,
        itemId: expenseLines.itemId,
        accountId: expenseLines.accountId,
        amount: expenseLines.amount,
        lineOrder: expenseLines.lineOrder,
      })
      .from(journalEntries)
      .innerJoin(expenses, sql`${journalEntries.sourceRef} = 'expense:' || ${expenses.id}::text`)
      .innerJoin(expenseLines, eq(expenseLines.expenseId, expenses.id))
      .where(and(...entryConds, refLike('expense:'))),
    // Item receipts post each line's amount (home) to its item's inventory account.
    ctx.db
      .select({ entryId: journalEntries.id, itemId: itemReceiptLines.itemId, amount: itemReceiptLines.amount })
      .from(journalEntries)
      .innerJoin(itemReceiptLines, sql`${journalEntries.sourceRef} = 'item_receipt:' || ${itemReceiptLines.itemReceiptId}::text`)
      .where(and(...entryConds, refLike('item_receipt:'))),
    // Vendor credits credit each returned item's inventory account with its cost (home).
    ctx.db
      .select({ entryId: journalEntries.id, itemId: vendorCreditLines.itemId, cost: vendorCreditLines.costAmount })
      .from(journalEntries)
      .innerJoin(vendorCreditLines, sql`${journalEntries.sourceRef} = 'vendor_credit:' || ${vendorCreditLines.vendorCreditId}::text`)
      .where(and(...entryConds, refLike('vendor_credit:'))),
  ]);
  addPostedLines(billRows);
  addPostedLines(expenseRows);
  for (const r of varianceRows) if (r.amount != null) addPurchase(r.entryId, r.itemId, Money.of(r.amount));
  for (const r of receiptRows) addPurchase(r.entryId, r.itemId, Money.of(r.amount));
  for (const r of creditRows) if (r.cost != null) addPurchase(r.entryId, r.itemId, Money.of(r.cost).negated());

  // --- Attribute entry by entry ---------------------------------------------------------------
  type Line = (typeof lines)[number];
  const byEntry = new Map<string, Line[]>();
  for (const l of lines) {
    const list = byEntry.get(l.entryId) ?? [];
    list.push(l);
    byEntry.set(l.entryId, list);
  }

  const byItem = new Map<string, ItemGlMovement[]>();
  const push = (itemId: string, head: Line, debit: Decimal, credit: Decimal) => {
    if (!itemAccountById.has(itemId)) return;
    if (debit.isZero() && credit.isZero()) return;
    const list = byItem.get(itemId) ?? [];
    list.push({
      entryId: head.entryId,
      entryNumber: head.entryNumber,
      date: head.date,
      description: head.description,
      debit,
      credit,
    });
    byItem.set(itemId, list);
  };
  const pushNet = (itemId: string, head: Line, net: Decimal) =>
    push(itemId, head, net.greaterThan(0) ? net : Money.zero(), net.lessThan(0) ? net.negated() : Money.zero());
  /** Lines of the entry on `itemId`'s own account go to that item, line by line. */
  const toItem = (itemId: string | undefined, entryLines: Line[]) => {
    if (!itemId) return;
    for (const l of entryLines) {
      if (l.accountId !== accountOf.get(itemId)) continue;
      push(itemId, l, Money.of(l.debit ?? '0'), Money.of(l.credit ?? '0'));
    }
  };

  for (const entryLines of byEntry.values()) {
    const head = entryLines[0];
    const ref = head.sourceRef ?? '';
    const colon = ref.indexOf(':');
    const kind = colon >= 0 ? ref.slice(0, colon) : ref;
    const rest = colon >= 0 ? ref.slice(colon + 1) : '';
    switch (kind) {
      case 'item':
        toItem(rest, entryLines);
        break;
      case 'invoice-cogs':
      case 'salesreceipt':
      case 'creditmemo-cogs':
        toItem(entryItem.get(head.entryId), entryLines);
        break;
      case 'assembly_build':
      case 'assembly_unbuild': {
        const [, fromId, toId] = rest.split(':');
        for (const l of entryLines) {
          const credit = Money.of(l.credit ?? '0');
          const debit = Money.of(l.debit ?? '0');
          if (credit.greaterThan(0) && fromId && l.accountId === accountOf.get(fromId)) push(fromId, l, Money.zero(), credit);
          if (debit.greaterThan(0) && toId && l.accountId === accountOf.get(toId)) push(toId, l, debit, Money.zero());
        }
        break;
      }
      default: {
        // Purchase documents: each inventory item line's posted home amount (no scaling, so a
        // line without an item on the same account stays unattributed).
        const values = purchaseValue.get(head.entryId);
        if (!values) break;
        for (const [itemId, amount] of values) {
          if (entryLines.some((l) => l.accountId === accountOf.get(itemId))) pushNet(itemId, head, amount);
        }
      }
    }
  }
  return byItem;
}

/** Build itemId -> inventory asset account id map (assetAccountId ?? code 1300). */
async function inventoryAccountMap(
  ctx: ServiceContext,
  rows: Array<{ id: string; assetAccountId: string | null }>,
): Promise<Map<string, string | null>> {
  let defaultAccountId: string | null = null;
  if (rows.some((r) => !r.assetAccountId)) {
    const [acct] = await ctx.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '1300')));
    defaultAccountId = acct?.id ?? null;
  }
  return new Map(rows.map((r) => [r.id, r.assetAccountId ?? defaultAccountId]));
}

/**
 * Current effective unit cost per item: averageCost for average items, total
 * remaining layer value / quantity for FIFO items (falling back to the most
 * recent layer's unitCost when no quantity remains). Null when unknown/zero.
 */
async function currentUnitCosts(
  ctx: ServiceContext,
  rows: Array<{ id: string; averageCost: string | null }>,
): Promise<Map<string, { cost: Decimal | null; costingMethod: 'fifo' | 'average' }>> {
  const layerRows = await ctx.db
    .select({
      itemId: inventoryLayers.itemId,
      date: inventoryLayers.date,
      quantityRemaining: inventoryLayers.quantityRemaining,
      unitCost: inventoryLayers.unitCost,
    })
    .from(inventoryLayers)
    .where(eq(inventoryLayers.companyId, ctx.companyId))
    .orderBy(asc(inventoryLayers.date), asc(inventoryLayers.createdAt));

  const layersByItem = new Map<string, typeof layerRows>();
  for (const l of layerRows) {
    const list = layersByItem.get(l.itemId) ?? [];
    list.push(l);
    layersByItem.set(l.itemId, list);
  }

  const result = new Map<string, { cost: Decimal | null; costingMethod: 'fifo' | 'average' }>();
  for (const r of rows) {
    const layers = layersByItem.get(r.id);
    if (layers && layers.length > 0) {
      let qty = Money.zero();
      let value = Money.zero();
      for (const l of layers) {
        const q = Money.of(l.quantityRemaining);
        qty = qty.plus(q);
        value = value.plus(fifoLayerValue(q, l.unitCost)); // same rule as inventoryValuation
      }
      let cost: Decimal | null = null;
      if (qty.greaterThan(0)) cost = value.dividedBy(qty);
      else {
        const last = Money.of(layers[layers.length - 1].unitCost);
        cost = last.greaterThan(0) ? last : null;
      }
      result.set(r.id, { cost: cost && cost.greaterThan(0) ? cost : null, costingMethod: 'fifo' });
    } else {
      const avg = Money.of(r.averageCost ?? '0');
      result.set(r.id, { cost: avg.greaterThan(0) ? avg : null, costingMethod: 'average' });
    }
  }
  return result;
}

export interface ValuationAsOfRow {
  id: string;
  name: string;
  sku: string | null;
  costingMethod: 'fifo' | 'average';
  /** Exact GL-derived inventory value at the as-of date. */
  valueAsOf: string;
  /** Approximate quantity (valueAsOf / current unit cost); null when cost is unknown. */
  quantityAsOf: string | null;
  /** Unit cost used to derive quantityAsOf (current cost). */
  unitCostUsed: string | null;
}

export interface ValuationAsOfResult {
  asOf: string;
  items: ValuationAsOfRow[];
  grandTotal: string;
  /** Documented approximations for this reconstruction. */
  notes: string[];
}

/** Inventory valuation reconstructed at a past date — see module notes above. */
export async function inventoryValuationAsOf(
  ctx: ServiceContext,
  asOf: Date,
): Promise<ValuationAsOfResult> {
  // Every inventory item: an inactive one is still listed while it carried value at the date
  // (making an item inactive does not take its stock off the balance sheet).
  const itemRows = await ctx.db
    .select({
      id: items.id,
      name: items.name,
      sku: items.sku,
      isActive: items.isActive,
      averageCost: items.averageCost,
      assetAccountId: items.assetAccountId,
    })
    .from(items)
    .where(and(eq(items.companyId, ctx.companyId), eq(items.type, 'inventory')));

  const accountMap = await inventoryAccountMap(ctx, itemRows);
  const movements = await loadItemGlMovements(ctx, accountMap, asOf);
  const costs = await currentUnitCosts(ctx, itemRows);

  let grandTotal = Money.zero();
  const valueOf = (id: string) =>
    (movements.get(id) ?? []).reduce((s, m) => s.plus(m.debit).minus(m.credit), Money.zero());
  const rows: ValuationAsOfRow[] = itemRows
    .filter((r) => r.isActive || !Money.round2(valueOf(r.id)).isZero())
    .map((r) => {
      const value = valueOf(r.id);
      grandTotal = grandTotal.plus(value);
      const costInfo = costs.get(r.id) ?? { cost: null, costingMethod: 'average' as const };
      const qty = costInfo.cost ? value.dividedBy(costInfo.cost) : null;
      return {
        id: r.id,
        name: r.name,
        sku: r.sku ?? null,
        costingMethod: costInfo.costingMethod,
        valueAsOf: toAmountString(Money.round2(value)),
        quantityAsOf: qty ? qty.toFixed(4) : null,
        unitCostUsed: costInfo.cost ? costInfo.cost.toFixed(4) : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    asOf: asOf.toISOString(),
    items: rows,
    grandTotal: toAmountString(Money.round2(grandTotal)),
    notes: [
      'Values are reconstructed exactly from posted journal entries on each item’s inventory asset account.',
      'Quantities are approximated as value ÷ current unit cost (exact when the unit cost has not changed since the as-of date).',
      'Each posting is attributed to its item through the document that made it (bills, checks, item receipts, vendor credits, sales COGS, restocks, adjustments, assembly builds); manual journal entries on an inventory account are not attributed to any item.',
    ],
  };
}

export interface ValuationDetailMovement {
  entryId: string;
  entryNumber: number;
  date: string;
  description: string;
  /** Value into inventory (debit). */
  valueIn: string;
  /** Value out of inventory (credit). */
  valueOut: string;
  delta: string;
  runningValue: string;
  /** Approximate quantity moved (delta / current unit cost); null when cost unknown. */
  approxQty: string | null;
}

export interface ValuationDetailItem {
  itemId: string;
  name: string;
  sku: string | null;
  costingMethod: 'fifo' | 'average';
  openingValue: string;
  closingValue: string;
  movements: ValuationDetailMovement[];
}

export interface ValuationDetailResult {
  from: string | null;
  to: string | null;
  items: ValuationDetailItem[];
  notes: string[];
}

/**
 * Inventory Valuation Detail — transaction-level value movements per item from
 * the GL (sourceRef `item:<id>` lines on the inventory asset account), with a
 * running balance. Optionally limited to one item and/or a date range; the
 * opening value accumulates everything before `from`.
 */
export async function inventoryValuationDetail(
  ctx: ServiceContext,
  opts?: { itemId?: string | null; from?: Date | null; to?: Date | null },
): Promise<ValuationDetailResult> {
  const conditions = [
    eq(items.companyId, ctx.companyId),
    eq(items.type, 'inventory'),
  ];
  if (opts?.itemId) conditions.push(eq(items.id, opts.itemId));

  const itemRows = await ctx.db
    .select({
      id: items.id,
      name: items.name,
      sku: items.sku,
      averageCost: items.averageCost,
      assetAccountId: items.assetAccountId,
    })
    .from(items)
    .where(and(...conditions));
  if (opts?.itemId && itemRows.length === 0) throw notFound('Item');

  const accountMap = await inventoryAccountMap(ctx, itemRows);
  const movements = await loadItemGlMovements(ctx, accountMap, opts?.to ?? undefined);
  const costs = await currentUnitCosts(ctx, itemRows);

  const from = opts?.from ?? null;
  const resultItems: ValuationDetailItem[] = [];

  for (const r of itemRows.sort((a, b) => a.name.localeCompare(b.name))) {
    const moves = movements.get(r.id) ?? [];
    const costInfo = costs.get(r.id) ?? { cost: null, costingMethod: 'average' as const };

    let opening = Money.zero();
    const inRange: ItemGlMovement[] = [];
    for (const m of moves) {
      if (from && m.date.getTime() < from.getTime()) {
        opening = opening.plus(m.debit).minus(m.credit);
      } else {
        inRange.push(m);
      }
    }

    if (!opts?.itemId && inRange.length === 0 && opening.isZero()) continue;

    let running = opening;
    const detailMoves: ValuationDetailMovement[] = inRange.map((m) => {
      const delta = m.debit.minus(m.credit);
      running = running.plus(delta);
      return {
        entryId: m.entryId,
        entryNumber: m.entryNumber,
        date: m.date.toISOString(),
        description: m.description,
        valueIn: toAmountString(Money.round2(m.debit)),
        valueOut: toAmountString(Money.round2(m.credit)),
        delta: toAmountString(Money.round2(delta)),
        runningValue: toAmountString(Money.round2(running)),
        approxQty: costInfo.cost ? delta.dividedBy(costInfo.cost).toFixed(4) : null,
      };
    });

    resultItems.push({
      itemId: r.id,
      name: r.name,
      sku: r.sku ?? null,
      costingMethod: costInfo.costingMethod,
      openingValue: toAmountString(Money.round2(opening)),
      closingValue: toAmountString(Money.round2(running)),
      movements: detailMoves,
    });
  }

  return {
    from: from ? from.toISOString() : null,
    to: opts?.to ? opts.to.toISOString() : null,
    items: resultItems,
    notes: [
      'Movements are the posted journal-entry lines on each item’s inventory asset account, attributed to the item by the document that posted them.',
      'Approx. qty is derived as value ÷ current unit cost — exact when the unit cost has not changed.',
      'Manual journal entries on an inventory account carry no item and do not appear as movements.',
    ],
  };
}
