/**
 * The ACTIVITY (lib/permissions/activities.ts) each kind of record belongs to: an invoice is
 * Invoices, a received payment Receive Payments, a customer the Customer Center, …
 *
 * Service checks and view filters that used to name only an AREA ("may view Customers &
 * Receivables") check the record's own activity instead (prefsperms review P1): an area-level
 * check is fail closed for roles built per activity (model.ts `can`), so without this a role with
 * Invoices but no Receive Payments would lose its invoices in search, to-dos, attachments, …
 * For roles stored the old way (one grant per area) every activity of the area holds that grant,
 * so the answer is exactly the old area answer.
 *
 * Pure module (no DB / Node imports).
 */
import type { ActivityKey } from './activities';
import type { AccessRef } from './model';

export const RECORD_ACTIVITY = {
  // Customers & Receivables
  customer: 'customers.center',
  job: 'customers.center',
  lead: 'customers.leads',
  invoice: 'customers.invoices',
  estimate: 'customers.estimates',
  sales_order: 'customers.sales_orders',
  sales_receipt: 'customers.sales_receipts',
  credit_memo: 'customers.credit_memos',
  payment: 'customers.payments',
  payment_received: 'customers.payments',
  // Vendors & Payables
  vendor: 'vendors.center',
  bill: 'vendors.bills',
  bill_credit: 'vendors.vendor_credits',
  vendor_credit: 'vendors.vendor_credits',
  bill_payment: 'vendors.pay_bills',
  purchase_order: 'vendors.purchase_orders',
  // Banking
  expense: 'banking.write_checks',
  check: 'banking.write_checks',
  cc_charge: 'banking.write_checks',
  cc_credit: 'banking.write_checks',
  credit_card: 'banking.write_checks',
  deposit: 'banking.deposits',
  // Sensitive Accounting
  journal: 'accounting.journal_entries',
  journal_entry: 'accounting.journal_entries',
  transfer: 'accounting.transfers',
  // Payroll
  employee: 'payroll.employees',
  paycheck: 'payroll.paychecks',
  // Lists
  item: 'lists.items',
  other_name: 'lists.other_lists',
  account: 'lists.chart_of_accounts',
} as const satisfies Record<string, ActivityKey>;

export type RecordKind = keyof typeof RECORD_ACTIVITY;

/** The activity of a record kind, or null for a kind not listed. */
export function recordActivity(kind: string | null | undefined): ActivityKey | null {
  if (!kind || !Object.prototype.hasOwnProperty.call(RECORD_ACTIVITY, kind)) return null;
  return RECORD_ACTIVITY[kind as RecordKind];
}

/** The record kind's activity, else `fallback` (an area: checked as the whole area). */
export function recordRef(kind: string | null | undefined, fallback: AccessRef): AccessRef {
  return recordActivity(kind) ?? fallback;
}
