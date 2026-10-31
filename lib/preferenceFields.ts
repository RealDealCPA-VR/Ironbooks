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
  /**
   * Fixed behaviour: the setting is shown checked and locked with this plain explanation
   * (Ironbooks always does this, for the reason given).
   */
  fixed?: string;
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
  requireAccountNumbers: { label: 'Require an account number on new accounts', help: 'When off, a new account left without a number gets the next free one.', type: 'bool', dependsOn: 'accountNumbersEnabled' },
  requireAccounts: { label: 'Require an account on every transaction line', type: 'bool', fixed: 'Always on: every line needs an account, so your books always balance and nothing lands in an unknown bucket.' },
  classTrackingEnabled: { label: 'Use class tracking', help: 'Tag transactions with a class (department, location, …) for reports by class.', type: 'bool' },
  warnUnassignedClass: { label: 'Warn me when a transaction has no class', type: 'bool', dependsOn: 'classTrackingEnabled' },
  autoAssignJeNumbers: { label: 'Automatically number journal entries', help: 'New journal entries get the next Entry No. You can still type your own.', type: 'bool' },
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
  enterMovesBetweenFields: { label: 'Pressing Enter moves between fields', help: 'Enter goes to the next field instead of saving. Use the Save button to save.', type: 'bool' },
  beepOnRecord: { label: 'Beep when recording a transaction', help: 'Plays a short tone after a transaction is saved.', type: 'bool' },
  autoDecimalPoint: { label: 'Automatically place the decimal point', help: 'Typing 1234 enters 12.34.', type: 'bool' },
  warnWhenEditing: { label: 'Warn when editing a transaction', help: 'Asks before saving changes to a transaction that was already recorded.', type: 'bool' },
  warnWhenDeleting: { label: 'Warn when deleting a transaction or unused list item', type: 'bool', fixed: 'Always on: Ironbooks always asks before deleting or voiding, because it cannot be undone.' },
  defaultDate: { label: 'Default date for new transactions', help: '"The last date I entered" uses the date you last saved on the same kind of form (a check, an invoice, ...) since you opened the app.', type: 'select', options: [['today', "Today's date"], ['last', 'The last date I entered']] },
  autoRecallLastTransaction: { label: 'Recall the last transaction for a name', help: 'When you pick a name on a new bill, check, expense, card charge, invoice, sales receipt, estimate or sales order, the lines, terms, class, sales rep, tax and memo from the last one for that name are filled in.', type: 'bool' },
  showHomeWorkflow: { label: 'Show the Home page workflow (the task diagram)', help: 'The clickable diagram of everyday tasks on the Home page.', type: 'bool' },
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
  unitsOfMeasureEnabled: { label: 'Use units of measure', help: 'Off hides the Units of Measure list and stops new unit sets from being saved.', type: 'bool' },
  // Payments
  autoApplyPayments: { label: 'Automatically apply payments to the oldest invoices', type: 'bool' },
  autoCalculatePayments: { label: 'Automatically calculate the payment amount from the invoices you check', type: 'bool' },
  useUndepositedFunds: { label: 'Put received payments in Undeposited Funds by default', help: 'Lets you combine several payments into one bank deposit, like your bank statement shows.', type: 'bool' },
  // Bills
  defaultVendorTerms: { label: 'Default terms for new vendors', type: 'select', options: TERMS },
  defaultExpenseAccountId: { label: 'Default expense account', type: 'account', accounts: expense },
  warnDuplicateBillNumbers: { label: 'Warn about duplicate bill numbers from the same vendor', type: 'bool' },
  autoUseVendorCredits: { label: 'Automatically use available vendor credits', help: "In Pay Bills, checking a bill applies the vendor's open credits first.", type: 'bool' },
  // Reminders
  reminders: { label: 'What to remind me about', type: 'reminders' },
  showRemindersAtStartup: { label: 'Show the Reminders list when I open the company', type: 'bool' },
  // Reports
  reportBasis: { label: 'Default report basis', help: 'Accrual counts income when invoiced; cash counts it when paid. Any report can still switch.', type: 'select', options: [['accrual', 'Accrual'], ['cash', 'Cash']] },
  agingFrom: { label: 'Aging reports age from', type: 'select', options: [['due_date', 'The due date'], ['transaction_date', 'The transaction date']] },
  accountDisplay: { label: 'Reports show accounts by', help: 'How every report names accounts. An account with no description shows its name.', type: 'select', options: [['name', 'Name only'], ['description', 'Description only'], ['both', 'Name and description']] },
  reportsRefresh: { label: 'When report data changes', type: 'select', options: [['auto', 'Refresh automatically'], ['prompt', 'Ask me to refresh'], ['never', "Don't refresh"]] },
  // Sales & Customers
  defaultCustomerTerms: { label: 'Default terms for new customers', type: 'select', options: TERMS },
  defaultInvoiceMemo: { label: 'Default customer message on invoices', type: 'text' },
  defaultShipVia: { label: 'Usual shipping method', type: 'text' },
  defaultFob: { label: 'Usual FOB', type: 'text' },
  priceLevelsEnabled: { label: 'Use price levels', help: 'Off stops price levels from being created or changed.', type: 'bool' },
  salesOrdersEnabled: { label: 'Use sales orders', type: 'bool' },
  warnDuplicateInvoiceNumbers: { label: 'Warn about duplicate invoice numbers', type: 'bool' },
  // Sales Tax
  salesTaxEnabled: { label: 'Charge sales tax', type: 'bool' },
  salesTaxBasis: { label: 'You owe sales tax', type: 'select', options: [['accrual', 'As of the invoice date (accrual)'], ['cash', 'Upon receipt of payment (cash)']], dependsOn: 'salesTaxEnabled' },
  salesTaxFrequency: { label: 'How often you pay sales tax', type: 'select', options: [['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['annually', 'Annually']], dependsOn: 'salesTaxEnabled' },
  // Send Forms
  sendForms: { label: 'Email wording for each form', type: 'sendForms' },
  sendFromName: { label: 'Send my emails with this name', help: "Leave blank to use the company's sender name.", type: 'text' },
  sendFromEmail: { label: 'Send my emails from this address', help: "Replies come back to you. Leave blank to use the company's address. Your mail server must allow sending from it: use Test on the Send Forms page.", type: 'text' },
  bccMe: { label: 'Send me a copy (Bcc) of every form I email', type: 'bool' },
  // Spelling
  spellCheckEnabled: { label: 'Check spelling as I type (memos and descriptions)', help: 'Uses the spell checker built into your computer. Right-click a word for suggestions.', type: 'bool' },
  spellIgnoreUppercase: { label: 'Ignore words in UPPERCASE', type: 'bool', dependsOn: 'spellCheckEnabled', help: "Note: the spell checker built into your computer decides this; Ironbooks cannot change it." },
  spellIgnoreWithNumbers: { label: 'Ignore words with numbers', type: 'bool', dependsOn: 'spellCheckEnabled', help: "Note: the spell checker built into your computer decides this; Ironbooks cannot change it." },
  spellIgnoreInternetAddresses: { label: 'Ignore internet addresses', type: 'bool', dependsOn: 'spellCheckEnabled', help: "Note: the spell checker built into your computer decides this; Ironbooks cannot change it." },
  // Time & Expenses
  timeTrackingEnabled: { label: 'Track time', type: 'bool' },
  firstDayOfWeek: { label: 'First day of the work week', type: 'select', options: [['monday', 'Monday'], ['sunday', 'Sunday']], dependsOn: 'timeTrackingEnabled' },
  trackReimbursedAsIncome: { label: 'Track reimbursed expenses as income', help: 'On: costs you bill back to customers go to an income account named "Reimbursed Expenses Income". Off: they reduce the original expense account.', type: 'bool' },
  defaultMarkupPercent: { label: 'Default markup percentage', type: 'number' },
  // Multiple currencies
  multiCurrencyEnabled: { label: 'I use more than one currency', help: 'Adds currency and exchange-rate fields to forms and the Currencies list. While off, they are hidden and foreign-currency entries are refused. Once you have foreign-currency data it can no longer be turned off (as in QuickBooks).', type: 'bool' },
  // Payroll
  payrollEnabled: { label: 'Use payroll (Full payroll)', help: 'Off ("No payroll"): pay runs, paychecks, payroll liabilities and payroll tax forms are hidden and cannot be saved. Your employee list stays.', type: 'bool' },
  payrollPayPeriod: { label: 'Usual pay period', type: 'select', options: [['weekly', 'Weekly'], ['biweekly', 'Every two weeks'], ['semimonthly', 'Twice a month'], ['monthly', 'Monthly']] },
  payrollStandardHours: { label: 'Standard hours per week', type: 'number' },
  payrollExpenseAccountId: { label: 'Wages expense account', type: 'account', accounts: expense },
  payrollLiabilityAccountId: { label: 'Payroll liabilities account', type: 'account', accounts: liability },
  // Desktop View (prefsperms A2)
  startPage: { label: 'When I open a company file', help: '"Where I left off" opens the page you were on when you last closed the file or signed out.', type: 'select', options: [['home', 'Show the Home page'], ['last', 'Go back to where I left off']] },
  homeShowSalesReceipts: { label: 'Show Sales Receipts on the Home page', help: 'Only the Home page icon: Sales Receipts stay in the menus.', type: 'bool' },
  homeShowStatements: { label: 'Show Statements and Statement Charges on the Home page', help: 'Only the Home page icons: statements stay in the menus.', type: 'bool' },
  homeShowBills: { label: 'Show Enter Bills and Pay Bills on the Home page', help: 'Turn off if you pay as you go with checks and never enter bills. Bills stay in the menus.', type: 'bool' },
  // Integrated Applications (prefsperms A2)
  integratedAppsBlocked: { label: "Don't allow any applications to access this company file", help: 'Turns off everything below at once: only people signed in to Ironbooks can reach the file.', type: 'bool' },
  allowEmployeePortal: { label: 'Employee portal: employees may sign in to see their pay stubs', help: 'Off: employees cannot sign in to the portal (signed-in employees are signed out).', type: 'bool' },
  allowPhoneReceipts: { label: 'Phone receipt capture: phone links may upload receipts', help: 'Off: no new phone links can be made and existing links stop accepting receipts.', type: 'bool' },
  // Search (prefsperms A2)
  showSearchBox: { label: 'Show the search box in the menu', help: 'Ctrl+K (the command bar) searches everything either way.', type: 'bool' },
  searchDefault: { label: 'Pressing Enter in the search box searches', type: 'select', options: [['pages', 'Pages (the best matching screen opens)'], ['everything', 'My company file: names, transactions and pages']] },
  // Calendar (prefsperms A2)
  calendarView: { label: 'Calendar view', type: 'select', options: [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['last', 'Remember the last view I used']] },
  calendarWeek: { label: 'Weekly view shows', type: 'select', options: [['company', 'The work week from Time & Expenses'], ['sun_sat', 'Sunday to Saturday'], ['mon_sun', 'Monday to Sunday'], ['mon_fri', 'Monday to Friday']] },
  calendarShowEntered: { label: 'Show transactions entered on each day', type: 'bool' },
  calendarShowDue: { label: 'Show transactions due on each day', type: 'bool' },
  calendarPastDueDays: { label: 'Upcoming & Past Due: show past-due items from this many days back', type: 'number' },
  calendarUpcomingDays: { label: 'Upcoming & Past Due: show items due in the next this many days', type: 'number' },
};
