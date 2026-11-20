/**
 * Agent full access: how the hand-written classification is split into files.
 *
 * Every API route belongs to exactly one bucket, by the first segment of its path after /api/.
 * Each bucket is one file in this folder, so areas can be classified and reviewed separately.
 * classes/buckets.test.ts fails when a segment is in no bucket or in two.
 */
export const CLASS_BUCKETS = {
  sales: [
    'customers', 'jobs', 'leads', 'customer-prices', 'invoices', 'estimates', 'sales-orders', 'fulfillment',
    'sales-receipts', 'payments', 'credit-memos', 'finance-charges', 'billables', 'billing-groups',
    'income-tracker', 'collections', 'sales-forms', 'job-type-assign', 'sales-reps',
  ],
  purchases: [
    'vendors', 'bills', 'bill-payments', 'vendor-credits', 'purchase-orders', 'receiving', 'expense-reports',
    'item-receipts', 'inventory', 'inventory-sites', 'inventory-transfers', 'assemblies', 'fifo', 'landed-cost',
  ],
  banking: [
    'bank-accounts', 'bank-rules', 'bank-transactions', 'banking', 'rules', 'deposits', 'expenses',
    'check-numbers', 'checks', 'print-queue', 'registers', 'reconciliations', 'transfers', 'journal-entries',
    'demo-feed', 'recurring', 'smart-defaults',
  ],
  lists: [
    'account-roles', 'accounts', 'classes', 'locations', 'lists', 'type-lists', 'custom-fields', 'currencies',
    'notes', 'todos', 'calendar', 'billing-rate-levels', 'uom-sets', 'merge', 'cleanup', 'items', 'pricing', 'terms',
  ],
  planning: [
    'tax-agencies', 'tax-rates', 'sales-tax', 'budgets', 'time-entries', 'mileage', 'fixed-assets', 'loans',
    'reminders', 'attention',
  ],
  payroll: ['employees', 'payroll', 'payroll-items', 'pay-liabilities', 'portal'],
  reports: [
    'reports', 'report-builder', 'report-schedules', 'memorized-reports', 'commented-reports', 'dashboard',
    'audit-trail', 'transaction-log', 'why-changed', 'find', 'search', 'export',
  ],
  documents: [
    'attachments', 'receipts', 'form-templates', 'letters', 'email', 'ai', 'errors', 'command-bar', 'import',
    'qb-import', 'product-info',
  ],
  company: [
    'company', 'preferences', 'doc-numbers', 'network-policy', 'accountant', 'accountant-copy', 'fiscal-periods',
    'month-end-close', 'year-end-close', 'period-copy', 'undo',
  ],
  admin: [
    'users', 'roles', 'file-lock', 'file-protection', 'unlock', 'sessions', 'single-user', 'auth',
    'device-security', 'handshake', 'agent', 'agents', 'agent-requests', 'agent-grants', 'backup', 'backups',
    'condense', 'integrity', 'portable', 'company-file', 'companies', 'sandbox',
  ],
} as const;

export type ClassBucket = keyof typeof CLASS_BUCKETS;
export const CLASS_BUCKET_NAMES = Object.keys(CLASS_BUCKETS) as ClassBucket[];

/** The first path segment after /api/ ("/api/invoices/[id]/email" → "invoices"). */
export function routeSegment(pattern: string): string {
  return pattern.split('/')[2] ?? '';
}

export function bucketOfRoute(pattern: string): ClassBucket | null {
  const seg = routeSegment(pattern);
  for (const name of CLASS_BUCKET_NAMES) {
    if ((CLASS_BUCKETS[name] as readonly string[]).includes(seg)) return name;
  }
  return null;
}
