/**
 * QuickBooks Enterprise-style ACTIVITIES (Users & Roles > Edit Role: Area and Activity tree).
 *
 * Each of the 18 permission AREAS (lib/permissions/model.ts) is split into the activities QB
 * shows under it — Customers & Receivables has Invoices, Receive Payments, Statements, Credit
 * Memos… as separate rows — and each activity has its own access level: View plus Create,
 * Modify, Delete, Print and (where QB has it) View Balance.
 *
 * Every activity belongs to exactly one area, and every route and page that used to need an area
 * now needs one of that area's activities (lib/permissions/routeActivities.ts). That is what keeps
 * existing roles exact on upgrade: a role stored the old way ("Customers & Receivables: view,
 * create") is read as that access on EVERY activity of the area (model.ts normalizeActivities),
 * so each route allows exactly the people it allowed before. View Balance is granted wherever an
 * old-style role could view, because before this change everybody who could view saw balances.
 *
 * Pure module (no DB / Node imports): shared by the server checks, the role editor and the nav.
 */
import type { Action, Area } from './model';

/** The extra QB right that shows account and name balances (registers, centers, the chart of accounts). */
export const VIEW_BALANCE = 'view_balance' as const;
export type ActivityAction = Action | typeof VIEW_BALANCE;
export const ACTIVITY_ACTIONS: readonly ActivityAction[] = ['view', 'create', 'modify', 'delete', 'print', VIEW_BALANCE];

export interface ActivityDef {
  /** "<area>.<activity>", e.g. 'customers.invoices'. */
  key: string;
  area: Area;
  label: string;
  description: string;
  /** Rights this activity has besides View (which every activity has). */
  actions: Exclude<Action, 'view'>[];
  /** Has QB's View Balance right (balances are hidden without it). */
  viewBalance?: boolean;
}

const C = 'create' as const;
const M = 'modify' as const;
const D = 'delete' as const;
const P = 'print' as const;

function act(
  area: Area,
  id: string,
  label: string,
  description: string,
  actions: Exclude<Action, 'view'>[],
  viewBalance = false,
): ActivityDef {
  return { key: `${area}.${id}`, area, label, description, actions, ...(viewBalance ? { viewBalance: true } : {}) };
}

export const ACTIVITIES = [
  // ---- Banking ----
  act('banking', 'write_checks', 'Write Checks & Expenses', 'Checks, credit card charges, cash and EFT expenses', [C, M, D, P]),
  act('banking', 'deposits', 'Make Deposits', 'Deposits, Undeposited Funds', [C, M, D, P]),
  act('banking', 'registers', 'Use Register', 'Open account registers and enter transactions in them', [C, M, D, P], true),
  act('banking', 'bank_accounts', 'Bank Accounts', 'Bank and credit card accounts list and their balances', [C, M, D, P], true),
  act('banking', 'bank_feeds', 'Bank Feeds', 'Import statements, match, add and exclude downloaded lines', [C, M, D, P]),
  act('banking', 'bank_rules', 'Bank Rules', 'Rules that categorize downloaded bank lines', [C, M, D]),
  act('banking', 'print_checks', 'Print Checks', 'Check print queue, check layouts and printer set-up', [C, M, P]),
  act('banking', 'loans', 'Loan Manager', 'Loans and loan payments', [C, M, D]),
  // ---- Lists / Centers ----
  act('lists', 'chart_of_accounts', 'Chart of Accounts', 'See the chart of accounts (editing it is under Sensitive Accounting)', [P], true),
  act('lists', 'items', 'Item List', 'Items, prices, barcodes, assembly components', [C, M, D, P]),
  act('lists', 'classes', 'Class List', 'Classes for class tracking', [C, M, D]),
  act('lists', 'locations', 'Locations', 'Location list', [C, M, D]),
  act('lists', 'price_levels', 'Price Levels & Price Rules', 'Price levels and advanced price rules', [C, M, D]),
  act('lists', 'type_lists', 'Customer & Vendor Types', 'Customer type and vendor type lists', [C, M, D]),
  act('lists', 'other_lists', 'Other Lists', 'Terms, Ship Via, payment methods, customer messages, Other Names, job types, vehicles', [C, M, D, P]),
  act('lists', 'memorized', 'Memorized Transactions', 'Memorized (recurring) transaction list', [C, M, D]),
  act('lists', 'fixed_assets', 'Fixed Asset Items', 'Fixed asset item list', [C, M, D]),
  act('lists', 'sales_reps', 'Sales Reps', 'Sales rep list', [C, M, D]),
  act('lists', 'doc_center', 'Doc Center & Receipts', 'Documents, receipt capture and phone upload links', [C, M, D]),
  act('lists', 'custom_fields', 'Custom Fields', 'Custom field definitions and values', [M]),
  act('lists', 'currencies', 'Currency List', 'Currencies and exchange rates', [C, M]),
  act('lists', 'letters', 'Letter Templates', 'Letter and label templates', [C, M, D]),
  act('lists', 'billing_rates', 'Billing Rate Levels', 'Billing rate levels for time', [C, M, D]),
  act('lists', 'uom', 'Units of Measure', 'Unit of measure sets', [C, M, D]),
  act('lists', 'merge', 'Merge Entries', 'Merge two list entries into one', [D]),
  // ---- Customers & Receivables ----
  act('customers', 'center', 'Customer Center', 'Customers and jobs, their notes and balances', [C, M, D, P], true),
  act('customers', 'leads', 'Lead Center', 'Leads (prospects) and converting them to customers', [C, M, D]),
  act('customers', 'invoices', 'Invoices', 'Invoices, packing slips, retainage, invoice reminders', [C, M, D, P]),
  act('customers', 'batch_invoicing', 'Batch Invoicing', 'Create many invoices at once', [C]),
  act('customers', 'estimates', 'Estimates', 'Estimates and estimate follow-up', [C, M, D, P]),
  act('customers', 'sales_orders', 'Sales Orders', 'Sales orders and back orders', [C, M, D, P]),
  act('customers', 'fulfillment', 'Sales Order Fulfillment', 'Fulfillment worksheet, pick lists, packing slips', [C, P]),
  act('customers', 'sales_receipts', 'Sales Receipts', 'Sales receipts', [C, M, D, P]),
  act('customers', 'payments', 'Receive Payments', 'Customer payments, discounts and credits applied to invoices', [C, M, D, P]),
  act('customers', 'credit_memos', 'Credit Memos & Refunds', 'Credit memos and customer refunds', [C, M, D, P]),
  act('customers', 'statements', 'Statements', 'Create, print and email customer statements', [P]),
  act('customers', 'statement_charges', 'Statement Charges', 'Statement charges', [C, M, D]),
  act('customers', 'finance_charges', 'Assess Finance Charges', 'Assess finance charges on overdue balances', [C]),
  act('customers', 'income_tracker', 'Income Tracker', 'Income Tracker and its batch actions', [C]),
  act('customers', 'collections', 'Collections Center', 'Collections Center and collection notes', [C, M]),
  act('customers', 'pricing', 'Customer Pricing', 'Special prices per customer and price quotes', [C, M, D]),
  act('customers', 'time_billing', 'Invoice for Time & Costs', 'Add billable time and costs to invoices', [C]),
  act('customers', 'write_off', 'Write Off Invoices', 'Write off small open balances', [C]),
  act('customers', 'send_forms', 'Print & Send Forms (batch)', 'The "To be printed" and "To be emailed" queues', [P]),
  // ---- Vendors & Payables ----
  act('vendors', 'center', 'Vendor Center', 'Vendors, their notes, types and balances', [C, M, D, P], true),
  act('vendors', 'bills', 'Enter Bills', 'Bills and duplicate bill warnings', [C, M, D, P]),
  act('vendors', 'pay_bills', 'Pay Bills', 'Bill payments', [C, M, D, P]),
  act('vendors', 'vendor_credits', 'Vendor Credits', 'Vendor credits', [C, M, D, P]),
  act('vendors', 'purchase_orders', 'Purchase Orders', 'Purchase orders, including POs from the reorder list', [C, M, D, P]),
  act('vendors', 'receive_bill', 'Receive Items & Enter Bill', 'Bill received items against purchase orders', [C]),
  act('vendors', 'expense_reports', 'Expense Reports', 'Employee expense reports', [C, M]),
  act('vendors', 'tax_1099', '1099 Set-up', 'Map accounts to 1099 boxes', [M]),
  // ---- Employees & Payroll ----
  act('payroll', 'employees', 'Employee Center', 'Employees and their portal passwords', [C, M, D, P]),
  act('payroll', 'payroll_items', 'Payroll Items', 'Payroll item list', [C, M, D]),
  act('payroll', 'paychecks', 'Pay Employees', 'Paychecks, pay runs and paycheck printing', [C, M, D, P]),
  act('payroll', 'liabilities', 'Pay Payroll Liabilities', 'Payroll liability payments', [C, M, D]),
  act('payroll', 'adjustments', 'Adjust Payroll Liabilities', 'Liability adjustments', [C, D]),
  act('payroll', 'setup', 'Payroll Set-up', 'State settings, workers comp and accruals', [C, M, D]),
  act('payroll', 'paystubs', 'Pay Stubs', 'Print pay stubs', [P]),
  // ---- Inventory ----
  act('inventory', 'adjust', 'Adjust Quantity / Value on Hand', 'Inventory adjustments and physical counts', [C, M]),
  act('inventory', 'center', 'Inventory Center', 'Inventory Center and reorder list', [C, M]),
  act('inventory', 'item_receipts', 'Receive Items', 'Item receipts', [C, M]),
  act('inventory', 'assemblies', 'Build Assemblies', 'Assemblies and pending builds', [C, M]),
  act('inventory', 'sites', 'Inventory Sites & Bins', 'Sites, bins, reorder points per site', [C, M]),
  act('inventory', 'transfers', 'Transfer Inventory', 'Inventory transfers between sites', [C, M]),
  act('inventory', 'landed_cost', 'Landed Cost', 'Landed cost', [C, M]),
  act('inventory', 'fifo', 'FIFO Cost Layers', 'FIFO cost layers', [C]),
  // ---- Sales Tax ----
  act('sales_tax', 'codes', 'Sales Tax Items & Agencies', 'Sales tax codes, rates, components and agencies', [C, M]),
  act('sales_tax', 'pay', 'Pay Sales Tax', 'Sales tax payments', [C, D]),
  act('sales_tax', 'adjust', 'Adjust Sales Tax Due', 'Sales tax adjustments and fixes', [C, M]),
  act('sales_tax', 'reports', 'Sales Tax Reports', 'Sales tax liability and revenue summary', []),
  // ---- Time & Mileage ----
  act('time', 'timesheets', 'Timesheets', 'Time entries and billing rates', [C, M, D]),
  act('time', 'mileage', 'Mileage', 'Vehicle mileage', [C, D]),
  // ---- Reports ----
  act('reports_financial', 'company', 'Company & Financial', 'P&L, balance sheet, cash flow, budgets vs actual, the Home snapshot', [P]),
  act('reports_financial', 'accountant', 'Accountant & Taxes', 'Trial balance, general ledger, transaction detail, voided/deleted', [P]),
  act('reports_financial', 'banking', 'Banking Reports', 'Check detail, deposit detail, missing checks', [P]),
  act('reports_financial', 'custom', 'Custom Reports & Find', 'Report builder, pivot, Find', [P]),
  act('reports_financial', 'audit', 'Audit Trail & Transaction Log', 'Audit trail and the running transaction log', [P]),
  act('reports_financial', 'ai_assistant', 'Ask the AI Assistant', 'Questions answered from read-only reports', []),
  act('reports_sales', 'receivables', 'Customers & Receivables', 'A/R aging, open invoices, collections, customer statements', [P]),
  act('reports_sales', 'sales', 'Sales', 'Sales by customer / item / rep, commissions', [P]),
  act('reports_purchases', 'payables', 'Vendors & Payables', 'A/P aging', [P]),
  act('reports_purchases', 'purchases', 'Purchases', 'Purchases by vendor / item', [P]),
  act('reports_purchases', 'tax_1099', '1099 Reports', '1099 summary, PDF and e-file', [P]),
  act('reports_payroll', 'payroll', 'Payroll Reports', 'Payroll summary, state wage worksheet', [P]),
  act('reports_payroll', 'tax_forms', 'Payroll Tax Forms', 'W-2, W-3, 940, 941', [P]),
  act('reports_inventory', 'valuation', 'Inventory Valuation', 'Inventory valuation summary and detail', [P]),
  act('reports_inventory', 'stock', 'Stock Status & Worksheets', 'Stock status, physical inventory worksheet, site reports', [P]),
  // ---- Sensitive Accounting ----
  act('accounting', 'journal_entries', 'Make General Journal Entries', 'Journal entries, adjusting entries, reversals', [C, M, D, P]),
  act('accounting', 'transfers', 'Transfer Funds', 'Transfers between accounts', [C, M, D]),
  act('accounting', 'reconcile', 'Reconcile', 'Reconcile, undo a reconciliation, reconciliation reports', [C, M, D, P]),
  act('accounting', 'chart_of_accounts', 'Edit Chart of Accounts', 'Add, edit and delete accounts; tax lines; account currency', [C, M, D]),
  act('accounting', 'accountant_tools', 'Accountant Center Tools', 'Reclassify, batch enter, batch void, working trial balance, client data review', [C, M, D]),
  act('accounting', 'error_check', 'Find & Fix Errors', 'Error detection and fixes', [C, M]),
  act('accounting', 'month_end', 'Month-End Close', 'Month-end checklist and scans', [C, M]),
  act('accounting', 'currency_adjust', 'Home Currency Adjustments', 'Exchange-rate gain/loss adjustments', [C, D]),
  act('accounting', 'accountants_copy', "Accountant's Copy Changes", "Review and import an accountant's changes", [C, M]),
  act('accounting', 'ai_proposals', 'AI Proposals', 'Approve journal entries proposed by the AI', [C]),
  act('accounting', 'memorized_run', 'Enter Memorized Transactions', 'Enter memorized transactions that are due', [C]),
  act('accounting', 'depreciation', 'Fixed Asset Depreciation', 'Post fixed asset depreciation', [C]),
  // ---- Company & Preferences ----
  act('company', 'preferences', 'Company Information & Preferences', 'Company information and every company preference', [M]),
  act('company', 'budgets', 'Budgets', 'Budgets and forecasts', [C, M]),
  act('company', 'templates', 'Form Templates', 'Invoice and other form templates, logos', [C, M, D]),
  act('company', 'doc_numbers', 'Document Numbers', 'Starting numbers for forms', [M]),
  act('company', 'ai', 'AI & Automation Settings', 'AI providers, keys and routing', [M]),
  act('company', 'network', 'Privacy & Network', 'What may leave this computer', [M]),
  act('company', 'send_forms', 'Send Forms (email set-up)', 'Mail server, sender addresses and the Test button', [M]),
  // ---- Closing Date / Periods ----
  act('closing', 'closing_date', 'Set Closing Date & Password', 'Closing date, its password, closing date exceptions', [M]),
  act('closing', 'fiscal_periods', 'Fiscal Periods', 'Close and reopen fiscal periods', [M]),
  act('closing', 'year_end', 'Year-End Close', 'Year-end close', [M]),
  // ---- Users & Roles ----
  act('users', 'users', 'Users', 'Add, edit, deactivate users; reset passwords', [C, M]),
  act('users', 'roles', 'Roles', 'Create, edit, clone and delete roles', [C, M, D]),
  act('users', 'password_rules', 'Password Rules', "The file's password rules", [M]),
  act('users', 'file_password', 'Company File Password', 'The password that opens this company file', [M]),
  act('users', 'permission_reports', 'View Permissions Reports', 'Role and user permission reports', [P]),
  // ---- File Utilities ----
  act('file_utilities', 'backup', 'Back Up', 'Back up now, backup schedule and history', [C, M]),
  act('file_utilities', 'restore', 'Restore', 'Restore a backup, portable file or condensed archive', [D]),
  act('file_utilities', 'condense', 'Condense Data', 'Condense (archive) old transactions', [D]),
  act('file_utilities', 'import', 'Import', 'Import from QuickBooks and other files', [C, M]),
  act('file_utilities', 'export', 'Export & Portable Files', 'Export lists, portable company files, shareable ledger', [C, P]),
  act('file_utilities', 'accountants_copy', "Create Accountant's Copy", "Create, cancel and open Accountant's Copies and period copies", [C, M]),
  act('file_utilities', 'integrity', 'Verify & Rebuild Data', 'Verify data, rebuild, books-in-balance check', [M]),
  act('file_utilities', 'cleanup', 'Clean Up Lists', 'Clean up unused list entries', [D]),
  act('file_utilities', 'schedules', 'Scheduled Reports', 'Reports exported on a schedule', [C, M, D]),
  act('file_utilities', 'sandbox', 'Try It on a Copy', 'Practice copies of this file (sandbox)', [C, D]),
  act('file_utilities', 'single_user', 'Single-User Mode', 'Switch to single-user mode', [M]),
] as const satisfies readonly ActivityDef[];

export type ActivityKey = (typeof ACTIVITIES)[number]['key'];
export const ACTIVITY_KEYS: ActivityKey[] = ACTIVITIES.map((a) => a.key);

const BY_KEY = new Map<string, ActivityDef>(ACTIVITIES.map((a) => [a.key, a as ActivityDef]));
const BY_AREA = new Map<Area, ActivityDef[]>();
for (const a of ACTIVITIES as readonly ActivityDef[]) BY_AREA.set(a.area, [...(BY_AREA.get(a.area) ?? []), a]);

export function isActivityKey(k: unknown): k is ActivityKey {
  return typeof k === 'string' && BY_KEY.has(k);
}

export function activityDef(key: string): ActivityDef | undefined {
  return BY_KEY.get(key);
}

/** The activities of one area, in the order QB lists them. */
export function activitiesOf(area: Area): ActivityDef[] {
  return BY_AREA.get(area) ?? [];
}

/** Every right an activity can hold (View first, then its own, then View Balance). */
export function supportedActions(def: ActivityDef): ActivityAction[] {
  return ['view', ...def.actions, ...(def.viewBalance ? [VIEW_BALANCE] : [])];
}

export function activityLabel(key: string): string {
  return BY_KEY.get(key)?.label ?? key;
}

/** Plain access level for reports: None, Full, or Partial (with the letters QB prints). */
export function accessLevel(def: ActivityDef, granted: readonly string[]): 'None' | 'Full' | 'Partial' {
  if (!granted.includes('view')) return 'None';
  const all = supportedActions(def);
  return all.every((a) => granted.includes(a)) ? 'Full' : 'Partial';
}

/** QB-style short rights list: "View, Create, Modify, Print, View Balance". */
export const ACTIVITY_ACTION_LABEL: Record<ActivityAction, string> = {
  view: 'View',
  create: 'Create',
  modify: 'Modify',
  delete: 'Delete',
  print: 'Print',
  view_balance: 'View Balance',
};
