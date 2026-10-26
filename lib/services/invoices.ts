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
import { assertAccountantDatesOpen } from './accountantCopy/guard';
import { hasAccountantCost } from './accountantCopy/inventoryCost';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { assertSalesTaxAllowed } from '@/lib/featureGate';
import { creditLimitFixes } from '@/lib/errorFixes';
import { assertStockAvailable } from './stockWarning';
import { Money, allocate, toAmountString } from '@/lib/money';
import {
  accounts,
  classes,
  companies,
  customers,
  estimateLines,
  estimates,
  inventoryLayers,
  invoices,
  invoiceLines,
  items,
  jobs,
  journalEntries,
  journalEntryLines,
  salesReps,
  taxRates,
} from '@/lib/db/schema';
import { billLines, depositLines, deposits, expenseLines, timeEntries } from '@/lib/db/schema';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { assertForeignCurrencyAllowed } from './multiCurrency';
import { assertNotControlLineAccount, postJournalEntry, voidJournalEntry } from './posting';
import { recordCOGS, valueRemainderAfter } from './inventory';
import { consumeStock, restoreConsumedStock } from './fifo';
import {
  type DocumentInventoryLine,
  type InventoryLineDetail,
  attachInventoryDetails,
  postDocumentInventory,
  reverseDocumentInventory,
  saveDocumentInventoryDetails,
} from './inventorySites';
import { type AppliedPricing, resolveLinePricing } from './pricing';
import { applyCustomerShipToDefault, applyCustomerTaxDefaults } from './customerDefaults';
import { dueDateFromTermsList } from './lists/terms';
import { allocateDocNumber, docRef, renumberDoc } from './docNumbers';
import {
  assertEstimatesNotRejected,
  checkEstimateOverBilling,
  estimatesBilledByInvoice,
  refreshEstimateBilling,
} from './estimateBilling';

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
  /**
   * Unit price. Omit on item lines to have the server price the line (price rules / price
   * levels / customer price / base price — lib/services/pricing.ts). A supplied rate that differs
   * from the computed price is kept as a manual override and flagged in the line's provenance.
   */
  rate?: string | number | null;
  /** Internal: where a carried-over price came from (conversions). Never sent by the UI. */
  pricing?: { origin?: string | null } | null;
  /** Whether this line participates in tax calculation. Defaults true. */
  taxable?: boolean;
  /** Per-line tax rate override (UUID of a taxRates row). When set, this line is taxed at this
   *  rate instead of the invoice-level rate (supports mixed-jurisdiction invoices). */
  taxRateId?: string | null;
  /** Class/department dimension for this line; falls back to the invoice-level classId. */
  classId?: string | null;
  /** Customer:Job for this line (job costing); falls back to the invoice-level jobId. */
  jobId?: string | null;
  /** Progress invoicing / estimate conversion: the estimate line this line bills. The invoice
   *  form sends it back on edit (null = no longer bills an estimate line); omitted (undefined)
   *  on an edit means "keep the link the matching old line had". Validated in prepareInvoice:
   *  it must be a line of an estimate for the same company and customer, for the same item. */
  estimateLineId?: string | null;
  /**
   * Internal (progress invoicing): the exact line amount when it differs from quantity × rate
   * only by rounding (a pro-rated quantity is kept at 4 decimals). Never accepted from the API.
   */
  amount?: string | null;
}

export interface CreateInvoiceInput {
  /**
   * Document number typed by the user (alphanumeric, e.g. "INV-1001"). Blank = the next number
   * (QB: last number used with its trailing digits + 1). See lib/services/docNumbers.ts.
   */
  refNumber?: string | null;
  /** The user confirmed the "this number is already used" warning. */
  allowDuplicateNumber?: boolean | null;
  customerId: string;
  date: Date;
  dueDate?: Date | null;
  /**
   * Payment terms (a Terms list name/code such as "Net 45", or legacy text like 'net_30').
   * A blank due date is worked out from them (standard or date-driven). Omitted on an edit =
   * keep the stored terms.
   */
  terms?: string | null;
  lines: InvoiceLineInput[];
  /** UUID of a taxRates row; if absent no tax is charged. */
  taxRateId?: string | null;
  /** Invoice-level class dimension (P&L by Class); inherited by lines without their own classId. */
  classId?: string | null;
  /** Invoice-level Customer:Job (job costing); inherited by lines without their own jobId. */
  jobId?: string | null;
  /** Sales rep credited with the sale (commissions; also a price-rule condition). */
  salesRepId?: string | null;
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
  // ---- wave2 sales: shipping (B6), send queues (C7), credit limit override (C2) ----
  shipDate?: Date | null;
  shipVia?: string | null;
  fob?: string | null;
  trackingNumber?: string | null;
  shipTo?: Record<string, string> | null;
  /** Customer's purchase-order number. */
  poNumber?: string | null;
  toBePrinted?: boolean;
  toBeEmailed?: boolean;
  /**
   * The user saw the "over credit limit" warning and chose to save anyway. Without it, an
   * invoice that pushes the customer over their credit limit is refused with a
   * VALIDATION error whose details carry `{ warning: 'CREDIT_LIMIT' }` (shown as a confirm).
   * The override is recorded in the audit trail.
   */
  overrideCreditLimit?: boolean;
  /**
   * Fix errors where they happen: the form asks the server to warn (soft NEGATIVE_STOCK warning
   * with fixes, lib/services/stockWarning.ts) when an inventory line sells more than is on hand.
   * The "Sell anyway" fix retries with false. Omitted = no check (QB lets stock go negative).
   */
  checkStock?: boolean;
  /**
   * Lines that bill estimate lines (estimateLineId) may not push a line past 100% of the
   * estimate without this flag (QB warns, then lets you): the save is refused with a
   * VALIDATION error whose details carry `{ warning: 'PROGRESS_OVERBILL', lines }`.
   */
  allowOverBilling?: boolean;
  /** Internal (statement charges, C5): mark the A/R document as a statement charge. */
  isStatementCharge?: boolean;
}

/** Shipping + send-queue columns of an A/R document, from an input (undefined keeps `prev`). */
export function shippingColumns(
  input: Pick<
    CreateInvoiceInput,
    'shipDate' | 'shipVia' | 'fob' | 'trackingNumber' | 'shipTo' | 'poNumber' | 'toBePrinted' | 'toBeEmailed'
  >,
  prev?: {
    shipDate?: Date | null;
    shipVia?: string | null;
    fob?: string | null;
    trackingNumber?: string | null;
    shipTo?: Record<string, string> | null;
    poNumber?: string | null;
    toBePrinted?: boolean;
    toBeEmailed?: boolean;
  },
) {
  const pick = <K extends keyof NonNullable<typeof prev>>(k: K, v: unknown) =>
    (v !== undefined ? v : (prev?.[k] ?? null)) as never;
  return {
    shipDate: pick('shipDate', input.shipDate),
    shipVia: pick('shipVia', input.shipVia?.trim() || (input.shipVia === undefined ? undefined : null)),
    fob: pick('fob', input.fob?.trim() || (input.fob === undefined ? undefined : null)),
    trackingNumber: pick(
      'trackingNumber',
      input.trackingNumber?.trim() || (input.trackingNumber === undefined ? undefined : null),
    ),
    shipTo: pick('shipTo', input.shipTo),
    poNumber: pick('poNumber', input.poNumber?.trim() || (input.poNumber === undefined ? undefined : null)),
    toBePrinted: (input.toBePrinted ?? prev?.toBePrinted ?? false) as boolean,
    toBeEmailed: (input.toBeEmailed ?? prev?.toBeEmailed ?? false) as boolean,
  };
}

/** Details of a credit-limit breach (warning payload / audit record). */
export interface CreditLimitBreach {
  warning: 'CREDIT_LIMIT';
  creditLimit: string;
  /** Customer's open A/R before this document (base currency). */
  currentBalance: string;
  /** Balance after this document is saved (base currency). */
  newBalance: string;
  overBy: string;
}

/**
 * Shared credit-limit check (C2 — QB warns, it does not block). Returns the breach when
 * `additionalBase` (base currency) pushes the customer's open A/R over their credit limit.
 */
export async function checkCreditLimit(
  ctx: ServiceContext,
  customerId: string,
  additionalBase: ReturnType<typeof Money.zero>,
  opts?: { excludeInvoiceId?: string },
): Promise<CreditLimitBreach | null> {
  const [customer] = await ctx.db
    .select({ creditLimit: customers.creditLimit })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, customerId)));
  if (!customer || customer.creditLimit == null) return null;
  const creditLimit = Money.of(customer.creditLimit);
  if (!creditLimit.greaterThan(0)) return null;
  // Compare in BASE currency: creditLimit and GL postings are base, but each invoice's
  // balanceDue is stored in its own transaction currency.
  const openConds = [
    eq(invoices.companyId, ctx.companyId),
    eq(invoices.customerId, customerId),
    inArray(invoices.status, ['open', 'partial', 'overdue']),
  ];
  if (opts?.excludeInvoiceId) openConds.push(ne(invoices.id, opts.excludeInvoiceId));
  const rows = await ctx.db
    .select({ balanceDue: invoices.balanceDue, exchangeRate: invoices.exchangeRate })
    .from(invoices)
    .where(and(...openConds));
  const openCharges = rows.reduce(
    (sum, row) => sum.plus(Money.round2(Money.mul(Money.of(row.balanceDue), Money.of(row.exchangeRate ?? 1)))),
    Money.zero(),
  );
  // QB checks the customer's BALANCE: open credits (unapplied credit memos, unapplied payments,
  // General Journal A/R credits — all home currency) reduce it. Same source as Receive Payments.
  // Imported lazily: payments.ts imports this module.
  const { listAvailableCredits } = await import('./payments');
  const openCredits = (await listAvailableCredits(ctx, customerId)).reduce(
    (sum, c) => sum.plus(Money.of(c.available)),
    Money.zero(),
  );
  const outstanding = Money.round2(openCharges.minus(openCredits));
  const newBalance = outstanding.plus(additionalBase);
  if (!newBalance.greaterThan(creditLimit)) return null;
  return {
    warning: 'CREDIT_LIMIT',
    creditLimit: toAmountString(creditLimit),
    currentBalance: toAmountString(outstanding),
    newBalance: toAmountString(newBalance),
    overBy: toAmountString(newBalance.minus(creditLimit)),
  };
}

/** The VALIDATION error raised for an un-acknowledged credit-limit breach. */
export function creditLimitError(breach: CreditLimitBreach): ServiceError {
  return new ServiceError(
    'VALIDATION',
    `Credit limit exceeded: this customer's balance would be ${breach.newBalance}, which is ${breach.overBy} over their credit limit of ${breach.creditLimit}. Save anyway?`,
    breach,
    creditLimitFixes(),
  );
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

/**
 * The (non-void) bank deposit that took this invoice's payment-item lines out of Undeposited
 * Funds (deposit line `invoicePayment:<id>`, lib/services/deposits.ts), or null.
 */
async function invoicePaymentDepositOf(ctx: ServiceContext, invoiceId: string) {
  const [row] = await ctx.db
    .select({ id: deposits.id, date: deposits.date })
    .from(depositLines)
    .innerJoin(deposits, eq(deposits.id, depositLines.depositId))
    .where(
      and(
        eq(deposits.companyId, ctx.companyId),
        isNull(deposits.voidedAt),
        eq(depositLines.description, `invoicePayment:${invoiceId}`),
      ),
    )
    .limit(1);
  return row ?? null;
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

/** Amount applied to the invoice from OUTSIDE it (payments, discounts, credits). */
async function externalPaidAmount(
  ctx: ServiceContext,
  invoice: { id: string; amountPaid: string | null },
) {
  if (!invoice.amountPaid || !Money.gt(invoice.amountPaid, 0)) return Money.zero();
  const paymentLines = await storedPaymentLineTotal(ctx, invoice.id);
  const ext = Money.of(invoice.amountPaid).minus(paymentLines);
  return ext.greaterThan(0) ? Money.round2(ext) : Money.zero();
}

/**
 * Editing an invoice that already has payments/credits applied (C1): the applications stay put,
 * so the edit must not invalidate them. Refuses (plain language) when the edit would change the
 * customer, the currency or exchange rate (A/R was relieved at the booked rate), or shrink the
 * invoice below what has already been applied.
 */
function assertEditKeepsApplications(
  existing: { customerId: string; currency: string | null; exchangeRate: string | null },
  input: CreateInvoiceInput,
  prep: PreparedInvoice,
  externalPaid: ReturnType<typeof Money.zero>,
) {
  if (!externalPaid.greaterThan(0)) return;
  if (input.customerId !== existing.customerId) {
    throw new ServiceError(
      'CONFLICT',
      'This invoice already has payments or credits applied, so its customer cannot be changed. Unapply them first.',
    );
  }
  if (
    (input.currency ?? null) !== (existing.currency ?? null) ||
    !Money.eq(prep.exchangeRate, Money.of(existing.exchangeRate ?? 1))
  ) {
    throw new ServiceError(
      'CONFLICT',
      'This invoice already has payments applied, so its currency and exchange rate cannot be changed. Unapply them first.',
    );
  }
  const openAfter = prep.dueNow.minus(prep.paymentTotal);
  if (externalPaid.greaterThan(openAfter)) {
    throw new ServiceError(
      'CONFLICT',
      `This invoice already has ${toAmountString(externalPaid)} in payments or credits applied, so its new amount due (${toAmountString(openAfter)}) cannot be less than that. Unapply some of the payment first, or increase the invoice.`,
    );
  }
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
  /** Advanced-pricing provenance (null for lines without a priceable item). */
  pricing: AppliedPricing | null;
  /** Estimate line billed by this line (progress invoicing / conversion), else null. */
  estimateLineId: string | null;
};

interface PreparedInvoice {
  /** Set when the user overrode a credit-limit warning (recorded in the audit trail). */
  creditLimitOverride: CreditLimitBreach | null;
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
 * `opts.alreadyApplied` (transaction currency) is what Receive Payments / credits have already
 * applied to that invoice; it stays applied, so it is not new exposure.
 */
async function prepareInvoice(
  ctx: ServiceContext,
  input: CreateInvoiceInput,
  opts?: { excludeInvoiceId?: string; alreadyApplied?: ReturnType<typeof Money.zero> },
): Promise<PreparedInvoice> {
  // --- Validate inputs ---
  if (!input.lines || input.lines.length === 0) {
    throw validation('An invoice must have at least one line.');
  }

  // Advanced pricing: fill omitted item rates server-side and record which rule/level priced
  // each line (or that the user overrode it). Every later step works on the priced lines.
  const pricedLines = await resolveLinePricing(
    ctx,
    {
      customerId: input.customerId,
      date: input.date,
      classId: input.classId ?? null,
      salesRepId: input.salesRepId ?? null,
      jobId: input.jobId ?? null,
    },
    input.lines,
  );
  input = { ...input, lines: pricedLines };

  if (input.salesRepId) {
    const [rep] = await ctx.db
      .select({ id: salesReps.id })
      .from(salesReps)
      .where(and(eq(salesReps.companyId, ctx.companyId), eq(salesReps.id, input.salesRepId)));
    if (!rep) throw notFound('Sales rep');
  }

  // Validate exchange rate.
  // Keep the rate at full precision (QB allows 4+ decimals; the column is numeric(18,8)) —
  // only home amounts are rounded to cents.
  const exchangeRate = Money.of(Money.of(input.exchangeRate ?? 1).toFixed(8));
  if (exchangeRate.lessThanOrEqualTo(0)) throw validation('Exchange rate must be positive.');
  await assertForeignCurrencyAllowed(ctx, input.currency); // A2: Multiple Currencies off

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
  // As in a QuickBooks contractor file, Retainage Receivable is an Other Current Asset, NOT an
  // A/R account: the held-back amount is not part of what the customer owes today, so it must
  // stay out of A/R (I11: A/R aging == the A/R accounts on the balance sheet). It is billed
  // later with an invoice line on this account, which moves it into A/R.
  const usesRetainage = input.retainagePercent != null && Money.of(input.retainagePercent).greaterThan(0);
  const retainageAcctId = usesRetainage
    ? await getOrCreateAccountByCode(ctx, '1250', {
        name: 'Retainage Receivable',
        type: 'asset',
        subtype: 'other_current_asset',
      })
    : null;
  if (retainageAcctId) {
    const [ret] = await ctx.db
      .select({ name: accounts.name, type: accounts.type, subtype: accounts.subtype })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, retainageAcctId)));
    if (!ret || ret.type !== 'asset' || ret.subtype === 'accounts_receivable' || ret.subtype === 'non_posting') {
      throw validation(
        `Retainage is held in account 1250${ret ? ` "${ret.name}"` : ''}, which must be an Other Current Asset account. Change that account's type to Other Current Asset in the Chart of Accounts, then save the invoice again.`,
      );
    }
  }

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

  // Estimate links (progress invoicing): each must be a line of an estimate of this company
  // for this customer, billing the same item — a client cannot move billing onto someone else's
  // estimate or onto an unrelated line.
  const linkedIds = [...new Set(input.lines.map((l) => l.estimateLineId).filter(Boolean) as string[])];
  if (linkedIds.length > 0) {
    const rows = await ctx.db
      .select({
        id: estimateLines.id,
        itemId: estimateLines.itemId,
        customerId: estimates.customerId,
        estimateStatus: estimates.status,
        estimateNumber: estimates.estimateNumber,
        estimateRef: estimates.refNumber,
      })
      .from(estimateLines)
      .innerJoin(estimates, eq(estimates.id, estimateLines.estimateId))
      .where(and(eq(estimates.companyId, ctx.companyId), inArray(estimateLines.id, linkedIds)));
    const byId = new Map(rows.map((r) => [r.id, r]));
    input.lines.forEach((l, i) => {
      if (!l.estimateLineId) return;
      const el = byId.get(l.estimateLineId);
      if (!el) throw notFound(`Estimate line ${l.estimateLineId}`);
      if (el.customerId !== input.customerId) {
        throw validation(`Line ${i + 1} bills an estimate for a different customer.`);
      }
      // Same rule as progress invoicing and estimate conversion: a declined estimate is not billed.
      if (el.estimateStatus === 'rejected') {
        throw new ServiceError(
          'CONFLICT',
          `Line ${i + 1} bills estimate ${el.estimateRef || el.estimateNumber}, which the customer rejected. Mark the estimate accepted before invoicing it.`,
        );
      }
      if ((el.itemId ?? null) !== (l.itemId ?? null)) {
        throw validation(`Line ${i + 1}: the item does not match the estimate line it bills.`);
      }
    });
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
    // A/R and A/P are never a line / discount account (QB invariant I11): an extra A/R line
    // would move the GL without moving the invoice's balance in A/R aging.
    if (kind !== 'subtotal') {
      const [lineAcct] = await ctx.db
        .select({ type: accounts.type, subtype: accounts.subtype, name: accounts.name })
        .from(accounts)
        .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, resolvedAccountId)));
      if (lineAcct) assertNotControlLineAccount(lineAcct, `Line ${i + 1}`);
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
        pricing: null,
        estimateLineId: null,
      });
      runningBody = Money.zero(); // QB: a subtotal item resets the running group
      continue;
    }

    // Quantity and rate are stored at 4 decimals (the column scale); compute the
    // amount from the stored values so a later rebuild (convert, copy) re-prices exactly.
    const qty = Money.of(l.quantity).toDecimalPlaces(4);
    const rate = Money.of(l.rate).toDecimalPlaces(4);
    if (qty.lessThanOrEqualTo(0)) throw validation(`Line ${i + 1}: quantity must be positive.`);
    if (kind !== 'discount' && rate.lessThan(0)) {
      throw validation(`Line ${i + 1}: rate cannot be negative.`);
    }

    let amount = Money.round2(Money.mul(qty, rate));
    if (l.amount != null) {
      // Progress invoicing passes the exact pro-rated amount; it may differ from qty × rate
      // only by the rounding of a 4-decimal quantity.
      const exact = Money.round2(l.amount);
      const tolerance = Money.abs(rate).times('0.0001').plus('0.05');
      if (Money.abs(exact.minus(Money.mul(qty, rate))).greaterThan(tolerance)) {
        throw validation(`Line ${i + 1}: amount does not match quantity × rate.`);
      }
      amount = exact;
    }
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
      quantity: qty.toFixed(4),
      rate: rate.toFixed(4),
      amount: toAmountString(amount),
      taxable,
      taxRateId: kind === 'income' ? (l.taxRateId ?? null) : null,
      classId: l.classId ?? headerClassId,
      jobId: l.jobId ?? headerJobId,
      lineOrder: i,
      kind,
      pricing: kind === 'income' ? pricedLines[i].pricing : null,
      estimateLineId: kind === 'income' || kind === 'discount' ? (l.estimateLineId ?? null) : null,
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
        subtype: 'undeposited_funds',
      })
    : null;

  // --- Credit limit check (QB warns; the user may save anyway — C2) ---
  // Exposure added by this document = what will be open on it (balance after payment lines,
  // and — on an edit — after the payments / credits already applied to it, which stay applied).
  let creditLimitOverride: CreditLimitBreach | null = null;
  if (customer.creditLimit != null) {
    const alreadyApplied = opts?.alreadyApplied ?? Money.zero();
    const newExposureBase = Money.round2(
      Money.mul(dueNow.minus(paymentTotal).minus(alreadyApplied).plus(retainageAmount), exchangeRate),
    );
    const breach = await checkCreditLimit(ctx, input.customerId, newExposureBase, {
      excludeInvoiceId: opts?.excludeInvoiceId,
    });
    if (breach) {
      if (!input.overrideCreditLimit) throw creditLimitError(breach);
      creditLimitOverride = breach;
    }
  }

  return {
    creditLimitOverride,
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
 *   Dr <income accounts>     = discount * fx   (header discount, split over the income lines; 0 if none)
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
  /** The number shown on the GL (typed ref number, else the legacy integer). */
  invoiceNumber: number | string,
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
    /** The invoice's own A/R line(s) — see posting.ts PostingLine.controlLine. */
    controlLine?: boolean;
  }> = [{
    accountId: arAccountId,
    weight: dueNow.minus(paymentTotal),
    memo: `Invoice #${invoiceNumber}`,
    controlLine: true,
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
    // The header discount reduces the income it discounts: split over the invoice's income
    // accounts (and classes) in proportion to their amounts — a service invoice's discount
    // reduces Service Income, not 4000. No income lines: the default income account.
    const incomeParts = [...incomeCredits.values()].filter((sp) => sp.amount.greaterThan(0));
    if (incomeParts.length === 0) {
      debitSpecs.push({ accountId: defaultIncomeId, weight: discount, memo: `Invoice #${invoiceNumber} — discount`, classId: headerClassId });
    } else {
      const shares = allocate(discount, incomeParts.map((sp) => sp.amount));
      incomeParts.forEach((sp, i) => {
        if (shares[i].greaterThan(0)) {
          debitSpecs.push({ accountId: sp.accountId, weight: shares[i], memo: `Invoice #${invoiceNumber} — discount`, classId: sp.classId ?? headerClassId });
        }
      });
    }
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
    controlLine?: boolean;
  }> = [];
  debitSpecs.forEach((s, i) => {
    if (debitAlloc[i].greaterThan(0)) {
      postingLines.push({
        accountId: s.accountId,
        debit: toAmountString(debitAlloc[i]),
        memo: s.memo,
        classId: s.classId ?? null,
        ...(s.controlLine ? { controlLine: true } : {}),
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
  /** The number shown on the GL (typed ref number, else the legacy integer). */
  invoiceNumber: number | string,
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
        classId: cl.classId, // COGS carries the sale's class (P&L by Class)
      });
      cogsEntryId = res.entryId!; // a sale always posts COGS (consumeStock refuses a $0 sale)
    } else {
      // Guard: a zero-average-cost sale would produce a $0 (unpostable) COGS entry
      // and an irreversible stock decrement — block it with a clear message.
      const [itemRow] = await tx.db
        .select({ averageCost: items.averageCost })
        .from(items)
        .where(and(eq(items.companyId, tx.companyId), eq(items.id, cl.itemId)));
      // (An Accountant's Copy import carrying the accountant's cost for this line needs no average.)
      if (!itemRow || (Money.of(itemRow.averageCost ?? '0').lessThanOrEqualTo(0) && !hasAccountantCost(cl.itemId))) {
        throw validation(
          `Inventory item "${info.name}" has no average cost. Receive stock with a unit cost (bill or inventory adjustment) before selling it.`,
        );
      }
      const res = await recordCOGS(tx, {
        itemId: cl.itemId,
        quantity: cl.quantity,
        date,
        memo: cogsMemo,
        classId: cl.classId, // COGS carries the sale's class (P&L by Class)
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
      // FIFO-tracked: the units go back into the layers the sale drew them from (the JE void
      // already restored the Inventory Asset GL balance) — see fifo.ts restoreConsumedStock.
      await restoreConsumedStock(tx, {
        itemId: line.itemId,
        itemName: item.name,
        entryId: cogsEntry.id,
        qty,
        value: cogsAmount,
        date: invoice.date,
        action: 'invoice reversed',
      });
      await tx.db
        .update(items)
        .set({ quantityOnHand: newQty.toFixed(4), updatedAt: new Date() })
        .where(eq(items.id, line.itemId));
    } else {
      // Average-cost: weight the restored value back into averageCost so the
      // item valuation stays tied to the restored GL balance. The base is the item's BOOK value
      // (round2(qty x average) — what the relief was taken from, see bookValueRelief), not the
      // unrounded product: otherwise an edit and an edit back move the average by 0.0001 and the
      // valuation by a cent.
      const currentAvg = Money.of(item.averageCost ?? '0');
      const newAvg = newQty.isZero()
        ? currentAvg
        : Money.round2(currentQty.times(currentAvg)).plus(cogsAmount).dividedBy(newQty);
      await tx.db
        .update(items)
        .set({
          quantityOnHand: newQty.toFixed(4),
          averageCost: newAvg.toFixed(4),
          // The void put cogsAmount back on the inventory account; what the new book value does not
          // show of it stays on record as the value remainder (0061), as for receipts.
          ...valueRemainderAfter(item, currentQty, newQty, newAvg, cogsAmount),
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

/** Record that the user saved past a credit-limit warning (C2). */
export async function auditCreditLimitOverride(
  tx: ServiceContext,
  entityId: string,
  breach: CreditLimitBreach,
  entityType = 'invoice',
) {
  await writeAudit(tx, {
    action: 'update',
    entityType,
    entityId,
    newValues: { creditLimitOverride: breach },
  });
}

/** B5: a blank due date follows the document's terms (Terms list first, then the legacy parser). */
async function applyTermsDueDate(ctx: ServiceContext, input: CreateInvoiceInput): Promise<CreateInvoiceInput> {
  if (input.dueDate || !input.terms?.trim()) return input;
  const dueDate = await dueDateFromTermsList(ctx, input.terms, input.date);
  return dueDate ? { ...input, dueDate } : input;
}

/** Stored `terms` varchar for an input's terms (blank → null). */
function termsColumn(terms: string | null | undefined): string | null {
  return terms?.trim() ? terms.trim().slice(0, 50) : null;
}

export async function createInvoice(ctx: ServiceContext, input: CreateInvoiceInput) {
  input = await applyTermsDueDate(ctx, input);
  await assertSalesTaxAllowed(ctx, input);
  if (input.checkStock && input.status !== 'draft') await assertStockAvailable(ctx, input.lines ?? []);
  // Customer's tax item when the form left it out; non-taxable customer → untaxed lines.
  input = await applyCustomerTaxDefaults(ctx, input, { defaultRate: true });
  input = await applyCustomerShipToDefault(ctx, input);
  const prep = await prepareInvoice(ctx, input);
  const isDraft = input.status === 'draft';

  // ---------------------------------------------------------------------------
  // Persist everything in a single transaction.
  // ---------------------------------------------------------------------------
  return inTransaction(ctx, async (tx) => {
    // Progress billing through a plain invoice: same over-billing rule as createProgressInvoice.
    // A pending invoice bills nothing yet; it is checked when it is posted.
    if (!isDraft) {
      await checkEstimateOverBilling(tx, prep.computedLines, { allowOverBilling: input.allowOverBilling });
    }

    const { refNumber, number: invoiceNumber } = await allocateDocNumber(tx, 'invoice', input.refNumber, {
      allowDuplicate: input.allowDuplicateNumber === true,
    });

    // Resolve currency fields.
    const currency = input.currency ?? null;
    const exchangeRateStr = prep.exchangeRate.toFixed(8);

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
        refNumber,
        date: input.date,
        dueDate: input.dueDate ?? null,
        terms: termsColumn(input.terms),
        status: isDraft ? 'draft' : postedStatus(prep),
        taxRateId: input.taxRateId ?? null,
        classId: prep.headerClassId,
        jobId: prep.headerJobId,
        salesRepId: input.salesRepId ?? null,
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
        ...shippingColumns(input),
        isStatementCharge: input.isStatementCharge === true,
        // postedEntryId filled below after posting (stays null for drafts)
      })
      .returning();

    if (prep.creditLimitOverride) {
      await auditCreditLimitOverride(tx, invoice.id, prep.creditLimitOverride);
    }

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
        pricing: cl.pricing as Record<string, unknown> | null,
        estimateLineId: cl.estimateLineId,
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
    const entry = await postInvoiceGL(tx, prep, invoice.id, docRef(refNumber, invoiceNumber), input.date);

    // 4) Stamp postedEntryId on the invoice.
    const [updated] = await tx.db
      .update(invoices)
      .set({ postedEntryId: entry.id, updatedAt: new Date() })
      .where(eq(invoices.id, invoice.id))
      .returning();

    // 5) Perpetual inventory: relieve stock + post COGS for inventory-item lines,
    //    then record which site/bin/serial/lot the stock left from.
    await postInvoiceCOGS(tx, prep, invoice.id, docRef(refNumber, invoiceNumber), input.date);
    await postDocumentInventory(tx, {
      sourceType: 'invoice',
      sourceId: invoice.id,
      date: input.date,
      direction: 'out',
      lines: inventoryLinesOf(input.lines, prep),
      memo: `Invoice #${docRef(refNumber, invoiceNumber)}`,
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

    // 7) Estimates this invoice bills: re-stamp amount invoiced / status.
    for (const estimateId of await estimatesBilledByInvoice(tx, invoice.id)) {
      await refreshEstimateBilling(tx, estimateId);
    }

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
export async function postDraftInvoice(
  ctx: ServiceContext,
  id: string,
  opts?: { overrideCreditLimit?: boolean; allowOverBilling?: boolean },
) {
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
    salesRepId: existing.salesRepId,
    discount: existing.discount,
    discountType: 'amount',
    retainagePercent: existing.retainagePercent,
    currency: existing.currency,
    exchangeRate: existing.exchangeRate,
    memo: existing.memo,
    customFields: existing.customFields ?? null,
    overrideCreditLimit: opts?.overrideCreditLimit,
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
      pricing: { origin: (l.pricing as { origin?: string | null } | null)?.origin ?? null },
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

    // Lines that bill estimate lines start counting now: same over-billing rule as
    // createProgressInvoice (the stored links stay on the stored lines). A rejected estimate
    // is not billed at all.
    await assertEstimatesNotRejected(tx, storedLines);
    await checkEstimateOverBilling(tx, storedLines, {
      excludeInvoiceId: id,
      allowOverBilling: opts?.allowOverBilling,
    });

    // 1) Post the GL entry (assertPeriodOpen runs here, on the invoice date).
    const entry = await postInvoiceGL(tx, prep, id, docRef(invoice.refNumber, invoice.invoiceNumber), invoice.date);
    if (prep.creditLimitOverride) await auditCreditLimitOverride(tx, id, prep.creditLimitOverride);

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
    await postInvoiceCOGS(tx, prep, id, docRef(invoice.refNumber, invoice.invoiceNumber), invoice.date);
    await postDocumentInventory(tx, {
      sourceType: 'invoice',
      sourceId: id,
      date: invoice.date,
      direction: 'out',
      lines: inventoryLinesOf(input.lines, prep),
      memo: `Invoice #${docRef(invoice.refNumber, invoice.invoiceNumber)}`,
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

    // 5) Estimates this invoice bills: re-stamp amount invoiced / status.
    for (const estimateId of await estimatesBilledByInvoice(tx, id)) {
      await refreshEstimateBilling(tx, estimateId);
    }

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
/**
 * Progress invoices: keep each edited line billing ITS estimate line. Lines that state their link
 * (estimateLineId set or null — the invoice form round-trips it) are left alone. For a line that
 * omits it (older API clients), find the old linked line it came from by content — same item,
 * description and rate first, then same item and description — never by position, so deleting
 * an earlier line cannot shift billing onto the wrong estimate line. Each old link is used once.
 */
function keepEstimateLinks(
  lines: ComputedLine[],
  inputLines: InvoiceLineInput[],
  oldLines: Array<{
    itemId: string | null;
    description: string | null;
    rate: string;
    estimateLineId: string | null;
  }>,
) {
  const pool = oldLines.filter((l) => l.estimateLineId);
  // Links the new lines state explicitly are taken.
  for (let i = 0; i < lines.length; i++) {
    if (inputLines[lines[i].lineOrder]?.estimateLineId === undefined || !lines[i].estimateLineId) continue;
    const at = pool.findIndex((o) => o.estimateLineId === lines[i].estimateLineId);
    if (at >= 0) pool.splice(at, 1);
  }
  const norm = (d: string | null) => (d ?? '').trim();
  const passes: Array<(o: (typeof pool)[number], cl: ComputedLine) => boolean> = [
    (o, cl) =>
      (o.itemId ?? null) === (cl.itemId ?? null) &&
      norm(o.description) === norm(cl.description) &&
      Money.of(o.rate).equals(Money.of(cl.rate)),
    (o, cl) => (o.itemId ?? null) === (cl.itemId ?? null) && norm(o.description) === norm(cl.description),
  ];
  for (const match of passes) {
    for (let i = 0; i < lines.length; i++) {
      const cl = lines[i];
      if (cl.estimateLineId || inputLines[cl.lineOrder]?.estimateLineId !== undefined) continue;
      if (cl.kind !== 'income' && cl.kind !== 'discount') continue;
      const at = pool.findIndex((o) => match(o, cl));
      if (at < 0) continue;
      cl.estimateLineId = pool[at].estimateLineId;
      pool.splice(at, 1);
    }
  }
}

export async function updateInvoice(ctx: ServiceContext, id: string, input: CreateInvoiceInput) {
  input = await applyCustomerTaxDefaults(ctx, input);
  input = await applyTermsDueDate(ctx, input);
  // Pre-check outside the transaction for a fast, friendly error.
  const [existing] = await ctx.db
    .select()
    .from(invoices)
    .where(and(eq(invoices.companyId, ctx.companyId), eq(invoices.id, id)));
  if (!existing) throw notFound('Invoice');
  if (existing.status === 'void') {
    throw new ServiceError('CONFLICT', 'Cannot edit a voided invoice.');
  }
  // Payments/credits already applied stay applied (QB lets you edit a paid invoice) as long as
  // the edit keeps them valid; see assertEditKeepsApplications.
  const externalPaidPre = await externalPaidAmount(ctx, existing);
  const keptTaxLines = await ctx.db
    .select({ taxRateId: invoiceLines.taxRateId })
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, id));
  await assertSalesTaxAllowed(ctx, input, [existing.taxRateId, ...keptTaxLines.map((l) => l.taxRateId)]);
  if (input.checkStock && existing.status !== 'draft') {
    // The stock this invoice already relieved comes back before the edited lines are re-sold.
    const sold = await ctx.db
      .select({ itemId: invoiceLines.itemId, quantity: invoiceLines.quantity })
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, id));
    await assertStockAvailable(ctx, input.lines ?? [], sold);
  }

  // An edit that does not mention the sales rep keeps the current one (it was usually set
  // via assignInvoiceRep, and it is also a price-rule condition).
  if (input.salesRepId === undefined) input = { ...input, salesRepId: existing.salesRepId };

  // Validate + compute the new document (read-only). Exclude this invoice's own
  // current balance from the credit-limit exposure — it is being replaced.
  const prep = await prepareInvoice(ctx, input, { excludeInvoiceId: id, alreadyApplied: externalPaidPre });
  assertEditKeepsApplications(existing, input, prep, externalPaidPre);
  // The payment-item lines are in a bank deposit: that deposit took exactly their amount out of
  // Undeposited Funds, so the edit must keep it (same amount, currency and rate).
  if (existing.status !== 'draft' && (await invoicePaymentDepositOf(ctx, id))) {
    const oldPayments = await storedPaymentLineTotal(ctx, id);
    if (
      !Money.round2(oldPayments).equals(Money.round2(prep.paymentTotal)) ||
      (input.currency ?? null) !== (existing.currency ?? null) ||
      !Money.eq(prep.exchangeRate, Money.of(existing.exchangeRate ?? 1))
    ) {
      throw new ServiceError(
        'CONFLICT',
        'The payment recorded on this invoice is part of a bank deposit, so its amount, currency and exchange rate cannot change. Remove it from the deposit (or void the deposit) first.',
      );
    }
  }

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
      const renum = await renumberDoc(
        tx, 'invoice', id, { refNumber: invoice.refNumber, number: invoice.invoiceNumber },
        input.refNumber, { allowDuplicate: input.allowDuplicateNumber === true },
      );

      const oldDraftLines = await tx.db
        .select()
        .from(invoiceLines)
        .where(eq(invoiceLines.invoiceId, id))
        .orderBy(invoiceLines.lineOrder);
      keepEstimateLinks(prep.computedLines, input.lines, oldDraftLines);
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
          pricing: cl.pricing as Record<string, unknown> | null,
          estimateLineId: cl.estimateLineId,
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
          ...(input.terms !== undefined ? { terms: termsColumn(input.terms) } : {}),
          status: 'draft',
          ...(renum ? { refNumber: renum.refNumber, invoiceNumber: renum.number } : {}),
          taxRateId: input.taxRateId ?? null,
          classId: prep.headerClassId,
          jobId: prep.headerJobId,
          salesRepId: input.salesRepId ?? null,
          currency: input.currency ?? null,
          exchangeRate: prep.exchangeRate.toFixed(8),
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
          ...shippingColumns(input, invoice),
          updatedAt: new Date(),
        })
        .where(eq(invoices.id, id))
        .returning();

      await writeAudit(tx, {
        action: 'update',
        entityType: 'invoice',
        entityId: id,
        oldValues: { status: 'draft', total: invoice.total, refNumber: invoice.refNumber },
        newValues: {
          status: 'draft',
          total: toAmountString(prep.total),
          refNumber: renum?.refNumber ?? invoice.refNumber,
          duplicateNumber: renum?.duplicate || undefined,
        },
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
    const externalPaid = await externalPaidAmount(tx, invoice);
    assertEditKeepsApplications(invoice, input, prep, externalPaid);
    // QB lets the user change the number on a saved invoice (duplicate → warn + confirm).
    const renum = await renumberDoc(
      tx, 'invoice', id, { refNumber: invoice.refNumber, number: invoice.invoiceNumber },
      input.refNumber, { allowDuplicate: input.allowDuplicateNumber === true },
    );
    const shownRef = renum ? renum.refNumber : docRef(invoice.refNumber, invoice.invoiceNumber);

    // Snapshot old lines for the audit trail BEFORE replacing them.
    const oldLines = await tx.db
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, id))
      .orderBy(invoiceLines.lineOrder);
    // Progress invoices: an edited line keeps billing the same estimate line (the form does not
    // send the link back), so the estimate's invoiced-to-date follows the edit.
    keepEstimateLinks(prep.computedLines, input.lines, oldLines);
    // The edited lines replace this invoice's old ones, so invoiced-to-date leaves it out.
    await checkEstimateOverBilling(tx, prep.computedLines, {
      excludeInvoiceId: id,
      allowOverBilling: input.allowOverBilling,
    });
    const estimatesBefore = await estimatesBilledByInvoice(tx, id);

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
        pricing: cl.pricing as Record<string, unknown> | null,
        estimateLineId: cl.estimateLineId,
      })),
    );

    // 4) Re-post the GL entry from the new document, then update the header in
    //    place — createdAt is intentionally NOT touched (the number only when retyped).
    const entry = await postInvoiceGL(tx, prep, id, shownRef, input.date);
    if (prep.creditLimitOverride) await auditCreditLimitOverride(tx, id, prep.creditLimitOverride);

    const paidNow = prep.paymentTotal.plus(externalPaid);
    const balanceNow = Money.round2(prep.dueNow.minus(paidNow));
    const [updated] = await tx.db
      .update(invoices)
      .set({
        customerId: input.customerId,
        date: input.date,
        dueDate: input.dueDate ?? null,
        ...(input.terms !== undefined ? { terms: termsColumn(input.terms) } : {}),
        ...(renum ? { refNumber: renum.refNumber, invoiceNumber: renum.number } : {}),
        status:
          balanceNow.lessThanOrEqualTo(0) && paidNow.greaterThan(0)
            ? 'paid'
            : paidNow.greaterThan(0)
              ? 'partial'
              : 'open',
        taxRateId: input.taxRateId ?? null,
        classId: prep.headerClassId,
        jobId: prep.headerJobId,
        salesRepId: input.salesRepId ?? null,
        currency: input.currency ?? null,
        exchangeRate: prep.exchangeRate.toFixed(8),
        discountType: prep.discountType,
        subtotal: toAmountString(prep.subtotal),
        discount: toAmountString(prep.discount),
        taxAmount: toAmountString(prep.taxAmount),
        total: toAmountString(prep.total),
        amountPaid: toAmountString(paidNow),
        balanceDue: toAmountString(balanceNow),
        retainagePercent: prep.usesRetainage ? prep.retainagePct.toFixed(2) : null,
        retainageAmount: toAmountString(prep.retainageAmount),
        memo: input.memo ?? null,
        customFields:
          input.customFields !== undefined ? input.customFields : invoice.customFields,
        ...shippingColumns(input, invoice),
        postedEntryId: entry.id,
        updatedAt: new Date(),
      })
      .where(eq(invoices.id, id))
      .returning();

    // 5) Re-post perpetual inventory COGS for the new lines (site detail carried forward
    //    for lines the edit did not touch).
    await postInvoiceCOGS(tx, prep, id, shownRef, input.date);
    await postDocumentInventory(tx, {
      sourceType: 'invoice',
      sourceId: id,
      date: input.date,
      direction: 'out',
      lines: inventoryLinesOf(input.lines, prep),
      memo: `Invoice #${shownRef}`,
      carryForward: true,
    });

    // 6) Audit trail with old + new values.
    await writeAudit(tx, {
      action: 'update',
      entityType: 'invoice',
      entityId: id,
      oldValues: {
        customerId: invoice.customerId,
        refNumber: invoice.refNumber,
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
        refNumber: shownRef,
        duplicateNumber: renum?.duplicate || undefined,
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

    for (const estimateId of new Set([...estimatesBefore, ...(await estimatesBilledByInvoice(tx, id))])) {
      await refreshEstimateBilling(tx, estimateId);
    }

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
      estimateLineId: invoiceLines.estimateLineId,
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
  // Its payment-item lines were swept into a bank deposit: voiding would take that money out of
  // Undeposited Funds a second time.
  if (await invoicePaymentDepositOf(ctx, id)) {
    throw new ServiceError(
      'CONFLICT',
      'The payment recorded on this invoice has been included in a deposit, so the invoice cannot be voided. Remove it from the deposit (or void the deposit) first.',
    );
  }

  return inTransaction(ctx, async (tx) => {
    // Retainage held on this invoice that has already been billed (retainage.ts billRetainage):
    // voiding would take more out of Retainage Receivable than is left there for the customer.
    if (Money.of(invoice.retainageAmount ?? '0').greaterThan(0) && invoice.status !== 'draft') {
      // Same lock as billRetainage, so a release and this void cannot interleave.
      await tx.db.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`retainage:${tx.companyId}:${invoice.customerId}`}))`,
      );
      // Imported lazily: retainage.ts imports this module (createInvoice).
      const { retainageReport } = await import('./retainage');
      const rep = await retainageReport(tx, { customerId: invoice.customerId });
      const row = rep.rows[0];
      const held = row?.documents.find((d) => d.kind === 'held' && d.invoiceId === id);
      if (row && held && Money.of(row.open).minus(Money.of(held.amount)).lessThan(0)) {
        throw new ServiceError(
          'CONFLICT',
          `The retainage held on this invoice has already been billed, so voiding it would leave Retainage Receivable negative. Void the retainage billing invoice first.`,
        );
      }
    }

    // Reverse the GL entry.
    if (invoice.postedEntryId) {
      await voidJournalEntry(tx, invoice.postedEntryId);
    }

    // Reverse perpetual-inventory effects: void each COGS entry created by
    // createInvoice and put the relieved stock back on hand (and at its site).
    await reverseInvoiceCOGS(tx, { id, date: invoice.date });
    await reverseDocumentInventory(tx, 'invoice', id);

    // Invoices made from a sales order give the order back the quantities they invoiced.
    // Imported lazily: salesOrders.ts imports this module (createInvoice).
    const { releaseSalesOrderInvoicingForInvoice } = await import('./salesOrders');
    await releaseSalesOrderInvoicingForInvoice(tx, id);

    // Mark invoice void.
    const [updated] = await tx.db
      .update(invoices)
      .set({ status: 'void', balanceDue: '0.00', updatedAt: new Date() })
      .where(eq(invoices.id, id))
      .returning();

    // Billable time & costs it billed become unbilled again (QB: voiding the invoice puts them
    // back on the Time/Costs list), so they can be billed on another invoice.
    await tx.db.update(timeEntries).set({ invoicedInvoiceId: null }).where(
      and(eq(timeEntries.companyId, tx.companyId), eq(timeEntries.invoicedInvoiceId, id)),
    );
    await tx.db.update(billLines).set({ billedInvoiceId: null }).where(eq(billLines.billedInvoiceId, id));
    await tx.db.update(expenseLines).set({ billedInvoiceId: null }).where(eq(expenseLines.billedInvoiceId, id));

    // Progress invoicing: what this invoice billed goes back onto its estimate(s).
    for (const estimateId of await estimatesBilledByInvoice(tx, id)) {
      await refreshEstimateBilling(tx, estimateId);
    }

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
  // Accountant's Copy (I1): the accountant can't change what is paid on the client's later invoices.
  await assertAccountantDatesOpen(ctx, [invoice.date], `Invoice ${invoice.refNumber ?? invoice.invoiceNumber}`);

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
  // A payment / credit larger than what is still due is refused (re-checked here, inside the
  // caller's transaction, so two concurrent applications cannot both settle the same balance).
  if (Money.of(amountPaidDelta).greaterThan(0) && newBalance.lessThan(0)) {
    throw new ServiceError(
      'CONFLICT',
      `Invoice ${invoice.refNumber ?? invoice.invoiceNumber} has only ${toAmountString(Money.round2(billedBase.minus(Money.of(invoice.amountPaid))))} due. It may have just been paid by someone else; reload and try again.`,
    );
  }
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
