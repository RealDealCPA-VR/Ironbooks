/**
 * Single source of truth for app navigation. The sidebar (components/AppShell.tsx) renders
 * `navGroups` (Advanced mode) or `simpleNavGroups` (Simple mode, the default for new users); the
 * command palette (components/CommandPalette.tsx) and the sidebar search box (`searchPages`)
 * derive their destinations from the same data so they can never drift apart.
 *
 * Labels are plain language. Where QuickBooks uses another name, it is kept in `qb` — shown as
 * the link's tooltip and matched by search — so a QuickBooks user still finds "Finance Charges".
 */
import type { ComponentType } from 'react';
import {
  PieChart, CreditCard, BookOpen, FileText, BarChart2,
  Users, Settings, Truck, Package, Receipt, Banknote, AlertTriangle, NotebookPen,
  Building2, FileCheck, ClipboardList, RotateCcw, HandCoins, ArrowLeftRight,
  Printer, UserSquare, Tag, Repeat, Coins, Rss, Wrench, Calculator,
  ShoppingCart, PiggyBank, FileSpreadsheet, CalendarClock, Briefcase as BriefcaseIcon,
  Layers, ShieldCheck, Network, Landmark, FileClock, Paperclip, BadgeCheck,
  ListChecks, GitMerge, FileX, Clock, Timer, Boxes, Wallet, Percent, Combine,
  GitCompareArrows, CalendarRange, PackageSearch, Scale, BadgePercent, Car, HardDrive,
  ScrollText,
  Warehouse, Ship, MapPin,
} from 'lucide-react';
import { pageAreasFor } from '@/lib/permissions/routes';
import type { Area } from '@/lib/permissions/model';
import { matchIntentsScored } from '@/lib/nav-actions';
import { Sparkles } from 'lucide-react'; // team ai: AI & Automation
// team pricing: advanced pricing, SO fulfillment worksheet, enhanced receiving
import { PackageCheck, FileInput, SlidersHorizontal } from 'lucide-react';
// wave-2 lists: Lists hub, To Do, Add/Edit Multiple, Clean Up, Inventory Center
import { ClipboardCheck, Table2, Eraser } from 'lucide-react';
// wave2 sales: Income Tracker, Collections Center, Batch Invoicing
import { TrendingUp, PhoneCall } from 'lucide-react';
import { Bookmark, LineChart, Grid3x3, Search } from 'lucide-react'; // wave2 reports
// wave2 prefs: calendar, reminders, lead center, letters, form templates
import { Bell, CalendarDays, Contact, Mail, LayoutTemplate } from 'lucide-react';
// p1 ux: Simple mode
import { Home, PenLine, FilePlus2 } from 'lucide-react';
import { Inbox } from 'lucide-react'; // team home: Needs attention inbox
import { ScanLine } from 'lucide-react'; // receipt capture
import { ArchiveRestore } from 'lucide-react'; // team backups
import { CalendarCheck } from 'lucide-react'; // month-end close
import { KeyRound } from 'lucide-react'; // gapsb K: Change My Password

export interface NavLink {
  icon: ComponentType<{ className?: string }>;
  label: string;
  /** Page path: decides the active highlight, permissions and feature toggles. */
  path: string;
  /** Where the link goes when that differs from `path` (e.g. '/invoices?new=1' opens the form). */
  href?: string;
  /** The QuickBooks name when the label uses plainer words (tooltip + search). */
  qb?: string;
  /** Extra words people might search for. */
  keywords?: string;
}
export interface NavGroup {
  heading: string;
  links: NavLink[];
}

export type NavMode = 'simple' | 'advanced';

export const navGroups: NavGroup[] = [
  {
    heading: '',
    links: [
      { icon: PieChart, label: 'Home', path: '/dashboard', qb: 'Home page', keywords: 'dashboard start overview' },
      { icon: Inbox, label: 'Needs attention', path: '/attention', qb: 'Company Snapshot alerts', keywords: 'inbox alerts urgent caught up' },
      { icon: ClipboardCheck, label: 'To Do list', path: '/todos', qb: 'To Do List', keywords: 'task reminder call follow up' },
    ],
  },
  {
    heading: 'Sales',
    links: [
      { icon: FileText, label: 'Invoices', path: '/invoices', qb: 'Create Invoices', keywords: 'bill a customer charge' },
      { icon: Receipt, label: 'Sales Receipts', path: '/sales-receipts', qb: 'Enter Sales Receipts', keywords: 'cash sale paid now' },
      { icon: ClipboardList, label: 'Estimates', path: '/estimates', qb: 'Create Estimates', keywords: 'quote bid proposal' },
      { icon: FileCheck, label: 'Sales Orders', path: '/sales-orders', qb: 'Create Sales Orders', keywords: 'order backorder' },
      { icon: PackageCheck, label: 'Sales order fulfillment', path: '/so-fulfillment', qb: 'Sales Order Fulfillment Worksheet (SO Fulfillment)', keywords: 'ship orders pick' },
      { icon: HandCoins, label: 'Receive Payments', path: '/payments', qb: 'Receive Payments', keywords: 'customer paid got paid collect' },
      { icon: RotateCcw, label: 'Credit Memos', path: '/credit-memos', qb: 'Create Credit Memos/Refunds', keywords: 'refund return credit' },
      { icon: Users, label: 'Customers', path: '/customers', qb: 'Customer Center', keywords: 'clients' },
      { icon: Contact, label: 'Leads', path: '/leads', qb: 'Lead Center', keywords: 'prospects' },
      { icon: Percent, label: 'Late-payment charges', path: '/finance-charges', qb: 'Assess Finance Charges', keywords: 'interest late fee overdue' },
      { icon: TrendingUp, label: 'Money coming in', path: '/income-tracker', qb: 'Income Tracker', keywords: 'unbilled open invoices paid' },
      { icon: PhoneCall, label: 'Collect overdue payments', path: '/collections-center', qb: 'Collections Center', keywords: 'overdue late customers' },
      { icon: Layers, label: 'Invoice many customers', path: '/invoices/batch', qb: 'Batch Invoicing', keywords: 'batch bulk invoices' },
      { icon: Package, label: 'Items', path: '/items', qb: 'Item List', keywords: 'products services inventory parts' },
      { icon: BadgePercent, label: 'Sales Reps', path: '/sales-reps', qb: 'Sales Rep List', keywords: 'commission' },
      { icon: SlidersHorizontal, label: 'Pricing rules', path: '/advanced-pricing', qb: 'Advanced Pricing', keywords: 'price rules discounts' },
    ],
  },
  {
    heading: 'Purchases',
    links: [
      { icon: ShoppingCart, label: 'Purchase Orders', path: '/purchase-orders', qb: 'Create Purchase Orders', keywords: 'po order from vendor' },
      { icon: PackageSearch, label: 'Receive Items', path: '/item-receipts', qb: 'Receive Items', keywords: 'inventory arrived' },
      { icon: FileInput, label: 'Bill for received items', path: '/receive-bill', qb: 'Enter Bill for Received Items', keywords: 'bill items received' },
      { icon: Receipt, label: 'Enter Bills', path: '/bills', qb: 'Enter Bills', keywords: 'bill vendor invoice owe' },
      { icon: HandCoins, label: 'Pay Bills', path: '/pay-bills', qb: 'Pay Bills', keywords: 'pay vendor supplier' },
      { icon: Banknote, label: 'Write Checks', path: '/expenses', qb: 'Write Checks', keywords: 'check cheque expense spend debit card purchase' },
      { icon: ScanLine, label: 'Receipts', path: '/receipts', qb: 'Doc Center (receipts)', keywords: 'receipt photo scan snap ocr phone upload capture' },
      { icon: RotateCcw, label: 'Vendor Credits', path: '/vendor-credits', qb: 'Enter Credit from Vendor', keywords: 'vendor refund return' },
      { icon: Percent, label: 'Pay Sales Tax', path: '/sales-tax', qb: 'Pay Sales Tax', keywords: 'sales tax liability agency remit' }, // p1 purchases
      { icon: Printer, label: 'Print Checks', path: '/print-checks', qb: 'Print Checks', keywords: 'print cheques' },
      { icon: Truck, label: 'Vendors', path: '/vendors', qb: 'Vendor Center', keywords: 'suppliers' },
    ],
  },
  {
    heading: 'Banking',
    links: [
      { icon: CreditCard, label: 'Bank accounts', path: '/banking', qb: 'Banking', keywords: 'bank checking savings credit card' },
      { icon: BookOpen, label: 'Registers', path: '/registers', qb: 'Use Register (Check Register)', keywords: 'check register ledger' },
      { icon: Rss, label: 'Bank Feeds', path: '/bank-feeds', qb: 'Bank Feeds', keywords: 'import download bank transactions csv ofx qfx' },
      { icon: ListChecks, label: 'Review bank transactions', path: '/bank-review', qb: 'Bank Feeds Center (review)', keywords: 'match categorize' },
      { icon: PiggyBank, label: 'Make Deposits', path: '/deposits', qb: 'Make Deposits', keywords: 'deposit bank undeposited' },
      { icon: Banknote, label: 'Reconcile', path: '/reconcile', qb: 'Reconcile', keywords: 'bank statement balance checkbook' },
      { icon: ArrowLeftRight, label: 'Transfer Funds', path: '/transfers', qb: 'Transfer Funds', keywords: 'move money transfer' },
      { icon: Landmark, label: 'Loans', path: '/loans', qb: 'Loan Manager', keywords: 'loan mortgage' },
      { icon: Table2, label: 'Enter many transactions', path: '/accountant/batch-enter', qb: 'Batch Enter Transactions', keywords: 'batch paste excel google sheets spreadsheet grid bulk checks deposits bills journal' }, // team keyboard
    ],
  },
  {
    heading: 'Accounting',
    links: [
      { icon: NotebookPen, label: 'Journal entries', path: '/journal', qb: 'Make General Journal Entries', keywords: 'journal adjust gl' },
      { icon: BookOpen, label: 'Chart of Accounts', path: '/accounts', qb: 'Chart of Accounts', keywords: 'accounts categories' },
      { icon: Landmark, label: 'Pay payroll taxes', path: '/pay-liabilities', qb: 'Pay Payroll Liabilities', keywords: 'liabilities withholding' },
      { icon: UserSquare, label: 'Employees & payroll', path: '/employees', qb: 'Employee Center / Payroll', keywords: 'employees staff paycheck' },
      { icon: Settings, label: 'Payroll Setup', path: '/employees/setup', qb: 'Payroll Setup', keywords: 'payroll items' },
      { icon: CalendarClock, label: 'Run payroll', path: '/pay-runs', qb: 'Pay Employees', keywords: 'pay run paycheck payroll' },
      { icon: FileSpreadsheet, label: 'Pay Stubs', path: '/pay-stubs', qb: 'Pay Stubs', keywords: 'paystub' },
      { icon: ClipboardList, label: 'Payroll Forms', path: '/payroll-forms', qb: 'Process Payroll Forms', keywords: 'w-2 941 940' },
      { icon: Calculator, label: 'Payroll Tax', path: '/payroll-tax', qb: 'Payroll Tax', keywords: 'withholding calculator' },
      { icon: Tag, label: 'Classes & locations', path: '/tracking', qb: 'Class List / Tracking', keywords: 'class location department tracking' },
      { icon: Percent, label: 'Sales tax rates', path: '/sales-tax-components', qb: 'Sales Tax Items / Components', keywords: 'sales tax' },
      { icon: Repeat, label: 'Recurring transactions', path: '/recurring', qb: 'Memorized Transactions', keywords: 'memorized repeat schedule' },
      { icon: Coins, label: 'Currencies', path: '/currencies', qb: 'Currency List', keywords: 'foreign exchange' },
      { icon: CalendarRange, label: 'Fiscal Periods', path: '/fiscal-periods', qb: 'Fiscal Periods', keywords: 'closing date period' },
      { icon: CalendarClock, label: 'Year-End Close', path: '/year-end', qb: 'Set Closing Date', keywords: 'close year end' },
    ],
  },
  {
    heading: 'Reports',
    links: [
      { icon: BarChart2, label: 'Report Center', path: '/reports', qb: 'Report Center', keywords: 'reports' },
      { icon: Wrench, label: 'Report Builder', path: '/reports/builder', qb: 'Custom Reports', keywords: 'custom report' },
      { icon: TrendingUp, label: 'Profit & Loss', path: '/reports/profit-loss', qb: 'Profit & Loss Standard', keywords: 'p&l income statement' },
      { icon: Scale, label: 'Balance Sheet', path: '/reports/balance-sheet', qb: 'Balance Sheet Standard', keywords: 'assets liabilities' },
      { icon: Wallet, label: 'Profit & Loss (cash basis)', path: '/reports/profit-loss-cash', qb: 'Profit & Loss (cash basis)', keywords: 'p&l income statement' },
      { icon: GitCompareArrows, label: 'Profit & Loss comparison', path: '/reports/pl-comparative', qb: 'Profit & Loss Prev Year Comparison', keywords: 'p&l compare' },
      { icon: CalendarRange, label: 'Profit & Loss by month', path: '/reports/pl-monthly', qb: 'Profit & Loss by Month', keywords: 'p&l monthly' },
      { icon: Scale, label: 'Balance Sheet (cash basis)', path: '/reports/balance-sheet-cash', qb: 'Balance Sheet (cash basis)', keywords: 'balance sheet' },
      { icon: Tag, label: 'Profit & Loss by class', path: '/reports/pl-by-class', qb: 'Profit & Loss by Class', keywords: 'p&l class' },
      { icon: Boxes, label: 'Inventory Valuation', path: '/reports/inventory-valuation', qb: 'Inventory Valuation Summary', keywords: 'stock value' },
      { icon: MapPin, label: 'Inventory by Site', path: '/reports/inventory-sites', qb: 'Inventory Stock Status by Site', keywords: 'warehouse' },
      { icon: UserSquare, label: 'Payroll Reports', path: '/reports/payroll-summary', qb: 'Payroll Summary', keywords: 'payroll report' },
      { icon: ClipboardList, label: 'Payroll Item Reports', path: '/payroll-forms/reports', qb: 'Payroll Item Detail', keywords: 'payroll item' },
      { icon: Banknote, label: 'Reconciliation Reports', path: '/reports/reconciliation', qb: 'Previous Reconciliation', keywords: 'reconcile report' },
      { icon: Percent, label: 'Sales Tax Liability', path: '/reports/sales-tax', qb: 'Sales Tax Liability', keywords: 'sales tax owed' }, // wave2 accountant
      { icon: Network, label: 'Combined company reports', path: '/reports/consolidated', qb: 'Combine Reports from Multiple Companies', keywords: 'consolidated' },
      { icon: Bookmark, label: 'Saved reports', path: '/reports/memorized', qb: 'Memorized Reports', keywords: 'memorized' },
      { icon: LineChart, label: 'Graphs', path: '/reports/graphs', qb: 'Graphs', keywords: 'chart' },
      { icon: Grid3x3, label: 'Advanced Reporting', path: '/reports/pivot', qb: 'Advanced Reporting', keywords: 'pivot' },
      { icon: Search, label: 'Find Transactions', path: '/find', qb: 'Find', keywords: 'search lookup' },
      { icon: AlertTriangle, label: 'AI Review', path: '/errors', qb: 'Client Data Review', keywords: 'errors mistakes problems' },
    ],
  },
  {
    heading: 'Admin',
    links: [
      { icon: FileClock, label: 'Audit Trail', path: '/audit-trail', qb: 'Audit Trail', keywords: 'history who changed' },
      { icon: BriefcaseIcon, label: 'Accountant Center', path: '/accountant', qb: 'Accountant Center', keywords: 'accountant' }, // wave2 accountant
      { icon: CalendarCheck, label: 'Close the month', path: '/month-end', qb: 'Month-End Close / Set Closing Date', keywords: 'month end close checklist books closing' }, // month-end close
      { icon: ScrollText, label: 'Transaction Log', path: '/transaction-log', qb: 'Transaction Log', keywords: 'log' },
      { icon: Paperclip, label: 'Attached documents', path: '/attachments', qb: 'Doc Center', keywords: 'attachments receipts files scan' },
      { icon: Bell, label: 'Reminders', path: '/reminders', qb: 'Reminders', keywords: 'due overdue' },
      { icon: CalendarDays, label: 'Calendar', path: '/calendar', qb: 'Calendar', keywords: 'schedule' },
      { icon: Mail, label: 'Letters & Labels', path: '/letters', qb: 'Prepare Letters with Envelopes', keywords: 'mail merge labels' },
      { icon: BadgeCheck, label: 'Data Integrity', path: '/integrity', qb: 'Verify Data', keywords: 'verify rebuild' },
      { icon: GitMerge, label: 'Merge Records', path: '/merge', qb: 'Merge', keywords: 'duplicate combine' },
      { icon: Eraser, label: 'Clean Up Lists', path: '/lists/cleanup', qb: 'Clean Up Company Data', keywords: 'condense' },
      { icon: FileX, label: '1099 E-File', path: '/reports/1099-efile', qb: '1099 Wizard', keywords: '1099 contractor' },
      { icon: Clock, label: 'Estimate Follow-up', path: '/estimates-followup', qb: 'Estimates follow-up', keywords: 'quotes follow up' },
    ],
  },
  {
    heading: 'Operations',
    links: [
      { icon: BriefcaseIcon, label: 'Jobs', path: '/jobs', qb: 'Customer:Job', keywords: 'projects' },
      { icon: Timer, label: 'Time Tracking', path: '/time-tracking', qb: 'Enter Time / Timesheets', keywords: 'hours timesheet' },
      { icon: Car, label: 'Mileage', path: '/mileage', qb: 'Enter Vehicle Mileage', keywords: 'miles vehicle' },
      { icon: Boxes, label: 'Fixed Assets', path: '/fixed-assets', qb: 'Fixed Asset Item List', keywords: 'depreciation equipment' },
      { icon: Combine, label: 'Build products', path: '/assemblies', qb: 'Build Assemblies', keywords: 'assembly bill of materials' },
      { icon: Warehouse, label: 'Inventory Center', path: '/inventory-center', qb: 'Inventory Center', keywords: 'stock' },
      { icon: PackageSearch, label: 'Adjust inventory', path: '/inventory-ops', qb: 'Adjust Quantity/Value on Hand', keywords: 'inventory adjustment reorder count' },
      { icon: Layers, label: 'FIFO Inventory', path: '/fifo', qb: 'FIFO cost', keywords: 'first in first out cost layers' },
      { icon: Warehouse, label: 'Inventory Sites', path: '/inventory-sites', qb: 'Inventory Site List', keywords: 'warehouses locations' },
      { icon: ArrowLeftRight, label: 'Transfer Inventory', path: '/inventory-transfers', qb: 'Transfer Inventory', keywords: 'move stock' },
      { icon: Ship, label: 'Landed Cost', path: '/landed-cost', qb: 'Landed Cost', keywords: 'freight duty shipping cost' },
      { icon: HandCoins, label: 'Customer Pricing', path: '/customer-pricing', qb: 'Price Levels', keywords: 'price level' },
      { icon: FileSpreadsheet, label: 'Expense Reports', path: '/expense-reports', qb: 'Expense Reports', keywords: 'reimburse employee expenses' },
      { icon: ListChecks, label: 'Lists', path: '/lists', qb: 'Lists menu', keywords: 'terms ship via payment methods' },
      { icon: Table2, label: 'Add/Edit Multiple', path: '/lists/multiple', qb: 'Add/Edit Multiple List Entries', keywords: 'bulk' },
    ],
  },
  {
    heading: 'Setup',
    links: [
      { icon: Building2, label: 'Companies', path: '/companies', qb: 'Open or Restore Company', keywords: 'company file switch' },
      { icon: HardDrive, label: 'Company File', path: '/company-file', qb: 'Back Up Company', keywords: 'backup restore' },
      { icon: ArchiveRestore, label: 'Back Up & Restore', path: '/backup', qb: 'Back Up Company / Restore Previous Local Backup', keywords: 'backup restore automatic schedule versions' }, // team backups
      { icon: Users, label: 'Users & Roles', path: '/users', qb: 'Set Up Users and Roles', keywords: 'permissions access' },
      { icon: FileSpreadsheet, label: 'Migrate from QuickBooks', path: '/qb-import', qb: 'Import IIF / Convert', keywords: 'import iif convert' },
      { icon: ShieldCheck, label: 'Security (2FA)', path: '/security', qb: 'Security', keywords: 'two factor password' },
      { icon: KeyRound, label: 'Change My Password', path: '/change-password', qb: 'Change Your Password', keywords: 'new password expired' }, // gapsb K
      { icon: Network, label: 'Privacy & Network', path: '/privacy', qb: 'Privacy', keywords: 'internet offline' },
      { icon: Users, label: 'Multi-user', path: '/multi-user', qb: 'Multi-user mode', keywords: 'network share host' },
      { icon: Settings, label: 'Preferences', path: '/settings', qb: 'Edit > Preferences', keywords: 'settings options company info' },
      { icon: ClipboardCheck, label: 'Setup Interview', path: '/onboarding', qb: 'EasyStep Interview', keywords: 'setup wizard new company start' }, // P1 setup: run it again
      { icon: ListChecks, label: 'Document Numbers', path: '/doc-numbers', qb: 'Document numbering', keywords: 'numbering' }, // wave2 foundation
      { icon: LayoutTemplate, label: 'Form Templates', path: '/templates', qb: 'Templates / Layout Designer', keywords: 'invoice design logo' },
      { icon: Sparkles, label: 'AI & Automation', path: '/ai-settings', qb: 'AI settings', keywords: 'ai' },
    ],
  },
];

/**
 * Simple mode (p1 ux): ~18 everyday tasks grouped like the QuickBooks Home page. Payroll shows
 * only while payroll is on (Preferences > Payroll & Employees); every link still respects the
 * member's permissions and the feature switches.
 */
export const simpleNavGroups: NavGroup[] = [
  {
    heading: '',
    links: [
      { icon: Home, label: 'Home', path: '/dashboard', qb: 'Home page', keywords: 'dashboard start' },
      { icon: Inbox, label: 'Needs attention', path: '/attention', qb: 'Company Snapshot alerts', keywords: 'inbox alerts urgent caught up' },
      { icon: ClipboardCheck, label: 'To Do list', path: '/todos', qb: 'To Do List', keywords: 'task reminder' },
      { icon: ScanLine, label: 'Receipts', path: '/receipts', qb: 'Doc Center (receipts)', keywords: 'receipt photo scan snap phone' },
    ],
  },
  {
    heading: 'Customers',
    links: [
      { icon: FilePlus2, label: 'Create Invoice', path: '/invoices', href: '/invoices?new=1', qb: 'Create Invoices', keywords: 'bill a customer' },
      { icon: HandCoins, label: 'Receive Payment', path: '/payments', href: '/payments?new=1', qb: 'Receive Payments', keywords: 'got paid' },
      { icon: Users, label: 'Customers', path: '/customers', qb: 'Customer Center', keywords: 'clients' },
    ],
  },
  {
    heading: 'Vendors',
    links: [
      { icon: Receipt, label: 'Enter Bill', path: '/bills', qb: 'Enter Bills', keywords: 'got a bill' },
      { icon: Wallet, label: 'Pay Bills', path: '/pay-bills', qb: 'Pay Bills', keywords: 'pay vendor' },
      { icon: Truck, label: 'Vendors', path: '/vendors', qb: 'Vendor Center', keywords: 'suppliers' },
    ],
  },
  {
    heading: 'Banking',
    links: [
      { icon: PenLine, label: 'Write Check', path: '/expenses', href: '/expenses?new=1', qb: 'Write Checks', keywords: 'spend expense' },
      { icon: Rss, label: 'Bank Feeds / Import', path: '/bank-feeds', qb: 'Bank Feeds', keywords: 'download import bank' },
      { icon: Scale, label: 'Reconcile', path: '/reconcile', qb: 'Reconcile', keywords: 'bank statement' },
      { icon: PiggyBank, label: 'Make Deposit', path: '/deposits', href: '/deposits?new=1', qb: 'Make Deposits', keywords: 'deposit' },
    ],
  },
  {
    heading: 'Employees',
    links: [{ icon: CalendarClock, label: 'Run Payroll', path: '/pay-runs', qb: 'Pay Employees', keywords: 'paycheck' }],
  },
  {
    heading: 'Reports',
    links: [
      { icon: TrendingUp, label: 'Profit & Loss', path: '/reports/profit-loss', qb: 'Profit & Loss Standard', keywords: 'p&l income statement' },
      { icon: Scale, label: 'Balance Sheet', path: '/reports/balance-sheet', qb: 'Balance Sheet Standard', keywords: 'assets liabilities' },
      { icon: BarChart2, label: 'Report Center', path: '/reports', qb: 'Report Center', keywords: 'reports' },
    ],
  },
  {
    heading: 'Company',
    links: [
      { icon: BookOpen, label: 'Chart of Accounts', path: '/accounts', qb: 'Chart of Accounts', keywords: 'accounts' },
      { icon: Package, label: 'Items', path: '/items', qb: 'Item List', keywords: 'products services' },
      { icon: CalendarCheck, label: 'Close the month', path: '/month-end', qb: 'Month-End Close / Set Closing Date', keywords: 'month end close checklist books closing' }, // month-end close
    ],
  },
];

/** The groups for a menu style. */
export function navGroupsFor(mode: NavMode): NavGroup[] {
  return mode === 'advanced' ? navGroups : simpleNavGroups;
}

/** Where a link goes (its deep link when it has one). */
export function linkHref(l: NavLink): string {
  return l.href ?? l.path;
}

/**
 * Hide links the signed-in user's roles can't use (Users & Roles). COSMETIC ONLY — every API
 * route is enforced server-side (getServerContext + lib/permissions/routes.ts). A link needs
 * 'view' of (one of) the area(s) its path maps to in PAGE_AREAS; unmapped paths are always shown, and a
 * null permission set (not loaded yet / first run) shows everything.
 */
export function filterNavGroups(
  groups: NavGroup[],
  permissions: Partial<Record<Area, readonly string[]>> | null | undefined,
): NavGroup[] {
  if (!permissions) return groups;
  return groups
    .map((g) => ({
      ...g,
      links: g.links.filter((l) => canSeePath(l.path, permissions)),
    }))
    .filter((g) => g.links.length > 0);
}

function canSeePath(path: string, permissions: Partial<Record<Area, readonly string[]>> | null | undefined): boolean {
  if (!permissions) return true;
  const areas = pageAreasFor(path.split('?')[0].split('#')[0]);
  return !areas || areas.some((a) => permissions[a]?.includes('view') ?? false);
}

/**
 * The sidebar for one person: their menu style, minus pages their roles can't open and pages
 * whose feature is switched off (Preferences). Empty groups drop out.
 */
export function visibleNavGroups(
  mode: NavMode,
  permissions: Partial<Record<Area, readonly string[]>> | null | undefined,
  hiddenPaths: ReadonlySet<string>,
): NavGroup[] {
  return filterNavGroups(navGroupsFor(mode), permissions)
    .map((g) => ({ ...g, links: g.links.filter((l) => !hiddenPaths.has(l.path)) }))
    .filter((g) => g.links.length > 0);
}

/** Pages that exist but are intentionally not in the sidebar. */
export const EXTRA_DESTINATIONS: { label: string; href: string }[] = [
  { label: 'Budgets', href: '/budgets' },
  { label: 'Transactions', href: '/transactions' },
];

/** Flat list of palette destinations, derived from the sidebar so the two never drift. */
export const paletteDestinations: { label: string; href: string }[] = [
  ...navGroups.flatMap((g) => g.links.map((l) => ({ label: l.label, href: l.path }))),
  ...EXTRA_DESTINATIONS,
];

// ---------------------------------------------------------------------------
// Page search (sidebar search box)
// ---------------------------------------------------------------------------

export interface PageSearchResult {
  label: string;
  href: string;
  /** Plain-language note (intents) or the QuickBooks name. */
  description?: string;
  /** Menu group the page lives in ('Suggested' for plain-language matches). */
  group: string;
}

function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

const SEARCH_STOP = new Set(['a', 'an', 'the', 'my', 'to', 'i', 'of', 'for', 'and', 'how', 'do', 'want']);
function stemWord(w: string): string {
  if (w === 'checks' || w === 'cheque' || w === 'cheques') return 'check';
  if (w.length <= 3) return w;
  return w.replace(/(ies)$/, 'y').replace(/(ing|ed|es|s)$/, '');
}

interface Candidate {
  label: string;
  href: string;
  path: string;
  qb?: string;
  keywords?: string;
  group: string;
}

const CANDIDATES: Candidate[] = [
  ...navGroups.flatMap((g) =>
    g.links.map((l) => ({ label: l.label, href: linkHref(l), path: l.path, qb: l.qb, keywords: l.keywords, group: g.heading || 'Home' })),
  ),
  ...simpleNavGroups.flatMap((g) =>
    g.links.map((l) => ({ label: l.label, href: linkHref(l), path: l.path, qb: l.qb, keywords: l.keywords, group: g.heading || 'Home' })),
  ),
  ...EXTRA_DESTINATIONS.map((d) => ({ label: d.label, href: d.href, path: d.href, group: 'More' })),
  { label: 'Help & glossary', href: '/help', path: '/help', keywords: 'help explain what does mean glossary', group: 'More' },
];

function scoreCandidate(q: string, qWords: string[], c: Candidate): number {
  const label = c.label.toLowerCase();
  const qb = (c.qb ?? '').toLowerCase();
  if (label === q || qb === q) return 100;
  if (label.startsWith(q)) return 90;
  if (qb.startsWith(q)) return 85;
  // Everything typed is exactly this page's keyword list ("reports" -> Report Center): that is a
  // name the page answers to, so it beats a page whose label merely contains the word.
  const kw = words(c.keywords ?? '').map(stemWord);
  const qStems = qWords.filter((w) => !SEARCH_STOP.has(w)).map(stemWord);
  if (kw.length && qStems.length === kw.length && qStems.every((w, i) => w === kw[i])) return 80;
  if (label.includes(q)) return 75;
  if (qb.includes(q)) return 70;
  const hay = new Set([...words(c.label), ...words(c.qb ?? ''), ...words(c.keywords ?? ''), ...words(c.group)].map(stemWord));
  const meaningful = qWords.filter((w) => !SEARCH_STOP.has(w));
  if (!meaningful.length) return 0;
  const last = meaningful.length - 1;
  const hits = meaningful.filter((w, i) => {
    const s = stemWord(w);
    if (hay.has(s)) return true;
    // The word still being typed may match as a prefix.
    return i === last && w.length >= 2 && [...hay].some((h) => h.startsWith(s));
  }).length;
  if (hits === meaningful.length) return 50 + Math.min(hits, 5);
  return hits / meaningful.length >= 0.5 ? 20 + hits : 0;
}

/**
 * Find pages by name, QuickBooks name or plain words ("write checks", "pay a bill", "record a
 * sale"), best first. Only pages this person can open are returned (permissions + feature
 * switches), in both Simple and Advanced mode — search reaches every screen.
 */
export function searchPages(
  query: string,
  opts: {
    permissions?: Partial<Record<Area, readonly string[]>> | null;
    hiddenPaths?: ReadonlySet<string>;
    limit?: number;
  } = {},
): PageSearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const limit = opts.limit ?? 8;
  const allowed = (path: string) => {
    const base = path.split('?')[0].split('#')[0];
    return !opts.hiddenPaths?.has(base) && canSeePath(base, opts.permissions);
  };
  const out: PageSearchResult[] = [];
  const seen = new Set<string>();
  const push = (r: PageSearchResult) => {
    const key = r.href.split('?')[0].split('#')[0];
    if (seen.has(key)) return;
    seen.add(key);
    out.push(r);
  };
  const qWords = words(q);
  const ranked = CANDIDATES.map((c, order) => ({ c, order, score: scoreCandidate(q, qWords, c) }))
    .filter((s) => s.score > 0 && allowed(s.c.path))
    .sort((a, b) => b.score - a.score || a.order - b.order);
  const pushPage = ({ c }: (typeof ranked)[number]) =>
    push({ label: c.label, href: c.href, description: c.qb && c.qb !== c.label ? `QuickBooks: ${c.qb}` : undefined, group: c.group });
  // 1. The page whose name (or QuickBooks name) contains what was typed ("finance charges").
  ranked.filter((s) => s.score >= 70).forEach(pushPage);
  // 2. Plain-language intents where a whole phrase was typed ("enter a bill" -> Enter Bills,
  //    "I got paid" -> Receive Payments).
  const intents = matchIntentsScored(query, 3);
  const pushIntent = ({ intent: i }: (typeof intents)[number]) => {
    if (allowed(i.href)) push({ label: i.label, href: i.href, description: i.description, group: 'Suggested' });
  };
  intents.filter((i) => i.score >= 100).forEach(pushIntent);
  // 3. Pages where every meaningful word typed matches the name or keywords ("late fee" ->
  //    Late-payment charges, "make a deposit" -> Make Deposits). A full keyword match beats a
  //    loose plain-language guess, so it ranks above the partial intents.
  ranked.filter((s) => s.score >= 50 && s.score < 70).forEach(pushPage);
  // 4. Looser plain-language intents.
  intents.filter((i) => i.score < 100).forEach(pushIntent);
  // 5. Pages where only some of the words match.
  ranked.filter((s) => s.score < 50).forEach(pushPage);
  return out.slice(0, limit);
}
