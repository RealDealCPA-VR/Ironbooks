/**
 * Sales Receipts service — point-of-sale sales that are paid in full immediately.
 *
 * Unlike an invoice (which debits A/R and waits for a payment), a sales receipt
 * records the income AND the money received in a single document. Every saved
 * receipt posts one balanced journal entry via `postJournalEntry`:
 *
 *   Dr  <deposit account>             total       (bank, or 1050 Undeposited Funds)
 *   Cr  <income account per line>     line.amount
 *   Cr  2200 Sales Tax Payable        taxAmount   (0 if no tax)
 *
 * Because total = subtotal + taxAmount the entry always balances; penny
 * allocation (money.allocate) is used on both sides so rounding can never
 * produce an unbalanced entry.
 *
 * Inventory lines ALSO relieve stock and post COGS — exactly like a QB sales
 * receipt. FIFO-tracked items (those with inventoryLayers rows) go through
 * `consumeStock` (fifo.ts); average-cost items go through `recordCOGS`
 * (inventory.ts). Each COGS entry is re-stamped with
 * sourceRef "salesreceipt:<id>" and reference = the receipt line id so that
 * voiding can find the entries, reverse the GL, and restore the stock.
 *
 * The default deposit account is 1050 Undeposited Funds so counter sales sit
 * with received payments until the bookkeeper makes a bank deposit.
 */
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { Money, allocate, toAmountString } from '@/lib/money';
import {
  accounts,
  customers,
  depositLines,
  deposits,
  inventoryLayers,
  items,
  journalEntries,
  journalEntryLines,
  salesReceiptLines,
  salesReceipts,
  taxRates,
} from '@/lib/db/schema';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { postJournalEntry, voidJournalEntry } from './posting';
import { recordCOGS } from './inventory';
import { consumeStock } from './fifo';
import {
  type InventoryLineDetail,
  attachInventoryDetails,
  postDocumentInventory,
  reverseDocumentInventory,
} from './inventorySites';
import { type AppliedPricing, resolveLinePricing } from './pricing';
import { shippingColumns } from './invoices';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SalesReceiptMethod =
  | 'cash'
  | 'check'
  | 'credit_card'
  | 'ach'
  | 'bank_transfer'
  | 'other';

const VALID_METHODS = new Set<SalesReceiptMethod>([
  'cash',
  'check',
  'credit_card',
  'ach',
  'bank_transfer',
  'other',
]);

export interface SalesReceiptLineInput extends InventoryLineDetail {
  /** Optional product/service item; supplies incomeAccountId as fallback and triggers COGS for inventory items. */
  itemId?: string | null;
  /** Direct income account override; takes priority over item.incomeAccountId. */
  accountId?: string | null;
  description?: string | null;
  quantity: string | number;
  /** Unit price; omit on item lines to price server-side (lib/services/pricing.ts). */
  rate?: string | number | null;
  /** Whether this line participates in tax calculation. Defaults true. */
  taxable?: boolean;
  /** Per-line tax rate override (UUID of a taxRates row). */
  taxRateId?: string | null;
}

export interface CreateSalesReceiptInput {
  /** Optional — walk-in / counter sales have no customer. */
  customerId?: string | null;
  date: Date;
  lines: SalesReceiptLineInput[];
  /** Receipt-level tax rate (UUID of a taxRates row); if absent no tax is charged. */
  taxRateId?: string | null;
  /** Where the money lands. Defaults to 1050 Undeposited Funds. */
  depositAccountId?: string | null;
  /** Payment method. Defaults to 'cash'. */
  method?: SalesReceiptMethod | null;
  /** Free-form reference (check #, card auth, etc.). */
  reference?: string | null;
  memo?: string | null;
  classId?: string | null;
  // wave2 sales: shipping (B6) + send queues (C7)
  shipDate?: Date | null;
  shipVia?: string | null;
  fob?: string | null;
  trackingNumber?: string | null;
  shipTo?: Record<string, string> | null;
  poNumber?: string | null;
  toBePrinted?: boolean;
  toBeEmailed?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Look up an account id by code, scoped to the company. Throws NOT_FOUND. */
async function accountIdByCode(ctx: ServiceContext, code: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
  if (!row) throw notFound(`Account with code ${code}`);
  return row.id;
}

/** Look up an account by code, creating it if missing (older companies may lack 1050). */
async function getOrCreateAccountByCode(
  ctx: ServiceContext,
  code: string,
  def: { name: string; type: string; subtype: string },
): Promise<string> {
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
  if (row) return row.id;
  const [created] = await ctx.db
    .insert(accounts)
    .values({
      companyId: ctx.companyId,
      code,
      name: def.name,
      type: def.type as never,
      subtype: def.subtype as never,
    })
    .returning();
  return created.id;
}

/** Return the next receipt number for the company (max + 1, 1 if none). */
async function nextReceiptNumber(ctx: ServiceContext): Promise<number> {
  const [row] = await ctx.db
    .select({ max: sql<number>`COALESCE(MAX(${salesReceipts.receiptNumber}), 0)` })
    .from(salesReceipts)
    .where(eq(salesReceipts.companyId, ctx.companyId));
  return (row?.max ?? 0) + 1;
}

/**
 * Is this item FIFO-tracked? Mirrors the detection used by inventory.ts
 * (`assertNotFifoTracked`): any inventoryLayers row means fifo.ts owns its costing.
 * Kept local because inventory.ts only exposes the throwing variant.
 */
async function isFifoTracked(ctx: ServiceContext, itemId: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ cnt: sql<number>`count(*)` })
    .from(inventoryLayers)
    .where(and(eq(inventoryLayers.companyId, ctx.companyId), eq(inventoryLayers.itemId, itemId)));
  return Number(row?.cnt ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// createSalesReceipt
// ---------------------------------------------------------------------------

/** Validate a sales receipt input and compute every amount/account (read-only; create + edit). */
async function prepareSalesReceipt(ctx: ServiceContext, input: CreateSalesReceiptInput) {
  // --- Validate inputs ---
  if (!input.lines || input.lines.length === 0) {
    throw validation('A sales receipt must have at least one line.');
  }

  const method: SalesReceiptMethod = input.method ?? 'cash';
  if (!VALID_METHODS.has(method)) {
    throw validation(`Invalid payment method "${method}".`);
  }

  // Customer is optional (walk-in sale); when given it must belong to the company.
  if (input.customerId) {
    const [customer] = await ctx.db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, input.customerId)));
    if (!customer) throw notFound('Customer');
  }

  // Load the receipt-level tax rate if provided.
  let taxRateDecimal = Money.zero();
  if (input.taxRateId) {
    const [taxRow] = await ctx.db
      .select({ rate: taxRates.rate })
      .from(taxRates)
      .where(and(eq(taxRates.companyId, ctx.companyId), eq(taxRates.id, input.taxRateId)));
    if (!taxRow) throw notFound('Tax rate');
    taxRateDecimal = Money.of(taxRow.rate);
  }

  // Resolve the deposit account: explicit (must be an asset of this company),
  // otherwise default to 1050 Undeposited Funds (created if missing).
  let depositAccountId: string;
  if (input.depositAccountId) {
    const [acct] = await ctx.db
      .select({ id: accounts.id, type: accounts.type, subtype: accounts.subtype })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, input.depositAccountId)));
    if (!acct) throw notFound('Deposit account');
    // Same rule as Receive Payments: A/R and Inventory are subledger control accounts,
    // so money can never be "deposited" into them (A/R would stop matching open invoices).
    if (acct.type !== 'asset' || acct.subtype === 'accounts_receivable' || acct.subtype === 'inventory') {
      throw validation('Deposit account must be a bank account or Undeposited Funds.');
    }
    depositAccountId = acct.id;
  } else {
    depositAccountId = await getOrCreateAccountByCode(ctx, '1050', {
      name: 'Undeposited Funds',
      type: 'asset',
      subtype: 'checking',
    });
  }

  // Fallback income + sales-tax payable accounts (from COA defaults), mirroring invoices.
  const defaultIncomeId = await accountIdByCode(ctx, '4000'); // Sales Income fallback
  const taxPayableId = await accountIdByCode(ctx, '2200'); // Sales Tax Payable

  // Pre-load referenced items (income account fallback + inventory typing for COGS).
  const itemIds = [...new Set(input.lines.filter((l) => l.itemId).map((l) => l.itemId as string))];
  const itemMap = new Map<string, { incomeAccountId: string | null; type: string; name: string }>();
  if (itemIds.length > 0) {
    const itemRows = await ctx.db
      .select({ id: items.id, incomeAccountId: items.incomeAccountId, type: items.type, name: items.name })
      .from(items)
      .where(and(eq(items.companyId, ctx.companyId), inArray(items.id, itemIds)));
    for (const r of itemRows) itemMap.set(r.id, r);
    for (const id of itemIds) {
      if (!itemMap.has(id)) throw notFound(`Item ${id}`);
    }
  }

  // Pre-load any per-line tax-rate overrides.
  const lineTaxRateIds = [...new Set(input.lines.map((l) => l.taxRateId).filter(Boolean) as string[])];
  const lineTaxRateMap = new Map<string, ReturnType<typeof Money.zero>>();
  if (lineTaxRateIds.length > 0) {
    const rateRows = await ctx.db
      .select({ id: taxRates.id, rate: taxRates.rate })
      .from(taxRates)
      .where(and(eq(taxRates.companyId, ctx.companyId), inArray(taxRates.id, lineTaxRateIds)));
    for (const r of rateRows) lineTaxRateMap.set(r.id, Money.of(r.rate));
    for (const id of lineTaxRateIds) {
      if (!lineTaxRateMap.has(id)) throw notFound(`Tax rate ${id}`);
    }
  }
  let perLineTax = Money.zero();

  // --- Compute per-line amounts and subtotal (same math as createInvoice) ---
  type ComputedLine = {
    itemId: string | null;
    accountId: string; // resolved income account id
    description: string | null;
    quantity: string;
    rate: string;
    amount: string; // quantity * rate, 2dp
    taxable: boolean;
    taxRateId: string | null;
    lineOrder: number;
    pricing: AppliedPricing | null;
  };

  // Advanced pricing: fill omitted item rates and record rule/level provenance.
  const pricedLines = await resolveLinePricing(
    ctx,
    { customerId: input.customerId ?? null, date: input.date, classId: input.classId ?? null },
    input.lines,
  );

  let subtotal = Money.zero();
  let taxableSubtotal = Money.zero();
  const computedLines: ComputedLine[] = [];

  for (let i = 0; i < pricedLines.length; i++) {
    const l = pricedLines[i];
    // Quantity and rate are stored at 4 decimals (the column scale); compute the
    // amount from the stored values so a later rebuild (convert, copy) re-prices exactly.
    const qty = Money.of(l.quantity).toDecimalPlaces(4);
    const rate = Money.of(l.rate).toDecimalPlaces(4);
    if (qty.lessThanOrEqualTo(0)) throw validation(`Line ${i + 1}: quantity must be positive.`);
    if (rate.lessThan(0)) throw validation(`Line ${i + 1}: rate cannot be negative.`);

    const amount = Money.round2(Money.mul(qty, rate));

    // Resolve income account: explicit accountId > item.incomeAccountId > 4000.
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
    if (taxable) {
      if (l.taxRateId) {
        perLineTax = perLineTax.plus(Money.round2(Money.mul(amount, lineTaxRateMap.get(l.taxRateId)!)));
      } else {
        taxableSubtotal = taxableSubtotal.plus(amount);
      }
    }

    computedLines.push({
      itemId: l.itemId ?? null,
      accountId: resolvedAccountId,
      description: l.description ?? null,
      quantity: qty.toFixed(4),
      rate: rate.toFixed(4),
      amount: toAmountString(amount),
      taxable,
      taxRateId: l.taxRateId ?? null,
      lineOrder: i,
      pricing: l.pricing,
    });
  }

  const taxAmount = Money.round2(Money.mul(taxableSubtotal, taxRateDecimal)).plus(perLineTax);
  const total = Money.round2(subtotal.plus(taxAmount));

  if (total.lessThanOrEqualTo(0)) {
    throw validation('Sales receipt total must be greater than zero.');
  }

  return { method, depositAccountId, taxPayableId, itemMap, computedLines, subtotal, taxAmount, total };
}

type PreparedSalesReceipt = Awaited<ReturnType<typeof prepareSalesReceipt>>;

/**
 * Insert the receipt lines and post everything a saved sales receipt posts: the income/payment
 * entry, COGS entries (stock relief) and site movements. Shared by create and edit (C1).
 */
async function postSalesReceiptDocument(
  tx: ServiceContext,
  receipt: { id: string; receiptNumber: number },
  input: CreateSalesReceiptInput,
  prep: PreparedSalesReceipt,
) {
  const { depositAccountId, taxPayableId, itemMap, computedLines, subtotal, taxAmount, total } = prep;
  const receiptNumber = receipt.receiptNumber;
  // 2) Insert receipt lines (returning ids so COGS entries can reference them).
  const insertedLines = await tx.db
    .insert(salesReceiptLines)
    .values(
      computedLines.map((cl) => ({
        salesReceiptId: receipt.id,
        itemId: cl.itemId,
        accountId: cl.accountId,
        description: cl.description,
        quantity: cl.quantity,
        rate: cl.rate,
        amount: cl.amount,
        taxable: cl.taxable,
        classId: input.classId ?? null,
        taxRateId: cl.taxRateId,
        lineOrder: cl.lineOrder,
        pricing: cl.pricing as Record<string, unknown> | null,
      })),
    )
    .returning();
  insertedLines.sort((a, b) => a.lineOrder - b.lineOrder);

  // 3) Post the income/payment entry.
  //
  //   Dr <deposit account>   total
  //   Cr <income accounts>   subtotal (per account)
  //   Cr 2200 Tax Payable    taxAmount
  //
  // entryBase = subtotal + taxAmount = total; both sides are penny-allocated
  // against the same anchor so the entry is always balanced.
  const entryBase = Money.round2(subtotal.plus(taxAmount));

  const incomeCredits = new Map<string, ReturnType<typeof Money.zero>>();
  for (const cl of computedLines) {
    const prev = incomeCredits.get(cl.accountId) ?? Money.zero();
    incomeCredits.set(cl.accountId, prev.plus(Money.of(cl.amount)));
  }

  const debitSpecs: Array<{ accountId: string; weight: ReturnType<typeof Money.zero>; memo: string }> = [
    { accountId: depositAccountId, weight: total, memo: `Sales Receipt #${receiptNumber}` },
  ];
  const creditSpecs: Array<{ accountId: string; weight: ReturnType<typeof Money.zero>; memo: string }> = [];
  for (const [acctId, amount] of incomeCredits) {
    creditSpecs.push({ accountId: acctId, weight: amount, memo: `Sales Receipt #${receiptNumber} — income` });
  }
  if (taxAmount.greaterThan(0)) {
    creditSpecs.push({
      accountId: taxPayableId,
      weight: taxAmount,
      memo: `Sales Receipt #${receiptNumber} — sales tax`,
    });
  }

  const debitAlloc = allocate(entryBase, debitSpecs.map((s) => s.weight));
  const creditAlloc = allocate(entryBase, creditSpecs.map((s) => s.weight));

  const postingLines: Array<{ accountId: string; debit?: string; credit?: string; memo?: string }> = [];
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
    description: `Sales Receipt #${receiptNumber}`,
    reference: String(receiptNumber),
    sourceRef: `salesreceipt:${receipt.id}`,
    lines: postingLines,
  });

  // 4) Relieve inventory + post COGS for inventory-item lines.
  //
  // FIFO-tracked items go through consumeStock (exact layer costing); the rest
  // through recordCOGS (weighted average). Both already validate stock levels
  // and keep item.quantityOnHand in sync. Each COGS entry is then re-stamped
  // with sourceRef "salesreceipt:<id>" and reference = the receipt line id so
  // voidSalesReceipt can find it, reverse the GL, and restore the stock.
  const cogsEntries: Array<{ entryId: string; lineId: string; itemId: string; cogs: string }> = [];
  for (const line of insertedLines) {
    if (!line.itemId) continue;
    const meta = itemMap.get(line.itemId);
    if (!meta || meta.type !== 'inventory') continue;

    const memo = `Sales Receipt #${receiptNumber} — COGS (${meta.name})`;
    let entryId: string;
    let cogs: string;
    if (await isFifoTracked(tx, line.itemId)) {
      const res = await consumeStock(tx, {
        itemId: line.itemId,
        quantity: line.quantity,
        date: input.date,
        memo,
      });
      entryId = res.entryId;
      cogs = res.totalCOGS;
    } else {
      const res = await recordCOGS(tx, {
        itemId: line.itemId,
        quantity: line.quantity,
        date: input.date,
        memo,
      });
      entryId = res.entry.id;
      cogs = res.cogsAmount;
    }

    // Re-stamp the COGS entry for traceability + void reversal.
    await tx.db
      .update(journalEntries)
      .set({ sourceRef: `salesreceipt:${receipt.id}`, reference: line.id })
      .where(and(eq(journalEntries.id, entryId), eq(journalEntries.companyId, tx.companyId)));

    cogsEntries.push({ entryId, lineId: line.id, itemId: line.itemId, cogs });
  }

  // 4b) Advanced Inventory: record the site/bin/serial/lot the stock left from.
  await postDocumentInventory(tx, {
    sourceType: 'sales_receipt',
    sourceId: receipt.id,
    date: input.date,
    direction: 'out',
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
    memo: `Sales Receipt #${receiptNumber}`,
  });

  return { insertedLines, entry, cogsEntries };
}

export async function createSalesReceipt(ctx: ServiceContext, input: CreateSalesReceiptInput) {
  const prep = await prepareSalesReceipt(ctx, input);
  const { method, depositAccountId, subtotal, taxAmount, total } = prep;

  return inTransaction(ctx, async (tx) => {
    const receiptNumber = await nextReceiptNumber(tx);

    // 1) Insert receipt header (already fully paid by definition).
    const [receipt] = await tx.db
      .insert(salesReceipts)
      .values({
        companyId: tx.companyId,
        customerId: input.customerId ?? null,
        receiptNumber,
        date: input.date,
        method,
        reference: input.reference ?? null,
        status: 'paid',
        classId: input.classId ?? null,
        subtotal: toAmountString(subtotal),
        taxAmount: toAmountString(taxAmount),
        total: toAmountString(total),
        depositAccountId,
        memo: input.memo ?? null,
        taxRateId: input.taxRateId ?? null,
        ...shippingColumns(input),
        // postedEntryId filled below after posting
      })
      .returning();

    const { insertedLines, entry, cogsEntries } = await postSalesReceiptDocument(tx, receipt, input, prep);

    // 5) Stamp postedEntryId on the receipt.
    const [updated] = await tx.db
      .update(salesReceipts)
      .set({ postedEntryId: entry.id })
      .where(eq(salesReceipts.id, receipt.id))
      .returning();

    // 6) Audit trail.
    await writeAudit(tx, {
      action: 'create',
      entityType: 'sales_receipt',
      entityId: receipt.id,
      newValues: {
        receiptNumber,
        customerId: input.customerId ?? null,
        total: toAmountString(total),
        depositAccountId,
        postedEntryId: entry.id,
        cogsEntries,
      },
    });

    return { ...updated, lines: insertedLines };
  });
}

// ---------------------------------------------------------------------------
// listSalesReceipts
// ---------------------------------------------------------------------------

export async function listSalesReceipts(
  ctx: ServiceContext,
  opts?: { customerId?: string; status?: string },
) {
  const conds = [eq(salesReceipts.companyId, ctx.companyId)];
  if (opts?.customerId) conds.push(eq(salesReceipts.customerId, opts.customerId));
  if (opts?.status) conds.push(eq(salesReceipts.status, opts.status as never));

  const rows = await ctx.db
    .select()
    .from(salesReceipts)
    .where(and(...conds))
    .orderBy(salesReceipts.receiptNumber);

  if (rows.length === 0) return [];

  // Enrich with customer display names for UI convenience (customer is optional).
  const custIds = [...new Set(rows.map((r) => r.customerId).filter(Boolean) as string[])];
  const custMap = new Map<string, string>();
  if (custIds.length > 0) {
    const custRows = await ctx.db
      .select({ id: customers.id, displayName: customers.displayName })
      .from(customers)
      .where(and(eq(customers.companyId, ctx.companyId), inArray(customers.id, custIds)));
    for (const c of custRows) custMap.set(c.id, c.displayName);
  }

  return rows.map((r) => ({
    ...r,
    customerName: r.customerId ? (custMap.get(r.customerId) ?? null) : null,
  }));
}

// ---------------------------------------------------------------------------
// getSalesReceipt (with lines)
// ---------------------------------------------------------------------------

export async function getSalesReceipt(ctx: ServiceContext, id: string) {
  const [receipt] = await ctx.db
    .select()
    .from(salesReceipts)
    .where(and(eq(salesReceipts.companyId, ctx.companyId), eq(salesReceipts.id, id)));
  if (!receipt) throw notFound('Sales receipt');

  const lines = await ctx.db
    .select()
    .from(salesReceiptLines)
    .where(eq(salesReceiptLines.salesReceiptId, id))
    .orderBy(salesReceiptLines.lineOrder);

  return { ...receipt, lines: await attachInventoryDetails(ctx, 'sales_receipt', id, lines) };
}

// ---------------------------------------------------------------------------
// voidSalesReceipt
// ---------------------------------------------------------------------------

/**
 * Reverse everything a saved sales receipt posted: COGS entries (stock put back on hand / new
 * FIFO layers, site movements reversed) and the main income/payment entry. Used by void and by
 * edit (C1, before re-posting).
 */
async function reverseSalesReceiptPostings(
  tx: ServiceContext,
  receipt: { id: string; date: Date; postedEntryId: string | null },
) {
  const lines = await tx.db
    .select()
    .from(salesReceiptLines)
    .where(eq(salesReceiptLines.salesReceiptId, receipt.id));
  const lineById = new Map(lines.map((l) => [l.id, l]));

  // Find all COGS entries stamped against this receipt (reference = line id).
  const relatedEntries = await tx.db
    .select({ id: journalEntries.id, reference: journalEntries.reference, status: journalEntries.status })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.companyId, tx.companyId),
        eq(journalEntries.sourceRef, `salesreceipt:${receipt.id}`),
        receipt.postedEntryId ? ne(journalEntries.id, receipt.postedEntryId) : undefined,
      ),
    );

  for (const cogsEntry of relatedEntries) {
    if (cogsEntry.status !== 'posted') continue;
    const line = cogsEntry.reference ? lineById.get(cogsEntry.reference) : undefined;

    // Reverse the GL first (Dr Inventory / Cr COGS via balance-delta reversal).
    await voidJournalEntry(tx, cogsEntry.id);

    if (!line?.itemId) continue; // defensive: entry not tied to an inventory line

    // COGS amount = the entry's total debits (the 5000 side).
    const entryLines = await tx.db
      .select({ debit: journalEntryLines.debit })
      .from(journalEntryLines)
      .where(eq(journalEntryLines.journalEntryId, cogsEntry.id));
    const cogs = entryLines.reduce((s, l) => s.plus(Money.of(l.debit)), Money.zero());

    const qty = Money.of(line.quantity);

    if (await isFifoTracked(tx, line.itemId)) {
      // Restore the stock value as a new layer at the blended consumed cost.
      const unitCost = qty.isZero() ? Money.zero() : cogs.dividedBy(qty);
      await tx.db.insert(inventoryLayers).values({
        companyId: tx.companyId,
        itemId: line.itemId,
        date: receipt.date,
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

  // Put the stock back at the site/bin/serial it was sold from.
  await reverseDocumentInventory(tx, 'sales_receipt', receipt.id);

  // Reverse the main income/payment entry.
  if (receipt.postedEntryId) {
    await voidJournalEntry(tx, receipt.postedEntryId);
  }
}

/**
 * Void a sales receipt: reverse the income/payment entry, reverse every COGS
 * entry, and put the relieved stock back.
 *
 * Stock restoration:
 *  - FIFO items get a NEW layer dated at the receipt date whose unit cost is the
 *    voided entry's COGS / quantity (value restored exactly matches the GL
 *    reversal; lot identity of the consumed layers is not resurrected).
 *  - Average-cost items get quantityOnHand bumped back (averageCost unchanged —
 *    symmetric with recordCOGS, which does not change averageCost on removal).
 */
export async function voidSalesReceipt(ctx: ServiceContext, id: string) {
  const [receipt] = await ctx.db
    .select()
    .from(salesReceipts)
    .where(and(eq(salesReceipts.companyId, ctx.companyId), eq(salesReceipts.id, id)));
  if (!receipt) throw notFound('Sales receipt');

  if (receipt.status === 'void') {
    throw new ServiceError('CONFLICT', 'Sales receipt is already voided.');
  }

  return inTransaction(ctx, async (tx) => {
    await reverseSalesReceiptPostings(tx, receipt);

    // Mark the receipt void.
    const [updated] = await tx.db
      .update(salesReceipts)
      .set({ status: 'void' })
      .where(eq(salesReceipts.id, id))
      .returning();

    await writeAudit(tx, {
      action: 'void',
      entityType: 'sales_receipt',
      entityId: id,
      oldValues: { status: receipt.status },
      newValues: { status: 'void' },
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// updateSalesReceipt (wave2 sales, C1 — edit a saved sales receipt)
// ---------------------------------------------------------------------------

/** True when the receipt has been swept into a (non-void) bank deposit. */
async function isDeposited(ctx: ServiceContext, receiptId: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ id: depositLines.id })
    .from(depositLines)
    .innerJoin(deposits, eq(deposits.id, depositLines.depositId))
    .where(
      and(
        eq(deposits.companyId, ctx.companyId),
        isNull(deposits.voidedAt),
        eq(depositLines.description, `salesReceipt:${receiptId}`),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Edit a saved sales receipt in place (QB "edit any saved transaction").
 *
 * Sanctioned void/repost pattern inside ONE transaction: reverse the old version (COGS entries
 * and stock, then the income/payment entry — closing-date check on the old date), replace the
 * lines, re-post from the new lines (closing-date check on the new date) and audit old + new
 * values. receiptNumber and createdAt are preserved.
 *
 * Once the receipt has been included in a bank deposit its amount and deposit account are
 * locked (the deposit moved exactly that money); other details can still change.
 */
export async function updateSalesReceipt(ctx: ServiceContext, id: string, input: CreateSalesReceiptInput) {
  const [existing] = await ctx.db
    .select()
    .from(salesReceipts)
    .where(and(eq(salesReceipts.companyId, ctx.companyId), eq(salesReceipts.id, id)));
  if (!existing) throw notFound('Sales receipt');
  if (existing.status === 'void') throw new ServiceError('CONFLICT', 'Cannot edit a voided sales receipt.');

  const prep = await prepareSalesReceipt(ctx, input);

  if (await isDeposited(ctx, id)) {
    if (!Money.eq(prep.total, existing.total) || prep.depositAccountId !== existing.depositAccountId) {
      throw new ServiceError(
        'CONFLICT',
        'This sales receipt is already part of a bank deposit, so its total and deposit account cannot change. Remove it from the deposit first, or change only the other details.',
      );
    }
  }

  return inTransaction(ctx, async (tx) => {
    const [receipt] = await tx.db
      .select()
      .from(salesReceipts)
      .where(and(eq(salesReceipts.companyId, tx.companyId), eq(salesReceipts.id, id)));
    if (!receipt || receipt.status === 'void') {
      throw new ServiceError('CONFLICT', 'Cannot edit a voided sales receipt.');
    }
    const oldLines = await tx.db
      .select()
      .from(salesReceiptLines)
      .where(eq(salesReceiptLines.salesReceiptId, id))
      .orderBy(salesReceiptLines.lineOrder);

    // 1) Reverse the old version.
    await reverseSalesReceiptPostings(tx, receipt);

    // 2) Replace lines + re-post.
    await tx.db.delete(salesReceiptLines).where(eq(salesReceiptLines.salesReceiptId, id));
    const { insertedLines, entry, cogsEntries } = await postSalesReceiptDocument(
      tx,
      { id, receiptNumber: receipt.receiptNumber },
      input,
      prep,
    );

    const [updated] = await tx.db
      .update(salesReceipts)
      .set({
        customerId: input.customerId ?? null,
        date: input.date,
        method: prep.method,
        reference: input.reference ?? null,
        classId: input.classId ?? null,
        subtotal: toAmountString(prep.subtotal),
        taxAmount: toAmountString(prep.taxAmount),
        total: toAmountString(prep.total),
        depositAccountId: prep.depositAccountId,
        memo: input.memo ?? null,
        taxRateId: input.taxRateId ?? null,
        ...shippingColumns(input, receipt),
        postedEntryId: entry.id,
      })
      .where(eq(salesReceipts.id, id))
      .returning();

    await writeAudit(tx, {
      action: 'update',
      entityType: 'sales_receipt',
      entityId: id,
      oldValues: {
        customerId: receipt.customerId,
        date: receipt.date,
        method: receipt.method,
        total: receipt.total,
        depositAccountId: receipt.depositAccountId,
        postedEntryId: receipt.postedEntryId,
        lines: oldLines.map((l) => ({ itemId: l.itemId, description: l.description, quantity: l.quantity, rate: l.rate, amount: l.amount })),
      },
      newValues: {
        customerId: input.customerId ?? null,
        date: input.date,
        method: prep.method,
        total: toAmountString(prep.total),
        depositAccountId: prep.depositAccountId,
        postedEntryId: entry.id,
        cogsEntries,
        lines: prep.computedLines.map((l) => ({ itemId: l.itemId, description: l.description, quantity: l.quantity, rate: l.rate, amount: l.amount })),
      },
    });

    return { ...updated, lines: insertedLines };
  });
}
