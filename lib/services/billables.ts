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
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { assertAccountantMayBillCosts } from './accountantCopy/guard';
import { Money, toAmountString } from '@/lib/money';
import {
  accounts,
  bills,
  billLines,
  customers,
  expenses,
  expenseLines,
  items,
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
import { getPreferences } from './company';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UnbilledCost {
  /** bill_lines.id or expense_lines.id */
  id: string;
  source: 'bill' | 'expense';
  date: Date;
  /** Bill number or expense payee/reference — where the cost came from. */
  ref: string | null;
  description: string | null;
  amount: string;
  jobId: string | null;
  /** The expense account the cost was recorded to (where the reimbursement goes by default). */
  accountId?: string | null;
}

export interface UnbilledTime {
  /** time_entries.id */
  id: string;
  date: Date;
  description: string | null;
  hours: string;
  /** Resolved rate: entry.rate → service item salesPrice → 0. */
  rate: string;
  /** hours * rate, 2dp. */
  amount: string;
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

  // --- Reimbursable bill lines ---
  const billRows = await ctx.db
    .select({
      id: billLines.id,
      description: billLines.description,
      amount: billLines.amount,
      jobId: billLines.jobId,
      accountId: billLines.accountId,
      date: bills.date,
      billNumber: bills.billNumber,
    })
    .from(billLines)
    .innerJoin(bills, eq(billLines.billId, bills.id))
    .where(
      and(
        eq(bills.companyId, ctx.companyId),
        ne(bills.status, 'void'),
        eq(billLines.customerId, customerId),
        isNull(billLines.billedInvoiceId),
      ),
    )
    .orderBy(bills.date);

  // --- Reimbursable expense (check) lines ---
  const expenseRows = await ctx.db
    .select({
      id: expenseLines.id,
      description: expenseLines.description,
      amount: expenseLines.amount,
      jobId: expenseLines.jobId,
      accountId: expenseLines.accountId,
      date: expenses.date,
      payeeName: expenses.payeeName,
      reference: expenses.reference,
    })
    .from(expenseLines)
    .innerJoin(expenses, eq(expenseLines.expenseId, expenses.id))
    .where(
      and(
        eq(expenses.companyId, ctx.companyId),
        isNull(expenses.voidedAt),
        eq(expenseLines.customerId, customerId),
        isNull(expenseLines.billedInvoiceId),
      ),
    )
    .orderBy(expenses.date);

  // --- Unbilled billable time (same selection as timeTracking.billTimeToInvoice) ---
  const timeRows = await ctx.db
    .select()
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.companyId, ctx.companyId),
        eq(timeEntries.customerId, customerId),
        eq(timeEntries.billable, true),
        isNull(timeEntries.invoicedInvoiceId),
      ),
    )
    .orderBy(timeEntries.date);

  // Rate resolution: entry.rate → service item salesPrice → 0 (mirrors billTimeToInvoice).
  const itemIds = [...new Set(timeRows.map((e) => e.serviceItemId).filter(Boolean) as string[])];
  const itemPriceMap = new Map<string, string | null>();
  if (itemIds.length > 0) {
    const itemRows = await ctx.db
      .select({ id: items.id, salesPrice: items.salesPrice })
      .from(items)
      .where(and(eq(items.companyId, ctx.companyId), inArray(items.id, itemIds)));
    for (const r of itemRows) itemPriceMap.set(r.id, r.salesPrice);
  }

  const time: UnbilledTime[] = timeRows.map((e) => {
    let rate = Money.zero();
    if (e.rate != null && Money.gt(e.rate, 0)) {
      rate = Money.of(e.rate);
    } else if (e.serviceItemId) {
      const itemPrice = itemPriceMap.get(e.serviceItemId);
      if (itemPrice != null) rate = Money.of(itemPrice);
    }
    return {
      id: e.id,
      date: e.date,
      description: e.description ?? null,
      hours: e.hours,
      rate: toAmountString(rate),
      amount: toAmountString(Money.round2(Money.mul(e.hours, rate))),
      serviceItemId: e.serviceItemId ?? null,
      jobId: e.jobId ?? null,
    };
  });

  const costs: UnbilledCost[] = [
    ...billRows.map((r) => ({
      id: r.id,
      source: 'bill' as const,
      date: r.date,
      ref: r.billNumber ?? null,
      description: r.description ?? null,
      amount: r.amount,
      jobId: r.jobId ?? null,
      accountId: r.accountId ?? null,
    })),
    ...expenseRows.map((r) => ({
      id: r.id,
      source: 'expense' as const,
      date: r.date,
      ref: r.payeeName ?? r.reference ?? null,
      description: r.description ?? null,
      amount: r.amount,
      jobId: r.jobId ?? null,
      accountId: r.accountId ?? null,
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
    lines.push(...costToLines(cost, markup, route));
  }
  for (const id of selection.expenseLineIds ?? []) {
    const cost = costById.get(id);
    if (!cost || cost.source !== 'expense') {
      throw new ServiceError('CONFLICT', `Expense line ${id} is not an unbilled billable cost for this customer.`);
    }
    lines.push(...costToLines(cost, markup, route));
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
    });
  }

  return lines;
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

  const billableLines = await buildBillableLines(ctx, input.customerId, selection);

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
