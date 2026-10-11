/**
 * Credit Memos (A/R credits) service.
 *
 * A credit memo reduces what a customer owes. The posting pattern at creation
 * reverses an invoice's posting exactly — including sales tax:
 *
 *   Dr  <income account per line>  (line.accountId or '4000')   line.amount
 *   Dr  2200 Sales Tax Payable                                  taxAmount
 *   Cr  1200 Accounts Receivable                                total
 *
 * Tax is computed like invoices/sales receipts: taxable lines x the memo-level
 * tax rate, with both sides of the entry penny-allocated so rounding can never
 * unbalance it. NOTE: the credit_memo_lines table has no taxable column (schema
 * is frozen), so per-line taxable flags affect the computation at create time
 * but are not persisted on the line rows.
 *
 * Inventory restocking (QB parity — a credit memo returns items to stock):
 * when a line references an inventory item and `restock` is not false, the
 * quantity goes back on hand and the original COGS is reversed:
 *
 *   Dr  1300 Inventory Asset    qty x unit cost
 *   Cr  5000 Cost of Goods Sold qty x unit cost
 *
 * Average-cost items restock at the item's current average cost; FIFO-tracked
 * items get a NEW layer at the current blended remaining-layer cost (mirroring
 * voidSalesReceipt's restore pattern). Each restock entry is tagged
 * sourceRef "creditmemo-cogs:<memoId>" with reference = the memo line id so a
 * later void can find it, reverse the GL, and pull the stock back out.
 * Lines with `restock: false` model a damaged-goods write-off: revenue is still
 * reversed but the cost stays in COGS and stock is untouched.
 *
 * A/R is credited immediately — AR balance drops. The unapplied field tracks
 * how much of the credit has not yet been applied to an invoice. Applying a
 * credit memo to an invoice does NOT post a new journal entry (the AR impact
 * already happened at creation); it only moves the credit from unapplied to
 * applied and reduces the invoice's balanceDue.
 *
 * Voiding refuses if any part of the memo has been applied or refunded, then
 * reverses the main GL entry AND every restock entry, removing the restocked
 * quantity from stock again.
 */
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  accounts,
  creditMemos,
  creditMemoLines,
  customers,
  inventoryLayers,
  invoices,
  items,
  journalEntries,
  journalEntryLines,
  taxRates,
} from '@/lib/db/schema';
import { Money, allocate, toAmountString } from '@/lib/money';
import { postJournalEntry, voidJournalEntry } from '@/lib/services/posting';
import { markPaidAmount } from './invoices';
import {
  type InventoryLineDetail,
  attachInventoryDetails,
  postDocumentInventory,
  reverseDocumentInventory,
} from './inventorySites';
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

export interface CreditMemoLineInput extends InventoryLineDetail {
  /**
   * Optional product/service item; supplies the income account as a fallback
   * and (for inventory items) triggers restocking + COGS reversal.
   */
  itemId?: string | null;
  description?: string | null;
  quantity: string | number;
  rate: string | number;
  /** Income account to debit (default: item.incomeAccountId, then code '4000'). */
  accountId?: string | null;
  /** Whether this line participates in tax computation. Defaults true. */
  taxable?: boolean;
  /**
   * Inventory items only: return the goods to stock (true, default) or treat
   * the return as a damaged-goods write-off (false — no restock, no COGS
   * reversal; the cost stays in COGS).
   */
  restock?: boolean;
}

export interface CreateCreditMemoInput {
  customerId: string;
  date: Date;
  lines: CreditMemoLineInput[];
  /** Memo-level tax rate (UUID of a taxRates row); if absent no tax is credited back. */
  taxRateId?: string | null;
  memo?: string | null;
}

export interface ApplyToInvoiceInput {
  creditMemoId: string;
  invoiceId: string;
  /** Amount to apply (must be <= unapplied and <= invoice.balanceDue). */
  amount: string | number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Look up an account id by COA code, scoped to the company. Throws NOT_FOUND. */
async function accountIdByCode(ctx: ServiceContext, code: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
  if (!row) throw notFound(`Account with code ${code}`);
  return row.id;
}

/** Return the next memo number for the company (max + 1, 1 if none). */
async function nextMemoNumber(ctx: ServiceContext): Promise<number> {
  const [row] = await ctx.db
    .select({ max: sql<number>`COALESCE(MAX(${creditMemos.memoNumber}), 0)` })
    .from(creditMemos)
    .where(eq(creditMemos.companyId, ctx.companyId));
  return (row?.max ?? 0) + 1;
}

/**
 * Is this item FIFO-tracked? Any inventoryLayers row means fifo.ts owns its
 * costing. Mirrors the detection used by salesReceipts.ts / inventory.ts
 * (`assertNotFifoTracked`); kept local because inventory.ts only exposes the
 * throwing variant.
 */
async function isFifoTracked(ctx: ServiceContext, itemId: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ cnt: sql<number>`count(*)` })
    .from(inventoryLayers)
    .where(and(eq(inventoryLayers.companyId, ctx.companyId), eq(inventoryLayers.itemId, itemId)));
  return Number(row?.cnt ?? 0) > 0;
}

/**
 * Current restock unit cost for an item.
 *  - FIFO-tracked: blended cost of remaining layers (value / qty); falls back
 *    to averageCost / purchaseCost when every layer is empty.
 *  - Average-cost: item.averageCost, falling back to purchaseCost.
 */
async function restockUnitCost(
  ctx: ServiceContext,
  item: { id: string; averageCost: string | null; purchaseCost: string | null },
  fifoTracked: boolean,
): Promise<ReturnType<typeof Money.zero>> {
  if (fifoTracked) {
    const layers = await ctx.db
      .select({ qty: inventoryLayers.quantityRemaining, unitCost: inventoryLayers.unitCost })
      .from(inventoryLayers)
      .where(
        and(eq(inventoryLayers.companyId, ctx.companyId), eq(inventoryLayers.itemId, item.id)),
      );
    let totalQty = Money.zero();
    let totalValue = Money.zero();
    for (const l of layers) {
      const q = Money.of(l.qty);
      if (q.lessThanOrEqualTo(0)) continue;
      totalQty = totalQty.plus(q);
      totalValue = totalValue.plus(q.times(Money.of(l.unitCost)));
    }
    if (totalQty.greaterThan(0)) return totalValue.dividedBy(totalQty);
  }
  const avg = Money.of(item.averageCost ?? '0');
  if (avg.greaterThan(0)) return avg;
  return Money.of(item.purchaseCost ?? '0');
}

// ---------------------------------------------------------------------------
// createCreditMemo
// ---------------------------------------------------------------------------

export async function createCreditMemo(ctx: ServiceContext, input: CreateCreditMemoInput) {
  // Validate lines
  if (!input.lines || input.lines.length === 0) {
    throw validation('A credit memo must have at least one line.');
  }

  // Verify customer belongs to company.
  const [customer] = await ctx.db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, input.customerId)));
  if (!customer) throw notFound('Customer');

  // Load the memo-level tax rate if provided (same pattern as invoices/sales receipts).
  let taxRateDecimal = Money.zero();
  if (input.taxRateId) {
    const [taxRow] = await ctx.db
      .select({ rate: taxRates.rate })
      .from(taxRates)
      .where(and(eq(taxRates.companyId, ctx.companyId), eq(taxRates.id, input.taxRateId)));
    if (!taxRow) throw notFound('Tax rate');
    taxRateDecimal = Money.of(taxRow.rate);
  }

  // Resolve standing accounts
  const arAccountId = await accountIdByCode(ctx, '1200');
  const defaultIncomeId = await accountIdByCode(ctx, '4000');
  const taxPayableId = input.taxRateId ? await accountIdByCode(ctx, '2200') : null;

  // Pre-load referenced items (income account fallback + inventory typing for restock).
  const itemIds = [...new Set(input.lines.filter((l) => l.itemId).map((l) => l.itemId as string))];
  const itemMap = new Map<
    string,
    {
      id: string;
      incomeAccountId: string | null;
      assetAccountId: string | null;
      type: string;
      name: string;
      averageCost: string | null;
      purchaseCost: string | null;
    }
  >();
  if (itemIds.length > 0) {
    const itemRows = await ctx.db
      .select({
        id: items.id,
        incomeAccountId: items.incomeAccountId,
        assetAccountId: items.assetAccountId,
        type: items.type,
        name: items.name,
        averageCost: items.averageCost,
        purchaseCost: items.purchaseCost,
      })
      .from(items)
      .where(and(eq(items.companyId, ctx.companyId), inArray(items.id, itemIds)));
    for (const r of itemRows) itemMap.set(r.id, r);
    for (const id of itemIds) {
      if (!itemMap.has(id)) throw notFound(`Item ${id}`);
    }
  }

  // Compute per-line amounts
  type ComputedLine = {
    itemId: string | null;
    accountId: string;
    description: string | null;
    quantity: string;
    rate: string;
    amount: string;
    taxable: boolean;
    restock: boolean;
    lineOrder: number;
  };

  let subtotal = Money.zero();
  let taxableSubtotal = Money.zero();
  const computedLines: ComputedLine[] = [];

  for (let i = 0; i < input.lines.length; i++) {
    const l = input.lines[i];
    const qty = Money.of(l.quantity);
    const rate = Money.of(l.rate);
    if (qty.lessThanOrEqualTo(0)) throw validation(`Line ${i + 1}: quantity must be positive.`);
    if (rate.lessThan(0)) throw validation(`Line ${i + 1}: rate cannot be negative.`);

    const amount = Money.round2(Money.mul(qty, rate));

    // Resolve income account: explicit accountId > item.incomeAccountId > 4000
    let resolvedAccountId = defaultIncomeId;
    if (l.accountId) {
      const [acctRow] = await ctx.db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, l.accountId)));
      if (!acctRow) throw notFound(`Account ${l.accountId} (line ${i + 1})`);
      resolvedAccountId = acctRow.id;
    } else if (l.itemId) {
      const itemIncomeId = itemMap.get(l.itemId)?.incomeAccountId ?? null;
      if (itemIncomeId) resolvedAccountId = itemIncomeId;
    }

    const taxable = l.taxable !== false; // default true
    subtotal = subtotal.plus(amount);
    if (taxable) taxableSubtotal = taxableSubtotal.plus(amount);

    computedLines.push({
      itemId: l.itemId ?? null,
      accountId: resolvedAccountId,
      description: l.description ?? null,
      quantity: toAmountString(qty),
      rate: toAmountString(rate),
      amount: toAmountString(amount),
      taxable,
      restock: l.restock !== false, // default true (returned to stock)
      lineOrder: i,
    });
  }

  const taxAmount = Money.round2(Money.mul(taxableSubtotal, taxRateDecimal));
  const total = Money.round2(subtotal.plus(taxAmount));
  if (total.lessThanOrEqualTo(0)) {
    throw validation('Credit memo total must be greater than zero.');
  }

  return inTransaction(ctx, async (tx) => {
    const memoNumber = await nextMemoNumber(tx);

    // 1) Insert credit memo header
    const [memo] = await tx.db
      .insert(creditMemos)
      .values({
        companyId: tx.companyId,
        customerId: input.customerId,
        memoNumber,
        date: input.date,
        // Persisted so the sales-tax liability engine can attribute the credited-back tax
        // to the rate's agencies (lib/services/accountant/salesTaxLedger.ts).
        taxRateId: input.taxRateId ?? null,
        status: 'open',
        subtotal: toAmountString(subtotal),
        taxAmount: toAmountString(taxAmount),
        total: toAmountString(total),
        unapplied: toAmountString(total),
        memo: input.memo ?? null,
      })
      .returning();

    // 2) Insert credit memo lines (returning ids so restock entries can reference them)
    const insertedLines = await tx.db
      .insert(creditMemoLines)
      .values(
        computedLines.map((cl) => ({
          creditMemoId: memo.id,
          itemId: cl.itemId,
          accountId: cl.accountId,
          description: cl.description,
          quantity: cl.quantity,
          rate: cl.rate,
          amount: cl.amount,
          lineOrder: cl.lineOrder,
        })),
      )
      .returning();
    insertedLines.sort((a, b) => a.lineOrder - b.lineOrder);

    // 3) Build and post the GL entry — the exact reverse of an invoice posting:
    //
    //    Dr each income account for line amounts (sum per account)
    //    Dr 2200 Sales Tax Payable for taxAmount (returns tax to the customer)
    //    Cr 1200 A/R for total
    //
    // entryBase = subtotal + taxAmount = total; both sides are penny-allocated
    // against the same anchor so rounding can never unbalance the entry.
    const entryBase = Money.round2(subtotal.plus(taxAmount));

    const incomeDebits = new Map<string, ReturnType<typeof Money.zero>>();
    for (const cl of computedLines) {
      const prev = incomeDebits.get(cl.accountId) ?? Money.zero();
      incomeDebits.set(cl.accountId, prev.plus(Money.of(cl.amount)));
    }

    const debitSpecs: Array<{
      accountId: string;
      weight: ReturnType<typeof Money.zero>;
      memo: string;
    }> = [];
    for (const [acctId, amount] of incomeDebits) {
      debitSpecs.push({
        accountId: acctId,
        weight: amount,
        memo: `Credit Memo #${memoNumber} — income reversal`,
      });
    }
    if (taxAmount.greaterThan(0) && taxPayableId) {
      debitSpecs.push({
        accountId: taxPayableId,
        weight: taxAmount,
        memo: `Credit Memo #${memoNumber} — sales tax reversal`,
      });
    }
    const creditSpecs: Array<{
      accountId: string;
      weight: ReturnType<typeof Money.zero>;
      memo: string;
    }> = [{ accountId: arAccountId, weight: total, memo: `Credit Memo #${memoNumber}` }];

    const debitAlloc = allocate(entryBase, debitSpecs.map((s) => s.weight));
    const creditAlloc = allocate(entryBase, creditSpecs.map((s) => s.weight));

    const postingLines: Array<{
      accountId: string;
      debit?: string;
      credit?: string;
      memo?: string;
    }> = [];
    debitSpecs.forEach((s, i) => {
      if (debitAlloc[i].greaterThan(0)) {
        postingLines.push({ accountId: s.accountId, debit: toAmountString(debitAlloc[i]), memo: s.memo });
      }
    });
    creditSpecs.forEach((s, i) => {
      if (creditAlloc[i].greaterThan(0)) {
        postingLines.push({ accountId: s.accountId, credit: toAmountString(creditAlloc[i]), memo: s.memo });
      }
    });

    const entry = await postJournalEntry(tx, {
      date: input.date,
      description: `Credit Memo #${memoNumber}`,
      reference: String(memoNumber),
      sourceRef: `credit_memo:${memo.id}`,
      lines: postingLines,
    });

    // 4) Restock inventory + reverse COGS for inventory-item lines marked restock.
    //
    //   Dr <inventory asset>  qty x unit cost
    //   Cr 5000 COGS          qty x unit cost
    //
    // Each entry is tagged sourceRef "creditmemo-cogs:<memoId>" with
    // reference = the memo line id so voidCreditMemo can find it, reverse the
    // GL, and pull the stock back out. FIFO items additionally get a NEW layer
    // at the restock unit cost (mirrors voidSalesReceipt's restore pattern).
    const restockEntries: Array<{ entryId: string; lineId: string; itemId: string; cost: string }> = [];
    for (let i = 0; i < insertedLines.length; i++) {
      const line = insertedLines[i];
      const cl = computedLines[i];
      if (!line.itemId || !cl.restock) continue;
      const meta = itemMap.get(line.itemId);
      if (!meta || meta.type !== 'inventory') continue;

      const qty = Money.of(line.quantity);
      const fifoTracked = await isFifoTracked(tx, line.itemId);
      const unitCost = await restockUnitCost(tx, meta, fifoTracked);
      const cost = Money.round2(qty.times(unitCost));

      // Reverse COGS only when there is a real cost (postJournalEntry rejects $0 entries).
      if (cost.greaterThan(0)) {
        const inventoryAccountId = meta.assetAccountId ?? (await accountIdByCode(tx, '1300'));
        const cogsAccountId = await accountIdByCode(tx, '5000');
        const restockEntry = await postJournalEntry(tx, {
          date: input.date,
          description: `Credit Memo #${memoNumber} — COGS reversal (${meta.name})`,
          reference: line.id,
          sourceRef: `creditmemo-cogs:${memo.id}`,
          lines: [
            {
              accountId: inventoryAccountId,
              debit: toAmountString(cost),
              memo: `Credit Memo #${memoNumber} — restock (${meta.name})`,
            },
            {
              accountId: cogsAccountId,
              credit: toAmountString(cost),
              memo: `Credit Memo #${memoNumber} — COGS reversal (${meta.name})`,
            },
          ],
        });
        restockEntries.push({ entryId: restockEntry.id, lineId: line.id, itemId: line.itemId, cost: toAmountString(cost) });
      }

      // FIFO items: restore stock value as a new layer at the restock cost.
      if (fifoTracked) {
        await tx.db.insert(inventoryLayers).values({
          companyId: tx.companyId,
          itemId: line.itemId,
          date: input.date,
          quantityRemaining: qty.toFixed(4),
          unitCost: unitCost.toFixed(4),
        });
      }

      // Both costing methods: put the quantity back on hand.
      await tx.db
        .update(items)
        .set({
          quantityOnHand: sql`COALESCE(${items.quantityOnHand}, 0) + ${qty.toFixed(4)}`,
          updatedAt: new Date(),
        })
        .where(and(eq(items.companyId, tx.companyId), eq(items.id, line.itemId)));
    }

    // 4b) Advanced Inventory: restocked units go back to the chosen site/bin (with their
    //     serial/lot identity). Damaged (restock=false) lines move no stock.
    await postDocumentInventory(tx, {
      sourceType: 'credit_memo',
      sourceId: memo.id,
      date: input.date,
      direction: 'in',
      lines: insertedLines.map((line) => {
        const src = input.lines[line.lineOrder];
        return {
          lineOrder: line.lineOrder,
          itemId: line.itemId,
          quantity: line.quantity,
          siteId: src?.siteId,
          binId: src?.binId,
          serialNumbers: src?.serialNumbers,
          lotNumber: src?.lotNumber,
          lotExpiration: src?.lotExpiration,
        };
      }),
      movingLineOrders: computedLines.filter((cl) => cl.restock).map((cl) => cl.lineOrder),
      memo: `Credit Memo #${memoNumber}`,
    });

    // 5) Stamp postedEntryId
    const [updated] = await tx.db
      .update(creditMemos)
      .set({ postedEntryId: entry.id })
      .where(eq(creditMemos.id, memo.id))
      .returning();

    // 6) Audit
    await writeAudit(tx, {
      action: 'create',
      entityType: 'credit_memo',
      entityId: memo.id,
      newValues: {
        memoNumber,
        customerId: input.customerId,
        subtotal: toAmountString(subtotal),
        taxAmount: toAmountString(taxAmount),
        total: toAmountString(total),
        postedEntryId: entry.id,
        restockEntries,
      },
    });

    return { ...updated, lines: insertedLines };
  });
}

// ---------------------------------------------------------------------------
// listCreditMemos
// ---------------------------------------------------------------------------

export async function listCreditMemos(
  ctx: ServiceContext,
  opts?: { customerId?: string; status?: string },
) {
  // Filter in SQL, not in JS — fetching the whole table is O(table size) per request.
  const conds = [eq(creditMemos.companyId, ctx.companyId)];
  if (opts?.customerId) conds.push(eq(creditMemos.customerId, opts.customerId));
  if (opts?.status) conds.push(eq(creditMemos.status, opts.status as never));

  return ctx.db
    .select()
    .from(creditMemos)
    .where(and(...conds))
    .orderBy(creditMemos.memoNumber);
}

// ---------------------------------------------------------------------------
// getCreditMemo (with lines)
// ---------------------------------------------------------------------------

export async function getCreditMemo(ctx: ServiceContext, id: string) {
  const [memo] = await ctx.db
    .select()
    .from(creditMemos)
    .where(and(eq(creditMemos.companyId, ctx.companyId), eq(creditMemos.id, id)));
  if (!memo) throw notFound('Credit memo');

  const lines = await ctx.db
    .select()
    .from(creditMemoLines)
    .where(eq(creditMemoLines.creditMemoId, id))
    .orderBy(asc(creditMemoLines.lineOrder));

  return { ...memo, lines: await attachInventoryDetails(ctx, 'credit_memo', id, lines) };
}

// ---------------------------------------------------------------------------
// applyToInvoice
// ---------------------------------------------------------------------------

/**
 * Apply a credit memo to an open invoice.
 * No new GL entry is created — the AR impact already happened when the memo was posted.
 * We simply transfer `amount` from the memo's unapplied to the invoice's amountPaid,
 * adjusting balanceDue and status on both documents.
 */
export async function applyToInvoice(ctx: ServiceContext, input: ApplyToInvoiceInput) {
  const amount = Money.round2(input.amount);
  if (!amount.greaterThan(0)) {
    throw validation('Apply amount must be greater than zero.');
  }

  // Load and validate the credit memo
  const [memo] = await ctx.db
    .select()
    .from(creditMemos)
    .where(and(eq(creditMemos.companyId, ctx.companyId), eq(creditMemos.id, input.creditMemoId)));
  if (!memo) throw notFound('Credit memo');
  if (memo.status === 'void') {
    throw new ServiceError('CONFLICT', 'Cannot apply a voided credit memo.');
  }

  const unapplied = Money.of(memo.unapplied);
  if (amount.greaterThan(unapplied)) {
    throw validation(
      `Apply amount ${toAmountString(amount)} exceeds credit memo unapplied balance ${toAmountString(unapplied)}.`,
    );
  }

  // Load and validate the invoice
  const [invoice] = await ctx.db
    .select()
    .from(invoices)
    .where(and(eq(invoices.companyId, ctx.companyId), eq(invoices.id, input.invoiceId)));
  if (!invoice) throw notFound('Invoice');
  if (invoice.status === 'void') {
    throw new ServiceError('CONFLICT', 'Cannot apply credit to a voided invoice.');
  }
  if (invoice.customerId !== memo.customerId) {
    throw new ServiceError(
      'VALIDATION',
      'Credit memo and invoice must belong to the same customer.',
    );
  }

  const balanceDue = Money.of(invoice.balanceDue);
  if (amount.greaterThan(balanceDue)) {
    throw validation(
      `Apply amount ${toAmountString(amount)} exceeds invoice balance due ${toAmountString(balanceDue)}.`,
    );
  }

  return inTransaction(ctx, async (tx) => {
    // Update invoice — delegate to the canonical helper so balanceDue is computed
    // against the billed base (total minus retainage holdback), exactly like payments.
    // Recomputing from invoice.total here would re-introduce the retainage into the
    // amount due and leave a settled retainage invoice looking 'partial'.
    const updatedInvoice = await markPaidAmount(tx, invoice.id, toAmountString(amount));

    // Update credit memo
    const newUnapplied = Money.round2(unapplied.minus(amount));
    const newMemoStatus = newUnapplied.isZero() ? 'paid' : 'open';

    const [updatedMemo] = await tx.db
      .update(creditMemos)
      .set({
        unapplied: toAmountString(newUnapplied),
        status: newMemoStatus as never,
      })
      .where(eq(creditMemos.id, memo.id))
      .returning();

    await writeAudit(tx, {
      action: 'update',
      entityType: 'credit_memo',
      entityId: memo.id,
      oldValues: { unapplied: toAmountString(unapplied), status: memo.status },
      newValues: {
        unapplied: toAmountString(newUnapplied),
        status: newMemoStatus,
        appliedToInvoice: invoice.id,
        amountApplied: toAmountString(amount),
      },
    });

    return { creditMemo: updatedMemo, invoice: updatedInvoice };
  });
}

// ---------------------------------------------------------------------------
// refundCreditMemo
// ---------------------------------------------------------------------------

export interface RefundCreditMemoInput {
  creditMemoId: string;
  /** Bank account the refund check is drawn on. */
  bankAccountId: string;
  /** Refund amount; must be <= the memo's unapplied balance. */
  amount: string | number;
  date?: Date | null;
  memo?: string | null;
}

/**
 * Refund (part of) a credit memo's unapplied balance to the customer by check.
 *
 * Posting:
 *   Dr  1200 Accounts Receivable   amount   — re-establishes the A/R the memo credited
 *   Cr  bank account               amount   — money leaves the bank
 *
 * The refund then immediately CONSUMES the memo's unapplied balance against that
 * A/R debit (refundedAmount += amount, unapplied -= amount), so the net open A/R
 * is unchanged: the memo's original A/R credit and this refund's A/R debit cancel,
 * and the subledger no longer carries the credit. Control account == subledger.
 */
export async function refundCreditMemo(ctx: ServiceContext, input: RefundCreditMemoInput) {
  const [memo] = await ctx.db
    .select()
    .from(creditMemos)
    .where(and(eq(creditMemos.companyId, ctx.companyId), eq(creditMemos.id, input.creditMemoId)));
  if (!memo) throw notFound('Credit memo');
  if (memo.status === 'void') {
    throw new ServiceError('CONFLICT', 'Cannot refund a voided credit memo.');
  }

  const amount = Money.round2(input.amount);
  if (!amount.greaterThan(0)) throw validation('Refund amount must be greater than zero.');
  const unapplied = Money.of(memo.unapplied);
  if (amount.greaterThan(unapplied)) {
    throw validation(
      `Refund amount ${toAmountString(amount)} exceeds the credit memo's unapplied balance ${toAmountString(unapplied)}.`,
    );
  }

  // Validate the bank account: company-owned bank/cash asset.
  const [bankAcct] = await ctx.db
    .select({ id: accounts.id, type: accounts.type, subtype: accounts.subtype })
    .from(accounts)
    .where(and(eq(accounts.id, input.bankAccountId), eq(accounts.companyId, ctx.companyId)));
  if (!bankAcct) throw notFound('Bank account');
  if (
    bankAcct.type !== 'asset' ||
    bankAcct.subtype === 'accounts_receivable' ||
    bankAcct.subtype === 'inventory'
  ) {
    throw validation('Refunds must be paid from a bank/cash account.');
  }

  const arAccountId = await accountIdByCode(ctx, '1200');
  const refundDate = input.date ?? new Date();

  return inTransaction(ctx, async (tx) => {
    // 1. Post the refund check.
    const entry = await postJournalEntry(tx, {
      date: refundDate,
      description: input.memo ?? `Refund — Credit Memo #${memo.memoNumber}`,
      reference: String(memo.memoNumber),
      sourceRef: `refund:${input.creditMemoId}`,
      lines: [
        {
          accountId: arAccountId,
          debit: toAmountString(amount),
          memo: `Credit Memo #${memo.memoNumber} refunded`,
        },
        {
          accountId: input.bankAccountId,
          credit: toAmountString(amount),
          memo: `Refund check — Credit Memo #${memo.memoNumber}`,
        },
      ],
    });

    // 2. Consume the memo's unapplied balance.
    const newUnapplied = Money.round2(unapplied.minus(amount));
    const newRefunded = Money.round2(Money.of(memo.refundedAmount).plus(amount));
    const newStatus = newUnapplied.isZero() ? 'paid' : memo.status;

    const [updatedMemo] = await tx.db
      .update(creditMemos)
      .set({
        unapplied: toAmountString(newUnapplied),
        refundedAmount: toAmountString(newRefunded),
        status: newStatus as never,
      })
      .where(eq(creditMemos.id, input.creditMemoId))
      .returning();

    await writeAudit(tx, {
      action: 'update',
      entityType: 'credit_memo',
      entityId: input.creditMemoId,
      oldValues: {
        unapplied: toAmountString(unapplied),
        refundedAmount: memo.refundedAmount,
        status: memo.status,
      },
      newValues: {
        action: 'refund',
        amount: toAmountString(amount),
        bankAccountId: input.bankAccountId,
        unapplied: toAmountString(newUnapplied),
        refundedAmount: toAmountString(newRefunded),
        postedEntryId: entry.id,
      },
    });

    return { creditMemo: updatedMemo, entry };
  });
}

// ---------------------------------------------------------------------------
// voidCreditMemo
// ---------------------------------------------------------------------------

/**
 * Void a credit memo: reverse the main GL entry, reverse every restock
 * (COGS-reversal) entry, and pull the restocked quantity back out of stock.
 *
 * Refuses (CONFLICT) when any part of the credit has been applied to an
 * invoice or refunded by check — unapply/handle those first. Also refuses
 * when a restocked quantity has since been sold (insufficient stock to
 * remove), which would otherwise drive quantityOnHand negative.
 */
export async function voidCreditMemo(ctx: ServiceContext, id: string) {
  const [memo] = await ctx.db
    .select()
    .from(creditMemos)
    .where(and(eq(creditMemos.companyId, ctx.companyId), eq(creditMemos.id, id)));
  if (!memo) throw notFound('Credit memo');

  if (memo.status === 'void') {
    return memo; // idempotent
  }

  // Block void if any of the credit has been refunded by check.
  if (Money.of(memo.refundedAmount).greaterThan(0)) {
    throw new ServiceError(
      'CONFLICT',
      'Cannot void a credit memo that has been refunded. Void the refund first.',
    );
  }

  // Block void if credit has been partially applied (total - unapplied covers
  // both invoice applications and refunds).
  const applied = Money.round2(Money.of(memo.total).minus(Money.of(memo.unapplied)));
  if (applied.greaterThan(0)) {
    throw new ServiceError(
      'CONFLICT',
      'Cannot void a credit memo with applied amounts. Unapply first.',
    );
  }

  return inTransaction(ctx, async (tx) => {
    const lines = await tx.db
      .select()
      .from(creditMemoLines)
      .where(eq(creditMemoLines.creditMemoId, id));
    const lineById = new Map(lines.map((l) => [l.id, l]));

    // Find all restock (COGS-reversal) entries tagged against this memo
    // (reference = memo line id).
    const restockJEs = await tx.db
      .select({
        id: journalEntries.id,
        reference: journalEntries.reference,
        status: journalEntries.status,
      })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, tx.companyId),
          eq(journalEntries.sourceRef, `creditmemo-cogs:${id}`),
          memo.postedEntryId ? ne(journalEntries.id, memo.postedEntryId) : undefined,
        ),
      );

    // Pre-check stock: every restocked quantity must still be on hand, or the
    // void would drive quantityOnHand negative.
    const removeQtyByItem = new Map<string, ReturnType<typeof Money.zero>>();
    for (const je of restockJEs) {
      if (je.status !== 'posted') continue;
      const line = je.reference ? lineById.get(je.reference) : undefined;
      if (!line?.itemId) continue;
      const prev = removeQtyByItem.get(line.itemId) ?? Money.zero();
      removeQtyByItem.set(line.itemId, prev.plus(Money.of(line.quantity)));
    }
    for (const [itemId, qty] of removeQtyByItem) {
      const [itemRow] = await tx.db
        .select({ name: items.name, quantityOnHand: items.quantityOnHand })
        .from(items)
        .where(and(eq(items.companyId, tx.companyId), eq(items.id, itemId)));
      const onHand = Money.of(itemRow?.quantityOnHand ?? '0');
      if (qty.greaterThan(onHand)) {
        throw new ServiceError(
          'CONFLICT',
          `Cannot void: restocked item "${itemRow?.name ?? itemId}" has since been sold ` +
            `(need ${qty.toFixed(4)} on hand to remove, only ${onHand.toFixed(4)} available).`,
        );
      }
    }

    // Reverse each restock entry and pull the stock back out.
    const reversedLineOrders: number[] = [];
    for (const je of restockJEs) {
      if (je.status !== 'posted') continue;
      const line = je.reference ? lineById.get(je.reference) : undefined;
      if (line) reversedLineOrders.push(line.lineOrder);

      // Reverse the GL first (Cr Inventory / Dr COGS via balance-delta reversal).
      await voidJournalEntry(tx, je.id);

      if (!line?.itemId) continue; // defensive: entry not tied to an inventory line

      const qty = Money.of(line.quantity);

      // Restock cost = the entry's total debits (the inventory side); its
      // unit cost identifies the layer the restock created.
      const entryLines = await tx.db
        .select({ debit: journalEntryLines.debit })
        .from(journalEntryLines)
        .where(eq(journalEntryLines.journalEntryId, je.id));
      const cost = entryLines.reduce((s, l) => s.plus(Money.of(l.debit)), Money.zero());
      const unitCost = qty.isZero() ? Money.zero() : cost.dividedBy(qty);

      if (await isFifoTracked(tx, line.itemId)) {
        // Deplete layers, preferring the exact layer the restock created
        // (matching unit cost), then oldest-first for any remainder.
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
        const target = unitCost.toFixed(4);
        available.sort((a, b) => {
          const aMatch = a.unitCost === target ? 0 : 1;
          const bMatch = b.unitCost === target ? 0 : 1;
          return aMatch - bMatch;
        });

        let remaining = qty;
        for (const layer of available) {
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
            `Cannot void: insufficient FIFO layers to remove ${qty.toFixed(4)} restocked units.`,
          );
        }
      }

      // Both costing methods: take the quantity back off hand.
      await tx.db
        .update(items)
        .set({
          quantityOnHand: sql`COALESCE(${items.quantityOnHand}, 0) - ${qty.toFixed(4)}`,
          updatedAt: new Date(),
        })
        .where(and(eq(items.companyId, tx.companyId), eq(items.id, line.itemId)));
    }

    // Pull the same units back out of the site/bin they were restocked to.
    await reverseDocumentInventory(tx, 'credit_memo', id, { lineOrders: reversedLineOrders });

    // Reverse the main credit memo entry.
    if (memo.postedEntryId) {
      await voidJournalEntry(tx, memo.postedEntryId);
    }

    const [updated] = await tx.db
      .update(creditMemos)
      .set({ status: 'void', unapplied: '0.00' })
      .where(eq(creditMemos.id, id))
      .returning();

    await writeAudit(tx, {
      action: 'void',
      entityType: 'credit_memo',
      entityId: id,
      oldValues: { status: memo.status },
      newValues: { status: 'void' },
    });

    return updated;
  });
}
