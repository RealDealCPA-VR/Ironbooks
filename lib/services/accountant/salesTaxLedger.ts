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
 * Cash basis (optional) recognizes invoice tax only as customers settle the invoice, pro rata to
 * its billed base (total minus retainage), on the settlement dates cashBasisLedger.ts uses:
 * payments (cash + early-payment discount), credits applied, payment-item lines on the invoice,
 * and bounced checks reversed on the bounce date (see invoiceSettlements). Sales receipts, credit
 * memos, payments and adjustments are recognized on their own date. Cash-basis figures are a
 * report view; they intentionally do not tie to the accrual GL.
 */
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import {
  accounts,
  bouncedChecks,
  creditApplications,
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

/**
 * Ids per `IN (…)` query. A company's whole sales history can name more forms than the database
 * accepts bound parameters in one statement (65,535), so id lists are queried in chunks.
 */
const ID_CHUNK = 1000;

async function inChunks<T>(ids: readonly string[], fetch: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    for (const row of await fetch(ids.slice(i, i + ID_CHUNK))) out.push(row);
  }
  return out;
}

/** Rows grouped by a key (instead of filtering the whole list once per document). */
function groupRows<T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

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
    const heads = await inChunks(docIds.invoice, (ids) =>
      ctx.db
        .select({ id: invoices.id, taxRateId: invoices.taxRateId })
        .from(invoices)
        .where(and(eq(invoices.companyId, ctx.companyId), inArray(invoices.id, ids))),
    );
    const lines = groupRows(
      await inChunks(docIds.invoice, (ids) =>
        ctx.db
          .select({
            docId: invoiceLines.invoiceId,
            itemId: invoiceLines.itemId,
            amount: invoiceLines.amount,
            taxable: invoiceLines.taxable,
            taxRateId: invoiceLines.taxRateId,
          })
          .from(invoiceLines)
          .where(inArray(invoiceLines.invoiceId, ids)),
      ),
      (l) => l.docId,
    );
    for (const h of heads) {
      const ls = lines.get(h.id) ?? [];
      shares.set(`invoice:${h.id}`, documentShares(h.taxRateId, ls, itemTypes, rates));
    }
  }
  if (docIds.sales_receipt.length) {
    // Receipts store their receipt-level rate since 0029; older receipts fall back to the
    // customer's default rate (lines taxed at the receipt rate carry taxRateId NULL).
    const heads = await inChunks(docIds.sales_receipt, (ids) =>
      ctx.db
        .select({ id: salesReceipts.id, taxRateId: salesReceipts.taxRateId, custRate: customers.taxRateId })
        .from(salesReceipts)
        .leftJoin(customers, eq(salesReceipts.customerId, customers.id))
        .where(and(eq(salesReceipts.companyId, ctx.companyId), inArray(salesReceipts.id, ids))),
    );
    const lines = groupRows(
      await inChunks(docIds.sales_receipt, (ids) =>
        ctx.db
          .select({
            docId: salesReceiptLines.salesReceiptId,
            itemId: salesReceiptLines.itemId,
            amount: salesReceiptLines.amount,
            taxable: salesReceiptLines.taxable,
            taxRateId: salesReceiptLines.taxRateId,
          })
          .from(salesReceiptLines)
          .where(inArray(salesReceiptLines.salesReceiptId, ids)),
      ),
      (l) => l.docId,
    );
    for (const h of heads) {
      const ls = lines.get(h.id) ?? [];
      shares.set(
        `salesreceipt:${h.id}`,
        documentShares(h.taxRateId ?? h.custRate ?? null, ls, itemTypes, rates),
      );
    }
  }
  if (docIds.credit_memo.length) {
    const heads = await inChunks(docIds.credit_memo, (ids) =>
      ctx.db
        .select({ id: creditMemos.id, taxRateId: creditMemos.taxRateId, custRate: customers.taxRateId })
        .from(creditMemos)
        .leftJoin(customers, eq(creditMemos.customerId, customers.id))
        .where(and(eq(creditMemos.companyId, ctx.companyId), inArray(creditMemos.id, ids))),
    );
    for (const h of heads) {
      // Memo lines carry no per-line rate: the whole memo tax belongs to the memo-level rate
      // (legacy memos without one fall back to the customer's default rate).
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
 * Re-time invoice tax onto the dates customers settle the invoice (pro rata: settled / billed
 * base, see invoiceSettlements). Everything else keeps its own date. Returns rows in the same
 * shape as salesTaxActivity.
 */
async function toCashBasis(ctx: ServiceContext, rows: SalesTaxActivity[]): Promise<SalesTaxActivity[]> {
  const invoiceIds = [...new Set(rows.filter((r) => r.docType === 'invoice' && r.docId).map((r) => r.docId!))];
  if (invoiceIds.length === 0) return rows;
  const heads = await loadInvoiceHeads(ctx, invoiceIds);
  const baseById = new Map(heads.map((h) => [h.id, settledBase(h)]));
  const byInvoice = groupByInvoice(await invoiceSettlements(ctx, heads));
  const out: SalesTaxActivity[] = [];
  for (const r of rows) {
    if (r.docType !== 'invoice' || !r.docId) {
      out.push(r);
      continue;
    }
    const base = baseById.get(r.docId);
    if (!base) continue;
    if (!base.greaterThan(0)) {
      // Nothing can ever be paid on it (e.g. 100% retainage): recognize the tax on its own date.
      out.push(r);
      continue;
    }
    // Cumulative allocation: each settlement's share is round(tax * cumulative settled / base)
    // minus what earlier settlements already took, so rounding never drifts. Once the invoice is
    // fully settled the shares sum to exactly the invoice tax (cash basis == accrual); a bounced
    // check (negative settlement) takes its share back on the bounce date.
    const tax = Money.of(r.amount);
    let cum = Money.zero();
    let allocated = Money.zero();
    for (const a of byInvoice.get(r.docId) ?? []) {
      cum = cum.plus(a.amount);
      const target = cum.greaterThanOrEqualTo(base)
        ? tax
        : cum.lessThanOrEqualTo(0)
          ? Money.zero()
          : Money.round2(tax.times(cum).dividedBy(base));
      const share = target.minus(allocated);
      allocated = target;
      if (share.isZero()) continue;
      const note = a.amount.isNegative() ? 'payment reversed' : 'paid';
      out.push({ ...r, date: a.date, amount: toAmountString(share), description: `${r.description} (${note})` });
    }
  }
  return out.sort((a, b) => a.date.getTime() - b.date.getTime());
}

/** Invoice header fields the cash-basis views need. */
interface InvoiceHead {
  id: string;
  date: Date;
  total: string;
  retainageAmount: string | null;
  amountPaid: string;
}

async function loadInvoiceHeads(ctx: ServiceContext, invoiceIds: string[]): Promise<InvoiceHead[]> {
  if (invoiceIds.length === 0) return [];
  return inChunks(invoiceIds, (ids) =>
    ctx.db
      .select({
        id: invoices.id,
        date: invoices.date,
        total: invoices.total,
        retainageAmount: invoices.retainageAmount,
        amountPaid: invoices.amountPaid,
      })
      .from(invoices)
      .where(and(eq(invoices.companyId, ctx.companyId), inArray(invoices.id, ids))),
  );
}

/**
 * What settling the invoice in full means: its billed base, total minus the retainage held back
 * (as in cashBasisLedger.ts and QB, where retainage is a balance-sheet line of the invoice).
 * Paying the billed base recognizes all of the invoice's tax; the retainage billing invoice that
 * later collects the holdback carries no tax of its own.
 */
function settledBase(h: Pick<InvoiceHead, 'total' | 'retainageAmount'>): Dec {
  return Money.sub(h.total, h.retainageAmount ?? 0);
}

/** One dated settlement of an invoice (signed: a bounced check reverses on its own date). */
interface InvoiceSettlement {
  invoiceId: string;
  amount: Dec;
  date: Date;
  /** Tie-break for a stable order. */
  key: string;
}

function groupByInvoice(list: InvoiceSettlement[]): Map<string, InvoiceSettlement[]> {
  const m = new Map<string, InvoiceSettlement[]>();
  for (const s of list) {
    const arr = m.get(s.invoiceId) ?? [];
    arr.push(s);
    m.set(s.invoiceId, arr);
  }
  return m;
}

/**
 * Every settlement of the given invoices, dated: the same events the cash-basis ledger
 * (cashBasisLedger.ts) recognizes invoice income on, so cash-basis tax and income agree (QB):
 *  - payment applications: cash + early-payment discount, on the payment date;
 *  - bounced checks: the snapshotted applications stay settled on the payment date and reverse
 *    on the bounce date (a period already reported is never rewritten);
 *  - credit memos applied (live credit_applications rows; an undone application is gone), on the
 *    memo date, where the memo's own credited tax is recognized, so the two offset;
 *  - whatever the invoice still shows as paid beyond those (payment-item lines entered on the
 *    invoice itself, legacy credits applied before credit_applications existed), on the invoice
 *    date.
 * No settlement counts before the invoice date. Sorted by date, positive settlements first on the
 * same day (a same-day bounce never dips below zero).
 */
async function invoiceSettlements(ctx: ServiceContext, heads: InvoiceHead[]): Promise<InvoiceSettlement[]> {
  if (heads.length === 0) return [];
  const ids = heads.map((h) => h.id);
  const headById = new Map(heads.map((h) => [h.id, h]));
  const out: InvoiceSettlement[] = [];
  const dated = new Map<string, Dec>();
  const push = (invoiceId: string, amount: Dec, date: Date, key: string) => {
    const h = headById.get(invoiceId);
    if (!h || amount.isZero()) return;
    out.push({ invoiceId, amount, date: date < h.date ? h.date : date, key });
    dated.set(invoiceId, (dated.get(invoiceId) ?? Money.zero()).plus(amount));
  };

  const pays = await inChunks(ids, (chunk) =>
    ctx.db
      .select({
        invoiceId: paymentApplications.invoiceId,
        applied: paymentApplications.amountApplied,
        discount: paymentApplications.discountAmount,
        date: paymentsReceived.date,
        paymentId: paymentsReceived.id,
      })
      .from(paymentApplications)
      .innerJoin(paymentsReceived, eq(paymentApplications.paymentId, paymentsReceived.id))
      .where(
        and(
          inArray(paymentApplications.invoiceId, chunk),
          eq(paymentsReceived.companyId, ctx.companyId),
          sql`${paymentsReceived.voidedAt} IS NULL`,
        ),
      ),
  );
  for (const p of pays) {
    push(String(p.invoiceId), Money.add(p.applied, p.discount ?? 0), p.date, `p:${p.paymentId}`);
  }

  // Bounced checks: recordBouncedCheck deletes the payment's applications (snapshotted on the
  // bounced-check row) and reopens the invoices.
  const bounced = await ctx.db
    .select({
      date: bouncedChecks.date,
      applications: bouncedChecks.applications,
      payDate: paymentsReceived.date,
      paymentId: paymentsReceived.id,
    })
    .from(bouncedChecks)
    .innerJoin(paymentsReceived, eq(bouncedChecks.paymentId, paymentsReceived.id))
    .where(eq(bouncedChecks.companyId, ctx.companyId));
  for (const b of bounced) {
    for (const a of b.applications ?? []) {
      const invoiceId = String(a.invoiceId ?? '');
      const amount = Money.add(a.amountApplied ?? 0, a.discountAmount ?? 0);
      if (!amount.greaterThan(0) || !headById.has(invoiceId)) continue;
      push(invoiceId, amount, b.payDate, `p:${b.paymentId}`);
      push(invoiceId, amount.negated(), b.date, `b:${b.paymentId}`);
    }
  }

  // Credit memos applied to the invoices settle them just like a payment (QB cash basis). The live
  // credit_applications rows say how much (an undone application is deleted, so it stops counting).
  // The settlement is dated like the memo's own credited tax, which cash basis recognizes on the
  // memo date: the later of the memo date and the invoice date. The two then offset in the same
  // period. Dating it on the application day instead would leave the memo month with a negative
  // liability whenever a credit is applied later than it was issued.
  const credits = await inChunks(ids, (chunk) =>
    ctx.db
      .select({
        id: creditApplications.id,
        invoiceId: creditApplications.invoiceId,
        amount: creditApplications.amount,
        memoDate: creditMemos.date,
        memoStatus: creditMemos.status,
      })
      .from(creditApplications)
      .innerJoin(creditMemos, eq(creditMemos.id, creditApplications.creditMemoId))
      .where(and(eq(creditApplications.companyId, ctx.companyId), inArray(creditApplications.invoiceId, chunk))),
  );
  for (const c of credits) {
    if (c.memoStatus === 'void') continue;
    push(c.invoiceId, Money.of(c.amount), c.memoDate, `c:${c.id}`);
  }

  // The rest of what the invoice shows as paid (payment-item lines, legacy credits).
  for (const h of heads) {
    const rest = Money.of(h.amountPaid).minus(dated.get(h.id) ?? Money.zero());
    if (rest.greaterThan(0)) push(h.id, rest, h.date, 'a:own');
  }

  out.sort(
    (a, b) =>
      a.date.getTime() - b.date.getTime() || b.amount.comparedTo(a.amount) || a.key.localeCompare(b.key),
  );
  return out;
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
  basis: SalesTaxBasis;
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
  range: { from?: Date; to?: Date; basis?: SalesTaxBasis } = {},
): Promise<SalesTaxRevenueSummary> {
  const basis = range.basis ?? 'accrual';
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
    share?: { before: Dec; through: Dec },
  ) => {
    for (const l of lines) {
      const t = l.itemId ? itemTypes.get(l.itemId) : undefined;
      if (t === 'subtotal' || t === 'payment' || t === 'sales_tax') continue;
      const full = Money.round2(Money.of(l.amount).times(fx));
      // Cash basis: cumulative allocation per line — round(amount x paid-through-end / total) minus
      // round(amount x paid-before-start / total) — so adjacent periods add up exactly to the whole.
      const part = share
        ? Money.round2(full.times(share.through)).minus(Money.round2(full.times(share.before)))
        : full;
      const amt = part.times(sign);
      const rateId = l.taxable ? (l.taxRateId && t !== 'discount' ? l.taxRateId : headerRateId) : headerRateId;
      const a = get(rateId);
      a.total = a.total.plus(amt);
      if (l.taxable && rateId) a.taxable = a.taxable.plus(amt);
      else a.nonTaxable = a.nonTaxable.plus(amt);
    }
  };

  // Cash basis (QB "owe sales tax upon receipt of payment"): an invoice's sales count only as the
  // customer settles it, pro rata (settled in range / billed base), on the settlement dates.
  const invHeadsAll = await ctx.db
    .select({
      id: invoices.id,
      taxRateId: invoices.taxRateId,
      fx: invoices.exchangeRate,
      total: invoices.total,
      retainageAmount: invoices.retainageAmount,
      amountPaid: invoices.amountPaid,
      date: invoices.date,
    })
    .from(invoices)
    .where(
      and(
        ...(basis === 'cash' ? [eq(invoices.companyId, ctx.companyId)] : dateConds(invoices.companyId, invoices.date)),
        sql`${invoices.status} NOT IN ('void', 'draft')`,
      ),
    );
  // Cash basis: fraction of each invoice settled before the range start and through the range end
  // (clamped to 0..1). Sales in range = share through end minus share before start, rounded per line
  // on the running total (same cumulative approach as toCashBasis uses for the tax).
  const invShare = new Map<string, { before: Dec; through: Dec }>();
  if (basis === 'cash' && invHeadsAll.length) {
    const byInvoice = groupByInvoice(await invoiceSettlements(ctx, invHeadsAll));
    for (const h of invHeadsAll) {
      const base = settledBase(h);
      if (!base.greaterThan(0)) {
        // Nothing can be paid on it (e.g. 100% retainage): its sales count on its own date.
        if (Money.gt(h.total, 0) && inRange(h.date, range) === 'in') {
          invShare.set(h.id, { before: Money.zero(), through: Money.of(1) });
        }
        continue;
      }
      let before = Money.zero();
      let through = Money.zero();
      for (const x of byInvoice.get(h.id) ?? []) {
        const where = inRange(x.date, range);
        if (where === 'after') continue;
        through = through.plus(x.amount);
        if (where === 'before') before = before.plus(x.amount);
      }
      const frac = (v: Dec) =>
        v.greaterThanOrEqualTo(base) ? Money.of(1) : v.lessThanOrEqualTo(0) ? Money.zero() : v.dividedBy(base);
      const share = { before: frac(before), through: frac(through) };
      // A bounced check in range gives a negative share (the sales it had recognized come back off).
      if (!share.through.equals(share.before)) invShare.set(h.id, share);
    }
  }
  const invHeads = basis === 'cash' ? invHeadsAll.filter((h) => invShare.has(h.id)) : invHeadsAll;
  if (invHeads.length) {
    // Billed retainage (a line on Retainage Receivable, see retainage.ts billRetainage) collects a
    // receivable the original invoice already counted as sales (and taxed): it is not a sale.
    const [retainageAcct] = await ctx.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '1250')));
    const lines = await inChunks(
      invHeads.map((h) => h.id),
      (ids) =>
        ctx.db
          .select({
            docId: invoiceLines.invoiceId,
            itemId: invoiceLines.itemId,
            accountId: invoiceLines.accountId,
            amount: invoiceLines.amount,
            taxable: invoiceLines.taxable,
            taxRateId: invoiceLines.taxRateId,
          })
          .from(invoiceLines)
          .where(inArray(invoiceLines.invoiceId, ids)),
    );
    const salesLines = groupRows(retainageAcct ? lines.filter((l) => l.accountId !== retainageAcct.id) : lines, (l) => l.docId);
    for (const h of invHeads) {
      addDoc(h.taxRateId, salesLines.get(h.id) ?? [], Money.of(h.fx ?? 1), 1, invShare.get(h.id));
    }
  }

  const srHeads = await ctx.db
    .select({ id: salesReceipts.id, taxRateId: salesReceipts.taxRateId, custRate: customers.taxRateId })
    .from(salesReceipts)
    .leftJoin(customers, eq(salesReceipts.customerId, customers.id))
    .where(and(...dateConds(salesReceipts.companyId as never, salesReceipts.date as never), sql`${salesReceipts.status} <> 'void'`));
  if (srHeads.length) {
    const lines = groupRows(
      await inChunks(
        srHeads.map((h) => h.id),
        (ids) =>
          ctx.db
            .select({
              docId: salesReceiptLines.salesReceiptId,
              itemId: salesReceiptLines.itemId,
              amount: salesReceiptLines.amount,
              taxable: salesReceiptLines.taxable,
              taxRateId: salesReceiptLines.taxRateId,
            })
            .from(salesReceiptLines)
            .where(inArray(salesReceiptLines.salesReceiptId, ids)),
      ),
      (l) => l.docId,
    );
    for (const h of srHeads) {
      addDoc(h.taxRateId ?? h.custRate ?? null, lines.get(h.id) ?? [], Money.of(1), 1);
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
    const lines = groupRows(
      await inChunks(
        cmHeads.map((h) => h.id),
        (ids) =>
          ctx.db
            .select({
              docId: creditMemoLines.creditMemoId,
              itemId: creditMemoLines.itemId,
              amount: creditMemoLines.amount,
              taxable: creditMemoLines.taxable,
            })
            .from(creditMemoLines)
            .where(inArray(creditMemoLines.creditMemoId, ids)),
      ),
      (l) => l.docId,
    );
    for (const h of cmHeads) {
      // Legacy memos without a memo-level rate fall back to the customer's rate when they carry tax.
      const rateId = h.taxRateId ?? (Money.gt(h.taxAmount, 0) ? h.custRate : null) ?? null;
      addDoc(
        rateId,
        // Each line keeps its own Tax flag (a returned non-taxable line is not a taxable sale).
        (lines.get(h.id) ?? []).map((l) => ({ ...l, taxable: rateId !== null && l.taxable !== false, taxRateId: null })),
        Money.of(1),
        -1,
      );
    }
  }

  // Tax: from the ledger engine (collected + credited in range), grouped by rate.
  let activity = await salesTaxActivity(ctx, { to: basis === 'accrual' ? range.to : undefined });
  if (basis === 'cash') activity = await toCashBasis(ctx, activity);
  for (const r of activity) {
    if (r.kind !== 'collected' && r.kind !== 'credited') continue;
    if (inRange(r.date, range) !== 'in') continue;
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
    basis,
    rows,
    totals: {
      totalSales: s('totalSales'),
      nonTaxableSales: s('nonTaxableSales'),
      taxableSales: s('taxableSales'),
      taxCollected: s('taxCollected'),
    },
  };
}

// ---------------------------------------------------------------------------
// Filing periods + "Show sales tax due through" (QB Pay Sales Tax)
// ---------------------------------------------------------------------------

export type SalesTaxFrequency = 'monthly' | 'quarterly' | 'annually';

const isoDay = (y: number, m0: number, d: number) =>
  new Date(Date.UTC(y, m0, d)).toISOString().slice(0, 10);

/**
 * The last COMPLETE filing period before `today` for a filing frequency (calendar months,
 * quarters and years, as QB uses): on 2026-10-12 monthly → Sep 1–30, quarterly → Jul 1–Sep 30,
 * annually → 2025-01-01–2025-12-31. Dates are YYYY-MM-DD.
 */
export function lastFilingPeriod(
  frequency: SalesTaxFrequency,
  today: Date | string = new Date(),
): { from: string; to: string } {
  const t = typeof today === 'string' ? new Date(`${today.slice(0, 10)}T12:00:00.000Z`) : today;
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth();
  if (frequency === 'monthly') {
    return { from: isoDay(y, m - 1, 1), to: isoDay(y, m, 0) };
  }
  if (frequency === 'annually') {
    return { from: isoDay(y - 1, 0, 1), to: isoDay(y - 1, 11, 31) };
  }
  const q = Math.floor(m / 3); // current quarter 0..3
  return { from: isoDay(y, (q - 1) * 3, 1), to: isoDay(y, q * 3, 0) };
}

export interface SalesTaxDueRow {
  agencyId: string | null;
  agencyName: string | null;
  liabilityAccountId: string | null;
  /** Owed on tax dated (accrual) or paid by customers (cash) on or before the due-through date. */
  owedThrough: string;
  /** Payments (and adjustments) dated after the due-through date — they settle this period first. */
  settledLater: string;
  /** What to pay now: owedThrough − settledLater (negative = overpaid / credit with the agency). */
  amountDue: string;
}

export interface SalesTaxDueResult {
  basis: SalesTaxBasis;
  /** YYYY-MM-DD */
  dueThrough: string;
  rows: SalesTaxDueRow[];
  totalDue: string;
}

/**
 * QB Pay Sales Tax grid: per agency, the tax owed through `dueThrough` (on the company's sales tax
 * basis) less payments / adjustments already recorded after that date. Tax collected after the
 * date is not due yet and is left out, exactly like QB's "Show sales tax due through".
 */
export async function salesTaxDueThrough(
  ctx: ServiceContext,
  opts: { dueThrough: string; basis?: SalesTaxBasis },
): Promise<SalesTaxDueResult> {
  const basis = opts.basis ?? 'accrual';
  const day = opts.dueThrough.slice(0, 10);
  const through = new Date(`${day}T23:59:59.999Z`);
  const owed = await salesTaxLiabilityReport(ctx, { to: through, basis });
  const after = await salesTaxLiabilityReport(ctx, { from: new Date(through.getTime() + 1), basis });
  const laterByAgency = new Map<string | null, Dec>();
  for (const a of after.agencies) {
    // paid is positive; adjustments are signed (+ increases what is owed).
    laterByAgency.set(a.agencyId, Money.of(a.paid).minus(Money.of(a.adjustments)));
  }
  const keys = new Set<string | null>([...owed.agencies.map((a) => a.agencyId), ...after.agencies.map((a) => a.agencyId)]);
  const rows: SalesTaxDueRow[] = [];
  for (const k of keys) {
    const o = owed.agencies.find((a) => a.agencyId === k);
    const later = laterByAgency.get(k) ?? Money.zero();
    const owedThrough = Money.of(o?.balance ?? 0);
    const info = o ?? after.agencies.find((a) => a.agencyId === k)!;
    if (k === null && owedThrough.isZero() && later.isZero()) continue;
    rows.push({
      agencyId: k,
      agencyName: info.agencyName,
      liabilityAccountId: info.liabilityAccountId,
      owedThrough: toAmountString(owedThrough),
      settledLater: toAmountString(later),
      amountDue: toAmountString(owedThrough.minus(later)),
    });
  }
  rows.sort((a, b) => {
    if (a.agencyId === null) return 1;
    if (b.agencyId === null) return -1;
    return (a.agencyName ?? '').localeCompare(b.agencyName ?? '');
  });
  return {
    basis,
    dueThrough: day,
    rows,
    totalDue: toAmountString(rows.reduce((t, r) => t.plus(Money.of(r.amountDue)), Money.zero())),
  };
}
