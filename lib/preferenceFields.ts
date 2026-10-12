/**
 * UI metadata for every Preferences key (label, plain-language help, input type) used by the
 * categorized Preferences page (app/settings/PreferencePane.tsx). Pure module (no JSX) so tests
 * can check every preference in lib/preferences.ts has a control.
 */

export interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype?: string | null;
  isActive?: boolean;
}

export type FieldType = 'bool' | 'number' | 'text' | 'select' | 'account' | 'reminders' | 'sendForms';

export interface FieldMeta {
  label: string;
  help?: string;
  type: FieldType;
  options?: Array<[string, string]>;
  /** For account pickers: which accounts qualify. */
  accounts?: (a: Account) => boolean;
  /** Show only when another boolean key is on. */
  dependsOn?: string;
}

// Mirrors lib/services/prefAccounts.ts accountFitsKind (kept separate: this module is client-safe).
// 1050 Undeposited Funds and 2200 Sales Tax Payable are system control accounts and never offered.
const bank = (a: Account) =>
  a.type === 'asset' && ['checking', 'savings', 'bank'].includes(String(a.subtype ?? '')) && a.code !== '1050';
const expense = (a: Account) => a.type === 'expense';
const liability = (a: Account) =>
  a.type === 'liability' && !['accounts_payable', 'credit_card'].includes(String(a.subtype ?? '')) && a.code !== '2200';

const TERMS: Array<[string, string]> = [
  ['due_on_receipt', 'Due on receipt'],
  ['net_15', 'Net 15'],
  ['net_30', 'Net 30'],
  ['net_60', 'Net 60'],
];

export const FIELD_META: Record<string, FieldMeta> = {
  // Accounting
  accountNumbersEnabled: { label: 'Use account numbers', help: 'Show account numbers next to account names everywhere.', type: 'bool' },
  requireAccountNumbers: { label: 'Require an account number on new accounts', type: 'bool', dependsOn: 'accountNumbersEnabled' },
  requireAccounts: { label: 'Require an account on every transaction line', help: 'Recommended. Lines without an account would otherwise land in an "uncategorized" bucket.', type: 'bool' },
  classTrackingEnabled: { label: 'Use class tracking', help: 'Tag transactions with a class (department, location, …) for reports by class.', type: 'bool' },
  warnUnassignedClass: { label: 'Warn me when a transaction has no class', type: 'bool', dependsOn: 'classTrackingEnabled' },
  autoAssignJeNumbers: { label: 'Automatically number journal entries', type: 'bool' },
  warnPastDatesEnabled: { label: 'Warn if a transaction is dated in the past', type: 'bool' },
  warnPastDays: { label: 'More than this many days in the past', type: 'number', dependsOn: 'warnPastDatesEnabled' },
  warnFutureDatesEnabled: { label: 'Warn if a transaction is dated in the future', type: 'bool' },
  warnFutureDays: { label: 'More than this many days in the future', type: 'number', dependsOn: 'warnFutureDatesEnabled' },
  // Checking
  defaultCheckAccountId: { label: 'Default account for Write Checks', type: 'account', accounts: bank },
  defaultBillPaymentAccountId: { label: 'Default account for Pay Bills', type: 'account', accounts: bank },
  defaultDepositAccountId: { label: 'Default account for Make Deposits', type: 'account', accounts: bank },
  defaultPaycheckAccountId: { label: 'Default account for paychecks', type: 'account', accounts: bank },
  warnDuplicateCheckNumbers: { label: 'Warn about duplicate check numbers', type: 'bool' },
  autofillPayeeAccount: { label: 'Fill in the account from the payee (Autofill)', type: 'bool' },
  startWithPayee: { label: 'Start with the payee field on checks', type: 'bool' },
  // General
  timezone: { label: 'Time zone', help: 'Decides what "today" means for due dates and reminders.', type: 'text' },
  currency: { label: 'Home currency (ISO code)', type: 'text' },
  fiscalYearEnd: { label: 'Fiscal year end (MM-DD)', type: 'text' },
  enterMovesBetweenFields: { label: 'Pressing Enter moves between fields', type: 'bool' },
  beepOnRecord: { label: 'Beep when recording a transaction', type: 'bool' },
  autoDecimalPoint: { label: 'Automatically place the decimal point', help: 'Typing 1234 enters 12.34.', type: 'bool' },
  warnWhenEditing: { label: 'Warn when editing a transaction', type: 'bool' },
  warnWhenDeleting: { label: 'Warn when deleting a transaction or unused list item', type: 'bool' },
  defaultDate: { label: 'Default date for new transactions', type: 'select', options: [['today', "Today's date"], ['last', 'The last date I entered']] },
  autoRecallLastTransaction: { label: 'Recall the last transaction for a name', type: 'bool' },
  showHomeWorkflow: { label: 'Show the home workflow on the dashboard', type: 'bool' },
  navMode: { label: 'Menu style', help: 'Simple shows only everyday tasks. Advanced shows every screen. You can also switch at the top of the menu.', type: 'select', options: [['simple', 'Simple (everyday tasks)'], ['advanced', 'Advanced (every screen)']] },
  // Jobs & Estimates
  estimatesEnabled: { label: 'Use estimates', type: 'bool' },
  progressInvoicingEnabled: { label: 'Use progress invoicing', help: 'Invoice part of an estimate at a time.', type: 'bool', dependsOn: 'estimatesEnabled' },
  warnDuplicateEstimateNumbers: { label: 'Warn about duplicate estimate numbers', type: 'bool' },
  dontPrintZeroAmountItems: { label: "Don't print items that have a zero amount", type: 'bool' },
  // Items & Inventory
  inventoryEnabled: { label: 'Track inventory', type: 'bool' },
  purchaseOrdersEnabled: { label: 'Use purchase orders', type: 'bool' },
  warnDuplicatePoNumbers: { label: 'Warn about duplicate purchase order numbers', type: 'bool', dependsOn: 'purchaseOrdersEnabled' },
  negativeStockWarning: { label: 'Warn if not enough inventory to sell', type: 'bool' },
  unitsOfMeasureEnabled: { label: 'Use units of measure', type: 'bool' },
  // Payments
  autoApplyPayments: { label: 'Automatically apply payments to the oldest invoices', type: 'bool' },
  autoCalculatePayments: { label: 'Automatically calculate the payment amount from the invoices you check', type: 'bool' },
  useUndepositedFunds: { label: 'Put received payments in Undeposited Funds by default', help: 'Lets you combine several payments into one bank deposit, like your bank statement shows.', type: 'bool' },
  // Bills
  defaultVendorTerms: { label: 'Default terms for new vendors', type: 'select', options: TERMS },
  defaultExpenseAccountId: { label: 'Default expense account', type: 'account', accounts: expense },
  warnDuplicateBillNumbers: { label: 'Warn about duplicate bill numbers from the same vendor', type: 'bool' },
  autoUseVendorCredits: { label: 'Automatically use available vendor credits', type: 'bool' },
  // Reminders
  reminders: { label: 'What to remind me about', type: 'reminders' },
  showRemindersAtStartup: { label: 'Show the Reminders list when I open the company', type: 'bool' },
  // Reports
  reportBasis: { label: 'Default report basis', help: 'Accrual counts income when invoiced; cash counts it when paid. Any report can still switch.', type: 'select', options: [['accrual', 'Accrual'], ['cash', 'Cash']] },
  agingFrom: { label: 'Aging reports age from', type: 'select', options: [['due_date', 'The due date'], ['transaction_date', 'The transaction date']] },
  accountDisplay: { label: 'Reports show accounts by', type: 'select', options: [['name', 'Name only'], ['description', 'Description only'], ['both', 'Name and description']] },
  reportsRefresh: { label: 'When report data changes', type: 'select', options: [['auto', 'Refresh automatically'], ['prompt', 'Ask me to refresh'], ['never', "Don't refresh"]] },
  // Sales & Customers
  defaultCustomerTerms: { label: 'Default terms for new customers', type: 'select', options: TERMS },
  defaultInvoiceMemo: { label: 'Default customer message on invoices', type: 'text' },
  defaultShipVia: { label: 'Usual shipping method', type: 'text' },
  defaultFob: { label: 'Usual FOB', type: 'text' },
  priceLevelsEnabled: { label: 'Use price levels', type: 'bool' },
  salesOrdersEnabled: { label: 'Use sales orders', type: 'bool' },
  warnDuplicateInvoiceNumbers: { label: 'Warn about duplicate invoice numbers', type: 'bool' },
  // Sales Tax
  salesTaxEnabled: { label: 'Charge sales tax', type: 'bool' },
  salesTaxBasis: { label: 'You owe sales tax', type: 'select', options: [['accrual', 'As of the invoice date (accrual)'], ['cash', 'Upon receipt of payment (cash)']], dependsOn: 'salesTaxEnabled' },
  salesTaxFrequency: { label: 'How often you pay sales tax', type: 'select', options: [['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['annually', 'Annually']], dependsOn: 'salesTaxEnabled' },
  // Send Forms
  sendForms: { label: 'Email wording for each form', type: 'sendForms' },
  // Spelling
  spellCheckEnabled: { label: 'Check spelling as I type (memos and descriptions)', help: 'Uses the spell checker built into your computer. Right-click a word for suggestions.', type: 'bool' },
  spellIgnoreUppercase: { label: 'Ignore words in UPPERCASE', type: 'bool', dependsOn: 'spellCheckEnabled' },
  spellIgnoreWithNumbers: { label: 'Ignore words with numbers', type: 'bool', dependsOn: 'spellCheckEnabled' },
  spellIgnoreInternetAddresses: { label: 'Ignore internet addresses', type: 'bool', dependsOn: 'spellCheckEnabled' },
  // Time & Expenses
  timeTrackingEnabled: { label: 'Track time', type: 'bool' },
  firstDayOfWeek: { label: 'First day of the work week', type: 'select', options: [['monday', 'Monday'], ['sunday', 'Sunday']], dependsOn: 'timeTrackingEnabled' },
  trackReimbursedAsIncome: { label: 'Track reimbursed expenses as income', type: 'bool' },
  defaultMarkupPercent: { label: 'Default markup percentage', type: 'number' },
  // Multiple currencies
  multiCurrencyEnabled: { label: 'I use more than one currency', help: 'Turning this on cannot be undone in QuickBooks; here it only shows the currency fields on forms.', type: 'bool' },
  // Payroll
  payrollEnabled: { label: 'Use payroll (QuickBooks "Full payroll")', help: 'Turn off if you do not pay employees through this app. Payroll screens leave the menus; nothing is deleted.', type: 'bool' },
  payrollPayPeriod: { label: 'Usual pay period', type: 'select', options: [['weekly', 'Weekly'], ['biweekly', 'Every two weeks'], ['semimonthly', 'Twice a month'], ['monthly', 'Monthly']] },
  payrollStandardHours: { label: 'Standard hours per week', type: 'number' },
  payrollExpenseAccountId: { label: 'Wages expense account', type: 'account', accounts: expense },
  payrollLiabilityAccountId: { label: 'Payroll liabilities account', type: 'account', accounts: liability },
};
