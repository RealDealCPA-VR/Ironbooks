/**
 * Standard report catalog — every report the generic report viewer (/reports/std/[key]) can run,
 * with its Report Center group, the permission area it needs, and which controls / filters its
 * toolbar offers. PURE module (client + server). The server-side runners live in
 * lib/services/reportRegistry.ts and must cover exactly these keys (reportRegistry.test.ts).
 */
import type { Area } from '@/lib/permissions/model';

export type ReportControl =
  /** From / To dates (defaults to fiscal year to date). */
  | 'range'
  /** Optional From / To (blank = all dates). */
  | 'optionalRange'
  /** As-of date. */
  | 'asOf'
  /** Display columns by: total / month / quarter / year. */
  | 'periodColumns'
  /** Previous period / previous year comparison. */
  | 'compare'
  | 'class'
  | 'account'
  | 'customer'
  | 'vendor'
  | 'employee'
  | 'item'
  | 'job'
  | 'txnType'
  | 'amount'
  | 'cleared'
  | 'memo'
  | 'number'
  | 'sort'
  | 'subtotal'
  | 'budget'
  | 'view'
  | 'vehicle'
  /** Aging reports: Interval (days), Through (days past due), aging from due / transaction date. */
  | 'aging'
  /** Open-item reports: only items more than N days past due (cmdbar). */
  | 'overdue';

export type ReportGroup =
  | 'Company & Financial'
  | 'Customers & Receivables'
  | 'Sales'
  | 'Jobs, Time & Mileage'
  | 'Vendors & Payables'
  | 'Purchases'
  | 'Accountant & Taxes'
  | 'Budgets & Forecasts'
  | 'Lists'
  | 'Multiple Companies';

export interface CatalogEntry {
  key: string;
  title: string;
  description: string;
  group: ReportGroup;
  area: Area;
  controls: ReportControl[];
  /** Not listed in the Report Center (e.g. waiting on another package). */
  hidden?: boolean;
  /** Default parameter values. */
  defaults?: Record<string, string>;
  /**
   * Runs on either basis (QB "Report Basis: Accrual / Cash"). With no basis chosen the company's
   * Reports preference ("Summary reports basis") decides; memorized reports save the basis.
   */
  basis?: boolean;
}

const DETAIL_FILTERS: ReportControl[] = ['account', 'customer', 'vendor', 'txnType', 'amount', 'cleared', 'class', 'memo', 'number', 'sort', 'subtotal'];

export const REPORT_CATALOG: CatalogEntry[] = [
  // ---- Company & Financial ----
  { key: 'profit-loss', title: 'Profit & Loss Standard', description: 'Income, cost of goods sold, expenses and net income for a period.', group: 'Company & Financial', area: 'reports_financial', controls: ['range', 'periodColumns', 'compare', 'class'], basis: true },
  { key: 'profit-loss-detail', title: 'Profit & Loss Detail', description: 'Every income and expense transaction behind the P&L.', group: 'Company & Financial', area: 'reports_financial', controls: ['range', ...DETAIL_FILTERS], basis: true },
  { key: 'profit-loss-ytd', title: 'Profit & Loss YTD Comparison', description: 'This period next to the fiscal year to date.', group: 'Company & Financial', area: 'reports_financial', controls: ['range', 'class'], basis: true },
  { key: 'profit-loss-prev-year', title: 'Profit & Loss Prev Year Comparison', description: 'This period vs the same period last year, with $ and % change.', group: 'Company & Financial', area: 'reports_financial', controls: ['range', 'class'], defaults: { compare: 'prev_year' }, basis: true },
  { key: 'profit-loss-by-month', title: 'Profit & Loss by Month', description: 'Income and expenses month by month.', group: 'Company & Financial', area: 'reports_financial', controls: ['range', 'periodColumns', 'class'], defaults: { columns: 'month' }, basis: true },
  { key: 'profit-loss-percent', title: 'Profit & Loss % of Income', description: 'Each line as a percentage of total income.', group: 'Company & Financial', area: 'reports_financial', controls: ['range', 'periodColumns', 'class'], basis: true },
  { key: 'profit-loss-by-job', title: 'Profit & Loss by Job', description: 'One column per customer or job.', group: 'Company & Financial', area: 'reports_financial', controls: ['range', 'class'], basis: true },
  { key: 'pl-by-class', title: 'Profit & Loss by Class', description: 'One column per class.', group: 'Company & Financial', area: 'reports_financial', controls: ['range'], basis: true },
  { key: 'balance-sheet', title: 'Balance Sheet Standard', description: 'What you own and owe, with Retained Earnings and Net Income.', group: 'Company & Financial', area: 'reports_financial', controls: ['asOf', 'compare'], basis: true },
  { key: 'balance-sheet-prev-year', title: 'Balance Sheet Prev Year Comparison', description: 'This balance sheet next to the same date last year, with $ and % change.', group: 'Company & Financial', area: 'reports_financial', controls: ['asOf'], defaults: { compare: 'prev_year' }, basis: true },
  { key: 'balance-sheet-summary', title: 'Balance Sheet Summary', description: 'The balance sheet by section totals only.', group: 'Company & Financial', area: 'reports_financial', controls: ['asOf'], basis: true },
  { key: 'balance-sheet-detail', title: 'Balance Sheet Detail', description: 'Beginning balance, transactions and ending balance for each balance sheet account.', group: 'Company & Financial', area: 'reports_financial', controls: ['range', ...DETAIL_FILTERS], basis: true },
  { key: 'balance-sheet-by-period', title: 'Balance Sheet by Period', description: 'Balance sheet at the end of each month, quarter or year.', group: 'Company & Financial', area: 'reports_financial', controls: ['range', 'periodColumns'], defaults: { columns: 'month' }, basis: true },
  { key: 'statement-of-cash-flows', title: 'Statement of Cash Flows', description: 'Where your cash came from and went: operating, investing and financing.', group: 'Company & Financial', area: 'reports_financial', controls: ['range'] },
  { key: 'trial-balance', title: 'Trial Balance', description: 'Debit and credit balance of every account.', group: 'Accountant & Taxes', area: 'reports_financial', controls: ['asOf'], basis: true },
  { key: 'transaction-detail-by-account', title: 'Transaction Detail by Account', description: 'Every transaction by account, with all report filters.', group: 'Accountant & Taxes', area: 'reports_financial', controls: ['range', ...DETAIL_FILTERS], basis: true },
  { key: 'journal', title: 'Journal', description: 'Every transaction with all of its debit and credit lines.', group: 'Accountant & Taxes', area: 'reports_financial', controls: ['range', 'account', 'customer', 'vendor', 'txnType', 'amount', 'class', 'memo', 'number'] },
  { key: 'transaction-list-by-date', title: 'Transaction List by Date', description: 'One line per transaction, by date.', group: 'Accountant & Taxes', area: 'reports_financial', controls: ['range', 'account', 'customer', 'vendor', 'txnType', 'amount', 'cleared', 'class', 'memo', 'number', 'sort', 'subtotal'] },
  { key: 'income-tax-preparation', title: 'Income Tax Preparation', description: 'Which tax form line each account maps to.', group: 'Accountant & Taxes', area: 'reports_financial', controls: [] },
  { key: 'income-tax-summary', title: 'Income Tax Summary', description: 'Totals by tax form line, in form order.', group: 'Accountant & Taxes', area: 'reports_financial', controls: ['range'], basis: true },
  { key: 'income-tax-detail', title: 'Income Tax Detail', description: 'Accounts behind each tax form line.', group: 'Accountant & Taxes', area: 'reports_financial', controls: ['range'], basis: true },
  { key: 'general-ledger', title: 'General Ledger', description: 'Every account with its beginning balance, transactions and ending balance.', group: 'Accountant & Taxes', area: 'reports_financial', controls: ['range', 'account', 'customer', 'vendor', 'txnType', 'amount', 'cleared', 'class', 'memo', 'number', 'sort'], basis: true },
  { key: 'adjusting-journal-entries', title: 'Adjusting Journal Entries', description: 'Journal entries marked as adjusting entries, with all their lines.', group: 'Accountant & Taxes', area: 'reports_financial', controls: ['range', 'account', 'customer', 'vendor', 'amount', 'class', 'memo', 'number'] },
  { key: 'account-listing', title: 'Account Listing', description: 'Your chart of accounts with balances.', group: 'Lists', area: 'reports_financial', controls: ['asOf'] },

  // ---- Customers & Receivables / Sales ----
  { key: 'ar-aging-summary', title: 'A/R Aging Summary', description: 'What each customer owes, by how many days past due.', group: 'Customers & Receivables', area: 'reports_sales', controls: ['asOf', 'aging', 'customer', 'class'] },
  { key: 'ar-aging-detail', title: 'A/R Aging Detail', description: 'Each open invoice and credit under its aging column.', group: 'Customers & Receivables', area: 'reports_sales', controls: ['asOf', 'aging', 'customer', 'class'] },
  { key: 'open-invoices', title: 'Open Invoices', description: 'Unpaid invoices and credits by customer, as of a date.', group: 'Customers & Receivables', area: 'reports_sales', controls: ['asOf', 'customer', 'class', 'overdue'] },
  { key: 'collections-report', title: 'Collections Report', description: 'Overdue invoices by customer, with phone and email.', group: 'Customers & Receivables', area: 'reports_sales', controls: ['asOf', 'customer', 'class'] },
  { key: 'customer-balance-summary', title: 'Customer Balance Summary', description: 'What each customer owes you.', group: 'Customers & Receivables', area: 'reports_sales', controls: ['asOf'] },
  { key: 'customer-balance-detail', title: 'Customer Balance Detail', description: 'Every invoice and payment behind each customer balance.', group: 'Customers & Receivables', area: 'reports_sales', controls: ['optionalRange', 'customer', 'sort'] },
  { key: 'transaction-list-by-customer', title: 'Transaction List by Customer', description: 'All transactions, grouped by customer.', group: 'Customers & Receivables', area: 'reports_sales', controls: ['range', 'customer', 'txnType', 'amount', 'memo', 'number', 'sort'] },
  { key: 'sales-by-customer-summary', title: 'Sales by Customer Summary', description: 'Total sales per customer and job.', group: 'Sales', area: 'reports_sales', controls: ['range', 'customer', 'item', 'class'], basis: true },
  { key: 'sales-by-item-summary', title: 'Sales by Item Summary', description: 'Quantity, sales, cost and gross margin per item.', group: 'Sales', area: 'reports_sales', controls: ['range', 'customer', 'item', 'class'], basis: true },
  { key: 'sales-by-customer-detail', title: 'Sales by Customer Detail', description: 'Every item sold, grouped by customer.', group: 'Sales', area: 'reports_sales', controls: ['range', 'customer', 'item', 'class'], basis: true },
  { key: 'sales-by-item-detail', title: 'Sales by Item Detail', description: 'Every sale, grouped by item.', group: 'Sales', area: 'reports_sales', controls: ['range', 'customer', 'item', 'class'], basis: true },
  { key: 'open-sales-orders-by-customer', title: 'Open Sales Orders by Customer', description: 'Sales orders not yet invoiced, by customer.', group: 'Sales', area: 'reports_sales', controls: ['customer', 'item'] },
  { key: 'open-sales-orders-by-item', title: 'Open Sales Orders by Item', description: 'Sales orders not yet invoiced, by item.', group: 'Sales', area: 'reports_sales', controls: ['customer', 'item'] },
  { key: 'customer-contact-list', title: 'Customer Contact List', description: 'Name, phone, email, address and balance.', group: 'Lists', area: 'reports_sales', controls: [] },
  { key: 'customer-phone-list', title: 'Customer Phone List', description: 'Customer names and phone numbers.', group: 'Lists', area: 'reports_sales', controls: [] },
  { key: 'item-price-list', title: 'Item Price List', description: 'Your items and their sales prices.', group: 'Lists', area: 'reports_sales', controls: [] },
  { key: 'item-listing', title: 'Item Listing', description: 'Items with cost, price, quantity and accounts.', group: 'Lists', area: 'reports_sales', controls: [] },

  // ---- Jobs, Time & Mileage ----
  { key: 'job-profitability-summary', title: 'Job Profitability Summary', description: 'Actual revenue vs actual cost per customer or job.', group: 'Jobs, Time & Mileage', area: 'reports_sales', controls: ['optionalRange'] },
  { key: 'job-profitability-detail', title: 'Job Profitability Detail', description: 'Revenue and cost by item for one job.', group: 'Jobs, Time & Mileage', area: 'reports_sales', controls: ['optionalRange', 'customer', 'job'] },
  { key: 'job-estimates-vs-actuals', title: 'Job Estimates vs. Actuals', description: 'Estimated revenue vs what you actually billed.', group: 'Jobs, Time & Mileage', area: 'reports_sales', controls: ['optionalRange'] },
  { key: 'item-estimates-vs-actuals', title: 'Item Estimates vs. Actuals', description: 'Estimated vs actual quantity and revenue per item.', group: 'Jobs, Time & Mileage', area: 'reports_sales', controls: ['optionalRange'] },
  { key: 'unbilled-costs-by-job', title: 'Unbilled Costs by Job', description: 'Billable expenses and time not yet invoiced.', group: 'Jobs, Time & Mileage', area: 'reports_sales', controls: [] },
  { key: 'time-by-job', title: 'Time by Job', description: 'Hours per customer or job.', group: 'Jobs, Time & Mileage', area: 'time', controls: ['range', 'view', 'employee', 'customer', 'item'] },
  { key: 'time-by-name', title: 'Time by Name', description: 'Hours per person.', group: 'Jobs, Time & Mileage', area: 'time', controls: ['range', 'view', 'employee', 'customer', 'item'] },
  { key: 'time-by-item', title: 'Time by Item', description: 'Hours per service item.', group: 'Jobs, Time & Mileage', area: 'time', controls: ['range', 'view', 'employee', 'customer', 'item'] },
  { key: 'mileage-by-job', title: 'Mileage by Job', description: 'Miles driven per customer or job.', group: 'Jobs, Time & Mileage', area: 'time', controls: ['range', 'view', 'customer'] },
  { key: 'mileage-by-vehicle', title: 'Mileage by Vehicle', description: 'Miles driven per vehicle.', group: 'Jobs, Time & Mileage', area: 'time', controls: ['range', 'view', 'vehicle'] },

  // ---- Vendors & Payables / Purchases ----
  { key: 'ap-aging-summary', title: 'A/P Aging Summary', description: 'What you owe each vendor, by how many days past due.', group: 'Vendors & Payables', area: 'reports_purchases', controls: ['asOf', 'aging', 'vendor', 'class'] },
  { key: 'ap-aging-detail', title: 'A/P Aging Detail', description: 'Each open bill and credit under its aging column.', group: 'Vendors & Payables', area: 'reports_purchases', controls: ['asOf', 'aging', 'vendor', 'class'] },
  { key: 'sales-tax-liability', title: 'Sales Tax Liability', description: 'Sales tax collected, paid and still owed, by tax agency.', group: 'Vendors & Payables', area: 'sales_tax', controls: ['range'] },
  { key: 'vendor-balance-summary', title: 'Vendor Balance Summary', description: 'What you owe each vendor.', group: 'Vendors & Payables', area: 'reports_purchases', controls: ['asOf'] },
  { key: 'vendor-balance-detail', title: 'Vendor Balance Detail', description: 'Every bill and payment behind each vendor balance.', group: 'Vendors & Payables', area: 'reports_purchases', controls: ['optionalRange', 'vendor', 'sort'] },
  { key: 'unpaid-bills-detail', title: 'Unpaid Bills Detail', description: 'Open bills and credits by vendor, with days past due.', group: 'Vendors & Payables', area: 'reports_purchases', controls: ['asOf', 'vendor', 'overdue'] },
  { key: 'bills-applied-payments', title: 'Bills & Applied Payments', description: 'Each bill with the payments and credits applied to it.', group: 'Vendors & Payables', area: 'reports_purchases', controls: ['range', 'vendor'] },
  { key: 'transaction-list-by-vendor', title: 'Transaction List by Vendor', description: 'All transactions, grouped by vendor.', group: 'Vendors & Payables', area: 'reports_purchases', controls: ['range', 'vendor', 'txnType', 'amount', 'memo', 'number', 'sort'] },
  { key: 'expenses-by-vendor-summary', title: 'Expenses by Vendor Summary', description: 'Total spending per vendor.', group: 'Vendors & Payables', area: 'reports_purchases', controls: ['range', 'class'], basis: true },
  { key: 'expenses-by-vendor-detail', title: 'Expenses by Vendor Detail', description: 'Every expense, grouped by vendor.', group: 'Vendors & Payables', area: 'reports_purchases', controls: ['range', 'vendor', 'class', 'memo', 'sort'], basis: true },
  { key: 'purchases-by-vendor-summary', title: 'Purchases by Vendor Summary', description: 'Items bought from each vendor.', group: 'Purchases', area: 'reports_purchases', controls: ['range', 'item', 'vendor'] },
  { key: 'purchases-by-item-summary', title: 'Purchases by Item Summary', description: 'Quantity and cost of each item bought.', group: 'Purchases', area: 'reports_purchases', controls: ['range', 'item', 'vendor'] },
  { key: 'purchases-by-item-detail', title: 'Purchases by Item Detail', description: 'Every item bought, grouped by item.', group: 'Purchases', area: 'reports_purchases', controls: ['range', 'item', 'vendor'] },
  { key: 'open-purchase-orders', title: 'Open Purchase Orders', description: 'Purchase orders not yet received.', group: 'Purchases', area: 'reports_purchases', controls: ['vendor'] },
  { key: 'vendor-contact-list', title: 'Vendor Contact List', description: 'Name, phone, email, address and balance.', group: 'Lists', area: 'reports_purchases', controls: [] },
  { key: 'vendor-phone-list', title: 'Vendor Phone List', description: 'Vendor names and phone numbers.', group: 'Lists', area: 'reports_purchases', controls: [] },

  // ---- Budgets & Forecasts ----
  { key: 'budget-overview', title: 'Budget Overview', description: 'Your budgeted amounts month by month.', group: 'Budgets & Forecasts', area: 'reports_financial', controls: ['budget', 'customer', 'class'] },
  { key: 'budget-vs-actual-report', title: 'Budget vs. Actual', description: 'Actual results against the budget — by company, class or customer:job, or balance sheet budgets.', group: 'Budgets & Forecasts', area: 'reports_financial', controls: ['budget', 'periodColumns', 'customer', 'class'] },
  { key: 'forecast-overview', title: 'Forecast Overview', description: 'Your forecast month by month.', group: 'Budgets & Forecasts', area: 'reports_financial', controls: ['budget', 'customer'] },

  // ---- Multiple companies ----
  { key: 'combined-trial-balance', title: 'Combined Trial Balance', description: 'Trial balance for every company in this file side by side.', group: 'Multiple Companies', area: 'reports_financial', controls: ['asOf'] },
  { key: 'combined-cash-flow', title: 'Combined Statement of Cash Flows', description: 'Cash flow for every company, combined.', group: 'Multiple Companies', area: 'reports_financial', controls: ['range'] },
  { key: 'combined-pl-by-month', title: 'Combined Profit & Loss by Month', description: 'Monthly P&L across all companies.', group: 'Multiple Companies', area: 'reports_financial', controls: ['range'], basis: true },
  { key: 'combined-ar-aging', title: 'Combined A/R Aging Summary', description: 'Receivables aging for every company.', group: 'Multiple Companies', area: 'reports_sales', controls: ['asOf'] },
  { key: 'combined-ap-aging', title: 'Combined A/P Aging Summary', description: 'Payables aging for every company.', group: 'Multiple Companies', area: 'reports_purchases', controls: ['asOf'] },
];

/** Null-prototype map so keys like "__proto__" / "constructor" never resolve to an entry. */
export const CATALOG_BY_KEY: Record<string, CatalogEntry> = Object.assign(
  Object.create(null) as Record<string, CatalogEntry>,
  Object.fromEntries(REPORT_CATALOG.map((e) => [e.key, e])),
);

export const REPORT_GROUPS: ReportGroup[] = [
  'Company & Financial',
  'Customers & Receivables',
  'Sales',
  'Jobs, Time & Mileage',
  'Vendors & Payables',
  'Purchases',
  'Accountant & Taxes',
  'Budgets & Forecasts',
  'Lists',
  'Multiple Companies',
];

/** Href of a standard report with optional parameters. */
export function stdReportHref(key: string, params: Record<string, string | undefined | null> = {}): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  const s = qs.toString();
  return `/reports/std/${key}${s ? `?${s}` : ''}`;
}
