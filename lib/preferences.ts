/**
 * Preferences model (QB Edit > Preferences): the categorized catalogue, defaults and pure helpers.
 *
 * Two scopes, exactly like QuickBooks:
 *  - COMPANY preferences live in companies.settings (lib/services/company.ts whitelists the keys)
 *    and apply to everyone in the company file. Only users with Company & Preferences: modify can
 *    change them.
 *  - MY preferences live in user_preferences (one row per user per company) and only change how
 *    the app behaves for the signed-in person.
 *
 * Pure module (no DB / Node imports) so the server services, API routes and the client hook
 * (lib/usePreferences.ts) share one source of truth for defaults and the helpers below.
 */

export const TERMS_VALUES = ['due_on_receipt', 'net_15', 'net_30', 'net_60'] as const;
export type TermsValue = (typeof TERMS_VALUES)[number];

/** Days until due for each payment-terms code. */
export const TERMS_DAYS: Record<TermsValue, number> = {
  due_on_receipt: 0,
  net_15: 15,
  net_30: 30,
  net_60: 60,
};

export const REMINDER_KEYS = [
  'checksToPrint',
  'invoicesToPrint',
  'overdueInvoices',
  'salesReceiptsToPrint',
  'salesOrdersToPrint',
  'inventoryToReorder',
  'billsToPay',
  'memorizedTransactionsDue',
  'moneyToDeposit',
  'purchaseOrdersToPrint',
  'toDoNotes',
] as const;
export type ReminderKey = (typeof REMINDER_KEYS)[number];
export type ReminderMode = 'summary' | 'list' | 'off';
export interface ReminderSetting {
  mode: ReminderMode;
  /** Look-ahead window: "remind me N days before" (or "after due date" for overdue invoices). */
  days: number;
}

export const REMINDER_LABELS: Record<ReminderKey, string> = {
  checksToPrint: 'Checks to print',
  invoicesToPrint: 'Invoices / credit memos to print',
  overdueInvoices: 'Overdue invoices',
  salesReceiptsToPrint: 'Sales receipts to print',
  salesOrdersToPrint: 'Open sales orders',
  inventoryToReorder: 'Inventory to reorder',
  billsToPay: 'Bills to pay',
  memorizedTransactionsDue: 'Memorized transactions due',
  moneyToDeposit: 'Money to deposit',
  purchaseOrdersToPrint: 'Open purchase orders',
  toDoNotes: 'To-dos',
};

export const DEFAULT_REMINDERS: Record<ReminderKey, ReminderSetting> = {
  checksToPrint: { mode: 'summary', days: 5 },
  invoicesToPrint: { mode: 'summary', days: 5 },
  overdueInvoices: { mode: 'summary', days: 5 },
  salesReceiptsToPrint: { mode: 'summary', days: 0 },
  salesOrdersToPrint: { mode: 'summary', days: 5 },
  inventoryToReorder: { mode: 'summary', days: 0 },
  billsToPay: { mode: 'summary', days: 10 },
  memorizedTransactionsDue: { mode: 'summary', days: 5 },
  moneyToDeposit: { mode: 'summary', days: 0 },
  purchaseOrdersToPrint: { mode: 'summary', days: 5 },
  toDoNotes: { mode: 'list', days: 0 },
};

export const FORM_TYPES = [
  'invoice',
  'estimate',
  'sales_receipt',
  'credit_memo',
  'sales_order',
  'purchase_order',
  'statement',
] as const;
export type FormType = (typeof FORM_TYPES)[number];

export const FORM_TYPE_LABELS: Record<FormType, string> = {
  invoice: 'Invoice',
  estimate: 'Estimate',
  sales_receipt: 'Sales Receipt',
  credit_memo: 'Credit Memo',
  sales_order: 'Sales Order',
  purchase_order: 'Purchase Order',
  statement: 'Statement',
};

export interface SendFormDefaults {
  subject: string;
  body: string;
}

/** Default email wording per form (Send Forms preferences). Merge fields: see lib/services/letters.ts. */
export const DEFAULT_SEND_FORMS: Record<FormType, SendFormDefaults> = {
  invoice: {
    subject: 'Invoice {{number}} from {{company.name}}',
    body:
      'Dear {{customer.name}},\n\nYour invoice is attached. Please remit payment at your earliest convenience.\n\nTotal: {{total}}\nBalance due: {{balance}}\n\nThank you for your business — we appreciate it very much.\n\nSincerely,\n{{company.name}}',
  },
  estimate: {
    subject: 'Estimate {{number}} from {{company.name}}',
    body:
      'Dear {{customer.name}},\n\nPlease review the attached estimate. Feel free to contact us if you have any questions.\n\nSincerely,\n{{company.name}}',
  },
  sales_receipt: {
    subject: 'Sales Receipt {{number}} from {{company.name}}',
    body: 'Dear {{customer.name}},\n\nYour sales receipt is attached. Thank you for your business.\n\nSincerely,\n{{company.name}}',
  },
  credit_memo: {
    subject: 'Credit Memo {{number}} from {{company.name}}',
    body: 'Dear {{customer.name}},\n\nYour credit memo is attached.\n\nSincerely,\n{{company.name}}',
  },
  sales_order: {
    subject: 'Sales Order {{number}} from {{company.name}}',
    body: 'Dear {{customer.name}},\n\nYour sales order is attached. Thank you for your order.\n\nSincerely,\n{{company.name}}',
  },
  purchase_order: {
    subject: 'Purchase Order {{number}} from {{company.name}}',
    body: 'Dear {{vendor.name}},\n\nPlease find our purchase order attached.\n\nSincerely,\n{{company.name}}',
  },
  statement: {
    subject: 'Statement from {{company.name}}',
    body: 'Dear {{customer.name}},\n\nYour statement is attached. Please remit payment for any balance due.\n\nSincerely,\n{{company.name}}',
  },
};

/** Company-wide preferences: every key with its default (companies.settings holds overrides). */
export interface CompanyPreferences {
  // Accounting
  accountNumbersEnabled: boolean;
  requireAccountNumbers: boolean;
  /** Require an account on every transaction line (QB "Require accounts"). */
  requireAccounts: boolean;
  classTrackingEnabled: boolean;
  warnUnassignedClass: boolean;
  autoAssignJeNumbers: boolean;
  warnPastDatesEnabled: boolean;
  warnPastDays: number;
  warnFutureDatesEnabled: boolean;
  warnFutureDays: number;
  // Checking
  defaultCheckAccountId: string | null;
  defaultBillPaymentAccountId: string | null;
  defaultDepositAccountId: string | null;
  defaultPaycheckAccountId: string | null;
  warnDuplicateCheckNumbers: boolean;
  autofillPayeeAccount: boolean;
  // General (company)
  timezone: string;
  currency: string;
  fiscalYearEnd: string;
  // Jobs & Estimates
  estimatesEnabled: boolean;
  progressInvoicingEnabled: boolean;
  warnDuplicateEstimateNumbers: boolean;
  dontPrintZeroAmountItems: boolean;
  // Items & Inventory
  inventoryEnabled: boolean;
  purchaseOrdersEnabled: boolean;
  warnDuplicatePoNumbers: boolean;
  negativeStockWarning: boolean;
  unitsOfMeasureEnabled: boolean;
  // Payments
  autoApplyPayments: boolean;
  autoCalculatePayments: boolean;
  useUndepositedFunds: boolean;
  // Purchases & Vendors (Bills)
  defaultVendorTerms: TermsValue;
  defaultExpenseAccountId: string | null;
  warnDuplicateBillNumbers: boolean;
  autoUseVendorCredits: boolean;
  // Reminders
  reminders: Record<ReminderKey, ReminderSetting>;
  // Reports
  reportBasis: 'accrual' | 'cash';
  agingFrom: 'due_date' | 'transaction_date';
  accountDisplay: 'name' | 'description' | 'both';
  // Sales & Customers
  defaultCustomerTerms: TermsValue;
  defaultInvoiceMemo: string;
  defaultShipVia: string;
  defaultFob: string;
  priceLevelsEnabled: boolean;
  salesOrdersEnabled: boolean;
  warnDuplicateInvoiceNumbers: boolean;
  // Sales Tax
  salesTaxEnabled: boolean;
  salesTaxBasis: 'accrual' | 'cash';
  salesTaxFrequency: 'monthly' | 'quarterly' | 'annually';
  // Send Forms
  sendForms: Record<FormType, SendFormDefaults>;
  // Time & Expenses
  timeTrackingEnabled: boolean;
  firstDayOfWeek: 'sunday' | 'monday';
  trackReimbursedAsIncome: boolean;
  defaultMarkupPercent: number;
  // Multiple Currencies
  multiCurrencyEnabled: boolean;
  // Payroll
  /** QB Payroll & Employees "Full payroll" vs "No payroll": off hides pay runs and payroll forms. */
  payrollEnabled: boolean;
  payrollPayPeriod: 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';
  payrollStandardHours: number;
  payrollExpenseAccountId: string | null;
  payrollLiabilityAccountId: string | null;
}

// Feature switches default to ON (class tracking, progress invoicing and units of measure too) so
// company files from before these switches were enforced keep working; the setup interview asks
// each question and saves an explicit on/off for new companies.
export const DEFAULT_COMPANY_PREFERENCES: CompanyPreferences = {
  accountNumbersEnabled: true,
  requireAccountNumbers: false,
  requireAccounts: true,
  classTrackingEnabled: true,
  warnUnassignedClass: false,
  autoAssignJeNumbers: true,
  warnPastDatesEnabled: true,
  warnPastDays: 90,
  warnFutureDatesEnabled: true,
  warnFutureDays: 30,
  defaultCheckAccountId: null,
  defaultBillPaymentAccountId: null,
  defaultDepositAccountId: null,
  defaultPaycheckAccountId: null,
  warnDuplicateCheckNumbers: true,
  autofillPayeeAccount: true,
  timezone: 'America/New_York',
  currency: 'USD',
  fiscalYearEnd: '12-31',
  estimatesEnabled: true,
  progressInvoicingEnabled: true,
  warnDuplicateEstimateNumbers: true,
  dontPrintZeroAmountItems: false,
  inventoryEnabled: true,
  purchaseOrdersEnabled: true,
  warnDuplicatePoNumbers: true,
  negativeStockWarning: true,
  unitsOfMeasureEnabled: true,
  autoApplyPayments: true,
  autoCalculatePayments: true,
  useUndepositedFunds: true,
  defaultVendorTerms: 'net_30',
  defaultExpenseAccountId: null,
  warnDuplicateBillNumbers: true,
  autoUseVendorCredits: false,
  reminders: DEFAULT_REMINDERS,
  reportBasis: 'accrual',
  agingFrom: 'due_date',
  accountDisplay: 'name',
  defaultCustomerTerms: 'net_30',
  defaultInvoiceMemo: '',
  defaultShipVia: '',
  defaultFob: '',
  priceLevelsEnabled: true,
  salesOrdersEnabled: true,
  warnDuplicateInvoiceNumbers: true,
  salesTaxEnabled: true,
  salesTaxBasis: 'accrual',
  salesTaxFrequency: 'quarterly',
  sendForms: DEFAULT_SEND_FORMS,
  timeTrackingEnabled: true,
  firstDayOfWeek: 'monday',
  trackReimbursedAsIncome: false,
  defaultMarkupPercent: 0,
  multiCurrencyEnabled: false,
  payrollEnabled: true,
  payrollPayPeriod: 'biweekly',
  payrollStandardHours: 40,
  payrollExpenseAccountId: null,
  payrollLiabilityAccountId: null,
};

/** Per-user ("My Preferences") settings. */
export interface MyPreferences {
  // General
  enterMovesBetweenFields: boolean;
  beepOnRecord: boolean;
  autoDecimalPoint: boolean;
  warnWhenEditing: boolean;
  warnWhenDeleting: boolean;
  /** 'today' | 'last' — default date for new transactions. */
  defaultDate: 'today' | 'last';
  autoRecallLastTransaction: boolean;
  /**
   * QB "Keep QuickBooks running for quick startups". Deliberate no-op: the desktop app has no
   * background process to keep alive, so the option is not offered on the Preferences page.
   */
  keepQuickBooksRunning: boolean;
  // Reminders
  showRemindersAtStartup: boolean;
  // Reports
  reportsRefresh: 'prompt' | 'auto' | 'never';
  // Spelling
  spellCheckEnabled: boolean;
  spellIgnoreUppercase: boolean;
  spellIgnoreWithNumbers: boolean;
  spellIgnoreInternetAddresses: boolean;
  // Checking
  startWithPayee: boolean;
  // Desktop
  showHomeWorkflow: boolean;
  /** p1 ux: 'simple' = everyday tasks only (default for new users); 'advanced' = every menu. */
  navMode: 'simple' | 'advanced';
}

export const DEFAULT_MY_PREFERENCES: MyPreferences = {
  enterMovesBetweenFields: false,
  beepOnRecord: false,
  autoDecimalPoint: false,
  warnWhenEditing: true,
  warnWhenDeleting: true,
  defaultDate: 'today',
  autoRecallLastTransaction: true,
  keepQuickBooksRunning: false,
  showRemindersAtStartup: false,
  reportsRefresh: 'auto',
  spellCheckEnabled: true,
  spellIgnoreUppercase: true,
  spellIgnoreWithNumbers: true,
  spellIgnoreInternetAddresses: true,
  startWithPayee: true,
  showHomeWorkflow: true,
  navMode: 'simple',
};

export const MY_PREFERENCE_KEYS = Object.keys(DEFAULT_MY_PREFERENCES) as (keyof MyPreferences)[];

/** Keys of CompanyPreferences that are stored flat in companies.settings. */
export const COMPANY_PREFERENCE_KEYS = Object.keys(
  DEFAULT_COMPANY_PREFERENCES,
) as (keyof CompanyPreferences)[];

/** QB's Preferences dialog categories → the keys each one edits (drives app/settings). */
export const PREFERENCE_CATEGORIES: Array<{
  id: string;
  label: string;
  company: (keyof CompanyPreferences)[];
  my: (keyof MyPreferences)[];
}> = [
  {
    id: 'accounting',
    label: 'Accounting',
    company: [
      'accountNumbersEnabled',
      'requireAccountNumbers',
      'requireAccounts',
      'classTrackingEnabled',
      'warnUnassignedClass',
      'autoAssignJeNumbers',
      'warnPastDatesEnabled',
      'warnPastDays',
      'warnFutureDatesEnabled',
      'warnFutureDays',
    ],
    my: [],
  },
  {
    id: 'checking',
    label: 'Checking',
    company: [
      'defaultCheckAccountId',
      'defaultBillPaymentAccountId',
      'defaultDepositAccountId',
      'defaultPaycheckAccountId',
      'warnDuplicateCheckNumbers',
      'autofillPayeeAccount',
    ],
    my: ['startWithPayee'],
  },
  {
    id: 'general',
    label: 'General',
    company: ['timezone', 'currency', 'fiscalYearEnd'],
    my: [
      'enterMovesBetweenFields',
      'beepOnRecord',
      'autoDecimalPoint',
      'warnWhenEditing',
      'warnWhenDeleting',
      'defaultDate',
      'autoRecallLastTransaction',
      'showHomeWorkflow',
      'navMode',
    ],
  },
  {
    id: 'jobs',
    label: 'Jobs & Estimates',
    company: [
      'estimatesEnabled',
      'progressInvoicingEnabled',
      'warnDuplicateEstimateNumbers',
      'dontPrintZeroAmountItems',
    ],
    my: [],
  },
  {
    id: 'items',
    label: 'Items & Inventory',
    company: [
      'inventoryEnabled',
      'purchaseOrdersEnabled',
      'warnDuplicatePoNumbers',
      'negativeStockWarning',
      'unitsOfMeasureEnabled',
    ],
    my: [],
  },
  {
    id: 'payments',
    label: 'Payments',
    company: ['autoApplyPayments', 'autoCalculatePayments', 'useUndepositedFunds'],
    my: [],
  },
  {
    id: 'bills',
    label: 'Bills',
    company: [
      'defaultVendorTerms',
      'defaultExpenseAccountId',
      'warnDuplicateBillNumbers',
      'autoUseVendorCredits',
    ],
    my: [],
  },
  { id: 'reminders', label: 'Reminders', company: ['reminders'], my: ['showRemindersAtStartup'] },
  {
    id: 'reports',
    label: 'Reports & Graphs',
    company: ['reportBasis', 'agingFrom', 'accountDisplay'],
    my: ['reportsRefresh'],
  },
  {
    id: 'sales',
    label: 'Sales & Customers',
    company: [
      'defaultCustomerTerms',
      'defaultInvoiceMemo',
      'defaultShipVia',
      'defaultFob',
      'priceLevelsEnabled',
      'salesOrdersEnabled',
      'warnDuplicateInvoiceNumbers',
    ],
    my: [],
  },
  {
    id: 'salesTax',
    label: 'Sales Tax',
    company: ['salesTaxEnabled', 'salesTaxBasis', 'salesTaxFrequency'],
    my: [],
  },
  { id: 'sendForms', label: 'Send Forms', company: ['sendForms'], my: [] },
  {
    id: 'spelling',
    label: 'Spelling',
    company: [],
    my: [
      'spellCheckEnabled',
      'spellIgnoreUppercase',
      'spellIgnoreWithNumbers',
      'spellIgnoreInternetAddresses',
    ],
  },
  {
    id: 'time',
    label: 'Time & Expenses',
    company: [
      'timeTrackingEnabled',
      'firstDayOfWeek',
      'trackReimbursedAsIncome',
      'defaultMarkupPercent',
    ],
    my: [],
  },
  { id: 'currencies', label: 'Multiple Currencies', company: ['multiCurrencyEnabled'], my: [] },
  {
    id: 'payroll',
    label: 'Payroll & Employees',
    company: [
      'payrollEnabled',
      'payrollPayPeriod',
      'payrollStandardHours',
      'payrollExpenseAccountId',
      'payrollLiabilityAccountId',
    ],
    my: [],
  },
];

// ---------------------------------------------------------------------------
// Resolution (stored overrides + defaults)
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Overlay stored values onto defaults, keeping only values of the default's type. */
function overlay<T extends object>(defaults: T, stored: unknown): T {
  const out = { ...defaults } as Record<string, unknown>;
  if (!isPlainObject(stored)) return out as T;
  for (const [k, def] of Object.entries(defaults)) {
    const v = stored[k];
    if (v === undefined) continue;
    if (def === null) {
      if (v === null || typeof v === 'string') out[k] = v === '' ? null : v;
    } else if (typeof def === typeof v && !isPlainObject(def)) {
      out[k] = v;
    }
  }
  return out as T;
}

/** Resolve the full CompanyPreferences from a companies.settings jsonb (unknown shape). */
export function resolveCompanyPreferences(settings: unknown): CompanyPreferences {
  const s = isPlainObject(settings) ? settings : {};
  const prefs = overlay(DEFAULT_COMPANY_PREFERENCES, s);
  // Nested: reminders + sendForms merge per key.
  const reminders = { ...DEFAULT_REMINDERS };
  if (isPlainObject(s.reminders)) {
    for (const k of REMINDER_KEYS) {
      const r = s.reminders[k];
      if (isPlainObject(r)) {
        const mode = r.mode === 'list' || r.mode === 'off' || r.mode === 'summary' ? r.mode : reminders[k].mode;
        const days = typeof r.days === 'number' && Number.isFinite(r.days) ? Math.max(0, Math.round(r.days)) : reminders[k].days;
        reminders[k] = { mode, days };
      }
    }
  }
  prefs.reminders = reminders;
  const sendForms = { ...DEFAULT_SEND_FORMS };
  if (isPlainObject(s.sendForms)) {
    for (const k of FORM_TYPES) {
      const f = s.sendForms[k];
      if (isPlainObject(f)) {
        sendForms[k] = {
          subject: typeof f.subject === 'string' && f.subject ? f.subject : sendForms[k].subject,
          body: typeof f.body === 'string' && f.body ? f.body : sendForms[k].body,
        };
      }
    }
  }
  prefs.sendForms = sendForms;
  if (!TERMS_VALUES.includes(prefs.defaultCustomerTerms)) prefs.defaultCustomerTerms = 'net_30';
  if (!TERMS_VALUES.includes(prefs.defaultVendorTerms)) prefs.defaultVendorTerms = 'net_30';
  if (prefs.reportBasis !== 'cash') prefs.reportBasis = 'accrual';
  // Always on (lib/preferenceFields.ts `fixed`): every line needs an account so the books balance.
  prefs.requireAccounts = true;
  return prefs;
}

export function resolveMyPreferences(stored: unknown): MyPreferences {
  // warnWhenDeleting is always on (lib/preferenceFields.ts `fixed`): deleting/voiding always asks.
  const my = { ...overlay(DEFAULT_MY_PREFERENCES, stored), warnWhenDeleting: true };
  if (my.navMode !== 'advanced') my.navMode = 'simple';
  return my;
}

// ---------------------------------------------------------------------------
// Helpers used by forms, reports and services
// ---------------------------------------------------------------------------

/** 'YYYY-MM-DD' for "today" in the company's time zone (falls back to UTC on a bad zone). */
export function todayInTimeZone(timeZone: string | null | undefined, now: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** Add days to a 'YYYY-MM-DD' calendar date (UTC arithmetic: no DST drift). */
export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Due date for a document dated `dateIso` under the given terms code ('' when unknown terms). */
export function dueDateForTerms(dateIso: string, terms: string | null | undefined): string {
  if (!dateIso || !terms || !(terms in TERMS_DAYS)) return '';
  return addDaysIso(dateIso, TERMS_DAYS[terms as TermsValue]);
}

/** Account label honoring "Show account numbers" and the Reports account-display preference. */
export function formatAccountLabel(
  account: { code?: string | null; name: string; description?: string | null },
  prefs: Pick<CompanyPreferences, 'accountNumbersEnabled'> &
    Partial<Pick<CompanyPreferences, 'accountDisplay'>>,
): string {
  let label = account.name;
  if (prefs.accountDisplay === 'description' && account.description) label = account.description;
  else if (prefs.accountDisplay === 'both' && account.description)
    label = `${account.name} (${account.description})`;
  return prefs.accountNumbersEnabled && account.code ? `${account.code} · ${label}` : label;
}

/**
 * QB "Warn if transactions are N day(s) in the past / future": returns a plain-language warning
 * for `dateIso` or null when the date is inside the window (or the warnings are off).
 */
export function transactionDateWarning(
  dateIso: string,
  prefs: Pick<
    CompanyPreferences,
    'warnPastDatesEnabled' | 'warnPastDays' | 'warnFutureDatesEnabled' | 'warnFutureDays'
  >,
  todayIso: string,
): string | null {
  if (!/^\d{4}-\d{2}-\d{2}/.test(dateIso)) return null;
  const day = dateIso.slice(0, 10);
  if (prefs.warnPastDatesEnabled && day < addDaysIso(todayIso, -prefs.warnPastDays)) {
    return `This date is more than ${prefs.warnPastDays} days in the past. Double-check it before saving.`;
  }
  if (prefs.warnFutureDatesEnabled && day > addDaysIso(todayIso, prefs.warnFutureDays)) {
    return `This date is more than ${prefs.warnFutureDays} days in the future. Double-check it before saving.`;
  }
  return null;
}

/** On/off feature preferences that hide menus and block their pages and saves when off. */
export type FeatureKey =
  | 'estimatesEnabled'
  | 'salesOrdersEnabled'
  | 'purchaseOrdersEnabled'
  | 'inventoryEnabled'
  | 'timeTrackingEnabled'
  | 'salesTaxEnabled'
  | 'classTrackingEnabled'
  | 'priceLevelsEnabled'
  | 'unitsOfMeasureEnabled'
  | 'payrollEnabled';

export interface FeatureGate {
  key: FeatureKey;
  /** Plain name, used in "<label> are turned off…". */
  label: string;
  /** The Preferences category and checkbox that turn it back on. */
  category: string;
  setting: string;
  /** Pages hidden from the menus and replaced by a "turned off" message. */
  pages: string[];
  /** API prefixes whose saves (POST/PUT/PATCH/DELETE) are refused while the feature is off. */
  apis: string[];
}

/**
 * QB Preferences feature switches (Jobs & Estimates, Sales & Customers, Items & Inventory,
 * Time & Expenses, Sales Tax, Accounting). While one is off, QB removes its menus and forms:
 * here its pages are hidden from the menus and show a plain "turned off" message, and its APIs
 * refuse to save (reads keep working, so existing records stay visible in reports). Existing
 * records are never changed. Multiple Currencies is not gated here (QB never lets it be turned
 * off once used; the Currencies page is where it is set up).
 */
export const FEATURE_GATES: FeatureGate[] = [
  {
    key: 'estimatesEnabled',
    label: 'Estimates',
    category: 'Jobs & Estimates',
    setting: 'Use estimates',
    pages: ['/estimates', '/estimates-followup'],
    apis: ['/api/estimates'],
  },
  {
    key: 'salesOrdersEnabled',
    label: 'Sales orders',
    category: 'Sales & Customers',
    setting: 'Use sales orders',
    pages: ['/sales-orders', '/so-fulfillment'],
    apis: ['/api/sales-orders', '/api/fulfillment'],
  },
  {
    key: 'purchaseOrdersEnabled',
    label: 'Purchase orders',
    category: 'Items & Inventory',
    setting: 'Use purchase orders',
    pages: ['/purchase-orders', '/item-receipts', '/receive-bill'],
    apis: [
      '/api/purchase-orders',
      '/api/receiving/po',
      '/api/receiving/bill',
      '/api/item-receipts',
      '/api/inventory/reorder/create-po',
    ],
  },
  {
    key: 'inventoryEnabled',
    label: 'Inventory features',
    category: 'Items & Inventory',
    setting: 'Track inventory',
    pages: [
      '/assemblies',
      '/inventory-ops',
      '/fifo',
      '/inventory-sites',
      '/inventory-transfers',
      '/landed-cost',
      '/reports/inventory-valuation',
      '/reports/inventory-sites',
    ],
    apis: [
      '/api/assemblies',
      '/api/inventory',
      '/api/fifo',
      '/api/inventory-sites',
      '/api/inventory-transfers',
      '/api/landed-cost',
    ],
  },
  {
    key: 'timeTrackingEnabled',
    label: 'Time tracking',
    category: 'Time & Expenses',
    setting: 'Track time',
    pages: ['/time-tracking'],
    apis: ['/api/time-entries'],
  },
  {
    key: 'salesTaxEnabled',
    label: 'Sales tax',
    category: 'Sales Tax',
    setting: 'Charge sales tax',
    pages: ['/sales-tax-components'],
    apis: ['/api/tax-rates', '/api/tax-agencies'],
  },
  {
    key: 'classTrackingEnabled',
    label: 'Class tracking',
    category: 'Accounting',
    setting: 'Use class tracking',
    pages: [],
    apis: ['/api/classes'],
  },
  {
    key: 'priceLevelsEnabled',
    label: 'Price levels',
    category: 'Sales & Customers',
    setting: 'Use price levels',
    pages: [],
    apis: ['/api/pricing/levels'],
  },
  {
    key: 'unitsOfMeasureEnabled',
    label: 'Units of measure',
    category: 'Items & Inventory',
    setting: 'Use units of measure',
    pages: ['/lists/uom'],
    apis: ['/api/uom-sets'],
  },
  {
    key: 'payrollEnabled',
    label: 'Payroll',
    category: 'Payroll & Employees',
    setting: 'Full payroll',
    // The Employee list itself stays (QB keeps the Employee Center with "No payroll").
    pages: [
      '/employees/setup',
      '/pay-runs',
      '/pay-stubs',
      '/pay-liabilities',
      '/payroll-tax',
      '/payroll-forms',
      '/reports/payroll-summary',
    ],
    apis: ['/api/payroll', '/api/pay-liabilities', '/api/payroll-items'],
  },
];

const underPrefix = (path: string, prefix: string) => path === prefix || path.startsWith(prefix + '/');

/** The feature gate a page path belongs to (longest page prefix wins), or null. */
export function featureGateForPage(path: string): FeatureGate | null {
  let best: { gate: FeatureGate; len: number } | null = null;
  for (const gate of FEATURE_GATES) {
    for (const p of gate.pages) {
      if (underPrefix(path, p) && (!best || p.length > best.len)) best = { gate, len: p.length };
    }
  }
  return best?.gate ?? null;
}

/** Every feature gate an API path belongs to (a path can need more than one feature). */
export function featureGatesForApi(path: string): FeatureGate[] {
  return FEATURE_GATES.filter((gate) => gate.apis.some((p) => underPrefix(path, p)));
}

/** The first feature gate an API path belongs to, or null. */
export function featureGateForApi(path: string): FeatureGate | null {
  return featureGatesForApi(path)[0] ?? null;
}

/**
 * The gate that blocks `path` for these preferences right now (page or API), or null. Every
 * matching gate is checked: e.g. "create purchase orders from the reorder list" needs both
 * inventory and purchase orders.
 */
export function blockingFeatureGate(
  path: string,
  prefs: Pick<CompanyPreferences, FeatureKey>,
  method: string = 'GET',
): FeatureGate | null {
  const isApi = path === '/api' || path.startsWith('/api/');
  if (isApi && method.toUpperCase() === 'GET') return null;
  if (!isApi) {
    const gate = featureGateForPage(path);
    return gate && prefs[gate.key] === false ? gate : null;
  }
  return featureGatesForApi(path).find((g) => prefs[g.key] === false) ?? null;
}

/** Plain-language "turned off" message (also matched by lib/friendlyErrors.ts). */
export function featureOffMessage(gate: Pick<FeatureGate, 'label' | 'category' | 'setting'>): string {
  return `${gate.label} ${/s$/i.test(gate.label) ? 'are' : 'is'} turned off for this company. To use ${/s$/i.test(gate.label) ? 'them' : 'it'}, an administrator can turn on "${gate.setting}" in Settings > Preferences > ${gate.category}.`;
}

/**
 * Pages QB hides from its menus while a feature is turned off in Preferences. The same pages
 * show a "turned off" message (components/AppShell.tsx) and their APIs refuse to save
 * (lib/featureGate.ts, called by getServerContext).
 */
export function featureHiddenPaths(prefs: Pick<CompanyPreferences, FeatureKey>): Set<string> {
  const hidden = new Set<string>();
  for (const gate of FEATURE_GATES) {
    if (prefs[gate.key] === false) for (const p of gate.pages) hidden.add(p);
  }
  return hidden;
}

/**
 * A2: pages hidden while Multiple Currencies is off (Preferences > Multiple Currencies). Kept
 * apart from FEATURE_GATES because this switch is OFF by default and, once foreign-currency data
 * exists, can never be turned off again; its saves are refused in the services
 * (lib/services/multiCurrency.ts), not by route prefix.
 */
export const MULTI_CURRENCY_PAGES = ['/currencies'] as const;

export function multiCurrencyHiddenPaths(prefs: Pick<CompanyPreferences, 'multiCurrencyEnabled'>): Set<string> {
  return new Set(prefs.multiCurrencyEnabled ? [] : MULTI_CURRENCY_PAGES);
}

/** Pay periods per year for the payroll pay-period preference. */
export const PAY_PERIODS_PER_YEAR: Record<CompanyPreferences['payrollPayPeriod'], number> = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
};

/** Default hours on an hourly paycheck for the pay period (standard weekly hours x weeks). */
export function defaultPeriodHours(
  period: CompanyPreferences['payrollPayPeriod'],
  standardWeeklyHours: number,
): number {
  const weeks = 52 / PAY_PERIODS_PER_YEAR[period];
  return Math.round(standardWeeklyHours * weeks * 100) / 100;
}

/**
 * Fill {{merge.fields}} in Send Forms / letter text. Unknown fields are left blank so a typo
 * never leaks template syntax to a customer. Keys are case-insensitive.
 */
export function fillMergeFields(text: string, values: Record<string, string | number | null | undefined>): string {
  const lower = new Map(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]));
  return text.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, key: string) => {
    const v = lower.get(key.toLowerCase());
    return v === null || v === undefined ? '' : String(v);
  });
}
