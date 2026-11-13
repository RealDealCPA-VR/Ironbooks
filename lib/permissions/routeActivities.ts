/**
 * Which ACTIVITY (lib/permissions/activities.ts) each API route and page needs.
 *
 * lib/permissions/routes.ts still says which AREA and action a route needs (that map is the
 * fail-closed list of every route); this file refines the area to one of its activities, so a
 * role can allow Invoices but not Receive Payments, or Statements without Invoices. The two maps
 * meet in `apiRuleFor` (routes.ts), and enforce.ts checks the activity.
 *
 * Keys are route PREFIXES: the longest prefix whose activity is in the rule's area wins, so
 * '/api/invoices/statement-charges' is Statement Charges while every other '/api/invoices/…'
 * route is Invoices. A value can list one activity per area (a route whose GET is Lists and whose
 * POST is Sensitive Accounting), name activities per HTTP method, or be a function of the concrete
 * path (sales forms are addressed by kind). A route with no activity of its area here is checked
 * as the WHOLE area (lib/permissions/model.ts canWholeArea) — fail closed — and
 * lib/permissions/routeActivities.test.ts fails, so new routes get mapped.
 *
 * Pure module (no Node/DB imports): also used client-side for the menus.
 */
import type { ActivityKey } from './activities';
import { activityDef } from './activities';
import type { Area } from './model';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type One = ActivityKey | ActivityKey[];
export type ActivityRef =
  | One
  | Partial<Record<Method, One>>
  | { resolve: (path: string, method: Method) => ActivityKey | null };

const SALES_FORM_ACTIVITY: Record<string, ActivityKey> = {
  invoice: 'customers.invoices',
  estimate: 'customers.estimates',
  sales_receipt: 'customers.sales_receipts',
  credit_memo: 'customers.credit_memos',
  sales_order: 'customers.sales_orders',
};

export const ROUTE_ACTIVITIES: Record<string, ActivityRef> = {
  // ---- Company / preferences ----
  '/api/file-lock': 'users.file_password',
  '/api/company': 'company.preferences',
  '/api/company/closing-date': 'closing.closing_date',
  '/api/company/setup-interview': 'company.preferences',
  '/api/doc-numbers': 'company.doc_numbers',
  '/api/custom-fields': 'lists.custom_fields',
  '/api/currencies': ['lists.currencies', 'accounting.currency_adjust'],
  '/api/budgets': 'company.budgets',
  '/api/budgets/[id]/vs-actual': 'reports_financial.company',
  '/api/fiscal-periods': 'closing.fiscal_periods',
  '/api/year-end-close': 'closing.year_end',
  '/api/month-end-close': 'accounting.month_end',
  '/api/month-end-close/close': 'closing.closing_date',
  '/api/month-end-close/report-pack': 'reports_financial.company',
  '/api/dashboard': 'reports_financial.company',
  '/api/report-schedules': 'file_utilities.schedules',
  '/api/reports/schedules': 'file_utilities.schedules',
  '/api/network-policy': 'company.network',
  '/api/ai/settings': 'company.ai',
  '/api/ai/tailnet': 'company.ai',
  '/api/ai/test': 'company.ai',
  '/api/ai/pull': 'company.ai',
  '/api/ai/chatgpt': 'company.ai',
  '/api/pricing/settings': 'company.preferences',
  '/api/receiving/settings': 'company.preferences',
  '/api/form-templates': 'company.templates',
  '/api/letters/templates': 'lists.letters',
  '/api/email': 'company.send_forms',
  // feature round (accountant): System Accounts by role (choosing one is a company setting).
  '/api/account-roles': ['accounting.accountant_tools', 'company.preferences'],

  // ---- Users & Roles ----
  '/api/users': 'users.users',
  '/api/users/password-policy': 'users.password_rules',
  '/api/users/permissions-report': 'users.permission_reports',
  '/api/roles': 'users.roles',

  // ---- File utilities ----
  '/api/backup': { GET: 'file_utilities.backup', POST: 'file_utilities.restore' },
  '/api/dashboard/auto-backup': 'file_utilities.backup',
  '/api/backups': 'file_utilities.backup',
  '/api/backups/restore': 'file_utilities.restore',
  '/api/condense': 'file_utilities.condense',
  '/api/condense/archives': { GET: 'file_utilities.condense', POST: 'file_utilities.restore' },
  '/api/integrity': 'file_utilities.integrity',
  '/api/portable': 'file_utilities.export',
  '/api/portable/restore': 'file_utilities.restore',
  '/api/transaction-log': 'reports_financial.audit',
  '/api/transaction-log/download': { GET: 'file_utilities.export' },
  '/api/qb-import': 'file_utilities.import',
  '/api/import': ['banking.bank_feeds', 'file_utilities.import'],
  '/api/import/rebuild': 'file_utilities.integrity',
  '/api/export/[list]': 'file_utilities.export',
  '/api/export/reports': 'reports_financial.company',
  '/api/export/statements': 'customers.statements',
  '/api/cleanup': 'file_utilities.cleanup',
  '/api/single-user': 'file_utilities.single_user',
  '/api/sandbox': 'file_utilities.sandbox',
  '/api/attention/backup': 'file_utilities.backup',
  '/api/accountant-copy': ['accounting.accountants_copy', 'file_utilities.accountants_copy'],
  '/api/period-copy': 'file_utilities.accountants_copy',

  // ---- Lists ----
  '/api/accounts': ['lists.chart_of_accounts', 'accounting.chart_of_accounts'],
  '/api/classes': 'lists.classes',
  '/api/locations': 'lists.locations',
  '/api/items': 'lists.items',
  '/api/pricing/levels': 'lists.price_levels',
  '/api/pricing/rules': 'lists.price_levels',
  '/api/type-lists/[kind]': 'lists.type_lists',
  '/api/type-lists/vendor-assign': 'vendors.center',
  '/api/ai/recurring': 'lists.memorized',
  '/api/sales-reps': 'lists.sales_reps',
  '/api/sales-reps/assign': 'customers.center',
  '/api/receipts': ['lists.doc_center', 'company.preferences'],
  '/api/recurring': 'lists.memorized',
  '/api/recurring/run': 'accounting.memorized_run',
  '/api/merge': 'lists.merge',
  '/api/fixed-assets': ['lists.fixed_assets', 'accounting.depreciation'],
  '/api/lists/[list]': 'lists.other_lists',
  '/api/terms/compute': 'lists.other_lists',
  '/api/billing-rate-levels': 'lists.billing_rates',
  '/api/billing-rate-levels/resolve': 'time.timesheets',
  '/api/uom-sets': 'lists.uom',

  // ---- Customers & Receivables ----
  '/api/customers': 'customers.center',
  '/api/jobs': 'customers.center',
  '/api/job-type-assign': 'customers.center',
  '/api/leads': 'customers.leads',
  '/api/customer-prices': 'customers.pricing',
  '/api/pricing/customers': 'customers.center',
  '/api/pricing/quote': 'customers.pricing',
  '/api/invoices': 'customers.invoices',
  '/api/invoices/batch': 'customers.batch_invoicing',
  '/api/invoices/statement-charges': 'customers.statement_charges',
  '/api/estimates': 'customers.estimates',
  '/api/sales-orders': 'customers.sales_orders',
  '/api/fulfillment': 'customers.fulfillment',
  '/api/sales-receipts': 'customers.sales_receipts',
  '/api/payments': 'customers.payments',
  '/api/credit-memos': 'customers.credit_memos',
  '/api/finance-charges': 'customers.finance_charges',
  '/api/finance-charges/settings': 'company.preferences',
  '/api/billables': 'customers.time_billing',
  '/api/time-entries/bill': 'customers.time_billing',
  '/api/sales-forms/[kind]': {
    resolve: (path) => SALES_FORM_ACTIVITY[path.split('/')[3] ?? ''] ?? null,
  },
  '/api/sales-forms/queue': 'customers.send_forms',
  '/api/sales-forms/statement-email': 'customers.statements',
  '/api/income-tracker': 'customers.income_tracker',
  '/api/collections': 'customers.collections',
  // salesar (C6/C9): Collections Center email/letter send (routes need the 'print' right).
  '/api/collections/email': 'customers.send_forms',
  '/api/collections/letter': 'customers.send_forms',
  // salesar: Billing Groups for Batch Invoicing (creating the group is Customer Center; creating a batch run is Batch Invoicing).
  '/api/billing-groups': { GET: 'customers.center', POST: 'customers.center' },
  '/api/billing-groups/[id]': 'customers.center',
  '/api/accountant/write-off': 'customers.write_off',
  '/api/attention/invoice-reminder': 'customers.invoices',
  '/api/smart-defaults/sales': 'customers.invoices',

  // ---- Vendors & Payables ----
  '/api/vendors': 'vendors.center',
  '/api/bills': 'vendors.bills',
  '/api/bills/to-pay': 'vendors.pay_bills',
  '/api/bill-payments': 'vendors.pay_bills',
  '/api/vendor-credits': 'vendors.vendor_credits',
  '/api/purchase-orders': 'vendors.purchase_orders',
  '/api/inventory/reorder/create-po': 'vendors.purchase_orders',
  '/api/expense-reports': 'vendors.expense_reports',
  '/api/reports/1099/mapping': 'vendors.tax_1099',
  '/api/receiving': 'vendors.receive_bill',
  '/api/ai/prefill': 'vendors.bills',
  '/api/smart-defaults/bills': 'vendors.bills',

  // ---- Banking ----
  '/api/bank-accounts': 'banking.bank_accounts',
  '/api/bank-transactions': 'banking.bank_feeds',
  '/api/ai/posts': 'banking.bank_feeds',
  '/api/rules': 'banking.bank_rules',
  '/api/bank-rules': 'banking.bank_rules',
  '/api/ai/bank-suggestions': 'banking.bank_feeds',
  '/api/ai/categorizer': 'banking.bank_feeds',
  '/api/demo-feed': 'banking.bank_feeds',
  '/api/deposits': 'banking.deposits',
  '/api/expenses': 'banking.write_checks',
  '/api/expenses/[id]/print': 'banking.print_checks',
  '/api/checks': 'banking.print_checks',
  '/api/check-numbers': 'banking.write_checks',
  '/api/smart-defaults/expenses': 'banking.write_checks',
  '/api/print-queue': 'banking.print_checks',
  '/api/print-queue/paychecks': 'payroll.paychecks',
  '/api/loans': 'banking.loans',
  '/api/banking/account-currency': 'accounting.chart_of_accounts',
  '/api/registers': 'banking.registers',

  // ---- Sensitive accounting ----
  '/api/journal-entries': 'accounting.journal_entries',
  '/api/transfers': 'accounting.transfers',
  '/api/reconciliations': 'accounting.reconcile',
  '/api/errors': 'accounting.error_check',
  '/api/ai/assistant': 'reports_financial.ai_assistant',
  '/api/ai/proposals': 'accounting.ai_proposals',
  '/api/audit-trail': 'reports_financial.audit',
  '/api/why-changed': 'reports_financial.accountant',
  '/api/accountant': 'accounting.accountant_tools',
  '/api/accountant/working-trial-balance': ['reports_financial.accountant', 'accounting.accountant_tools'],
  '/api/accountant/closing-date-exceptions': 'closing.closing_date',
  '/api/accountant/voided-deleted': 'reports_financial.accountant',
  '/api/accountant/sales-tax/liability': 'sales_tax.reports',
  '/api/accountant/sales-tax/revenue-summary': 'sales_tax.reports',
  '/api/accountant/sales-tax/adjustments': 'sales_tax.adjust',
  '/api/accountant/sales-tax/fix': 'sales_tax.adjust',

  // ---- Inventory ----
  '/api/inventory': 'inventory.adjust',
  '/api/inventory/reorder': 'inventory.center',
  '/api/inventory/center': 'inventory.center',
  '/api/inventory/stock-status': 'reports_inventory.stock',
  '/api/inventory/worksheet': 'reports_inventory.stock',
  '/api/inventory/stock-by-vendor': 'reports_inventory.stock',
  '/api/item-receipts': 'inventory.item_receipts',
  '/api/assemblies': 'inventory.assemblies',
  '/api/fifo': 'inventory.fifo',
  '/api/inventory-sites': 'inventory.sites',
  '/api/inventory-sites/reports': 'reports_inventory.stock',
  '/api/inventory-transfers': 'inventory.transfers',
  '/api/landed-cost': 'inventory.landed_cost',

  // ---- Sales tax ----
  '/api/tax-agencies': 'sales_tax.codes',
  '/api/tax-rates': 'sales_tax.codes',
  '/api/pay-liabilities/sales-tax': 'sales_tax.pay',
  '/api/sales-tax': 'sales_tax.pay',
  '/api/reports/sales-tax-by-agency': 'sales_tax.reports',

  // ---- Time ----
  '/api/time-entries': 'time.timesheets',
  '/api/mileage': 'time.mileage',

  // ---- Payroll ----
  '/api/employees': 'payroll.employees',
  '/api/payroll-items': 'payroll.payroll_items',
  '/api/payroll': 'payroll.paychecks',
  '/api/payroll/adjustments': 'payroll.adjustments',
  '/api/payroll/state-settings': 'payroll.setup',
  '/api/payroll/workers-comp': 'payroll.setup',
  '/api/payroll/accruals': 'payroll.setup',
  '/api/payroll/paystub': 'payroll.paystubs',
  '/api/payroll/state-wage-worksheet': 'reports_payroll.payroll',
  '/api/payroll/reports': 'reports_payroll.payroll',
  '/api/payroll/940': 'reports_payroll.tax_forms',
  '/api/payroll/941': 'reports_payroll.tax_forms',
  '/api/payroll/w2': 'reports_payroll.tax_forms',
  '/api/payroll/w3': 'reports_payroll.tax_forms',
  '/api/pay-liabilities': 'payroll.liabilities',

  // ---- Reports ----
  '/api/report-builder': 'reports_financial.custom',
  '/api/reports/pivot': 'reports_financial.custom',
  '/api/find': 'reports_financial.custom',
  '/api/reports/balance-sheet': 'reports_financial.company',
  '/api/reports/balance-sheet-cash': 'reports_financial.company',
  '/api/reports/balance-sheet-classified': 'reports_financial.company',
  '/api/reports/budget-vs-actual': 'reports_financial.company',
  '/api/reports/budget-vs-actual-class': 'reports_financial.company',
  '/api/reports/cash-flow': 'reports_financial.company',
  '/api/reports/consolidated': 'reports_financial.company',
  '/api/reports/pl-by-class': 'reports_financial.company',
  '/api/reports/pl-comparative': 'reports_financial.company',
  '/api/reports/pl-monthly': 'reports_financial.company',
  '/api/reports/pl-percent': 'reports_financial.company',
  '/api/reports/profit-loss': 'reports_financial.company',
  '/api/reports/profit-loss-cash': 'reports_financial.company',
  '/api/reports/check-detail': 'reports_financial.banking',
  '/api/reports/deposit-detail': 'reports_financial.banking',
  '/api/reports/missing-checks': 'reports_financial.banking',
  '/api/reports/general-ledger': 'reports_financial.accountant',
  '/api/reports/transaction-detail': 'reports_financial.accountant',
  '/api/reports/trial-balance': 'reports_financial.accountant',
  '/api/reports/ar-aging': 'reports_sales.receivables',
  '/api/reports/ar-aging-detail': 'reports_sales.receivables',
  '/api/reports/collections': 'reports_sales.receivables',
  '/api/reports/open-invoices': 'reports_sales.receivables',
  '/api/reports/customer-statement': 'reports_sales.receivables',
  '/api/reports/commissions': 'reports_sales.sales',
  '/api/reports/sales-by-customer': 'reports_sales.sales',
  '/api/reports/sales-by-item': 'reports_sales.sales',
  '/api/reports/ap-aging': 'reports_purchases.payables',
  '/api/reports/ap-aging-detail': 'reports_purchases.payables',
  '/api/reports/purchases-by-item': 'reports_purchases.purchases',
  '/api/reports/purchases-by-vendor': 'reports_purchases.purchases',
  '/api/reports/1099': 'reports_purchases.tax_1099',
  '/api/reports/1099-pdf': 'reports_purchases.tax_1099',
  '/api/reports/1099-xml': 'reports_purchases.tax_1099',
  '/api/reports/inventory-valuation': 'reports_inventory.valuation',
};

/**
 * Page prefixes → the activity whose View they need (a list = any one). Longest prefix wins;
 * a page not listed falls back to lib/permissions/routes.ts PAGE_AREAS (its area).
 */
export const PAGE_ACTIVITIES: Record<string, ActivityKey | ActivityKey[]> = {
  '/invoices': 'customers.invoices',
  '/invoices/batch': 'customers.batch_invoicing',
  '/sales-receipts': 'customers.sales_receipts',
  '/estimates': 'customers.estimates',
  '/estimates-followup': 'customers.estimates',
  '/sales-orders': 'customers.sales_orders',
  '/payments': 'customers.payments',
  '/credit-memos': 'customers.credit_memos',
  '/customers': 'customers.center',
  '/jobs': 'customers.center',
  '/finance-charges': 'customers.finance_charges',
  '/income-tracker': 'customers.income_tracker',
  '/collections-center': 'customers.collections',
  '/customer-pricing': 'customers.pricing',
  '/leads': 'customers.leads',
  '/so-fulfillment': 'customers.fulfillment',
  '/accountant/write-off': 'customers.write_off',
  '/items': 'lists.items',
  '/sales-reps': 'lists.sales_reps',
  '/tracking': ['lists.classes', 'lists.locations'],
  '/recurring': 'lists.memorized',
  '/attachments': 'lists.doc_center',
  '/receipts': 'lists.doc_center',
  '/letters': 'lists.letters',
  '/merge': 'lists.merge',
  '/fixed-assets': 'lists.fixed_assets',
  '/lists': 'lists.other_lists',
  '/lists/uom': 'lists.uom',
  '/currencies': 'lists.currencies',
  '/accounts': 'lists.chart_of_accounts',
  '/advanced-pricing': 'lists.price_levels',
  '/templates': 'company.templates',
  '/purchase-orders': 'vendors.purchase_orders',
  '/bills': 'vendors.bills',
  '/pay-bills': 'vendors.pay_bills',
  '/vendor-credits': 'vendors.vendor_credits',
  '/vendors': 'vendors.center',
  '/expense-reports': 'vendors.expense_reports',
  '/receive-bill': 'vendors.receive_bill',
  '/expenses': 'banking.write_checks',
  '/print-checks': 'banking.print_checks',
  '/loans': 'banking.loans',
  '/banking': 'banking.bank_accounts',
  '/registers': 'banking.registers',
  '/bank-feeds': 'banking.bank_feeds',
  '/bank-review': 'banking.bank_feeds',
  '/ai-posts': 'banking.bank_feeds',
  '/transactions': 'banking.bank_feeds',
  '/bank-rules': 'banking.bank_rules',
  '/deposits': 'banking.deposits',
  '/reconcile': 'accounting.reconcile',
  '/transfers': 'accounting.transfers',
  '/journal': 'accounting.journal_entries',
  '/errors': 'accounting.error_check',
  '/month-end': 'accounting.month_end',
  '/accountant': 'accounting.accountant_tools',
  '/accountant/accountants-copy': 'accounting.accountants_copy',
  '/accountant/working-trial-balance': 'reports_financial.accountant',
  '/accountant/fix-sales-tax': 'sales_tax.adjust',
  '/accountant/sales-tax-adjustment': 'sales_tax.adjust',
  '/accountant/period-copy': 'file_utilities.accountants_copy',
  '/pay-liabilities': 'payroll.liabilities',
  '/employees': 'payroll.employees',
  '/employees/setup': 'payroll.setup',
  '/pay-runs': 'payroll.paychecks',
  '/pay-stubs': 'payroll.paystubs',
  '/payroll-tax': 'payroll.setup',
  '/payroll-forms': 'reports_payroll.tax_forms',
  '/payroll-forms/reports': 'reports_payroll.payroll',
  '/sales-tax-components': 'sales_tax.codes',
  '/sales-tax': 'sales_tax.pay',
  '/fiscal-periods': 'closing.fiscal_periods',
  '/year-end': 'closing.year_end',
  '/budgets': 'company.budgets',
  '/settings': 'company.preferences',
  '/doc-numbers': 'company.doc_numbers',
  '/ai-settings': 'company.ai',
  '/privacy': 'company.network',
  '/time-tracking': 'time.timesheets',
  '/mileage': 'time.mileage',
  '/assemblies': 'inventory.assemblies',
  '/inventory-ops': 'inventory.adjust',
  '/inventory-center': 'inventory.center',
  '/fifo': 'inventory.fifo',
  '/inventory-sites': 'inventory.sites',
  '/inventory-transfers': 'inventory.transfers',
  '/landed-cost': 'inventory.landed_cost',
  '/item-receipts': 'inventory.item_receipts',
  '/transaction-log': 'reports_financial.audit',
  '/audit-trail': 'reports_financial.audit',
  '/integrity': 'file_utilities.integrity',
  '/backup': 'file_utilities.backup',
  '/qb-import': 'file_utilities.import',
  '/lists/cleanup': 'file_utilities.cleanup',
  '/sandbox': 'file_utilities.sandbox',
  '/reports/schedules': 'file_utilities.schedules',
  '/users': ['users.users', 'users.roles'],
  '/users/permissions': 'users.permission_reports',
  '/reports/builder': 'reports_financial.custom',
  '/reports/pivot': 'reports_financial.custom',
  '/find': 'reports_financial.custom',
  '/reports/balance-sheet': 'reports_financial.company',
  '/reports/balance-sheet-cash': 'reports_financial.company',
  '/reports/balance-sheet-classified': 'reports_financial.company',
  '/reports/cash-flow': 'reports_financial.company',
  '/reports/consolidated': 'reports_financial.company',
  '/reports/pl-by-class': 'reports_financial.company',
  '/reports/pl-comparative': 'reports_financial.company',
  '/reports/pl-monthly': 'reports_financial.company',
  '/reports/pl-percent': 'reports_financial.company',
  '/reports/profit-loss': 'reports_financial.company',
  '/reports/profit-loss-cash': 'reports_financial.company',
  '/reports/check-detail': 'reports_financial.banking',
  '/reports/deposit-detail': 'reports_financial.banking',
  '/reports/missing-checks': 'reports_financial.banking',
  '/reports/general-ledger': 'reports_financial.accountant',
  '/reports/transaction-detail': 'reports_financial.accountant',
  '/reports/trial-balance': 'reports_financial.accountant',
  '/reports/voided-deleted': 'reports_financial.accountant',
  '/reports/ar-aging': 'reports_sales.receivables',
  '/reports/ar-aging-detail': 'reports_sales.receivables',
  '/reports/collections': 'reports_sales.receivables',
  '/reports/open-invoices': 'reports_sales.receivables',
  '/reports/customer-statement': 'reports_sales.receivables',
  '/reports/statements': 'reports_sales.receivables',
  '/reports/commissions': 'reports_sales.sales',
  '/reports/sales-by-customer': 'reports_sales.sales',
  '/reports/sales-by-item': 'reports_sales.sales',
  '/reports/sales-by-rep': 'reports_sales.sales',
  '/reports/ap-aging': 'reports_purchases.payables',
  '/reports/ap-aging-detail': 'reports_purchases.payables',
  '/reports/purchases-by-item': 'reports_purchases.purchases',
  '/reports/purchases-by-vendor': 'reports_purchases.purchases',
  '/reports/1099': 'reports_purchases.tax_1099',
  '/reports/1099-efile': 'reports_purchases.tax_1099',
  '/reports/payroll-summary': 'reports_payroll.payroll',
  '/reports/inventory-valuation': 'reports_inventory.valuation',
  '/reports/inventory-sites': 'reports_inventory.stock',
  '/reports/sales-tax': 'sales_tax.reports',
  '/reports/closing-date-exceptions': 'closing.closing_date',
  '/reports/reconciliation': 'accounting.reconcile',
};

const asList = (v: One | null | undefined): ActivityKey[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

function refActivities(ref: ActivityRef, path: string | null, method: Method): ActivityKey[] {
  if (typeof ref === 'string' || Array.isArray(ref)) return asList(ref);
  if ('resolve' in ref) {
    if (!path) return [];
    const k = ref.resolve(path, method);
    return k ? [k] : [];
  }
  return asList((ref as Partial<Record<Method, One>>)[method]);
}

const underPrefix = (pattern: string, prefix: string) => pattern === prefix || pattern.startsWith(prefix + '/');

/**
 * The activity a route rule needs: the longest prefix of the route PATTERN whose activity is in
 * the rule's area. `path` (the concrete request path) is only needed by kind-addressed routes.
 * Null when nothing is mapped (the caller then checks the whole area).
 */
export function activityForRoute(
  pattern: string,
  method: string,
  area: Area,
  path: string | null = null,
): ActivityKey | null {
  const m = method.toUpperCase() as Method;
  const prefixes = Object.keys(ROUTE_ACTIVITIES)
    .filter((p) => underPrefix(pattern, p))
    .sort((a, b) => b.length - a.length);
  for (const p of prefixes) {
    const hit = refActivities(ROUTE_ACTIVITIES[p], path, m).find((k) => activityDef(k)?.area === area);
    if (hit) return hit;
  }
  return null;
}

/** The activities (any one with View) a page path needs, or null when no activity is mapped. */
export function pageActivitiesFor(pathname: string): ActivityKey[] | null {
  let best: string | null = null;
  for (const prefix of Object.keys(PAGE_ACTIVITIES)) {
    if (underPrefix(pathname, prefix) && (!best || prefix.length > best.length)) best = prefix;
  }
  return best ? asList(PAGE_ACTIVITIES[best]) : null;
}
