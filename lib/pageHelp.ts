/**
 * "What is this page?" help (p1 ux): one or two plain-language sentences about each everyday
 * screen plus what to do first. The app shell shows it with the <Help page=…> bubble next to
 * the page, so every screen reachable from Simple mode and every Sales / Purchases / Banking
 * form explains itself. Where QuickBooks uses a different name, `qb` keeps it for reference.
 *
 * Pure data (no JSX) so tests can check coverage against the menus.
 */

export interface PageHelpEntry {
  /** Page name as people know it. */
  title: string;
  /** What the page is for (one or two sentences, no jargon). */
  what: string;
  /** What to do first. */
  first: string;
  /** QuickBooks name, when different from the title. */
  qb?: string;
}

export const PAGE_HELP: Record<string, PageHelpEntry> = {
  // ---- Home / everyday ----
  '/dashboard': {
    title: 'Home',
    what: 'Your starting point: "Needs attention" lists what is waiting on you, most urgent first; "Overview" shows how money moves, and you click any step to do it.',
    first: 'Work down Needs attention, or on Overview pick a task such as Create Invoices or Pay Bills.',
    qb: 'Home page',
  },
  '/attention': {
    title: 'Needs attention',
    what: 'Everything waiting on you, most urgent first: bank transactions to sort, late customers, bills due, reconciling, payroll taxes, to-dos and backups.',
    first: 'Use the button on each line (Sort it, Send reminder, Pay, Done). Not now? Choose Later to snooze or dismiss it.',
    qb: 'Company Snapshot / Reminders',
  },
  '/todos': {
    title: 'To Do list',
    what: 'Calls, emails, meetings and tasks you want to remember, optionally about a customer, vendor, employee or lead. They also show on the Calendar and in Reminders.',
    first: 'Click "New to-do", describe it and pick a due date.',
    qb: 'To Do List',
  },
  '/calendar': {
    title: 'Calendar',
    what: 'A month view of what you entered each day, what is due (invoices, bills) and your to-dos.',
    first: 'Click a day to see everything on it or to add a to-do.',
  },
  '/reminders': {
    title: 'Reminders',
    what: 'Everything that needs attention: overdue invoices, bills to pay, checks to print, money to deposit and to-dos.',
    first: 'Click a line to go straight to the screen that handles it.',
  },
  // ---- Customers / Sales ----
  '/invoices': {
    title: 'Invoices',
    what: 'Bill a customer who will pay you later. Saving an invoice records the sale and what the customer owes you.',
    first: 'Click "New invoice", pick the customer, add what you sold and save.',
    qb: 'Create Invoices',
  },
  '/invoices/batch': {
    title: 'Invoice many customers',
    what: 'Send the same charge (for example a monthly fee) to a group of customers in one go.',
    first: 'Pick the customers, add the items once, then create the invoices.',
    qb: 'Batch Invoicing',
  },
  '/payments': {
    title: 'Receive Payments',
    what: 'Record money a customer paid you against their invoices, so their balance goes down.',
    first: 'Pick the customer, enter the amount, and tick the invoices it pays.',
    qb: 'Receive Payments',
  },
  '/customers': {
    title: 'Customers',
    what: 'Everyone you sell to, with their contact details, balance owed and history.',
    first: 'Click "New customer" to add one, or click a name to see what they owe.',
    qb: 'Customer Center',
  },
  '/sales-receipts': {
    title: 'Sales Receipts',
    what: 'Record a sale that was paid on the spot (cash, card or check), so no invoice is needed.',
    first: 'Click "New sales receipt", pick the customer, add what you sold and how they paid.',
    qb: 'Enter Sales Receipts',
  },
  '/estimates': {
    title: 'Estimates',
    what: 'A price quote for a customer. It does not change your books until you turn it into an invoice.',
    first: 'Click "New estimate", add the work or items, then send it to the customer.',
    qb: 'Create Estimates',
  },
  '/sales-orders': {
    title: 'Sales Orders',
    what: 'Track an order a customer placed that you will deliver and invoice later. It does not change your books by itself.',
    first: 'Click "New sales order", add the items, and invoice it when you ship.',
    qb: 'Create Sales Orders',
  },
  '/so-fulfillment': {
    title: 'Sales order fulfillment',
    what: 'See which open sales orders you can ship now with the stock on hand.',
    first: 'Tick the orders to fill, then print pick lists or create the invoices.',
    qb: 'Sales Order Fulfillment Worksheet',
  },
  '/credit-memos': {
    title: 'Credit Memos',
    what: 'Give a customer a credit (for a return or a mistake) that lowers what they owe, or refund them.',
    first: 'Click "New credit memo", pick the customer and add what you are crediting. Prices follow the price level set on the customer, like on invoices.',
    qb: 'Create Credit Memos/Refunds',
  },
  '/leads': {
    title: 'Leads',
    what: 'People who might become customers. Track calls and to-dos, then turn a lead into a customer in one click.',
    first: 'Add a lead, then add a to-do to follow up.',
    qb: 'Lead Center',
  },
  '/finance-charges': {
    title: 'Late-payment charges',
    what: 'Add interest or a late fee to customers whose invoices are overdue.',
    first: 'Check the rate and grace period, review the list, then assess the charges you want.',
    qb: 'Assess Finance Charges',
  },
  '/income-tracker': {
    title: 'Money coming in',
    what: 'One view of estimates, unbilled orders, open and overdue invoices, and money paid in the last 30 days.',
    first: 'Click a coloured bar to see those transactions.',
    qb: 'Income Tracker',
  },
  '/collections-center': {
    title: 'Collect overdue payments',
    what: 'Customers who are late paying, with how much and how late, so you can follow up.',
    first: 'Pick a customer to email a reminder or add a note.',
    qb: 'Collections Center',
  },
  '/sales-reps': {
    title: 'Sales Reps',
    what: 'The people credited with sales, so reports can show sales by rep.',
    first: 'Add each rep once, then pick them on invoices.',
  },
  '/advanced-pricing': {
    title: 'Pricing rules',
    what: 'Automatic price changes, for example 10% off for a customer group or a sale price for a date range.',
    first: 'Click "New rule", choose who and what it applies to, and the price change.',
    qb: 'Advanced Pricing',
  },
  '/items': {
    title: 'Items',
    what: 'The products and services you buy and sell. Each item knows its price and which account it goes to.',
    first: 'Click "New item" and add the things you sell most.',
    qb: 'Item List',
  },
  // ---- Vendors / Purchases ----
  '/bills': {
    title: 'Enter Bills',
    what: 'Record a bill you received and will pay later, so you know what you owe each vendor.',
    first: 'Click "New bill", pick the vendor, the amount and what it was for.',
    qb: 'Enter Bills',
  },
  '/pay-bills': {
    title: 'Pay Bills',
    what: 'Pay the bills you already entered. Each payment lowers what you owe the vendor.',
    first: 'Tick the bills to pay, choose the bank account and payment date, then pay.',
    qb: 'Pay Bills',
  },
  '/vendors': {
    title: 'Vendors',
    what: 'Everyone you buy from, with their details, balance you owe and history.',
    first: 'Click "New vendor" to add one, or click a name to see open bills.',
    qb: 'Vendor Center',
  },
  '/purchase-orders': {
    title: 'Purchase Orders',
    what: 'An order you send a vendor. It does not change your books until the items arrive or the bill comes.',
    first: 'Click "New purchase order", pick the vendor and the items you are ordering.',
    qb: 'Create Purchase Orders',
  },
  '/item-receipts': {
    title: 'Receive Items',
    what: 'Record items that arrived before the bill, so your stock is right.',
    first: 'Pick the vendor and the purchase order, then enter what arrived.',
    qb: 'Receive Items',
  },
  '/receive-bill': {
    title: 'Bill for received items',
    what: 'When the bill comes for items you already received, turn that receipt into a bill.',
    first: 'Pick the vendor and the item receipt, check the amounts and save.',
    qb: 'Enter Bill for Received Items',
  },
  '/expenses': {
    title: 'Write Checks',
    what: 'Record money you paid right away by check, debit card or cash, and what it was for.',
    first: 'Click "New check", pick the bank account, the payee and the expense. The payee can be a vendor or someone on the Other Names list.',
    qb: 'Write Checks',
  },
  '/receipts': {
    title: 'Receipts',
    what: 'Photos and PDFs of receipts waiting to be entered. Ironbooks reads them on this computer and fills in a new expense or bill for you to check.',
    first: 'Drag a receipt anywhere in the app, or click Add receipts or Send from your phone.',
  },
  '/vendor-credits': {
    title: 'Vendor Credits',
    what: 'A credit from a vendor (for a return or overcharge) that lowers what you owe them.',
    first: 'Click "New vendor credit", pick the vendor and the amount; use it when you pay bills.',
    qb: 'Enter Credit from Vendor',
  },
  '/print-checks': {
    title: 'Print Checks',
    what: 'Print the checks you marked "to be printed" on your check stock.',
    first: 'Pick the bank account, check the starting check number, then print.',
  },
  '/sales-tax': {
    title: 'Pay Sales Tax',
    what: 'See the sales tax you collected and owe each tax agency, and pay it.',
    first: 'Pick the bank account and the "show tax due through" date, tick the agencies to pay, then pay.',
    qb: 'Pay Sales Tax',
  },
  '/onboarding': {
    title: 'Setup Interview',
    what: 'Answer a few questions about your company and the app turns on only the features you use.',
    first: 'Fill in your company details, pick your tax form, then choose the features. You can skip any time.',
    qb: 'EasyStep Interview',
  },
  // ---- Banking ----
  '/banking': {
    title: 'Bank accounts',
    what: 'Your bank and credit card accounts with their balances.',
    first: 'Click an account to see its transactions, or add a new account.',
    qb: 'Banking',
  },
  '/registers': {
    title: 'Registers',
    what: 'Every transaction in one account, like a checkbook, with a running balance.',
    first: 'Pick an account to open its register.',
    qb: 'Use Register',
  },
  '/bank-feeds': {
    title: 'Bank Feeds / Import',
    what: 'Bring in transactions from your bank (download or import a file) so you do not type them.',
    first: 'Pick the bank account and import the file from your bank, then review each line.',
    qb: 'Bank Feeds',
  },
  '/bank-review': {
    title: 'Review bank transactions',
    what: 'Match each imported bank line to a transaction you entered, or add it.',
    first: 'Work down the list: confirm the suggested match or choose a category.',
    qb: 'Bank Feeds Center',
  },
  '/bank-rules': {
    title: 'Bank rules',
    what: 'Rules tell the app which account to use for bank lines that look alike, such as every SHELL OIL charge going to Fuel. It also offers rules when you repeat a choice.',
    first: 'Click "New rule", say what the bank line contains and which account it goes to, then test it.',
    qb: 'Bank Feeds Rules',
  },
  '/deposits': {
    title: 'Make Deposits',
    what: 'Group customer payments you took to the bank into one deposit, so it matches your bank statement.',
    first: 'Tick the payments you deposited, choose the bank account and save.',
    qb: 'Make Deposits',
  },
  '/month-end': {
    title: 'Close the month',
    what: 'A guided checklist for the end of each month: reconcile, tidy up, review balances, then lock the books.',
    first: 'Pick the month, work through each step, then close the books and download the report pack.',
    qb: 'Month-End Close / Set Closing Date',
  },
  '/reconcile': {
    title: 'Reconcile',
    what: 'Check your books against your bank statement so you know every transaction is right.',
    first: 'Pick the account, enter the statement date and ending balance, then tick what cleared.',
    qb: 'Reconcile',
  },
  '/transfers': {
    title: 'Transfer Funds',
    what: 'Move money between your own accounts, for example checking to savings.',
    first: 'Pick the from and to accounts and the amount.',
    qb: 'Transfer Funds',
  },
  '/loans': {
    title: 'Loans',
    what: 'Track loans you owe, their payments and how much is interest.',
    first: 'Add a loan with its amount, rate and term.',
    qb: 'Loan Manager',
  },
  '/accountant/batch-enter': {
    title: 'Enter many transactions',
    what: 'Type or paste lots of checks, deposits, card charges, bills, invoices or journal entries in one spreadsheet-style grid. Each row is checked as you go and saved as its own transaction.',
    first: 'Pick the transaction type, then type rows or paste them from Excel or Google Sheets. Fix rows marked red, then save.',
    qb: 'Batch Enter Transactions',
  },
  // ---- Employees ----
  '/pay-runs': {
    title: 'Run payroll',
    what: 'Pay your employees: work out each paycheck, the taxes withheld and what you owe the government.',
    first: 'Pick the pay period and employees, check the paychecks, then create them.',
    qb: 'Pay Employees',
  },
  '/employees': {
    title: 'Employees & payroll',
    what: 'Your employees, their pay rates and tax settings.',
    first: 'Add each employee, then run payroll.',
    qb: 'Employee Center',
  },
  '/pay-liabilities': {
    title: 'Pay payroll taxes',
    what: 'Send the payroll taxes you withheld and owe to the government.',
    first: 'Pick the date range, tick what you are paying and choose the bank account.',
    qb: 'Pay Payroll Liabilities',
  },
  // ---- Reports / Company ----
  '/reports': {
    title: 'Report Center',
    what: 'Every report in one place: profit, what you own and owe, sales, spending, taxes and more.',
    first: 'Start with Profit & Loss and Balance Sheet; click any report to open it.',
    qb: 'Report Center',
  },
  '/reports/profit-loss': {
    title: 'Profit & Loss',
    what: 'Money in minus money out for a period: did the business make or lose money?',
    first: 'Choose the dates at the top; click any amount to see the transactions behind it.',
    qb: 'Profit & Loss Standard',
  },
  '/reports/balance-sheet': {
    title: 'Balance Sheet',
    what: 'What the business owns, what it owes, and what is left over for the owners, on one date.',
    first: 'Pick the date at the top; click any amount to see the details.',
    qb: 'Balance Sheet Standard',
  },
  '/reports/drilldown': {
    title: "What's behind this number",
    what: 'Every transaction that adds up to the amount you clicked on a report, using the same dates, basis and filters as the report.',
    first: 'Click a date to open that transaction and its original document; use Back to return to the report where you left it.',
    qb: 'QuickZoom',
  },
  '/accounts': {
    title: 'Chart of Accounts',
    what: 'The categories your money is sorted into: bank accounts, income, expenses, what you own and owe.',
    first: 'Look through the list; add an account only when you need a new category.',
    qb: 'Chart of Accounts',
  },
  '/journal': {
    title: 'Journal entries',
    what: 'Move amounts between accounts directly. Mostly used by accountants for adjustments.',
    first: 'Ask your accountant before using it; debits must equal credits.',
    qb: 'Make General Journal Entries',
  },
  '/recurring': {
    title: 'Recurring transactions',
    what: 'Transactions you enter again and again (rent, subscriptions), saved so they repeat on schedule or with one click.',
    first: 'Save a transaction as recurring from its form, then set how often.',
    qb: 'Memorized Transactions',
  },
  // gapsb K
  '/change-password': {
    title: 'Change My Password',
    what: 'Choose a new password for signing in, following the password rules an Admin set under Users & Roles. When your password expires, you come here first.',
    first: 'Type your current password, then the new one twice, and click Change password.',
    qb: 'Change Your Password',
  },
  '/sandbox': {
    title: 'Try it on a copy',
    what: 'Opens a throwaway copy of your whole company file so you can practise or test a change. Emails, bank feeds and automatic backups are off there.',
    first: 'Click "Try it on a copy". When done, discard the copy or keep it as a training file.',
    qb: 'Sample / practice company file',
  },
  '/settings': {
    title: 'Preferences',
    what: 'Settings for the whole company and just for you, such as features you use and the menu style.',
    first: 'Open a category on the left, change what you need and save.',
    qb: 'Edit > Preferences',
  },
  // team backups
  '/backup': {
    title: 'Back Up & Restore',
    what: 'Keeps safe copies of your company file, automatically on a schedule and whenever you ask. Look inside any copy before you restore it.',
    first: 'Check the automatic backup schedule, then click "Back up now" to make a copy today.',
    qb: 'Back Up Company / Restore Previous Local Backup',
  },
  // ---- Accountant's Copy (I1) / Period Copy (I7) ----
  '/accountant/accountants-copy': {
    title: "Accountant's Copy",
    what: 'Send your books to your accountant while you keep working. They fix things dated on or before a dividing date; you keep entering everything after it, then bring their changes in after reviewing them.',
    first: 'Pick the dividing date and create the copy. When the changes come back, import them here.',
    qb: "Accountant's Copy",
  },
  '/accountant/period-copy': {
    title: 'Period Copy',
    what: 'A separate copy of your company file that shows only one period, for an auditor: opening balances for everything before it and nothing after it. Your own file is not changed.',
    first: 'Pick the first and last day of the period and click "Create Period Copy".',
    qb: 'Period Copy',
  },
};

/** The help for a path (longest matching prefix, so /registers/abc gets the Registers help). */
export function pageHelpFor(pathname: string): PageHelpEntry | null {
  const path = pathname.split('?')[0].split('#')[0];
  let best: string | null = null;
  for (const key of Object.keys(PAGE_HELP)) {
    if (path === key || path.startsWith(key + '/')) {
      if (!best || key.length > best.length) best = key;
    }
  }
  return best ? PAGE_HELP[best] : null;
}
