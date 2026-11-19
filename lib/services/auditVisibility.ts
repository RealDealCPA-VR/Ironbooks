/**
 * Which audit-trail and transaction-log entries a person may read.
 *
 * Both logs keep the full before / after snapshot of every change: an employee's pay rate, W-4
 * and home address, a paycheck, a user's e-mail and roles. Reading them needs only the Audit Trail
 * right (Reports — Financial), which roles with no payroll access hold (Bookkeeper). So each entry
 * is shown only to someone who may view the record it is about: every `entityType` the app writes
 * is mapped to the permission activity (or area) that owns it — the record kinds notes, to-dos and
 * attachments already use (lib/permissions/recordActivities.ts), plus the kinds only the logs know.
 *
 *  - An entry of a kind not listed here (a kind added later, or one an older version wrote) is
 *    shown only to an Admin: fail closed.
 *  - Notes, to-dos, documents and undo records are about another record (their snapshot names
 *    its kind as `entityType`): they need that record's activity, before and after the change.
 *  - Admins, and trusted contexts (no `access`: system jobs, tests), see everything, as before.
 *
 * Hidden entries are left out of the rows AND the counts, the filters' lists and the exports, so
 * the only trace of them is that the log's own record count (integrity check) is larger.
 */
import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { auditLogs } from '@/lib/db/schema';
import { canRef, type AccessRef, type EffectiveAccess } from '@/lib/permissions/model';
import { RECORD_ACTIVITY, recordActivity } from '@/lib/permissions/recordActivities';

/**
 * Kinds written by writeAudit / logTransaction that recordActivity() does not know, with the
 * activity (or area) that owns them. Keep in step with every `entityType:` the services write
 * (lib/services/security1.auditTrail.test.ts checks the list against the code).
 */
export const AUDIT_ENTITY_REFS: Record<string, AccessRef> = {
  // Banking
  bank_account: 'banking.bank_accounts',
  bank_transaction: 'banking.bank_feeds',
  bank_rule_dismissal: 'banking.bank_rules',
  transaction_rule: 'banking.bank_rules',
  check_print_settings: 'banking.print_checks',
  // Sales tax and payroll liability checks are bank checks (their registers show them too).
  payment_check: 'banking.write_checks',
  loan: 'banking.loans',
  loan_payment: 'banking.loans',
  // Lists / Centers
  class: 'lists.classes',
  location: 'lists.locations',
  price_level: 'lists.price_levels',
  price_rule: 'lists.price_levels',
  pricing_settings: 'lists.price_levels',
  customer_type: 'lists.type_lists',
  vendor_type: 'lists.type_lists',
  job_type: 'lists.other_lists',
  payment_terms: 'lists.other_lists',
  ship_via: 'lists.other_lists',
  payment_method: 'lists.other_lists',
  customer_message: 'lists.other_lists',
  vehicle: 'lists.other_lists',
  recurring_template: 'lists.memorized',
  fixed_asset: 'lists.fixed_assets',
  sales_rep: 'lists.sales_reps',
  receipt_scan: 'lists.doc_center',
  receipt_settings: 'lists.doc_center',
  receipt_upload_link: 'lists.doc_center',
  currency: 'lists.currencies',
  letter_template: 'lists.letters',
  billing_rate_level: 'lists.billing_rates',
  uom_set: 'lists.uom',
  // Customers & Receivables
  billing_group: 'customers.batch_invoicing',
  retainage_billing: 'customers.invoices',
  payment_reminder: 'customers.invoices',
  collection_note: 'customers.collections',
  customer_price: 'customers.pricing',
  invoice_write_off: 'customers.write_off',
  // Vendors & Payables
  vendor_credit_application: 'vendors.vendor_credits',
  expense_report: 'vendors.expense_reports',
  // Employees & Payroll
  pay_run: 'payroll.paychecks',
  payroll_item: 'payroll.payroll_items',
  payroll_liability_adjustment: 'payroll.adjustments',
  payroll_ytd_adjustment: 'payroll.adjustments',
  payroll_state_setting: 'payroll.setup',
  workers_comp_code: 'payroll.setup',
  // Inventory
  inventory_adjustment: 'inventory.adjust',
  item_receipt: 'inventory.item_receipts',
  receiving_settings: 'inventory.item_receipts',
  assembly_bom: 'inventory.assemblies',
  pending_build: 'inventory.assemblies',
  inventory_site: 'inventory.sites',
  inventory_bin: 'inventory.sites',
  item_site_settings: 'inventory.sites',
  inventory_transfer: 'inventory.transfers',
  landed_cost_allocation: 'inventory.landed_cost',
  inventory_layer: 'inventory.fifo',
  // Sales tax
  sales_tax_code: 'sales_tax.codes',
  tax_rate: 'sales_tax.codes',
  tax_rate_components: 'sales_tax.codes',
  tax_agency: 'sales_tax.codes',
  sales_tax_adjustment: 'sales_tax.adjust',
  sales_tax_fix: 'sales_tax.adjust',
  sales_tax_line_link: 'sales_tax.adjust',
  // Time & Mileage
  time_entry: 'time.timesheets',
  mileage_log: 'time.mileage',
  // Reports (saved report set-ups: their names and settings, not report data)
  memorized_report: 'reports_financial.custom',
  memorized_report_group: 'reports_financial.custom',
  commented_report: 'reports_financial.custom',
  // Sensitive Accounting
  reconciliation: 'accounting.reconcile',
  error_correction: 'accounting.error_check',
  month_end_close: 'accounting.month_end',
  home_currency_adjustment: 'accounting.currency_adjust',
  ai_proposal: 'accounting.ai_proposals',
  batch_void: 'accounting.accountant_tools',
  batch_deleted_txn: 'accounting.accountant_tools',
  client_review_snapshot: 'accounting.accountant_tools',
  client_review_task: 'accounting.accountant_tools',
  list_change_review: 'accounting.accountant_tools',
  working_tb_note: 'accounting.accountant_tools',
  // Company & Preferences
  company: 'company.preferences',
  company_settings: 'company.preferences',
  budget: 'company.budgets',
  forecast: 'company.budgets',
  budgetLine: 'company.budgets',
  form_template: 'company.templates',
  ai_settings: 'company.ai',
  network_policy: 'company.network',
  email_settings: 'company.send_forms',
  // Closing Date / Periods
  closing_date_exception: 'closing.closing_date',
  fiscal_period: 'closing.fiscal_periods',
  // Users & Roles
  user: 'users.users',
  user_company: 'users.users',
  user_session: 'users.users',
  user_preferences: 'users.users',
  role: 'users.roles',
  password_policy: 'users.password_rules',
  company_file: 'users.file_password',
  file_password: 'users.file_password',
  // File Utilities
  company_restore: 'file_utilities.restore',
  condense: 'file_utilities.condense',
  file_import: 'file_utilities.import',
  qb_gl_import: 'file_utilities.import',
  qb_open_item_document: 'file_utilities.import',
  qb_open_item_total: 'file_utilities.import',
  accountant_copy: 'file_utilities.accountants_copy',
  period_copy: 'file_utilities.accountants_copy',
  data_rebuild: 'file_utilities.integrity',
  sandbox: 'file_utilities.sandbox',
  single_user_mode: 'file_utilities.single_user',
  report_schedule: 'file_utilities.schedules',
};

/**
 * Kinds about ANOTHER record, whose snapshot names that record's kind as `entityType`. `unlinked`
 * is the rule when neither snapshot names one: an activity, 'all' (anyone who may read the log)
 * or 'none' (Admins only).
 */
export const AUDIT_LINKED_KINDS: Record<string, { unlinked: AccessRef | 'all' | 'none' }> = {
  // A document filed nowhere sits in the Doc Center inbox (lib/services/attachments.ts).
  attachment: { unlinked: 'lists.doc_center' },
  // A note is always on a record.
  note: { unlinked: 'none' },
  // An unlinked to-do is anyone's (lib/services/todos.ts canSeeTodoLink).
  todo: { unlinked: 'all' },
  // An undo names the record it undid.
  undo: { unlinked: 'none' },
};

/** Kinds with nothing in them that is anyone's business: the log's own start record. */
export const AUDIT_OPEN_KINDS = new Set(['transaction_log']);

/** The activity / area owning a plain kind (null for linked, open and unknown kinds). */
export function auditEntityRef(entityType: string): AccessRef | null {
  if (Object.prototype.hasOwnProperty.call(AUDIT_LINKED_KINDS, entityType)) return null;
  return recordActivity(entityType) ?? (Object.prototype.hasOwnProperty.call(AUDIT_ENTITY_REFS, entityType) ? AUDIT_ENTITY_REFS[entityType] : null);
}

/** Every kind this module knows (plain, linked and open). */
export function knownAuditEntityTypes(): string[] {
  const plain = new Set<string>([...Object.keys(RECORD_ACTIVITY), ...Object.keys(AUDIT_ENTITY_REFS)]);
  return [...plain, ...Object.keys(AUDIT_LINKED_KINDS), ...AUDIT_OPEN_KINDS];
}

/** True when the logs are shown in full (an Admin, or a trusted context). */
export function seesWholeLog(access: EffectiveAccess | null | undefined): boolean {
  return !access || access.isAdmin;
}

function canSeeRef(access: EffectiveAccess, ref: AccessRef | 'all' | 'none'): boolean {
  if (ref === 'all') return true;
  if (ref === 'none') return false;
  return canRef(access, ref, 'view');
}

function linkedKind(v: unknown): string | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const t = (v as Record<string, unknown>).entityType;
  return typeof t === 'string' && t ? t : null;
}

/** A record kind's own visibility (a linked record's kind, or a plain kind). */
function canSeeKind(access: EffectiveAccess, kind: string): boolean {
  if (AUDIT_OPEN_KINDS.has(kind)) return true;
  const ref = auditEntityRef(kind);
  return ref !== null && canSeeRef(access, ref);
}

/**
 * May `access` read an entry of `entityType` with these snapshots? (The transaction log's rule;
 * listAuditLogs applies the same rule in SQL, auditVisibilitySql.)
 */
export function canSeeAuditEntry(
  access: EffectiveAccess | null | undefined,
  entityType: string,
  oldValues: unknown,
  newValues: unknown,
): boolean {
  if (seesWholeLog(access)) return true;
  const a = access!;
  const linked = Object.prototype.hasOwnProperty.call(AUDIT_LINKED_KINDS, entityType) ? AUDIT_LINKED_KINDS[entityType] : null;
  if (!linked) return canSeeKind(a, entityType);
  const kinds = [linkedKind(oldValues), linkedKind(newValues)].filter((k): k is string => k !== null);
  if (!kinds.length) return canSeeRef(a, linked.unlinked);
  return kinds.every((k) => canSeeKind(a, k));
}

/** canSeeAuditEntry for a transaction-log record (its data is { old, new }). */
export function canSeeLogRecord(
  access: EffectiveAccess | null | undefined,
  record: { entityType: string; data: unknown },
): boolean {
  if (seesWholeLog(access)) return true;
  const d = (record.data ?? {}) as { old?: unknown; new?: unknown };
  return canSeeAuditEntry(access, record.entityType, d?.old ?? null, d?.new ?? null);
}

/**
 * SQL condition on audit_logs: the entries `access` may read (undefined: all of them). The same
 * rule as canSeeAuditEntry, so the page, its total and its filters agree.
 */
export function auditVisibilitySql(access: EffectiveAccess | null | undefined): SQL | undefined {
  if (seesWholeLog(access)) return undefined;
  const a = access!;
  const plain = knownAuditEntityTypes().filter(
    (k) => !Object.prototype.hasOwnProperty.call(AUDIT_LINKED_KINDS, k) && canSeeKind(a, k),
  );
  const parts: SQL[] = [];
  if (plain.length) parts.push(inArray(auditLogs.entityType, plain));
  const newKind = sql`(${auditLogs.newValues} ->> 'entityType')`;
  const oldKind = sql`(${auditLogs.oldValues} ->> 'entityType')`;
  const visibleKinds = knownAuditEntityTypes().filter((k) => canSeeKind(a, k));
  const inVisible = (expr: SQL) =>
    visibleKinds.length ? sql`${expr} IN (${sql.join(visibleKinds.map((k) => sql`${k}`), sql`, `)})` : sql`false`;
  for (const [kind, rule] of Object.entries(AUDIT_LINKED_KINDS)) {
    const unlinked = canSeeRef(a, rule.unlinked) ? sql`true` : sql`false`;
    parts.push(
      and(
        eq(auditLogs.entityType, kind),
        sql`(CASE WHEN ${newKind} IS NULL AND ${oldKind} IS NULL THEN ${unlinked}
              ELSE (${newKind} IS NULL OR ${inVisible(newKind)}) AND (${oldKind} IS NULL OR ${inVisible(oldKind)}) END)`,
      )!,
    );
  }
  return parts.length ? or(...parts) : sql`false`;
}
