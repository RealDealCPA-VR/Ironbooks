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
  payrollPayPeriod: 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';
  payrollStandardHours: number;
  payrollExpenseAccountId: string | null;
  payrollLiabilityAccountId: string | null;
}

export const DEFAULT_COMPANY_PREFERENCES: CompanyPreferences = {
  accountNumbersEnabled: true,
  requireAccountNumbers: false,
  requireAccounts: true,
  classTrackingEnabled: false,
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
  progressInvoicingEnabled: false,
  warnDuplicateEstimateNumbers: true,
  dontPrintZeroAmountItems: false,
  inventoryEnabled: true,
  purchaseOrdersEnabled: true,
  warnDuplicatePoNumbers: true,
  negativeStockWarning: true,
  unitsOfMeasureEnabled: false,
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
  return prefs;
}

export function resolveMyPreferences(stored: unknown): MyPreferences {
  const my = overlay(DEFAULT_MY_PREFERENCES, stored);
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

/**
 * Pages QB hides from its menus while a feature is turned off in Preferences (Jobs & Estimates,
 * Sales & Customers, Items & Inventory, Time & Expenses, Sales Tax).
 * Cosmetic only: the pages and APIs keep working, and existing records stay intact.
 */
export function featureHiddenPaths(
  prefs: Pick<
    CompanyPreferences,
    | 'estimatesEnabled'
    | 'salesOrdersEnabled'
    | 'purchaseOrdersEnabled'
    | 'inventoryEnabled'
    | 'timeTrackingEnabled'
    | 'salesTaxEnabled'
  >,
): Set<string> {
  const hidden = new Set<string>();
  const add = (on: boolean, paths: string[]) => {
    if (!on) for (const p of paths) hidden.add(p);
  };
  add(prefs.estimatesEnabled, ['/estimates', '/estimates-followup']);
  add(prefs.salesOrdersEnabled, ['/sales-orders', '/so-fulfillment']);
  add(prefs.purchaseOrdersEnabled, ['/purchase-orders', '/item-receipts', '/receive-bill']);
  add(prefs.inventoryEnabled, [
    '/assemblies',
    '/inventory-ops',
    '/fifo',
    '/inventory-sites',
    '/inventory-transfers',
    '/landed-cost',
    '/reports/inventory-valuation',
    '/reports/inventory-sites',
  ]);
  add(prefs.timeTrackingEnabled, ['/time-tracking']);
  // Multiple Currencies stays visible: the Currencies page is where it is set up, and QB never
  // lets it be turned back off once foreign-currency records exist.
  add(prefs.salesTaxEnabled, ['/sales-tax-components']);
  return hidden;
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
