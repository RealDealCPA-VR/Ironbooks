/**
 * Single source of truth for app navigation. The sidebar (components/AppShell.tsx) renders
 * `navGroups`; the command palette (components/CommandPalette.tsx) derives its "Go to"
 * destinations from the same data so the two can never drift apart.
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
} from 'lucide-react';

export interface NavLink {
  icon: ComponentType<{ className?: string }>;
  label: string;
  path: string;
}
export interface NavGroup {
  heading: string;
  links: NavLink[];
}

export const navGroups: NavGroup[] = [
  {
    heading: '',
    links: [{ icon: PieChart, label: 'Dashboard', path: '/dashboard' }],
  },
  {
    heading: 'Sales',
    links: [
      { icon: FileText, label: 'Invoices', path: '/invoices' },
      { icon: Receipt, label: 'Sales Receipts', path: '/sales-receipts' },
      { icon: ClipboardList, label: 'Estimates', path: '/estimates' },
      { icon: FileCheck, label: 'Sales Orders', path: '/sales-orders' },
      { icon: HandCoins, label: 'Receive Payments', path: '/payments' },
      { icon: RotateCcw, label: 'Credit Memos', path: '/credit-memos' },
      { icon: Users, label: 'Customers', path: '/customers' },
      { icon: Percent, label: 'Finance Charges', path: '/finance-charges' },
      { icon: Package, label: 'Items', path: '/items' },
      { icon: BadgePercent, label: 'Sales Reps', path: '/sales-reps' },
    ],
  },
  {
    heading: 'Purchases',
    links: [
      { icon: ShoppingCart, label: 'Purchase Orders', path: '/purchase-orders' },
      { icon: PackageSearch, label: 'Receive Items', path: '/item-receipts' },
      { icon: Receipt, label: 'Bills', path: '/bills' },
      { icon: HandCoins, label: 'Pay Bills', path: '/pay-bills' },
      { icon: Banknote, label: 'Write Checks', path: '/expenses' },
      { icon: RotateCcw, label: 'Vendor Credits', path: '/vendor-credits' },
      { icon: Printer, label: 'Print Checks', path: '/print-checks' },
      { icon: Truck, label: 'Vendors', path: '/vendors' },
    ],
  },
  {
    heading: 'Banking',
    links: [
      { icon: CreditCard, label: 'Banking', path: '/banking' },
      { icon: BookOpen, label: 'Registers', path: '/registers' },
      { icon: Rss, label: 'Bank Feeds', path: '/bank-feeds' },
      { icon: ListChecks, label: 'Bank Review', path: '/bank-review' },
      { icon: PiggyBank, label: 'Deposits', path: '/deposits' },
      { icon: Banknote, label: 'Reconcile', path: '/reconcile' },
      { icon: ArrowLeftRight, label: 'Transfers', path: '/transfers' },
    ],
  },
  {
    heading: 'Accounting',
    links: [
      { icon: NotebookPen, label: 'Journal', path: '/journal' },
      { icon: BookOpen, label: 'Chart of Accounts', path: '/accounts' },
      { icon: Landmark, label: 'Pay Liabilities', path: '/pay-liabilities' },
      { icon: UserSquare, label: 'Payroll', path: '/employees' },
      { icon: CalendarClock, label: 'Pay Runs', path: '/pay-runs' },
      { icon: FileSpreadsheet, label: 'Pay Stubs', path: '/pay-stubs' },
      { icon: ClipboardList, label: 'Payroll Forms', path: '/payroll-forms' },
      { icon: Calculator, label: 'Payroll Tax', path: '/payroll-tax' },
      { icon: Tag, label: 'Tracking', path: '/tracking' },
      { icon: Percent, label: 'Tax Components', path: '/sales-tax-components' },
      { icon: Repeat, label: 'Recurring', path: '/recurring' },
      { icon: Coins, label: 'Currencies', path: '/currencies' },
      { icon: CalendarRange, label: 'Fiscal Periods', path: '/fiscal-periods' },
      { icon: CalendarClock, label: 'Year-End Close', path: '/year-end' },
    ],
  },
  {
    heading: 'Insights',
    links: [
      { icon: BarChart2, label: 'Reports', path: '/reports' },
      { icon: Wrench, label: 'Report Builder', path: '/reports/builder' },
      { icon: Wallet, label: 'P&L (Cash Basis)', path: '/reports/profit-loss-cash' },
      { icon: GitCompareArrows, label: 'P&L Comparative', path: '/reports/pl-comparative' },
      { icon: CalendarRange, label: 'P&L by Month', path: '/reports/pl-monthly' },
      { icon: Scale, label: 'Balance Sheet (Cash)', path: '/reports/balance-sheet-cash' },
      { icon: Tag, label: 'P&L by Class', path: '/reports/pl-by-class' },
      { icon: Boxes, label: 'Inventory Valuation', path: '/reports/inventory-valuation' },
      { icon: UserSquare, label: 'Payroll Reports', path: '/reports/payroll-summary' },
      { icon: Banknote, label: 'Reconciliation Reports', path: '/reports/reconciliation' },
      { icon: Network, label: 'Consolidated', path: '/reports/consolidated' },
      { icon: AlertTriangle, label: 'AI Review', path: '/errors' },
    ],
  },
  {
    heading: 'Admin',
    links: [
      { icon: FileClock, label: 'Audit Trail', path: '/audit-trail' },
      { icon: Paperclip, label: 'Attachments', path: '/attachments' },
      { icon: BadgeCheck, label: 'Data Integrity', path: '/integrity' },
      { icon: GitMerge, label: 'Merge Records', path: '/merge' },
      { icon: FileX, label: '1099 E-File', path: '/reports/1099-efile' },
      { icon: Clock, label: 'Estimate Follow-up', path: '/estimates-followup' },
    ],
  },
  {
    heading: 'Operations',
    links: [
      { icon: BriefcaseIcon, label: 'Jobs', path: '/jobs' },
      { icon: Timer, label: 'Time Tracking', path: '/time-tracking' },
      { icon: Car, label: 'Mileage', path: '/mileage' },
      { icon: Boxes, label: 'Fixed Assets', path: '/fixed-assets' },
      { icon: Combine, label: 'Assemblies', path: '/assemblies' },
      { icon: PackageSearch, label: 'Inventory Ops', path: '/inventory-ops' },
      { icon: Layers, label: 'FIFO Inventory', path: '/fifo' },
      { icon: HandCoins, label: 'Customer Pricing', path: '/customer-pricing' },
      { icon: FileSpreadsheet, label: 'Expense Reports', path: '/expense-reports' },
    ],
  },
  {
    heading: 'Setup',
    links: [
      { icon: Building2, label: 'Companies', path: '/companies' },
      { icon: HardDrive, label: 'Company File', path: '/company-file' },
      { icon: ShieldCheck, label: 'Security (2FA)', path: '/security' },
      { icon: Network, label: 'Privacy & Network', path: '/privacy' },
      { icon: Users, label: 'Multi-user', path: '/multi-user' },
      { icon: Settings, label: 'Settings', path: '/settings' },
    ],
  },
];

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
