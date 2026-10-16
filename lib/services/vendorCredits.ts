/**
 * Vendor Credits (A/P credits) service.
 *
 * A vendor credit records an amount that a vendor owes the company (e.g. returned goods,
 * negotiated discount after the fact). The posting pattern is the reverse of a bill:
 *
 *   Dr  Accounts Payable  2000      (total — reduces the A/P liability)
 *   Cr  <expense/asset account per line>   (line.amount)
 *
 * Application to a bill (applyToBill) reduces the bill's balanceDue and the credit's
 * unapplied balance.  No new GL entry is needed because the A/P balance was already
 * reduced when the credit was posted; the application is a bookkeeping memo only.
 *
 * Voiding calls voidJournalEntry and flips the document status to 'void'.
 *
 * p1 purchases — QB Enter Bills (Credit) parity:
 *   - Ref. No. (the vendor's credit memo number) on the credit and its journal entry reference.
 *   - Expenses AND Items tabs. Returning inventory to the vendor takes the units out of stock at
 *     their CURRENT cost (average cost, or the oldest FIFO layers) and credits the inventory asset
 *     with that cost; any difference between what the vendor credits and that cost goes to Cost of
 *     Goods Sold ("return price difference"), so the inventory value always equals the stock
 *     subledger. Non-inventory / service items credit the item's expense account.
 *   - Class and Customer:Job on every line (Class also on the journal line).
 *   - Voiding (or a ledger-changing edit) puts the returned stock back at the cost it left with.
 */

import { assertAccountantDatesOpen } from './accountantCopy/guard';
import { isDepositTargetAccount } from '@/lib/accountTypes';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type Decimal from 'decimal.js';
import {
  accounts,
  auditLogs,
  bills,
  classes,
  customers,
  inventoryLayers,
  items,
  jobs,
  vendorCredits,
  vendorCreditLines,
  vendors,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import {
  type PostingLine,
  assertNotControlLineAccount,
  postJournalEntry,
  voidJournalEntry,
} from '@/lib/services/posting';
import { receivePurchasedStock } from './bills';
import { takeFromLayers } from './fifo';
import { postDocumentInventory, reverseDocumentInventory } from './inventorySites';
import { planPostedEdit, retitleEntry } from './postedEdit';
import { getHomeCurrencyCode } from './currencies';
import {
  applyForeignVendorCredit,
  refundForeignVendorCredit,
  resolveVendorCreditFx,
  unapplyForeignVendorCredit,
  vendorCreditEntryFx,
  vendorCreditApplicationDate,
  vendorCreditRefundDate,
  assertRedateAfterVendorCreditSteps,
  clearSettledForeignApplications,
  vendorCreditFxColumns,
} from './vendorCreditsFx';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface VendorCreditLineInput {
  /** Expenses tab: GL account to credit (expense or asset). Items tab: optional override for a
   * non-inventory item's account. */
  accountId?: string | null;
  /** Items tab: the item returned / credited. Inventory items leave stock at cost. */
  itemId?: string | null;
  /** Items tab: units returned (> 0). */
  quantity?: string | number | null;
  /** Items tab: cost per unit the vendor credits (amount = quantity x unitCost when no amount). */
  unitCost?: string | number | null;
  description?: string | null;
  /** Line amount the vendor credits (> 0). Required on Expenses-tab lines. */
  amount?: string | number | null;
  classId?: string | null;
  /** Customer:Job the credit relates to (job costing). */
  customerId?: string | null;
  jobId?: string | null;
}

export interface CreateVendorCreditInput {
  vendorId: string;
  date: Date;
  memo?: string | null;
  /** The vendor's credit memo number (QB "Ref. No."). */
  refNumber?: string | null;
  lines: VendorCreditLineInput[];
  /** p1 fx: the vendor's currency is used; a stated rate overrides the currency list's rate. */
  currency?: string | null;
  exchangeRate?: string | number | null;
}

export interface ApplyToBillInput {
  vendorCreditId: string;
  billId: string;
  /** Amount to apply (must be <= credit.unapplied and <= bill.balanceDue). */
  amount: string | number;
  /** p1 fx: date of a foreign application's exchange gain/loss entry (default today). */
  date?: Date | null;
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

async function accountIdByCode(ctx: ServiceContext, code: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
  if (!row) throw notFound(`Account with code ${code}`);
  return row.id;
}

/** One validated vendor-credit line. */
interface PreparedLine {
  /** Account credited: the item's inventory asset for inventory returns. */
  accountId: string;
  itemId: string | null;
  isInventory: boolean;
  quantity: Decimal | null;
  unitCost: string | null;
  /** What the vendor credits for this line (2dp). */
  amount: string;
  description: string | null;
  classId: string | null;
  customerId: string | null;
  jobId: string | null;
}

/**
 * Validate the lines (Expenses and Items tabs) and resolve each line's account. Items tab:
 * inventory items credit their inventory asset account (stock leaves at cost — see
 * relieveReturnedStock); other items credit line.accountId ?? item.expenseAccountId.
 */
async function prepareLines(
  ctx: ServiceContext,
  lines: VendorCreditLineInput[],
): Promise<{ lines: PreparedLine[]; total: Decimal }> {
  if (!lines || lines.length === 0) throw validation('A vendor credit must have at least one line.');
  const itemIds = [...new Set(lines.map((l) => l.itemId).filter((x): x is string => Boolean(x)))];
  const itemRows = itemIds.length
    ? await ctx.db
        .select()
        .from(items)
        .where(and(eq(items.companyId, ctx.companyId), inArray(items.id, itemIds)))
    : [];
  const itemById = new Map(itemRows.map((i) => [i.id, i] as const));
  let inventoryDefault: string | null = null;
  let total = Money.zero();
  const out: PreparedLine[] = [];
  for (const [i, l] of lines.entries()) {
    const n = i + 1;
    const dims = { classId: l.classId ?? null, customerId: l.customerId ?? null, jobId: l.jobId ?? null };
    if (l.itemId) {
      const item = itemById.get(l.itemId);
      if (!item) throw notFound(`Item on line ${n}`);
      let qty: Decimal;
      try {
        qty = Money.of(l.quantity ?? 0);
      } catch {
        throw validation(`Line ${n}: quantity is not a number.`);
      }
      if (!qty.greaterThan(0)) throw validation(`Line ${n}: enter the quantity returned.`);
      if (l.amount == null && l.unitCost == null) throw validation(`Line ${n}: enter a cost or an amount for "${item.name}".`);
      const amount = l.amount != null ? Money.round2(l.amount) : Money.round2(qty.times(Money.of(l.unitCost!)));
      if (!amount.greaterThan(0)) throw validation(`Line ${n}: the amount must be greater than zero.`);
      const unitCost = l.unitCost != null ? Money.of(l.unitCost) : amount.dividedBy(qty);
      const isInventory = item.type === 'inventory';
      let accountId: string;
      if (isInventory) {
        accountId = item.assetAccountId ?? (inventoryDefault ??= await accountIdByCode(ctx, '1300'));
      } else {
        const routed = l.accountId ?? item.expenseAccountId;
        if (!routed) {
          throw validation(`Line ${n}: "${item.name}" has no expense account. Set one on the item or pick an account.`);
        }
        accountId = routed;
      }
      out.push({
        accountId,
        itemId: item.id,
        isInventory,
        quantity: qty,
        unitCost: unitCost.toFixed(4),
        amount: toAmountString(amount),
        description: l.description?.trim() || item.name,
        ...dims,
      });
      total = total.plus(amount);
    } else {
      if (!l.accountId) throw validation(`Line ${n}: pick an account or an item.`);
      let amt: Decimal;
      try {
        amt = Money.round2(l.amount ?? 0);
      } catch {
        throw validation(`Line ${n}: amount is not a number.`);
      }
      if (!amt.greaterThan(0)) throw validation(`Line ${n}: amount must be greater than zero.`);
      out.push({
        accountId: l.accountId,
        itemId: null,
        isInventory: false,
        quantity: null,
        unitCost: null,
        amount: toAmountString(amt),
        description: l.description ?? null,
        ...dims,
      });
      total = total.plus(amt);
    }
  }

  // Line accounts: owned by the company, never A/R / A/P (QB lists neither on a form line).
  const acctIds = [...new Set(out.map((l) => l.accountId))];
  const acctRows = await ctx.db
    .select({ id: accounts.id, type: accounts.type, subtype: accounts.subtype, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), inArray(accounts.id, acctIds)));
  const acctById = new Map(acctRows.map((a) => [a.id, a] as const));
  out.forEach((l, i) => {
    const a = acctById.get(l.accountId);
    if (!a) throw notFound(`Account on line ${i + 1}`);
    assertNotControlLineAccount(a, `Line ${i + 1}`);
  });

  // Class / customer / job belong to this company; a job must belong to the line's customer.
  const ids = (k: 'classId' | 'customerId' | 'jobId') => [...new Set(out.map((l) => l[k]).filter((x): x is string => Boolean(x)))];
  const classIds = ids('classId');
  if (classIds.length) {
    const rows = await ctx.db.select({ id: classes.id }).from(classes).where(and(eq(classes.companyId, ctx.companyId), inArray(classes.id, classIds)));
    if (rows.length !== classIds.length) throw notFound('Class');
  }
  const customerIds = ids('customerId');
  if (customerIds.length) {
    const rows = await ctx.db.select({ id: customers.id }).from(customers).where(and(eq(customers.companyId, ctx.companyId), inArray(customers.id, customerIds)));
    if (rows.length !== customerIds.length) throw notFound('Customer');
  }
  const jobIds = ids('jobId');
  if (jobIds.length) {
    const rows = await ctx.db
      .select({ id: jobs.id, customerId: jobs.customerId })
      .from(jobs)
      .where(and(eq(jobs.companyId, ctx.companyId), inArray(jobs.id, jobIds)));
    if (rows.length !== jobIds.length) throw notFound('Job');
    const jobCustomer = new Map(rows.map((r) => [r.id, r.customerId] as const));
    for (const l of out) {
      if (!l.jobId) continue;
      const jc = jobCustomer.get(l.jobId) ?? null;
      if (l.customerId && jc && jc !== l.customerId) throw validation('A job on the credit belongs to a different customer.');
      if (!l.customerId) l.customerId = jc;
    }
  }
  return { lines: out, total: Money.round2(total) };
}

/**
 * Take returned units out of stock at their CURRENT cost (average cost, or the oldest FIFO
 * layers), like an inventory decrease. Returns the cost relieved (2dp). Returning more than is on
 * hand is refused.
 */
async function relieveReturnedStock(
  tx: ServiceContext,
  itemId: string,
  qty: Decimal,
  reason: string,
): Promise<Decimal> {
  const [item] = await tx.db
    .select()
    .from(items)
    .where(and(eq(items.companyId, tx.companyId), eq(items.id, itemId)));
  if (!item) throw notFound('Item');
  const onHand = Money.of(item.quantityOnHand ?? '0');
  if (qty.greaterThan(onHand)) {
    throw validation(
      `You are returning ${qty.toFixed(2)} of "${item.name}" but only ${onHand.toFixed(2)} are on hand.`,
    );
  }
  const [layer] = await tx.db
    .select({ id: inventoryLayers.id })
    .from(inventoryLayers)
    .where(and(eq(inventoryLayers.companyId, tx.companyId), eq(inventoryLayers.itemId, itemId)))
    .limit(1);
  const cost = layer
    ? (await takeFromLayers(tx, itemId, qty)).cost
    : Money.round2(qty.times(Money.of(item.averageCost ?? '0')));
  const newQty = onHand.minus(qty);
  await tx.db
    .update(items)
    .set({ quantityOnHand: newQty.toFixed(4), updatedAt: new Date() })
    .where(eq(items.id, itemId));
  await writeAudit(tx, {
    action: 'update',
    entityType: 'item',
    entityId: itemId,
    oldValues: { quantityOnHand: item.quantityOnHand },
    newValues: { quantityOnHand: newQty.toFixed(4), returnedCost: toAmountString(cost), reason },
  });
  return cost;
}

/** Relieve stock for every inventory line; returns the cost per line index. */
async function relieveCreditStock(
  tx: ServiceContext,
  creditId: string,
  date: Date,
  prep: PreparedLine[],
): Promise<Map<number, Decimal>> {
  const costs = new Map<number, Decimal>();
  for (const [i, l] of prep.entries()) {
    if (!l.isInventory || !l.itemId || !l.quantity) continue;
    costs.set(i, await relieveReturnedStock(tx, l.itemId, l.quantity, `vendor_credit:${creditId}`));
  }
  if (costs.size > 0) {
    await postDocumentInventory(tx, {
      sourceType: 'vendor_credit',
      sourceId: creditId,
      date,
      direction: 'out',
      lines: prep.map((l, idx) => ({
        lineOrder: idx,
        itemId: l.isInventory ? l.itemId : null,
        quantity: l.quantity ? l.quantity.toFixed(4) : '0',
      })),
      memo: 'Returned to vendor',
    });
  }
  return costs;
}

/** Put the stock a saved credit returned back on hand at the cost it left with (void / edit). */
async function restoreCreditStock(tx: ServiceContext, credit: typeof vendorCredits.$inferSelect) {
  const saved = await tx.db
    .select()
    .from(vendorCreditLines)
    .where(eq(vendorCreditLines.vendorCreditId, credit.id));
  const inv = saved.filter((l) => l.itemId && l.costAmount != null && l.quantity != null && Money.gt(l.quantity, 0));
  if (inv.length === 0) return;
  await receivePurchasedStock(
    tx,
    `vendor_credit:${credit.id}`,
    credit.date,
    inv.map((l) => ({
      itemId: l.itemId,
      isInventory: true,
      quantity: Money.of(l.quantity!).toFixed(4),
      unitCost: Money.of(l.costAmount!).dividedBy(Money.of(l.quantity!)),
    })),
    `vendor_credit_reversed:${credit.id}`,
  );
  await reverseDocumentInventory(tx, 'vendor_credit', credit.id);
}

/**
 * The credit's journal lines:
 *   Dr A/P                                   total (the credit's own control line)
 *   Cr each Expenses-tab line account        line amount (with Class)
 *   Cr Inventory asset                       cost of returned units (Items tab, inventory)
 *   Cr / Dr Cost of Goods Sold               returned-price difference (credit amount − cost)
 *   Cr other item's account                  line amount (non-inventory / service items)
 */
function postingLinesFor(
  creditId: string,
  apAccountId: string,
  cogsAccountId: string | null,
  prep: PreparedLine[],
  total: Decimal,
  costs: Map<number, Decimal>,
): PostingLine[] {
  const out: PostingLine[] = [
    { accountId: apAccountId, debit: toAmountString(total), memo: `Vendor credit ${creditId}`, controlLine: true },
  ];
  prep.forEach((l, i) => {
    const cost = costs.get(i);
    if (!l.isInventory || cost === undefined) {
      out.push({ accountId: l.accountId, credit: l.amount, memo: l.description, classId: l.classId });
      return;
    }
    if (cost.greaterThan(0)) {
      out.push({ accountId: l.accountId, credit: toAmountString(cost), memo: l.description, classId: l.classId });
    }
    const diff = Money.round2(Money.of(l.amount).minus(cost));
    if (!diff.isZero()) {
      out.push({
        accountId: cogsAccountId!,
        ...(diff.greaterThan(0) ? { credit: toAmountString(diff) } : { debit: toAmountString(diff.abs()) }),
        memo: `Return price difference — ${l.description ?? 'item'}`,
        classId: l.classId,
      });
    }
  });
  return out;
}

/** The prepared lines with each amount replaced by its home value (p1 fx: postings are in home currency). */
function homePrep(prep: PreparedLine[], fx: { homeLines: string[] }): PreparedLine[] {
  return prep.map((l, i) => ({ ...l, amount: fx.homeLines[i] }));
}

function lineRowsFor(creditId: string, prep: PreparedLine[], costs: Map<number, Decimal>) {
  return prep.map((l, idx) => ({
    vendorCreditId: creditId,
    accountId: l.accountId,
    description: l.description,
    amount: l.amount,
    lineOrder: idx,
    itemId: l.itemId,
    quantity: l.quantity ? l.quantity.toFixed(4) : null,
    unitCost: l.unitCost,
    costAmount: costs.has(idx) ? toAmountString(costs.get(idx)!) : null,
    classId: l.classId,
    customerId: l.customerId,
    jobId: l.jobId,
  }));
}

/** Ledger signature of a set of lines (account, item, qty, amount, class) — order-sensitive. */
function lineSignature(
  rows: Array<{ accountId: string; itemId: string | null; quantity: string | Decimal | null; amount: string; classId: string | null }>,
): string {
  return rows
    .map(
      (r) =>
        `${r.accountId}|${r.itemId ?? ''}|${r.quantity == null ? '' : Money.of(r.quantity).toFixed(4)}|${Money.round2(r.amount).toFixed(2)}|${r.classId ?? ''}`,
    )
    .join(';');
}

// ---------------------------------------------------------------------------
// createVendorCredit
// ---------------------------------------------------------------------------

/**
 * J10 / p1 fx: a vendor credit is in its vendor's currency (vendorCreditsFx.ts); A/P and the
 * line accounts get home amounts. A home credit can't be refunded into a foreign account.
 */
async function foreignCurrencyOf(ctx: ServiceContext, code: string | null | undefined): Promise<string | null> {
  const v = (code ?? '').trim().toUpperCase();
  if (!v) return null;
  const home = await getHomeCurrencyCode(ctx);
  return home && v === home ? null : v;
}

export async function createVendorCredit(ctx: ServiceContext, input: CreateVendorCreditInput) {
  // Verify vendor belongs to this company.
  const [vendor] = await ctx.db
    .select({ id: vendors.id, name: vendors.displayName })
    .from(vendors)
    .where(and(eq(vendors.id, input.vendorId), eq(vendors.companyId, ctx.companyId)));
  if (!vendor) throw notFound('Vendor');

  const { lines: prep, total } = await prepareLines(ctx, input.lines);
  const totalStr = toAmountString(total);
  const fx = await resolveVendorCreditFx(ctx, input.vendorId, { ...input, lines: prep });
  const apAccountId = await resolveApAccount(ctx);
  const cogsAccountId = prep.some((l) => l.isInventory) ? await accountIdByCode(ctx, '5000') : null;

  return inTransaction(ctx, async (tx) => {
    // 1) Insert the vendor credit header.
    const [credit] = await tx.db
      .insert(vendorCredits)
      .values({
        companyId: tx.companyId,
        vendorId: input.vendorId,
        date: input.date,
        memo: input.memo ?? null,
        refNumber: input.refNumber?.trim() || null,
        status: 'open',
        total: totalStr,
        unapplied: totalStr,
        ...vendorCreditFxColumns(fx),
      })
      .returning();

    // 2) Returned items leave stock at their current cost.
    const costs = await relieveCreditStock(tx, credit.id, input.date, prep);

    // 3) Lines (amounts in the credit's currency).
    await tx.db.insert(vendorCreditLines).values(lineRowsFor(credit.id, prep, costs));

    // 4) Post: Dr A/P total / Cr line accounts (inventory at cost, price difference to COGS).
    const entry = await postJournalEntry(tx, {
      date: input.date,
      description: `Vendor Credit — ${vendor.name}`,
      reference: input.refNumber?.trim() || null,
      sourceRef: `vendor_credit:${credit.id}`,
      lines: postingLinesFor(credit.id, apAccountId, cogsAccountId, homePrep(prep, fx), Money.of(fx.homeTotal), costs),
      ...vendorCreditEntryFx(fx),
    });

    // 5) Stamp postedEntryId.
    const [updated] = await tx.db
      .update(vendorCredits)
      .set({ postedEntryId: entry.id })
      .where(eq(vendorCredits.id, credit.id))
      .returning();

    await writeAudit(tx, {
      action: 'create',
      entityType: 'vendor_credit',
      entityId: credit.id,
      newValues: { ...updated, linesCount: prep.length, total: totalStr },
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// updateVendorCredit — edit a saved vendor credit (D1)
// ---------------------------------------------------------------------------

/**
 * Edit a saved vendor credit in ONE transaction. A ledger-neutral edit (memo, Ref. No., line
 * descriptions, Customer:Job — same date, vendor, accounts, items, quantities, amounts and
 * classes) keeps the journal entry. Anything else voids the entry and re-posts it (returned stock
 * goes back on hand and is taken out again); that is only allowed while nothing of the credit has
 * been applied to a bill or refunded (unapply first, like QB).
 */
export async function updateVendorCredit(ctx: ServiceContext, id: string, input: CreateVendorCreditInput) {
  const [existing] = await ctx.db
    .select()
    .from(vendorCredits)
    .where(and(eq(vendorCredits.id, id), eq(vendorCredits.companyId, ctx.companyId)));
  if (!existing) throw notFound('Vendor credit');
  if (existing.status === 'void') throw new ServiceError('CONFLICT', 'Cannot edit a voided vendor credit.');
  // p1 fx: never move a credit after its dated applications or refunds.
  await assertRedateAfterVendorCreditSteps(ctx, { vendorCreditId: id }, input.date);

  const [vendor] = await ctx.db
    .select({ id: vendors.id, name: vendors.displayName })
    .from(vendors)
    .where(and(eq(vendors.id, input.vendorId), eq(vendors.companyId, ctx.companyId)));
  if (!vendor) throw notFound('Vendor');
  const { lines: prep, total } = await prepareLines(ctx, input.lines);
  const totalStr = toAmountString(total);
  // p1 fx: a blank rate keeps the credit's saved rate (not today's list rate), so a memo edit of an
  // applied foreign credit stays ledger-neutral.
  const fx = await resolveVendorCreditFx(ctx, input.vendorId, {
    ...input,
    lines: prep,
    exchangeRate:
      input.exchangeRate == null || String(input.exchangeRate).trim() === ''
        ? existing.currency
          ? existing.exchangeRate
          : null
        : input.exchangeRate,
  });
  if ((existing.currency ?? null) !== fx.currency) {
    throw validation(
      `This credit is in ${existing.currency ?? 'your home currency'} and can't be moved to a vendor or currency in ${fx.currency ?? 'your home currency'}. Void it and enter a new credit instead.`,
    );
  }
  const apAccountId = await resolveApAccount(ctx);
  const cogsAccountId = prep.some((l) => l.isInventory) ? await accountIdByCode(ctx, '5000') : null;
  const refNumber = input.refNumber?.trim() || null;

  return inTransaction(ctx, async (tx) => {
    const [cur] = await tx.db.select().from(vendorCredits).where(eq(vendorCredits.id, id));
    if (!cur || cur.status === 'void') throw new ServiceError('CONFLICT', 'Cannot edit a voided vendor credit.');
    const oldLines = await tx.db
      .select()
      .from(vendorCreditLines)
      .where(eq(vendorCreditLines.vendorCreditId, id))
      .orderBy(asc(vendorCreditLines.lineOrder));

    const hasItems = oldLines.some((l) => l.itemId) || prep.some((l) => l.itemId);
    let plan: 'unchanged' | 'repost';
    if (hasItems) {
      const same =
        cur.vendorId === input.vendorId &&
        new Date(cur.date).toISOString().slice(0, 10) === new Date(input.date).toISOString().slice(0, 10) &&
        lineSignature(oldLines) === lineSignature(prep);
      plan = same ? 'unchanged' : 'repost';
    } else {
      plan = await planPostedEdit(tx, {
        entryId: cur.postedEntryId,
        date: input.date,
        lines: postingLinesFor(id, apAccountId, cogsAccountId, homePrep(prep, fx), Money.of(fx.homeTotal), new Map()),
        what: 'vendor credit',
      });
      if (plan === 'unchanged' && cur.vendorId !== input.vendorId) plan = 'repost';
    }
    // p1 fx: a foreign credit whose amount or rate changed re-posts even if its home value did not.
    if (
      plan === 'unchanged' &&
      fx.currency &&
      (!Money.eq(cur.total, totalStr) || !Money.of(cur.exchangeRate ?? 0).equals(fx.rate))
    ) {
      plan = 'repost';
    }

    let entryId = cur.postedEntryId;
    if (plan === 'unchanged') {
      // Keep the entry and the stock; carry each line's relieved cost forward.
      const costs = new Map<number, Decimal>();
      oldLines.forEach((l, i) => {
        if (l.costAmount != null) costs.set(i, Money.of(l.costAmount));
      });
      await tx.db.update(vendorCredits).set({ memo: input.memo ?? null, refNumber }).where(eq(vendorCredits.id, id));
      await tx.db.delete(vendorCreditLines).where(eq(vendorCreditLines.vendorCreditId, id));
      await tx.db.insert(vendorCreditLines).values(lineRowsFor(id, prep, costs));
      await retitleEntry(tx, entryId, { description: `Vendor Credit — ${vendor.name}`, reference: refNumber });
    } else {
      const used = Money.of(cur.total).minus(Money.of(cur.unapplied));
      if (used.greaterThan(0) || Money.of(cur.refundedAmount).greaterThan(0)) {
        throw new ServiceError(
          'CONFLICT',
          'Part of this credit was already applied to a bill or refunded. Unapply it first, then change the amount or accounts.',
        );
      }
      if (cur.postedEntryId) await voidJournalEntry(tx, cur.postedEntryId);
      await restoreCreditStock(tx, cur);
      await tx.db.delete(vendorCreditLines).where(eq(vendorCreditLines.vendorCreditId, id));
      const costs = await relieveCreditStock(tx, id, input.date, prep);
      await tx.db.insert(vendorCreditLines).values(lineRowsFor(id, prep, costs));
      const entry = await postJournalEntry(tx, {
        date: input.date,
        description: `Vendor Credit — ${vendor.name}`,
        reference: refNumber,
        sourceRef: `vendor_credit:${id}`,
        lines: postingLinesFor(id, apAccountId, cogsAccountId, homePrep(prep, fx), Money.of(fx.homeTotal), costs),
        ...vendorCreditEntryFx(fx),
      });
      entryId = entry.id;
      await tx.db
        .update(vendorCredits)
        .set({
          vendorId: input.vendorId,
          date: input.date,
          memo: input.memo ?? null,
          refNumber,
          total: totalStr,
          unapplied: totalStr,
          status: 'open',
          postedEntryId: entry.id,
          ...vendorCreditFxColumns(fx),
        })
        .where(eq(vendorCredits.id, id));
    }

    const [updated] = await tx.db.select().from(vendorCredits).where(eq(vendorCredits.id, id));
    await writeAudit(tx, {
      action: 'update',
      entityType: 'vendor_credit',
      entityId: id,
      oldValues: {
        vendorId: cur.vendorId,
        date: cur.date,
        memo: cur.memo,
        refNumber: cur.refNumber,
        total: cur.total,
        postedEntryId: cur.postedEntryId,
        lines: oldLines.map((l) => ({
          accountId: l.accountId,
          itemId: l.itemId,
          quantity: l.quantity,
          amount: l.amount,
          description: l.description,
        })),
      },
      newValues: {
        vendorId: input.vendorId,
        date: input.date,
        memo: input.memo ?? null,
        refNumber,
        total: updated.total,
        ledger: plan === 'unchanged' ? 'unchanged' : 'reposted',
        postedEntryId: entryId,
        lines: input.lines,
      },
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// listVendorCredits
// ---------------------------------------------------------------------------

export async function listVendorCredits(
  ctx: ServiceContext,
  opts?: { vendorId?: string; status?: string },
) {
  const conditions = [eq(vendorCredits.companyId, ctx.companyId)];
  if (opts?.vendorId) conditions.push(eq(vendorCredits.vendorId, opts.vendorId));
  if (opts?.status) conditions.push(eq(vendorCredits.status, opts.status as never));

  return ctx.db
    .select()
    .from(vendorCredits)
    .where(and(...conditions))
    .orderBy(desc(vendorCredits.date), asc(vendorCredits.createdAt));
}

// ---------------------------------------------------------------------------
// getVendorCredit (with lines)
// ---------------------------------------------------------------------------

export async function getVendorCredit(ctx: ServiceContext, id: string) {
  const [credit] = await ctx.db
    .select()
    .from(vendorCredits)
    .where(and(eq(vendorCredits.id, id), eq(vendorCredits.companyId, ctx.companyId)));
  if (!credit) throw notFound('Vendor credit');

  const lines = await ctx.db
    .select()
    .from(vendorCreditLines)
    .where(eq(vendorCreditLines.vendorCreditId, id))
    .orderBy(asc(vendorCreditLines.lineOrder));

  return { ...credit, lines };
}

// ---------------------------------------------------------------------------
// applyToBill
// ---------------------------------------------------------------------------

/**
 * Apply a vendor credit to an open bill.
 *
 * This does NOT post a new GL entry — the credit already reduced A/P when it
 * was created.  Here we just track the application so reporting shows the
 * bill is reduced and the credit is consumed.
 */
export async function applyToBill(ctx: ServiceContext, input: ApplyToBillInput) {
  const applyAmount = Money.round2(input.amount);

  if (!applyAmount.greaterThan(0)) {
    throw validation('Apply amount must be greater than zero.');
  }

  // Load the vendor credit (scoped to company).
  const [credit] = await ctx.db
    .select()
    .from(vendorCredits)
    .where(and(eq(vendorCredits.id, input.vendorCreditId), eq(vendorCredits.companyId, ctx.companyId)));
  if (!credit) throw notFound('Vendor credit');

  if (credit.status === 'void') {
    throw new ServiceError('CONFLICT', 'Cannot apply a voided vendor credit.');
  }

  const unapplied = Money.of(credit.unapplied);
  if (applyAmount.greaterThan(unapplied)) {
    throw validation(
      `Apply amount ${toAmountString(applyAmount)} exceeds the credit's unapplied balance ${toAmountString(unapplied)}.`,
    );
  }

  // Load the bill (scoped to company).
  const [bill] = await ctx.db
    .select()
    .from(bills)
    .where(and(eq(bills.id, input.billId), eq(bills.companyId, ctx.companyId)));
  if (!bill) throw notFound('Bill');

  if (bill.status === 'void') {
    throw new ServiceError('CONFLICT', 'Cannot apply a credit to a voided bill.');
  }

  const balanceDue = Money.of(bill.balanceDue);
  if (applyAmount.greaterThan(balanceDue)) {
    throw validation(
      `Apply amount ${toAmountString(applyAmount)} exceeds the bill's balance due ${toAmountString(balanceDue)}.`,
    );
  }

  // Verify the credit and bill belong to the same vendor.
  if (credit.vendorId !== bill.vendorId) {
    throw validation('Vendor credit and bill must belong to the same vendor.');
  }
  // Accountant's Copy (I1): records dated after the dividing date belong to the client.
  await assertAccountantDatesOpen(ctx, [credit.date, bill.date], 'The vendor credit or bill');

  // Currencies: blank or the home code (any case) is home. A home credit only applies to a home
  // bill; a foreign credit / bill is applied at each side's booked rate with a realized exchange
  // gain/loss (vendorCreditsFx.ts) and only to a bill in the same currency.
  const creditCurrency = await foreignCurrencyOf(ctx, credit.currency);
  const billCurrency = await foreignCurrencyOf(ctx, bill.currency);
  if (!creditCurrency && billCurrency) {
    throw validation(
      `This bill is in ${billCurrency}. Home-currency vendor credits can't be applied to it — settle it with Pay Bills instead.`,
    );
  }
  // An application is dated (never before the credit or the bill exists).
  const applyDate = await vendorCreditApplicationDate(ctx, credit, bill, input.date, 'apply');
  if (creditCurrency) {
    return applyForeignVendorCredit(
      ctx,
      { ...credit, currency: creditCurrency },
      { ...bill, currency: billCurrency },
      applyAmount,
      applyDate,
    );
  }

  return inTransaction(ctx, async (tx) => {
    // Update credit's unapplied balance.
    const newUnapplied = unapplied.minus(applyAmount);
    const newCreditStatus = newUnapplied.isZero() ? 'closed' : 'partial';

    const [updatedCredit] = await tx.db
      .update(vendorCredits)
      .set({
        unapplied: toAmountString(newUnapplied),
        status: newCreditStatus as never,
      })
      .where(eq(vendorCredits.id, input.vendorCreditId))
      .returning();

    // Update bill's amountCredited and balanceDue. Credits are tracked separately
    // from cash payments (amountPaid) so reports/void-guards don't conflate them:
    // balanceDue = total - amountPaid - amountCredited.
    const newAmountCredited = Money.round2(Money.of(bill.amountCredited).plus(applyAmount));
    const newBalanceDue = Money.round2(balanceDue.minus(applyAmount));
    const newBillStatus = newBalanceDue.isZero()
      ? 'paid'
      : Money.of(bill.amountPaid).plus(newAmountCredited).greaterThan(0)
        ? 'partial'
        : 'open';

    const [updatedBill] = await tx.db
      .update(bills)
      .set({
        amountCredited: toAmountString(newAmountCredited),
        balanceDue: toAmountString(newBalanceDue),
        status: newBillStatus as never,
        updatedAt: new Date(),
      })
      .where(eq(bills.id, input.billId))
      .returning();

    await writeAudit(tx, {
      action: 'update',
      entityType: 'vendor_credit',
      entityId: input.vendorCreditId,
      newValues: {
        action: 'applied_to_bill',
        billId: input.billId,
        amount: toAmountString(applyAmount),
        newUnapplied: toAmountString(newUnapplied),
      },
    });

    return { credit: updatedCredit, bill: updatedBill };
  });
}

// ---------------------------------------------------------------------------
// unapplyFromBill
// ---------------------------------------------------------------------------

export interface UnapplyFromBillInput {
  vendorCreditId: string;
  billId: string;
  /** Amount to unapply (must be <= credit's applied amount and <= bill.amountCredited). */
  amount: string | number;
  /** p1 fx: date of the reversing exchange gain/loss entry (default today). */
  date?: Date | null;
}

/**
 * Reverse a previous applyToBill: restore the credit's unapplied balance and
 * give the bill back its balanceDue. No GL entry is involved (same as apply).
 * This makes the "unapply first" instructions in voidBill / voidVendorCredit
 * actually satisfiable.
 */
/**
 * Net amount a vendor credit has applied to one bill (applications minus unapplications), from the
 * audit trail applyToBill / unapplyFromBill (home and foreign) write in the same transaction.
 */
export async function netAppliedToBill(ctx: ServiceContext, vendorCreditId: string, billId: string): Promise<Decimal> {
  const rows = await ctx.db
    .select({ newValues: auditLogs.newValues })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.companyId, ctx.companyId),
        eq(auditLogs.entityType, 'vendor_credit'),
        eq(auditLogs.entityId, vendorCreditId),
        sql`${auditLogs.newValues}->>'billId' = ${billId}`,
        sql`${auditLogs.newValues}->>'action' IN ('applied_to_bill', 'unapplied_from_bill')`,
      ),
    );
  let net = Money.zero();
  for (const r of rows) {
    const nv = (r.newValues ?? {}) as { action?: string; amount?: string };
    const a = Money.of(nv.amount ?? '0');
    net = nv.action === 'applied_to_bill' ? net.plus(a) : net.minus(a);
  }
  return Money.round2(net);
}

export async function unapplyFromBill(ctx: ServiceContext, input: UnapplyFromBillInput) {
  const unapplyAmount = Money.round2(input.amount);

  if (!unapplyAmount.greaterThan(0)) {
    throw validation('Unapply amount must be greater than zero.');
  }

  // Load the vendor credit (scoped to company).
  const [credit] = await ctx.db
    .select()
    .from(vendorCredits)
    .where(and(eq(vendorCredits.id, input.vendorCreditId), eq(vendorCredits.companyId, ctx.companyId)));
  if (!credit) throw notFound('Vendor credit');

  if (credit.status === 'void') {
    throw new ServiceError('CONFLICT', 'Cannot unapply a voided vendor credit.');
  }

  const appliedTotal = Money.of(credit.total).minus(Money.of(credit.unapplied));
  if (unapplyAmount.greaterThan(appliedTotal)) {
    throw validation(
      `Unapply amount ${toAmountString(unapplyAmount)} exceeds the credit's applied amount ${toAmountString(appliedTotal)}.`,
    );
  }

  // Load the bill (scoped to company).
  const [bill] = await ctx.db
    .select()
    .from(bills)
    .where(and(eq(bills.id, input.billId), eq(bills.companyId, ctx.companyId)));
  if (!bill) throw notFound('Bill');

  if (bill.status === 'void') {
    throw new ServiceError('CONFLICT', 'Cannot unapply a credit from a voided bill.');
  }
  await assertAccountantDatesOpen(ctx, [credit.date, bill.date], 'The vendor credit or bill');
  if (credit.vendorId !== bill.vendorId) {
    throw validation('Vendor credit and bill must belong to the same vendor.');
  }

  const billCredited = Money.of(bill.amountCredited);
  if (unapplyAmount.greaterThan(billCredited)) {
    throw validation(
      `Unapply amount ${toAmountString(unapplyAmount)} exceeds the bill's credited amount ${toAmountString(billCredited)}.`,
    );
  }
  // Only what THIS credit applied to THIS bill can come off it (refunds are not applications).
  const pairApplied = await netAppliedToBill(ctx, credit.id, bill.id);
  if (unapplyAmount.greaterThan(pairApplied)) {
    throw validation(
      `Unapply amount ${toAmountString(unapplyAmount)} exceeds the ${toAmountString(pairApplied)} this vendor credit has applied to this bill.`,
      { appliedToBill: toAmountString(pairApplied) },
    );
  }
  const creditCurrency = await foreignCurrencyOf(ctx, credit.currency);
  const billCurrency = await foreignCurrencyOf(ctx, bill.currency);
  const unapplyDate = await vendorCreditApplicationDate(ctx, credit, bill, input.date, 'unapply');
  if (creditCurrency || billCurrency) {
    return unapplyForeignVendorCredit(
      ctx,
      { ...credit, currency: creditCurrency },
      { ...bill, currency: billCurrency },
      unapplyAmount,
      unapplyDate,
    );
  }

  return inTransaction(ctx, async (tx) => {
    // Restore the credit's unapplied balance.
    const newUnapplied = Money.round2(Money.of(credit.unapplied).plus(unapplyAmount));
    const newCreditStatus = newUnapplied.greaterThanOrEqualTo(Money.of(credit.total))
      ? 'open'
      : 'partial';

    const [updatedCredit] = await tx.db
      .update(vendorCredits)
      .set({
        unapplied: toAmountString(newUnapplied),
        status: newCreditStatus as never,
      })
      .where(eq(vendorCredits.id, input.vendorCreditId))
      .returning();

    // Restore the bill's balanceDue and reduce amountCredited.
    const newAmountCredited = Money.round2(billCredited.minus(unapplyAmount));
    const newBalanceDue = Money.round2(Money.of(bill.balanceDue).plus(unapplyAmount));
    const newBillStatus = newBalanceDue.isZero()
      ? 'paid'
      : Money.of(bill.amountPaid).plus(newAmountCredited).greaterThan(0)
        ? 'partial'
        : 'open';

    const [updatedBill] = await tx.db
      .update(bills)
      .set({
        amountCredited: toAmountString(newAmountCredited),
        balanceDue: toAmountString(newBalanceDue),
        status: newBillStatus as never,
        updatedAt: new Date(),
      })
      .where(eq(bills.id, input.billId))
      .returning();

    await writeAudit(tx, {
      action: 'update',
      entityType: 'vendor_credit',
      entityId: input.vendorCreditId,
      newValues: {
        action: 'unapplied_from_bill',
        billId: input.billId,
        amount: toAmountString(unapplyAmount),
        newUnapplied: toAmountString(newUnapplied),
      },
    });

    return { credit: updatedCredit, bill: updatedBill };
  });
}

// ---------------------------------------------------------------------------
// refundVendorCredit
// ---------------------------------------------------------------------------

export interface RefundVendorCreditInput {
  vendorCreditId: string;
  /** Bank account the vendor's refund is deposited into. */
  bankAccountId: string;
  /** Refund amount; must be <= the credit's unapplied balance. */
  amount: string | number;
  date?: Date | null;
  memo?: string | null;
  /** p1 fx: foreign credit — home units per 1 unit on the refund date (default: list rate). */
  exchangeRate?: string | number | null;
}

/**
 * Record a vendor refund (cash back) against a vendor credit's unapplied balance.
 *
 * Posting:
 *   Dr  bank account              amount   — money arrives in the bank
 *   Cr  2000 Accounts Payable     amount   — restores the A/P the credit debited
 *
 * The original credit debited A/P (reducing the liability); the vendor settling
 * that credit in cash restores A/P by the same amount while the credit's
 * unapplied balance is consumed (refundedAmount += amount). Net A/P from the
 * credit + refund pair is zero, and the A/P control account stays equal to the
 * open-bill / open-credit subledger.
 */
export async function refundVendorCredit(ctx: ServiceContext, input: RefundVendorCreditInput) {
  const [credit] = await ctx.db
    .select()
    .from(vendorCredits)
    .where(
      and(eq(vendorCredits.id, input.vendorCreditId), eq(vendorCredits.companyId, ctx.companyId)),
    );
  if (!credit) throw notFound('Vendor credit');
  if (credit.status === 'void') {
    throw new ServiceError('CONFLICT', 'Cannot refund a voided vendor credit.');
  }

  const amount = Money.round2(input.amount);
  if (!amount.greaterThan(0)) throw validation('Refund amount must be greater than zero.');
  const unapplied = Money.of(credit.unapplied);
  if (amount.greaterThan(unapplied)) {
    throw validation(
      `Refund amount ${toAmountString(amount)} exceeds the credit's unapplied balance ${toAmountString(unapplied)}.`,
    );
  }

  // p1 fx: a foreign credit's refund is taken at its booked rate, banked at the refund's rate.
  if (credit.currency) {
    return refundForeignVendorCredit(ctx, credit, {
      bankAccountId: input.bankAccountId,
      amount,
      date: input.date,
      memo: input.memo,
      exchangeRate: input.exchangeRate,
    });
  }

  // Validate the bank account: company-owned bank/cash asset.
  const [bankAcct] = await ctx.db
    .select({ id: accounts.id, type: accounts.type, subtype: accounts.subtype, currency: accounts.currency })
    .from(accounts)
    .where(and(eq(accounts.id, input.bankAccountId), eq(accounts.companyId, ctx.companyId)));
  if (!bankAcct) throw notFound('Bank account');
  const refundCur = await foreignCurrencyOf(ctx, bankAcct.currency);
  if (refundCur) {
    throw validation(`This is a ${refundCur} account. Vendor refunds can only go into a home-currency bank account.`);
  }
  // Bank accounts, Undeposited Funds or another cash-like current asset (lib/accountTypes.ts).
  if (!isDepositTargetAccount(bankAcct)) {
    throw validation('Vendor refunds must be deposited into a bank/cash account.');
  }

  const apAccountId = await resolveApAccount(ctx);
  const refundDate = vendorCreditRefundDate(credit, input.date);

  return inTransaction(ctx, async (tx) => {
    // 1. Post the refund receipt.
    const entry = await postJournalEntry(tx, {
      date: refundDate,
      description: input.memo ?? 'Vendor refund received',
      sourceRef: `refund:${input.vendorCreditId}`,
      lines: [
        {
          accountId: input.bankAccountId,
          debit: toAmountString(amount),
          memo: 'Vendor refund deposited',
        },
        {
          accountId: apAccountId,
          credit: toAmountString(amount),
          memo: 'Vendor credit settled in cash',
          controlLine: true,
        },
      ],
    });

    // 2. Consume the credit's unapplied balance.
    const newUnapplied = Money.round2(unapplied.minus(amount));
    const newRefunded = Money.round2(Money.of(credit.refundedAmount).plus(amount));
    const newStatus = newUnapplied.isZero() ? 'closed' : 'partial';

    const [updatedCredit] = await tx.db
      .update(vendorCredits)
      .set({
        unapplied: toAmountString(newUnapplied),
        refundedAmount: toAmountString(newRefunded),
        status: newStatus as never,
      })
      .where(eq(vendorCredits.id, input.vendorCreditId))
      .returning();

    await writeAudit(tx, {
      action: 'update',
      entityType: 'vendor_credit',
      entityId: input.vendorCreditId,
      oldValues: {
        unapplied: toAmountString(unapplied),
        refundedAmount: credit.refundedAmount,
        status: credit.status,
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

    return { credit: updatedCredit, entry };
  });
}

// ---------------------------------------------------------------------------
// voidVendorCredit
// ---------------------------------------------------------------------------

export async function voidVendorCredit(ctx: ServiceContext, id: string) {
  const [credit] = await ctx.db
    .select()
    .from(vendorCredits)
    .where(and(eq(vendorCredits.id, id), eq(vendorCredits.companyId, ctx.companyId)));
  if (!credit) throw notFound('Vendor credit');

  if (credit.status === 'void') {
    // Idempotent.
    return credit;
  }

  // Block voiding if the credit has been partially or fully applied.
  const appliedAmount = Money.of(credit.total).minus(Money.of(credit.unapplied));
  if (appliedAmount.greaterThan(0)) {
    throw new ServiceError(
      'CONFLICT',
      'Cannot void a vendor credit that has been applied to a bill. Unapply first.',
    );
  }

  return inTransaction(ctx, async (tx) => {
    // p1 fx: settled (applied, then unapplied) foreign applications go with the credit.
    await clearSettledForeignApplications(tx, { vendorCreditId: id });
    // Reverse the GL entry.
    if (credit.postedEntryId) {
      await voidJournalEntry(tx, credit.postedEntryId);
    }
    // Returned items come back on hand at the cost they left with.
    await restoreCreditStock(tx, credit);

    const [updated] = await tx.db
      .update(vendorCredits)
      .set({ status: 'void', unapplied: '0.00', ...(credit.currency ? { homeUnapplied: '0.00' } : {}) })
      .where(eq(vendorCredits.id, id))
      .returning();

    await writeAudit(tx, {
      action: 'void',
      entityType: 'vendor_credit',
      entityId: id,
      oldValues: { status: credit.status },
      newValues: { status: 'void' },
    });

    return updated;
  });
}
