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
 * Pricing (B12): item lines sent without a rate are priced server-side by the advanced pricing
 * engine (price rules, the customer's price level, customer-specific prices) and every item line
 * records its provenance on credit_memo_lines.pricing (drizzle/0055) — same as invoices.
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
import { assertAccountantDatesOpen } from './accountantCopy/guard';
import { averageAfter, takeAccountantCost } from './accountantCopy/inventoryCost';
import { cogsAccountForItem, fifoLayerValue, valueRemainderAfter } from './inventory';
import { isDepositTargetAccount } from '@/lib/accountTypes';
import { assertSalesTaxAllowed } from '@/lib/featureGate';
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
  creditApplications,
} from '@/lib/db/schema';
import { Money, allocate, toAmountString } from '@/lib/money';
import { assertNotControlLineAccount, postJournalEntry, voidJournalEntry } from '@/lib/services/posting';
import { markPaidAmount } from './invoices';
import { assertPeriodOpen, recordClosingDateException, type PeriodCheck } from './fiscalPeriods';
import { getHomeCurrencyCode } from './currencies';
import { layerRoundingTolerance, takeFromDocumentLayers } from './fifo';
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
import { applyCustomerTaxDefaults } from './customerDefaults';
import { allocateDocNumber, docRef, renumberDoc } from './docNumbers';
import { type AppliedPricing, resolveLinePricing } from './pricing';
import { type SalesLineKind, SalesLineTotals, salesLineKind } from './salesLineKinds';

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
  /**
   * Unit price. Omit on item lines to price server-side like invoices (B12: price rules, the
   * customer's price level, customer-specific prices — lib/services/pricing.ts).
   */
  rate?: string | number | null;
  /** Internal callers (conversions) may tag where a carried-over price came from. */
  pricing?: { origin?: string | null } | null;
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
  /**
   * Document number typed by the user (alphanumeric, e.g. "INV-1001"). Blank = the next number
   * (QB: last number used with its trailing digits + 1). See lib/services/docNumbers.ts.
   */
  refNumber?: string | null;
  /** The user confirmed the "this number is already used" warning. */
  allowDuplicateNumber?: boolean | null;
  customerId: string;
  date: Date;
  lines: CreditMemoLineInput[];
  /** Memo-level tax rate (UUID of a taxRates row); if absent no tax is credited back. */
  taxRateId?: string | null;
  memo?: string | null;
  /** wave2 sales (C7): queue for batch printing / emailing. */
  toBePrinted?: boolean;
  toBeEmailed?: boolean;
}

export interface ApplyToInvoiceInput {
  creditMemoId: string;
  invoiceId: string;
  /** Amount to apply (must be <= unapplied and <= invoice.balanceDue). */
  amount: string | number;
  /** wave2 sales (C4): the received payment this credit was applied with (undone with it). */
  paymentId?: string | null;
  date?: Date | null;
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

/** inventory_layers.source_ref of the FIFO layer a credit memo line's restock creates. */
function restockLayerRef(memoId: string, lineId: string): string {
  return `creditmemo-cogs:${memoId}:${lineId}`;
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
      totalValue = totalValue.plus(fifoLayerValue(q, l.unitCost)); // the valuation reports' rule
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

/** Validate a credit memo input and compute every amount/account (read-only). */
async function prepareCreditMemo(ctx: ServiceContext, input: CreateCreditMemoInput) {
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
    pricing: AppliedPricing | null;
    kind: SalesLineKind;
  };

  // B12 advanced pricing: fill omitted item rates (price rules / price level / customer price)
  // and record which rule or level priced each line, exactly as invoices and sales receipts do.
  const pricedLines = await resolveLinePricing(
    ctx,
    { customerId: input.customerId, date: input.date },
    input.lines,
  );

  // Same item-type semantics as invoices (discount / subtotal / sales-tax items).
  const totals = new SalesLineTotals();
  const computedLines: ComputedLine[] = [];

  for (let i = 0; i < pricedLines.length; i++) {
    const l = pricedLines[i];
    const kind = salesLineKind(l.itemId ? itemMap.get(l.itemId)?.type : null, i + 1, 'credit memo');

    // Resolve income account: explicit accountId > item.incomeAccountId > 4000
    // (for a discount line: the discount account, credited back by the memo)
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
    // A/R and A/P are never a line account (QB invariant I11).
    {
      const [lineAcct] = await ctx.db
        .select({ type: accounts.type, subtype: accounts.subtype, name: accounts.name })
        .from(accounts)
        .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, resolvedAccountId)));
      if (lineAcct) assertNotControlLineAccount(lineAcct, `Line ${i + 1}`);
    }

    if (kind === 'subtotal') {
      // Non-posting: the sum of the body lines above it, excluded from every total.
      const sub = totals.takeSubtotal();
      computedLines.push({
        itemId: l.itemId ?? null,
        accountId: resolvedAccountId,
        description: l.description ?? 'Subtotal',
        quantity: '1.0000',
        rate: sub,
        amount: sub,
        taxable: false,
        restock: false,
        lineOrder: i,
        pricing: null,
        kind,
      });
      continue;
    }

    // Quantity and rate are stored at 4 decimals (the column scale); compute the
    // amount from the stored values so a later rebuild (convert, copy) re-prices exactly.
    const qty = Money.of(l.quantity).toDecimalPlaces(4);
    const rate = Money.of(l.rate).toDecimalPlaces(4);
    if (qty.lessThanOrEqualTo(0)) throw validation(`Line ${i + 1}: quantity must be positive.`);
    if (kind !== 'discount' && rate.lessThan(0)) throw validation(`Line ${i + 1}: rate cannot be negative.`);

    const added = totals.addLine(kind, Money.round2(Money.mul(qty, rate)), l.taxable !== false);

    computedLines.push({
      itemId: l.itemId ?? null,
      accountId: resolvedAccountId,
      description: l.description ?? null,
      quantity: qty.toFixed(4),
      rate: rate.toFixed(4),
      amount: toAmountString(added.amount),
      taxable: added.taxable,
      restock: kind === 'income' && l.restock !== false, // default true (returned to stock)
      lineOrder: i,
      pricing: kind === 'income' ? l.pricing : null,
      kind,
    });
  }

  const subtotal = totals.subtotal;
  const grossIncome = totals.grossIncome;
  const taxAmount = totals.taxAmount(taxRateDecimal);
  const total = Money.round2(subtotal.plus(taxAmount));
  const taxPayableId =
    input.taxRateId || totals.salesTaxLines.greaterThan(0) ? await accountIdByCode(ctx, '2200') : null;
  if (total.lessThanOrEqualTo(0)) {
    throw validation('Credit memo total must be greater than zero.');
  }

  return {
    arAccountId,
    defaultIncomeId,
    taxPayableId,
    itemMap,
    computedLines,
    subtotal,
    grossIncome,
    taxAmount,
    total,
  };
}

type PreparedCreditMemo = Awaited<ReturnType<typeof prepareCreditMemo>>;

/**
 * Insert the memo lines and post everything a saved credit memo posts: the A/R credit entry,
 * restock (COGS-reversal) entries and site movements. Shared by create and edit (C1).
 */
async function postCreditMemoDocument(
  tx: ServiceContext,
  memo: { id: string; memoNumber: number; refNumber?: string | null },
  input: CreateCreditMemoInput,
  prep: PreparedCreditMemo,
  /** Edit: what the previous version restocked per item (see restockCostsByItem). */
  priorRestock?: Map<string, PriorRestock>,
) {
  const { arAccountId, taxPayableId, itemMap, computedLines, grossIncome, taxAmount, total } = prep;
  // The number shown on the GL: the typed ref number, else the legacy integer.
  const shownNumber = docRef(memo.refNumber ?? null, memo.memoNumber);
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
        taxable: cl.taxable,
        restock: cl.restock,
        pricing: cl.pricing as Record<string, unknown> | null,
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
  // Discount item lines are the reverse of an invoice's: they CREDIT their discount account,
  // so entryBase = income lines + tax = total + discounts. Subtotal lines post nothing.
  const entryBase = Money.round2(grossIncome.plus(taxAmount));

  const incomeDebits = new Map<string, ReturnType<typeof Money.zero>>();
  const discountCredits = new Map<string, ReturnType<typeof Money.zero>>();
  for (const cl of computedLines) {
    if (cl.kind !== 'income' && cl.kind !== 'discount') continue;
    const map = cl.kind === 'income' ? incomeDebits : discountCredits;
    const prev = map.get(cl.accountId) ?? Money.zero();
    map.set(cl.accountId, prev.plus(Money.abs(Money.of(cl.amount))));
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
      memo: `Credit Memo #${shownNumber} — income reversal`,
    });
  }
  if (taxAmount.greaterThan(0) && taxPayableId) {
    debitSpecs.push({
      accountId: taxPayableId,
      weight: taxAmount,
      memo: `Credit Memo #${shownNumber} — sales tax reversal`,
    });
  }
  const creditSpecs: Array<{
    accountId: string;
    weight: ReturnType<typeof Money.zero>;
    memo: string;
    controlLine?: boolean;
  }> = [{ accountId: arAccountId, weight: total, memo: `Credit Memo #${shownNumber}`, controlLine: true }];
  for (const [acctId, amount] of discountCredits) {
    creditSpecs.push({ accountId: acctId, weight: amount, memo: `Credit Memo #${shownNumber} — discount reversal` });
  }

  const debitAlloc = allocate(entryBase, debitSpecs.map((s) => s.weight));
  const creditAlloc = allocate(entryBase, creditSpecs.map((s) => s.weight));

  const postingLines: Array<{
    accountId: string;
    debit?: string;
    credit?: string;
    memo?: string;
    controlLine?: boolean;
  }> = [];
  debitSpecs.forEach((s, i) => {
    if (debitAlloc[i].greaterThan(0)) {
      postingLines.push({ accountId: s.accountId, debit: toAmountString(debitAlloc[i]), memo: s.memo });
    }
  });
  creditSpecs.forEach((s, i) => {
    if (creditAlloc[i].greaterThan(0)) {
      // The memo's own A/R line is the control line (posting.ts PostingLine.controlLine).
      postingLines.push({
        accountId: s.accountId,
        credit: toAmountString(creditAlloc[i]),
        memo: s.memo,
        ...(s.controlLine ? { controlLine: true } : {}),
      });
    }
  });

  const entry = await postJournalEntry(tx, {
    date: input.date,
    description: `Credit Memo #${shownNumber}`,
    reference: shownNumber,
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
    // Accountant's Copy import: restock at the cost the accountant's file used (null otherwise).
    const accountantCost = takeAccountantCost(line.itemId);
    const currentUnitCost = await restockUnitCost(tx, meta, fifoTracked);
    // Edit: an item the previous version already restocked keeps that version's restock unit
    // cost (the cost the returned units came back at), so editing a memo — or undoing an edit —
    // never re-values its returns at today's average. Same quantity = exactly the same cost.
    const prior = accountantCost ? undefined : priorRestock?.get(line.itemId);
    const priorCost =
      prior && prior.qty.greaterThan(0) && qty.greaterThan(0)
        ? qty.equals(prior.qty)
          ? prior.cost
          : Money.round2(prior.cost.times(qty).dividedBy(prior.qty))
        : null;
    const cost = accountantCost ? Money.round2(accountantCost) : priorCost ?? Money.round2(qty.times(currentUnitCost));
    const unitCost = (accountantCost || priorCost) && qty.greaterThan(0) ? cost.dividedBy(qty) : currentUnitCost;
    if (!fifoTracked) {
      // Average-cost item restocked at a cost other than qty x its stored average (an Accountant's
      // Copy cost, or the purchaseCost fallback when no average exists yet): re-derive its average
      // from the new value so the item stays tied to the GL.
      const [cur] = await tx.db
        .select({
          qty: items.quantityOnHand,
          avg: items.averageCost,
          valueRemainder: items.valueRemainder,
          valueRemainderAvg: items.valueRemainderAvg,
        })
        .from(items)
        .where(and(eq(items.companyId, tx.companyId), eq(items.id, line.itemId)));
      const curQty = Money.of(cur?.qty ?? '0');
      const curAvg = Money.of(cur?.avg ?? '0');
      const avg = cost.equals(Money.round2(qty.times(curAvg))) ? curAvg : averageAfter(curQty, curAvg, curQty.plus(qty), cost);
      await tx.db
        .update(items)
        .set({
          averageCost: avg.toFixed(4),
          // The restock put `cost` on the inventory account; what the book value round2(qty x
          // average) does not show of it stays on record as the value remainder (0061).
          ...valueRemainderAfter(
            { averageCost: cur?.avg ?? null, valueRemainder: cur?.valueRemainder ?? null, valueRemainderAvg: cur?.valueRemainderAvg ?? null },
            curQty,
            curQty.plus(qty),
            avg,
            cost,
          ),
          updatedAt: new Date(),
        })
        .where(and(eq(items.companyId, tx.companyId), eq(items.id, line.itemId)));
    }

    // Reverse COGS only when there is a real cost (postJournalEntry rejects $0 entries).
    if (cost.greaterThan(0)) {
      const inventoryAccountId = meta.assetAccountId ?? (await accountIdByCode(tx, '1300'));
      // Reverse onto the item's own COGS account (the one its sale debited; 5000 by default).
      const [cogsItem] = await tx.db
        .select({ expenseAccountId: items.expenseAccountId })
        .from(items)
        .where(and(eq(items.companyId, tx.companyId), eq(items.id, line.itemId)));
      const cogsAccountId = await cogsAccountForItem(tx, cogsItem ?? {});
      const restockEntry = await postJournalEntry(tx, {
        date: input.date,
        description: `Credit Memo #${shownNumber} — COGS reversal (${meta.name})`,
        reference: line.id,
        sourceRef: `creditmemo-cogs:${memo.id}`,
        lines: [
          {
            accountId: inventoryAccountId,
            debit: toAmountString(cost),
            memo: `Credit Memo #${shownNumber} — restock (${meta.name})`,
          },
          {
            accountId: cogsAccountId,
            credit: toAmountString(cost),
            memo: `Credit Memo #${shownNumber} — COGS reversal (${meta.name})`,
          },
        ],
      });
      restockEntries.push({ entryId: restockEntry.id, lineId: line.id, itemId: line.itemId, cost: toAmountString(cost) });
    }

    // FIFO items: restore stock value as a new layer at the restock cost, tagged with the memo
    // line so a void / edit takes exactly this layer back out (restockLayerRef).
    if (fifoTracked) {
      await tx.db.insert(inventoryLayers).values({
        companyId: tx.companyId,
        itemId: line.itemId,
        date: input.date,
        quantityRemaining: qty.toFixed(4),
        unitCost: unitCost.toFixed(4),
        sourceRef: restockLayerRef(memo.id, line.id),
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
    memo: `Credit Memo #${shownNumber}`,
  });

  return { insertedLines, entry, restockEntries };
}

export async function createCreditMemo(ctx: ServiceContext, input: CreateCreditMemoInput) {
  await assertSalesTaxAllowed(ctx, input);
  input = await applyCustomerTaxDefaults(ctx, input, { defaultRate: true });
  const prep = await prepareCreditMemo(ctx, input);
  const { subtotal, taxAmount, total } = prep;
  return inTransaction(ctx, async (tx) => {
    const { refNumber, number: memoNumber } = await allocateDocNumber(tx, 'credit_memo', input.refNumber, {
      allowDuplicate: input.allowDuplicateNumber === true,
    });
    // 1) Insert credit memo header
    const [memo] = await tx.db
      .insert(creditMemos)
      .values({
        companyId: tx.companyId,
        customerId: input.customerId,
        memoNumber,
        refNumber,
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
        toBePrinted: input.toBePrinted ?? false,
        toBeEmailed: input.toBeEmailed ?? false,
      })
      .returning();

    const { insertedLines, entry, restockEntries } = await postCreditMemoDocument(
      tx,
      memo,
      input,
      prep,
    );

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
/**
 * Date of a credit application, checked against the closing date / closed periods / the
 * Accountant's Copy dividing date. A date the caller gives is used as is. Without one the
 * application takes the later of the memo's and the invoice's dates (when both documents exist,
 * as QuickBooks links them) — so an accountant can apply credits in an Accountant's Copy, where
 * "today" is after the dividing date. When that day cannot be posted (a closed period, or the
 * client's side of an outstanding Accountant's Copy) the application is dated today instead, as
 * it always was before applications carried a checked date.
 */
async function creditApplicationDate(
  ctx: ServiceContext,
  memoDate: Date,
  invoiceDate: Date,
  date: Date | null | undefined,
): Promise<{ applicationDate: Date; periodCheck: PeriodCheck }> {
  if (date) return { applicationDate: date, periodCheck: await assertPeriodOpen(ctx, date) };
  const natural = memoDate > invoiceDate ? memoDate : invoiceDate;
  try {
    return { applicationDate: natural, periodCheck: await assertPeriodOpen(ctx, natural) };
  } catch (err) {
    const locked =
      err instanceof ServiceError &&
      (err.code === 'PERIOD_CLOSED' || (err.details as { accountantCopy?: boolean } | undefined)?.accountantCopy === true);
    if (!locked) throw err;
  }
  const today = new Date();
  return { applicationDate: today, periodCheck: await assertPeriodOpen(ctx, today) };
}

export async function applyToInvoice(ctx: ServiceContext, input: ApplyToInvoiceInput) {
  // Load + validate in the same transaction as the write: two concurrent applies must not both
  // see the full unapplied balance.
  return inTransaction(ctx, (tx) => applyToInvoiceInTx(tx, input));
}

async function applyToInvoiceInTx(ctx: ServiceContext, input: ApplyToInvoiceInput) {
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
  // Accountant's Copy (I1): a credit memo dated after the dividing date belongs to the client.
  await assertAccountantDatesOpen(ctx, [memo.date], 'The credit memo');

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
  if (invoice.status === 'draft') {
    // A pending invoice posted nothing to A/R, so a credit applied to it would relieve nothing.
    throw new ServiceError('VALIDATION', 'This invoice is still a draft. Post it before applying a credit to it.');
  }
  if (invoice.customerId !== memo.customerId) {
    throw new ServiceError(
      'VALIDATION',
      'Credit memo and invoice must belong to the same customer.',
    );
  }
  // Credit memos are recorded in home currency; a foreign-currency invoice is settled through
  // Receive Payments (which converts at the booked rate and posts realized exchange gain/loss).
  // Same rule as vendorCredits.applyToBill on the A/P side.
  // The invoice Currency field is free text: blank or the home code (any case) means home currency,
  // the same normalisation Receive Payments uses — only a genuinely foreign code is refused.
  const invoiceCurrency = (invoice.currency ?? '').trim().toUpperCase();
  if (invoiceCurrency) {
    const home = ((await getHomeCurrencyCode(ctx)) ?? '').trim().toUpperCase();
    if (invoiceCurrency !== home) {
      throw validation(
        `This invoice is in ${invoiceCurrency}. Home-currency credits can't be applied to it — settle it with Receive Payments instead.`,
      );
    }
  }

  const balanceDue = Money.of(invoice.balanceDue);
  if (amount.greaterThan(balanceDue)) {
    throw validation(
      `Apply amount ${toAmountString(amount)} exceeds invoice balance due ${toAmountString(balanceDue)}.`,
    );
  }

  // The application is dated: one back-dated into a closed period would change its A/R aging.
  const { applicationDate, periodCheck } = await creditApplicationDate(ctx, memo.date, invoice.date, input.date);

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

    // wave2 sales: remember the application so it can be listed and undone.
    const [application] = await tx.db
      .insert(creditApplications)
      .values({
        companyId: tx.companyId,
        creditMemoId: memo.id,
        invoiceId: invoice.id,
        paymentId: input.paymentId ?? null,
        amount: toAmountString(amount),
        date: applicationDate,
      })
      .returning();
    await recordClosingDateException(tx, periodCheck, {
      entryId: memo.id,
      operation: 'apply',
      transactionDate: applicationDate,
      sourceRef: `credit_application:${application.id}`,
    });

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
        paymentId: input.paymentId ?? null,
        creditApplicationId: application.id,
      },
    });

    return { creditMemo: updatedMemo, invoice: updatedInvoice, application };
  });
}

// ---------------------------------------------------------------------------
// Credit applications (wave2 sales, C4): list / undo
// ---------------------------------------------------------------------------

export async function listCreditApplications(
  ctx: ServiceContext,
  opts: { creditMemoId?: string; invoiceId?: string; paymentId?: string },
) {
  const conds = [eq(creditApplications.companyId, ctx.companyId)];
  if (opts.creditMemoId) conds.push(eq(creditApplications.creditMemoId, opts.creditMemoId));
  if (opts.invoiceId) conds.push(eq(creditApplications.invoiceId, opts.invoiceId));
  if (opts.paymentId) conds.push(eq(creditApplications.paymentId, opts.paymentId));
  return ctx.db
    .select({
      id: creditApplications.id,
      creditMemoId: creditApplications.creditMemoId,
      invoiceId: creditApplications.invoiceId,
      paymentId: creditApplications.paymentId,
      amount: creditApplications.amount,
      date: creditApplications.date,
      memoNumber: creditMemos.memoNumber,
      memoRef: creditMemos.refNumber,
      invoiceNumber: invoices.invoiceNumber,
      invoiceRef: invoices.refNumber,
    })
    .from(creditApplications)
    .innerJoin(creditMemos, eq(creditMemos.id, creditApplications.creditMemoId))
    .innerJoin(invoices, eq(invoices.id, creditApplications.invoiceId))
    .where(and(...conds))
    .orderBy(asc(creditApplications.createdAt));
}

/**
 * Undo one credit application: the invoice's balance comes back and the credit is available
 * again. No GL entry (applying posted none either — the memo credited A/R when it was saved).
 */
export async function unapplyCreditApplication(ctx: ServiceContext, applicationId: string) {
  return inTransaction(ctx, async (tx) => {
    // Loaded inside the transaction: a second concurrent undo of the same application finds it gone.
    const [app] = await tx.db
      .select()
      .from(creditApplications)
      .where(and(eq(creditApplications.companyId, tx.companyId), eq(creditApplications.id, applicationId)));
    if (!app) throw notFound('Credit application');
    // The application is dated: removing one from a closed period changes that period's A/R aging.
    const periodCheck = await assertPeriodOpen(tx, app.date, { movable: false });
    await recordClosingDateException(tx, periodCheck, {
      entryId: app.creditMemoId,
      operation: 'unapply',
      transactionDate: app.date,
      sourceRef: `credit_application:${app.id}`,
    });

    const [memo] = await tx.db
      .select()
      .from(creditMemos)
      .where(and(eq(creditMemos.companyId, tx.companyId), eq(creditMemos.id, app.creditMemoId)));
    if (!memo) throw notFound('Credit memo');
    await assertAccountantDatesOpen(tx, [memo.date], 'The credit memo');
    const amount = Money.of(app.amount);

    await markPaidAmount(tx, app.invoiceId, toAmountString(amount.negated()));
    const newUnapplied = Money.round2(Money.of(memo.unapplied).plus(amount));
    const [updatedMemo] = await tx.db
      .update(creditMemos)
      .set({ unapplied: toAmountString(newUnapplied), status: 'open' })
      .where(eq(creditMemos.id, memo.id))
      .returning();
    await tx.db.delete(creditApplications).where(eq(creditApplications.id, app.id));

    await writeAudit(tx, {
      action: 'update',
      entityType: 'credit_memo',
      entityId: memo.id,
      oldValues: { unapplied: memo.unapplied, appliedToInvoice: app.invoiceId, amountApplied: app.amount },
      newValues: { action: 'unapply', unapplied: toAmountString(newUnapplied), invoiceId: app.invoiceId },
    });
    return updatedMemo;
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
  // Load + validate in the same transaction as the write (no double refund of one credit).
  return inTransaction(ctx, (tx) => refundCreditMemoInTx(tx, input));
}

async function refundCreditMemoInTx(ctx: ServiceContext, input: RefundCreditMemoInput) {
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
  // Bank accounts, Undeposited Funds or another cash-like current asset (lib/accountTypes.ts).
  if (!isDepositTargetAccount(bankAcct)) {
    throw validation('Refunds must be paid from a bank/cash account.');
  }

  const arAccountId = await accountIdByCode(ctx, '1200');
  const refundDate = input.date ?? new Date();
  // The credit only exists from the memo's date: a refund dated earlier would debit A/R on days
  // when the customer held no credit.
  const day = (d: Date) => new Date(d).toISOString().slice(0, 10);
  if (day(refundDate) < day(memo.date)) {
    throw validation(
      `The refund date (${day(refundDate)}) is before the credit memo date (${day(memo.date)}). Date the refund on or after the credit memo.`,
    );
  }

  return inTransaction(ctx, async (tx) => {
    // 1. Post the refund check.
    const entry = await postJournalEntry(tx, {
      date: refundDate,
      description: input.memo ?? `Refund — Credit Memo #${docRef(memo.refNumber, memo.memoNumber)}`,
      reference: docRef(memo.refNumber, memo.memoNumber),
      sourceRef: `refund:${input.creditMemoId}`,
      lines: [
        {
          accountId: arAccountId,
          debit: toAmountString(amount),
          memo: `Credit Memo #${docRef(memo.refNumber, memo.memoNumber)} refunded`,
          controlLine: true,
        },
        {
          accountId: input.bankAccountId,
          credit: toAmountString(amount),
          memo: `Refund check — Credit Memo #${docRef(memo.refNumber, memo.memoNumber)}`,
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

/** What a saved credit memo restocked of one item: quantity and the cost it posted. */
interface PriorRestock {
  qty: ReturnType<typeof Money.zero>;
  cost: ReturnType<typeof Money.zero>;
}

/**
 * The memo's posted restock (COGS-reversal) entries per item: the quantity of the restocked line
 * each entry belongs to (reference = memo line id) and the entry's cost (its inventory debit).
 */
async function restockCostsByItem(
  tx: ServiceContext,
  memoId: string,
  lines: Array<typeof creditMemoLines.$inferSelect>,
): Promise<Map<string, PriorRestock>> {
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const out = new Map<string, PriorRestock>();
  const entries = await tx.db
    .select({ id: journalEntries.id, reference: journalEntries.reference })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.companyId, tx.companyId),
        eq(journalEntries.sourceRef, `creditmemo-cogs:${memoId}`),
        eq(journalEntries.status, 'posted'),
      ),
    );
  for (const e of entries) {
    const line = e.reference ? lineById.get(e.reference) : undefined;
    if (!line?.itemId) continue;
    const debits = await tx.db
      .select({ debit: journalEntryLines.debit })
      .from(journalEntryLines)
      .where(eq(journalEntryLines.journalEntryId, e.id));
    const cost = debits.reduce((s, l) => s.plus(Money.of(l.debit)), Money.zero());
    const prev = out.get(line.itemId) ?? { qty: Money.zero(), cost: Money.zero() };
    out.set(line.itemId, { qty: prev.qty.plus(Money.of(line.quantity)), cost: prev.cost.plus(cost) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// voidCreditMemo
// ---------------------------------------------------------------------------

/**
 * Reverse everything a saved credit memo posted: every restock (COGS-reversal) entry with the
 * restocked quantity pulled back out of stock/sites, then the main A/R entry. Used by void and
 * by edit (C1, before re-posting). Refuses when restocked units have since been sold.
 */
async function reverseCreditMemoPostings(
  tx: ServiceContext,
  memo: { id: string; postedEntryId: string | null },
) {
  const lines = await tx.db
    .select()
    .from(creditMemoLines)
    .where(eq(creditMemoLines.creditMemoId, memo.id));
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
        eq(journalEntries.sourceRef, `creditmemo-cogs:${memo.id}`),
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

    const fifoTracked = await isFifoTracked(tx, line.itemId);
    // The layer this restock created (tagged with the memo line): exactly what it added back,
    // or a CONFLICT when those units were sold / revalued since (fifo.ts takeFromDocumentLayers).
    const own = fifoTracked
      ? await takeFromDocumentLayers(tx, {
          itemId: line.itemId,
          itemName: (await tx.db.select({ name: items.name }).from(items).where(eq(items.id, line.itemId)))[0]?.name ?? 'item',
          sourceRefs: [restockLayerRef(memo.id, line.id)],
          qty,
          expectedValue: cost,
          action: 'void this credit memo (or change its restocked lines)',
        })
      : null;
    if (fifoTracked && !own) {
      // Older data (restock layers not tagged): deplete layers, preferring the layer the restock
      // created (matching unit cost), then oldest-first for any remainder.
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

    // Average cost: the GL loses exactly the restock cost, which differs from qty x today's
    // average once the average has moved — back that cost out of the average.
    let newAvgCost: string | undefined;
    let remainderAfter: { valueRemainder: string; valueRemainderAvg: string } | undefined;
    if (!(await isFifoTracked(tx, line.itemId))) {
      const [cur] = await tx.db
        .select({
          qty: items.quantityOnHand,
          avg: items.averageCost,
          valueRemainder: items.valueRemainder,
          valueRemainderAvg: items.valueRemainderAvg,
        })
        .from(items)
        .where(and(eq(items.companyId, tx.companyId), eq(items.id, line.itemId)));
      const curQty = Money.of(cur?.qty ?? '0');
      const curAvg = Money.of(cur?.avg ?? '0');
      const newQty = curQty.minus(qty);
      const remainingValue = curQty.times(curAvg).minus(cost);
      // Refuse rather than clamp the average to 0 when the stock left is worth less than the
      // restock cost the void takes off the GL (written down / sold at a lower average since).
      if (remainingValue.lessThan(layerRoundingTolerance(curQty).negated())) {
        throw new ServiceError(
          'CONFLICT',
          `Cannot void this credit memo (or change its restocked lines): the stock on hand is valued at ${toAmountString(Money.round2(curQty.times(curAvg)))}, less than the ${toAmountString(cost)} the restock added (its cost was written down or the units sold since). Reverse the value adjustment or those sales first.`,
        );
      }
      if (newQty.greaterThan(0)) {
        newAvgCost = (remainingValue.isNegative() ? Money.zero() : remainingValue.dividedBy(newQty)).toFixed(4);
      }
      // The voided restock took `cost` off the inventory account: keep the value remainder (0061)
      // equal to what the GL carries beyond the new book value.
      remainderAfter = valueRemainderAfter(
        { averageCost: cur?.avg ?? null, valueRemainder: cur?.valueRemainder ?? null, valueRemainderAvg: cur?.valueRemainderAvg ?? null },
        curQty,
        newQty,
        Money.of(newAvgCost ?? curAvg),
        cost.negated(),
      );
    }

    // Both costing methods: take the quantity back off hand.
    await tx.db
      .update(items)
      .set({
        quantityOnHand: sql`COALESCE(${items.quantityOnHand}, 0) - ${qty.toFixed(4)}`,
        ...(newAvgCost !== undefined ? { averageCost: newAvgCost } : {}),
        ...(remainderAfter ?? {}),
        updatedAt: new Date(),
      })
      .where(and(eq(items.companyId, tx.companyId), eq(items.id, line.itemId)));
  }

  // Pull the same units back out of the site/bin they were restocked to.
  await reverseDocumentInventory(tx, 'credit_memo', memo.id, { lineOrders: reversedLineOrders });

  // Reverse the main credit memo entry.
  if (memo.postedEntryId) {
    await voidJournalEntry(tx, memo.postedEntryId);
  }
}

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
  // Load + validate in the same transaction as the void: a concurrent refund/apply cannot slip
  // in between the "nothing used" check and the void.
  return inTransaction(ctx, (tx) => voidCreditMemoInTx(tx, id));
}

async function voidCreditMemoInTx(ctx: ServiceContext, id: string) {
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
    await reverseCreditMemoPostings(tx, memo);

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

// ---------------------------------------------------------------------------
// updateCreditMemo (wave2 sales, C1 — edit a saved credit memo)
// ---------------------------------------------------------------------------

/**
 * Earliest day (YYYY-MM-DD) the memo's credit was used: a posted refund or a recorded
 * application. Computed as a day string in SQL so no driver time-zone parsing is involved.
 */
async function firstCreditUseDay(ctx: ServiceContext, memoId: string): Promise<string | null> {
  const [refund] = await ctx.db
    .select({ d: sql<string | null>`to_char(MIN(${journalEntries.date}), 'YYYY-MM-DD')` })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.sourceRef, `refund:${memoId}`),
        eq(journalEntries.status, 'posted'),
      ),
    );
  const [app] = await ctx.db
    .select({ d: sql<string | null>`to_char(MIN(${creditApplications.date}), 'YYYY-MM-DD')` })
    .from(creditApplications)
    .where(and(eq(creditApplications.companyId, ctx.companyId), eq(creditApplications.creditMemoId, memoId)));
  const days = [refund?.d, app?.d].filter((v): v is string => !!v).sort();
  return days[0] ?? null;
}

/**
 * Edit a saved credit memo in place (QB "edit any saved transaction").
 *
 * Sanctioned void/repost pattern, all inside ONE transaction: reverse every posting of the
 * old version (restock entries + stock, then the A/R entry — the closing-date check runs on the
 * old date), replace the lines, re-post from the new lines (closing-date check on the new date),
 * and audit old + new values. memoNumber and createdAt are preserved.
 *
 * Credit already used (applied to invoices or refunded) stays used, so the edit must keep it
 * valid: same customer, the new total cannot drop below what has been used, and the memo cannot be
 * dated after the first refund / application of it.
 */
export async function updateCreditMemo(
  ctx: ServiceContext,
  id: string,
  input: CreateCreditMemoInput,
) {
  input = await applyCustomerTaxDefaults(ctx, input);
  const [existing] = await ctx.db
    .select()
    .from(creditMemos)
    .where(and(eq(creditMemos.companyId, ctx.companyId), eq(creditMemos.id, id)));
  if (!existing) throw notFound('Credit memo');
  if (existing.status === 'void') throw new ServiceError('CONFLICT', 'Cannot edit a voided credit memo.');
  await assertSalesTaxAllowed(ctx, input, [existing.taxRateId]);

  const prep = await prepareCreditMemo(ctx, input);

  return inTransaction(ctx, async (tx) => {
    const [memo] = await tx.db
      .select()
      .from(creditMemos)
      .where(and(eq(creditMemos.companyId, tx.companyId), eq(creditMemos.id, id)));
    if (!memo || memo.status === 'void') {
      throw new ServiceError('CONFLICT', 'Cannot edit a voided credit memo.');
    }
    const used = Money.round2(Money.of(memo.total).minus(Money.of(memo.unapplied)));
    if (used.greaterThan(0)) {
      if (input.customerId !== memo.customerId) {
        throw new ServiceError(
          'CONFLICT',
          'Part of this credit has already been used, so its customer cannot be changed. Unapply the credit first.',
        );
      }
      if (prep.total.lessThan(used)) {
        throw new ServiceError(
          'CONFLICT',
          `${toAmountString(used)} of this credit has already been applied or refunded, so the new total (${toAmountString(prep.total)}) cannot be less than that. Unapply some of the credit first.`,
        );
      }
      // The credit must exist on the day it was first used (same rule as refundCreditMemo):
      // re-dating the memo after a refund / application would leave A/R debited on days when the
      // customer held no credit.
      const firstUse = await firstCreditUseDay(tx, id);
      const newDay = new Date(input.date).toISOString().slice(0, 10);
      if (firstUse && newDay > firstUse) {
        throw validation(
          `This credit was already used on ${firstUse}, so the credit memo cannot be dated after that (${newDay}). Date it on or before ${firstUse}, or unapply the credit first.`,
        );
      }
    }

    const oldLines = await tx.db
      .select()
      .from(creditMemoLines)
      .where(eq(creditMemoLines.creditMemoId, id))
      .orderBy(asc(creditMemoLines.lineOrder));

    const renum = await renumberDoc(
      tx, 'credit_memo', id, { refNumber: memo.refNumber, number: memo.memoNumber },
      input.refNumber, { allowDuplicate: input.allowDuplicateNumber === true },
    );

    // The old version's restock per item (quantity + cost): returned units keep the cost they
    // came back at, so an edit (or an undo of one) does not re-value them at today's average.
    const priorRestock = await restockCostsByItem(tx, id, oldLines);

    // 1) Reverse the old version's postings (restock + A/R entry).
    await reverseCreditMemoPostings(tx, memo);

    // 2) Replace lines and re-post.
    await tx.db.delete(creditMemoLines).where(eq(creditMemoLines.creditMemoId, id));
    const { insertedLines, entry, restockEntries } = await postCreditMemoDocument(
      tx,
      {
        id,
        memoNumber: renum?.number ?? memo.memoNumber,
        refNumber: renum?.refNumber ?? memo.refNumber,
      },
      input,
      prep,
      priorRestock,
    );

    const newUnapplied = Money.round2(prep.total.minus(used));
    const [updated] = await tx.db
      .update(creditMemos)
      .set({
        customerId: input.customerId,
        date: input.date,
        subtotal: toAmountString(prep.subtotal),
        taxAmount: toAmountString(prep.taxAmount),
        total: toAmountString(prep.total),
        unapplied: toAmountString(newUnapplied),
        status: newUnapplied.isZero() ? 'paid' : 'open',
        memo: input.memo ?? null,
        taxRateId: input.taxRateId ?? null,
        ...(renum ? { refNumber: renum.refNumber, memoNumber: renum.number } : {}),
        toBePrinted: input.toBePrinted ?? memo.toBePrinted,
        toBeEmailed: input.toBeEmailed ?? memo.toBeEmailed,
        postedEntryId: entry.id,
      })
      .where(eq(creditMemos.id, id))
      .returning();

    await writeAudit(tx, {
      action: 'update',
      entityType: 'credit_memo',
      entityId: id,
      oldValues: {
        customerId: memo.customerId,
        date: memo.date,
        refNumber: memo.refNumber,
        subtotal: memo.subtotal,
        taxAmount: memo.taxAmount,
        total: memo.total,
        unapplied: memo.unapplied,
        postedEntryId: memo.postedEntryId,
        lines: oldLines.map((l) => ({ itemId: l.itemId, description: l.description, quantity: l.quantity, rate: l.rate, amount: l.amount })),
      },
      newValues: {
        customerId: input.customerId,
        date: input.date,
        refNumber: renum?.refNumber ?? memo.refNumber,
        duplicateNumber: renum?.duplicate || undefined,
        subtotal: toAmountString(prep.subtotal),
        taxAmount: toAmountString(prep.taxAmount),
        total: toAmountString(prep.total),
        unapplied: toAmountString(newUnapplied),
        postedEntryId: entry.id,
        restockEntries,
        lines: prep.computedLines.map((l) => ({ itemId: l.itemId, description: l.description, quantity: l.quantity, rate: l.rate, amount: l.amount })),
      },
    });

    return { ...updated, lines: insertedLines };
  });
}
