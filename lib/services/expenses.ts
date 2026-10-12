/**
 * Expenses service — QB "Write Checks" / "Enter Credit Card Charges" (direct non-bill spend).
 *
 * An expense records money leaving a payment account WITHOUT going through A/P:
 *
 *   method 'check' | 'cash' (bank/cash payment account):
 *     Dr  each expense line account
 *     Cr  payment account                       — classic Write Checks
 *
 *   method 'credit_card' (credit-card liability payment account):
 *     Dr  each expense line account
 *     Cr  credit-card liability                 — QB "Enter Credit Card Charge"
 *
 *   credit-card CREDIT (refund flag, or negative line total):
 *     Dr  credit-card liability
 *     Cr  each expense line account             — QB "Enter Credit Card Credit"
 *
 * Items tab (wave2 D2): a line may reference an item instead of a GL account (quantity x unit
 * cost). Inventory items debit the item's inventory asset account (item.assetAccountId ?? 1300)
 * and receive stock in the SAME transaction through the bill receipt logic
 * (bills.receivePurchasedStock: FIFO layer or weighted-average update + site/bin movements);
 * non-inventory / service items debit line.accountId ?? item.expenseAccountId.
 *
 * Multi-currency (wave2 J10): the expense carries `currency` / `exchangeRate`; amounts are stored
 * in the transaction currency and posted in home currency (one anchor, penny-allocated lines).
 *
 * Edit after save (wave2 D1): updateExpense follows the sanctioned void + repost pattern in one
 * transaction (see postedEdit.ts); a ledger-neutral edit (memo / payee / number) leaves the entry
 * alone, which is what lets you fix the memo of a reconciled check.
 *
 * All GL writes go through postJournalEntry with sourceRef "expense:<id>". Check numbers come
 * from lib/services/checkNumbers (duplicate numbers are refused unless the user confirmed).
 *
 * Print queue: a method='check' expense saved with toPrint=true has NO check number yet — it
 * sits in the Print Checks queue until markExpensePrinted stamps a number and clears the flag.
 *
 * Multi-tenant safety: every query is scoped by ctx.companyId.
 * Money: all arithmetic uses Money/toAmountString — never JS floats.
 */
import { isBankAccount, isCreditCardAccount } from '@/lib/accountTypes';
import { and, asc, desc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import type Decimal from 'decimal.js';
import { Money, toAmountString } from '@/lib/money';
import {
  accounts,
  classes,
  customers,
  expenseLines,
  expenses,
  items,
  jobs,
  journalEntries,
  loanPayments,
  vendors,
} from '@/lib/db/schema';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { postJournalEntry, voidJournalEntry, type PostingLine } from './posting';
import { assertCheckNumberAvailable, nextCheckNumber } from './checkNumbers';
import { homeAmounts, resolveDocumentCurrency } from './currencies';
import { receivePurchasedStock, reversePurchasedStock } from './bills';
import {
  type InventoryLineDetail,
  attachInventoryDetails,
  postDocumentInventory,
  reverseDocumentInventory,
} from './inventorySites';
import { planPostedEdit, retitleEntry } from './postedEdit';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExpenseMethod = 'check' | 'cash' | 'credit_card';

export interface ExpenseLineInput extends InventoryLineDetail {
  /** GL account. Required unless itemId is set (Items tab). */
  accountId?: string | null;
  /** Item purchased (Items tab) — inventory items receive stock. */
  itemId?: string | null;
  /** Units purchased (item lines; > 0). */
  quantity?: string | number | null;
  /** Per-unit cost (item lines). Provide unitCost or amount (or both). */
  unitCost?: string | number | null;
  description?: string | null;
  /** Decimal string/number. Positive normally; all-negative lines flip into a CC credit. */
  amount?: string | number | null;
  classId?: string | null;
  /** Billable customer (and optional job) for job costing. */
  customerId?: string | null;
  jobId?: string | null;
}

export interface CreateExpenseInput {
  /** Either a vendor or a free-text payee name (at least one required). */
  vendorId?: string | null;
  payeeName?: string | null;
  date: Date;
  method: ExpenseMethod;
  /** Check number (method='check'). Auto-assigned from the sequence when omitted, unless toPrint. */
  reference?: string | null;
  /** Funding account — bank/cash asset for check/cash, credit-card liability for credit_card. */
  paymentAccountId: string;
  memo?: string | null;
  lines: ExpenseLineInput[];
  /** Queue this check for Print Checks; number is stamped at print time. method='check' only. */
  toPrint?: boolean;
  /** Credit-card credit (vendor refund): Dr CC liability / Cr expense lines. method='credit_card' only. */
  isRefund?: boolean;
  /** Transaction currency (defaults to the payment account's / vendor's currency). */
  currency?: string | null;
  /** Home units per 1 transaction unit (defaults to the currency list rate). */
  exchangeRate?: string | number | null;
  /**
   * QB duplicate check-number warning (A3): when true, a check number already used on the same
   * bank account is refused (CONFLICT, details.duplicateNumber) — user-facing routes set it
   * unless the user confirmed the duplicate.
   */
  checkDuplicateNumber?: boolean;
}

type ResolvedExpenseLine = {
  accountId: string;
  itemId: string | null;
  isInventory: boolean;
  quantity: string | null; // 4dp (item lines)
  /** Transaction-currency unit cost as entered (item lines), 4dp. */
  unitCostTxn: string | null;
  /** HOME-currency unit cost for the stock subledger (inventory lines). */
  unitCostHome: Decimal | null;
  /** Signed 2dp amount in the transaction currency (negative on CC credits). */
  amount: string;
  /** Absolute 2dp home-currency amount posted to the GL. */
  homeAmount: string;
  description: string | null;
  classId: string | null;
  customerId: string | null;
  jobId: string | null;
  /**
   * Name on the GL line (wave2 foundation): a line on A/R carries the line's customer and a line
   * on A/P the payee vendor, so A/R / A/P aging sees it (posting.ts guard).
   */
  entity: { entityType: 'customer' | 'vendor'; entityId: string } | null;
};

interface PreparedExpense {
  payeeDisplay: string;
  isRefund: boolean;
  /** Absolute transaction-currency total. */
  absTotal: Decimal;
  homeTotalStr: string;
  currency: string | null;
  rate: Decimal;
  lines: ResolvedExpenseLine[];
}

// ---------------------------------------------------------------------------
// prepareExpense — validation + line resolution shared by create / update
// ---------------------------------------------------------------------------

async function accountIdByCode(ctx: ServiceContext, code: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
  if (!row) throw notFound(`Account with code ${code}`);
  return row.id;
}

async function prepareExpense(ctx: ServiceContext, input: CreateExpenseInput): Promise<PreparedExpense> {
  // ── payee ─────────────────────────────────────────────────────────────────
  let payeeDisplay = input.payeeName?.trim() || '';
  // undefined = free-text payee (any account currency); null = home-currency vendor.
  let vendorCurrency: string | null | undefined = undefined;
  if (input.vendorId) {
    const [vendor] = await ctx.db
      .select({ id: vendors.id, name: vendors.displayName, currency: vendors.currency })
      .from(vendors)
      .where(and(eq(vendors.id, input.vendorId), eq(vendors.companyId, ctx.companyId)));
    if (!vendor) throw notFound('Vendor');
    if (!payeeDisplay) payeeDisplay = vendor.name;
    vendorCurrency = vendor.currency ?? null;
  }
  if (!payeeDisplay) {
    throw validation('A vendor or a payee name is required.');
  }

  if (!['check', 'cash', 'credit_card'].includes(input.method)) {
    throw validation(`Unsupported expense method '${input.method}'.`);
  }

  // ── payment account: ownership + type fit for the method ────────────────
  const [payAcct] = await ctx.db
    .select({
      id: accounts.id,
      type: accounts.type,
      subtype: accounts.subtype,
      name: accounts.name,
      currency: accounts.currency,
    })
    .from(accounts)
    .where(and(eq(accounts.id, input.paymentAccountId), eq(accounts.companyId, ctx.companyId)));
  if (!payAcct) throw notFound('Payment account');

  // QB parity: checks and cash expenses come from a Bank account (lib/accountTypes.ts).
  const isBankish = isBankAccount(payAcct);
  const isCreditCard = isCreditCardAccount(payAcct);

  if (input.method === 'credit_card') {
    if (!isCreditCard) {
      throw validation('Credit card charges must use a credit-card liability account as the payment account.');
    }
  } else if (!isBankish) {
    throw validation('Checks and cash expenses must be paid from a bank/cash account.');
  }

  // ── lines ─────────────────────────────────────────────────────────────────
  if (!input.lines || input.lines.length === 0) {
    throw validation('At least one expense line is required.');
  }

  const itemIds = [...new Set(input.lines.filter((l) => l.itemId).map((l) => l.itemId as string))];
  const itemMap = new Map<
    string,
    { type: string; name: string; assetAccountId: string | null; expenseAccountId: string | null }
  >();
  if (itemIds.length > 0) {
    const rows = await ctx.db
      .select({
        id: items.id,
        type: items.type,
        name: items.name,
        assetAccountId: items.assetAccountId,
        expenseAccountId: items.expenseAccountId,
      })
      .from(items)
      .where(and(eq(items.companyId, ctx.companyId), inArray(items.id, itemIds)));
    for (const r of rows) itemMap.set(r.id, r);
    for (const id of itemIds) if (!itemMap.has(id)) throw notFound(`Item ${id}`);
  }

  let defaultInventoryAcctId: string | null = null;
  let total = Money.zero();
  let sawNegative = false;
  let sawPositive = false;
  const lines: ResolvedExpenseLine[] = [];

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
      const amount =
        line.amount != null ? Money.round2(line.amount) : Money.round2(qty.times(Money.of(line.unitCost!)));
      if (!amount.greaterThan(0)) {
        throw validation(`Line ${i + 1}: item line amounts must be greater than zero.`);
      }
      const unitCost = line.unitCost != null ? Money.of(line.unitCost) : amount.dividedBy(qty);
      if (unitCost.isNegative()) throw validation(`Line ${i + 1}: unit cost cannot be negative.`);
      const isInventory = item.type === 'inventory';
      let accountId: string;
      if (isInventory) {
        accountId = item.assetAccountId ?? (defaultInventoryAcctId ??= await accountIdByCode(ctx, '1300'));
      } else {
        const routed = line.accountId ?? item.expenseAccountId;
        if (!routed) {
          throw validation(
            `Line ${i + 1}: item "${item.name}" has no expense account — set one on the item or pick an account.`,
          );
        }
        accountId = routed;
      }
      sawPositive = true;
      total = total.plus(amount);
      lines.push({
        accountId,
        itemId: line.itemId,
        isInventory,
        quantity: qty.toFixed(4),
        unitCostTxn: unitCost.toFixed(4),
        unitCostHome: isInventory ? unitCost : null,
        amount: toAmountString(amount),
        homeAmount: toAmountString(amount),
        description: line.description?.trim() || item.name,
        classId: line.classId ?? null,
        customerId: line.customerId ?? null,
        jobId: line.jobId ?? null,
        entity: null,
      });
    } else {
      if (!line.accountId) throw validation(`Line ${i + 1}: select an account or an item.`);
      const amt = Money.round2(line.amount ?? 0);
      if (amt.isZero()) throw validation(`Line ${i + 1}: amount cannot be zero.`);
      if (amt.isNegative()) sawNegative = true;
      else sawPositive = true;
      total = total.plus(amt);
      lines.push({
        accountId: line.accountId,
        itemId: null,
        isInventory: false,
        quantity: null,
        unitCostTxn: null,
        unitCostHome: null,
        amount: toAmountString(amt),
        homeAmount: toAmountString(amt.abs()),
        description: line.description?.trim() || null,
        classId: line.classId ?? null,
        customerId: line.customerId ?? null,
        jobId: line.jobId ?? null,
        entity: null,
      });
    }
  }
  if (sawNegative && sawPositive) {
    throw validation('Mixed positive and negative line amounts are not supported. Enter a charge or a credit, not both.');
  }

  // Negative total (or explicit flag) = credit-card credit.
  const isRefund = Boolean(input.isRefund) || sawNegative;
  if (isRefund && input.method !== 'credit_card') {
    throw validation('Refunds/credits are only supported for the credit_card method. Record a vendor refund check as a deposit.');
  }
  if (isRefund && lines.some((l) => l.itemId)) {
    throw validation(
      'Item lines are not supported on a credit card credit. Record returned items with a vendor credit or an inventory adjustment.',
    );
  }
  const absTotal = total.abs();
  if (absTotal.isZero()) throw validation('Expense total must be non-zero.');

  // Validate line GL accounts belong to the company and are not the payment account.
  const lineAccountIds = [...new Set(lines.map((l) => l.accountId))];
  const acctRows = await ctx.db
    .select({ id: accounts.id, type: accounts.type, subtype: accounts.subtype })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), inArray(accounts.id, lineAccountIds)));
  const acctById = new Map(acctRows.map((a) => [a.id, a]));
  const ownedAccountIds = new Set(acctRows.map((a) => a.id));
  for (const id of lineAccountIds) {
    if (!ownedAccountIds.has(id)) throw notFound(`Account ${id}`);
    if (id === input.paymentAccountId) {
      throw validation('An expense line cannot post to the payment account itself. Use a transfer instead.');
    }
  }

  // QB: a check line on A/R (e.g. refunding a customer) carries that customer's name, and a
  // line on A/P carries the payee vendor, so A/R / A/P aging sees it (posting.ts guard).
  for (const l of lines) {
    const acct = acctById.get(l.accountId);
    const isAr = acct?.type === 'asset' && acct.subtype === 'accounts_receivable';
    const isAp = acct?.type === 'liability' && acct.subtype === 'accounts_payable';
    l.entity =
      isAr && l.customerId
        ? { entityType: 'customer', entityId: l.customerId }
        : isAp && input.vendorId
          ? { entityType: 'vendor', entityId: input.vendorId }
          : null;
  }

  // Validate optional dimensions (class / billable customer / job) belong to the company.
  await assertDimensionsOwned(ctx, input.lines);

  // ── currency: account currency, else vendor currency ─────────────────────
  const fx = await resolveDocumentCurrency(ctx, {
    currency: input.currency,
    exchangeRate: input.exchangeRate,
    vendorCurrency,
    accountCurrency: payAcct.currency ?? null,
  });
  const home = homeAmounts(
    lines.map((l) => Money.of(l.amount).abs()),
    fx.rate,
  );
  if (fx.currency) {
    lines.forEach((l, i) => {
      if (!home.lines[i].greaterThan(0)) {
        throw validation(`Line ${i + 1}: the amount is too small to convert to your home currency.`);
      }
      l.homeAmount = toAmountString(home.lines[i]);
      if (l.isInventory) l.unitCostHome = home.lines[i].dividedBy(Money.of(l.quantity!));
    });
  }

  return {
    payeeDisplay,
    isRefund,
    absTotal,
    homeTotalStr: toAmountString(home.total),
    currency: fx.currency,
    rate: fx.rate,
    lines,
  };
}

function buildGlLines(prep: PreparedExpense, method: ExpenseMethod, paymentAccountId: string): PostingLine[] {
  // Charge: Dr expense lines / Cr payment. Credit: Dr payment / Cr expense lines.
  const gl: PostingLine[] = prep.lines.map((l) => ({
    accountId: l.accountId,
    ...(prep.isRefund ? { credit: l.homeAmount } : { debit: l.homeAmount }),
    memo: l.description,
    classId: l.classId,
    ...(l.entity ?? {}),
  }));
  gl.push({
    accountId: paymentAccountId,
    ...(prep.isRefund ? { debit: prep.homeTotalStr } : { credit: prep.homeTotalStr }),
    memo: entryDescription(prep, method),
    // p1 fx: a foreign-currency bank / card line keeps the amount in its own currency.
    ...(prep.currency ? { foreignAmount: toAmountString(prep.absTotal) } : {}),
  });
  return gl;
}

function entryDescription(prep: PreparedExpense, method: ExpenseMethod): string {
  return prep.isRefund
    ? `Credit card credit — ${prep.payeeDisplay}`
    : `${methodLabel(method)} — ${prep.payeeDisplay}`;
}

function lineRowsFor(expenseId: string, prep: PreparedExpense) {
  return prep.lines.map((l, i) => ({
    expenseId,
    accountId: l.accountId,
    itemId: l.itemId,
    quantity: l.quantity,
    unitCost: l.unitCostTxn,
    description: l.description,
    amount: l.amount,
    classId: l.classId,
    customerId: l.customerId,
    jobId: l.jobId,
    lineOrder: i,
  }));
}

/** Receive stock + site movements for the expense's inventory item lines. */
async function receiveExpenseStock(
  tx: ServiceContext,
  expenseId: string,
  date: Date,
  input: CreateExpenseInput,
  prep: PreparedExpense,
  opts: { reason: string; carryForward?: boolean },
) {
  if (!prep.lines.some((l) => l.isInventory)) return;
  await receivePurchasedStock(
    tx,
    `expense:${expenseId}`,
    date,
    prep.lines.map((l) => ({
      itemId: l.itemId,
      isInventory: l.isInventory,
      quantity: l.quantity ?? '0',
      unitCost: l.unitCostHome,
    })),
    `${opts.reason}:${expenseId}`,
  );
  await postDocumentInventory(tx, {
    sourceType: 'expense',
    sourceId: expenseId,
    date,
    direction: 'in',
    lines: prep.lines.map((l, idx) => {
      const src = input.lines[idx];
      return {
        lineOrder: idx,
        itemId: l.isInventory ? l.itemId : null,
        quantity: l.quantity ?? '0',
        siteId: src?.siteId,
        binId: src?.binId,
        serialNumbers: src?.serialNumbers,
        lotNumber: src?.lotNumber,
        lotExpiration: src?.lotExpiration,
      };
    }),
    memo: `Check/charge ${prep.payeeDisplay}`,
    carryForward: opts.carryForward,
  });
}

/** Pull the stock received by an expense's saved item lines back out (void / edit). */
async function reverseExpenseStock(tx: ServiceContext, expense: typeof expenses.$inferSelect, reason: string) {
  const saved = await tx.db
    .select()
    .from(expenseLines)
    .where(eq(expenseLines.expenseId, expense.id))
    .orderBy(asc(expenseLines.lineOrder));
  if (!saved.some((l) => l.itemId)) return;
  const home = homeAmounts(
    saved.map((l) => Money.of(l.amount).abs()),
    expense.currency ? (expense.exchangeRate ?? 1) : 1,
  );
  await reversePurchasedStock(
    tx,
    saved.map((l, i) => ({ itemId: l.itemId, quantity: l.quantity ?? '0', homeAmount: home.lines[i] })),
    `${reason}:${expense.id}`,
    "this check's",
  );
  await reverseDocumentInventory(tx, 'expense', expense.id);
}

// ---------------------------------------------------------------------------
// createExpense
// ---------------------------------------------------------------------------

export async function createExpense(ctx: ServiceContext, input: CreateExpenseInput) {
  const prep = await prepareExpense(ctx, input);

  // ── check-number handling ─────────────────────────────────────────────────
  const toPrint = Boolean(input.toPrint) && input.method === 'check';
  let reference = input.reference?.trim() || null;
  if (input.method !== 'check') {
    // keep whatever reference the user typed (e.g. CC slip number)
  } else if (toPrint) {
    reference = null; // number is stamped at print time
  } else if (!reference) {
    reference = await nextCheckNumber(ctx, input.paymentAccountId);
  } else if (input.checkDuplicateNumber) {
    await assertCheckNumberAvailable(ctx, { paymentAccountId: input.paymentAccountId, number: reference });
  }

  // ── transaction: insert expense + lines, post GL, link entry ─────────────
  return inTransaction(ctx, async (tx) => {
    const [expense] = await tx.db
      .insert(expenses)
      .values({
        companyId: tx.companyId,
        vendorId: input.vendorId ?? null,
        payeeName: prep.payeeDisplay,
        date: input.date,
        method: input.method,
        reference,
        paymentAccountId: input.paymentAccountId,
        total: prep.isRefund ? toAmountString(prep.absTotal.negated()) : toAmountString(prep.absTotal),
        memo: input.memo?.trim() || null,
        toPrint,
        currency: prep.currency,
        exchangeRate: prep.currency ? prep.rate.toFixed(8) : null,
      })
      .returning();

    const lineRows = lineRowsFor(expense.id, prep);
    await tx.db.insert(expenseLines).values(lineRows);

    const entry = await postJournalEntry(tx, {
      date: input.date,
      description: entryDescription(prep, input.method),
      reference,
      sourceRef: `expense:${expense.id}`,
      lines: buildGlLines(prep, input.method, input.paymentAccountId),
    });

    const [updated] = await tx.db
      .update(expenses)
      .set({ postedEntryId: entry.id })
      .where(eq(expenses.id, expense.id))
      .returning();

    await receiveExpenseStock(tx, expense.id, input.date, input, prep, { reason: 'expense_receipt' });

    await writeAudit(tx, {
      action: 'create',
      entityType: 'expense',
      entityId: expense.id,
      newValues: {
        payee: prep.payeeDisplay,
        method: input.method,
        reference,
        paymentAccountId: input.paymentAccountId,
        total: updated.total,
        currency: prep.currency,
        exchangeRate: prep.currency ? prep.rate.toFixed(8) : null,
        isRefund: prep.isRefund,
        toPrint,
        postedEntryId: entry.id,
        lines: lineRows.map(({ expenseId: _e, ...rest }) => rest),
      },
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// updateExpense — edit a saved check / cash expense / credit-card charge (D1)
// ---------------------------------------------------------------------------

/**
 * Edit a saved expense. All inside ONE transaction:
 *   - ledger-neutral edit (same date, accounts, amounts, classes, items and quantities):
 *     only the header + line descriptions/billable fields change; the entry is kept
 *     (allowed even when the check was cleared in a completed reconciliation).
 *   - otherwise: void the entry (closing date checked on the OLD date), pull received stock back
 *     out, replace the lines, post a fresh entry (closing date checked on the NEW date) and
 *     receive stock again. Refused when a line was cleared in a completed reconciliation, was
 *     already billed to a customer invoice, or the check carries a Loan Manager payment.
 */
export async function updateExpense(ctx: ServiceContext, id: string, input: CreateExpenseInput) {
  const [existing] = await ctx.db
    .select()
    .from(expenses)
    .where(and(eq(expenses.id, id), eq(expenses.companyId, ctx.companyId)));
  if (!existing) throw notFound('Expense');
  if (existing.voidedAt) throw new ServiceError('CONFLICT', 'This transaction is void and cannot be edited.');

  const prep = await prepareExpense(ctx, input);

  // Check number: keep the saved one unless the user typed another; print-later clears it.
  const toPrint = Boolean(input.toPrint) && input.method === 'check';
  let reference = input.reference?.trim() || null;
  if (input.method === 'check') {
    if (toPrint) reference = null;
    else if (!reference) reference = existing.reference ?? (await nextCheckNumber(ctx, input.paymentAccountId));
    if (reference && input.checkDuplicateNumber && reference !== (existing.reference ?? '').trim()) {
      await assertCheckNumberAvailable(ctx, {
        paymentAccountId: input.paymentAccountId,
        number: reference,
        exclude: { source: 'expense', id },
      });
    }
  }

  return inTransaction(ctx, async (tx) => {
    const [cur] = await tx.db.select().from(expenses).where(eq(expenses.id, id));
    if (!cur || cur.voidedAt) throw new ServiceError('CONFLICT', 'This transaction is void and cannot be edited.');
    const oldLines = await tx.db
      .select()
      .from(expenseLines)
      .where(eq(expenseLines.expenseId, id))
      .orderBy(asc(expenseLines.lineOrder));

    const glLines = buildGlLines(prep, input.method, input.paymentAccountId);
    const sameItems =
      oldLines.length === prep.lines.length &&
      oldLines.every(
        (o, i) =>
          (o.itemId ?? null) === prep.lines[i].itemId &&
          Money.of(o.quantity ?? 0).equals(Money.of(prep.lines[i].quantity ?? 0)),
      );
    const sameCurrency = (cur.currency ?? null) === prep.currency;
    let plan = await planPostedEdit(tx, {
      entryId: cur.postedEntryId,
      date: input.date,
      lines: glLines,
      what: input.method === 'credit_card' ? 'charge' : 'check',
    });
    if (plan === 'unchanged' && !(sameItems && sameCurrency && cur.method === input.method)) plan = 'repost';

    const header = {
      vendorId: input.vendorId ?? null,
      payeeName: prep.payeeDisplay,
      date: input.date,
      method: input.method,
      reference,
      paymentAccountId: input.paymentAccountId,
      total: prep.isRefund ? toAmountString(prep.absTotal.negated()) : toAmountString(prep.absTotal),
      memo: input.memo?.trim() || null,
      toPrint,
      currency: prep.currency,
      exchangeRate: prep.currency ? prep.rate.toFixed(8) : null,
    };

    let entryId = cur.postedEntryId;
    if (plan === 'unchanged') {
      // Ledger untouched: header + non-financial line fields only.
      await tx.db.update(expenses).set(header).where(eq(expenses.id, id));
      for (const [i, o] of oldLines.entries()) {
        await tx.db
          .update(expenseLines)
          .set({
            description: prep.lines[i].description,
            customerId: o.billedInvoiceId ? o.customerId : prep.lines[i].customerId,
            jobId: o.billedInvoiceId ? o.jobId : prep.lines[i].jobId,
            unitCost: prep.lines[i].unitCostTxn,
          })
          .where(eq(expenseLines.id, o.id));
      }
      await retitleEntry(tx, entryId, { description: entryDescription(prep, input.method), reference });
    } else {
      if (oldLines.some((l) => l.billedInvoiceId)) {
        throw new ServiceError(
          'CONFLICT',
          'A line of this transaction was already billed to a customer on an invoice. Remove it from that invoice before changing amounts or accounts.',
        );
      }
      const [loanLink] = await tx.db
        .select({ id: loanPayments.id })
        .from(loanPayments)
        .where(and(eq(loanPayments.companyId, tx.companyId), eq(loanPayments.expenseId, id)))
        .limit(1);
      if (loanLink) {
        throw new ServiceError(
          'CONFLICT',
          'This check is a Loan Manager payment. To change its amounts, void it and set up the loan payment again.',
        );
      }
      if (cur.postedEntryId) await voidJournalEntry(tx, cur.postedEntryId);
      await reverseExpenseStock(tx, cur, 'expense_edit');
      await tx.db.delete(expenseLines).where(eq(expenseLines.expenseId, id));
      await tx.db.insert(expenseLines).values(lineRowsFor(id, prep));
      const entry = await postJournalEntry(tx, {
        date: input.date,
        description: entryDescription(prep, input.method),
        reference,
        sourceRef: `expense:${id}`,
        lines: glLines,
      });
      entryId = entry.id;
      await tx.db.update(expenses).set({ ...header, postedEntryId: entry.id }).where(eq(expenses.id, id));
      await receiveExpenseStock(tx, id, input.date, input, prep, {
        reason: 'expense_edit_receipt',
        carryForward: true,
      });
    }

    const [updated] = await tx.db.select().from(expenses).where(eq(expenses.id, id));
    await writeAudit(tx, {
      action: 'update',
      entityType: 'expense',
      entityId: id,
      oldValues: {
        payee: cur.payeeName,
        date: cur.date,
        method: cur.method,
        reference: cur.reference,
        paymentAccountId: cur.paymentAccountId,
        total: cur.total,
        memo: cur.memo,
        postedEntryId: cur.postedEntryId,
        lines: oldLines.map((l) => ({ accountId: l.accountId, itemId: l.itemId, quantity: l.quantity, amount: l.amount })),
      },
      newValues: {
        payee: prep.payeeDisplay,
        date: input.date,
        method: input.method,
        reference,
        paymentAccountId: input.paymentAccountId,
        total: updated.total,
        memo: updated.memo,
        ledger: plan === 'unchanged' ? 'unchanged' : 'reposted',
        postedEntryId: entryId,
        lines: prep.lines.map((l) => ({ accountId: l.accountId, itemId: l.itemId, quantity: l.quantity, amount: l.amount })),
      },
    });
    return updated;
  });
}

function methodLabel(method: ExpenseMethod): string {
  switch (method) {
    case 'check':
      return 'Check';
    case 'cash':
      return 'Cash expense';
    case 'credit_card':
      return 'Credit card charge';
  }
}

async function assertDimensionsOwned(ctx: ServiceContext, lines: ExpenseLineInput[]) {
  const classIds = [...new Set(lines.map((l) => l.classId).filter((x): x is string => !!x))];
  const customerIds = [...new Set(lines.map((l) => l.customerId).filter((x): x is string => !!x))];
  const jobIds = [...new Set(lines.map((l) => l.jobId).filter((x): x is string => !!x))];

  for (const id of classIds) {
    const [row] = await ctx.db
      .select({ id: classes.id })
      .from(classes)
      .where(and(eq(classes.id, id), eq(classes.companyId, ctx.companyId)));
    if (!row) throw notFound(`Class ${id}`);
  }
  for (const id of customerIds) {
    const [row] = await ctx.db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.id, id), eq(customers.companyId, ctx.companyId)));
    if (!row) throw notFound(`Customer ${id}`);
  }
  for (const id of jobIds) {
    const [row] = await ctx.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.companyId, ctx.companyId)));
    if (!row) throw notFound(`Job ${id}`);
  }
}

// ---------------------------------------------------------------------------
// getExpense
// ---------------------------------------------------------------------------

export async function getExpense(ctx: ServiceContext, id: string) {
  const [expense] = await ctx.db
    .select()
    .from(expenses)
    .where(and(eq(expenses.id, id), eq(expenses.companyId, ctx.companyId)));
  if (!expense) throw notFound('Expense');

  const lines = await ctx.db
    .select()
    .from(expenseLines)
    .where(eq(expenseLines.expenseId, id))
    .orderBy(expenseLines.lineOrder);

  return { ...expense, lines: await attachInventoryDetails(ctx, 'expense', id, lines) };
}

// ---------------------------------------------------------------------------
// listExpenses
// ---------------------------------------------------------------------------

export interface ListExpensesOptions {
  vendorId?: string;
  method?: ExpenseMethod;
  paymentAccountId?: string;
  /** Only checks queued for printing (method='check', toPrint=true, not void). */
  toPrint?: boolean;
  includeVoided?: boolean;
  dateFrom?: Date;
  dateTo?: Date;
  limit?: number;
  offset?: number;
}

/** List expenses newest-first with the vendor display name joined in. */
export async function listExpenses(ctx: ServiceContext, opts?: ListExpensesOptions) {
  const conditions = [eq(expenses.companyId, ctx.companyId)];
  if (opts?.vendorId) conditions.push(eq(expenses.vendorId, opts.vendorId));
  if (opts?.method) conditions.push(eq(expenses.method, opts.method));
  if (opts?.paymentAccountId) conditions.push(eq(expenses.paymentAccountId, opts.paymentAccountId));
  if (opts?.toPrint) {
    conditions.push(eq(expenses.toPrint, true));
    conditions.push(eq(expenses.method, 'check'));
  }
  if (!opts?.includeVoided) conditions.push(isNull(expenses.voidedAt));
  if (opts?.dateFrom) conditions.push(gte(expenses.date, opts.dateFrom));
  if (opts?.dateTo) conditions.push(lte(expenses.date, opts.dateTo));

  const rows = await ctx.db
    .select({
      expense: expenses,
      vendorName: vendors.displayName,
      paymentAccountName: accounts.name,
    })
    .from(expenses)
    .leftJoin(vendors, eq(expenses.vendorId, vendors.id))
    .leftJoin(accounts, eq(expenses.paymentAccountId, accounts.id))
    .where(and(...conditions))
    .orderBy(desc(expenses.date), desc(expenses.createdAt))
    .limit(opts?.limit ?? 200)
    .offset(opts?.offset ?? 0);

  return rows.map((r) => ({
    ...r.expense,
    vendorName: r.vendorName ?? null,
    paymentAccountName: r.paymentAccountName ?? null,
  }));
}

/** The Print Checks queue: check expenses awaiting a printed number. */
export async function listPrintQueue(ctx: ServiceContext, paymentAccountId?: string) {
  return listExpenses(ctx, { toPrint: true, paymentAccountId });
}

// ---------------------------------------------------------------------------
// markExpensePrinted
// ---------------------------------------------------------------------------

/**
 * Stamp a printed check: assign the check number, clear the print flag, and
 * propagate the number onto the journal entry reference for traceability.
 */
export async function markExpensePrinted(
  ctx: ServiceContext,
  input: { expenseId: string; checkNumber?: string; allowDuplicateNumber?: boolean },
) {
  const [expense] = await ctx.db
    .select()
    .from(expenses)
    .where(and(eq(expenses.id, input.expenseId), eq(expenses.companyId, ctx.companyId)));
  if (!expense) throw notFound('Expense');
  if (expense.voidedAt) throw new ServiceError('CONFLICT', 'This expense is void and cannot be printed.');
  if (expense.method !== 'check') throw validation('Only check expenses can be printed.');
  if (!expense.toPrint) throw new ServiceError('CONFLICT', 'This check is not in the print queue.');

  const checkNumber =
    input.checkNumber?.trim() || (await nextCheckNumber(ctx, expense.paymentAccountId));
  await assertCheckNumberAvailable(ctx, {
    paymentAccountId: expense.paymentAccountId,
    number: checkNumber,
    exclude: { source: 'expense', id: expense.id },
    allowDuplicate: input.allowDuplicateNumber,
  });

  return inTransaction(ctx, async (tx) => {
    const [updated] = await tx.db
      .update(expenses)
      .set({ toPrint: false, reference: checkNumber })
      .where(eq(expenses.id, expense.id))
      .returning();

    if (expense.postedEntryId) {
      await tx.db
        .update(journalEntries)
        .set({ reference: checkNumber, updatedAt: new Date() })
        .where(
          and(
            eq(journalEntries.id, expense.postedEntryId),
            eq(journalEntries.companyId, tx.companyId),
          ),
        );
    }

    await writeAudit(tx, {
      action: 'update',
      entityType: 'expense',
      entityId: expense.id,
      oldValues: { toPrint: true, reference: expense.reference },
      newValues: { toPrint: false, reference: checkNumber },
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// voidExpense
// ---------------------------------------------------------------------------

/**
 * Void an expense: reverse its GL impact via voidJournalEntry, pull any stock received by item
 * lines back out, and stamp voidedAt.
 */
export async function voidExpense(ctx: ServiceContext, id: string) {
  const [expense] = await ctx.db
    .select()
    .from(expenses)
    .where(and(eq(expenses.id, id), eq(expenses.companyId, ctx.companyId)));
  if (!expense) throw notFound('Expense');
  if (expense.voidedAt) {
    throw new ServiceError('CONFLICT', 'This expense is already void.');
  }

  return inTransaction(ctx, async (tx) => {
    if (expense.postedEntryId) {
      await voidJournalEntry(tx, expense.postedEntryId);
    }
    await reverseExpenseStock(tx, expense, 'expense_void');

    const [updated] = await tx.db
      .update(expenses)
      .set({ voidedAt: new Date(), toPrint: false })
      .where(eq(expenses.id, id))
      .returning();

    await writeAudit(tx, {
      action: 'void',
      entityType: 'expense',
      entityId: id,
      oldValues: { voidedAt: null },
      newValues: { voidedAt: updated.voidedAt },
    });

    return updated;
  });
}
