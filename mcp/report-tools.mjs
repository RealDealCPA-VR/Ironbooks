/**
 * Every standard report, by its key (plan §9, Phase 2): list_reports finds one, run_report runs it
 * with the options the report itself offers, report_drilldown lists the transactions behind one of
 * its amounts, and export_report makes the same report as a PDF or Excel file.
 *
 * Each runs one operation of the generic door (run_operation, mcp/operations-tools.mjs), so the
 * agent's role and policy decide as they do for every other read:
 *
 *   run_report        reports.std.get       GET /api/reports/std/[report]
 *   report_drilldown  reports.drilldown.get GET /api/reports/drilldown/[report]
 *   export_report     reports.std.get, then export.reports (POST /api/export/reports): the rows
 *                     the report answered, made into a file the same way the report window's own
 *                     Excel and PDF buttons make it (lib/reports/types.ts reportToTable). The file
 *                     is staged, and the answer names it for get_file and save_file.
 *
 * The connector ships on its own (no TypeScript, no app modules), so the report catalog
 * (lib/reports/catalog.ts) is copied here: key, title, group, what it shows, the controls its
 * window offers and whether it runs on either basis. test/mcp/reportTools.test.ts holds the copy
 * to the catalog, the options to the app's report parameters (lib/validation/reports.ts) and the
 * drill-down list to lib/reports/drilldown.ts, so a report added or changed in the app fails a test
 * here, not an agent's question.
 *
 * Also the report shaping the named report_* tools use (shapeReport): column headers once, then
 * each row as its cells in column order.
 *
 * When an Admin set reading reports to Ask, a person must approve the read first. These tools only
 * look, so they take no request id or reason to ask with (test/mcp/protocol.test.ts holds every
 * tool that only looks to that): the answer says to ask with run_operation, with the same input,
 * then to wait_for_decision. What the agent then collects comes back as these tools give it
 * (compactCollected, used by mcp/tools.mjs).
 */
import { ToolError } from './protocol.mjs';
import { fit, runOperation } from './entry-tools.mjs';
import { askedReadCheck, settle } from './write-tools.mjs';

const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', patternHint: 'must be a date as YYYY-MM-DD' };
const ID = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', patternHint: 'must be an id returned by another tool' };
const MONEY = { type: 'string', pattern: '^\\d{1,13}(\\.\\d{1,2})?$', patternHint: 'must be an amount like 1250.00' };

/** The named periods a report takes instead of dates (lib/validation/reports.ts `dates`). */
export const DATE_PRESETS = [
  'today', 'this_week', 'this_month', 'this_month_to_date', 'last_month', 'this_quarter', 'this_quarter_to_date',
  'last_quarter', 'this_year', 'this_year_to_date', 'last_year', 'this_fiscal_year', 'this_fiscal_year_to_date',
  'last_fiscal_year', 'all',
];

/** Transaction types a report or a search can filter by (lib/validation/reports.ts TXN_TYPE_KEYS). */
export const TXN_TYPES = [
  'invoice', 'payment', 'sales_receipt', 'credit_memo', 'refund', 'bill', 'bill_payment', 'bill_credit', 'check',
  'deposit', 'transfer', 'paycheck', 'journal', 'inventory', 'item_receipt', 'build_assembly', 'depreciation',
  'sales_tax_payment', 'cc_payment', 'expense_report', 'opening_balance', 'other',
];

/**
 * A standard report as Ironbooks returns it, made compact: column headers once, then each row as
 * its cells in column order, with its level and kind (section heading, line, subtotal, total).
 * `ids`: also each column's key and each row's id, which report_drilldown names an amount by.
 * @param {any} report
 * @param {number} [maxRows]
 * @param {{ ids?: boolean }} [opts]
 * @returns {Record<string, any>}
 */
export function shapeReport(report, maxRows, opts = {}) {
  const columns = Array.isArray(report?.columns) ? report.columns : [];
  const rows = (Array.isArray(report?.rows) ? report.rows : []).filter((r) => r && r.kind !== 'spacer');
  const limit = maxRows ?? 300;
  const out = {
    report: report?.title ?? report?.key ?? 'Report',
    ...(report?.subtitle ? { subtitle: report.subtitle } : {}),
    ...(report?.basis ? { basis: report.basis } : {}),
    ...(report?.range ? { period: report.range } : {}),
    ...(typeof report?.balanced === 'boolean' ? { balanced: report.balanced } : {}),
    columns: columns.map((c) => ({ name: c.header || c.key, ...(opts.ids ? { key: c.key } : {}), ...(c.type ? { type: c.type } : {}) })),
    row_count: rows.length,
    rows: rows.slice(0, limit).map((r) => ({
      ...(opts.ids && r.id ? { row_id: r.id } : {}),
      kind: r.kind,
      level: r.depth ?? 0,
      cells: columns.map((c) => r.cells?.[c.key] ?? null),
      ...(r.entryId ? { journal_entry_id: r.entryId } : {}),
    })),
  };
  const notes = Array.isArray(report?.notes) ? report.notes.filter(Boolean) : [];
  if (report?.truncated) notes.push('Ironbooks cut this report short. Use a shorter date range or a filter.');
  if (rows.length > limit) {
    out.truncated = true;
    notes.push(`Showing the first ${limit} of ${rows.length} rows. Use a shorter date range, a filter, or a higher max_rows.`);
  }
  if (notes.length) out.notes = notes;
  return out;
}

// ---------------------------------------------------------------------------
// The catalog (a copy of lib/reports/catalog.ts REPORT_CATALOG; a test holds them together)
// ---------------------------------------------------------------------------

/**
 * `controls` are the catalog's own words for what the report's window offers (ReportControl);
 * REPORT_CONTROL_OPTIONS turns them into this tool's options. `basis`: it runs on cash or accrual.
 * `needs`: the company preference the report belongs to (it is refused while that is off).
 */
export const REPORTS = [
  { key: 'profit-loss', title: 'Profit & Loss Standard', group: 'Company & Financial', about: 'Income, cost of goods sold, expenses and net income for a period.', controls: 'range periodColumns compare class customer vendor employee item account txnType amount cleared memo number', basis: true },
  { key: 'profit-loss-detail', title: 'Profit & Loss Detail', group: 'Company & Financial', about: 'Every income and expense transaction behind the P&L.', controls: 'range account customer vendor item txnType amount cleared class memo number sort subtotal', basis: true },
  { key: 'profit-loss-ytd', title: 'Profit & Loss YTD Comparison', group: 'Company & Financial', about: 'This period next to the fiscal year to date.', controls: 'range class', basis: true },
  { key: 'profit-loss-prev-year', title: 'Profit & Loss Prev Year Comparison', group: 'Company & Financial', about: 'This period vs the same period last year, with $ and % change.', controls: 'range class customer vendor employee item account txnType amount cleared memo number', basis: true },
  { key: 'profit-loss-by-month', title: 'Profit & Loss by Month', group: 'Company & Financial', about: 'Income and expenses month by month.', controls: 'range periodColumns class customer vendor employee item account txnType amount cleared memo number', basis: true },
  { key: 'profit-loss-percent', title: 'Profit & Loss % of Income', group: 'Company & Financial', about: 'Each line as a percentage of total income.', controls: 'range periodColumns class customer vendor employee item account txnType amount cleared memo number', basis: true },
  { key: 'profit-loss-by-job', title: 'Profit & Loss by Job', group: 'Company & Financial', about: 'One column per customer or job.', controls: 'range class', basis: true },
  { key: 'pl-by-class', title: 'Profit & Loss by Class', group: 'Company & Financial', about: 'One column per class.', controls: 'range', basis: true },
  { key: 'balance-sheet', title: 'Balance Sheet Standard', group: 'Company & Financial', about: 'What you own and owe, with Retained Earnings and Net Income.', controls: 'asOf compare class customer vendor employee item account txnType amount cleared memo number', basis: true },
  { key: 'balance-sheet-prev-year', title: 'Balance Sheet Prev Year Comparison', group: 'Company & Financial', about: 'This balance sheet next to the same date last year, with $ and % change.', controls: 'asOf class customer vendor employee item account txnType amount cleared memo number', basis: true },
  { key: 'balance-sheet-summary', title: 'Balance Sheet Summary', group: 'Company & Financial', about: 'The balance sheet by section totals only.', controls: 'asOf class customer vendor employee item account txnType amount cleared memo number', basis: true },
  { key: 'balance-sheet-detail', title: 'Balance Sheet Detail', group: 'Company & Financial', about: 'Beginning balance, transactions and ending balance for each balance sheet account.', controls: 'range account customer vendor item txnType amount cleared class memo number sort subtotal', basis: true },
  { key: 'balance-sheet-by-period', title: 'Balance Sheet by Period', group: 'Company & Financial', about: 'Balance sheet at the end of each month, quarter or year.', controls: 'range periodColumns class customer vendor employee item account txnType amount cleared memo number', basis: true },
  { key: 'cash-flow-forecast', title: 'Cash Flow Forecast', group: 'Company & Financial', about: 'The cash you can expect week by week from open invoices, bills and bank transactions.', controls: 'range period' },
  { key: 'statement-of-cash-flows', title: 'Statement of Cash Flows', group: 'Company & Financial', about: 'Where your cash came from and went: operating, investing and financing.', controls: 'range' },
  { key: 'trial-balance', title: 'Trial Balance', group: 'Accountant & Taxes', about: 'Debit and credit balance of every account.', controls: 'asOf', basis: true },
  { key: 'transaction-detail-by-account', title: 'Transaction Detail by Account', group: 'Accountant & Taxes', about: 'Every transaction by account, with all report filters.', controls: 'range account customer vendor item txnType amount cleared class memo number sort subtotal', basis: true },
  { key: 'journal', title: 'Journal', group: 'Accountant & Taxes', about: 'Every transaction with all of its debit and credit lines.', controls: 'range account customer vendor txnType amount class memo number' },
  { key: 'transaction-list-by-date', title: 'Transaction List by Date', group: 'Accountant & Taxes', about: 'One line per transaction, by date.', controls: 'range account customer vendor txnType amount cleared class memo number sort subtotal' },
  { key: 'income-tax-preparation', title: 'Income Tax Preparation', group: 'Accountant & Taxes', about: 'Which tax form line each account maps to.', controls: '' },
  { key: 'income-tax-summary', title: 'Income Tax Summary', group: 'Accountant & Taxes', about: 'Totals by tax form line, in form order.', controls: 'range', basis: true },
  { key: 'income-tax-detail', title: 'Income Tax Detail', group: 'Accountant & Taxes', about: 'Accounts behind each tax form line.', controls: 'range', basis: true },
  { key: 'general-ledger', title: 'General Ledger', group: 'Accountant & Taxes', about: 'Every account with its beginning balance, transactions and ending balance.', controls: 'range account customer vendor txnType amount cleared class memo number sort', basis: true },
  { key: 'adjusting-journal-entries', title: 'Adjusting Journal Entries', group: 'Accountant & Taxes', about: 'Journal entries marked as adjusting entries, with all their lines.', controls: 'range account customer vendor amount class memo number' },
  { key: 'account-listing', title: 'Account Listing', group: 'Lists', about: 'Your chart of accounts with balances.', controls: 'asOf' },
  { key: 'ar-aging-summary', title: 'A/R Aging Summary', group: 'Customers & Receivables', about: 'What each customer owes, by how many days past due.', controls: 'asOf aging customer customerType class' },
  { key: 'ar-aging-detail', title: 'A/R Aging Detail', group: 'Customers & Receivables', about: 'Each open invoice and credit under its aging column.', controls: 'asOf aging customer customerType class' },
  { key: 'open-invoices', title: 'Open Invoices', group: 'Customers & Receivables', about: 'Unpaid invoices and credits by customer, as of a date.', controls: 'asOf customer customerType class overdue' },
  { key: 'collections-report', title: 'Collections Report', group: 'Customers & Receivables', about: 'Overdue invoices by customer, with phone and email.', controls: 'asOf customer customerType class overdue' },
  { key: 'customer-balance-summary', title: 'Customer Balance Summary', group: 'Customers & Receivables', about: 'What each customer owes you.', controls: 'asOf customerType' },
  { key: 'customer-balance-detail', title: 'Customer Balance Detail', group: 'Customers & Receivables', about: 'Every invoice and payment behind each customer balance.', controls: 'optionalRange customer customerType sort' },
  { key: 'transaction-list-by-customer', title: 'Transaction List by Customer', group: 'Customers & Receivables', about: 'All transactions, grouped by customer.', controls: 'range customer txnType amount memo number sort' },
  { key: 'sales-by-customer-summary', title: 'Sales by Customer Summary', group: 'Sales', about: 'Total sales per customer and job.', controls: 'range customer customerType item class', basis: true },
  { key: 'sales-by-item-summary', title: 'Sales by Item Summary', group: 'Sales', about: 'Quantity, sales, cost and gross margin per item.', controls: 'range customer item class', basis: true },
  { key: 'sales-by-customer-detail', title: 'Sales by Customer Detail', group: 'Sales', about: 'Every item sold, grouped by customer.', controls: 'range customer customerType item class', basis: true },
  { key: 'sales-by-item-detail', title: 'Sales by Item Detail', group: 'Sales', about: 'Every sale, grouped by item.', controls: 'range customer item class', basis: true },
  { key: 'sales-by-rep-summary', title: 'Sales by Rep Summary', group: 'Sales', about: 'Sales and commission per sales rep.', controls: 'range rep customer item class', basis: true },
  { key: 'sales-by-rep-detail', title: 'Sales by Rep Detail', group: 'Sales', about: 'Every sale, grouped by sales rep.', controls: 'range rep customer item class', basis: true },
  { key: 'open-sales-orders-by-customer', title: 'Open Sales Orders by Customer', group: 'Sales', about: 'Sales orders not yet invoiced, by customer.', controls: 'customer item' },
  { key: 'open-sales-orders-by-item', title: 'Open Sales Orders by Item', group: 'Sales', about: 'Sales orders not yet invoiced, by item.', controls: 'customer item' },
  { key: 'customer-contact-list', title: 'Customer Contact List', group: 'Lists', about: 'Name, phone, email, address and balance.', controls: '' },
  { key: 'customer-phone-list', title: 'Customer Phone List', group: 'Lists', about: 'Customer names and phone numbers.', controls: '' },
  { key: 'item-price-list', title: 'Item Price List', group: 'Lists', about: 'Your items and their sales prices.', controls: '' },
  { key: 'item-listing', title: 'Item Listing', group: 'Lists', about: 'Items with cost, price, quantity and accounts.', controls: '' },
  { key: 'job-profitability-summary', title: 'Job Profitability Summary', group: 'Jobs, Time & Mileage', about: 'Actual revenue vs actual cost per customer or job.', controls: 'optionalRange jobType' },
  { key: 'job-profitability-detail', title: 'Job Profitability Detail', group: 'Jobs, Time & Mileage', about: 'Revenue and cost by item for one job.', controls: 'optionalRange customer job jobType' },
  { key: 'job-estimates-vs-actuals', title: 'Job Estimates vs. Actuals', group: 'Jobs, Time & Mileage', about: 'Estimated revenue vs what you actually billed.', controls: 'optionalRange jobType' },
  { key: 'item-estimates-vs-actuals', title: 'Item Estimates vs. Actuals', group: 'Jobs, Time & Mileage', about: 'Estimated vs actual quantity and revenue per item.', controls: 'optionalRange' },
  { key: 'unbilled-costs-by-job', title: 'Unbilled Costs by Job', group: 'Jobs, Time & Mileage', about: 'Billable expenses and time not yet invoiced.', controls: '' },
  { key: 'time-by-job', title: 'Time by Job', group: 'Jobs, Time & Mileage', about: 'Hours per customer or job.', controls: 'range view employee customer item' },
  { key: 'time-by-name', title: 'Time by Name', group: 'Jobs, Time & Mileage', about: 'Hours per person.', controls: 'range view employee customer item' },
  { key: 'time-by-item', title: 'Time by Item', group: 'Jobs, Time & Mileage', about: 'Hours per service item.', controls: 'range view employee customer item' },
  { key: 'mileage-by-job', title: 'Mileage by Job', group: 'Jobs, Time & Mileage', about: 'Miles driven per customer or job.', controls: 'range view customer' },
  { key: 'mileage-by-vehicle', title: 'Mileage by Vehicle', group: 'Jobs, Time & Mileage', about: 'Miles driven per vehicle.', controls: 'range view vehicle' },
  { key: 'ap-aging-summary', title: 'A/P Aging Summary', group: 'Vendors & Payables', about: 'What you owe each vendor, by how many days past due.', controls: 'asOf aging vendor vendorType class' },
  { key: 'ap-aging-detail', title: 'A/P Aging Detail', group: 'Vendors & Payables', about: 'Each open bill and credit under its aging column.', controls: 'asOf aging vendor vendorType class' },
  { key: 'sales-tax-liability', title: 'Sales Tax Liability', group: 'Vendors & Payables', about: 'Sales tax collected, paid and still owed, by tax agency.', controls: 'range', needs: 'sales_tax' },
  { key: 'sales-tax-revenue-summary', title: 'Sales Tax Revenue Summary', group: 'Vendors & Payables', about: 'Total, non-taxable and taxable sales and the tax on them, per sales tax item.', controls: 'range', needs: 'sales_tax' },
  { key: 'vendor-balance-summary', title: 'Vendor Balance Summary', group: 'Vendors & Payables', about: 'What you owe each vendor.', controls: 'asOf vendorType' },
  { key: 'vendor-balance-detail', title: 'Vendor Balance Detail', group: 'Vendors & Payables', about: 'Every bill and payment behind each vendor balance.', controls: 'optionalRange vendor vendorType sort' },
  { key: 'unpaid-bills-detail', title: 'Unpaid Bills Detail', group: 'Vendors & Payables', about: 'Open bills and credits by vendor, with days past due.', controls: 'asOf vendor vendorType overdue' },
  { key: 'bills-applied-payments', title: 'Bills & Applied Payments', group: 'Vendors & Payables', about: 'Each bill with the payments and credits applied to it.', controls: 'range vendor' },
  { key: 'transaction-list-by-vendor', title: 'Transaction List by Vendor', group: 'Vendors & Payables', about: 'All transactions, grouped by vendor.', controls: 'range vendor txnType amount memo number sort' },
  { key: 'expenses-by-vendor-summary', title: 'Expenses by Vendor Summary', group: 'Vendors & Payables', about: 'Total spending per vendor.', controls: 'range class', basis: true },
  { key: 'expenses-by-vendor-detail', title: 'Expenses by Vendor Detail', group: 'Vendors & Payables', about: 'Every expense, grouped by vendor.', controls: 'range vendor class memo sort', basis: true },
  { key: 'purchases-by-vendor-summary', title: 'Purchases by Vendor Summary', group: 'Purchases', about: 'Items bought from each vendor.', controls: 'range item vendor vendorType' },
  { key: 'purchases-by-item-summary', title: 'Purchases by Item Summary', group: 'Purchases', about: 'Quantity and cost of each item bought.', controls: 'range item vendor' },
  { key: 'purchases-by-item-detail', title: 'Purchases by Item Detail', group: 'Purchases', about: 'Every item bought, grouped by item.', controls: 'range item vendor' },
  { key: 'open-purchase-orders', title: 'Open Purchase Orders', group: 'Purchases', about: 'Purchase orders not yet received.', controls: 'vendor' },
  { key: 'vendor-contact-list', title: 'Vendor Contact List', group: 'Lists', about: 'Name, phone, email, address and balance.', controls: '' },
  { key: 'vendor-phone-list', title: 'Vendor Phone List', group: 'Lists', about: 'Vendor names and phone numbers.', controls: '' },
  { key: 'budget-overview', title: 'Budget Overview', group: 'Budgets & Forecasts', about: 'Your budgeted amounts month by month.', controls: 'budget customer class' },
  { key: 'budget-vs-actual-report', title: 'Budget vs. Actual', group: 'Budgets & Forecasts', about: 'Actual results against the budget — by company, class or customer:job, or balance sheet budgets.', controls: 'budget periodColumns customer class' },
  { key: 'forecast-overview', title: 'Forecast Overview', group: 'Budgets & Forecasts', about: 'Your forecast month by month.', controls: 'budget customer' },
  { key: 'inventory-valuation-summary', title: 'Inventory Valuation Summary', group: 'Inventory', about: 'On hand, average cost, asset value and retail value per item.', controls: 'asOf item', needs: 'inventory' },
  { key: 'inventory-valuation-detail', title: 'Inventory Valuation Detail', group: 'Inventory', about: 'Every change in the value of each item, with a running asset value.', controls: 'range item', needs: 'inventory' },
  { key: 'inventory-stock-status-by-item', title: 'Inventory Stock Status by Item', group: 'Inventory', about: 'On hand, on sales order, available, on purchase order and when to reorder.', controls: 'range item vendor', needs: 'inventory' },
  { key: 'inventory-stock-status-by-vendor', title: 'Inventory Stock Status by Vendor', group: 'Inventory', about: 'Stock status grouped by the preferred vendor of each item.', controls: 'range item vendor', needs: 'inventory' },
  { key: 'physical-inventory-worksheet', title: 'Physical Inventory Worksheet', group: 'Inventory', about: 'A count sheet: every item with its quantity on hand and a blank count column.', controls: 'item', needs: 'inventory' },
  { key: 'quantity-on-hand-by-site', title: 'Quantity on Hand by Site', group: 'Inventory', about: 'How many of each item are at each inventory site.', controls: 'site item', needs: 'inventory' },
  { key: 'inventory-stock-status-by-site', title: 'Inventory Stock Status by Site', group: 'Inventory', about: 'Stock status for each item at each site.', controls: 'site item', needs: 'inventory' },
  { key: 'inventory-reorder-by-site', title: 'Inventory Reorder Report by Site', group: 'Inventory', about: 'Items at or below their reorder point, by site.', controls: 'site', needs: 'inventory' },
  { key: 'serial-lot-in-stock', title: 'Serial/Lot Numbers in Stock', group: 'Inventory', about: 'Serial and lot numbers on hand, by site and bin.', controls: 'site item', needs: 'inventory' },
  { key: 'transactions-by-serial-lot', title: 'Transactions by Serial/Lot Number', group: 'Inventory', about: 'Every transaction that moved one serial or lot number.', controls: 'number item', needs: 'inventory' },
  { key: 'payroll-summary', title: 'Payroll Summary', group: 'Employees & Payroll', about: 'Wages, taxes, deductions and net pay per employee.', controls: 'range employee', needs: 'payroll' },
  { key: 'employee-earnings-summary', title: 'Employee Earnings Summary', group: 'Employees & Payroll', about: 'One line per employee: gross, each tax and deduction, net pay.', controls: 'range employee', needs: 'payroll' },
  { key: 'payroll-detail', title: 'Payroll Detail', group: 'Employees & Payroll', about: 'Every paycheck with its gross, taxes, deductions and net pay.', controls: 'range employee', needs: 'payroll' },
  { key: 'payroll-item-detail', title: 'Payroll Item Detail', group: 'Employees & Payroll', about: 'Every paycheck line, grouped by payroll item.', controls: 'range employee', needs: 'payroll' },
  { key: 'payroll-liability-balances', title: 'Payroll Liability Balances', group: 'Employees & Payroll', about: 'Payroll taxes and deductions owed, by payroll item.', controls: 'asOf', needs: 'payroll' },
  { key: 'employee-contact-list', title: 'Employee Contact List', group: 'Lists', about: 'Employees with SS No. (last four digits), phone, email and address.', controls: 'employee' },
  { key: 'check-detail', title: 'Check Detail', group: 'Banking', about: 'Every check written, with the accounts and bills it paid.', controls: 'range account' },
  { key: 'deposit-detail', title: 'Deposit Detail', group: 'Banking', about: 'Every deposit with the payments and lines in it.', controls: 'range account' },
  { key: 'missing-checks', title: 'Missing Checks', group: 'Banking', about: 'Gaps in the check numbers of each bank account.', controls: 'account' },
  { key: 'voided-deleted-summary', title: 'Voided/Deleted Transactions Summary', group: 'Accountant & Taxes', about: 'Every transaction voided or deleted, who did it and when.', controls: 'optionalRange' },
  { key: 'voided-deleted-detail', title: 'Voided/Deleted Transactions Detail', group: 'Accountant & Taxes', about: 'The same list with the original values of each transaction.', controls: 'optionalRange' },
  { key: 'closing-date-exceptions', title: 'Closing Date Exception Report', group: 'Accountant & Taxes', about: 'Changes made on or before the closing date with the closing date password.', controls: 'optionalRange' },
  { key: 'agent-activity', title: 'Agent Activity', group: 'Accountant & Taxes', about: 'Every request an agent made for approval, who decided and what became of it.', controls: 'optionalRange' },
  { key: 'combined-trial-balance', title: 'Combined Trial Balance', group: 'Multiple Companies', about: 'Trial balance for every company in this file side by side.', controls: 'asOf' },
  { key: 'combined-cash-flow', title: 'Combined Statement of Cash Flows', group: 'Multiple Companies', about: 'Cash flow for every company, combined.', controls: 'range' },
  { key: 'combined-pl-by-month', title: 'Combined Profit & Loss by Month', group: 'Multiple Companies', about: 'Monthly P&L across all companies.', controls: 'range', basis: true },
  { key: 'combined-ar-aging', title: 'Combined A/R Aging Summary', group: 'Multiple Companies', about: 'Receivables aging for every company.', controls: 'asOf' },
  { key: 'combined-ap-aging', title: 'Combined A/P Aging Summary', group: 'Multiple Companies', about: 'Payables aging for every company.', controls: 'asOf' },
];

/** Every report key, in the catalog's order: run_report's choices. */
export const REPORT_KEYS = REPORTS.map((r) => r.key);

/** The Report Center's groups, in its order (lib/reports/catalog.ts REPORT_GROUPS). */
export const REPORT_GROUPS = [
  'Company & Financial', 'Customers & Receivables', 'Sales', 'Jobs, Time & Mileage', 'Vendors & Payables', 'Purchases',
  'Inventory', 'Employees & Payroll', 'Banking', 'Accountant & Taxes', 'Budgets & Forecasts', 'Lists', 'Multiple Companies',
];

/** Reports whose every amount report_drilldown can explain (lib/reports/drilldown.ts DRILLDOWN_REPORTS). */
export const DRILLDOWN_KEYS = [
  'profit-loss', 'profit-loss-prev-year', 'profit-loss-by-month', 'profit-loss-percent', 'profit-loss-ytd', 'pl-by-class',
  'profit-loss-by-job', 'balance-sheet', 'balance-sheet-prev-year', 'balance-sheet-summary', 'balance-sheet-by-period',
  'trial-balance', 'general-ledger', 'ar-aging-summary', 'ar-aging-detail', 'ap-aging-summary', 'ap-aging-detail',
  'open-invoices', 'collections-report', 'sales-by-customer-summary', 'sales-by-item-summary', 'expenses-by-vendor-summary',
];

const BY_KEY = new Map(REPORTS.map((r) => [r.key, r]));
const NEEDS_WORDS = { inventory: 'inventory to be turned on (Edit > Preferences)', payroll: 'payroll to be turned on', sales_tax: 'sales tax to be turned on' };

// ---------------------------------------------------------------------------
// Options: the tool's names, the app's names, and which report offers which
// ---------------------------------------------------------------------------

/** The options each of the catalog's controls offers. */
export const REPORT_CONTROL_OPTIONS = {
  range: ['period', 'date_from', 'date_to'],
  optionalRange: ['period', 'date_from', 'date_to'],
  asOf: ['period', 'as_of'],
  periodColumns: ['columns'],
  compare: ['compare'],
  class: ['class_id'],
  account: ['account_id'],
  customer: ['customer_id'],
  vendor: ['vendor_id'],
  customerType: ['customer_type_id'],
  vendorType: ['vendor_type_id'],
  jobType: ['job_type_id'],
  employee: ['employee_id'],
  item: ['item_id'],
  job: ['job_id'],
  txnType: ['transaction_type'],
  amount: ['amount_min', 'amount_max'],
  cleared: ['cleared'],
  memo: ['memo'],
  number: ['number'],
  sort: ['sort_by', 'sort_dir'],
  subtotal: ['subtotal_by'],
  budget: ['budget_id'],
  view: ['view'],
  vehicle: ['vehicle'],
  aging: ['days_per_column', 'through_days', 'age_from'],
  overdue: ['more_than_days_past_due'],
  rep: ['sales_rep_id'],
  site: ['site_id'],
  period: ['forecast_by'],
};

/** Each option's name in the app (the query of GET /api/reports/std/[report], lib/validation/reports.ts). */
export const REPORT_OPTION_PARAMS = {
  period: 'dates',
  date_from: 'from',
  date_to: 'to',
  as_of: 'asOf',
  prior_as_of: 'priorAsOf',
  basis: 'basis',
  columns: 'columns',
  compare: 'compare',
  class_id: 'classId',
  account_id: 'accountId',
  customer_id: 'customerId',
  vendor_id: 'vendorId',
  customer_type_id: 'customerTypeId',
  vendor_type_id: 'vendorTypeId',
  job_type_id: 'jobTypeId',
  employee_id: 'employeeId',
  item_id: 'itemId',
  job_id: 'jobId',
  transaction_type: 'txnType',
  amount_min: 'amountMin',
  amount_max: 'amountMax',
  cleared: 'cleared',
  memo: 'memo',
  number: 'number',
  sort_by: 'sortBy',
  sort_dir: 'sortDir',
  subtotal_by: 'subtotalBy',
  budget_id: 'budgetId',
  view: 'view',
  vehicle: 'vehicle',
  days_per_column: 'interval',
  through_days: 'through',
  age_from: 'agingFrom',
  more_than_days_past_due: 'overDays',
  sales_rep_id: 'repId',
  site_id: 'siteId',
  forecast_by: 'period',
};

/** The options one report takes, in a steady order. */
export function optionsOf(/** @type {{ controls: string, basis?: boolean }} */ entry) {
  const controls = entry.controls ? entry.controls.split(' ') : [];
  const out = new Set();
  for (const c of controls) for (const o of REPORT_CONTROL_OPTIONS[/** @type {keyof typeof REPORT_CONTROL_OPTIONS} */ (c)] ?? []) out.add(o);
  // A balance sheet compared with an earlier date can name that date.
  if (controls.includes('compare') && controls.includes('asOf')) out.add('prior_as_of');
  if (entry.basis) out.add('basis');
  return Object.keys(REPORT_OPTION_PARAMS).filter((o) => out.has(o));
}

const ID_OPTION = (/** @type {string} */ what) => ({ ...ID, description: `Only ${what}.` });

/** The options object of run_report, report_drilldown and export_report. */
export const REPORT_OPTIONS = {
  type: 'object',
  additionalProperties: false,
  description:
    'The report\'s options, in the tool\'s names. Each report takes only some of them: list_reports shows which. Leave out what you do not need; the report then uses its own defaults (dates: the fiscal year to date, or today).',
  properties: {
    period: { type: 'string', enum: DATE_PRESETS, description: 'A named period, instead of date_from / date_to (or as_of).' },
    date_from: { ...DATE, description: 'First day (YYYY-MM-DD).' },
    date_to: { ...DATE, description: 'Last day (YYYY-MM-DD).' },
    as_of: { ...DATE, description: 'The date of a point-in-time report (balance sheet, aging, trial balance). Default today.' },
    prior_as_of: { ...DATE, description: 'With compare: the earlier date to compare with (default a period or a year before).' },
    basis: { type: 'string', enum: ['accrual', 'cash'], description: "Accrual or cash basis. Default: the company's report basis (see get_company_info)." },
    columns: { type: 'string', enum: ['total', 'month', 'quarter', 'year'], description: 'One total column (default) or one column per month, quarter or year.' },
    compare: { type: 'string', enum: ['none', 'prev_period', 'prev_year'], description: 'Add the previous period or the same period last year, with the change.' },
    class_id: ID_OPTION('this class (list_classes)'),
    account_id: ID_OPTION('this account and its sub-accounts (list_accounts)'),
    customer_id: ID_OPTION('this customer or job (list_customers)'),
    vendor_id: ID_OPTION('this vendor (list_vendors)'),
    customer_type_id: ID_OPTION('customers of this customer type'),
    vendor_type_id: ID_OPTION('vendors of this vendor type'),
    job_type_id: ID_OPTION('jobs of this job type'),
    employee_id: ID_OPTION('this employee (list_employees)'),
    item_id: ID_OPTION('this item (list_items)'),
    job_id: ID_OPTION('this job'),
    budget_id: { ...ID, description: 'The budget or forecast to show (run_operation "budgets.list" lists them). Needed by the budget reports.' },
    site_id: ID_OPTION('this inventory site'),
    sales_rep_id: { type: 'string', pattern: `^(none|${ID.pattern.slice(1, -1)})$`, patternHint: 'must be a sales rep id, or none', description: 'Only this sales rep, or "none" for sales without a rep.' },
    transaction_type: { type: 'string', enum: TXN_TYPES, description: 'Only this kind of transaction.' },
    amount_min: { ...MONEY, description: 'Only transactions of at least this amount.' },
    amount_max: { ...MONEY, description: 'Only transactions of at most this amount.' },
    cleared: { type: 'string', enum: ['any', 'cleared', 'uncleared'], description: 'Only cleared, or only uncleared, bank lines.' },
    memo: { type: 'string', maxLength: 200, description: 'Only transactions whose memo contains this text.' },
    number: { type: 'string', maxLength: 100, description: 'Only transactions whose number contains this text (a serial or lot number on that report).' },
    sort_by: { type: 'string', enum: ['date', 'num', 'name', 'amount', 'account', 'type', 'memo'], description: 'Sort the transactions by this (default date).' },
    sort_dir: { type: 'string', enum: ['asc', 'desc'], description: 'Sort order (default asc).' },
    subtotal_by: { type: 'string', enum: ['none', 'account', 'name', 'type', 'month', 'class'], description: 'Group and subtotal the transactions by this; none for one flat list.' },
    view: { type: 'string', enum: ['summary', 'detail'], description: 'Summary (default) or every entry.' },
    vehicle: { type: 'string', maxLength: 100, description: 'Only this vehicle (list_other with list vehicles).' },
    days_per_column: { type: 'integer', minimum: 1, maximum: 365, description: 'Aging: days in each aging column (default 30).' },
    through_days: { type: 'integer', minimum: 1, maximum: 3650, description: 'Aging: the last aging column, in days past due (default 90).' },
    age_from: { type: 'string', enum: ['due_date', 'transaction_date'], description: 'Aging: count days from the due date or the transaction date (default: the company preference).' },
    more_than_days_past_due: { type: 'integer', minimum: 0, maximum: 3650, description: 'Only items more than this many days past due.' },
    forecast_by: { type: 'string', enum: ['week', 'month'], description: 'Cash flow forecast: one column per week (default) or per month.' },
  },
};

/**
 * The query of GET /api/reports/std/[report] for one report, from the tool's options. An option
 * the report does not take is refused, never quietly dropped: a filter the agent thinks is on
 * would give it a wrong answer.
 * @param {string} key @param {Record<string, unknown> | undefined} options
 * @returns {Record<string, string>}
 */
export function reportQuery(key, options) {
  const entry = BY_KEY.get(key);
  if (!entry) throw new ToolError(`There is no report "${key}". Use list_reports to find its key.`);
  const given = Object.entries(options ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  const takes = optionsOf(entry);
  const extra = given.map(([k]) => k).filter((k) => !takes.includes(k));
  if (extra.length) {
    throw new ToolError(
      `The ${entry.title} report does not take ${extra.join(', ')}. ${takes.length ? `It takes: ${takes.join(', ')}.` : 'It takes no options.'} list_reports shows each report's options.`,
    );
  }
  const has = (/** @type {string} */ k) => given.some(([g]) => g === k);
  if (has('period') && (has('date_from') || has('date_to') || has('as_of'))) throw new ToolError('Give either "period" or dates (date_from / date_to, or as_of), not both.');
  /** @type {Record<string, string>} */
  const query = {};
  for (const [k, v] of given) query[REPORT_OPTION_PARAMS[/** @type {keyof typeof REPORT_OPTION_PARAMS} */ (k)]] = String(v);
  return query;
}

// ---------------------------------------------------------------------------
// Running a report through the door
// ---------------------------------------------------------------------------

const MAX_ROWS = { type: 'integer', minimum: 1, maximum: 2000, description: 'Most rows to return (default 300). The answer says when it was cut.' };
const KEY = { type: 'string', enum: REPORT_KEYS, description: 'The report, by its key from list_reports (for example "profit-loss", "ar-aging-summary" or "general-ledger").' };
const OTHER_READS =
  '1099s, paystubs, the audit trail, the transaction log and why a number changed are not standard reports: find_operations finds them ("1099", "paystub", "audit trail", "transaction log", "why changed").';

/**
 * Read through the door. A read usually runs at once and needs no request id, so these tools take
 * none (a tool that only looks takes neither dry_run nor request_id). But an Admin can set reading
 * reports to Ask (a class or area override): the door then files the read for a person, and asks
 * for a request id and a reason as it does for a change (lib/agent/operate.ts change). That answer
 * would send the agent to an argument these tools do not have, so it is turned into the way that
 * works: run_operation, which takes both, with the same input. It is told from any other error by
 * the door's own answer to the same read as a dry run (write-tools.mjs askedReadCheck), not by the
 * words of the error. `instead` says how to send the input; `collect` what wait_for_decision gives.
 * @param {any} client
 * @param {Parameters<typeof runOperation>[1]} req
 * @param {string} instead
 * @param {string} collect
 */
async function readThroughDoor(client, req, instead, collect) {
  try {
    return await runOperation(client, req);
  } catch (err) {
    const tried = await askedReadCheck(err, () => runOperation(client, { ...req, dryRun: true }));
    if (!tried) throw err;
    // Read after all (the first error passed), or refused: answered as either is.
    if (tried.outcome !== 'dry_run') return tried;
    throw new ToolError(
      `A person must approve this read before you see it, and this tool cannot ask for that. Ask with run_operation instead: operation "${req.operation}", ${instead}, a request_id of your own and a reason. Then call wait_for_decision with the request_id it gives: once a person approves it, ${collect}.`,
    );
  }
}

/** The input of a run_operation request, in its own words, for the message above. */
const inputWords = (/** @type {Record<string, unknown>} */ input) =>
  Object.entries(input)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k} ${JSON.stringify(v)}`)
    .join(', ');

/**
 * Run one standard report: the door's answer, and the report itself when it was read. Anything
 * but a read (refused, or asked) comes back as the door's answer, shaped like run_operation's.
 * @returns {Promise<{ report: any } | { answer: Record<string, unknown> }>}
 */
async function readReport(/** @type {any} */ client, /** @type {string} */ key, /** @type {any} */ options) {
  const req = { operation: 'reports.std.get', params: { report: key }, query: reportQuery(key, options) };
  const answer = await readThroughDoor(
    client,
    req,
    inputWords({ params: req.params, query: Object.keys(req.query).length ? req.query : undefined }),
    'it gives you the report as run_report does',
  );
  if (answer?.outcome !== 'read') return { answer: fit(settle(answer, { fields: [] })) };
  const report = answer.result;
  if (!report || typeof report !== 'object' || !Array.isArray(report.columns)) throw new ToolError('Ironbooks answered without a report. Try again; if it keeps happening, tell the person.');
  return { report };
}

const DRILL_HINT = 'report_drilldown with this key, the same options, a row_id and a money column\'s key lists the transactions behind that amount.';

/**
 * One report as run_report gives it: the key, the compact report (shapeReport), and for a report
 * whose amounts can be drilled, each row's id, each column's key and how to drill.
 * @param {string} key @param {any} report @param {number | undefined} maxRows
 */
export function compactReport(key, report, maxRows) {
  const drill = DRILLDOWN_KEYS.includes(key);
  return { key, ...shapeReport(report, maxRows, { ids: drill }), ...(drill ? { drilldown: DRILL_HINT } : {}) };
}

/**
 * The transactions behind one report amount as report_drilldown gives them (lib/reports/drilldown.ts
 * DrillResult made into the tools' words). `key`: the report, when the answer does not name it.
 * @param {any} d @param {string} key
 */
export function compactDrilldown(d, key) {
  const list = Array.isArray(d?.transactions) ? d.transactions.map(drillRow) : [];
  const notes = [];
  if (d.incomplete) notes.push('There are too many transactions to add up here: the count and total do not cover everything. Run it again with a shorter date range.');
  else if (d.ties === false) notes.push('The transactions do not add up to the amount shown: the books changed between the two reads. Run the report again.');
  if (d.listTruncated) notes.push(`Only the first ${list.length} of ${d.count} transactions are listed. Raise max_transactions, or narrow the dates, to see more.`);
  return {
    report: d.report ?? key,
    line: d.rowLabel ?? null,
    column: d.columnLabel ?? null,
    ...(d.scope ? { scope: d.scope } : {}),
    ...(d.basis ? { basis: d.basis } : {}),
    amount_shown: d.cell ?? null,
    ...(d.kind === 'formula' && d.formula ? { worked_out_as: d.formula } : {}),
    total: d.total ?? null,
    count: d.count ?? list.length,
    ...(d.largest ? { largest: drillRow(d.largest) } : {}),
    ...(d.explanation ? { explanation: d.explanation } : {}),
    transactions: list,
    ...(notes.length ? { notes } : {}),
  };
}

const isObject = (/** @type {unknown} */ v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** A report as the route answers it (lib/reports/types.ts StdReport), not yet made compact. */
function rawReport(/** @type {any} */ v) {
  return isObject(v) && !('row_count' in v) && Array.isArray(v.columns) && Array.isArray(v.rows) && !v.rows.some((/** @type {any} */ r) => Array.isArray(r?.cells));
}

/** A drill-down as the route answers it (lib/reports/drilldown.ts), not yet in the tools' words. */
function rawDrilldown(/** @type {any} */ v) {
  return isObject(v) && Array.isArray(v.transactions) && !('amount_shown' in v);
}

/** A report already made compact (shapeReport). */
function compactShape(/** @type {any} */ v) {
  return isObject(v) && typeof v.row_count === 'number' && Array.isArray(v.rows);
}

/** A drill-down already in the tools' words (compactDrilldown). */
function compactDrillShape(/** @type {any} */ v) {
  return isObject(v) && 'amount_shown' in v && Array.isArray(v.transactions);
}

/** The connector held the answer to its size limit and cut its result (operations-tools.mjs holdToLimit). */
const resultCut = (/** @type {any} */ answer) => isObject(answer.cut_short) && typeof answer.cut_short.result === 'string';

const SEE_THE_REST = 'To see the rest, run it again with a shorter date range or a filter.';

/**
 * A collected report that was cut to fit one answer, saying so inside the result as run_report
 * says it: `truncated`, and a note. When the report was made compact before it was held
 * (mcp/tools.mjs collectingClient), row_count is the report's own and the note names how many of
 * them are shown. `heldFirst`: it was held while still raw (its rows halved before they were
 * counted), so the report's real count is not known any more, and the note says that row_count
 * counts only the rows shown. Marked once: a result already marked is handed back as it is.
 */
function markCutReport(/** @type {any} */ r, /** @type {boolean} */ heldFirst) {
  if (r.truncated === true) return r;
  const shown = r.rows.length;
  const why = 'the whole report was too long for one answer';
  const note = heldFirst
    ? `Part of the report was left out (${why}), so row_count counts only the ${shown} rows shown. ${SEE_THE_REST}`
    : shown < r.row_count
      ? `Showing the first ${shown} of ${r.row_count} rows: ${why}. ${SEE_THE_REST}`
      : `Part of the report was left out: ${why}. ${SEE_THE_REST}`;
  return { ...r, truncated: true, notes: [...(Array.isArray(r.notes) ? r.notes : []), note] };
}

/** The same for a drill-down whose list of transactions was cut to fit one answer. */
function markCutDrill(/** @type {any} */ d) {
  if (d.truncated === true) return d;
  const note = `Only ${d.transactions.length} of the transactions are listed here: the whole list was too long for one answer. The count and the total still cover all of them. ${SEE_THE_REST}`;
  return { ...d, truncated: true, notes: [...(Array.isArray(d.notes) ? d.notes : []), note] };
}

/**
 * A report read a person approved, as the agent collects it: wait_for_decision's request, the
 * request's resource, or run_operation sent again with the request id it was asked under. The
 * result is made what run_report (or report_drilldown) would have given, had the read run at once,
 * so the agent reads one shape whichever way the report came. Every row the answer still holds is
 * kept. mcp/tools.mjs makes the result compact as it arrives, before operations-tools.mjs holds the
 * answer to the connector's size limit, so the limit is spent on compact rows and row_count stays
 * the report's own; this runs again on the held answer, where it only says what the limit cut
 * (`truncated` and a note in the result, beside the answer's own cut_short). Anything else is
 * handed back as it is.
 * @param {any} answer  a request view (lib/agent/contract.ts AgentRequestView), or a shaped answer or request (mcp/operations-tools.mjs)
 * @param {string} [operation]  the operation, when the answer does not name it (run_operation's)
 */
export function compactCollected(answer, operation) {
  if (!isObject(answer)) return answer;
  const op = typeof answer.operation === 'string' ? answer.operation : operation;
  const result = answer.result;
  const cut = resultCut(answer);
  if (op === 'reports.std.get' && rawReport(result)) {
    // A key this copy of the catalog does not know yet is kept, without the drill-down parts.
    const key = typeof result.key === 'string' && result.key ? result.key : null;
    const rows = Math.max(1, result.rows.length);
    const shaped = key ? compactReport(key, result, rows) : shapeReport(result, rows);
    return { ...answer, result: cut ? markCutReport(shaped, true) : shaped };
  }
  if (op === 'reports.std.get' && cut && compactShape(result)) return withResult(answer, markCutReport(result, false));
  if (op === 'reports.drilldown.get' && rawDrilldown(result)) {
    const shaped = compactDrilldown(result, typeof result.report === 'string' ? result.report : 'Report');
    return { ...answer, result: cut ? markCutDrill(shaped) : shaped };
  }
  if (op === 'reports.drilldown.get' && cut && compactDrillShape(result)) return withResult(answer, markCutDrill(result));
  return answer;
}

/** The answer with another result, or the answer itself when the result is the same. */
const withResult = (/** @type {any} */ answer, /** @type {unknown} */ result) => (result === answer.result ? answer : { ...answer, result });

/** The rows of a report as its Excel and PDF files show them (lib/reports/types.ts reportToTable). */
export function reportTable(/** @type {any} */ report) {
  const columns = (Array.isArray(report?.columns) ? report.columns : []).map((/** @type {any} */ c) => ({
    header: String(c.header ?? c.key ?? '').slice(0, 120),
    numeric: c.type === 'money' || c.type === 'number' || c.type === 'percent',
  }));
  const rows = (Array.isArray(report?.rows) ? report.rows : [])
    .filter((/** @type {any} */ r) => r && r.kind !== 'spacer')
    .map((/** @type {any} */ r) =>
      report.columns.map((/** @type {any} */ c, /** @type {number} */ i) => {
        const v = r.cells?.[c.key] ?? null;
        if (i === 0 && typeof v === 'string') return `${'  '.repeat(Math.max(0, r.depth ?? 0))}${v}`;
        return typeof v === 'string' || typeof v === 'number' ? v : v === null ? null : String(v);
      }),
    );
  return { columns, rows };
}

/** The most rows and columns POST /api/export/reports takes. */
export const EXPORT_MAX_ROWS = 50_000;
export const EXPORT_MAX_COLUMNS = 64;

const FORMAT_WORDS = { pdf: 'a PDF', xlsx: 'an Excel (.xlsx) file' };

/** One transaction behind a report amount, in the tools' words (lib/reports/drilldown.ts DrillTransaction). */
function drillRow(/** @type {any} */ t) {
  return {
    date: t.date,
    type: t.type || null,
    number: t.num || null,
    name: t.name || null,
    memo: t.memo || null,
    account: t.account || null,
    amount: t.amount,
    ...(t.entryId ? { journal_entry_id: t.entryId } : {}),
    ...(t.sourceRef ? { source: t.sourceRef } : {}),
  };
}

/** @type {import('./protocol.mjs').Tool[]} */
export const REPORT_TOOLS = [
  {
    name: 'list_reports',
    title: 'Find a report',
    description: `Every standard report Ironbooks has (about 100, as in the Report Center), with its key, what it shows, its group, and the options it takes. Search by words ("aging", "sales by", "inventory") or by group. Then run_report with the key. ${OTHER_READS}`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', maxLength: 100, description: 'Words to look for in the report\'s key, title and description. Every word must match.' },
        group: { type: 'string', enum: REPORT_GROUPS, description: 'Only reports of this Report Center group.' },
      },
    },
    handler: async (a) => {
      const words = String(a.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const rows = REPORTS.filter((r) => !a.group || r.group === a.group)
        .filter((r) => words.every((w) => `${r.key} ${r.title} ${r.about} ${r.group}`.toLowerCase().includes(w)))
        .map((r) => {
          const options = optionsOf(r);
          return {
            key: r.key,
            title: r.title,
            group: r.group,
            shows: r.about,
            options: options.length ? options : 'none',
            ...(DRILLDOWN_KEYS.includes(r.key) ? { drilldown: true } : {}),
            ...(r.needs ? { needs: NEEDS_WORDS[/** @type {keyof typeof NEEDS_WORDS} */ (r.needs)] ?? r.needs } : {}),
          };
        });
      return {
        count: rows.length,
        reports: rows,
        next: rows.length
          ? 'run_report with a key and the options it takes. drilldown true: report_drilldown can list the transactions behind any of its amounts.'
          : 'Nothing matched. Try fewer or other words, or leave out the group.',
        other: OTHER_READS,
      };
    },
  },
  {
    name: 'run_report',
    title: 'Run a report',
    description: `Run any standard report by its key (list_reports finds it), with the options that report takes: a named period or dates (or an as-of date), cash or accrual basis, columns by month, quarter or year, a comparison, and filters (class, account, customer, vendor, item, transaction type, amount …). The answer is compact: the column headers once, then each row as its cells, with a row_id and the columns' keys for report_drilldown, and a journal_entry_id on transaction rows for get_journal_entry. Profit & Loss, Balance Sheet, Trial Balance, General Ledger and the agings also have named tools (report_*). Social Security numbers in employee-contact-list and voided-deleted-detail stay masked; to see them in full, a person must approve it: run_operation with operation "reports.std.get", reveal true and a reason. If a person must approve reading the report itself, the answer says how to ask for it with run_operation; once approved, wait_for_decision gives the report in this same compact shape. ${OTHER_READS}`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['key'],
      properties: { key: KEY, options: REPORT_OPTIONS, max_rows: MAX_ROWS },
    },
    handler: async (a, c) => {
      const got = await readReport(c, a.key, a.options);
      if ('answer' in got) return got.answer;
      return fit(compactReport(a.key, got.report, a.max_rows));
    },
  },
  {
    name: 'report_drilldown',
    title: 'Transactions behind a report amount',
    description:
      'The transactions behind one amount of a report (QuickZoom): give the report key, the same options you ran it with, the row_id of the line and the key of the column, both from run_report. The answer says how many transactions there are, their total, the largest, and lists them (newest last) with their journal_entry_id. Works for the Profit & Loss and Balance Sheet reports, the Trial Balance, the General Ledger, the A/R and A/P agings, open invoices, collections, and the sales and expense summaries (list_reports marks them drilldown). If a person must approve reading it, the answer says how to ask for it with run_operation; once approved, wait_for_decision gives the transactions in this same shape.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['key', 'row_id', 'column'],
      properties: {
        key: { type: 'string', enum: DRILLDOWN_KEYS, description: 'The report (one list_reports marks drilldown).' },
        row_id: { type: 'string', maxLength: 300, description: 'The row_id of the line, from run_report.' },
        column: { type: 'string', pattern: '^[A-Za-z0-9_.:-]{1,60}$', patternHint: 'must be a column key from run_report', description: 'The key of the money column, from run_report\'s columns.' },
        options: { ...REPORT_OPTIONS, description: 'The same options you gave run_report, so the line means the same thing.' },
        max_transactions: { type: 'integer', minimum: 1, maximum: 5000, description: 'Most transactions to list (default 200). The count and the total always cover all of them.' },
      },
    },
    handler: async (a, c) => {
      const query = { ...reportQuery(a.key, a.options), row: a.row_id, col: a.column, limit: String(a.max_transactions ?? 200) };
      const req = { operation: 'reports.drilldown.get', params: { report: a.key }, query };
      const answer = await readThroughDoor(c, req, inputWords({ params: req.params, query }), 'it gives you the transactions as report_drilldown does');
      if (answer?.outcome !== 'read') return fit(settle(answer, { fields: [] }));
      return fit(compactDrilldown(answer.result ?? {}, a.key));
    },
  },
  {
    name: 'export_report',
    title: 'Report as a PDF or Excel file',
    description:
      'Make a standard report into a PDF or an Excel (.xlsx) file, the same file the report window\'s own buttons make, with the options run_report takes. Nothing in the books changes. The answer gives a file_id: get_file reads it, and save_file saves it in a folder you may use (a person approves each save). If a person must approve reading the report or making the file, the answer says how to ask for it with run_operation; once approved, wait_for_decision gives the file_id. To send it to someone, find_operations "email" shows what can be emailed.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['key', 'format'],
      properties: {
        key: KEY,
        format: { type: 'string', enum: ['pdf', 'xlsx'], description: 'pdf, or xlsx for Excel.' },
        options: REPORT_OPTIONS,
        title: { type: 'string', minLength: 1, maxLength: 200, description: "The title printed on the file. Default: the report's own title." },
        landscape: { type: 'boolean', description: 'PDF only: print it sideways. Default: sideways when it has more than 6 columns.' },
      },
    },
    handler: async (a, c) => {
      const got = await readReport(c, a.key, a.options);
      if ('answer' in got) return got.answer;
      const report = got.report;
      const table = reportTable(report);
      if (!table.columns.length) throw new ToolError('That report has no columns to put in a file.');
      if (table.columns.length > EXPORT_MAX_COLUMNS) throw new ToolError(`That report has ${table.columns.length} columns; a file holds at most ${EXPORT_MAX_COLUMNS}. Use fewer columns (columns "total", or a shorter date range).`);
      if (table.rows.length > EXPORT_MAX_ROWS) throw new ToolError(`That report has ${table.rows.length} rows; a file holds at most ${EXPORT_MAX_ROWS}. Use a shorter date range or a filter.`);
      // A title of only spaces is no title: the file's own check (title at least 1 character)
      // would refuse it, so the report's title is used instead.
      const own = typeof a.title === 'string' && a.title.trim() ? a.title.trim() : null;
      const title = String(own ?? report.title ?? BY_KEY.get(a.key)?.title ?? a.key).slice(0, 200);
      const body = {
        format: a.format,
        filename: a.key,
        title,
        ...(report.subtitle ? { subtitle: String(report.subtitle).slice(0, 300) } : {}),
        columns: table.columns,
        rows: table.rows,
        ...(a.format === 'pdf' && typeof a.landscape === 'boolean' ? { landscape: a.landscape } : {}),
      };
      // The rows are too many to repeat in a message: describe_operation says how to send them.
      const answer = await readThroughDoor(
        c,
        { operation: 'export.reports', body },
        'with the body describe_operation shows for it (the format, a title, and the report\'s columns and rows in the shape it shows)',
        'it gives you the file_id of the file it made',
      );
      if (answer?.outcome !== 'read') return fit(settle(answer, { fields: [] }));
      const f = answer.file;
      if (!f || !f.fileId) throw new ToolError('Ironbooks ran the report but did not make the file. Try again; if it keeps happening, tell the person.');
      return {
        outcome: 'read',
        said: `Ironbooks made ${FORMAT_WORDS[/** @type {keyof typeof FORMAT_WORDS} */ (a.format)]} of the report "${title}". Nothing in the books changed.`,
        report: title,
        ...(report.subtitle ? { subtitle: report.subtitle } : {}),
        ...(report.range ? { period: report.range } : {}),
        row_count: table.rows.length,
        ...(report.truncated ? { note: 'Ironbooks cut this report short, so the file is too. Use a shorter date range or a filter.' } : {}),
        file: { file_id: f.fileId, name: f.name, type: f.type, size: f.size },
        next: `Call get_file with file_id "${f.fileId}" to read it, or save_file to save it in a folder you may use (a person approves each save). The file is kept for 24 hours.`,
      };
    },
  },
];
