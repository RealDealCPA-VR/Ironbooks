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
  ScrollText,
  Warehouse, Ship, MapPin,
} from 'lucide-react';
import { pageAreasFor } from '@/lib/permissions/routes';
import type { Area } from '@/lib/permissions/model';
import { Sparkles } from 'lucide-react'; // team ai: AI & Automation
// team pricing: advanced pricing, SO fulfillment worksheet, enhanced receiving
import { PackageCheck, FileInput, SlidersHorizontal } from 'lucide-react';
// wave-2 lists: Lists hub, To Do, Add/Edit Multiple, Clean Up, Inventory Center
import { ClipboardCheck, Table2, Eraser } from 'lucide-react';
// wave2 sales: Income Tracker, Collections Center, Batch Invoicing
import { TrendingUp, PhoneCall } from 'lucide-react';

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
      { icon: PackageCheck, label: 'SO Fulfillment', path: '/so-fulfillment' },
      { icon: HandCoins, label: 'Receive Payments', path: '/payments' },
      { icon: RotateCcw, label: 'Credit Memos', path: '/credit-memos' },
      { icon: Users, label: 'Customers', path: '/customers' },
      { icon: Percent, label: 'Finance Charges', path: '/finance-charges' },
      { icon: TrendingUp, label: 'Income Tracker', path: '/income-tracker' },
      { icon: PhoneCall, label: 'Collections Center', path: '/collections-center' },
      { icon: Layers, label: 'Batch Invoicing', path: '/invoices/batch' },
      { icon: Package, label: 'Items', path: '/items' },
      { icon: BadgePercent, label: 'Sales Reps', path: '/sales-reps' },
      { icon: SlidersHorizontal, label: 'Advanced Pricing', path: '/advanced-pricing' },
    ],
  },
  {
    heading: 'Purchases',
    links: [
      { icon: ShoppingCart, label: 'Purchase Orders', path: '/purchase-orders' },
      { icon: PackageSearch, label: 'Receive Items', path: '/item-receipts' },
      { icon: FileInput, label: 'Bill Received Items', path: '/receive-bill' },
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
      { icon: Landmark, label: 'Loan Manager', path: '/loans' },
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
      { icon: MapPin, label: 'Inventory by Site', path: '/reports/inventory-sites' },
      { icon: UserSquare, label: 'Payroll Reports', path: '/reports/payroll-summary' },
      { icon: Banknote, label: 'Reconciliation Reports', path: '/reports/reconciliation' },
      { icon: Percent, label: 'Sales Tax Liability', path: '/reports/sales-tax' }, // wave2 accountant
      { icon: Network, label: 'Consolidated', path: '/reports/consolidated' },
      { icon: AlertTriangle, label: 'AI Review', path: '/errors' },
    ],
  },
  {
    heading: 'Admin',
    links: [
      { icon: FileClock, label: 'Audit Trail', path: '/audit-trail' },
      { icon: BriefcaseIcon, label: 'Accountant Center', path: '/accountant' }, // wave2 accountant
      { icon: ScrollText, label: 'Transaction Log', path: '/transaction-log' },
      { icon: Paperclip, label: 'Attachments', path: '/attachments' },
      { icon: BadgeCheck, label: 'Data Integrity', path: '/integrity' },
      { icon: GitMerge, label: 'Merge Records', path: '/merge' },
      { icon: Eraser, label: 'Clean Up Lists', path: '/lists/cleanup' },
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
      { icon: Warehouse, label: 'Inventory Center', path: '/inventory-center' },
      { icon: PackageSearch, label: 'Inventory Ops', path: '/inventory-ops' },
      { icon: Layers, label: 'FIFO Inventory', path: '/fifo' },
      { icon: Warehouse, label: 'Inventory Sites', path: '/inventory-sites' },
      { icon: ArrowLeftRight, label: 'Transfer Inventory', path: '/inventory-transfers' },
      { icon: Ship, label: 'Landed Cost', path: '/landed-cost' },
      { icon: HandCoins, label: 'Customer Pricing', path: '/customer-pricing' },
      { icon: FileSpreadsheet, label: 'Expense Reports', path: '/expense-reports' },
      { icon: ListChecks, label: 'Lists', path: '/lists' },
      { icon: ClipboardCheck, label: 'To Do', path: '/lists/todos' },
      { icon: Table2, label: 'Add/Edit Multiple', path: '/lists/multiple' },
    ],
  },
  {
    heading: 'Setup',
    links: [
      { icon: Building2, label: 'Companies', path: '/companies' },
      { icon: HardDrive, label: 'Company File', path: '/company-file' },
      { icon: Users, label: 'Users & Roles', path: '/users' },
      { icon: FileSpreadsheet, label: 'Migrate from QuickBooks', path: '/qb-import' },
      { icon: ShieldCheck, label: 'Security (2FA)', path: '/security' },
      { icon: Network, label: 'Privacy & Network', path: '/privacy' },
      { icon: Users, label: 'Multi-user', path: '/multi-user' },
      { icon: Settings, label: 'Settings', path: '/settings' },
      { icon: ListChecks, label: 'Document Numbers', path: '/doc-numbers' }, // wave2 foundation
      { icon: Sparkles, label: 'AI & Automation', path: '/ai-settings' },
    ],
  },
];

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
      links: g.links.filter((l) => {
        const areas = pageAreasFor(l.path);
        return !areas || areas.some((a) => permissions[a]?.includes('view') ?? false);
      }),
    }))
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
