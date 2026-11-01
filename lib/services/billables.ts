/**
 * Billable time & costs passthrough (QB "Invoice for Time & Expenses").
 *
 * Sources of unbilled billables for a customer:
 *   - bill_lines     with customerId set and billedInvoiceId NULL (reimbursable costs from bills)
 *   - expense_lines  with customerId set and billedInvoiceId NULL (reimbursable costs from checks/expenses)
 *   - time_entries   with billable = true and invoicedInvoiceId NULL (mirrors
 *     timeTracking.billTimeToInvoice's selection + rate resolution)
 *
 * `createInvoiceWithBillables` appends the selected billables as invoice lines
 * (cost lines support an optional markup %) and stamps billed_invoice_id /
 * invoiced_invoice_id on the source rows INSIDE the same transaction that
 * posts the invoice, so a failure can never leave a posted invoice with the
 * source rows still flagged unbilled (double-billing risk).
 *
 * No direct GL posting here — the GL is written exclusively by createInvoice.
 */
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, ne, or } from 'drizzle-orm';
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { assertAccountantMayBillCosts } from './accountantCopy/guard';
import { Money, toAmountString } from '@/lib/money';
import {
  accounts,
  bills,
  billLines,
  customers,
  expenses,
  expenseLines,
  invoices,
  timeEntries,
} from '@/lib/db/schema';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
} from './_base';
import { createInvoice, type CreateInvoiceInput, type InvoiceLineInput } from './invoices';
import { resolveTimeEntryRates, type TimeRateSource } from './lists/billingRates';
import { getPreferences } from './company';
import { homeAmounts } from './currencies';
import { currencyRate, foreignCode } from './exchangeRates';
import { effectiveHomeCurrency } from './multiCurrency';

/** The `[payroll:<paycheckId>]` marker on time paid in payroll (timeTracking.ts) — never billed. */
const PAYROLL_TAG_RE = /\s*\[payroll:[^\]\s]+\]/g;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UnbilledCost {
  /** bill_lines.id or expense_lines.id */
  id: string;
  source: 'bill' | 'expense';
  /** The bill / check-expense the cost is on. */
  docId?: string;
  /** The customer the cost is billable to. */
  customerId?: string;
  date: Date;
  /** Bill number or expense payee/reference — where the cost came from. */
  ref: string | null;
  description: string | null;
  /** What the cost was booked at in HOME currency (review5 fx: a foreign bill / check line's home share). */
  amount: string;
  jobId: string | null;
  /** The expense account the cost was recorded to (where the reimbursement goes by default). */
  accountId?: string | null;
  /** review5 fx: the source document's foreign currency (null = home) and the line's amount in it. */
  currency?: string | null;
  foreignAmount?: string | null;
}

export interface UnbilledTime {
  /** time_entries.id */
  id: string;
  customerId?: string;
  date: Date;
  description: string | null;
  hours: string;
  /**
   * Resolved rate (B13, lists/billingRates.resolveTimeEntryRates): the entry's typed rate → the
   * person's billing rate level → the service item's sales price → 0.
   */
  rate: string;
  /** Where `rate` came from (shown on the Time/Costs list, e.g. "Senior rate"). */
  rateSource: TimeRateSource;
  /** The billing rate level's name when `rateSource` is 'billing_rate_level'. */
  rateLevelName: string | null;
  /** hours * rate, 2dp. */
  amount: string;
  employeeId: string | null;
  serviceItemId: string | null;
  jobId: string | null;
}

export interface UnbilledBillables {
  costs: UnbilledCost[];
  time: UnbilledTime[];
}

export interface BillableSelection {
  billLineIds?: string[];
  expenseLineIds?: string[];
  timeEntryIds?: string[];
  /** Optional markup percentage applied to COST lines (bills/expenses), e.g. 10 = +10%. */
  markupPercent?: string | number | null;
}

// ---------------------------------------------------------------------------
// listUnbilled
// ---------------------------------------------------------------------------

/**
 * All unbilled billable costs + time for one customer.
 * Voided source documents are excluded (a voided bill/expense is not billable).
 */
export async function listUnbilled(
  ctx: ServiceContext,
  customerId: string,
): Promise<UnbilledBillables> {
  const [cust] = await ctx.db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, customerId)));
  if (!cust) throw notFound('Customer');
  return unbilledBillables(ctx, { customerId });
}

/**
 * Unbilled billable costs + time for one customer or (no customerId) for every customer.
 *
 * `asOf` (the Income Tracker's as-of day) rebuilds the list for that day: sources dated after it
 * are left out, and a source billed by an invoice dated after it (or by a voided invoice) was
 * still unbilled then. Without `asOf` it is the live list: whatever no invoice bills now.
 */
export async function unbilledBillables(
  ctx: ServiceContext,
  opts: { customerId?: string; asOf?: Date } = {},
): Promise<UnbilledBillables> {
  const { customerId } = opts;
  /** Last instant of the as-of day (anything dated that day counts). */
  const cutoff = opts.asOf
    ? new Date(Date.UTC(opts.asOf.getUTCFullYear(), opts.asOf.getUTCMonth(), opts.asOf.getUTCDate()) + 86_400_000 - 1)
    : null;
  const billedInv = alias(invoices, 'billed_inv');
  /** "Not billed (yet)" for a billed-invoice column: live, or as of the cutoff. */
  const unbilledBy = (col: AnyPgColumn) =>
    cutoff ? or(isNull(col), gt(billedInv.date, cutoff), eq(billedInv.status, 'void'))! : isNull(col);

  // --- Reimbursable bill lines ---
  const billRows = await ctx.db
    .select({
      id: billLines.id,
      customerId: billLines.customerId,
      description: billLines.description,
      amount: billLines.amount,
      jobId: billLines.jobId,
      accountId: billLines.accountId,
      date: bills.date,
      billNumber: bills.billNumber,
      docId: bills.id,
      currency: bills.currency,
      exchangeRate: bills.exchangeRate,
    })
    .from(billLines)
    .innerJoin(bills, eq(billLines.billId, bills.id))
    .leftJoin(billedInv, eq(billedInv.id, billLines.billedInvoiceId))
    .where(
      and(
        eq(bills.companyId, ctx.companyId),
        ne(bills.status, 'void'),
        customerId ? eq(billLines.customerId, customerId) : isNotNull(billLines.customerId),
        unbilledBy(billLines.billedInvoiceId),
        cutoff ? lte(bills.date, cutoff) : undefined,
      ),
    )
    .orderBy(bills.date);

  // --- Reimbursable expense (check) lines ---
  const expenseRows = await ctx.db
    .select({
      id: expenseLines.id,
      customerId: expenseLines.customerId,
      description: expenseLines.description,
      amount: expenseLines.amount,
      jobId: expenseLines.jobId,
      accountId: expenseLines.accountId,
      date: expenses.date,
      payeeName: expenses.payeeName,
      reference: expenses.reference,
      docId: expenses.id,
      currency: expenses.currency,
      exchangeRate: expenses.exchangeRate,
    })
    .from(expenseLines)
    .innerJoin(expenses, eq(expenseLines.expenseId, expenses.id))
    .leftJoin(billedInv, eq(billedInv.id, expenseLines.billedInvoiceId))
    .where(
      and(
        eq(expenses.companyId, ctx.companyId),
        isNull(expenses.voidedAt),
        customerId ? eq(expenseLines.customerId, customerId) : isNotNull(expenseLines.customerId),
        unbilledBy(expenseLines.billedInvoiceId),
        cutoff ? lte(expenses.date, cutoff) : undefined,
      ),
    )
    .orderBy(expenses.date);

  // --- Unbilled billable time (same selection as timeTracking.billTimeToInvoice) ---
  const timeRows = (
    await ctx.db
      .select({ e: timeEntries })
      .from(timeEntries)
      .leftJoin(billedInv, eq(billedInv.id, timeEntries.invoicedInvoiceId))
      .where(
        and(
          eq(timeEntries.companyId, ctx.companyId),
          customerId ? eq(timeEntries.customerId, customerId) : isNotNull(timeEntries.customerId),
          eq(timeEntries.billable, true),
          unbilledBy(timeEntries.invoicedInvoiceId),
          cutoff ? lte(timeEntries.date, cutoff) : undefined,
        ),
      )
      .orderBy(timeEntries.date)
  ).map((r) => r.e);

  // B13: entry rate → the person's billing rate level → service item price → 0.
  const rates = await resolveTimeEntryRates(ctx, timeRows);
  const time: UnbilledTime[] = timeRows.map((e) => {
    const r = rates.get(e.id)!;
    return {
      id: e.id,
      customerId: e.customerId!,
      date: e.date,
      // The payroll link is internal bookkeeping — it never shows on the customer's invoice.
      description: (e.description ?? '').replace(PAYROLL_TAG_RE, '').trim() || null,
      hours: e.hours,
      rate: r.rate,
      rateSource: r.source,
      rateLevelName: r.levelName,
      amount: toAmountString(Money.round2(Money.mul(e.hours, r.rate))),
      employeeId: e.employeeId ?? null,
      serviceItemId: e.serviceItemId ?? null,
      jobId: e.jobId ?? null,
    };
  });

  // review5 fx: a cost on a foreign-currency bill / check was booked at its HOME share (the
  // document's home total penny-allocated over its lines, as bills.ts / expenses.ts post it). It
  // used to be billed at its foreign amount as if that were home currency (EUR 100 of costs that
  // cost USD 120 billed as USD 100, and the reimbursement did not net the expense).
  const home = await effectiveHomeCurrency(ctx);
  const homeShares = new Map<string, string>();
  const foreignBills = [...new Set(billRows.filter((r) => foreignCode(r.currency, home)).map((r) => r.docId))];
  for (const billId of foreignBills) {
    const all = await ctx.db
      .select({ id: billLines.id, amount: billLines.amount })
      .from(billLines)
      .where(eq(billLines.billId, billId))
      .orderBy(asc(billLines.lineOrder));
    const rate = billRows.find((r) => r.docId === billId)!.exchangeRate ?? 1;
    const h = homeAmounts(all.map((l) => Money.of(l.amount)), rate);
    all.forEach((l, i) => homeShares.set(l.id, toAmountString(h.lines[i])));
  }
  const foreignExpenses = [...new Set(expenseRows.filter((r) => foreignCode(r.currency, home)).map((r) => r.docId))];
  for (const expenseId of foreignExpenses) {
    const all = await ctx.db
      .select({ id: expenseLines.id, amount: expenseLines.amount })
      .from(expenseLines)
      .where(eq(expenseLines.expenseId, expenseId))
      .orderBy(asc(expenseLines.lineOrder));
    const rate = expenseRows.find((r) => r.docId === expenseId)!.exchangeRate ?? 1;
    const h = homeAmounts(all.map((l) => Money.of(l.amount).abs()), rate);
    all.forEach((l, i) => homeShares.set(l.id, toAmountString(Money.of(l.amount).isNegative() ? h.lines[i].negated() : h.lines[i])));
  }
  const fxOf = (r: { id: string; amount: string; currency: string | null }) => {
    const cur = foreignCode(r.currency, home);
    return cur
      ? { amount: homeShares.get(r.id) ?? r.amount, currency: cur, foreignAmount: r.amount }
      : { amount: r.amount, currency: null, foreignAmount: null };
  };

  const costs: UnbilledCost[] = [
    ...billRows.map((r) => ({
      id: r.id,
      source: 'bill' as const,
      docId: r.docId,
      customerId: r.customerId!,
      date: r.date,
      ref: r.billNumber ?? null,
      description: r.description ?? null,
      jobId: r.jobId ?? null,
      accountId: r.accountId ?? null,
      ...fxOf(r),
    })),
    ...expenseRows.map((r) => ({
      id: r.id,
      source: 'expense' as const,
      docId: r.docId,
      customerId: r.customerId!,
      date: r.date,
      ref: r.payeeName ?? r.reference ?? null,
      description: r.description ?? null,
      jobId: r.jobId ?? null,
      accountId: r.accountId ?? null,
      ...fxOf(r),
    })),
  ];

  return { costs, time };
}

// ---------------------------------------------------------------------------
// buildBillableLines — selection → invoice line inputs
// ---------------------------------------------------------------------------

/**
 * Turn a billable selection into invoice line inputs. Throws CONFLICT if any
 * selected row is no longer unbilled (or doesn't belong to this customer).
 * Cost lines get the optional markup; time lines bill at their resolved rate.
 *
 * Cost lines intentionally carry NO itemId: the source item is a PURCHASE item
 * (re-attaching it would re-route income and, for inventory items, re-relieve
 * stock). Where the billed amount is credited follows the "Track reimbursed expenses as
 * income" preference (reimbursementAccountResolver).
 */
async function buildBillableLines(
  ctx: ServiceContext,
  customerId: string,
  selection: BillableSelection,
  invoiceFx: InvoiceFx = { currency: null, rate: Money.of(1) },
): Promise<InvoiceLineInput[]> {
  const unbilled = await listUnbilled(ctx, customerId);
  const costById = new Map(unbilled.costs.map((c) => [c.id, c]));
  const timeById = new Map(unbilled.time.map((t) => [t.id, t]));

  const route = await reimbursementAccountResolver(ctx);
  // Time & Expenses > "Default markup percentage" applies when the caller gives no markup.
  const markup = Money.of(selection.markupPercent ?? route.defaultMarkupPercent ?? 0);
  if (markup.lessThan(0)) throw validation('Markup percent cannot be negative.');

  const lines: InvoiceLineInput[] = [];

  for (const id of selection.billLineIds ?? []) {
    const cost = costById.get(id);
    if (!cost || cost.source !== 'bill') {
      throw new ServiceError('CONFLICT', `Bill line ${id} is not an unbilled billable cost for this customer.`);
    }
    lines.push(...costToLines(inInvoiceCurrency(cost, invoiceFx), markup, route));
  }
  for (const id of selection.expenseLineIds ?? []) {
    const cost = costById.get(id);
    if (!cost || cost.source !== 'expense') {
      throw new ServiceError('CONFLICT', `Expense line ${id} is not an unbilled billable cost for this customer.`);
    }
    lines.push(...costToLines(inInvoiceCurrency(cost, invoiceFx), markup, route));
  }
  for (const id of selection.timeEntryIds ?? []) {
    const t = timeById.get(id);
    if (!t) {
      throw new ServiceError('CONFLICT', `Time entry ${id} is not unbilled billable time for this customer.`);
    }
    lines.push({
      itemId: t.serviceItemId,
      description: t.description ?? `Time entry — ${t.date.toISOString().slice(0, 10)}`,
      quantity: t.hours,
      rate: t.rate,
      taxable: false,
      jobId: t.jobId,
      // The line remembers the time it bills: an edit that removes it puts the time back.
      billableSource: { kind: 'time_entry', id: t.id },
    });
  }

  return lines;
}

/** The invoice's currency (null = home) and its rate (home units per 1 unit). */
interface InvoiceFx {
  currency: string | null;
  rate: ReturnType<typeof Money.of>;
}

/**
 * review5 fx: a cost in the invoice's currency — its own amount when it was in that same currency,
 * else its home cost (converted at the invoice's rate for a foreign-currency invoice).
 */
function inInvoiceCurrency(cost: UnbilledCost, invoiceFx: InvoiceFx): UnbilledCost {
  if ((cost.currency ?? null) === invoiceFx.currency) {
    return cost.currency ? { ...cost, amount: cost.foreignAmount ?? cost.amount } : cost;
  }
  if (!invoiceFx.currency) return cost; // `amount` is the home cost
  return { ...cost, amount: toAmountString(Money.round2(Money.of(cost.amount).dividedBy(invoiceFx.rate))) };
}

interface ReimbursementRouting {
  /** Account the reimbursed COST is credited to. */
  cost: (cost: UnbilledCost) => string | null;
  /** Account the MARKUP is credited to (null = the default income account). */
  markup: string | null;
  defaultMarkupPercent: number;
}

/**
 * QB Time & Expenses > 'Track reimbursed expenses as income'.
 *  - Off (the QB default): the reimbursed COST is credited back to the expense account it was
 *    recorded to, so that expense nets to zero for costs passed through at cost. This applies
 *    only to expense / COGS accounts; a cost recorded to a balance-sheet account (e.g. 1300
 *    Inventory Asset) is credited to the default income account instead.
 *  - On: the cost is credited to an income account for reimbursements (the active income
 *    account whose name mentions 'reimburs', e.g. 4130 Reimbursed Expenses Income), or the
 *    default income account when there is none.
 * Either way the MARKUP is income, never a reduction of expense: it goes to the active income
 * account whose name mentions 'markup' (QB's Markup Income), or the default income account.
 */
async function reimbursementAccountResolver(ctx: ServiceContext): Promise<ReimbursementRouting> {
  const prefs = await getPreferences(ctx);
  const income = await ctx.db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.type, 'revenue'), eq(accounts.isActive, true)));
  const markup = income.find((a) => /markup/i.test(a.name))?.id ?? null;
  const defaultMarkupPercent = Number(prefs.defaultMarkupPercent) || 0;
  if (!prefs.trackReimbursedAsIncome) {
    // Only an expense / cost-of-goods account can be netted back. A billable line recorded to a
    // balance-sheet account (Inventory Asset on an Inventory Part line, a prepaid, fixed asset or
    // liability) must NOT be credited: that would drain the asset without relieving stock and the
    // GL would stop tying to the subledger. Those fall back to the default income account.
    const expenseIds = new Set(
      (
        await ctx.db
          .select({ id: accounts.id })
          .from(accounts)
          .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.type, 'expense')))
      ).map((a) => a.id),
    );
    return {
      cost: (cost) => (cost.accountId && expenseIds.has(cost.accountId) ? cost.accountId : null),
      markup,
      defaultMarkupPercent,
    };
  }
  const reimbursed = income.find((a) => /reimburs/i.test(a.name))?.id ?? null;
  return { cost: () => reimbursed, markup, defaultMarkupPercent };
}

/**
 * One invoice line for the cost (at cost) plus, when there is a markup, a separate markup line
 * (QB adds the markup as its own line credited to the markup account).
 */
function costToLines(
  cost: UnbilledCost,
  markupPercent: ReturnType<typeof Money.zero>,
  route: ReimbursementRouting,
): InvoiceLineInput[] {
  const base = Money.round2(Money.of(cost.amount));
  const what = cost.description ?? cost.ref ?? 'reimbursable';
  const lines: InvoiceLineInput[] = [
    {
      itemId: null,
      accountId: route.cost(cost),
      description: `Billable ${cost.source === 'bill' ? 'cost' : 'expense'}: ${what}`,
      quantity: 1,
      rate: toAmountString(base),
      taxable: false,
      jobId: cost.jobId,
      // The cost line (not its markup line) remembers the cost it bills: an edit that removes it
      // puts the cost back on the Time/Costs list.
      billableSource: { kind: cost.source === 'bill' ? 'bill_line' : 'expense_line', id: cost.id },
    },
  ];
  const markupAmount = Money.round2(Money.mul(base, Money.div(markupPercent, 100)));
  if (markupAmount.greaterThan(0)) {
    lines.push({
      itemId: null,
      accountId: route.markup,
      description: `Markup on ${what} (+${toAmountString(markupPercent)}% markup)`,
      quantity: 1,
      rate: toAmountString(markupAmount),
      taxable: false,
      jobId: cost.jobId,
    });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// addBillablesToInvoice — stamp source rows inside the invoice transaction
// ---------------------------------------------------------------------------

/**
 * Stamp billed_invoice_id (bills/expenses) and invoiced_invoice_id (time) on
 * the selected source rows. MUST be called inside the same transaction that
 * created the invoice. Re-checks the unbilled predicate in the UPDATE's WHERE
 * and verifies affected-row counts, so a concurrent biller forces a rollback
 * instead of double-billing.
 */
export async function addBillablesToInvoice(
  tx: ServiceContext,
  invoiceId: string,
  selection: BillableSelection,
): Promise<void> {
  await assertAccountantMayBillCosts(tx); // Accountant's Copy (I1): the links can't travel back
  const billLineIds = selection.billLineIds ?? [];
  const expenseLineIds = selection.expenseLineIds ?? [];
  const timeEntryIds = selection.timeEntryIds ?? [];

  if (billLineIds.length > 0) {
    const stamped = await tx.db
      .update(billLines)
      .set({ billedInvoiceId: invoiceId })
      .where(and(inArray(billLines.id, billLineIds), isNull(billLines.billedInvoiceId)))
      .returning({ id: billLines.id });
    if (stamped.length !== billLineIds.length) {
      throw new ServiceError('CONFLICT', 'One or more billable bill lines were already invoiced.');
    }
  }

  if (expenseLineIds.length > 0) {
    const stamped = await tx.db
      .update(expenseLines)
      .set({ billedInvoiceId: invoiceId })
      .where(and(inArray(expenseLines.id, expenseLineIds), isNull(expenseLines.billedInvoiceId)))
      .returning({ id: expenseLines.id });
    if (stamped.length !== expenseLineIds.length) {
      throw new ServiceError('CONFLICT', 'One or more billable expense lines were already invoiced.');
    }
  }

  if (timeEntryIds.length > 0) {
    const stamped = await tx.db
      .update(timeEntries)
      .set({ invoicedInvoiceId: invoiceId })
      .where(
        and(
          eq(timeEntries.companyId, tx.companyId),
          inArray(timeEntries.id, timeEntryIds),
          isNull(timeEntries.invoicedInvoiceId),
        ),
      )
      .returning({ id: timeEntries.id });
    if (stamped.length !== timeEntryIds.length) {
      throw new ServiceError('CONFLICT', 'One or more time entries were already invoiced.');
    }
  }
}

// ---------------------------------------------------------------------------
// createInvoiceWithBillables — end-to-end vertical slice
// ---------------------------------------------------------------------------

/**
 * Create an invoice whose lines include the manually entered lines PLUS the
 * selected billable time & costs, and stamp the source rows — all in ONE
 * transaction. `input.lines` may be empty when the invoice is purely
 * reimbursables (the combined line set must still be non-empty).
 */
export async function createInvoiceWithBillables(
  ctx: ServiceContext,
  input: CreateInvoiceInput,
  selection: BillableSelection,
) {
  const hasSelection =
    (selection.billLineIds?.length ?? 0) +
      (selection.expenseLineIds?.length ?? 0) +
      (selection.timeEntryIds?.length ?? 0) >
    0;
  if (!hasSelection) {
    throw validation('Select at least one billable cost or time entry.');
  }
  await assertAccountantMayBillCosts(ctx); // Accountant's Copy (I1)

  // review5 fx: the invoice's currency + rate, as createInvoice resolves them (blank = home).
  const home = await effectiveHomeCurrency(ctx);
  const invCur = foreignCode(input.currency ?? null, home);
  const invoiceFx: InvoiceFx = invCur
    ? { currency: invCur, rate: (await currencyRate(ctx, invCur, input.exchangeRate)).rate }
    : { currency: null, rate: Money.of(1) };
  const billableLines = await buildBillableLines(ctx, input.customerId, selection, invoiceFx);

  return inTransaction(ctx, async (tx) => {
    // createInvoice nests as a savepoint on this transaction (same pattern as
    // timeTracking.billTimeToInvoice).
    const invoice = await createInvoice(tx, {
      ...input,
      lines: [...(input.lines ?? []), ...billableLines],
    });
    await addBillablesToInvoice(tx, invoice.id, selection);
    return invoice;
  });
}
