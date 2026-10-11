/**
 * Invoices (A/R) service.
 *
 * Invoices are the primary revenue document. Every saved invoice posts a balanced
 * journal entry via `postJournalEntry`:
 *
 *   Dr  1200 Accounts Receivable      total (in BASE currency)
 *   Cr  <income account per line>     line.amount (in BASE currency)
 *   Cr  2200 Sales Tax Payable        taxAmount   (in BASE currency)
 *   Dr  4000 Sales Income (contra)    discount    (in BASE currency)
 *
 * For foreign-currency invoices the invoice itself stores amounts in the
 * transaction currency, but every GL posting line is multiplied by exchangeRate
 * so the ledger stays in base currency.
 *
 * Because total = subtotal - discount + taxAmount, the entry balances:
 *   Debits:  total + discount  (AR debit + discount debit contra)
 *   Credits: subtotal + taxAmount  (income credits + tax credit)
 *   And total + discount = (subtotal - discount + taxAmount) + discount = subtotal + taxAmount ✓
 *
 * Discount can be a flat dollar amount ('amount') or a percentage of the subtotal
 * ('percent'). The stored `discount` column always holds the resolved dollar amount.
 *
 * Voiding calls `voidJournalEntry` which reverses all balance deltas.
 *
 * Editing (`updateInvoice`) is allowed while the invoice has no payments/credits
 * applied (amountPaid == 0) and the period is open. The implementation voids the
 * existing journal entries (including COGS entries tagged `invoice-cogs:<id>`,
 * restoring stock), re-creates the lines, and re-posts — all inside ONE
 * transaction — preserving invoiceNumber and createdAt.
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { Money, allocate, toAmountString } from '@/lib/money';
import {
  accounts,
  classes,
  companies,
  customers,
  inventoryLayers,
  invoices,
  invoiceLines,
  items,
  jobs,
  journalEntries,
  journalEntryLines,
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
  type DocumentInventoryLine,
  type InventoryLineDetail,
  attachInventoryDetails,
  postDocumentInventory,
  reverseDocumentInventory,
  saveDocumentInventoryDetails,
} from './inventorySites';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InvoiceLineInput extends InventoryLineDetail {
  /** Optional product/service item; supplies incomeAccountId as fallback. */
  itemId?: string | null;
  /** Direct income account override; takes priority over item.incomeAccountId. */
  accountId?: string | null;
  description?: string | null;
  quantity: string | number;
  rate: string | number;
  /** Whether this line participates in tax calculation. Defaults true. */
  taxable?: boolean;
  /** Per-line tax rate override (UUID of a taxRates row). When set, this line is taxed at this
   *  rate instead of the invoice-level rate (supports mixed-jurisdiction invoices). */
  taxRateId?: string | null;
  /** Class/department dimension for this line; falls back to the invoice-level classId. */
  classId?: string | null;
  /** Customer:Job for this line (job costing); falls back to the invoice-level jobId. */
  jobId?: string | null;
}

export interface CreateInvoiceInput {
  customerId: string;
  date: Date;
  dueDate?: Date | null;
  lines: InvoiceLineInput[];
  /** UUID of a taxRates row; if absent no tax is charged. */
  taxRateId?: string | null;
  /** Invoice-level class dimension (P&L by Class); inherited by lines without their own classId. */
  classId?: string | null;
  /** Invoice-level Customer:Job (job costing); inherited by lines without their own jobId. */
  jobId?: string | null;
  /**
   * Discount value. Interpretation depends on discountType:
   *   'amount'  (default) — flat dollar subtracted from subtotal.
   *   'percent'           — percentage of subtotal (e.g. 10 = 10%).
   */
  discount?: string | number | null;
  /** Controls how `discount` is interpreted. Defaults to 'amount'. */
  discountType?: 'amount' | 'percent' | null;
  /** Optional retainage (holdback) percentage of the total, posted to Retainage Receivable (1250)
   *  and excluded from the immediately-due balance. Common in construction/contract billing. */
  retainagePercent?: string | number | null;
  memo?: string | null;
  /**
   * ISO 4217 currency code for the invoice (e.g. 'EUR', 'GBP').
   * Defaults to base currency (no conversion).
   */
  currency?: string | null;
  /**
   * Exchange rate: how many base-currency units equal 1 transaction-currency unit.
   * E.g. if base=USD and currency=EUR, exchangeRate=1.10 means 1 EUR = 1.10 USD.
   * Defaults to 1 (base currency).
   */
  exchangeRate?: string | number | null;
  /**
   * 'draft' saves a PENDING invoice: no GL posting, no inventory relief.
   * Post it later with `postDraftInvoice` (period check happens at post time).
   * Defaults to 'open' (post immediately).
   */
  status?: 'draft' | 'open' | null;
  /** Values for company-defined invoice custom fields ({ [fieldName]: value }). */
  customFields?: Record<string, string> | null;
}

/** A company-defined custom field rendered on the invoice form. */
export interface InvoiceCustomFieldDef {
  name: string;
}

/**
 * Read the company-defined custom-field definitions for invoices.
 *
 * Definitions live in companies.settings.customFields.invoice as a [{ name }]
 * array (managed by the custom-fields service/UI). Tolerates plain-string
 * entries for forward compatibility.
 */
export async function getInvoiceCustomFieldDefs(
  ctx: ServiceContext,
): Promise<InvoiceCustomFieldDef[]> {
  const [row] = await ctx.db
    .select({ settings: companies.settings })
    .from(companies)
    .where(eq(companies.id, ctx.companyId));
  const raw = (row?.settings as { customFields?: { invoice?: unknown } } | null)?.customFields
    ?.invoice;
  if (!Array.isArray(raw)) return [];
  const defs: InvoiceCustomFieldDef[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.trim()) defs.push({ name: entry.trim() });
    else if (entry && typeof (entry as { name?: unknown }).name === 'string') {
      defs.push({ name: (entry as { name: string }).name });
    }
  }
  return defs;
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

/** Look up an account by code, creating it if missing (for accounts older companies may lack). */
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
    .values({ companyId: ctx.companyId, code, name: def.name, type: def.type as never, subtype: def.subtype as never })
    .returning();
  return created.id;
}

/**
 * Sum of an invoice's stored payment-item lines (items.type = 'payment').
 * `amountPaid` includes these, so "has external payments applied" checks must
 * compare amountPaid against this sum instead of against zero.
 */
async function storedPaymentLineTotal(ctx: ServiceContext, invoiceId: string) {
  const rows = await ctx.db
    .select({ amount: invoiceLines.amount })
    .from(invoiceLines)
    .innerJoin(items, eq(items.id, invoiceLines.itemId))
    .where(and(eq(invoiceLines.invoiceId, invoiceId), eq(items.type, 'payment')));
  return rows.reduce((sum, r) => sum.plus(Money.of(r.amount)), Money.zero());
}

/** True when the invoice has payments applied beyond its own payment-item lines. */
async function hasExternalPayments(
  ctx: ServiceContext,
  invoice: { id: string; amountPaid: string | null },
): Promise<boolean> {
  if (!invoice.amountPaid || !Money.gt(invoice.amountPaid, 0)) return false;
  const paymentLines = await storedPaymentLineTotal(ctx, invoice.id);
  return Money.of(invoice.amountPaid).greaterThan(paymentLines);
}

/** Return the next invoice number for the company (max + 1, 1 if none). */
async function nextInvoiceNumber(ctx: ServiceContext): Promise<number> {
  const [row] = await ctx.db
    .select({ max: sql<number>`COALESCE(MAX(${invoices.invoiceNumber}), 0)` })
    .from(invoices)
    .where(eq(invoices.companyId, ctx.companyId));
  return (row?.max ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// prepareInvoice — shared validation + computation for create/update
// ---------------------------------------------------------------------------

/**
 * Posting semantics of a line, derived from its item's type:
 *  - 'income'    — normal revenue line (service/inventory/non_inventory/bundle/
 *                  other_charge or no item). Credits its income account.
 *  - 'discount'  — negative body line. Debits its discount (income) account.
 *  - 'subtotal'  — UI helper: amount = sum of body lines since the previous
 *                  subtotal. Non-posting, excluded from all totals.
 *  - 'payment'   — reduces the balance: Dr Undeposited Funds / Cr A/R (by
 *                  shrinking the A/R debit) within the invoice entry.
 *  - 'sales_tax' — manual tax line: adds to taxAmount (Cr 2200), not subtotal.
 */
type LineKind = 'income' | 'discount' | 'subtotal' | 'payment' | 'sales_tax';

type ComputedLine = {
  itemId: string | null;
  accountId: string;         // resolved income account id
  description: string | null;
  quantity: string;
  rate: string;
  amount: string;            // quantity * rate, 2dp (in transaction currency)
  taxable: boolean;
  taxRateId: string | null;
  classId: string | null;
  jobId: string | null;
  lineOrder: number;
  kind: LineKind;
};

interface PreparedInvoice {
  exchangeRate: ReturnType<typeof Money.zero>;
  arAccountId: string;
  defaultIncomeId: string;
  taxPayableId: string;
  retainageAcctId: string | null;
  headerClassId: string | null;
  headerJobId: string | null;
  computedLines: ComputedLine[];
  subtotal: ReturnType<typeof Money.zero>;
  discount: ReturnType<typeof Money.zero>;
  discountType: 'amount' | 'percent';
  taxAmount: ReturnType<typeof Money.zero>;
  total: ReturnType<typeof Money.zero>;
  usesRetainage: boolean;
  retainagePct: ReturnType<typeof Money.zero>;
  retainageAmount: ReturnType<typeof Money.zero>;
  dueNow: ReturnType<typeof Money.zero>;
  /** Gross positive income-line sum (= subtotal + discount-line magnitudes). */
  grossIncome: ReturnType<typeof Money.zero>;
  /** Sum of payment-item lines (already received; shrinks the A/R debit). */
  paymentTotal: ReturnType<typeof Money.zero>;
  /** Undeposited Funds (1050); resolved only when payment lines exist. */
  ufAccountId: string | null;
  itemMap: Map<string, { incomeAccountId: string | null; type: string; name: string }>;
}

/**
 * Validate a CreateInvoiceInput and compute every derived amount/account needed
 * to persist + post the invoice. Pure read-only (no writes). Used by both
 * `createInvoice` and `updateInvoice` so edits go through the exact same math.
 *
 * `opts.excludeInvoiceId` removes one invoice from the credit-limit exposure
 * (the invoice being edited — its old balance is replaced by the new total).
 */
async function prepareInvoice(
  ctx: ServiceContext,
  input: CreateInvoiceInput,
  opts?: { excludeInvoiceId?: string },
): Promise<PreparedInvoice> {
  // --- Validate inputs ---
  if (!input.lines || input.lines.length === 0) {
    throw validation('An invoice must have at least one line.');
  }

  // Validate exchange rate.
  const exchangeRate = Money.round2(input.exchangeRate ?? 1);
  if (exchangeRate.lessThanOrEqualTo(0)) throw validation('Exchange rate must be positive.');

  // Verify customer belongs to company; also load creditLimit for the credit check.
  const [customer] = await ctx.db
    .select({ id: customers.id, creditLimit: customers.creditLimit })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, input.customerId)));
  if (!customer) throw notFound('Customer');

  // Load tax rate if provided.
  let taxRateDecimal = Money.zero();
  if (input.taxRateId) {
    const [taxRow] = await ctx.db
      .select({ rate: taxRates.rate })
      .from(taxRates)
      .where(and(eq(taxRates.companyId, ctx.companyId), eq(taxRates.id, input.taxRateId)));
    if (!taxRow) throw notFound('Tax rate');
    taxRateDecimal = Money.of(taxRow.rate);
  }

  // Resolve fallback account ids (from COA defaults).
  const arAccountId = await accountIdByCode(ctx, '1200');    // A/R
  const defaultIncomeId = await accountIdByCode(ctx, '4000'); // Sales Income (fallback + discount contra)
  const taxPayableId = await accountIdByCode(ctx, '2200');   // Sales Tax Payable

  // Resolve (or create) the Retainage Receivable account if this invoice uses retainage.
  const usesRetainage = input.retainagePercent != null && Money.of(input.retainagePercent).greaterThan(0);
  const retainageAcctId = usesRetainage
    ? await getOrCreateAccountByCode(ctx, '1250', {
        name: 'Retainage Receivable',
        type: 'asset',
        subtype: 'accounts_receivable',
      })
    : null;

  // Pre-load items referenced by lines (income account routing + inventory typing).
  const itemIds = [
    ...new Set(input.lines.filter((l) => l.itemId).map((l) => l.itemId as string)),
  ];
  const itemMap = new Map<
    string,
    { incomeAccountId: string | null; type: string; name: string }
  >();
  if (itemIds.length > 0) {
    const itemRows = await ctx.db
      .select({
        id: items.id,
        incomeAccountId: items.incomeAccountId,
        type: items.type,
        name: items.name,
      })
      .from(items)
      .where(and(eq(items.companyId, ctx.companyId), inArray(items.id, itemIds)));
    for (const r of itemRows)
      itemMap.set(r.id, { incomeAccountId: r.incomeAccountId, type: r.type, name: r.name });
    for (const id of itemIds) {
      if (!itemMap.has(id)) throw notFound(`Item ${id}`);
    }
  }

  // Validate class/job dimensions (header + per-line) belong to this company.
  const headerClassId = input.classId ?? null;
  const headerJobId = input.jobId ?? null;
  const classIds = [
    ...new Set(
      [headerClassId, ...input.lines.map((l) => l.classId ?? null)].filter(Boolean) as string[],
    ),
  ];
  if (classIds.length > 0) {
    const rows = await ctx.db
      .select({ id: classes.id })
      .from(classes)
      .where(and(eq(classes.companyId, ctx.companyId), inArray(classes.id, classIds)));
    const found = new Set(rows.map((r) => r.id));
    for (const id of classIds) if (!found.has(id)) throw notFound(`Class ${id}`);
  }
  const jobIds = [
    ...new Set(
      [headerJobId, ...input.lines.map((l) => l.jobId ?? null)].filter(Boolean) as string[],
    ),
  ];
  if (jobIds.length > 0) {
    const rows = await ctx.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.companyId, ctx.companyId), inArray(jobs.id, jobIds)));
    const found = new Set(rows.map((r) => r.id));
    for (const id of jobIds) if (!found.has(id)) throw notFound(`Job ${id}`);
  }

  // Pre-load any per-line tax-rate overrides into a rate map.
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
  // Accumulates tax from lines that carry their own rate (kept separate from the invoice-level rate).
  let perLineTax = Money.zero();

  // --- Compute per-line amounts and subtotal ---
  // QB item-type semantics: lines whose item is a special type (discount /
  // subtotal / payment / sales_tax) do NOT post as plain income — see LineKind.
  let subtotal = Money.zero();
  let taxableSubtotal = Money.zero();
  let grossIncome = Money.zero();
  let paymentTotal = Money.zero();
  let salesTaxLines = Money.zero();
  // Running sum of body lines (income + discount) since the last subtotal item.
  let runningBody = Money.zero();
  const computedLines: ComputedLine[] = [];

  for (let i = 0; i < input.lines.length; i++) {
    const l = input.lines[i];
    const itemType = l.itemId ? (itemMap.get(l.itemId)?.type ?? 'service') : 'service';
    const kind: LineKind =
      itemType === 'discount' || itemType === 'subtotal' ||
      itemType === 'payment' || itemType === 'sales_tax'
        ? (itemType as LineKind)
        : 'income';

    // Resolve income account: explicit accountId > item.incomeAccountId > 4000.
    // (For discount lines this is the DISCOUNT account that gets debited.)
    let resolvedAccountId = defaultIncomeId;
    if (l.accountId) {
      // Verify it belongs to this company.
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

    if (kind === 'subtotal') {
      // UI-computed subtotal of the preceding body lines — non-posting,
      // excluded from every total. Stored so the printed doc shows it.
      computedLines.push({
        itemId: l.itemId ?? null,
        accountId: resolvedAccountId,
        description: l.description ?? 'Subtotal',
        quantity: '1.00',
        rate: toAmountString(runningBody),
        amount: toAmountString(runningBody),
        taxable: false,
        taxRateId: null,
        classId: l.classId ?? headerClassId,
        jobId: l.jobId ?? headerJobId,
        lineOrder: i,
        kind,
      });
      runningBody = Money.zero(); // QB: a subtotal item resets the running group
      continue;
    }

    const qty = Money.of(l.quantity);
    const rate = Money.of(l.rate);
    if (qty.lessThanOrEqualTo(0)) throw validation(`Line ${i + 1}: quantity must be positive.`);
    if (kind !== 'discount' && rate.lessThan(0)) {
      throw validation(`Line ${i + 1}: rate cannot be negative.`);
    }

    let amount = Money.round2(Money.mul(qty, rate));
    let taxable = l.taxable !== false; // default true

    if (kind === 'discount') {
      // A discount line always REDUCES the invoice: store a negative amount
      // regardless of the sign the caller entered.
      amount = Money.abs(amount).negated();
      // (magnitude check against the whole body happens via the total >= 0 guard)
    } else if (kind === 'payment') {
      if (amount.lessThanOrEqualTo(0)) {
        throw validation(`Line ${i + 1}: payment line amount must be positive.`);
      }
      taxable = false;
    } else if (kind === 'sales_tax') {
      if (amount.lessThan(0)) {
        throw validation(`Line ${i + 1}: sales tax line amount cannot be negative.`);
      }
      taxable = false;
    }

    if (kind === 'income' || kind === 'discount') {
      subtotal = subtotal.plus(amount);
      runningBody = runningBody.plus(amount);
      if (kind === 'income') grossIncome = grossIncome.plus(amount);
      if (taxable) {
        if (l.taxRateId && kind === 'income') {
          // Per-line rate: tax this line directly, keep it out of the invoice-level taxable base.
          perLineTax = perLineTax.plus(Money.round2(Money.mul(amount, lineTaxRateMap.get(l.taxRateId)!)));
        } else {
          // Taxable discount lines reduce the invoice-level taxable base.
          taxableSubtotal = taxableSubtotal.plus(amount);
        }
      }
    } else if (kind === 'payment') {
      paymentTotal = paymentTotal.plus(amount);
    } else if (kind === 'sales_tax') {
      salesTaxLines = salesTaxLines.plus(amount);
    }

    computedLines.push({
      itemId: l.itemId ?? null,
      accountId: resolvedAccountId,
      description: l.description ?? null,
      quantity: toAmountString(qty),
      rate: toAmountString(rate),
      amount: toAmountString(amount),
      taxable,
      taxRateId: kind === 'income' ? (l.taxRateId ?? null) : null,
      classId: l.classId ?? headerClassId,
      jobId: l.jobId ?? headerJobId,
      lineOrder: i,
      kind,
    });
  }

  // --- Resolve discount (flat or percent of subtotal) ---
  const discountType: 'amount' | 'percent' = input.discountType === 'percent' ? 'percent' : 'amount';
  const discountRaw = Money.round2(input.discount ?? 0);
  if (discountRaw.lessThan(0)) throw validation('Discount cannot be negative.');
  let discount: ReturnType<typeof Money.zero>;
  if (discountType === 'percent') {
    // Interpret discountRaw as a percentage value, e.g. 10 means 10%.
    if (discountRaw.greaterThan(100)) throw validation('Percent discount cannot exceed 100%.');
    discount = Money.round2(Money.mul(subtotal, Money.div(discountRaw, 100)));
  } else {
    discount = discountRaw;
  }

  // taxAmount = (invoice-rate base * rate) + per-line-rate taxes + manual sales_tax lines.
  // Discount item lines can drag the taxable base negative; tax never goes below 0.
  const effectiveTaxableBase = taxableSubtotal.lessThan(0) ? Money.zero() : taxableSubtotal;
  let taxAmount = Money.round2(Money.mul(effectiveTaxableBase, taxRateDecimal))
    .plus(perLineTax)
    .plus(salesTaxLines);
  if (taxAmount.lessThan(0)) taxAmount = Money.zero();
  // total = subtotal - discount + taxAmount  (all in transaction currency;
  // subtotal is already net of discount ITEM lines — `discount` here is the header discount)
  const total = Money.round2(subtotal.minus(discount).plus(taxAmount));

  if (total.lessThan(0)) {
    throw validation('Invoice total cannot be negative — discount exceeds subtotal + tax.');
  }

  // --- Retainage (holdback): a % of the total is posted to Retainage Receivable and excluded
  //     from the immediately-due balance (billed/released later). ---
  const retainagePct = usesRetainage ? Money.round2(input.retainagePercent!) : Money.zero();
  if (retainagePct.greaterThan(100)) throw validation('Retainage percent cannot exceed 100%.');
  const retainageAmount = usesRetainage
    ? Money.round2(Money.mul(total, Money.div(retainagePct, 100)))
    : Money.zero();
  const dueNow = Money.round2(total.minus(retainageAmount));

  // --- Payment item lines: cannot exceed what is billable now ---
  if (paymentTotal.greaterThan(dueNow)) {
    throw validation('Payment line(s) exceed the invoice balance due.');
  }
  // Resolve Undeposited Funds (1050) only when a payment line needs it.
  const ufAccountId = paymentTotal.greaterThan(0)
    ? await getOrCreateAccountByCode(ctx, '1050', {
        name: 'Undeposited Funds',
        type: 'asset',
        subtype: 'checking',
      })
    : null;

  // --- Credit limit check ---
  if (customer.creditLimit != null) {
    const creditLimit = Money.of(customer.creditLimit);
    if (creditLimit.greaterThan(0)) {
      // Compare in BASE currency: creditLimit and GL postings are base, but each invoice's
      // balanceDue (and this invoice's `total`) are stored in their own transaction currency.
      const openConds = [
        eq(invoices.companyId, ctx.companyId),
        eq(invoices.customerId, input.customerId),
        inArray(invoices.status, ['open', 'partial']),
      ];
      if (opts?.excludeInvoiceId) openConds.push(ne(invoices.id, opts.excludeInvoiceId));
      const openInvoiceRows = await ctx.db
        .select({ balanceDue: invoices.balanceDue, exchangeRate: invoices.exchangeRate })
        .from(invoices)
        .where(and(...openConds));
      const outstandingBase = openInvoiceRows.reduce(
        (sum, row) =>
          sum.plus(Money.round2(Money.mul(Money.of(row.balanceDue), Money.of(row.exchangeRate ?? 1)))),
        Money.zero(),
      );
      const newExposureBase = Money.round2(Money.mul(total, exchangeRate));
      if (outstandingBase.plus(newExposureBase).greaterThan(creditLimit)) {
        throw new ServiceError('VALIDATION', 'Credit limit exceeded');
      }
    }
  }

  return {
    exchangeRate,
    arAccountId,
    defaultIncomeId,
    taxPayableId,
    retainageAcctId,
    headerClassId,
    headerJobId,
    computedLines,
    subtotal,
    discount,
    discountType,
    taxAmount,
    total,
    usesRetainage,
    retainagePct,
    retainageAmount,
    dueNow,
    grossIncome,
    paymentTotal,
    ufAccountId,
    itemMap,
  };
}

// ---------------------------------------------------------------------------
// postInvoiceGL — build + post the balanced A/R journal entry
// ---------------------------------------------------------------------------

/**
 * Build and post the journal entry for a prepared invoice.
 *
 * All GL amounts are in BASE currency = transaction-currency amount * exchangeRate.
 *
 * The scheme is designed so debits == credits:
 *   Dr 1200 A/R              = total * fx
 *   Cr <income accounts>     = subtotal * fx   (gross line amounts)
 *   Cr 2200 Tax Payable      = taxAmount * fx  (0 if no tax)
 *   Dr 4000 Sales contra     = discount * fx   (0 if no discount)
 *
 *   Debit  total*fx + discount*fx  = (subtotal - discount + taxAmount)*fx + discount*fx
 *                                  = (subtotal + taxAmount)*fx
 *   Total credits: subtotal*fx + taxAmount*fx  ✓
 *
 * Rounding each converted line independently can leave debits ≠ credits by a cent
 * (sum of rounded products ≠ rounded sum). Instead, pick ONE base-currency anchor —
 * entryBase = round2((subtotal + taxAmount) * fx) — and penny-allocate it across each
 * side of the entry with allocate() (largest-remainder), so both sides always sum to
 * exactly entryBase and assertBalanced passes. For exchangeRate = 1 the allocation is
 * exact (weights already sum to the anchor), so base-currency entries are unchanged.
 */
async function postInvoiceGL(
  tx: ServiceContext,
  prep: PreparedInvoice,
  invoiceId: string,
  invoiceNumber: number,
  date: Date,
) {
  const {
    taxAmount, discount, dueNow, retainageAmount, exchangeRate,
    arAccountId, defaultIncomeId, taxPayableId, retainageAcctId, headerClassId,
    computedLines, grossIncome, paymentTotal, ufAccountId,
  } = prep;

  // Anchor on the gross credit side: income line amounts + tax. (grossIncome =
  // subtotal + discount-line magnitudes, so this generalises the old
  // subtotal+tax anchor when no discount item lines exist.)
  const entryBase = Money.round2(Money.mul(grossIncome.plus(taxAmount), exchangeRate));

  // Aggregate per income account + class (multiple lines may share an account, and
  // class must flow onto the GL line so P&L-by-Class sees invoice revenue).
  // Only 'income' lines credit revenue; discount lines collect on the debit side.
  const incomeCredits = new Map<
    string,
    { accountId: string; classId: string | null; amount: ReturnType<typeof Money.zero> }
  >();
  const discountDebits = new Map<
    string,
    { accountId: string; classId: string | null; amount: ReturnType<typeof Money.zero> }
  >();
  for (const cl of computedLines) {
    if (cl.kind !== 'income' && cl.kind !== 'discount') continue;
    const key = `${cl.accountId}|${cl.classId ?? ''}`;
    const map = cl.kind === 'income' ? incomeCredits : discountDebits;
    const lineAmt = Money.abs(Money.of(cl.amount)); // discount amounts are stored negative
    const prev = map.get(key);
    if (prev) {
      prev.amount = prev.amount.plus(lineAmt);
    } else {
      map.set(key, { accountId: cl.accountId, classId: cl.classId, amount: lineAmt });
    }
  }

  // Debit side: A/R for the amount still due (after payment item lines),
  // Undeposited Funds for payment lines, Retainage Receivable for any held-back
  // portion, the header-discount contra, and each discount item line.
  // Weights sum to (dueNow - payments) + payments + retainage + discount + discountLines
  // = total + discount + discountLines = grossIncome + taxAmount, matching the credit side.
  const debitSpecs: Array<{
    accountId: string;
    weight: ReturnType<typeof Money.zero>;
    memo: string;
    classId?: string | null;
  }> = [{
    accountId: arAccountId,
    weight: dueNow.minus(paymentTotal),
    memo: `Invoice #${invoiceNumber}`,
  }];
  if (paymentTotal.greaterThan(0) && ufAccountId) {
    debitSpecs.push({
      accountId: ufAccountId,
      weight: paymentTotal,
      memo: `Invoice #${invoiceNumber} — payment received`,
    });
  }
  if (retainageAmount.greaterThan(0) && retainageAcctId) {
    debitSpecs.push({
      accountId: retainageAcctId,
      weight: retainageAmount,
      memo: `Invoice #${invoiceNumber} — retainage`,
    });
  }
  if (discount.greaterThan(0)) {
    debitSpecs.push({
      accountId: defaultIncomeId,
      weight: discount,
      memo: `Invoice #${invoiceNumber} — discount`,
      classId: headerClassId,
    });
  }
  for (const spec of discountDebits.values()) {
    if (spec.amount.greaterThan(0)) {
      debitSpecs.push({
        accountId: spec.accountId,
        weight: spec.amount,
        memo: `Invoice #${invoiceNumber} — discount`,
        classId: spec.classId,
      });
    }
  }

  // Credit side: each income account for its gross line amounts, plus sales tax.
  const creditSpecs: Array<{
    accountId: string;
    weight: ReturnType<typeof Money.zero>;
    memo: string;
    classId?: string | null;
  }> = [];
  for (const spec of incomeCredits.values()) {
    creditSpecs.push({
      accountId: spec.accountId,
      weight: spec.amount,
      memo: `Invoice #${invoiceNumber} — income`,
      classId: spec.classId,
    });
  }
  if (taxAmount.greaterThan(0)) {
    creditSpecs.push({
      accountId: taxPayableId,
      weight: taxAmount,
      memo: `Invoice #${invoiceNumber} — sales tax`,
    });
  }

  const debitAlloc = allocate(entryBase, debitSpecs.map((s) => s.weight));
  const creditAlloc = allocate(entryBase, creditSpecs.map((s) => s.weight));

  const postingLines: Array<{
    accountId: string;
    debit?: string;
    credit?: string;
    memo?: string;
    classId?: string | null;
  }> = [];
  debitSpecs.forEach((s, i) => {
    if (debitAlloc[i].greaterThan(0)) {
      postingLines.push({
        accountId: s.accountId,
        debit: toAmountString(debitAlloc[i]),
        memo: s.memo,
        classId: s.classId ?? null,
      });
    }
  });
  creditSpecs.forEach((s, i) => {
    if (creditAlloc[i].greaterThan(0)) {
      postingLines.push({
        accountId: s.accountId,
        credit: toAmountString(creditAlloc[i]),
        memo: s.memo,
        classId: s.classId ?? null,
      });
    }
  });

  return postJournalEntry(tx, {
    date,
    description: `Invoice #${invoiceNumber}`,
    reference: String(invoiceNumber),
    sourceRef: `invoice:${invoiceId}`,
    lines: postingLines,
  });
}

// ---------------------------------------------------------------------------
// postInvoiceCOGS — perpetual inventory effects for inventory-item lines
// ---------------------------------------------------------------------------

/**
 * Perpetual inventory: every line that sells an inventory-type item relieves
 * stock and posts COGS inside the caller's transaction.
 *   - FIFO-tracked items (any inventoryLayers rows) consume layers via fifo.ts,
 *     which posts Dr 5000 COGS / Cr Inventory Asset at exact layer cost.
 *   - Average-cost items go through inventory.recordCOGS (Dr COGS / Cr Inventory
 *     at averageCost) and quantityOnHand is decremented.
 * Each COGS entry is then tagged with sourceRef `invoice-cogs:<invoiceId>` and
 * reference `cogs:<lineOrder>` so voidInvoice/updateInvoice can reverse it and
 * restore stock.
 */
async function postInvoiceCOGS(
  tx: ServiceContext,
  prep: PreparedInvoice,
  invoiceId: string,
  invoiceNumber: number,
  date: Date,
) {
  const { computedLines, itemMap } = prep;
  const fifoTracked = new Map<string, boolean>();
  for (const cl of computedLines) {
    if (!cl.itemId) continue;
    const info = itemMap.get(cl.itemId);
    if (!info || info.type !== 'inventory') continue;

    let isFifo = fifoTracked.get(cl.itemId);
    if (isFifo === undefined) {
      const [layerRow] = await tx.db
        .select({ id: inventoryLayers.id })
        .from(inventoryLayers)
        .where(
          and(
            eq(inventoryLayers.companyId, tx.companyId),
            eq(inventoryLayers.itemId, cl.itemId),
          ),
        )
        .limit(1);
      isFifo = Boolean(layerRow);
      fifoTracked.set(cl.itemId, isFifo);
    }

    const cogsMemo = `Invoice #${invoiceNumber} — COGS (${info.name})`;
    let cogsEntryId: string;
    if (isFifo) {
      const res = await consumeStock(tx, {
        itemId: cl.itemId,
        quantity: cl.quantity,
        date,
        memo: cogsMemo,
      });
      cogsEntryId = res.entryId;
    } else {
      // Guard: a zero-average-cost sale would produce a $0 (unpostable) COGS entry
      // and an irreversible stock decrement — block it with a clear message.
      const [itemRow] = await tx.db
        .select({ averageCost: items.averageCost })
        .from(items)
        .where(and(eq(items.companyId, tx.companyId), eq(items.id, cl.itemId)));
      if (!itemRow || Money.of(itemRow.averageCost ?? '0').lessThanOrEqualTo(0)) {
        throw validation(
          `Inventory item "${info.name}" has no average cost. Receive stock with a unit cost (bill or inventory adjustment) before selling it.`,
        );
      }
      const res = await recordCOGS(tx, {
        itemId: cl.itemId,
        quantity: cl.quantity,
        date,
        memo: cogsMemo,
      });
      cogsEntryId = res.entry.id;
    }

    await tx.db
      .update(journalEntries)
      .set({
        sourceRef: `invoice-cogs:${invoiceId}`,
        reference: `cogs:${cl.lineOrder}`,
        updatedAt: new Date(),
      })
      .where(eq(journalEntries.id, cogsEntryId));
  }
}

// ---------------------------------------------------------------------------
// reverseInvoiceCOGS — void COGS entries and restore stock
// ---------------------------------------------------------------------------

/**
 * Reverse perpetual-inventory effects of an invoice: void each COGS entry
 * tagged `invoice-cogs:<id>` and put the relieved stock back on hand.
 * Must run BEFORE the invoice's lines are deleted/replaced (it reads them to
 * know which item/quantity each COGS entry belongs to).
 */
async function reverseInvoiceCOGS(
  tx: ServiceContext,
  invoice: { id: string; date: Date },
) {
  const id = invoice.id;
  const cogsEntries = await tx.db
    .select()
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.companyId, tx.companyId),
        eq(journalEntries.sourceRef, `invoice-cogs:${id}`),
        eq(journalEntries.status, 'posted'),
      ),
    );
  if (cogsEntries.length === 0) return;

  const lines = await tx.db
    .select()
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, id));
  const lineByOrder = new Map(lines.map((l) => [l.lineOrder, l]));

  for (const cogsEntry of cogsEntries) {
    // COGS amount = total debits on the entry (Dr COGS / Cr Inventory Asset).
    const entryLines = await tx.db
      .select()
      .from(journalEntryLines)
      .where(eq(journalEntryLines.journalEntryId, cogsEntry.id));
    const cogsAmount = entryLines.reduce(
      (sum, l) => sum.plus(Money.of(l.debit ?? '0')),
      Money.zero(),
    );

    // Reverse the GL impact.
    await voidJournalEntry(tx, cogsEntry.id);

    // Restore stock for the invoice line this entry belongs to.
    const match = /^cogs:(\d+)$/.exec(cogsEntry.reference ?? '');
    const line = match ? lineByOrder.get(Number(match[1])) : undefined;
    if (!line?.itemId) continue;
    const qty = Money.of(line.quantity);
    if (qty.lessThanOrEqualTo(0)) continue;

    const [item] = await tx.db
      .select()
      .from(items)
      .where(and(eq(items.companyId, tx.companyId), eq(items.id, line.itemId)));
    if (!item) continue;

    const currentQty = Money.of(item.quantityOnHand ?? '0');
    const newQty = currentQty.plus(qty);

    const [layerRow] = await tx.db
      .select({ id: inventoryLayers.id })
      .from(inventoryLayers)
      .where(
        and(
          eq(inventoryLayers.companyId, tx.companyId),
          eq(inventoryLayers.itemId, line.itemId),
        ),
      )
      .limit(1);

    if (layerRow) {
      // FIFO-tracked: post a compensating layer at the blended consumed cost
      // (the JE void already restored the Inventory Asset GL balance).
      const unitCost = cogsAmount.dividedBy(qty);
      await tx.db.insert(inventoryLayers).values({
        companyId: tx.companyId,
        itemId: line.itemId,
        date: invoice.date,
        quantityRemaining: qty.toFixed(4),
        unitCost: unitCost.toFixed(4),
      });
      await tx.db
        .update(items)
        .set({ quantityOnHand: newQty.toFixed(4), updatedAt: new Date() })
        .where(eq(items.id, line.itemId));
    } else {
      // Average-cost: weight the restored value back into averageCost so the
      // item valuation stays tied to the restored GL balance.
      const currentAvg = Money.of(item.averageCost ?? '0');
      const newAvg = newQty.isZero()
        ? currentAvg
        : currentQty.times(currentAvg).plus(cogsAmount).dividedBy(newQty);
      await tx.db
        .update(items)
        .set({
          quantityOnHand: newQty.toFixed(4),
          averageCost: newAvg.toFixed(4),
          updatedAt: new Date(),
        })
        .where(eq(items.id, line.itemId));
    }

    await writeAudit(tx, {
      action: 'update',
      entityType: 'item',
      entityId: line.itemId,
      oldValues: { quantityOnHand: item.quantityOnHand },
      newValues: {
        quantityOnHand: newQty.toFixed(4),
        reason: `invoice_void:${id}`,
        restoredCOGS: toAmountString(cogsAmount),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Advanced Inventory: per-line site / bin / serial / lot
// ---------------------------------------------------------------------------

/**
 * Pair each computed line with the site/bin/serial/lot fields of its input line (lineOrder =
 * input index). Absent keys stay undefined so edits can carry stored detail forward.
 */
function inventoryLinesOf(
  lines: InvoiceLineInput[],
  prep: PreparedInvoice,
): DocumentInventoryLine[] {
  return prep.computedLines.map((cl) => {
    const src = lines[cl.lineOrder];
    return {
      lineOrder: cl.lineOrder,
      itemId: cl.itemId,
      quantity: cl.quantity,
      siteId: src?.siteId,
      binId: src?.binId,
      serialNumbers: src?.serialNumbers,
      lotNumber: src?.lotNumber,
      lotExpiration: src?.lotExpiration,
    };
  });
}

// ---------------------------------------------------------------------------
// createInvoice
// ---------------------------------------------------------------------------

/** Post-posting status for an invoice given its prepared amounts. */
function postedStatus(prep: PreparedInvoice): 'open' | 'partial' | 'paid' {
  const balance = prep.dueNow.minus(prep.paymentTotal);
  if (prep.paymentTotal.greaterThan(0) && balance.lessThanOrEqualTo(0)) return 'paid';
  if (prep.paymentTotal.greaterThan(0)) return 'partial';
  return 'open';
}

export async function createInvoice(ctx: ServiceContext, input: CreateInvoiceInput) {
  const prep = await prepareInvoice(ctx, input);
  const isDraft = input.status === 'draft';

  // ---------------------------------------------------------------------------
  // Persist everything in a single transaction.
  // ---------------------------------------------------------------------------
  return inTransaction(ctx, async (tx) => {
    const invoiceNumber = await nextInvoiceNumber(tx);

    // Resolve currency fields.
    const currency = input.currency ?? null;
    const exchangeRateStr = toAmountString(prep.exchangeRate);

    // 1) Insert invoice header.
    //    subtotal / discount / taxAmount / total / balanceDue are stored in TRANSACTION currency.
    //    Drafts (pending invoices) are saved with NO GL posting and NO inventory
    //    relief — `postDraftInvoice` posts them later.
    const [invoice] = await tx.db
      .insert(invoices)
      .values({
        companyId: tx.companyId,
        customerId: input.customerId,
        invoiceNumber,
        date: input.date,
        dueDate: input.dueDate ?? null,
        status: isDraft ? 'draft' : postedStatus(prep),
        taxRateId: input.taxRateId ?? null,
        classId: prep.headerClassId,
        jobId: prep.headerJobId,
        currency,
        exchangeRate: exchangeRateStr,
        discountType: prep.discountType,
        subtotal: toAmountString(prep.subtotal),
        discount: toAmountString(prep.discount),
        taxAmount: toAmountString(prep.taxAmount),
        total: toAmountString(prep.total),
        amountPaid: isDraft ? '0.00' : toAmountString(prep.paymentTotal),
        balanceDue: toAmountString(prep.dueNow.minus(prep.paymentTotal)),
        retainagePercent: prep.usesRetainage ? prep.retainagePct.toFixed(2) : null,
        retainageAmount: toAmountString(prep.retainageAmount),
        memo: input.memo ?? null,
        customFields: input.customFields ?? null,
        // postedEntryId filled below after posting (stays null for drafts)
      })
      .returning();

    // 2) Insert invoice lines.
    await tx.db.insert(invoiceLines).values(
      prep.computedLines.map((cl) => ({
        invoiceId: invoice.id,
        itemId: cl.itemId,
        accountId: cl.accountId,
        description: cl.description,
        quantity: cl.quantity,
        rate: cl.rate,
        amount: cl.amount,
        taxable: cl.taxable,
        taxRateId: cl.taxRateId,
        classId: cl.classId,
        jobId: cl.jobId,
        lineOrder: cl.lineOrder,
      })),
    );

    if (isDraft) {
      // Pending invoice: no journal entry, no COGS, no stock relief — but keep any
      // site/serial/lot the user picked so posting later relieves the right stock.
      await saveDocumentInventoryDetails(tx, {
        sourceType: 'invoice',
        sourceId: invoice.id,
        lines: inventoryLinesOf(input.lines, prep),
      });
      await writeAudit(tx, {
        action: 'create',
        entityType: 'invoice',
        entityId: invoice.id,
        newValues: {
          invoiceNumber,
          customerId: input.customerId,
          total: toAmountString(prep.total),
          status: 'draft',
        },
      });
      return { ...invoice, lines: prep.computedLines };
    }

    // 3) Build and post the journal entry.
    const entry = await postInvoiceGL(tx, prep, invoice.id, invoiceNumber, input.date);

    // 4) Stamp postedEntryId on the invoice.
    const [updated] = await tx.db
      .update(invoices)
      .set({ postedEntryId: entry.id, updatedAt: new Date() })
      .where(eq(invoices.id, invoice.id))
      .returning();

    // 5) Perpetual inventory: relieve stock + post COGS for inventory-item lines,
    //    then record which site/bin/serial/lot the stock left from.
    await postInvoiceCOGS(tx, prep, invoice.id, invoiceNumber, input.date);
    await postDocumentInventory(tx, {
      sourceType: 'invoice',
      sourceId: invoice.id,
      date: input.date,
      direction: 'out',
      lines: inventoryLinesOf(input.lines, prep),
      memo: `Invoice #${invoiceNumber}`,
    });

    // 6) Audit trail.
    await writeAudit(tx, {
      action: 'create',
      entityType: 'invoice',
      entityId: invoice.id,
      newValues: {
        invoiceNumber,
        customerId: input.customerId,
        total: toAmountString(prep.total),
        postedEntryId: entry.id,
      },
    });

    return { ...updated, lines: prep.computedLines };
  });
}

// ---------------------------------------------------------------------------
// postDraftInvoice — post a pending (draft) invoice to the GL
// ---------------------------------------------------------------------------

/**
 * Post a pending (draft) invoice: re-validates and recomputes the document from
 * its stored lines, posts the GL entry and perpetual-inventory COGS, and flips
 * the status to open/partial/paid. The fiscal-period check happens NOW (post
 * time) via `postJournalEntry`'s assertPeriodOpen on the invoice date — drafts
 * themselves are non-posting and may be saved into any period.
 */
export async function postDraftInvoice(ctx: ServiceContext, id: string) {
  const [existing] = await ctx.db
    .select()
    .from(invoices)
    .where(and(eq(invoices.companyId, ctx.companyId), eq(invoices.id, id)));
  if (!existing) throw notFound('Invoice');
  if (existing.status !== 'draft') {
    throw new ServiceError('CONFLICT', 'Only pending (draft) invoices can be posted.');
  }

  const storedLines = await ctx.db
    .select()
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, id))
    .orderBy(invoiceLines.lineOrder);

  // Rebuild the document input from storage. The stored header discount is the
  // RESOLVED dollar amount, so it re-enters as a flat 'amount' discount.
  const input: CreateInvoiceInput = {
    customerId: existing.customerId,
    date: existing.date,
    dueDate: existing.dueDate,
    taxRateId: existing.taxRateId,
    classId: existing.classId,
    jobId: existing.jobId,
    discount: existing.discount,
    discountType: 'amount',
    retainagePercent: existing.retainagePercent,
    currency: existing.currency,
    exchangeRate: existing.exchangeRate,
    memo: existing.memo,
    customFields: existing.customFields ?? null,
    lines: storedLines.map((l) => ({
      itemId: l.itemId,
      accountId: l.accountId,
      description: l.description,
      quantity: l.quantity,
      rate: l.rate,
      taxable: l.taxable,
      taxRateId: l.taxRateId,
      classId: l.classId,
      jobId: l.jobId,
    })),
  };

  const prep = await prepareInvoice(ctx, input, { excludeInvoiceId: id });

  return inTransaction(ctx, async (tx) => {
    // Re-load inside the transaction to close the read-then-post race.
    const [invoice] = await tx.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.companyId, tx.companyId), eq(invoices.id, id)));
    if (!invoice) throw notFound('Invoice');
    if (invoice.status !== 'draft') {
      throw new ServiceError('CONFLICT', 'Only pending (draft) invoices can be posted.');
    }

    // 1) Post the GL entry (assertPeriodOpen runs here, on the invoice date).
    const entry = await postInvoiceGL(tx, prep, id, invoice.invoiceNumber, invoice.date);

    // 2) Flip the header to its posted state.
    const [updated] = await tx.db
      .update(invoices)
      .set({
        status: postedStatus(prep),
        subtotal: toAmountString(prep.subtotal),
        discount: toAmountString(prep.discount),
        taxAmount: toAmountString(prep.taxAmount),
        total: toAmountString(prep.total),
        amountPaid: toAmountString(prep.paymentTotal),
        balanceDue: toAmountString(prep.dueNow.minus(prep.paymentTotal)),
        retainageAmount: toAmountString(prep.retainageAmount),
        postedEntryId: entry.id,
        updatedAt: new Date(),
      })
      .where(eq(invoices.id, id))
      .returning();

    // 3) Perpetual inventory: relieve stock + post COGS now that it is real, using the
    //    site/serial/lot detail saved with the draft.
    await postInvoiceCOGS(tx, prep, id, invoice.invoiceNumber, invoice.date);
    await postDocumentInventory(tx, {
      sourceType: 'invoice',
      sourceId: id,
      date: invoice.date,
      direction: 'out',
      lines: inventoryLinesOf(input.lines, prep),
      memo: `Invoice #${invoice.invoiceNumber}`,
      carryForward: true,
    });

    // 4) Audit trail.
    await writeAudit(tx, {
      action: 'update',
      entityType: 'invoice',
      entityId: id,
      oldValues: { status: 'draft' },
      newValues: { status: updated.status, postedEntryId: entry.id },
    });

    return { ...updated, lines: prep.computedLines };
  });
}

// ---------------------------------------------------------------------------
// updateInvoice
// ---------------------------------------------------------------------------

/**
 * Edit a saved invoice in place (QB Desktop "edit any saved transaction").
 *
 * Allowed only while NO payments/credits have been applied (amountPaid == 0)
 * and the accounting period is open (enforced by voidJournalEntry on the old
 * entry's date and postJournalEntry on the new date).
 *
 * Implementation — all inside ONE transaction:
 *   1. Void the existing journal entry.
 *   2. Void all COGS entries tagged `invoice-cogs:<id>`, restoring stock.
 *   3. Replace the invoice lines and update the header in place,
 *      preserving invoiceNumber and createdAt (the document keeps its identity).
 *   4. Re-post the GL entry and COGS from the new lines.
 *   5. Audit trail records old and new values.
 */
export async function updateInvoice(ctx: ServiceContext, id: string, input: CreateInvoiceInput) {
  // Pre-check outside the transaction for a fast, friendly error.
  const [existing] = await ctx.db
    .select()
    .from(invoices)
    .where(and(eq(invoices.companyId, ctx.companyId), eq(invoices.id, id)));
  if (!existing) throw notFound('Invoice');
  if (existing.status === 'void') {
    throw new ServiceError('CONFLICT', 'Cannot edit a voided invoice.');
  }
  if (await hasExternalPayments(ctx, existing)) {
    throw new ServiceError(
      'CONFLICT',
      'Cannot edit an invoice that has payments or credits applied. Unapply them first.',
    );
  }

  // Validate + compute the new document (read-only). Exclude this invoice's own
  // current balance from the credit-limit exposure — it is being replaced.
  const prep = await prepareInvoice(ctx, input, { excludeInvoiceId: id });

  // ── Drafts: editing a pending invoice is a simple row update — nothing was
  //    ever posted, so there is no GL/COGS to void or re-post. ──
  if (existing.status === 'draft') {
    return inTransaction(ctx, async (tx) => {
      const [invoice] = await tx.db
        .select()
        .from(invoices)
        .where(and(eq(invoices.companyId, tx.companyId), eq(invoices.id, id)));
      if (!invoice || invoice.status !== 'draft') {
        throw new ServiceError('CONFLICT', 'Invoice is no longer a draft — reload and retry.');
      }

      await tx.db.delete(invoiceLines).where(eq(invoiceLines.invoiceId, id));
      await tx.db.insert(invoiceLines).values(
        prep.computedLines.map((cl) => ({
          invoiceId: id,
          itemId: cl.itemId,
          accountId: cl.accountId,
          description: cl.description,
          quantity: cl.quantity,
          rate: cl.rate,
          amount: cl.amount,
          taxable: cl.taxable,
          taxRateId: cl.taxRateId,
          classId: cl.classId,
          jobId: cl.jobId,
          lineOrder: cl.lineOrder,
        })),
      );

      await saveDocumentInventoryDetails(tx, {
        sourceType: 'invoice',
        sourceId: id,
        lines: inventoryLinesOf(input.lines, prep),
        carryForward: true,
      });

      const [updated] = await tx.db
        .update(invoices)
        .set({
          customerId: input.customerId,
          date: input.date,
          dueDate: input.dueDate ?? null,
          status: 'draft',
          taxRateId: input.taxRateId ?? null,
          classId: prep.headerClassId,
          jobId: prep.headerJobId,
          currency: input.currency ?? null,
          exchangeRate: toAmountString(prep.exchangeRate),
          discountType: prep.discountType,
          subtotal: toAmountString(prep.subtotal),
          discount: toAmountString(prep.discount),
          taxAmount: toAmountString(prep.taxAmount),
          total: toAmountString(prep.total),
          amountPaid: '0.00',
          balanceDue: toAmountString(prep.dueNow.minus(prep.paymentTotal)),
          retainagePercent: prep.usesRetainage ? prep.retainagePct.toFixed(2) : null,
          retainageAmount: toAmountString(prep.retainageAmount),
          memo: input.memo ?? null,
          customFields:
            input.customFields !== undefined ? input.customFields : invoice.customFields,
          updatedAt: new Date(),
        })
        .where(eq(invoices.id, id))
        .returning();

      await writeAudit(tx, {
        action: 'update',
        entityType: 'invoice',
        entityId: id,
        oldValues: { status: 'draft', total: invoice.total },
        newValues: { status: 'draft', total: toAmountString(prep.total) },
      });

      return { ...updated, lines: prep.computedLines };
    });
  }

  return inTransaction(ctx, async (tx) => {
    // Re-load inside the transaction to close the read-then-write race.
    const [invoice] = await tx.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.companyId, tx.companyId), eq(invoices.id, id)));
    if (!invoice) throw notFound('Invoice');
    if (invoice.status === 'void') {
      throw new ServiceError('CONFLICT', 'Cannot edit a voided invoice.');
    }
    if (await hasExternalPayments(tx, invoice)) {
      throw new ServiceError(
        'CONFLICT',
        'Cannot edit an invoice that has payments or credits applied. Unapply them first.',
      );
    }

    // Snapshot old lines for the audit trail BEFORE replacing them.
    const oldLines = await tx.db
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, id))
      .orderBy(invoiceLines.lineOrder);

    // 1) Void the original A/R journal entry (assertPeriodOpen runs on its date).
    if (invoice.postedEntryId) {
      await voidJournalEntry(tx, invoice.postedEntryId);
    }

    // 2) Void COGS entries + restore stock (reads old lines — must precede delete),
    //    and put the stock back at the site/bin/serial it left from.
    await reverseInvoiceCOGS(tx, { id, date: invoice.date });
    await reverseDocumentInventory(tx, 'invoice', id);

    // 3) Replace lines.
    await tx.db.delete(invoiceLines).where(eq(invoiceLines.invoiceId, id));
    await tx.db.insert(invoiceLines).values(
      prep.computedLines.map((cl) => ({
        invoiceId: id,
        itemId: cl.itemId,
        accountId: cl.accountId,
        description: cl.description,
        quantity: cl.quantity,
        rate: cl.rate,
        amount: cl.amount,
        taxable: cl.taxable,
        taxRateId: cl.taxRateId,
        classId: cl.classId,
        jobId: cl.jobId,
        lineOrder: cl.lineOrder,
      })),
    );

    // 4) Re-post the GL entry from the new document, then update the header in
    //    place — invoiceNumber and createdAt are intentionally NOT touched.
    const entry = await postInvoiceGL(tx, prep, id, invoice.invoiceNumber, input.date);

    const [updated] = await tx.db
      .update(invoices)
      .set({
        customerId: input.customerId,
        date: input.date,
        dueDate: input.dueDate ?? null,
        status: postedStatus(prep),
        taxRateId: input.taxRateId ?? null,
        classId: prep.headerClassId,
        jobId: prep.headerJobId,
        currency: input.currency ?? null,
        exchangeRate: toAmountString(prep.exchangeRate),
        discountType: prep.discountType,
        subtotal: toAmountString(prep.subtotal),
        discount: toAmountString(prep.discount),
        taxAmount: toAmountString(prep.taxAmount),
        total: toAmountString(prep.total),
        amountPaid: toAmountString(prep.paymentTotal),
        balanceDue: toAmountString(prep.dueNow.minus(prep.paymentTotal)),
        retainagePercent: prep.usesRetainage ? prep.retainagePct.toFixed(2) : null,
        retainageAmount: toAmountString(prep.retainageAmount),
        memo: input.memo ?? null,
        customFields:
          input.customFields !== undefined ? input.customFields : invoice.customFields,
        postedEntryId: entry.id,
        updatedAt: new Date(),
      })
      .where(eq(invoices.id, id))
      .returning();

    // 5) Re-post perpetual inventory COGS for the new lines (site detail carried forward
    //    for lines the edit did not touch).
    await postInvoiceCOGS(tx, prep, id, invoice.invoiceNumber, input.date);
    await postDocumentInventory(tx, {
      sourceType: 'invoice',
      sourceId: id,
      date: input.date,
      direction: 'out',
      lines: inventoryLinesOf(input.lines, prep),
      memo: `Invoice #${invoice.invoiceNumber}`,
      carryForward: true,
    });

    // 6) Audit trail with old + new values.
    await writeAudit(tx, {
      action: 'update',
      entityType: 'invoice',
      entityId: id,
      oldValues: {
        customerId: invoice.customerId,
        date: invoice.date,
        dueDate: invoice.dueDate,
        subtotal: invoice.subtotal,
        discount: invoice.discount,
        taxAmount: invoice.taxAmount,
        total: invoice.total,
        memo: invoice.memo,
        postedEntryId: invoice.postedEntryId,
        lines: oldLines.map((l) => ({
          itemId: l.itemId,
          description: l.description,
          quantity: l.quantity,
          rate: l.rate,
          amount: l.amount,
        })),
      },
      newValues: {
        customerId: input.customerId,
        date: input.date,
        dueDate: input.dueDate ?? null,
        subtotal: toAmountString(prep.subtotal),
        discount: toAmountString(prep.discount),
        taxAmount: toAmountString(prep.taxAmount),
        total: toAmountString(prep.total),
        memo: input.memo ?? null,
        postedEntryId: entry.id,
        lines: prep.computedLines.map((cl) => ({
          itemId: cl.itemId,
          description: cl.description,
          quantity: cl.quantity,
          rate: cl.rate,
          amount: cl.amount,
        })),
      },
    });

    return { ...updated, lines: prep.computedLines };
  });
}

// ---------------------------------------------------------------------------
// listInvoices
// ---------------------------------------------------------------------------

export async function listInvoices(
  ctx: ServiceContext,
  opts?: { customerId?: string; status?: string },
) {
  // Filter in SQL, not in JS — fetching the whole table is O(table size) per request.
  const conds = [eq(invoices.companyId, ctx.companyId)];
  if (opts?.customerId) conds.push(eq(invoices.customerId, opts.customerId));
  if (opts?.status) conds.push(eq(invoices.status, opts.status as never));

  return ctx.db
    .select()
    .from(invoices)
    .where(and(...conds))
    .orderBy(invoices.invoiceNumber);
}

// ---------------------------------------------------------------------------
// getInvoice (with lines)
// ---------------------------------------------------------------------------

export async function getInvoice(ctx: ServiceContext, id: string) {
  const [invoice] = await ctx.db
    .select()
    .from(invoices)
    .where(and(eq(invoices.companyId, ctx.companyId), eq(invoices.id, id)));
  if (!invoice) throw notFound('Invoice');

  // Left-join item master data so line grids / printed docs can show the item
  // name, its type (discount/subtotal/payment badges), and unit of measure.
  const lines = await ctx.db
    .select({
      id: invoiceLines.id,
      invoiceId: invoiceLines.invoiceId,
      itemId: invoiceLines.itemId,
      accountId: invoiceLines.accountId,
      description: invoiceLines.description,
      quantity: invoiceLines.quantity,
      rate: invoiceLines.rate,
      amount: invoiceLines.amount,
      taxable: invoiceLines.taxable,
      classId: invoiceLines.classId,
      jobId: invoiceLines.jobId,
      taxRateId: invoiceLines.taxRateId,
      lineOrder: invoiceLines.lineOrder,
      itemName: items.name,
      itemType: items.type,
      unitOfMeasure: items.unitOfMeasure,
    })
    .from(invoiceLines)
    .leftJoin(items, eq(items.id, invoiceLines.itemId))
    .where(eq(invoiceLines.invoiceId, id))
    .orderBy(invoiceLines.lineOrder);

  return { ...invoice, lines: await attachInventoryDetails(ctx, 'invoice', id, lines) };
}

// ---------------------------------------------------------------------------
// voidInvoice
// ---------------------------------------------------------------------------

export async function voidInvoice(ctx: ServiceContext, id: string) {
  // Load invoice scoped to company.
  const [invoice] = await ctx.db
    .select()
    .from(invoices)
    .where(and(eq(invoices.companyId, ctx.companyId), eq(invoices.id, id)));
  if (!invoice) throw notFound('Invoice');

  if (invoice.status === 'void') {
    throw new ServiceError('CONFLICT', 'Invoice is already voided.');
  }

  // Payment-item lines live INSIDE the invoice's own entry (voided with it);
  // only externally applied payments/credits block the void.
  if (await hasExternalPayments(ctx, invoice)) {
    throw new ServiceError(
      'CONFLICT',
      'Cannot void an invoice that has payments applied. Unapply payments first.',
    );
  }

  return inTransaction(ctx, async (tx) => {
    // Reverse the GL entry.
    if (invoice.postedEntryId) {
      await voidJournalEntry(tx, invoice.postedEntryId);
    }

    // Reverse perpetual-inventory effects: void each COGS entry created by
    // createInvoice and put the relieved stock back on hand (and at its site).
    await reverseInvoiceCOGS(tx, { id, date: invoice.date });
    await reverseDocumentInventory(tx, 'invoice', id);

    // Mark invoice void.
    const [updated] = await tx.db
      .update(invoices)
      .set({ status: 'void', balanceDue: '0.00', updatedAt: new Date() })
      .where(eq(invoices.id, id))
      .returning();

    await writeAudit(tx, {
      action: 'void',
      entityType: 'invoice',
      entityId: id,
      oldValues: { status: invoice.status },
      newValues: { status: 'void' },
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// markPaidAmount — used by the payments service when applying/unapplying
// ---------------------------------------------------------------------------

/**
 * Update amountPaid and recompute balanceDue. Called by the payments service;
 * does NOT touch the GL (the payment service posts its own entry).
 *
 * @param amountPaidDelta  Positive = adding payment, negative = unapplying.
 */
export async function markPaidAmount(
  ctx: ServiceContext,
  invoiceId: string,
  amountPaidDelta: string | number,
) {
  const [invoice] = await ctx.db
    .select()
    .from(invoices)
    .where(and(eq(invoices.companyId, ctx.companyId), eq(invoices.id, invoiceId)));
  if (!invoice) throw notFound('Invoice');
  if (invoice.status === 'void') {
    throw new ServiceError('CONFLICT', 'Cannot apply payment to a voided invoice.');
  }

  const newAmountPaid = Money.round2(Money.of(invoice.amountPaid).plus(Money.of(amountPaidDelta)));
  if (newAmountPaid.lessThan(0)) {
    throw validation('Payment amount would make amountPaid negative.');
  }

  // Balance due is computed against the billed base (total minus any retainage holdback),
  // matching how balanceDue is set at creation. Otherwise the held-back amount would be
  // re-introduced into what is due.
  const billedBase = Money.round2(
    Money.of(invoice.total).minus(Money.of(invoice.retainageAmount ?? '0')),
  );
  const newBalance = Money.round2(billedBase.minus(newAmountPaid));
  const newStatus = newBalance.lessThanOrEqualTo(0)
    ? 'paid'
    : newAmountPaid.greaterThan(0)
      ? 'partial'
      : 'open';

  const [updated] = await ctx.db
    .update(invoices)
    .set({
      amountPaid: toAmountString(newAmountPaid),
      balanceDue: toAmountString(Money.abs(newBalance)), // guard against tiny negative rounding
      status: newStatus as never,
      updatedAt: new Date(),
    })
    .where(eq(invoices.id, invoiceId))
    .returning();

  return updated;
}
