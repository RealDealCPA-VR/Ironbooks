/**
 * Reclassify Transactions — keeping the SOURCE DOCUMENT in step with a reclassified line, so that
 * editing the document later re-posts the new account / class instead of silently undoing the fix.
 *
 * Every posted line is matched to the document rows it was built from:
 *  - documents that post one line per account (+ class): invoices (income lines aggregated per
 *    account + class, discount items on the debit side), sales receipts and credit memos
 *    (aggregated per account) — the journal line maps to every document row in its group;
 *  - documents that post one line per row: bills, checks / expenses, vendor credits, deposits
 *    (extra lines + cash back) — the journal line maps to the row with the same account, class and
 *    amount (the memo breaks ties).
 * A group must add up to the journal amount (home currency), otherwise the match is not trusted.
 *
 * Refused, with a plain message (QuickBooks parity — nothing is changed):
 *  - moving an ITEM line to another account (QB only allows a class change on item lines; the
 *    account comes from the item) — change the item's account or edit the document instead;
 *  - a class change on a document that keeps no class per line (sales receipt, credit memo, vendor
 *    credit, deposit) — the next save would drop it;
 *  - a line that can't be matched to the document's rows;
 *  - lines posted by documents that rebuild their lines from their own settings when saved
 *    (paychecks, item receipts, expense reports, payments, bill payments, refunds, bounced checks,
 *    cost-of-goods entries).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type Decimal from 'decimal.js';
import {
  billLines,
  bills,
  creditMemoLines,
  creditMemos,
  depositLines,
  deposits,
  expenseLines,
  expenses,
  invoiceLines,
  invoices,
  items,
  journalEntryLines,
  salesReceiptLines,
  salesReceipts,
  vendorCreditLines,
  vendorCredits,
} from '@/lib/db/schema';
import { Money } from '@/lib/money';
import { type ServiceContext, validation } from '../_base';

type Dir = 'debit' | 'credit';
type DocKind = 'invoice' | 'salesreceipt' | 'credit_memo' | 'bill' | 'expense' | 'vendor_credit' | 'deposit';

const KIND_NAME: Record<DocKind, string> = {
  invoice: 'invoice',
  salesreceipt: 'sales receipt',
  credit_memo: 'credit memo',
  bill: 'bill',
  expense: 'check',
  vendor_credit: 'bill credit',
  deposit: 'deposit',
};

/** Sources whose lines are rebuilt from their own settings on save (no line rows to keep in step). */
const REBUILT_SOURCES: Record<string, string> = {
  paycheck: 'paycheck',
  item_receipt: 'item receipt',
  item_receipt_edit: 'item receipt',
  expense_report: 'expense report',
  'invoice-cogs': 'invoice (cost of goods sold)',
  'creditmemo-cogs': 'credit memo (cost of goods sold)',
  customer: 'customer payment',
  payment: 'customer payment',
  vendor: 'bill payment',
  refund: 'refund',
  bounced: 'bounced check',
};

interface DocLine {
  table: DocKind;
  id: string;
  accountId: string | null;
  classId: string | null;
  dir: Dir;
  /** Signed transaction-currency amount on the `dir` side (a negative row nets against it). */
  amount: Decimal;
  itemId: string | null;
  itemName: string | null;
  description: string | null;
  /** Deposit cash-back row: the account lives in its description (`cashback:<id>`). */
  cashBack?: boolean;
}

interface DocInfo {
  kind: DocKind;
  label: string;
  postedEntryId: string | null;
  rate: Decimal;
  /** The document keeps a class on each row (and posts it). */
  lineClass: boolean;
  lines: DocLine[];
}

const NON_POSTING_ITEM_TYPES = new Set(['subtotal', 'payment', 'sales_tax']);

async function itemInfo(ctx: ServiceContext, ids: Array<string | null>) {
  const wanted = [...new Set(ids.filter((i): i is string => Boolean(i)))];
  if (wanted.length === 0) return new Map<string, { name: string; type: string }>();
  const rows = await ctx.db
    .select({ id: items.id, name: items.name, type: items.type })
    .from(items)
    .where(and(eq(items.companyId, ctx.companyId), inArray(items.id, wanted)));
  return new Map(rows.map((r) => [r.id, { name: r.name, type: r.type as string }]));
}

async function loadDoc(ctx: ServiceContext, kind: DocKind, id: string): Promise<DocInfo | null> {
  const c = ctx.companyId;
  if (kind === 'invoice') {
    const [h] = await ctx.db.select().from(invoices).where(and(eq(invoices.id, id), eq(invoices.companyId, c)));
    if (!h) return null;
    const rows = await ctx.db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, id));
    const it = await itemInfo(ctx, rows.map((r) => r.itemId));
    return {
      kind,
      label: `Invoice #${h.refNumber ?? h.invoiceNumber}`,
      postedEntryId: h.postedEntryId,
      rate: Money.of(h.exchangeRate ?? 1),
      lineClass: true,
      lines: rows
        .filter((r) => !NON_POSTING_ITEM_TYPES.has(it.get(r.itemId ?? '')?.type ?? ''))
        .map((r) => {
          const discount = it.get(r.itemId ?? '')?.type === 'discount';
          return {
            table: kind,
            id: r.id,
            accountId: r.accountId,
            classId: r.classId,
            dir: discount ? 'debit' : 'credit',
            amount: discount ? Money.of(r.amount).abs() : Money.of(r.amount),
            itemId: r.itemId,
            itemName: it.get(r.itemId ?? '')?.name ?? null,
            description: r.description,
          };
        }),
    };
  }
  if (kind === 'salesreceipt') {
    const [h] = await ctx.db.select().from(salesReceipts).where(and(eq(salesReceipts.id, id), eq(salesReceipts.companyId, c)));
    if (!h) return null;
    const rows = await ctx.db.select().from(salesReceiptLines).where(eq(salesReceiptLines.salesReceiptId, id));
    const it = await itemInfo(ctx, rows.map((r) => r.itemId));
    return {
      kind,
      label: `Sales Receipt #${h.refNumber ?? h.receiptNumber}`,
      postedEntryId: h.postedEntryId,
      rate: Money.of(1),
      lineClass: false,
      lines: rows
        .filter((r) => !NON_POSTING_ITEM_TYPES.has(it.get(r.itemId ?? '')?.type ?? ''))
        .map((r) => ({
          table: kind,
          id: r.id,
          accountId: r.accountId,
          classId: null,
          dir: 'credit' as const,
          amount: Money.of(r.amount),
          itemId: r.itemId,
          itemName: it.get(r.itemId ?? '')?.name ?? null,
          description: r.description,
        })),
    };
  }
  if (kind === 'credit_memo') {
    const [h] = await ctx.db.select().from(creditMemos).where(and(eq(creditMemos.id, id), eq(creditMemos.companyId, c)));
    if (!h) return null;
    const rows = await ctx.db.select().from(creditMemoLines).where(eq(creditMemoLines.creditMemoId, id));
    const it = await itemInfo(ctx, rows.map((r) => r.itemId));
    return {
      kind,
      label: `Credit Memo #${h.refNumber ?? h.memoNumber}`,
      postedEntryId: h.postedEntryId,
      rate: Money.of(1),
      lineClass: false,
      lines: rows
        .filter((r) => !NON_POSTING_ITEM_TYPES.has(it.get(r.itemId ?? '')?.type ?? ''))
        .map((r) => ({
          table: kind,
          id: r.id,
          accountId: r.accountId,
          classId: null,
          dir: 'debit' as const,
          amount: Money.of(r.amount),
          itemId: r.itemId,
          itemName: it.get(r.itemId ?? '')?.name ?? null,
          description: r.description,
        })),
    };
  }
  if (kind === 'bill') {
    const [h] = await ctx.db.select().from(bills).where(and(eq(bills.id, id), eq(bills.companyId, c)));
    if (!h) return null;
    const rows = await ctx.db.select().from(billLines).where(eq(billLines.billId, id));
    const it = await itemInfo(ctx, rows.map((r) => r.itemId));
    return {
      kind,
      label: h.billNumber ? `Bill ${h.billNumber}` : 'Bill',
      postedEntryId: h.postedEntryId,
      rate: Money.of(h.exchangeRate ?? 1),
      lineClass: true,
      lines: rows.map((r) => ({
        table: kind,
        id: r.id,
        accountId: r.accountId,
        classId: r.classId,
        dir: 'debit' as const,
        amount: Money.of(r.amount),
        itemId: r.itemId,
        itemName: it.get(r.itemId ?? '')?.name ?? null,
        description: r.description,
      })),
    };
  }
  if (kind === 'expense') {
    const [h] = await ctx.db.select().from(expenses).where(and(eq(expenses.id, id), eq(expenses.companyId, c)));
    if (!h) return null;
    const rows = await ctx.db.select().from(expenseLines).where(eq(expenseLines.expenseId, id));
    const it = await itemInfo(ctx, rows.map((r) => r.itemId));
    // A credit-card credit credits its expense accounts. It is saved either with negative rows or
    // with positive rows and the refund flag (the header total is negative either way).
    const refund = Money.of(h.total ?? 0).isNegative() || rows.some((r) => Money.of(r.amount).isNegative());
    return {
      kind,
      label: h.reference ? `Check ${h.reference}` : 'Check / expense',
      postedEntryId: h.postedEntryId,
      rate: Money.of(h.exchangeRate ?? 1),
      lineClass: true,
      lines: rows.map((r) => {
        const amt = Money.of(r.amount);
        return {
          table: kind,
          id: r.id,
          accountId: r.accountId,
          classId: r.classId,
          dir: refund ? ('credit' as const) : ('debit' as const),
          amount: amt.abs(),
          itemId: r.itemId,
          itemName: it.get(r.itemId ?? '')?.name ?? null,
          description: r.description,
        };
      }),
    };
  }
  if (kind === 'vendor_credit') {
    const [h] = await ctx.db.select().from(vendorCredits).where(and(eq(vendorCredits.id, id), eq(vendorCredits.companyId, c)));
    if (!h) return null;
    const rows = await ctx.db.select().from(vendorCreditLines).where(eq(vendorCreditLines.vendorCreditId, id));
    return {
      kind,
      label: 'Bill credit',
      postedEntryId: h.postedEntryId,
      rate: Money.of(1),
      lineClass: false,
      lines: rows.map((r) => ({
        table: kind,
        id: r.id,
        accountId: r.accountId,
        classId: null,
        dir: 'credit' as const,
        amount: Money.of(r.amount),
        itemId: null,
        itemName: null,
        description: r.description,
      })),
    };
  }
  // deposit
  const [h] = await ctx.db.select().from(deposits).where(and(eq(deposits.id, id), eq(deposits.companyId, c)));
  if (!h) return null;
  const rows = await ctx.db.select().from(depositLines).where(eq(depositLines.depositId, id));
  const lines: DocLine[] = [];
  for (const r of rows) {
    const desc = r.description ?? '';
    // Undeposited Funds (control): payments, sales receipts and invoice payment-item lines.
    if (r.paymentId || desc.startsWith('salesReceipt:') || desc.startsWith('invoicePayment:')) continue;
    if (desc.startsWith('cashback:')) {
      lines.push({
        table: kind,
        id: r.id,
        accountId: desc.slice('cashback:'.length),
        classId: null,
        dir: 'debit',
        amount: Money.of(r.amount).abs(),
        itemId: null,
        itemName: null,
        description: null,
        cashBack: true,
      });
    } else {
      lines.push({
        table: kind,
        id: r.id,
        accountId: r.accountId,
        classId: null,
        dir: 'credit',
        amount: Money.of(r.amount),
        itemId: null,
        itemName: null,
        description: r.description,
      });
    }
  }
  return { kind, label: 'Deposit', postedEntryId: h.postedEntryId, rate: Money.of(1), lineClass: false, lines };
}

export interface SelectedLine {
  id: string;
  entryId: string;
  entryNumber: number;
  accountId: string;
  classId: string | null;
  debit: string | null;
  credit: string | null;
  sourceRef: string | null;
}

/** The document rows to update for one entry, decided BEFORE anything is written. */
export interface DocSyncPlan {
  doc: DocInfo;
  rows: DocLine[];
}

function lineDir(l: { debit: string | null; credit: string | null }): Dir {
  return l.debit != null && Money.gt(l.debit, 0) ? 'debit' : 'credit';
}
function lineAmt(l: { debit: string | null; credit: string | null }): Decimal {
  return lineDir(l) === 'debit' ? Money.of(l.debit) : Money.of(l.credit);
}

/**
 * Work out which document rows a set of selected lines (all from ONE entry) maps to, or refuse
 * with a plain message when the change could not be kept in the document. Returns null when the
 * entry has no line-based source document (manual entries, reversals, imports, ...): the journal
 * line IS the record, so changing it in place is enough.
 */
export async function planDocumentSync(
  ctx: ServiceContext,
  entryLines: SelectedLine[],
  change: { account: boolean; class: boolean },
): Promise<DocSyncPlan | null> {
  const first = entryLines[0];
  const ref = first.sourceRef;
  if (!ref) return null;
  const i = ref.indexOf(':');
  const prefix = i > 0 ? ref.slice(0, i) : ref;
  const docId = i > 0 ? ref.slice(i + 1) : '';
  const entryLabel = `Entry #${first.entryNumber}`;

  if (REBUILT_SOURCES[prefix]) {
    const what = REBUILT_SOURCES[prefix];
    throw validation(
      `${entryLabel} was posted by a ${what}, which rebuilds its lines from its own settings each time it is saved, so a reclassification would not last. Open the ${what} and change it there.`,
    );
  }
  if (!(prefix in KIND_NAME) || !/^[0-9a-f-]{36}$/i.test(docId)) return null;
  const doc = await loadDoc(ctx, prefix as DocKind, docId);
  // Only the document's own posting is rebuilt from its rows (FX or other follow-up entries that
  // share the reference are not).
  if (!doc || doc.postedEntryId !== first.entryId) return null;
  const kindName = KIND_NAME[doc.kind];

  if (change.class && !doc.lineClass) {
    throw validation(
      `${doc.label}: a ${kindName} doesn't keep a class on each line, so a class change here would be undone the next time it is saved. Open the ${kindName} and change its class there instead.`,
    );
  }

  const all = await ctx.db
    .select({
      id: journalEntryLines.id,
      accountId: journalEntryLines.accountId,
      classId: journalEntryLines.classId,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
      memo: journalEntryLines.memo,
    })
    .from(journalEntryLines)
    .where(eq(journalEntryLines.journalEntryId, first.entryId));
  const keyOf = (accountId: string | null, dir: Dir, classId: string | null) =>
    `${accountId ?? ''}|${dir}|${doc.lineClass ? (classId ?? '') : ''}`;
  const memoById = new Map(all.map((l) => [l.id, l.memo]));

  const selectedByKey = new Map<string, SelectedLine[]>();
  for (const l of entryLines) {
    const k = keyOf(l.accountId, lineDir(l), l.classId);
    selectedByKey.set(k, [...(selectedByKey.get(k) ?? []), l]);
  }

  const cantMatch = () =>
    validation(
      `${doc.label}: the selected line doesn't match a line on the ${kindName}, so the change would be undone the next time the ${kindName} is saved. Open the ${kindName} and change the account or class there instead.`,
    );
  const home = (d: DocLine) => Money.round2(d.amount.times(doc.rate));
  const exact = doc.rate.equals(1);
  const close = (a: Decimal, b: Decimal, n: number) => (exact ? a.equals(b) : a.minus(b).abs().lessThanOrEqualTo(Money.of('0.01').times(Math.max(1, n))));

  const rows: DocLine[] = [];
  for (const [k, selected] of selectedByKey) {
    const J = all.filter((l) => keyOf(l.accountId, lineDir(l), l.classId) === k);
    const G = doc.lines.filter((d) => keyOf(d.accountId, d.dir, d.classId) === k);
    if (G.length === 0) throw cantMatch();
    const sumJ = J.reduce((s, l) => s.plus(lineAmt(l)), Money.zero());
    const sumG = Money.round2(G.reduce((s, d) => s.plus(d.amount), Money.zero()).times(doc.rate));
    if (!close(sumJ, sumG, G.length)) throw cantMatch();

    if (selected.length === J.length || J.length === 1) {
      rows.push(...G);
      continue;
    }
    // One journal line per document row: pair each selected line with a row of the same amount,
    // preferring the row whose description is the line's memo.
    const free = [...G];
    for (const l of selected) {
      const amt = lineAmt(l);
      const memo = memoById.get(l.id) ?? null;
      let idx = free.findIndex((d) => close(home(d), amt, 1) && (d.description ?? null) === memo);
      if (idx < 0) idx = free.findIndex((d) => close(home(d), amt, 1));
      if (idx < 0) throw cantMatch();
      rows.push(free[idx]);
      free.splice(idx, 1);
    }
  }

  if (change.account) {
    const item = rows.find((r) => r.itemId);
    if (item) {
      throw validation(
        `${doc.label}: this amount comes from the item "${item.itemName ?? 'item'}". QuickBooks doesn't move item lines to another account — change the item's account, or edit the ${kindName}. You can still change the class.`,
      );
    }
  }
  return { doc, rows };
}

/** Write a plan: point the document rows at the new account and/or class. */
export async function applyDocumentSync(
  tx: ServiceContext,
  plan: DocSyncPlan,
  change: { accountId?: string; classId?: string | null; account: boolean; class: boolean },
): Promise<number> {
  let n = 0;
  for (const r of plan.rows) {
    const acct = change.account ? { accountId: change.accountId! } : {};
    const cls = change.class && plan.doc.lineClass ? { classId: change.classId ?? null } : {};
    if (Object.keys(acct).length === 0 && Object.keys(cls).length === 0) continue;
    if (r.table === 'invoice') await tx.db.update(invoiceLines).set({ ...acct, ...cls }).where(eq(invoiceLines.id, r.id));
    else if (r.table === 'bill') await tx.db.update(billLines).set({ ...acct, ...cls }).where(eq(billLines.id, r.id));
    else if (r.table === 'expense') await tx.db.update(expenseLines).set({ ...acct, ...cls }).where(eq(expenseLines.id, r.id));
    else if (r.table === 'salesreceipt') await tx.db.update(salesReceiptLines).set(acct).where(eq(salesReceiptLines.id, r.id));
    else if (r.table === 'credit_memo') await tx.db.update(creditMemoLines).set(acct).where(eq(creditMemoLines.id, r.id));
    else if (r.table === 'vendor_credit') await tx.db.update(vendorCreditLines).set(acct).where(eq(vendorCreditLines.id, r.id));
    else if (r.table === 'deposit') {
      if (!change.account) continue;
      await tx.db
        .update(depositLines)
        .set(r.cashBack ? { description: `cashback:${change.accountId}` } : { accountId: change.accountId! })
        .where(eq(depositLines.id, r.id));
    }
    n += 1;
  }
  if (n > 0) await touchDocumentVersion(tx, plan.doc.kind, plan.doc.postedEntryId);
  return n;
}

const HEADER_TABLES = {
  invoice: invoices,
  salesreceipt: salesReceipts,
  credit_memo: creditMemos,
  bill: bills,
  expense: expenses,
  vendor_credit: vendorCredits,
  deposit: deposits,
} as const;

/**
 * Record locking: the document's rows changed under it, so its version (updated_at) must move —
 * a copy someone opened before the reclassify is then refused as stale ("This record was changed
 * by …", lib/services/concurrency.ts) instead of re-posting the old account when it is saved.
 * Only the line tables changed, and the version triggers sit on the header tables, so it is
 * bumped here explicitly (strictly later than the current version, like the triggers do).
 */
async function touchDocumentVersion(tx: ServiceContext, kind: DocKind, postedEntryId: string | null): Promise<void> {
  if (!postedEntryId) return;
  const t = HEADER_TABLES[kind] as unknown as typeof bills;
  await tx.db
    .update(t)
    .set({
      updatedAt: sql`GREATEST(date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC'), ${t.updatedAt} + interval '1 millisecond')`,
    })
    .where(and(eq(t.companyId, tx.companyId), eq(t.postedEntryId, postedEntryId)));
}
