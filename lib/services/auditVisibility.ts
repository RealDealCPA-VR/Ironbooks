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
 *  - Or to someone who may run the reports that already show those records (REPORT_FALLBACK): the
 *    General Ledger and the sales reports show the invoices, the payroll reports the employees and
 *    their pay. So the Reports Only role (report rights, no entry rights) reads the audit trail of
 *    what its reports cover. Kinds about users, roles, sign-in, sessions, file protection and the
 *    company's security settings have no such report: only their own area (in practice Admins).
 *  - An entry of a kind not listed here (a kind added later, or one an older version wrote) is
 *    shown only to an Admin: fail closed.
 *  - Notes, to-dos, documents and undo records are about another record (their snapshot names
 *    its kind as `entityType`): they need that record's activity, before and after the change.
 *  - Admins, and trusted contexts (no `access`: system jobs, tests), see everything, as before.
 *
 * Hidden entries are left out of the rows AND the counts, the filters' lists and the exports, so
 * the only trace of them is that the log's own record count (integrity check) is larger.
 *
 * An entry a person may read is shown through auditValuesFor: no credential material, SSNs and
 * account numbers masked by field name for their roles, and the account number in memo text
 * ("Acct # 000123456789", the memo a check gets when it is left blank) masked too.
 */
import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { auditLogs } from '@/lib/db/schema';
import { maskAccountsInText } from '@/lib/agent/guards';
import { maskSensitive, stripSecrets } from '@/lib/permissions/mask';
import { canRef, refArea, type AccessRef, type Area, type EffectiveAccess } from '@/lib/permissions/model';
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
  // Agents, what they asked a person to approve and the standing permission people gave them
  // (agent full access): managed on Users & Roles > Users, like the agent itself. A decision's
  // record names the operation and the agent, never the input or a secret, but can hold the
  // person's note, the app's message and a grant's limits: the audit trail shows those only to
  // someone who may also view the operation's work (auditTrail.ts auditEntryValuesFor), and
  // never any of these records to an agent (auditReaderFor).
  agent: 'users.users',
  agent_permission_request: 'users.users',
  agent_grant: 'users.users',
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

/**
 * The report categories (lib/permissions/model.ts REPORT_AREAS) that show the records of an entry
 * area: being allowed to VIEW one of them (the whole category, as the model checks an area) is
 * enough to read the audit entries of that area's records. By area, then finer by activity (Lists
 * and Company mix bookkeeping lists with set-up screens) and by kind. An area, activity or kind
 * with no entry here has no report fallback: users and roles, sign-in, file utilities (backups,
 * restores, the company file), the company's security settings (AI keys, network, mail server),
 * documents, letters and form templates, and Time & Mileage (its reports belong to its own area).
 */
const AREA_REPORTS: Partial<Record<Area, Area[]>> = {
  banking: ['reports_financial'],
  accounting: ['reports_financial'],
  closing: ['reports_financial'],
  sales_tax: ['reports_financial'],
  customers: ['reports_sales'],
  vendors: ['reports_purchases'],
  payroll: ['reports_payroll'],
  inventory: ['reports_inventory'],
};

const ACTIVITY_REPORTS: Record<string, Area[]> = {
  'lists.chart_of_accounts': ['reports_financial'],
  'lists.classes': ['reports_financial'],
  'lists.locations': ['reports_financial'],
  'lists.other_lists': ['reports_financial'],
  'lists.memorized': ['reports_financial'],
  'lists.fixed_assets': ['reports_financial'],
  'lists.currencies': ['reports_financial'],
  'lists.items': ['reports_sales', 'reports_purchases', 'reports_inventory'],
  'lists.price_levels': ['reports_sales'],
  'lists.sales_reps': ['reports_sales'],
  'lists.billing_rates': ['reports_sales'],
  'lists.uom': ['reports_inventory'],
  'inventory.item_receipts': ['reports_inventory', 'reports_purchases'],
  'company.preferences': ['reports_financial'],
  'company.budgets': ['reports_financial'],
  // Users & Roles, File Utilities, Time & Mileage, Doc Center, letters, form templates, AI /
  // network / mail-server settings, document numbers, the company file: none (see above).
  'lists.doc_center': [],
  'lists.letters': [],
  'lists.type_lists': [],
  'company.templates': [],
  'company.ai': [],
  'company.network': [],
  'company.send_forms': [],
  'company.company_file': [],
  'company.doc_numbers': [],
};

/** Kinds whose report category is not their activity's (Customer & Vendor Types share one). */
const KIND_REPORTS: Record<string, Area[]> = {
  customer_type: ['reports_sales'],
  vendor_type: ['reports_purchases'],
};

/** The report categories whose view right also shows a kind's audit entries (none: [] ). */
export function auditReportFallback(entityType: string): Area[] {
  if (Object.prototype.hasOwnProperty.call(KIND_REPORTS, entityType)) return KIND_REPORTS[entityType];
  const ref = auditEntityRef(entityType);
  if (!ref) return [];
  if (Object.prototype.hasOwnProperty.call(ACTIVITY_REPORTS, ref)) return ACTIVITY_REPORTS[ref];
  const area = refArea(ref);
  return (area === 'lists' || area === 'company' ? undefined : AREA_REPORTS[area]) ?? [];
}

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

/**
 * A record kind's own visibility (a linked record's kind, or a plain kind): its entry area, or a
 * report category that shows its records (auditReportFallback). Unknown kinds: neither.
 */
function canSeeKind(access: EffectiveAccess, kind: string): boolean {
  if (AUDIT_OPEN_KINDS.has(kind)) return true;
  const ref = auditEntityRef(kind);
  if (ref === null) return false;
  if (canSeeRef(access, ref)) return true;
  return auditReportFallback(kind).some((reportArea) => canRef(access, reportArea, 'view'));
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

/**
 * Keys holding memo text: a check's memo, a journal line's memo (every memo column in the schema
 * is named `memo`; "lineMemo" and the like are covered too).
 */
const MEMO_KEY = /memo$/i;

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** A copy of `v` with the account number in every memo text masked (maskAccountsInText). */
function maskMemoText(v: unknown, key: string | null): unknown {
  if (typeof v === 'string') return key !== null && MEMO_KEY.test(key) ? maskAccountsInText(v) : v;
  if (Array.isArray(v)) return v.map((x) => maskMemoText(x, key));
  if (!isPlainRecord(v)) return v; // Date, Decimal …: as they are
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) out[k] = maskMemoText(val, k);
  return out;
}

/**
 * An entry's before / after snapshot as this reader may see it: the audit trail's entry
 * (auditTrail.ts getAuditLog, through auditEntryValuesFor). The transaction log's records carry
 * the same snapshots; auditTrail.ts logRecordDataFor is this rule for them, but GET
 * /api/transaction-log does not use it yet (it masks by field name only, maskForContext), so the
 * memo text below is still shown there in full. Its CSV export has no snapshots.
 *  - Credential material is never in it, whoever asks (stripSecrets; trusted contexts too).
 *  - For a person, SSNs and account numbers are masked by field name for their roles
 *    (maskSensitive), as every other answer is.
 *  - Without "view full account numbers", so is the number in memo text. A check whose memo is
 *    left blank stores the payee's full account number there ("Acct # 000123456789", written by
 *    liabilityPayments.ts and printQueue.ts) and its audit row keeps that text; older Sales Tax
 *    Payment entries carry it on a journal line's memo. It reads "Acct # ••••6789", as the check's
 *    own answers show it (liabilityPayments.ts checkMemoFor). Text the mask itself wrote comes back
 *    unchanged (maskAccountsInText keeps "••••6789" as it is), and a typed memo with an account
 *    label is masked after the label too, which errs on the safe side.
 * Trusted contexts (no `access`: system jobs, tests) see the rest as stored.
 */
export function auditValuesFor<T>(access: EffectiveAccess | null | undefined, value: T): T {
  const clean = stripSecrets(value);
  if (!access) return clean;
  const masked = maskSensitive(clean, access);
  return access.flags.fullAccountNumbers ? masked : (maskMemoText(masked, null) as T);
}
