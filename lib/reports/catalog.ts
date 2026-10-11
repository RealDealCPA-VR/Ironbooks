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
  | 'vehicle';

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
}

const DETAIL_FILTERS: ReportControl[] = ['account', 'customer', 'vendor', 'txnType', 'amount', 'cleared', 'class', 'memo', 'number', 'sort', 'subtotal'];

export const REPORT_CATALOG: CatalogEntry[] = [
  // ---- Company & Financial ----
  { key: 'profit-loss', title: 'Profit & Loss Standard', description: 'Income, cost of goods sold, expenses and net income for a period.', group: 'Company & Financial', area: 'reports_financial', controls: ['range', 'periodColumns', 'compare', 'class'] },
  { key: 'profit-loss-detail', title: 'Profit & Loss Detail', description: 'Every income and expense transaction behind the P&L.', group: 'Company & Financial', area: 'reports_financial', controls: ['range', ...DETAIL_FILTERS] },
  { key: 'profit-loss-ytd', title: 'Profit & Loss YTD Comparison', description: 'This period next to the fiscal year to date.', group: 'Company & Financial', area: 'reports_financial', controls: ['range', 'class'] },
  { key: 'profit-loss-prev-year', title: 'Profit & Loss Prev Year Comparison', description: 'This period vs the same period last year, with $ and % change.', group: 'Company & Financial', area: 'reports_financial', controls: ['range', 'class'], defaults: { compare: 'prev_year' } },
  { key: 'profit-loss-by-month', title: 'Profit & Loss by Month', description: 'Income and expenses month by month.', group: 'Company & Financial', area: 'reports_financial', controls: ['range', 'periodColumns', 'class'], defaults: { columns: 'month' } },
  { key: 'profit-loss-percent', title: 'Profit & Loss % of Income', description: 'Each line as a percentage of total income.', group: 'Company & Financial', area: 'reports_financial', controls: ['range', 'periodColumns', 'class'] },
  { key: 'pl-by-class', title: 'Profit & Loss by Class', description: 'One column per class.', group: 'Company & Financial', area: 'reports_financial', controls: ['range'] },
  { key: 'balance-sheet', title: 'Balance Sheet Standard', description: 'What you own and owe, with Retained Earnings and Net Income.', group: 'Company & Financial', area: 'reports_financial', controls: ['asOf', 'compare'] },
  { key: 'balance-sheet-summary', title: 'Balance Sheet Summary', description: 'The balance sheet by section totals only.', group: 'Company & Financial', area: 'reports_financial', controls: ['asOf'] },
  { key: 'balance-sheet-detail', title: 'Balance Sheet Detail', description: 'Beginning balance, transactions and ending balance for each balance sheet account.', group: 'Company & Financial', area: 'reports_financial', controls: ['range', ...DETAIL_FILTERS] },
  { key: 'balance-sheet-by-period', title: 'Balance Sheet by Period', description: 'Balance sheet at the end of each month, quarter or year.', group: 'Company & Financial', area: 'reports_financial', controls: ['range', 'periodColumns'], defaults: { columns: 'month' } },
  { key: 'trial-balance', title: 'Trial Balance', description: 'Debit and credit balance of every account.', group: 'Accountant & Taxes', area: 'reports_financial', controls: ['asOf'] },
  { key: 'transaction-detail-by-account', title: 'Transaction Detail by Account', description: 'Every transaction by account, with all report filters.', group: 'Accountant & Taxes', area: 'reports_financial', controls: ['range', ...DETAIL_FILTERS] },
  { key: 'journal', title: 'Journal', description: 'Every transaction with all of its debit and credit lines.', group: 'Accountant & Taxes', area: 'reports_financial', controls: ['range', 'account', 'customer', 'vendor', 'txnType', 'amount', 'class', 'memo', 'number'] },
  { key: 'transaction-list-by-date', title: 'Transaction List by Date', description: 'One line per transaction, by date.', group: 'Accountant & Taxes', area: 'reports_financial', controls: ['range', 'account', 'customer', 'vendor', 'txnType', 'amount', 'cleared', 'class', 'memo', 'number', 'sort', 'subtotal'] },
  { key: 'income-tax-preparation', title: 'Income Tax Preparation', description: 'Which tax form line each account maps to.', group: 'Accountant & Taxes', area: 'reports_financial', controls: [], hidden: true },
  { key: 'income-tax-summary', title: 'Income Tax Summary', description: 'Totals by tax form line.', group: 'Accountant & Taxes', area: 'reports_financial', controls: ['range'], hidden: true },
  { key: 'income-tax-detail', title: 'Income Tax Detail', description: 'Accounts behind each tax form line.', group: 'Accountant & Taxes', area: 'reports_financial', controls: ['range'], hidden: true },
  { key: 'account-listing', title: 'Account Listing', description: 'Your chart of accounts with balances.', group: 'Lists', area: 'reports_financial', controls: ['asOf'] },

  // ---- Customers & Receivables / Sales ----
  { key: 'customer-balance-summary', title: 'Customer Balance Summary', description: 'What each customer owes you.', group: 'Customers & Receivables', area: 'reports_sales', controls: ['asOf'] },
  { key: 'customer-balance-detail', title: 'Customer Balance Detail', description: 'Every invoice and payment behind each customer balance.', group: 'Customers & Receivables', area: 'reports_sales', controls: ['optionalRange', 'customer', 'sort'] },
  { key: 'transaction-list-by-customer', title: 'Transaction List by Customer', description: 'All transactions, grouped by customer.', group: 'Customers & Receivables', area: 'reports_sales', controls: ['range', 'customer', 'txnType', 'amount', 'memo', 'number', 'sort'] },
  { key: 'sales-by-customer-detail', title: 'Sales by Customer Detail', description: 'Every item sold, grouped by customer.', group: 'Sales', area: 'reports_sales', controls: ['range', 'customer', 'item', 'class'] },
  { key: 'sales-by-item-detail', title: 'Sales by Item Detail', description: 'Every sale, grouped by item.', group: 'Sales', area: 'reports_sales', controls: ['range', 'customer', 'item', 'class'] },
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
  { key: 'vendor-balance-summary', title: 'Vendor Balance Summary', description: 'What you owe each vendor.', group: 'Vendors & Payables', area: 'reports_purchases', controls: ['asOf'] },
  { key: 'vendor-balance-detail', title: 'Vendor Balance Detail', description: 'Every bill and payment behind each vendor balance.', group: 'Vendors & Payables', area: 'reports_purchases', controls: ['optionalRange', 'vendor', 'sort'] },
  { key: 'unpaid-bills-detail', title: 'Unpaid Bills Detail', description: 'Open bills and credits by vendor, with days past due.', group: 'Vendors & Payables', area: 'reports_purchases', controls: ['asOf', 'vendor'] },
  { key: 'bills-applied-payments', title: 'Bills & Applied Payments', description: 'Each bill with the payments and credits applied to it.', group: 'Vendors & Payables', area: 'reports_purchases', controls: ['range', 'vendor'] },
  { key: 'transaction-list-by-vendor', title: 'Transaction List by Vendor', description: 'All transactions, grouped by vendor.', group: 'Vendors & Payables', area: 'reports_purchases', controls: ['range', 'vendor', 'txnType', 'amount', 'memo', 'number', 'sort'] },
  { key: 'expenses-by-vendor-summary', title: 'Expenses by Vendor Summary', description: 'Total spending per vendor.', group: 'Vendors & Payables', area: 'reports_purchases', controls: ['range', 'class'] },
  { key: 'expenses-by-vendor-detail', title: 'Expenses by Vendor Detail', description: 'Every expense, grouped by vendor.', group: 'Vendors & Payables', area: 'reports_purchases', controls: ['range', 'vendor', 'class', 'memo', 'sort'] },
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
  { key: 'combined-pl-by-month', title: 'Combined Profit & Loss by Month', description: 'Monthly P&L across all companies.', group: 'Multiple Companies', area: 'reports_financial', controls: ['range'] },
  { key: 'combined-ar-aging', title: 'Combined A/R Aging Summary', description: 'Receivables aging for every company.', group: 'Multiple Companies', area: 'reports_sales', controls: ['asOf'] },
  { key: 'combined-ap-aging', title: 'Combined A/P Aging Summary', description: 'Payables aging for every company.', group: 'Multiple Companies', area: 'reports_purchases', controls: ['asOf'] },
];

export const CATALOG_BY_KEY: Record<string, CatalogEntry> = Object.fromEntries(REPORT_CATALOG.map((e) => [e.key, e]));

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
