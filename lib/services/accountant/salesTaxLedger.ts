/**
 * Sales-tax liability engine (QB "Pay Sales Tax", "Sales Tax Liability" and "Sales Tax Revenue
 * Summary"). wave2 accountant — gap D7/H12.
 *
 * WHY GL-DRIVEN: the old report read invoice headers only (taxRateId + taxAmount), so sales
 * receipts, credit memos, per-line rates, edits and foreign-currency postings were missed and the
 * "amount owed" disagreed with the Sales Tax Payable account. This engine starts from the ledger
 * instead: every POSTED journal line on a sales-tax liability account (2200 Sales Tax Payable plus
 * each agency's own liability account) is one unit of activity, and it is attributed to agencies:
 *
 *   - "invoice:<id>" / "salesreceipt:<id>" / "credit_memo:<id>"  → the document's own tax
 *     breakdown (header rate on the taxable base, per-line rates, manual sales-tax item lines),
 *     each rate split over its combined-rate components (or the rate's single agency). The GL
 *     amount is penny-allocated over those weights, so the per-agency amounts always sum to the
 *     posted line exactly (foreign-currency rounding included).
 *   - "tax_agency:<id>"     → a Pay Sales Tax payment to that agency.
 *   - "sales_tax_adj:<id>"  → a Sales Tax Adjustment for that agency (discount, rounding, penalty…).
 *   - anything else         → linked via sales_tax_line_links (Fix Incorrectly Recorded Sales
 *     Tax), otherwise "unattributed" — still counted, in a "needs review" bucket.
 *
 * Voided documents are excluded automatically (their entries are no longer 'posted'), edits are
 * void + re-post, so the engine always reflects the current books. Accrual results therefore tie
 * EXACTLY to the GL: Σ(agency balances) == Σ(liability account balances) as of any date.
 *
 * Attribution weights use the tax rates / components as they are NOW (like QB, which reports by
 * the current tax item setup); the amounts themselves always come from the posted ledger, so a
 * later rate change can move tax between an agency's components but never changes the totals.
 *
 * Cash basis (optional) recognizes invoice tax only as customers pay (pro rata by payment
 * applications, on the payment date). Sales receipts, credit memos, payments and adjustments are
 * recognized on their own date. Cash-basis figures are a report view; they intentionally do not
 * tie to the accrual GL.
 */
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import {
  accounts,
  auditLogs,
  creditMemoLines,
  creditMemos,
  customers,
  invoiceLines,
  invoices,
  items,
  journalEntries,
  journalEntryLines,
  paymentApplications,
  paymentsReceived,
  salesReceiptLines,
  salesReceipts,
  salesTaxLineLinks,
  taxAgencies,
  taxRateComponents,
  taxRates,
} from '@/lib/db/schema';
import { Money, allocate, toAmountString } from '@/lib/money';
import type { ServiceContext } from '../_base';

type Dec = ReturnType<typeof Money.zero>;

export const SALES_TAX_PAYABLE_CODE = '2200';

export type SalesTaxBasis = 'accrual' | 'cash';
export type SalesTaxDocType =
  | 'invoice'
  | 'sales_receipt'
  | 'credit_memo'
  | 'tax_payment'
  | 'tax_adjustment'
  | 'other';
/** How a unit of activity moves the liability. */
export type SalesTaxActivityKind = 'collected' | 'credited' | 'paid' | 'adjustment' | 'unattributed';

export interface SalesTaxActivity {
  lineId: string;
  entryId: string;
  entryNumber: number;
  date: Date;
  description: string;
  sourceRef: string | null;
  docType: SalesTaxDocType;
  docId: string | null;
  accountId: string;
  agencyId: string | null;
  taxRateId: string | null;
  /** Component / rate label ("State 6%", "Tax", "Manual sales tax", …). */
  componentName: string;
  kind: SalesTaxActivityKind;
  /** Signed effect on the amount owed (credit − debit): + increases, − decreases. 2dp string. */
  amount: string;
  /** True when attributed through a Fix-Incorrectly-Recorded-Sales-Tax link. */
  linked: boolean;
}

// ---------------------------------------------------------------------------
// Liability accounts
// ---------------------------------------------------------------------------

/** All accounts that carry sales-tax liability: 2200 plus each agency's own liability account. */
export async function salesTaxLiabilityAccounts(
  ctx: ServiceContext,
): Promise<Array<{ id: string; code: string; name: string }>> {
  const agencyRows = await ctx.db
    .select({ id: taxAgencies.liabilityAccountId })
    .from(taxAgencies)
    .where(eq(taxAgencies.companyId, ctx.companyId));
  const ids = new Set(agencyRows.map((r) => r.id).filter((x): x is string => Boolean(x)));
  // Accounts an agency USED to point at stay in scope: any liability account debited by a Pay Sales
  // Tax payment (sourceRef tax_agency:<id>). Otherwise re-pointing an agency at a new account would
  // drop its earlier payments (and the tax they cleared) out of the report and the GL tie-out.
  const historic = await ctx.db
    .selectDistinct({ id: journalEntryLines.accountId })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        sql`${journalEntries.sourceRef} LIKE 'tax_agency:%'`,
        sql`COALESCE(${journalEntryLines.debit}, 0) > 0`,
      ),
    );
  for (const h of historic) ids.add(h.id);
  const rows = await ctx.db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type, subtype: accounts.subtype })
    .from(accounts)
    .where(eq(accounts.companyId, ctx.companyId));
  // An agency account only counts when it is a plain liability account: a misconfigured agency
  // pointing at A/P, a credit card or payroll liabilities must not pull those ledgers in.
  const usable = (a: (typeof rows)[number]) =>
    a.type === 'liability' &&
    !['accounts_payable', 'credit_card'].includes(a.subtype as string) &&
    !['2000', '2100', '2300'].includes(a.code);
  return rows
    .filter((a) => a.code === SALES_TAX_PAYABLE_CODE || (ids.has(a.id) && usable(a)))
    .map((a) => ({ id: a.id, code: a.code, name: a.name }));
}

/** Natural (credit) GL balance of the sales-tax liability accounts as of `asOf` (inclusive). */
export async function salesTaxGlBalance(ctx: ServiceContext, asOf?: Date): Promise<string> {
  const accts = await salesTaxLiabilityAccounts(ctx);
  if (accts.length === 0) return '0.00';
  const conds = [
    eq(journalEntries.companyId, ctx.companyId),
    eq(journalEntries.status, 'posted'),
    inArray(
      journalEntryLines.accountId,
      accts.map((a) => a.id),
    ),
  ];
  if (asOf) conds.push(lte(journalEntries.date, asOf));
  const [row] = await ctx.db
    .select({
      d: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`,
      c: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(...conds));
  return toAmountString(Money.sub(row?.c ?? 0, row?.d ?? 0));
}

// ---------------------------------------------------------------------------
// Document tax breakdown → agency weights
// ---------------------------------------------------------------------------

interface RateInfo {
  id: string;
  name: string;
  rate: string;
  agencyId: string | null;
  components: Array<{ name: string; agencyId: string | null; rate: string }>;
}

/** One weighted share of a document's tax. */
interface TaxShare {
  agencyId: string | null;
  taxRateId: string | null;
  componentName: string;
  weight: Dec;
}

interface DocLine {
  itemId: string | null;
  amount: string;
  taxable: boolean;
  taxRateId: string | null;
}

/** Split one rate group's tax over the rate's components (or its single agency). */
function splitRate(rate: RateInfo | undefined, rateId: string | null, tax: Dec): TaxShare[] {
  if (!rate) {
    return [{ agencyId: null, taxRateId: rateId, componentName: 'Unassigned tax', weight: tax }];
  }
  if (rate.components.length === 0) {
    return [{ agencyId: rate.agencyId, taxRateId: rate.id, componentName: rate.name, weight: tax }];
  }
  const total = rate.components.reduce((s, c) => s.plus(Money.of(c.rate)), Money.zero());
  return rate.components.map((c) => ({
    agencyId: c.agencyId,
    taxRateId: rate.id,
    componentName: c.name,
    weight: total.isZero()
      ? tax.dividedBy(rate.components.length)
      : tax.times(Money.of(c.rate)).dividedBy(total),
  }));
}

/**
 * Weighted tax shares of one sales document, mirroring how invoices / sales receipts compute
 * tax: per-line rates tax their own line; the header rate taxes the remaining taxable lines
 * (discount lines included, base floored at 0); sales-tax item lines are manual tax attributed
 * to the header rate. Used only as WEIGHTS — the posted GL amount is what gets allocated.
 */
function documentShares(
  headerRateId: string | null,
  lines: DocLine[],
  itemTypes: Map<string, string>,
  rates: Map<string, RateInfo>,
): TaxShare[] {
  const byRate = new Map<string | null, Dec>();
  const add = (rateId: string | null, v: Dec) =>
    byRate.set(rateId, (byRate.get(rateId) ?? Money.zero()).plus(v));
  let headerBase = Money.zero();
  let manual = Money.zero();
  for (const l of lines) {
    const t = l.itemId ? itemTypes.get(l.itemId) : undefined;
    if (t === 'subtotal' || t === 'payment') continue;
    const amt = Money.of(l.amount);
    if (t === 'sales_tax') {
      manual = manual.plus(amt);
      continue;
    }
    if (!l.taxable) continue;
    if (l.taxRateId && t !== 'discount') {
      const r = rates.get(l.taxRateId);
      add(l.taxRateId, Money.round2(amt.times(Money.of(r?.rate ?? 0))));
    } else {
      headerBase = headerBase.plus(amt);
    }
  }
  if (headerRateId && headerBase.greaterThan(0)) {
    const r = rates.get(headerRateId);
    add(headerRateId, Money.round2(headerBase.times(Money.of(r?.rate ?? 0))));
  }
  if (manual.greaterThan(0)) add(headerRateId, manual);

  const shares: TaxShare[] = [];
  for (const [rateId, tax] of byRate) {
    if (tax.lessThanOrEqualTo(0)) continue;
    shares.push(...splitRate(rateId ? rates.get(rateId) : undefined, rateId, tax));
  }
  if (shares.length === 0 || shares.every((s) => s.weight.isZero())) {
    // No computable breakdown (legacy rows / rate changed to 0): fall back to the header rate's
    // agency split with equal weight, else one unassigned bucket.
    return splitRate(headerRateId ? rates.get(headerRateId) : undefined, headerRateId, Money.of(1));
  }
  return shares;
}

async function loadRates(ctx: ServiceContext): Promise<Map<string, RateInfo>> {
  const rateRows = await ctx.db
    .select()
    .from(taxRates)
    .where(eq(taxRates.companyId, ctx.companyId));
  const compRows = await ctx.db
    .select()
    .from(taxRateComponents)
    .where(eq(taxRateComponents.companyId, ctx.companyId));
  const map = new Map<string, RateInfo>();
  for (const r of rateRows) {
    map.set(r.id, { id: r.id, name: r.name, rate: r.rate, agencyId: r.agencyId, components: [] });
  }
  for (const c of compRows) {
    map.get(c.taxRateId)?.components.push({ name: c.name, agencyId: c.agencyId, rate: c.rate });
  }
  return map;
}

function parseSourceRef(ref: string | null): { docType: SalesTaxDocType; docId: string | null } {
  if (!ref) return { docType: 'other', docId: null };
  const i = ref.indexOf(':');
  const prefix = i < 0 ? ref : ref.slice(0, i);
  const id = i < 0 ? null : ref.slice(i + 1);
  switch (prefix) {
    case 'invoice':
      return { docType: 'invoice', docId: id };
    case 'salesreceipt':
      return { docType: 'sales_receipt', docId: id };
    case 'credit_memo':
      return { docType: 'credit_memo', docId: id };
    case 'tax_agency':
      return { docType: 'tax_payment', docId: id };
    case 'sales_tax_adj':
      return { docType: 'tax_adjustment', docId: id };
    default:
      return { docType: 'other', docId: null };
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface DocContext {
  rates: Map<string, RateInfo>;
  itemTypes: Map<string, string>;
  /** docKey "invoice:<id>" → shares */
  shares: Map<string, TaxShare[]>;
}

async function loadDocumentShares(
  ctx: ServiceContext,
  docIds: { invoice: string[]; sales_receipt: string[]; credit_memo: string[] },
): Promise<DocContext> {
  const rates = await loadRates(ctx);
  const itemRows = await ctx.db
    .select({ id: items.id, type: items.type })
    .from(items)
    .where(eq(items.companyId, ctx.companyId));
  const itemTypes = new Map(itemRows.map((r) => [r.id, r.type as string]));
  const shares = new Map<string, TaxShare[]>();

  if (docIds.invoice.length) {
    const heads = await ctx.db
      .select({ id: invoices.id, taxRateId: invoices.taxRateId })
      .from(invoices)
      .where(and(eq(invoices.companyId, ctx.companyId), inArray(invoices.id, docIds.invoice)));
    const lines = await ctx.db
      .select({
        docId: invoiceLines.invoiceId,
        itemId: invoiceLines.itemId,
        amount: invoiceLines.amount,
        taxable: invoiceLines.taxable,
        taxRateId: invoiceLines.taxRateId,
      })
      .from(invoiceLines)
      .where(inArray(invoiceLines.invoiceId, docIds.invoice));
    for (const h of heads) {
      const ls = lines.filter((l) => l.docId === h.id);
      shares.set(`invoice:${h.id}`, documentShares(h.taxRateId, ls, itemTypes, rates));
    }
  }
  if (docIds.sales_receipt.length) {
    // Receipts store their receipt-level rate since 0029; older receipts fall back to the
    // customer's default rate (lines taxed at the receipt rate carry taxRateId NULL).
    const heads = await ctx.db
      .select({ id: salesReceipts.id, taxRateId: salesReceipts.taxRateId, custRate: customers.taxRateId })
      .from(salesReceipts)
      .leftJoin(customers, eq(salesReceipts.customerId, customers.id))
      .where(
        and(eq(salesReceipts.companyId, ctx.companyId), inArray(salesReceipts.id, docIds.sales_receipt)),
      );
    const lines = await ctx.db
      .select({
        docId: salesReceiptLines.salesReceiptId,
        itemId: salesReceiptLines.itemId,
        amount: salesReceiptLines.amount,
        taxable: salesReceiptLines.taxable,
        taxRateId: salesReceiptLines.taxRateId,
      })
      .from(salesReceiptLines)
      .where(inArray(salesReceiptLines.salesReceiptId, docIds.sales_receipt));
    for (const h of heads) {
      const ls = lines.filter((l) => l.docId === h.id);
      shares.set(
        `salesreceipt:${h.id}`,
        documentShares(h.taxRateId ?? h.custRate ?? null, ls, itemTypes, rates),
      );
    }
  }
  if (docIds.credit_memo.length) {
    const heads = await ctx.db
      .select({ id: creditMemos.id, taxRateId: creditMemos.taxRateId, custRate: customers.taxRateId })
      .from(creditMemos)
      .leftJoin(customers, eq(creditMemos.customerId, customers.id))
      .where(and(eq(creditMemos.companyId, ctx.companyId), inArray(creditMemos.id, docIds.credit_memo)));
    for (const h of heads) {
      // Memo lines carry no taxable flag / per-line rate: the whole memo tax belongs to the
      // memo-level rate (legacy memos without one fall back to the customer's default rate).
      const rateId = h.taxRateId ?? h.custRate ?? null;
      shares.set(`credit_memo:${h.id}`, splitRate(rateId ? rates.get(rateId) : undefined, rateId, Money.of(1)));
    }
  }
  return { rates, itemTypes, shares };
}

// ---------------------------------------------------------------------------
// Activity (the ledger, attributed)
// ---------------------------------------------------------------------------

/**
 * Every posted line on a sales-tax liability account dated on/before `to` (all history when
 * omitted), attributed to agencies. Amounts are signed (+ increases what is owed).
 */
export async function salesTaxActivity(
  ctx: ServiceContext,
  opts: { to?: Date } = {},
): Promise<SalesTaxActivity[]> {
  const accts = await salesTaxLiabilityAccounts(ctx);
  if (accts.length === 0) return [];
  const conds = [
    eq(journalEntries.companyId, ctx.companyId),
    eq(journalEntries.status, 'posted'),
    inArray(
      journalEntryLines.accountId,
      accts.map((a) => a.id),
    ),
  ];
  if (opts.to) conds.push(lte(journalEntries.date, opts.to));
  const lines = await ctx.db
    .select({
      lineId: journalEntryLines.id,
      accountId: journalEntryLines.accountId,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
      memo: journalEntryLines.memo,
      entryId: journalEntries.id,
      entryNumber: journalEntries.entryNumber,
      date: journalEntries.date,
      description: journalEntries.description,
      sourceRef: journalEntries.sourceRef,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(...conds))
    .orderBy(journalEntries.date, journalEntries.entryNumber);
  if (lines.length === 0) return [];

  const links = await ctx.db
    .select()
    .from(salesTaxLineLinks)
    .where(eq(salesTaxLineLinks.companyId, ctx.companyId));
  const linkByLine = new Map(links.map((l) => [l.journalEntryLineId, l]));

  const docIds = { invoice: [] as string[], sales_receipt: [] as string[], credit_memo: [] as string[] };
  for (const l of lines) {
    const { docType, docId } = parseSourceRef(l.sourceRef);
    if (!docId || !UUID_RE.test(docId)) continue;
    if (docType === 'invoice' || docType === 'sales_receipt' || docType === 'credit_memo') {
      docIds[docType].push(docId);
    }
  }
  for (const k of Object.keys(docIds) as Array<keyof typeof docIds>) docIds[k] = [...new Set(docIds[k])];
  const docCtx = await loadDocumentShares(ctx, docIds);

  const agencyRows = await ctx.db
    .select({ id: taxAgencies.id })
    .from(taxAgencies)
    .where(eq(taxAgencies.companyId, ctx.companyId));
  const agencyIds = new Set(agencyRows.map((a) => a.id));

  const out: SalesTaxActivity[] = [];
  for (const l of lines) {
    const amount = Money.sub(l.credit ?? 0, l.debit ?? 0);
    if (amount.isZero()) continue;
    const parsed = parseSourceRef(l.sourceRef);
    const base = {
      lineId: l.lineId,
      entryId: l.entryId,
      entryNumber: l.entryNumber,
      date: l.date,
      description: l.description,
      sourceRef: l.sourceRef,
      docType: parsed.docType,
      docId: parsed.docId,
      accountId: l.accountId,
      linked: false,
    };
    const link = linkByLine.get(l.lineId);
    if (link) {
      out.push({
        ...base,
        agencyId: link.agencyId,
        taxRateId: null,
        componentName: link.kind === 'payment' ? 'Payment' : link.kind === 'adjustment' ? 'Adjustment' : 'Tax',
        kind: (link.kind === 'collected' ? 'collected' : link.kind === 'payment' ? 'paid' : 'adjustment'),
        amount: toAmountString(amount),
        linked: true,
      });
      continue;
    }

    if (parsed.docType === 'invoice' || parsed.docType === 'sales_receipt' || parsed.docType === 'credit_memo') {
      const key = `${parsed.docType === 'sales_receipt' ? 'salesreceipt' : parsed.docType}:${parsed.docId}`;
      const shares = docCtx.shares.get(key) ?? [
        { agencyId: null, taxRateId: null, componentName: 'Unassigned tax', weight: Money.of(1) },
      ];
      const parts = allocate(
        amount,
        shares.map((s) => s.weight),
      );
      const kind: SalesTaxActivityKind =
        parsed.docType === 'credit_memo' || amount.isNegative() ? 'credited' : 'collected';
      shares.forEach((s, i) => {
        if (parts[i].isZero()) return;
        out.push({
          ...base,
          agencyId: s.agencyId,
          taxRateId: s.taxRateId,
          componentName: s.componentName,
          kind,
          amount: toAmountString(parts[i]),
        });
      });
      continue;
    }

    if (parsed.docType === 'tax_payment' || parsed.docType === 'tax_adjustment') {
      const agencyId = parsed.docId && agencyIds.has(parsed.docId) ? parsed.docId : null;
      out.push({
        ...base,
        agencyId,
        taxRateId: null,
        componentName: parsed.docType === 'tax_payment' ? 'Payment' : 'Adjustment',
        kind: parsed.docType === 'tax_payment' ? 'paid' : 'adjustment',
        amount: toAmountString(amount),
      });
      continue;
    }

    out.push({
      ...base,
      agencyId: null,
      taxRateId: null,
      componentName: l.memo || 'Not recorded through sales tax',
      kind: 'unattributed',
      amount: toAmountString(amount),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cash basis view
// ---------------------------------------------------------------------------

/**
 * Re-time invoice tax onto customer payment dates (pro rata: applied / invoice total).
 * Everything else keeps its own date. Returns rows in the same shape as salesTaxActivity.
 */
async function toCashBasis(ctx: ServiceContext, rows: SalesTaxActivity[]): Promise<SalesTaxActivity[]> {
  const invoiceIds = [...new Set(rows.filter((r) => r.docType === 'invoice' && r.docId).map((r) => r.docId!))];
  if (invoiceIds.length === 0) return rows;
  const heads = await ctx.db
    .select({ id: invoices.id, total: invoices.total })
    .from(invoices)
    .where(and(eq(invoices.companyId, ctx.companyId), inArray(invoices.id, invoiceIds)));
  const totalById = new Map(heads.map((h) => [h.id, Money.of(h.total)]));
  const apps = await ctx.db
    .select({
      invoiceId: paymentApplications.invoiceId,
      amount: paymentApplications.amountApplied,
      date: paymentsReceived.date,
      paymentId: paymentsReceived.id,
    })
    .from(paymentApplications)
    .innerJoin(paymentsReceived, eq(paymentApplications.paymentId, paymentsReceived.id))
    .where(
      and(
        inArray(paymentApplications.invoiceId, invoiceIds),
        eq(paymentsReceived.companyId, ctx.companyId),
        sql`${paymentsReceived.voidedAt} IS NULL`,
      ),
    );
  // Credit memos applied to an invoice settle it just like a payment (QB cash basis). applyToInvoice
  // records the edge only in the audit trail (newValues.appliedToInvoice / amountApplied), so read
  // it from there. The settlement date is the later of the memo date and the invoice date, so the
  // invoice tax recognised by the credit lands in the same period as the memo's credited tax.
  const creditRows = await ctx.db
    .select({ memoId: auditLogs.entityId, newValues: auditLogs.newValues })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.companyId, ctx.companyId),
        eq(auditLogs.entityType, 'credit_memo'),
        sql`${auditLogs.newValues}->>'appliedToInvoice' IS NOT NULL`,
      ),
    );
  const relevant = creditRows.filter((c) =>
    invoiceIds.includes(String((c.newValues as { appliedToInvoice?: string } | null)?.appliedToInvoice ?? '')),
  );
  if (relevant.length > 0) {
    const memoIds = [...new Set(relevant.map((c) => c.memoId))];
    const memoHeads = await ctx.db
      .select({ id: creditMemos.id, date: creditMemos.date, status: creditMemos.status })
      .from(creditMemos)
      .where(and(eq(creditMemos.companyId, ctx.companyId), inArray(creditMemos.id, memoIds)));
    const memoById = new Map(memoHeads.map((m) => [m.id, m]));
    const invDate = new Map(
      rows.filter((r) => r.docType === 'invoice' && r.docId).map((r) => [r.docId!, r.date] as const),
    );
    for (const c of relevant) {
      const nv = c.newValues as { appliedToInvoice: string; amountApplied?: string };
      const m = memoById.get(c.memoId);
      if (!m || m.status === 'void') continue;
      const id = invDate.get(nv.appliedToInvoice);
      const date = id && id.getTime() > m.date.getTime() ? id : m.date;
      apps.push({ invoiceId: nv.appliedToInvoice, amount: nv.amountApplied ?? '0', date, paymentId: c.memoId });
    }
  }
  const out: SalesTaxActivity[] = [];
  for (const r of rows) {
    if (r.docType !== 'invoice' || !r.docId) {
      out.push(r);
      continue;
    }
    const total = totalById.get(r.docId);
    if (!total || total.isZero()) continue;
    for (const a of apps.filter((x) => x.invoiceId === r.docId)) {
      const share = Money.round2(Money.of(r.amount).times(Money.of(a.amount)).dividedBy(total));
      if (share.isZero()) continue;
      out.push({ ...r, date: a.date, amount: toAmountString(share), description: `${r.description} (paid)` });
    }
  }
  return out.sort((a, b) => a.date.getTime() - b.date.getTime());
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export interface SalesTaxRange {
  from?: Date;
  to?: Date;
  basis?: SalesTaxBasis;
}

export interface AgencyComponentRow {
  taxRateId: string | null;
  componentName: string;
  collected: string;
  credited: string;
}

export interface AgencyLiability {
  agencyId: string | null;
  agencyName: string | null;
  liabilityAccountId: string | null;
  /** Owed at the start of the range (all activity before `from`). */
  openingBalance: string;
  /** Tax charged in the range (invoices + sales receipts). */
  collected: string;
  /** Tax credited back in the range (credit memos, negative adjustments of sales docs) — ≤ 0. */
  credited: string;
  /** Sales tax adjustments in the range (signed). */
  adjustments: string;
  /** Payments to the agency in the range (positive number). */
  paid: string;
  /** Activity on liability accounts not yet attributed (only on the null-agency row). */
  unattributed: string;
  /** opening + collected + credited + adjustments + unattributed − paid  (owed as of `to`). */
  balance: string;
  components: AgencyComponentRow[];
}

export interface SalesTaxLiabilityReport {
  basis: SalesTaxBasis;
  from: string | null;
  to: string | null;
  agencies: AgencyLiability[];
  totals: Omit<AgencyLiability, 'agencyId' | 'agencyName' | 'liabilityAccountId' | 'components'>;
  /** Sales-tax liability accounts' GL balance as of `to` (accrual reference figure). */
  glBalance: string;
  /** Accrual only: Σ balances == GL. Always true unless the books are corrupt. */
  tiesToGl: boolean;
}

function inRange(d: Date, r: SalesTaxRange): 'before' | 'in' | 'after' {
  if (r.from && d < r.from) return 'before';
  if (r.to && d > r.to) return 'after';
  return 'in';
}

/** Sales Tax Liability report + Pay Sales Tax data, per agency (and per component). */
export async function salesTaxLiabilityReport(
  ctx: ServiceContext,
  range: SalesTaxRange = {},
): Promise<SalesTaxLiabilityReport> {
  const basis = range.basis ?? 'accrual';
  let rows = await salesTaxActivity(ctx, { to: basis === 'accrual' ? range.to : undefined });
  if (basis === 'cash') rows = await toCashBasis(ctx, rows);

  const agencyRows = await ctx.db
    .select({ id: taxAgencies.id, name: taxAgencies.name, liabilityAccountId: taxAgencies.liabilityAccountId })
    .from(taxAgencies)
    .where(eq(taxAgencies.companyId, ctx.companyId));

  type Acc = {
    opening: Dec;
    collected: Dec;
    credited: Dec;
    adjustments: Dec;
    paid: Dec;
    unattributed: Dec;
    comps: Map<string, { taxRateId: string | null; componentName: string; collected: Dec; credited: Dec }>;
  };
  const blank = (): Acc => ({
    opening: Money.zero(),
    collected: Money.zero(),
    credited: Money.zero(),
    adjustments: Money.zero(),
    paid: Money.zero(),
    unattributed: Money.zero(),
    comps: new Map(),
  });
  const acc = new Map<string | null, Acc>();
  for (const a of agencyRows) acc.set(a.id, blank());

  for (const r of rows) {
    const where = inRange(r.date, range);
    if (where === 'after') continue;
    const key = r.agencyId && acc.has(r.agencyId) ? r.agencyId : null;
    const a = acc.get(key) ?? blank();
    acc.set(key, a);
    const amt = Money.of(r.amount);
    if (where === 'before') {
      a.opening = a.opening.plus(amt);
      continue;
    }
    switch (r.kind) {
      case 'collected':
      case 'credited': {
        if (r.kind === 'collected') a.collected = a.collected.plus(amt);
        else a.credited = a.credited.plus(amt);
        const ck = `${r.taxRateId ?? ''}|${r.componentName}`;
        const c = a.comps.get(ck) ?? {
          taxRateId: r.taxRateId,
          componentName: r.componentName,
          collected: Money.zero(),
          credited: Money.zero(),
        };
        if (r.kind === 'collected') c.collected = c.collected.plus(amt);
        else c.credited = c.credited.plus(amt);
        a.comps.set(ck, c);
        break;
      }
      case 'paid':
        a.paid = a.paid.minus(amt); // payments are debits (negative amounts) → positive "paid"
        break;
      case 'adjustment':
        a.adjustments = a.adjustments.plus(amt);
        break;
      default:
        a.unattributed = a.unattributed.plus(amt);
    }
  }

  const fmt = (key: string | null, a: Acc): AgencyLiability => {
    const agency = key ? agencyRows.find((x) => x.id === key) : undefined;
    const balance = a.opening.plus(a.collected).plus(a.credited).plus(a.adjustments).plus(a.unattributed).minus(a.paid);
    return {
      agencyId: key,
      agencyName: agency?.name ?? null,
      liabilityAccountId: agency?.liabilityAccountId ?? null,
      openingBalance: toAmountString(a.opening),
      collected: toAmountString(a.collected),
      credited: toAmountString(a.credited),
      adjustments: toAmountString(a.adjustments),
      paid: toAmountString(a.paid),
      unattributed: toAmountString(a.unattributed),
      balance: toAmountString(balance),
      components: [...a.comps.values()]
        .map((c) => ({
          taxRateId: c.taxRateId,
          componentName: c.componentName,
          collected: toAmountString(c.collected),
          credited: toAmountString(c.credited),
        }))
        .sort((x, y) => x.componentName.localeCompare(y.componentName)),
    };
  };

  const agencies: AgencyLiability[] = [];
  for (const [key, a] of acc) {
    if (key === null) {
      const any = [a.opening, a.collected, a.credited, a.adjustments, a.paid, a.unattributed].some(
        (v) => !v.isZero(),
      );
      if (!any) continue;
    }
    agencies.push(fmt(key, a));
  }
  agencies.sort((x, y) => {
    if (x.agencyId === null) return 1;
    if (y.agencyId === null) return -1;
    return (x.agencyName ?? '').localeCompare(y.agencyName ?? '');
  });

  const sum = (f: keyof AgencyLiability) =>
    toAmountString(agencies.reduce((s, a) => s.plus(Money.of(a[f] as string)), Money.zero()));
  const totals = {
    openingBalance: sum('openingBalance'),
    collected: sum('collected'),
    credited: sum('credited'),
    adjustments: sum('adjustments'),
    paid: sum('paid'),
    unattributed: sum('unattributed'),
    balance: sum('balance'),
  };
  const glBalance = await salesTaxGlBalance(ctx, range.to);
  return {
    basis,
    from: range.from ? range.from.toISOString() : null,
    to: range.to ? range.to.toISOString() : null,
    agencies,
    totals,
    glBalance,
    tiesToGl: basis === 'accrual' ? Money.eq(glBalance, totals.balance) : false,
  };
}

// ---------------------------------------------------------------------------
// Sales Tax Revenue Summary (taxable vs non-taxable sales per tax rate)
// ---------------------------------------------------------------------------

export interface RevenueSummaryRow {
  taxRateId: string | null;
  taxRateName: string;
  rate: string;
  totalSales: string;
  nonTaxableSales: string;
  taxableSales: string;
  taxCollected: string;
}

export interface SalesTaxRevenueSummary {
  rows: RevenueSummaryRow[];
  totals: Omit<RevenueSummaryRow, 'taxRateId' | 'taxRateName' | 'rate'>;
}

/**
 * QB "Sales Tax Revenue Summary": for each tax rate (tax item) — total sales, non-taxable sales,
 * taxable sales and the tax collected (net of credit memos), from live (non-void) invoices, sales
 * receipts and credit memos dated in the range, in BASE currency. Credit memos reduce sales.
 * Tax figures come from the ledger engine so they agree with the liability report.
 */
export async function salesTaxRevenueSummary(
  ctx: ServiceContext,
  range: { from?: Date; to?: Date } = {},
): Promise<SalesTaxRevenueSummary> {
  const rates = await loadRates(ctx);
  const itemRows = await ctx.db
    .select({ id: items.id, type: items.type })
    .from(items)
    .where(eq(items.companyId, ctx.companyId));
  const itemTypes = new Map(itemRows.map((r) => [r.id, r.type as string]));

  type Acc = { total: Dec; nonTaxable: Dec; taxable: Dec; tax: Dec };
  const acc = new Map<string | null, Acc>();
  const get = (k: string | null) => {
    const a = acc.get(k) ?? { total: Money.zero(), nonTaxable: Money.zero(), taxable: Money.zero(), tax: Money.zero() };
    acc.set(k, a);
    return a;
  };
  const dateConds = (companyCol: typeof invoices.companyId, dateCol: typeof invoices.date) => {
    const c = [eq(companyCol, ctx.companyId)];
    if (range.from) c.push(sql`${dateCol} >= ${range.from}`);
    if (range.to) c.push(sql`${dateCol} <= ${range.to}`);
    return c;
  };

  const addDoc = (
    headerRateId: string | null,
    lines: DocLine[],
    fx: Dec,
    sign: 1 | -1,
  ) => {
    for (const l of lines) {
      const t = l.itemId ? itemTypes.get(l.itemId) : undefined;
      if (t === 'subtotal' || t === 'payment' || t === 'sales_tax') continue;
      const amt = Money.round2(Money.of(l.amount).times(fx)).times(sign);
      const rateId = l.taxable ? (l.taxRateId && t !== 'discount' ? l.taxRateId : headerRateId) : headerRateId;
      const a = get(rateId);
      a.total = a.total.plus(amt);
      if (l.taxable && rateId) a.taxable = a.taxable.plus(amt);
      else a.nonTaxable = a.nonTaxable.plus(amt);
    }
  };

  const invHeads = await ctx.db
    .select({ id: invoices.id, taxRateId: invoices.taxRateId, fx: invoices.exchangeRate })
    .from(invoices)
    .where(and(...dateConds(invoices.companyId, invoices.date), sql`${invoices.status} NOT IN ('void', 'draft')`));
  if (invHeads.length) {
    const lines = await ctx.db
      .select({
        docId: invoiceLines.invoiceId,
        itemId: invoiceLines.itemId,
        amount: invoiceLines.amount,
        taxable: invoiceLines.taxable,
        taxRateId: invoiceLines.taxRateId,
      })
      .from(invoiceLines)
      .where(inArray(invoiceLines.invoiceId, invHeads.map((h) => h.id)));
    for (const h of invHeads) {
      addDoc(h.taxRateId, lines.filter((l) => l.docId === h.id), Money.of(h.fx ?? 1), 1);
    }
  }

  const srHeads = await ctx.db
    .select({ id: salesReceipts.id, taxRateId: salesReceipts.taxRateId, custRate: customers.taxRateId })
    .from(salesReceipts)
    .leftJoin(customers, eq(salesReceipts.customerId, customers.id))
    .where(and(...dateConds(salesReceipts.companyId as never, salesReceipts.date as never), sql`${salesReceipts.status} <> 'void'`));
  if (srHeads.length) {
    const lines = await ctx.db
      .select({
        docId: salesReceiptLines.salesReceiptId,
        itemId: salesReceiptLines.itemId,
        amount: salesReceiptLines.amount,
        taxable: salesReceiptLines.taxable,
        taxRateId: salesReceiptLines.taxRateId,
      })
      .from(salesReceiptLines)
      .where(inArray(salesReceiptLines.salesReceiptId, srHeads.map((h) => h.id)));
    for (const h of srHeads) {
      addDoc(h.taxRateId ?? h.custRate ?? null, lines.filter((l) => l.docId === h.id), Money.of(1), 1);
    }
  }

  const cmHeads = await ctx.db
    .select({
      id: creditMemos.id,
      taxRateId: creditMemos.taxRateId,
      taxAmount: creditMemos.taxAmount,
      custRate: customers.taxRateId,
    })
    .from(creditMemos)
    .leftJoin(customers, eq(creditMemos.customerId, customers.id))
    .where(and(...dateConds(creditMemos.companyId as never, creditMemos.date as never), sql`${creditMemos.status} <> 'void'`));
  if (cmHeads.length) {
    const lines = await ctx.db
      .select({ docId: creditMemoLines.creditMemoId, itemId: creditMemoLines.itemId, amount: creditMemoLines.amount })
      .from(creditMemoLines)
      .where(inArray(creditMemoLines.creditMemoId, cmHeads.map((h) => h.id)));
    for (const h of cmHeads) {
      const rateId = h.taxRateId ?? (Money.gt(h.taxAmount, 0) ? h.custRate : null) ?? null;
      const taxed = Money.gt(h.taxAmount, 0) && rateId !== null;
      addDoc(
        rateId,
        lines.filter((l) => l.docId === h.id).map((l) => ({ ...l, taxable: taxed, taxRateId: null })),
        Money.of(1),
        -1,
      );
    }
  }

  // Tax: from the ledger engine (collected + credited in range), grouped by rate.
  const activity = await salesTaxActivity(ctx, { to: range.to });
  for (const r of activity) {
    if (r.kind !== 'collected' && r.kind !== 'credited') continue;
    if (range.from && r.date < range.from) continue;
    get(r.taxRateId).tax = get(r.taxRateId).tax.plus(Money.of(r.amount));
  }

  const rows: RevenueSummaryRow[] = [...acc.entries()].map(([k, a]) => {
    const rate = k ? rates.get(k) : undefined;
    return {
      taxRateId: k,
      taxRateName: rate?.name ?? (k ? 'Unknown rate' : 'No tax rate'),
      rate: rate?.rate ?? '0.000000',
      totalSales: toAmountString(a.total),
      nonTaxableSales: toAmountString(a.nonTaxable),
      taxableSales: toAmountString(a.taxable),
      taxCollected: toAmountString(a.tax),
    };
  });
  rows.sort((a, b) => a.taxRateName.localeCompare(b.taxRateName));
  const s = (f: 'totalSales' | 'nonTaxableSales' | 'taxableSales' | 'taxCollected') =>
    toAmountString(rows.reduce((t, r) => t.plus(Money.of(r[f])), Money.zero()));
  return {
    rows,
    totals: {
      totalSales: s('totalSales'),
      nonTaxableSales: s('nonTaxableSales'),
      taxableSales: s('taxableSales'),
      taxCollected: s('taxCollected'),
    },
  };
}
