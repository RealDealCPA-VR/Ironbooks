/**
 * The Report Center's report cards, by QB menu group (app/reports/page.tsx renders them;
 * lib/reports/reportCenter.test.ts checks every report page and catalog report is listed).
 */
import {
  AlertCircle,
  BarChart2,
  BarChart3,
  Banknote,
  Bookmark,
  BookOpen,
  Boxes,
  Building2,
  CalendarClock,
  CalendarRange,
  ClipboardList,
  Clock,
  FileCode2,
  FileText,
  Grid3x3,
  History,
  Landmark,
  Layers,
  List,
  ListChecks,
  MapPin,
  MessageSquare,
  Package,
  PackageCheck,
  Percent,
  PhoneCall,
  PieChart,
  Receipt,
  Scale,
  Search,
  SearchX,
  ShieldAlert,
  ShoppingCart,
  Target,
  TrendingUp,
  Truck,
  Users,
  Wallet,
  Wrench,
  Ban,
} from 'lucide-react';

import type { ComponentType } from 'react';

export interface ReportCardProps {
  href: string;
  icon: ComponentType<{ className?: string }>;
  name: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Report definitions
// ---------------------------------------------------------------------------

const FINANCIAL_REPORTS: ReportCardProps[] = [
  { href: '/reports/profit-loss', icon: BarChart2, name: 'Profit & Loss', description: 'Revenue, expenses, and net income over a date range.' },
  { href: '/reports/pl-percent', icon: Percent, name: 'P&L — % of Income', description: 'Common-size income statement: each line as a % of income.' },
  { href: '/reports/pl-comparative', icon: TrendingUp, name: 'P&L — Comparative', description: 'Current vs prior period with dollar and percent variance.' },
  { href: '/reports/pl-monthly', icon: CalendarRange, name: 'P&L — By Month', description: 'Income and expenses broken out month by month.' },
  { href: '/reports/profit-loss-cash', icon: Wallet, name: 'P&L — Cash Basis', description: 'Income and expenses counted when they are paid (cash basis).' },
  { href: '/reports/pl-by-class', icon: BarChart3, name: 'P&L by Class', description: 'Income and expenses split out per class/division.' },
  { href: '/reports/std/profit-loss-by-job', icon: BarChart3, name: 'P&L by Job', description: 'Income and expenses per customer or job.' },
  { href: '/reports/balance-sheet', icon: Scale, name: 'Balance Sheet', description: 'Assets, liabilities, and equity as of a date — with optional prior-date comparison.' },
  { href: '/reports/balance-sheet-cash', icon: Scale, name: 'Balance Sheet — Cash Basis', description: 'Balance sheet with unpaid invoices and bills left out of income and expenses.' },
  { href: '/reports/balance-sheet-classified', icon: Scale, name: 'Classified Balance Sheet', description: 'Current and long-term assets and liabilities.' },
  { href: '/reports/std/balance-sheet-prev-year', icon: Layers, name: 'Balance Sheet — Prev Year Comparison', description: 'This balance sheet next to the same date last year.' },
  { href: '/reports/trial-balance', icon: BookOpen, name: 'Trial Balance', description: 'All account debit and credit balances as of a date.' },
  { href: '/reports/general-ledger', icon: List, name: 'General Ledger', description: 'Every account: beginning balance, transactions and ending balance.' },
  { href: '/reports/transaction-detail', icon: ListChecks, name: 'Transaction Detail', description: 'Filterable journal-line listing with running totals.' },
  { href: '/reports/cash-flow', icon: TrendingUp, name: 'Statement of Cash Flows', description: 'Operating, investing, and financing cash movements.' },
  { href: '/reports/std/cash-flow-forecast', icon: CalendarRange, name: 'Cash Flow Forecast', description: 'The cash you can expect week by week from open invoices, bills and bank transactions.' },
];

const ACCOUNTANT_REPORTS: ReportCardProps[] = [
  { href: '/reports/std/adjusting-journal-entries', icon: BookOpen, name: 'Adjusting Journal Entries', description: 'Journal entries marked as adjusting entries, with all their lines.' },
  { href: '/reports/std/income-tax-preparation', icon: FileText, name: 'Income Tax Preparation', description: 'Which tax form line each account adds up to.' },
  { href: '/reports/std/income-tax-summary', icon: Receipt, name: 'Income Tax Summary', description: 'Totals by tax form line, in form order.' },
  { href: '/reports/std/income-tax-detail', icon: ListChecks, name: 'Income Tax Detail', description: 'The accounts behind each tax form line.' },
  { href: '/reports/voided-deleted', icon: Ban, name: 'Voided/Deleted Transactions', description: 'Every transaction voided or deleted, who did it and when.' },
  { href: '/reports/closing-date-exceptions', icon: ShieldAlert, name: 'Closing Date Exceptions', description: 'Changes made on or before the closing date with the closing date password.' },
  { href: '/audit-trail', icon: History, name: 'Audit Trail', description: 'Every change to every transaction and list record.' },
  { href: '/transaction-log', icon: ClipboardList, name: 'Transaction Log', description: 'The tamper-evident log of every saved change, with download and verification.' },
];

const RECEIVABLES_PAYABLES_REPORTS: ReportCardProps[] = [
  { href: '/reports/ar-aging', icon: Clock, name: 'A/R Aging Summary', description: 'Outstanding customer balances bucketed by days past due.' },
  { href: '/reports/ar-aging-detail', icon: Clock, name: 'A/R Aging Detail', description: 'Each open invoice listed under its aging bucket.' },
  { href: '/reports/open-invoices', icon: FileText, name: 'Open Invoices', description: 'Every unpaid invoice with its current balance due.' },
  { href: '/reports/collections', icon: PhoneCall, name: 'Collections Report', description: 'Overdue invoices grouped by customer with contact details.' },
  { href: '/reports/ap-aging', icon: AlertCircle, name: 'A/P Aging Summary', description: 'Vendor bills owed, bucketed by days past due.' },
  { href: '/reports/ap-aging-detail', icon: AlertCircle, name: 'A/P Aging Detail', description: 'Each open bill listed under its aging bucket.' },
  { href: '/reports/std/unpaid-bills-detail', icon: AlertCircle, name: 'Unpaid Bills Detail', description: 'Open bills and credits by vendor, with days past due.' },
  { href: '/reports/sales-tax', icon: Percent, name: 'Sales Tax Liability', description: 'Sales tax collected, paid and still owed, by tax agency.' },
  { href: '/reports/std/sales-tax-revenue-summary', icon: Percent, name: 'Sales Tax Revenue Summary', description: 'Taxable and non-taxable sales and the tax on them, per sales tax item.' },
  { href: '/reports/statements', icon: FileText, name: 'Customer Statements', description: 'Per-customer invoice and payment history statements.' },
  { href: '/reports/1099', icon: Receipt, name: '1099 Summary', description: 'Annual vendor payments for 1099-NEC / 1099-MISC filing.' },
  { href: '/reports/1099-efile', icon: FileCode2, name: '1099 E-File', description: 'Generate the 1099-NEC e-file XML for IRS FIRE submission.' },
];

const SALES_PURCHASES_REPORTS: ReportCardProps[] = [
  { href: '/reports/sales-by-customer', icon: TrendingUp, name: 'Sales by Customer Summary', description: 'Sales per customer and job over a date range.' },
  { href: '/reports/sales-by-item', icon: Package, name: 'Sales by Item Summary', description: 'Quantity, sales, COGS, and gross margin per item.' },
  { href: '/reports/sales-by-rep', icon: Users, name: 'Sales by Rep', description: 'Sales totals and earned commission per sales rep.' },
  { href: '/reports/purchases-by-vendor', icon: Truck, name: 'Purchases by Vendor Summary', description: 'Items bought from each vendor over a date range.' },
  { href: '/reports/purchases-by-item', icon: ShoppingCart, name: 'Purchases by Item Summary', description: 'Quantity and cost per item from vendor bills.' },
];

const INVENTORY_REPORTS: ReportCardProps[] = [
  { href: '/reports/inventory-valuation', icon: Boxes, name: 'Inventory Valuation', description: 'On hand, average cost and asset value per item, today or on a past date.' },
  { href: '/reports/std/inventory-stock-status-by-item', icon: PackageCheck, name: 'Inventory Stock Status by Item', description: 'On hand, on order, available and when to reorder.' },
  { href: '/reports/std/inventory-stock-status-by-vendor', icon: Truck, name: 'Inventory Stock Status by Vendor', description: 'Stock status grouped by preferred vendor.' },
  { href: '/reports/std/physical-inventory-worksheet', icon: ClipboardList, name: 'Physical Inventory Worksheet', description: 'A count sheet with every item and a blank count column.' },
  { href: '/reports/inventory-sites', icon: MapPin, name: 'Inventory by Site', description: 'Quantity on hand, stock status, reorder, and serial/lot numbers by site.' },
];

const PAYROLL_REPORTS: ReportCardProps[] = [
  { href: '/reports/payroll-summary', icon: Users, name: 'Payroll Summary', description: 'Wages, taxes, deductions and net pay per employee.' },
  { href: '/reports/std/employee-earnings-summary', icon: Users, name: 'Employee Earnings Summary', description: 'One line per employee with each tax and deduction.' },
  { href: '/reports/std/payroll-liability-balances', icon: Landmark, name: 'Payroll Liability Balances', description: 'Payroll taxes and deductions still owed.' },
  { href: '/reports/std/employee-contact-list', icon: PhoneCall, name: 'Employee Contact List', description: 'Employees with phone, email, address and SS No. (last four digits).' },
];

const BANKING_REPORTS: ReportCardProps[] = [
  { href: '/reports/check-detail', icon: Banknote, name: 'Check Detail', description: 'Every check written, with split lines and paid bills.' },
  { href: '/reports/missing-checks', icon: SearchX, name: 'Missing Checks', description: 'Gaps in the check-number sequence per bank account.' },
  { href: '/reports/deposit-detail', icon: Landmark, name: 'Deposit Detail', description: 'Bank deposits with their deposited payments and lines.' },
  { href: '/reports/reconciliation', icon: Scale, name: 'Reconciliation Reports', description: 'Past reconciliations with cleared and uncleared detail.' },
];

const PLANNING_REPORTS: ReportCardProps[] = [
  { href: '/budgets', icon: Target, name: 'Set Up Budgets & Forecasts', description: 'Budgets by account, class or customer:job; create from last year, copy and adjust.' },
  { href: '/reports/std/budget-overview', icon: Target, name: 'Budget Overview', description: 'Your budgeted amounts month by month.' },
  { href: '/reports/std/budget-vs-actual-report', icon: Target, name: 'Budget vs. Actual', description: 'Actual results against the budget.' },
  { href: '/reports/std/forecast-overview', icon: TrendingUp, name: 'Forecast Overview', description: 'Your forecast month by month.' },
];

const OTHER_REPORTS: ReportCardProps[] = [
  { href: '/reports/memorized', icon: Bookmark, name: 'Memorized Reports', description: 'Your saved reports and report groups. Run several at once (Process Multiple Reports) and export them together.' },
  { href: '/reports/commented', icon: MessageSquare, name: 'Commented Reports', description: 'Reports saved with your comments on their amounts, to print or send.' },
  { href: '/reports/schedules', icon: CalendarClock, name: 'Scheduled Reports', description: 'Save or email memorized reports automatically every day, week or month.' },
  { href: '/reports/graphs', icon: PieChart, name: 'Graphs', description: 'Income & expense, net worth, sales, A/R, A/P and budget vs actual charts.' },
  { href: '/reports/pivot', icon: Grid3x3, name: 'Advanced Reporting', description: 'Slice your ledger or item sales by any two things — account, class, customer, month and more.' },
  { href: '/find', icon: Search, name: 'Find Transactions', description: 'Search every transaction by type, name, amount, number, account, date or memo.' },
  { href: '/reports/builder', icon: Wrench, name: 'Report Builder', description: 'Build, run, and save custom reports with your own filters.' },
  { href: '/reports/consolidated', icon: Building2, name: 'Consolidated Reports', description: 'Multi-company P&L and balance sheet roll-ups.' },
];

/** Every card section, in Report Center order. */
export const REPORT_CENTER_SECTIONS: { title: string; cards: ReportCardProps[] }[] = [
  { title: 'Financial', cards: FINANCIAL_REPORTS },
  { title: 'Accountant & Taxes', cards: ACCOUNTANT_REPORTS },
  { title: 'Receivables / Payables', cards: RECEIVABLES_PAYABLES_REPORTS },
  { title: 'Sales / Purchases', cards: SALES_PURCHASES_REPORTS },
  { title: 'Inventory', cards: INVENTORY_REPORTS },
  { title: 'Employees & Payroll', cards: PAYROLL_REPORTS },
  { title: 'Banking', cards: BANKING_REPORTS },
  { title: 'Planning', cards: PLANNING_REPORTS },
  { title: 'Report tools', cards: OTHER_REPORTS },
];

