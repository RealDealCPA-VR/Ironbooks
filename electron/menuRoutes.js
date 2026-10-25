// QuickBooks-style application menus (Company, Customers, Vendors, Employees, Banking, Reports,
// Lists) as plain data: label -> in-app route. electron/main.js turns them into native menu items
// that navigate through the DesktopBridge IPC ('navigate'); the Window menu is built there.
//
// Pure module (no electron import) so tests can check every route is a real page.
// Shortcut keys are only SHOWN next to the items (`shortcut`, rendered as an accelerator with
// registerAccelerator: false): the app's own handlers own the QuickBooks keys (Ctrl+W/I/J/A/R/T,
// GLOBAL_SHORTCUTS in lib/shortcuts.ts), so they keep their rules for keys typed into fields
// (Ctrl+A still selects a field's text) instead of a native accelerator grabbing every press.

'use strict';

/** @typedef {{ label: string, route: string, shortcut?: string } | { separator: true }} MenuEntry */

/** @type {Array<{ label: string, items: MenuEntry[] }>} */
const MENU_SECTIONS = [
  {
    label: 'Company',
    items: [
      { label: 'Home', route: '/dashboard' },
      { label: 'Calendar', route: '/calendar' },
      { label: 'To Do List', route: '/todos' },
      { label: 'Reminders', route: '/reminders' },
      { label: 'Lead Center', route: '/leads' },
      { label: 'Doc Center', route: '/attachments' },
      { separator: true },
      { label: 'Company Information…', route: '/settings' },
      { label: 'Preferences…', route: '/settings' },
      { label: 'Setup Interview…', route: '/onboarding' },
      { label: 'Form Templates', route: '/templates' },
      { label: 'Users and Roles', route: '/users' },
      { label: 'Set Closing Date / Fiscal Periods', route: '/fiscal-periods' },
      { separator: true },
      { label: 'Chart of Accounts', route: '/accounts', shortcut: 'Ctrl+A' },
      { label: 'Make General Journal Entries', route: '/journal' },
      { label: 'Memorized Transaction List', route: '/recurring', shortcut: 'Ctrl+T' },
      { label: 'Prepare Letters with Envelopes', route: '/letters' },
      { label: 'Budgets', route: '/budgets' },
    ],
  },
  {
    label: 'Customers',
    items: [
      { label: 'Customer Center', route: '/customers', shortcut: 'Ctrl+J' },
      { label: 'Create Invoices', route: '/invoices?new=1', shortcut: 'Ctrl+I' },
      { label: 'Create Estimates', route: '/estimates' },
      { label: 'Create Sales Orders', route: '/sales-orders' },
      { label: 'Enter Sales Receipts', route: '/sales-receipts' },
      { label: 'Receive Payments', route: '/payments' },
      { label: 'Create Credit Memos/Refunds', route: '/credit-memos' },
      { label: 'Create Statements', route: '/reports/statements' },
      { label: 'Assess Finance Charges', route: '/finance-charges' },
      { separator: true },
      { label: 'Lead Center', route: '/leads' },
      { label: 'Jobs', route: '/jobs' },
    ],
  },
  {
    label: 'Vendors',
    items: [
      { label: 'Vendor Center', route: '/vendors' },
      { label: 'Enter Bills', route: '/bills' },
      { label: 'Pay Bills', route: '/pay-bills' },
      { label: 'Create Purchase Orders', route: '/purchase-orders' },
      { label: 'Receive Items', route: '/item-receipts' },
      { label: 'Enter Bill for Received Items', route: '/receive-bill' },
      { label: 'Vendor Credits', route: '/vendor-credits' },
      { label: 'Pay Sales Tax', route: '/sales-tax' },
      { separator: true },
      { label: '1099 Summary', route: '/reports/1099' },
    ],
  },
  {
    label: 'Employees',
    items: [
      { label: 'Employee Center', route: '/employees' },
      { label: 'Pay Employees', route: '/pay-runs' },
      { label: 'Pay Payroll Liabilities', route: '/pay-liabilities' },
      { label: 'Pay Stubs', route: '/pay-stubs' },
      { label: 'Payroll Tax Forms', route: '/payroll-forms' },
      { separator: true },
      { label: 'Enter Time', route: '/time-tracking' },
      { label: 'Enter Mileage', route: '/mileage' },
    ],
  },
  {
    label: 'Banking',
    items: [
      { label: 'Write Checks', route: '/expenses?new=1', shortcut: 'Ctrl+W' },
      { label: 'Make Deposits', route: '/deposits' },
      { label: 'Transfer Funds', route: '/transfers' },
      { label: 'Use Register', route: '/registers', shortcut: 'Ctrl+R' },
      { label: 'Reconcile', route: '/reconcile' },
      { label: 'Bank Feeds', route: '/bank-feeds' },
      { label: 'Print Checks', route: '/print-checks' },
      { label: 'Enter Batch Transactions', route: '/accountant/batch-enter' },
    ],
  },
  {
    label: 'Reports',
    items: [
      { label: 'Report Center', route: '/reports' },
      { label: 'Report Builder', route: '/reports/builder' },
      { separator: true },
      { label: 'Profit & Loss', route: '/reports/profit-loss' },
      { label: 'Balance Sheet', route: '/reports/balance-sheet' },
      { label: 'Statement of Cash Flows', route: '/reports/cash-flow' },
      { label: 'Trial Balance', route: '/reports/trial-balance' },
      { label: 'General Ledger', route: '/reports/general-ledger' },
      { separator: true },
      { label: 'A/R Aging', route: '/reports/ar-aging' },
      { label: 'A/P Aging', route: '/reports/ap-aging' },
      { label: 'Sales by Customer', route: '/reports/sales-by-customer' },
      { label: 'Inventory Valuation', route: '/reports/inventory-valuation' },
      { label: 'Payroll Summary', route: '/reports/payroll-summary' },
    ],
  },
  {
    label: 'Lists',
    items: [
      { label: 'Chart of Accounts', route: '/accounts', shortcut: 'Ctrl+A' },
      { label: 'Item List', route: '/items' },
      { label: 'Class and Location Lists', route: '/tracking' },
      { label: 'Memorized Transaction List', route: '/recurring', shortcut: 'Ctrl+T' },
      { label: 'Templates', route: '/templates' },
      { label: 'Price Levels', route: '/advanced-pricing' },
      { label: 'Sales Rep List', route: '/sales-reps' },
      { label: 'Currency List', route: '/currencies' },
      { label: 'Fixed Asset Item List', route: '/fixed-assets' },
    ],
  },
];

/** Every distinct route the menus can open (for tests). */
function menuRoutes() {
  const out = new Set();
  for (const section of MENU_SECTIONS) {
    for (const item of section.items) if ('route' in item) out.add(item.route);
  }
  return [...out];
}

/**
 * Electron menu template for the sections, given a navigate(route) callback. Shortcut keys are
 * displayed, not registered (registerAccelerator: false, Windows / Linux). macOS has no such
 * switch — a menu key equivalent would take the key before the page — so they are left off there.
 * @param {(route: string) => void} navigate
 * @param {string} [platform] process.platform (for tests)
 */
function buildSectionMenus(navigate, platform = process.platform) {
  const showKeys = platform !== 'darwin';
  return MENU_SECTIONS.map((section) => ({
    label: section.label,
    submenu: section.items.map((item) => {
      if ('separator' in item) return { type: 'separator' };
      const entry = { label: item.label, click: () => navigate(item.route) };
      return item.shortcut && showKeys
        ? { ...entry, accelerator: item.shortcut, registerAccelerator: false }
        : entry;
    }),
  }));
}

module.exports = { MENU_SECTIONS, menuRoutes, buildSectionMenus };
