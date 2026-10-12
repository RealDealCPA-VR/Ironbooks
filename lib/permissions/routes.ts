/**
 * Declarative permission map: every API route path + HTTP method → the permission it needs.
 *
 * ENFORCEMENT is central and automatic: middleware.ts stamps each request with its pathname and
 * method (ROUTE_PATH_HEADER / ROUTE_METHOD_HEADER, overwriting any client-supplied value), and
 * `getServerContext` (lib/context.ts) looks the pair up here and throws FORBIDDEN unless the
 * caller's effective permissions allow it. A route can't "forget" — calling getServerContext is
 * how a route gets a context at all, and lib/permissions/routes.test.ts walks every
 * app/api/**\/route.ts and FAILS if any exported HTTP method is missing from this map (or if an
 * area-mapped route never calls getServerContext). Unmapped API paths are denied (fail closed).
 *
 * Rule kinds:
 *  - { area, action }  checked against the caller's effective permissions.
 *  - 'member'          any active member of the company (no specific area); still requires a
 *                      valid session + unlocked file via getServerContext.
 *  - 'self'            acts on the signed-in USER rather than the active company (company-file
 *                      list/create/select/rename/archive, the caller's own 2FA settings). These
 *                      call getSessionGate (lib/context.ts), which still enforces the file lock,
 *                      the session's file binding and deactivation; per-company checks (e.g.
 *                      rename needs company:modify in the company named by the URL) are in the
 *                      handler. The employee portal uses its own portal session. Never put data
 *                      routes here (routes.test.ts checks every 'self' route uses the gate).
 *  - 'public'          no authentication at all (login, signup, unlock, status probes).
 *
 * Pure module (no Node/DB imports): also used client-side to filter navigation.
 */
import type { Action, Area } from './model';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export type AreaRule = { area: Area; action: Action };
export type RouteRule = AreaRule | 'member' | 'self' | 'public';
export type MethodRules = Partial<Record<HttpMethod, RouteRule>>;

/** Request headers stamped by middleware.ts (never trusted from the client — always overwritten). */
export { ROUTE_PATH_HEADER, ROUTE_METHOD_HEADER } from './headers';

const DEFAULT_ACTION: Record<HttpMethod, Action> = {
  GET: 'view',
  POST: 'create',
  PUT: 'modify',
  PATCH: 'modify',
  DELETE: 'delete',
};

/**
 * Map methods to an area. `spec` lists methods, each optionally with an explicit action:
 * 'GET POST' → GET view, POST create; 'GET POST:modify DELETE' → POST mapped to modify.
 */
function r(area: Area, spec: string): MethodRules {
  const out: MethodRules = {};
  for (const tok of spec.trim().split(/\s+/)) {
    const [m, a] = tok.split(':') as [HttpMethod, Action | undefined];
    out[m] = { area, action: a ?? DEFAULT_ACTION[m] };
  }
  return out;
}
function kind(k: 'member' | 'self' | 'public', spec: string): MethodRules {
  const out: MethodRules = {};
  for (const m of spec.trim().split(/\s+/) as HttpMethod[]) out[m] = k;
  return out;
}

export const API_ROUTE_PERMISSIONS: Record<string, MethodRules> = {
  // ---- Auth / session / file lock ----
  '/api/auth/login': kind('public', 'POST'),
  '/api/auth/logout': kind('public', 'POST'),
  '/api/auth/signup': kind('public', 'POST'),
  '/api/auth/request-reset': kind('public', 'POST'),
  '/api/auth/reset': kind('public', 'POST'),
  '/api/auth/me': kind('public', 'GET'), // returns null without a valid session
  '/api/auth/2fa/setup': kind('self', 'POST'),
  '/api/auth/2fa/enable': kind('self', 'POST'),
  '/api/auth/2fa/disable': kind('self', 'POST'),
  '/api/unlock': kind('public', 'POST'),
  '/api/file-lock': { GET: 'member', ...r('users', 'POST:modify') },
  '/api/portal/login': kind('public', 'POST'),
  '/api/portal/logout': kind('public', 'POST'),
  '/api/portal/me': kind('self', 'GET'),
  '/api/email/status': kind('public', 'GET'),
  '/api/plaid/status': kind('public', 'GET'),

  // ---- Company files / company settings ----
  '/api/companies': kind('self', 'GET POST'),
  '/api/companies/[id]': kind('self', 'PATCH DELETE'),
  '/api/companies/select': kind('self', 'POST'),
  '/api/company': { GET: 'member', ...r('company', 'PATCH') },
  '/api/company/closing-date': r('closing', 'GET PATCH'),
  // wave2 foundation: document numbering (next number for forms; starting numbers).
  '/api/doc-numbers': { GET: 'member', ...r('company', 'PUT') },
  '/api/custom-fields': r('lists', 'GET PATCH'),
  '/api/custom-fields/values': r('lists', 'POST:modify'),
  '/api/currencies': r('lists', 'GET POST'),
  '/api/currencies/fx-adjustment': r('accounting', 'POST'),
  '/api/budgets': r('company', 'GET POST'),
  '/api/budgets/[id]': r('company', 'GET PATCH'),
  '/api/budgets/[id]/vs-actual': r('reports_financial', 'GET'),
  '/api/fiscal-periods': r('closing', 'GET POST:modify'),
  '/api/fiscal-periods/[id]': r('closing', 'PATCH'),
  '/api/year-end-close': r('closing', 'POST:modify'),
  '/api/dashboard': r('reports_financial', 'GET'),
  '/api/search': kind('member', 'GET'), // results filtered per area in the route
  '/api/memorized-reports': kind('member', 'GET POST'),
  // wave2 reports: memorized report groups / Process Multiple Reports run each report through
  // runStandardReport, which checks that report's own area — so these are member routes.
  '/api/memorized-reports/[id]': kind('member', 'GET PATCH DELETE'),
  '/api/memorized-reports/groups': kind('member', 'GET POST'),
  '/api/memorized-reports/groups/[id]': kind('member', 'PATCH DELETE'),
  '/api/memorized-reports/process': kind('member', 'POST'),
  // Scheduled reports write export files to the local disk (a file utility).
  '/api/report-schedules': r('file_utilities', 'GET POST'),
  '/api/report-schedules/[id]': r('file_utilities', 'PATCH:modify DELETE'),
  '/api/report-schedules/run-due': r('file_utilities', 'POST:create'),
  '/api/reports/schedules/run-due': r('file_utilities', 'POST:create'),
  // Privacy & Network (team hosting): any member may read the policy (admins see more; the
  // route decides) and ask whether a destination is allowed; changing it is a company setting
  // (the service additionally requires owner/admin).
  '/api/network-policy': { GET: 'member', ...r('company', 'PUT:modify PATCH:modify') },
  '/api/network-policy/check': kind('member', 'GET'),
  // AI & Automation (team ai): provider settings are company preferences; tailnet discovery
  // and Test Connection are part of editing them.
  '/api/ai/settings': r('company', 'GET PUT:modify'),
  '/api/ai/tailnet': r('company', 'GET:modify'),
  '/api/ai/test': r('company', 'POST:modify'),
  // Advanced pricing / receiving preferences (team pricing).
  '/api/pricing/settings': r('company', 'GET PATCH'),
  '/api/receiving/settings': r('company', 'GET PATCH'),
  // wave2 prefs: resolved Preferences (company + My Preferences). Any member reads them (forms
  // and reports honor them); company preferences are written through PATCH /api/company; My
  // Preferences only change the signed-in person's own settings.
  '/api/preferences': kind('member', 'GET'),
  '/api/preferences/my': kind('member', 'GET PATCH'),
  // Form templates: any member may list them (print/email template pickers); designing them is a
  // company preference.
  '/api/form-templates': { GET: 'member', ...r('company', 'POST') },
  '/api/form-templates/[id]': { GET: 'member', ...r('company', 'PATCH DELETE') },
  '/api/form-templates/[id]/logo': r('company', 'POST:modify DELETE:modify'),
  '/api/form-templates/preview': r('company', 'POST:view'),
  // Reminders / Calendar / To Do list: per-member views; the services drop categories from areas
  // the member can't view. To-dos are personal notes (no books data).
  '/api/reminders': kind('member', 'GET'),
  '/api/calendar': kind('member', 'GET'),
  // Calendar / Lead Center to-dos (wave2 prefs). Served under /api/calendar/todos because
  // /api/todos is the wave2 lists To Do list (Lists > To Do, gated by the lists area).
  '/api/calendar/todos': kind('member', 'GET POST'),
  '/api/calendar/todos/[id]': kind('member', 'PATCH DELETE'),
  // Letters & labels: the templates are a list; producing letters/labels/envelopes needs print
  // on the recipients' area (customers / vendors / payroll), checked in the handlers.
  '/api/letters/templates': r('lists', 'GET POST'),
  '/api/letters/templates/[id]': r('lists', 'PATCH DELETE'),
  '/api/letters/recipients': kind('member', 'GET'),
  '/api/letters/prepare': kind('member', 'POST'),
  '/api/letters/labels': kind('member', 'POST'),
  '/api/letters/envelopes': kind('member', 'POST'),

  // ---- Users & Roles ----
  '/api/users': r('users', 'GET POST'),
  '/api/users/[id]': r('users', 'GET PATCH'),
  '/api/users/[id]/reset-password': r('users', 'POST:modify'),
  '/api/roles': r('users', 'GET POST'),
  '/api/roles/[id]': r('users', 'GET PATCH DELETE'),
  // Multi-user hosting (team hosting): who is logged in / sign-out / single-user mode. Every
  // member sees their own session and may sign it out; the services restrict everything else
  // (other people's sessions, sign-out-others, single-user mode) to owner/admin.
  '/api/sessions': kind('member', 'GET POST'),
  '/api/sessions/[id]': kind('member', 'DELETE'),
  '/api/single-user': { GET: 'member', ...r('file_utilities', 'POST:modify') },

  // ---- File utilities ----
  '/api/backup': r('file_utilities', 'GET:create POST:delete'),
  '/api/backup/company': r('file_utilities', 'GET:create POST:delete'),
  '/api/dashboard/auto-backup': r('file_utilities', 'POST'),
  '/api/condense': r('file_utilities', 'POST:delete'),
  '/api/condense/archives': r('file_utilities', 'GET POST:delete'), // POST restores the whole file
  '/api/integrity/books-in-balance': r('file_utilities', 'GET'),
  // Company file (team companyfile): portable file = full copy of the file (create, like a
  // backup); restoring one is a restore ('delete', like /api/backup); the shareable ledger
  // and transaction log are exports / an audit view of the books.
  '/api/portable': r('file_utilities', 'GET:create'),
  '/api/portable/restore': r('file_utilities', 'POST:delete'),
  '/api/portable/shareable': r('file_utilities', 'GET:print'),
  '/api/transaction-log': r('reports_financial', 'GET'),
  '/api/transaction-log/verify': r('reports_financial', 'GET'),
  '/api/qb-import/gl': r('file_utilities', 'GET POST'),
  '/api/integrity': r('file_utilities', 'GET'),
  '/api/import': r('file_utilities', 'POST'),
  '/api/import/csv-preview': r('file_utilities', 'POST'),
  '/api/import/qb': r('file_utilities', 'POST'),
  '/api/import/rebuild': r('file_utilities', 'GET POST:modify'),
  '/api/qb-import': r('file_utilities', 'POST'),
  '/api/export/[list]': r('file_utilities', 'GET:print'),
  '/api/export/reports': r('reports_financial', 'POST:print'),
  '/api/export/statements/batch': r('customers', 'GET:print'),
  '/api/export/statements/open-item': r('customers', 'GET:print'),
  '/api/export/statements/open-item/pdf': r('customers', 'GET:print'),

  // ---- Lists ----
  '/api/accounts': { ...r('lists', 'GET'), ...r('accounting', 'POST') },
  '/api/accounts/[id]': { ...r('lists', 'GET'), ...r('accounting', 'PATCH DELETE') },
  // wave2 foundation: income-tax form + account tax-line mapping.
  '/api/accounts/tax-lines': { ...r('lists', 'GET'), ...r('accounting', 'PUT') },
  '/api/classes': r('lists', 'GET POST'),
  '/api/classes/[id]': r('lists', 'PATCH'),
  '/api/locations': r('lists', 'GET POST'),
  '/api/locations/[id]': r('lists', 'PATCH'),
  '/api/items': r('lists', 'GET POST'),
  '/api/items/[id]': r('lists', 'GET PATCH DELETE'),
  '/api/items/[id]/components': r('lists', 'GET'),
  '/api/items/barcode': r('lists', 'GET'),
  // Advanced pricing (team pricing): price levels, price rules and customer/vendor type lists
  // are lists; assigning them to a customer/vendor edits that customer/vendor.
  '/api/pricing/levels': r('lists', 'GET POST'),
  '/api/pricing/levels/[id]': r('lists', 'PUT:modify DELETE'),
  '/api/pricing/levels/[id]/items': r('lists', 'PUT:modify'),
  '/api/pricing/rules': r('lists', 'GET POST'),
  '/api/pricing/rules/[id]': r('lists', 'PUT:modify DELETE'),
  '/api/type-lists/[kind]': r('lists', 'GET POST'),
  '/api/type-lists/[kind]/[id]': r('lists', 'PUT:modify DELETE'),
  '/api/ai/recurring': r('lists', 'GET POST'), // memorizes via the recurring-template list
  '/api/sales-reps': r('lists', 'GET POST'),
  '/api/sales-reps/[id]': r('lists', 'GET PATCH DELETE'),
  '/api/sales-reps/assign': r('customers', 'POST:modify'),
  '/api/attachments': r('lists', 'GET POST'),
  '/api/attachments/[id]': r('lists', 'GET PATCH DELETE'),
  '/api/recurring': r('lists', 'GET POST'),
  '/api/recurring/[id]': r('lists', 'GET PATCH DELETE'),
  '/api/recurring/run': r('accounting', 'POST'),
  '/api/merge': r('lists', 'POST:delete'),
  '/api/fixed-assets': r('lists', 'GET POST'),
  '/api/fixed-assets/[id]': { ...r('lists', 'GET'), ...r('accounting', 'POST') },
  // Wave-2 lists: simple QB lists (Other Names, Job Types, Terms, Ship Via, Payment Methods,
  // Customer Messages, Sales Tax Codes, Vehicles), To Do, Billing Rate Levels, U/M sets, item
  // tools. Notes are 'member' — the handler checks the area of the record the note is on.
  '/api/lists/[list]': r('lists', 'GET POST'),
  '/api/lists/[list]/[id]': r('lists', 'PATCH DELETE'),
  '/api/terms/compute': r('lists', 'GET'),
  '/api/todos': r('lists', 'GET POST'),
  '/api/todos/[id]': r('lists', 'PATCH DELETE'),
  '/api/notes': kind('member', 'GET POST'),
  '/api/notes/[id]': kind('member', 'PATCH DELETE'),
  '/api/billing-rate-levels': r('lists', 'GET POST'),
  '/api/billing-rate-levels/[id]': r('lists', 'GET PUT:modify DELETE'),
  '/api/billing-rate-levels/assign': r('lists', 'POST:modify'),
  '/api/billing-rate-levels/resolve': r('time', 'GET'),
  '/api/uom-sets': r('lists', 'GET POST'),
  '/api/uom-sets/[id]': r('lists', 'GET PUT:modify DELETE'),
  '/api/items/bulk': r('lists', 'GET POST'),
  '/api/items/change-prices': r('lists', 'POST:modify'),
  '/api/cleanup': r('file_utilities', 'GET POST:delete'),

  // ---- Customers & Receivables ----
  '/api/customers': r('customers', 'GET POST'),
  '/api/customers/[id]': r('customers', 'GET PATCH DELETE'),
  '/api/customers/bulk': r('customers', 'GET POST'), // Add/Edit Multiple (edits also need modify)
  '/api/jobs': r('customers', 'GET POST'),
  '/api/jobs/[id]': r('customers', 'GET PATCH DELETE'),
  '/api/job-type-assign': r('customers', 'POST:modify'), // wave-2 lists: a job's Job Type
  // Lead Center (wave2 prefs): prospects before they become customers.
  '/api/leads': r('customers', 'GET POST'),
  '/api/leads/[id]': r('customers', 'GET PATCH DELETE'),
  '/api/leads/[id]/convert': r('customers', 'POST:create'),
  '/api/customer-prices': r('customers', 'GET POST'),
  '/api/customer-prices/[id]': r('customers', 'DELETE'),
  '/api/pricing/customers/[id]': r('customers', 'PATCH'),
  '/api/pricing/quote': r('customers', 'POST:view'), // advisory price lookup for sales forms
  '/api/invoices': r('customers', 'GET POST'),
  '/api/invoices/[id]': r('customers', 'GET PUT PATCH DELETE'),
  '/api/invoices/[id]/email': r('customers', 'POST:print'),
  '/api/invoices/[id]/packing-slip': r('customers', 'GET:print'),
  '/api/invoices/[id]/pdf': r('customers', 'GET:print'),
  '/api/invoices/[id]/post': r('customers', 'POST:modify'),
  '/api/invoices/custom-fields': r('customers', 'GET'),
  '/api/estimates': r('customers', 'GET POST'),
  '/api/estimates/[id]': r('customers', 'GET PATCH POST:modify'),
  '/api/estimates/[id]/pdf': r('customers', 'GET:print'),
  '/api/estimates/expire': r('customers', 'POST:modify'),
  '/api/sales-orders': r('customers', 'GET POST'),
  '/api/sales-orders/[id]': r('customers', 'GET POST:modify PUT PATCH'),
  '/api/sales-orders/backorders': r('customers', 'GET'),
  // SO fulfillment worksheet (team pricing): batch-invoicing creates invoices.
  '/api/fulfillment': r('customers', 'GET POST'),
  '/api/fulfillment/pick-list': r('customers', 'GET:print'),
  '/api/fulfillment/packing-slips': r('customers', 'GET:print'),
  '/api/sales-receipts': r('customers', 'GET POST'),
  '/api/sales-receipts/[id]': r('customers', 'GET PUT PATCH DELETE'),
  '/api/payments': r('customers', 'GET POST'),
  '/api/payments/[id]': r('customers', 'GET POST:modify PUT PATCH DELETE'),
  '/api/credit-memos': r('customers', 'GET POST'),
  '/api/credit-memos/[id]': r('customers', 'GET POST:modify PUT PATCH DELETE'),
  '/api/finance-charges': r('customers', 'POST'),
  '/api/finance-charges/preview': r('customers', 'GET'),
  '/api/finance-charges/settings': r('company', 'GET PUT PATCH'),
  '/api/billables': r('customers', 'GET'),
  // wave2 sales: batch invoicing, statement charges, discounts/credits in Receive Payments,
  // sales-form PDFs/email/queues, Income Tracker, Collections Center.
  '/api/invoices/batch': r('customers', 'POST'),
  '/api/invoices/statement-charges': r('customers', 'GET POST'),
  '/api/invoices/statement-charges/[id]': r('customers', 'PUT PATCH'),
  '/api/payments/credits': r('customers', 'GET'),
  '/api/payments/discounts': r('customers', 'GET'),
  '/api/sales-forms/[kind]/[id]/pdf': r('customers', 'GET:print'),
  '/api/sales-forms/[kind]/[id]/email': r('customers', 'POST:print'),
  '/api/sales-forms/[kind]/[id]/flags': r('customers', 'PATCH'),
  '/api/sales-forms/queue': r('customers', 'GET:print POST:print'),
  '/api/sales-forms/statement-email': r('customers', 'POST:print'),
  '/api/income-tracker': r('customers', 'GET'),
  '/api/income-tracker/actions': r('customers', 'POST:create'),
  '/api/collections': r('customers', 'GET'),
  '/api/collections/notes': r('customers', 'GET POST'),
  '/api/collections/notes/[id]': r('customers', 'PATCH'),
  '/api/time-entries/bill': r('customers', 'POST'),

  // ---- Vendors & Payables ----
  '/api/vendors': r('vendors', 'GET POST'),
  '/api/vendors/[id]': r('vendors', 'GET PATCH DELETE'),
  '/api/vendors/bulk': r('vendors', 'GET POST'), // Add/Edit Multiple (edits also need modify)
  '/api/bills': r('vendors', 'GET POST'),
  '/api/bills/[id]': r('vendors', 'GET PATCH DELETE'),
  '/api/bills/to-pay': r('vendors', 'GET'), // wave2 purchases: Pay Bills due/discount filters
  '/api/bills/duplicate-number': r('vendors', 'GET'), // wave2 purchases: duplicate ref warning
  '/api/bill-payments': r('vendors', 'GET POST'),
  '/api/bill-payments/[id]': r('vendors', 'GET PATCH DELETE'),
  '/api/vendor-credits': r('vendors', 'GET POST'),
  '/api/vendor-credits/[id]': r('vendors', 'GET POST:modify PATCH DELETE'),
  '/api/purchase-orders': r('vendors', 'GET POST'),
  '/api/purchase-orders/[id]': r('vendors', 'GET POST:modify PATCH'),
  '/api/purchase-orders/[id]/pdf': r('vendors', 'GET:print'),
  '/api/expense-reports': r('vendors', 'GET POST'),
  '/api/expense-reports/[id]': r('vendors', 'GET POST:modify'),
  '/api/reports/1099/mapping': r('vendors', 'GET PATCH'),
  '/api/type-lists/vendor-assign': r('vendors', 'POST:modify'),
  // Enhanced receiving (team pricing): bill received items.
  '/api/receiving/open-lines': r('vendors', 'GET'),
  '/api/receiving/po/[id]': r('vendors', 'GET'),
  '/api/receiving/bill': r('vendors', 'POST'),
  // AI vendor pre-fill of expense accounts (bills / checks / expenses).
  '/api/ai/prefill': r('vendors', 'GET'),

  // ---- Banking ----
  '/api/bank-accounts': r('banking', 'GET POST'),
  '/api/bank-transactions': r('banking', 'GET'),
  '/api/bank-transactions/[id]/matches': r('banking', 'GET'),
  '/api/bank-transactions/bulk': r('banking', 'POST:modify'),
  '/api/bank-transactions/categorize': r('banking', 'POST'),
  '/api/bank-transactions/exclude': r('banking', 'POST:modify'),
  '/api/bank-transactions/match': r('banking', 'POST:modify'),
  '/api/bank-transactions/unmatch': r('banking', 'POST:modify'),
  '/api/rules': r('banking', 'GET POST'),
  // AI categorization of bank feed lines (team ai): auto-apply posts through categorize.
  '/api/ai/bank-suggestions': r('banking', 'GET POST'),
  '/api/ai/categorizer': r('banking', 'GET POST:modify'),
  '/api/demo-feed': r('banking', 'POST'),
  '/api/plaid/exchange': r('banking', 'POST'),
  '/api/plaid/link-token': r('banking', 'POST'),
  '/api/plaid/sync': r('banking', 'POST'),
  '/api/deposits': r('banking', 'GET POST'),
  '/api/deposits/[id]': r('banking', 'GET PATCH DELETE'),
  '/api/deposits/undeposited': r('banking', 'GET'),
  '/api/expenses': r('banking', 'GET POST'),
  '/api/expenses/[id]': r('banking', 'GET PATCH DELETE'),
  '/api/expenses/[id]/print': r('banking', 'POST:print'),
  '/api/checks/pdf': r('banking', 'POST:print'),
  '/api/check-numbers/next': r('banking', 'GET'),
  // wave2 purchases: duplicate check numbers, unified print queue, printer setup, Loan Manager,
  // bank / card account currency.
  '/api/check-numbers/duplicate': r('banking', 'GET'),
  '/api/print-queue': r('banking', 'GET POST:print'),
  '/api/print-queue/paychecks': r('payroll', 'GET POST:print'),
  '/api/checks/settings': r('banking', 'GET PUT:modify'),
  '/api/loans': r('banking', 'GET POST'),
  '/api/loans/[id]': r('banking', 'GET PATCH DELETE'),
  '/api/loans/[id]/payments': r('banking', 'POST'),
  '/api/banking/account-currency': r('accounting', 'POST:modify'),
  '/api/registers': r('banking', 'GET'),
  '/api/registers/[accountId]': r('banking', 'GET'),

  // ---- Sensitive accounting ----
  '/api/journal-entries': r('accounting', 'GET POST'),
  '/api/journal-entries/[id]': r('accounting', 'GET PATCH DELETE'),
  '/api/journal-entries/[id]/history': r('accounting', 'GET'),
  '/api/journal-entries/[id]/reverse': r('accounting', 'POST'),
  // wave2 foundation: Adjusting Journal Entries report data.
  '/api/journal-entries/adjusting': r('accounting', 'GET'),
  '/api/transfers': r('accounting', 'GET POST'),
  '/api/transfers/[id]': r('accounting', 'GET PATCH DELETE'), // wave2 purchases: edit / void
  '/api/reconciliations': r('accounting', 'GET POST'),
  '/api/reconciliations/[id]': r('accounting', 'GET PATCH DELETE'),
  '/api/reconciliations/[id]/clearable': r('accounting', 'GET'),
  '/api/reconciliations/[id]/pay': r('accounting', 'POST'),
  '/api/reconciliations/[id]/report': r('accounting', 'GET:print'),
  '/api/reconciliations/discrepancies': r('accounting', 'GET'),
  '/api/reconciliations/info': r('accounting', 'GET'),
  '/api/reconciliations/undo': r('accounting', 'POST:delete'),
  '/api/errors': r('accounting', 'GET POST'),
  '/api/errors/[id]/analyze': r('accounting', 'POST'),
  '/api/errors/[id]/apply': r('accounting', 'POST:modify'),
  // AI assistant (team ai): answers come from read-only report tools; proposals are journal
  // entries that post only when approved, under the approver's own permissions.
  '/api/ai/assistant': r('reports_financial', 'POST:view'),
  '/api/ai/proposals': r('accounting', 'GET'),
  '/api/ai/proposals/[id]': r('accounting', 'POST'),
  '/api/audit-trail': r('reports_financial', 'GET'),
  '/api/audit-trail/[id]': r('reports_financial', 'GET'),
  // wave2 accountant: Accountant Center tools.
  '/api/accountant/center': r('accounting', 'GET'),
  '/api/accountant/reclassify': r('accounting', 'GET POST:modify'),
  '/api/accountant/write-off': r('customers', 'GET POST'),
  '/api/accountant/batch-enter': r('accounting', 'POST'),
  '/api/accountant/batch-void': r('accounting', 'GET POST:delete'),
  '/api/accountant/working-trial-balance': { GET: { area: 'reports_financial', action: 'view' }, ...r('accounting', 'PUT:modify POST') },
  '/api/accountant/list-changes': r('accounting', 'GET POST:modify'),
  '/api/accountant/client-data-review': r('accounting', 'GET POST:modify'),
  '/api/accountant/closing-date-exceptions': r('closing', 'GET'),
  '/api/accountant/voided-deleted': r('reports_financial', 'GET'),

  // ---- Inventory ----
  '/api/inventory': r('inventory', 'GET POST'),
  '/api/inventory/batch-count': r('inventory', 'POST:modify'),
  '/api/inventory/physical-count': r('inventory', 'POST:modify'),
  '/api/inventory/reorder': r('inventory', 'GET'),
  '/api/inventory/value-adjust': r('inventory', 'POST:modify'),
  '/api/inventory/stock-status': r('reports_inventory', 'GET'),
  '/api/inventory/worksheet': r('reports_inventory', 'GET'),
  // Wave-2 lists: Inventory Center, POs from the reorder list, stock status by vendor.
  '/api/inventory/center': r('inventory', 'GET'),
  '/api/inventory/center/[id]': r('inventory', 'GET'),
  '/api/inventory/reorder/create-po': r('vendors', 'POST'),
  '/api/inventory/stock-by-vendor': r('reports_inventory', 'GET'),
  '/api/item-receipts': r('inventory', 'GET POST'),
  '/api/item-receipts/[id]': r('inventory', 'GET POST:modify PATCH'),
  '/api/assemblies': r('inventory', 'GET PUT PATCH'),
  '/api/assemblies/build': r('inventory', 'POST'),
  '/api/assemblies/pending': r('inventory', 'GET POST'),
  '/api/assemblies/pending/[id]': r('inventory', 'POST:modify'),
  '/api/fifo': r('inventory', 'GET POST'),
  // Advanced Inventory (team inventory): sites, bins, transfers, landed cost.
  '/api/inventory-sites': r('inventory', 'GET POST'),
  '/api/inventory-sites/[id]': r('inventory', 'GET PATCH'),
  '/api/inventory-sites/adjust': r('inventory', 'POST:modify'),
  '/api/inventory-sites/bins': r('inventory', 'GET POST'),
  '/api/inventory-sites/bins/[id]': r('inventory', 'PATCH'),
  '/api/inventory-sites/reorder-points': r('inventory', 'GET PUT'),
  '/api/inventory-sites/reports': r('reports_inventory', 'GET'),
  '/api/inventory-transfers': r('inventory', 'GET POST'),
  '/api/inventory-transfers/[id]': r('inventory', 'GET POST:modify'),
  '/api/landed-cost': r('inventory', 'GET POST'),
  '/api/landed-cost/[id]': r('inventory', 'GET POST:modify'),
  '/api/landed-cost/preview': r('inventory', 'POST:view'),

  // ---- Sales tax ----
  '/api/tax-agencies': r('sales_tax', 'GET POST'),
  '/api/tax-rates': r('sales_tax', 'GET POST'),
  '/api/tax-rates/[id]/components': r('sales_tax', 'GET PATCH'),
  '/api/tax-rates/[id]': r('sales_tax', 'PATCH'),
  '/api/pay-liabilities/sales-tax': r('sales_tax', 'GET'),
  // wave2 accountant: sales tax liability engine, adjustments, fix incorrectly recorded tax.
  '/api/accountant/sales-tax/liability': r('sales_tax', 'GET'),
  '/api/accountant/sales-tax/revenue-summary': r('sales_tax', 'GET'),
  '/api/accountant/sales-tax/adjustments': r('sales_tax', 'POST'),
  '/api/accountant/sales-tax/fix': r('sales_tax', 'GET POST:modify'),

  // ---- Time & mileage ----
  '/api/time-entries': r('time', 'GET POST'),
  '/api/time-entries/[id]': r('time', 'PATCH DELETE'),
  '/api/mileage': r('time', 'GET POST'),
  '/api/mileage/[id]': r('time', 'DELETE'),

  // ---- Employees & payroll ----
  '/api/employees': r('payroll', 'GET POST'),
  '/api/employees/[id]': r('payroll', 'GET PATCH'),
  '/api/employees/[id]/portal-password': r('payroll', 'POST:modify'),
  '/api/payroll-items': r('payroll', 'GET POST'),
  '/api/payroll-items/[id]': r('payroll', 'GET PATCH'),
  '/api/payroll': r('payroll', 'GET POST'),
  '/api/payroll/[id]': r('payroll', 'DELETE'),
  '/api/payroll/accruals': r('payroll', 'GET PUT'),
  '/api/payroll/calc': r('payroll', 'POST:view'),
  '/api/payroll/state-tax': r('payroll', 'POST:view'),
  '/api/payroll/pay-runs': r('payroll', 'GET POST'),
  '/api/payroll/paystub': r('payroll', 'GET:print'),
  '/api/payroll/unpaid-time': r('payroll', 'GET'),
  '/api/pay-liabilities': r('payroll', 'GET POST'),
  '/api/pay-liabilities/by-item': r('payroll', 'GET POST'),
  '/api/payroll/940': r('reports_payroll', 'GET'),
  '/api/payroll/941': r('reports_payroll', 'GET'),
  '/api/payroll/reports': r('reports_payroll', 'GET'),
  '/api/payroll/w2': r('reports_payroll', 'GET'),
  '/api/payroll/w3': r('reports_payroll', 'GET'),

  // ---- Reports ----
  '/api/report-builder': r('reports_financial', 'POST:view'),
  '/api/reports/balance-sheet': r('reports_financial', 'GET'),
  '/api/reports/balance-sheet-cash': r('reports_financial', 'GET'),
  '/api/reports/balance-sheet-classified': r('reports_financial', 'GET'),
  '/api/reports/budget-vs-actual': r('reports_financial', 'GET'),
  '/api/reports/budget-vs-actual-class': r('reports_financial', 'GET'),
  '/api/reports/cash-flow': r('reports_financial', 'GET'),
  '/api/reports/check-detail': r('reports_financial', 'GET'),
  '/api/reports/consolidated': r('reports_financial', 'GET'),
  '/api/reports/deposit-detail': r('reports_financial', 'GET'),
  '/api/reports/general-ledger': r('reports_financial', 'GET'),
  '/api/reports/missing-checks': r('reports_financial', 'GET'),
  '/api/reports/pl-by-class': r('reports_financial', 'GET'),
  '/api/reports/pl-comparative': r('reports_financial', 'GET'),
  '/api/reports/pl-monthly': r('reports_financial', 'GET'),
  '/api/reports/pl-percent': r('reports_financial', 'GET'),
  '/api/reports/profit-loss': r('reports_financial', 'GET'),
  '/api/reports/profit-loss-cash': r('reports_financial', 'GET'),
  '/api/reports/transaction-detail': r('reports_financial', 'GET'),
  '/api/reports/trial-balance': r('reports_financial', 'GET'),
  // wave2 reports: one route serves every standard report; runStandardReport checks the
  // report's own area (financial / sales / purchases / time). Graphs check per graph kind.
  '/api/reports/std/[report]': kind('member', 'GET'),
  '/api/reports/graphs': kind('member', 'GET'),
  '/api/reports/filter-options': kind('member', 'GET'), // names only; service requires a report area
  '/api/reports/pivot': r('reports_financial', 'GET'),
  '/api/find': r('reports_financial', 'GET'),
  '/api/reports/ar-aging': r('reports_sales', 'GET'),
  '/api/reports/ar-aging-detail': r('reports_sales', 'GET'),
  '/api/reports/collections': r('reports_sales', 'GET'),
  '/api/reports/commissions': r('reports_sales', 'GET'),
  '/api/reports/customer-statement': r('reports_sales', 'GET'),
  '/api/reports/customer-statement/pdf': r('reports_sales', 'GET:print'),
  '/api/reports/open-invoices': r('reports_sales', 'GET'),
  '/api/reports/sales-by-customer': r('reports_sales', 'GET'),
  '/api/reports/sales-by-item': r('reports_sales', 'GET'),
  '/api/reports/sales-tax-by-agency': r('sales_tax', 'GET'),
  '/api/reports/ap-aging': r('reports_purchases', 'GET'),
  '/api/reports/ap-aging-detail': r('reports_purchases', 'GET'),
  '/api/reports/purchases-by-item': r('reports_purchases', 'GET'),
  '/api/reports/purchases-by-vendor': r('reports_purchases', 'GET'),
  '/api/reports/1099': r('reports_purchases', 'GET'),
  '/api/reports/1099-pdf': r('reports_purchases', 'GET:print'),
  '/api/reports/1099-xml': r('reports_purchases', 'GET:print'),
  '/api/reports/inventory-valuation': r('reports_inventory', 'GET'),
  '/api/reports/inventory-valuation/detail': r('reports_inventory', 'GET'),
};

const ANY_REPORT: Area[] = [
  'reports_financial',
  'reports_sales',
  'reports_purchases',
  'reports_payroll',
  'reports_inventory',
];

/**
 * Page (navigation) prefixes → the area whose 'view' they need (an array = any of them). Used to
 * (a) hide sidebar entries the user can't use (cosmetic) and (b) gate server-rendered pages
 * through getServerContext. Longest prefix wins; paths not listed are open to every member
 * (their data still flows through the API map above).
 */
export const PAGE_AREAS: Record<string, Area | Area[]> = {
  '/invoices': 'customers',
  '/sales-receipts': 'customers',
  '/estimates': 'customers',
  '/estimates-followup': 'customers',
  '/sales-orders': 'customers',
  '/payments': 'customers',
  '/credit-memos': 'customers',
  '/customers': 'customers',
  '/finance-charges': 'customers',
  '/income-tracker': 'customers',
  '/collections-center': 'customers',
  '/customer-pricing': 'customers',
  '/jobs': 'customers',
  '/items': 'lists',
  '/sales-reps': 'lists',
  '/tracking': 'lists',
  '/recurring': 'lists',
  '/attachments': 'lists',
  '/letters': 'lists',
  '/leads': 'customers',
  '/templates': 'company',
  '/merge': 'lists',
  '/fixed-assets': 'lists',
  '/lists': 'lists',
  '/lists/cleanup': 'file_utilities',
  '/inventory-center': 'inventory',
  '/currencies': 'lists',
  '/purchase-orders': 'vendors',
  '/item-receipts': 'inventory',
  '/bills': 'vendors',
  '/pay-bills': 'vendors',
  '/vendor-credits': 'vendors',
  '/vendors': 'vendors',
  '/expense-reports': 'vendors',
  '/expenses': 'banking',
  '/print-checks': 'banking',
  '/loans': 'banking', // wave2 purchases: Loan Manager
  '/banking': 'banking',
  '/registers': 'banking',
  '/bank-feeds': 'banking',
  '/bank-review': 'banking',
  '/deposits': 'banking',
  '/transactions': 'banking',
  '/reconcile': 'accounting',
  '/transfers': 'accounting',
  '/journal': 'accounting',
  '/accounts': 'lists',
  '/errors': 'accounting',
  '/pay-liabilities': 'payroll',
  '/employees': 'payroll',
  '/pay-runs': 'payroll',
  '/pay-stubs': 'payroll',
  '/payroll-forms': 'reports_payroll',
  '/payroll-tax': 'payroll',
  '/sales-tax-components': 'sales_tax',
  '/fiscal-periods': 'closing',
  '/year-end': 'closing',
  '/budgets': 'company',
  '/settings': 'company',
  '/doc-numbers': 'company', // wave2 foundation: starting document numbers
  '/time-tracking': 'time',
  '/mileage': 'time',
  '/assemblies': 'inventory',
  '/inventory-ops': 'inventory',
  '/fifo': 'inventory',
  '/inventory-sites': 'inventory',
  '/inventory-transfers': 'inventory',
  '/landed-cost': 'inventory',
  '/advanced-pricing': 'lists',
  '/so-fulfillment': 'customers',
  '/receive-bill': 'vendors',
  '/ai-settings': 'company',
  '/privacy': 'company',
  '/transaction-log': 'reports_financial',
  '/audit-trail': 'reports_financial',
  // wave2 accountant
  '/accountant': 'accounting',
  '/accountant/write-off': 'customers',
  '/accountant/working-trial-balance': 'reports_financial',
  '/accountant/fix-sales-tax': 'sales_tax',
  '/accountant/sales-tax-adjustment': 'sales_tax',
  '/integrity': 'file_utilities',
  '/backup': 'file_utilities',
  '/qb-import': 'file_utilities',
  '/users': 'users',
  '/reports': ANY_REPORT, // the Report Center lists whatever the user may run
  '/reports/builder': 'reports_financial',
  '/reports/balance-sheet': 'reports_financial',
  '/reports/balance-sheet-cash': 'reports_financial',
  '/reports/balance-sheet-classified': 'reports_financial',
  '/reports/cash-flow': 'reports_financial',
  '/reports/check-detail': 'reports_financial',
  '/reports/consolidated': 'reports_financial',
  '/reports/deposit-detail': 'reports_financial',
  '/reports/general-ledger': 'reports_financial',
  '/reports/missing-checks': 'reports_financial',
  '/reports/pl-by-class': 'reports_financial',
  '/reports/pl-comparative': 'reports_financial',
  '/reports/pl-monthly': 'reports_financial',
  '/reports/pl-percent': 'reports_financial',
  '/reports/profit-loss': 'reports_financial',
  '/reports/profit-loss-cash': 'reports_financial',
  '/reports/transaction-detail': 'reports_financial',
  '/reports/trial-balance': 'reports_financial',
  '/reports/sales-by-rep': 'reports_sales',
  '/reports/statements': 'reports_sales',
  '/reports/ar-aging': 'reports_sales',
  '/reports/ar-aging-detail': 'reports_sales',
  '/reports/collections': 'reports_sales',
  '/reports/commissions': 'reports_sales',
  '/reports/customer-statement': 'reports_sales',
  '/reports/open-invoices': 'reports_sales',
  '/reports/sales-by-customer': 'reports_sales',
  '/reports/sales-by-item': 'reports_sales',
  '/reports/ap-aging': 'reports_purchases',
  '/reports/ap-aging-detail': 'reports_purchases',
  '/reports/purchases-by-item': 'reports_purchases',
  '/reports/purchases-by-vendor': 'reports_purchases',
  '/reports/1099': 'reports_purchases',
  '/reports/1099-efile': 'reports_purchases',
  '/reports/payroll-summary': 'reports_payroll',
  '/reports/inventory-valuation': 'reports_inventory',
  '/reports/inventory-sites': 'reports_inventory',
  '/reports/sales-tax': 'sales_tax',
  '/reports/closing-date-exceptions': 'closing',
  '/reports/voided-deleted': 'reports_financial',
  '/reports/reconciliation': 'accounting',
  // wave2 reports. The standard report viewer, memorized reports and graphs host reports from
  // several areas; their APIs check each report's own area (runStandardReport / graph kind).
  '/reports/std': [...ANY_REPORT, 'time'],
  '/reports/memorized': ANY_REPORT,
  '/reports/graphs': ['reports_financial', 'reports_sales', 'reports_purchases'],
  '/reports/pivot': 'reports_financial',
  '/reports/schedules': 'file_utilities',
  '/find': 'reports_financial',
};

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Convert an app/api file path (…/app/api/x/[id]/route.ts) to its route pattern (/api/x/[id]). */
export function routePatternFromFile(relPath: string): string {
  const norm = relPath.replace(/\\/g, '/');
  const idx = norm.indexOf('app/api/');
  const tail = norm.slice(idx + 'app/'.length).replace(/\/route\.(ts|tsx|js)$/, '');
  // Drop route groups "(group)" — they don't appear in URLs.
  return '/' + tail.split('/').filter((s) => !/^\(.*\)$/.test(s)).join('/');
}

const isDynamic = (seg: string) => seg.startsWith('[') && seg.endsWith(']');
const isCatchAll = (seg: string) => seg.startsWith('[...') || seg.startsWith('[[...');

/**
 * Find the route pattern matching a concrete pathname. Static segments beat dynamic ones at the
 * same position (Next.js precedence), so /api/estimates/expire never matches /api/estimates/[id].
 */
export function matchRoutePattern(
  pathname: string,
  patterns: Iterable<string> = Object.keys(API_ROUTE_PERMISSIONS),
): string | null {
  const segs = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  let best: { pattern: string; score: number[] } | null = null;
  for (const pattern of patterns) {
    const psegs = pattern.split('/').filter(Boolean);
    const score: number[] = [];
    let ok = true;
    for (let i = 0; i < psegs.length; i++) {
      const p = psegs[i];
      if (isCatchAll(p)) {
        if (i >= segs.length && !p.startsWith('[[')) ok = false;
        score.push(0);
        i = psegs.length; // consumes the rest
        break;
      }
      if (i >= segs.length) {
        ok = false;
        break;
      }
      if (isDynamic(p)) score.push(1);
      else if (p === segs[i]) score.push(2);
      else {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const hasCatchAll = psegs.some(isCatchAll);
    if (!hasCatchAll && psegs.length !== segs.length) continue;
    if (!best || compareScore(score, best.score) > 0) best = { pattern, score };
  }
  return best?.pattern ?? null;
}

function compareScore(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The rule for a concrete API request, or null when the path/method is unmapped (callers must
 * treat null as DENY).
 */
export function apiRuleFor(pathname: string, method: string): RouteRule | null {
  const pattern = matchRoutePattern(pathname);
  if (!pattern) return null;
  const m = method.toUpperCase() as HttpMethod;
  // HEAD is answered by GET handlers.
  const rules = API_ROUTE_PERMISSIONS[pattern];
  return rules[m] ?? (m === ('HEAD' as HttpMethod) ? (rules.GET ?? null) : null);
}

/**
 * The areas a page path needs 'view' of (ANY one suffices), or null when the page is open to
 * every member.
 */
export function pageAreasFor(pathname: string): Area[] | null {
  let best: string | null = null;
  for (const prefix of Object.keys(PAGE_AREAS)) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) {
      if (!best || prefix.length > best.length) best = prefix;
    }
  }
  if (!best) return null;
  const v = PAGE_AREAS[best];
  return Array.isArray(v) ? v : [v];
}
