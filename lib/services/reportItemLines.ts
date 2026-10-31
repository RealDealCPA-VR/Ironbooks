/**
 * The Item filter of the ledger reports (QB "Filters > Item" on Profit & Loss, Balance Sheet and
 * every detail report). Ledger lines carry no item — the documents do — so each posted line is
 * traced back to the document line(s) it came from:
 *
 *  - `item:<id>` / `item_opening:<id>` entries (quantity / value adjustments, opening stock):
 *    the item named in the tag;
 *  - `assembly_build:<build>:<from>:<to>` (and unbuild): the credit side is the `from` item, the
 *    debit side the `to` item;
 *  - COGS / restock entries posted per document line: `invoice-cogs:<invoice>` with reference
 *    `cogs:<lineOrder>`, `creditmemo-cogs:<memo>` and `salesreceipt:<receipt>` with the line id as
 *    reference — that line's item;
 *  - the document's own entry (invoice, sales receipt, credit memo, bill, check / charge, vendor
 *    credit, item receipt) and its cash-basis shares: a document posts one line per account (and
 *    class), so the line belongs to the item in proportion to the item's lines on that account
 *    (and class) among all the document's lines on it — a $300 income line made of a $200 widget
 *    line and a $100 service line is $200 widget. A header discount spread over an account is
 *    shared the same way. Lines on accounts no item line uses (sales tax, A/R, A/P, the bank)
 *    belong to no item.
 *
 * `itemCandidates` narrows the SQL read to entries that can involve the item (a superset);
 * `linesForItem` then keeps each line's item share.
 */
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type Decimal from 'decimal.js';
import {
  billLines,
  bills,
  creditMemoLines,
  creditMemos,
  expenseLines,
  expenses,
  invoiceLines,
  invoices,
  itemReceiptLines,
  itemReceipts,
  items,
  journalEntries,
  salesReceiptLines,
  salesReceipts,
  vendorCreditLines,
  vendorCredits,
} from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { ServiceContext } from './_base';
import type { GlLine } from './reportEngine';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type DocKind = 'invoice' | 'sales_receipt' | 'credit_memo' | 'bill' | 'expense' | 'vendor_credit' | 'item_receipt';

/** sourceRef prefix → the document whose lines carry the items. */
const DOC_PREFIX: Record<string, DocKind> = {
  invoice: 'invoice',
  salesreceipt: 'sales_receipt',
  sales_receipt: 'sales_receipt',
  credit_memo: 'credit_memo',
  bill: 'bill',
  expense: 'expense',
  vendor_credit: 'vendor_credit',
  item_receipt: 'item_receipt',
  item_receipt_void: 'item_receipt',
  item_receipt_edit: 'item_receipt',
};

/** Cash-basis shares (cashBasisLedger documents) → the document kind. */
const CASH_DOC: Record<string, DocKind> = { invoice: 'invoice', credit_memo: 'credit_memo', bill: 'bill', vendor_credit: 'vendor_credit' };

/**
 * Ledger lines that can belong to `itemId`: entries tagged with it, and entries of documents
 * with a line for it (and their per-line COGS entries). A superset; linesForItem decides.
 */
export function itemCandidates(companyId: string, itemId: string): SQL {
  const c = companyId;
  const prefix = sql`split_part(${journalEntries.sourceRef}, ':', 1)`;
  const docOf = sql`split_part(${journalEntries.sourceRef}, ':', 2)`;
  const docsWith = (lineTable: SQL, docCol: SQL, headTable: SQL, headId: SQL, headCompany: SQL, itemCol: SQL) =>
    sql`${docOf} IN (SELECT ${docCol}::text FROM ${lineTable} JOIN ${headTable} ON ${headId} = ${docCol} WHERE ${headCompany} = ${c} AND ${itemCol} = ${itemId})`;
  return sql`(
    (${prefix} IN ('item', 'item_opening') AND ${docOf} = ${itemId})
    OR (${prefix} IN ('assembly_build', 'assembly_unbuild') AND (split_part(${journalEntries.sourceRef}, ':', 3) = ${itemId} OR split_part(${journalEntries.sourceRef}, ':', 4) = ${itemId}))
    OR (${prefix} IN ('invoice', 'invoice-cogs') AND ${docsWith(sql`${invoiceLines}`, sql`${invoiceLines.invoiceId}`, sql`${invoices}`, sql`${invoices.id}`, sql`${invoices.companyId}`, sql`${invoiceLines.itemId}`)})
    OR (${prefix} IN ('salesreceipt', 'sales_receipt') AND ${docsWith(sql`${salesReceiptLines}`, sql`${salesReceiptLines.salesReceiptId}`, sql`${salesReceipts}`, sql`${salesReceipts.id}`, sql`${salesReceipts.companyId}`, sql`${salesReceiptLines.itemId}`)})
    OR (${prefix} IN ('credit_memo', 'creditmemo-cogs') AND ${docsWith(sql`${creditMemoLines}`, sql`${creditMemoLines.creditMemoId}`, sql`${creditMemos}`, sql`${creditMemos.id}`, sql`${creditMemos.companyId}`, sql`${creditMemoLines.itemId}`)})
    OR (${prefix} = 'bill' AND ${docsWith(sql`${billLines}`, sql`${billLines.billId}`, sql`${bills}`, sql`${bills.id}`, sql`${bills.companyId}`, sql`${billLines.itemId}`)})
    OR (${prefix} = 'expense' AND ${docsWith(sql`${expenseLines}`, sql`${expenseLines.expenseId}`, sql`${expenses}`, sql`${expenses.id}`, sql`${expenses.companyId}`, sql`${expenseLines.itemId}`)})
    OR (${prefix} = 'vendor_credit' AND ${docsWith(sql`${vendorCreditLines}`, sql`${vendorCreditLines.vendorCreditId}`, sql`${vendorCredits}`, sql`${vendorCredits.id}`, sql`${vendorCredits.companyId}`, sql`${vendorCreditLines.itemId}`)})
    OR (${prefix} IN ('item_receipt', 'item_receipt_void', 'item_receipt_edit') AND ${docsWith(sql`${itemReceiptLines}`, sql`${itemReceiptLines.itemReceiptId}`, sql`${itemReceipts}`, sql`${itemReceipts.id}`, sql`${itemReceipts.companyId}`, sql`${itemReceiptLines.itemId}`)})
  )`;
}

interface DocLine {
  id: string;
  docId: string;
  lineOrder: number;
  itemId: string | null;
  accountId: string | null;
  classId: string | null;
  amount: Decimal;
}

/** The lines of the given documents with the account each one posts to. */
async function loadDocLines(ctx: ServiceContext, kind: DocKind, ids: string[]): Promise<DocLine[]> {
  const out: DocLine[] = [];
  const c = ctx.companyId;
  for (let i = 0; i < ids.length; i += 2000) {
    const chunk = ids.slice(i, i + 2000);
    let rows: { id: string; docId: string; lineOrder: number; itemId: string | null; accountId: string | null; classId: string | null; amount: string | null }[];
    switch (kind) {
      case 'invoice':
        rows = await ctx.db
          .select({ id: invoiceLines.id, docId: invoiceLines.invoiceId, lineOrder: invoiceLines.lineOrder, itemId: invoiceLines.itemId, accountId: sql<string | null>`COALESCE(${invoiceLines.accountId}, ${items.incomeAccountId})`, classId: invoiceLines.classId, amount: invoiceLines.amount })
          .from(invoiceLines)
          .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
          .leftJoin(items, eq(items.id, invoiceLines.itemId))
          .where(and(eq(invoices.companyId, c), inArray(invoiceLines.invoiceId, chunk)));
        break;
      case 'sales_receipt':
        rows = await ctx.db
          .select({ id: salesReceiptLines.id, docId: salesReceiptLines.salesReceiptId, lineOrder: salesReceiptLines.lineOrder, itemId: salesReceiptLines.itemId, accountId: sql<string | null>`COALESCE(${salesReceiptLines.accountId}, ${items.incomeAccountId})`, classId: salesReceiptLines.classId, amount: salesReceiptLines.amount })
          .from(salesReceiptLines)
          .innerJoin(salesReceipts, eq(salesReceipts.id, salesReceiptLines.salesReceiptId))
          .leftJoin(items, eq(items.id, salesReceiptLines.itemId))
          .where(and(eq(salesReceipts.companyId, c), inArray(salesReceiptLines.salesReceiptId, chunk)));
        break;
      case 'credit_memo':
        rows = await ctx.db
          .select({ id: creditMemoLines.id, docId: creditMemoLines.creditMemoId, lineOrder: creditMemoLines.lineOrder, itemId: creditMemoLines.itemId, accountId: sql<string | null>`COALESCE(${creditMemoLines.accountId}, ${items.incomeAccountId})`, classId: sql<string | null>`NULL`, amount: creditMemoLines.amount })
          .from(creditMemoLines)
          .innerJoin(creditMemos, eq(creditMemos.id, creditMemoLines.creditMemoId))
          .leftJoin(items, eq(items.id, creditMemoLines.itemId))
          .where(and(eq(creditMemos.companyId, c), inArray(creditMemoLines.creditMemoId, chunk)));
        break;
      case 'bill':
        rows = await ctx.db
          .select({ id: billLines.id, docId: billLines.billId, lineOrder: billLines.lineOrder, itemId: billLines.itemId, accountId: sql<string | null>`COALESCE(${billLines.accountId}, ${items.assetAccountId}, ${items.expenseAccountId})`, classId: billLines.classId, amount: billLines.amount })
          .from(billLines)
          .innerJoin(bills, eq(bills.id, billLines.billId))
          .leftJoin(items, eq(items.id, billLines.itemId))
          .where(and(eq(bills.companyId, c), inArray(billLines.billId, chunk)));
        break;
      case 'expense':
        rows = await ctx.db
          .select({ id: expenseLines.id, docId: expenseLines.expenseId, lineOrder: expenseLines.lineOrder, itemId: expenseLines.itemId, accountId: sql<string | null>`COALESCE(${expenseLines.accountId}, ${items.assetAccountId}, ${items.expenseAccountId})`, classId: expenseLines.classId, amount: expenseLines.amount })
          .from(expenseLines)
          .innerJoin(expenses, eq(expenses.id, expenseLines.expenseId))
          .leftJoin(items, eq(items.id, expenseLines.itemId))
          .where(and(eq(expenses.companyId, c), inArray(expenseLines.expenseId, chunk)));
        break;
      case 'vendor_credit':
        rows = await ctx.db
          .select({ id: vendorCreditLines.id, docId: vendorCreditLines.vendorCreditId, lineOrder: vendorCreditLines.lineOrder, itemId: vendorCreditLines.itemId, accountId: sql<string | null>`COALESCE(${vendorCreditLines.accountId}, ${items.assetAccountId}, ${items.expenseAccountId})`, classId: vendorCreditLines.classId, amount: vendorCreditLines.amount })
          .from(vendorCreditLines)
          .innerJoin(vendorCredits, eq(vendorCredits.id, vendorCreditLines.vendorCreditId))
          .leftJoin(items, eq(items.id, vendorCreditLines.itemId))
          .where(and(eq(vendorCredits.companyId, c), inArray(vendorCreditLines.vendorCreditId, chunk)));
        break;
      case 'item_receipt':
        rows = await ctx.db
          .select({ id: itemReceiptLines.id, docId: itemReceiptLines.itemReceiptId, lineOrder: itemReceiptLines.lineOrder, itemId: itemReceiptLines.itemId, accountId: items.assetAccountId, classId: sql<string | null>`NULL`, amount: itemReceiptLines.amount })
          .from(itemReceiptLines)
          .innerJoin(itemReceipts, eq(itemReceipts.id, itemReceiptLines.itemReceiptId))
          .leftJoin(items, eq(items.id, itemReceiptLines.itemId))
          .where(and(eq(itemReceipts.companyId, c), inArray(itemReceiptLines.itemReceiptId, chunk)));
        break;
    }
    for (const r of rows) out.push({ ...r, amount: Money.of(r.amount ?? '0').abs() });
  }
  return out;
}

/** A copy of `l` carrying only `share` of its amount (signs kept, cents rounded). */
function scaled(l: GlLine, num: Decimal, den: Decimal): GlLine {
  const f = (v: Decimal) => Money.round2(v.times(num).dividedBy(den));
  const debit = f(l.debit);
  const credit = f(l.credit);
  return { ...l, debit, credit, amount: debit.minus(credit), natural: f(l.natural) };
}

/**
 * The part of each line that belongs to `itemId` (see the module comment). Lines that are wholly
 * the item's are returned as they are; shared lines as a proportional copy; others dropped.
 */
export async function linesForItem(ctx: ServiceContext, lines: GlLine[], itemId: string): Promise<GlLine[]> {
  const want: Record<DocKind, Set<string>> = {
    invoice: new Set(), sales_receipt: new Set(), credit_memo: new Set(), bill: new Set(), expense: new Set(), vendor_credit: new Set(), item_receipt: new Set(),
  };
  type Plan = { l: GlLine; how: 'keep' | 'drop' | 'doc' | 'invoiceCogs' | 'lineRef'; kind?: DocKind; docId?: string; ref?: string };
  const plans: Plan[] = [];
  const refOf = async (): Promise<Map<string, string | null>> => {
    const ids = [...new Set(lines.filter((l) => !l.cashDoc && l.reference === undefined).map((l) => l.entryId))];
    const out = new Map<string, string | null>();
    for (let i = 0; i < ids.length; i += 2000) {
      for (const r of await ctx.db
        .select({ id: journalEntries.id, reference: journalEntries.reference })
        .from(journalEntries)
        .where(and(eq(journalEntries.companyId, ctx.companyId), inArray(journalEntries.id, ids.slice(i, i + 2000))))) {
        out.set(r.id, r.reference);
      }
    }
    return out;
  };
  const refs = await refOf();
  for (const l of lines) {
    if (l.cashDoc) {
      const kind = CASH_DOC[l.cashDoc.kind];
      if (!kind) {
        plans.push({ l, how: 'drop' });
        continue;
      }
      want[kind].add(l.cashDoc.id);
      plans.push({ l, how: 'doc', kind, docId: l.cashDoc.id });
      continue;
    }
    const parts = (l.sourceRef ?? '').split(':');
    const prefix = parts[0];
    const id = parts[1] && UUID_RE.test(parts[1]) ? parts[1] : null;
    const reference = l.reference !== undefined ? l.reference : (refs.get(l.entryId) ?? null);
    if (prefix === 'item' || prefix === 'item_opening') {
      plans.push({ l, how: id === itemId ? 'keep' : 'drop' });
    } else if (prefix === 'assembly_build' || prefix === 'assembly_unbuild') {
      const [from, to] = [parts[2], parts[3]];
      const mine = l.credit.greaterThan(0) ? from === itemId : to === itemId;
      plans.push({ l, how: mine ? 'keep' : 'drop' });
    } else if (prefix === 'invoice-cogs' && id) {
      want.invoice.add(id);
      plans.push({ l, how: 'invoiceCogs', kind: 'invoice', docId: id, ref: reference ?? '' });
    } else if (prefix === 'creditmemo-cogs' && id) {
      want.credit_memo.add(id);
      plans.push({ l, how: 'lineRef', kind: 'credit_memo', docId: id, ref: reference ?? '' });
    } else if ((prefix === 'salesreceipt' || prefix === 'sales_receipt') && id && reference && UUID_RE.test(reference)) {
      // A sales receipt's per-line COGS entry carries the line id as its reference.
      want.sales_receipt.add(id);
      plans.push({ l, how: 'lineRef', kind: 'sales_receipt', docId: id, ref: reference });
    } else if (DOC_PREFIX[prefix] && id) {
      const kind = DOC_PREFIX[prefix];
      want[kind].add(id);
      plans.push({ l, how: 'doc', kind, docId: id });
    } else {
      plans.push({ l, how: 'drop' });
    }
  }
  const docLines = new Map<string, DocLine[]>();
  for (const kind of Object.keys(want) as DocKind[]) {
    if (!want[kind].size) continue;
    for (const dl of await loadDocLines(ctx, kind, [...want[kind]])) {
      const k = `${kind}:${dl.docId}`;
      const list = docLines.get(k);
      if (list) list.push(dl);
      else docLines.set(k, [dl]);
    }
  }
  const out: GlLine[] = [];
  for (const p of plans) {
    if (p.how === 'keep') out.push(p.l);
    if (p.how === 'keep' || p.how === 'drop') continue;
    const list = docLines.get(`${p.kind}:${p.docId}`) ?? [];
    if (p.how === 'invoiceCogs') {
      const order = /^cogs:(\d+)$/.exec(p.ref ?? '')?.[1];
      const line = order !== undefined ? list.find((x) => String(x.lineOrder) === order) : undefined;
      if (line?.itemId === itemId) out.push(p.l);
      continue;
    }
    if (p.how === 'lineRef') {
      if (list.find((x) => x.id === p.ref)?.itemId === itemId) out.push(p.l);
      continue;
    }
    // The document's own line: the item's share of the document lines on this account (and class).
    let cands = list.filter((x) => x.accountId === p.l.accountId);
    if (p.l.classId) {
      const sameClass = cands.filter((x) => x.classId === p.l.classId);
      if (sameClass.length) cands = sameClass;
    }
    const total = cands.reduce((s, x) => s.plus(x.amount), Money.zero());
    const mine = cands.filter((x) => x.itemId === itemId).reduce((s, x) => s.plus(x.amount), Money.zero());
    if (mine.isZero() || total.isZero()) continue;
    out.push(mine.equals(total) ? p.l : scaled(p.l, mine, total));
  }
  return out;
}
