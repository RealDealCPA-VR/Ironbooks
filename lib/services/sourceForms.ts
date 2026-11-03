/**
 * QuickZoom to the SOURCE FORM (QB: double-click a detail line of any report and the invoice,
 * bill, check, deposit… it came from opens). Given a posted journal entry, find the document
 * that posted it and the page / form that opens it:
 *
 *  - the documents that keep their posted entry (postedEntryId): invoices, bills, checks and
 *    card charges, deposits, credit memos, bill credits, sales receipts, received payments, bill
 *    payments, paychecks (their row on Pay Stubs), transfers, item receipts, expense reports and the sales
 *    tax / liability / refund checks;
 *  - otherwise the entry's sourceRef (COGS entries of an invoice or credit memo, bank-feed lines,
 *    item adjustments and opening quantities, reconciliation charges, fixed assets, loans…);
 *  - a General Journal entry opens in Make General Journal Entries; anything else shows the
 *    entry itself (null).
 *
 * The form pages open the record from `?open=<id>` (lib/useOpenParam.ts) or `?focus=<id>`.
 * Company-scoped; the form page itself checks the user's permission for its area.
 */
import { and, eq } from 'drizzle-orm';
import {
  billPayments,
  bills,
  creditMemos,
  deposits,
  expenseReports,
  expenses,
  invoices,
  itemReceipts,
  journalEntries,
  paychecks,
  paymentChecks,
  paymentsReceived,
  salesReceipts,
  transfers,
  vendorCredits,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Form pages by document kind (the id goes into ?open= unless the page uses ?focus=). */
export const SOURCE_FORMS = {
  invoice: (id: string) => `/invoices?open=${id}`,
  bill: (id: string) => `/bills?open=${id}`,
  expense: (id: string) => `/expenses?focus=${id}`,
  deposit: (id: string) => `/deposits?open=${id}`,
  credit_memo: (id: string) => `/credit-memos?open=${id}`,
  vendor_credit: (id: string) => `/vendor-credits?focus=${id}`,
  sales_receipt: (id: string) => `/sales-receipts?open=${id}`,
  payment: (id: string) => `/payments?open=${id}`,
  bill_payment: (id: string) => `/pay-bills?open=${id}`,
  // The paycheck's row on Pay Stubs (its PDF opens from there in a window of its own).
  paycheck: (id: string) => `/pay-stubs?open=${id}`,
  transfer: (id: string) => `/transfers?open=${id}`,
  item_receipt: (id: string) => `/item-receipts?open=${id}`,
  expense_report: (id: string) => `/expense-reports?open=${id}`,
  journal: (id: string) => `/journal?open=${id}`,
  item: (id: string) => `/items?focus=${id}`,
} as const;

const PAYMENT_CHECK_PAGES: Record<string, string> = {
  sales_tax: '/sales-tax',
  payroll_liability: '/pay-liabilities',
  customer_refund: '/credit-memos',
};

type DocTable =
  | typeof invoices
  | typeof bills
  | typeof expenses
  | typeof deposits
  | typeof creditMemos
  | typeof vendorCredits
  | typeof salesReceipts
  | typeof paymentsReceived
  | typeof billPayments
  | typeof paychecks
  | typeof transfers
  | typeof itemReceipts
  | typeof expenseReports;

const BY_POSTED_ENTRY: [DocTable, keyof typeof SOURCE_FORMS][] = [
  [invoices, 'invoice'],
  [bills, 'bill'],
  [expenses, 'expense'],
  [deposits, 'deposit'],
  [creditMemos, 'credit_memo'],
  [vendorCredits, 'vendor_credit'],
  [salesReceipts, 'sales_receipt'],
  [paymentsReceived, 'payment'],
  [billPayments, 'bill_payment'],
  [paychecks, 'paycheck'],
  [transfers, 'transfer'],
  [itemReceipts, 'item_receipt'],
  [expenseReports, 'expense_report'],
];

/** Where a sourceRef's document opens, when no document keeps the entry as its posted entry. */
export function sourceRefForm(sourceRef: string | null | undefined, entryId: string): string | null {
  if (!sourceRef || sourceRef === 'manual') return SOURCE_FORMS.journal(entryId);
  const [prefix, rawId] = sourceRef.split(':');
  const id = rawId && UUID_RE.test(rawId) ? rawId : null;
  switch (prefix) {
    case 'invoice':
    case 'invoice-cogs':
      return id ? SOURCE_FORMS.invoice(id) : null;
    case 'bill':
      return id ? SOURCE_FORMS.bill(id) : null;
    case 'expense':
      return id ? SOURCE_FORMS.expense(id) : null;
    case 'deposit':
      return id ? SOURCE_FORMS.deposit(id) : null;
    case 'credit_memo':
    case 'creditmemo-cogs':
      return id ? SOURCE_FORMS.credit_memo(id) : null;
    case 'vendor_credit':
      return id ? SOURCE_FORMS.vendor_credit(id) : null;
    case 'salesreceipt':
    case 'sales_receipt':
      return id ? SOURCE_FORMS.sales_receipt(id) : null;
    case 'payment':
    case 'bounced':
      return id ? SOURCE_FORMS.payment(id) : null;
    case 'refund':
      return '/credit-memos';
    case 'paycheck':
      return id ? SOURCE_FORMS.paycheck(id) : null;
    case 'transfer':
      return id ? SOURCE_FORMS.transfer(id) : null;
    case 'item_receipt':
    case 'item_receipt_void':
    case 'item_receipt_edit':
      return id ? SOURCE_FORMS.item_receipt(id) : null;
    case 'expense_report':
      return id ? SOURCE_FORMS.expense_report(id) : null;
    case 'item':
    case 'item_opening':
      return id ? SOURCE_FORMS.item(id) : '/inventory-ops';
    case 'assembly_build':
    case 'assembly_unbuild':
      return '/assemblies';
    case 'inventory_transfer':
      return '/inventory-transfers';
    case 'bank_transaction':
      return '/bank-review';
    case 'reconciliation':
      return '/reports/reconciliation';
    case 'fixed_asset':
      return '/fixed-assets';
    case 'loan':
      return '/loans';
    case 'tax_agency':
    case 'sales_tax_adj':
      return '/sales-tax';
    case 'hca':
      return '/currencies';
    // Reversals and imported QuickBooks GL entries are system entries: shown as the entry itself.
    default:
      return null;
  }
}

/**
 * The page that opens the form a posted journal entry came from, or null when it has none (the
 * caller then shows the entry itself). Unknown or other companies' entries → null.
 */
export async function sourceFormForEntry(ctx: ServiceContext, entryId: string): Promise<string | null> {
  if (typeof entryId !== 'string' || !UUID_RE.test(entryId)) return null;
  const [entry] = await ctx.db
    .select({ id: journalEntries.id, sourceRef: journalEntries.sourceRef })
    .from(journalEntries)
    .where(and(eq(journalEntries.id, entryId), eq(journalEntries.companyId, ctx.companyId)));
  if (!entry) return null;
  for (const [table, kind] of BY_POSTED_ENTRY) {
    const t = table as typeof invoices;
    const [doc] = await ctx.db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.companyId, ctx.companyId), eq(t.postedEntryId, entryId)))
      .limit(1);
    if (doc) return SOURCE_FORMS[kind](doc.id);
  }
  const [check] = await ctx.db
    .select({ kind: paymentChecks.kind })
    .from(paymentChecks)
    .where(and(eq(paymentChecks.companyId, ctx.companyId), eq(paymentChecks.postedEntryId, entryId)))
    .limit(1);
  if (check) return PAYMENT_CHECK_PAGES[check.kind] ?? '/print-checks';
  return sourceRefForm(entry.sourceRef, entry.id);
}
