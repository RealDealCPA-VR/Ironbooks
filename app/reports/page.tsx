'use client';

import Link from 'next/link';
import {
  BarChart2,
  Scale,
  BookOpen,
  List,
  ListChecks,
  TrendingUp,
  Clock,
  AlertCircle,
  FileText,
  Receipt,
  Target,
  Percent,
  Users,
  Package,
  ShoppingCart,
  Truck,
  Banknote,
  Landmark,
  SearchX,
  PhoneCall,
  CalendarRange,
  Layers,
  Wallet,
  BarChart3,
  Building2,
  FileCode2,
  Wrench,
  MapPin,
} from 'lucide-react';
import { Card, PageHeader } from '@/components/ui';

// ---------------------------------------------------------------------------
// Report link card
// ---------------------------------------------------------------------------

interface ReportCardProps {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  name: string;
  description: string;
}

function ReportCard({ href, icon: Icon, name, description }: ReportCardProps) {
  return (
    <Link href={href} className="group focus:outline-none">
      <Card className="flex items-start gap-4 p-5 transition-all duration-150 hover:shadow-2xl hover:border-electric/40 group-focus:ring-2 group-focus:ring-electric/40 cursor-pointer h-full">
        <div className="flex-shrink-0 rounded-xl bg-electric/10 p-2.5 group-hover:bg-electric/20 transition-colors">
          <Icon className="h-5 w-5 text-electric" />
        </div>
        <div className="min-w-0">
          <p className="font-semibold text-navy text-sm leading-snug mb-0.5 group-hover:text-electric transition-colors">
            {name}
          </p>
          <p className="text-xs text-navy/50 leading-snug">{description}</p>
        </div>
      </Card>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Section header
// ---------------------------------------------------------------------------

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-bold uppercase tracking-widest text-navy/40 mb-3 mt-8 first:mt-0">
      {children}
    </h2>
  );
}

// ---------------------------------------------------------------------------
// Report definitions
// ---------------------------------------------------------------------------

const FINANCIAL_REPORTS: ReportCardProps[] = [
  {
    href: '/reports/profit-loss',
    icon: BarChart2,
    name: 'Profit & Loss',
    description: 'Revenue, expenses, and net income over a date range.',
  },
  {
    href: '/reports/pl-percent',
    icon: Percent,
    name: 'P&L — % of Income',
    description: 'Common-size income statement: each line as a % of income.',
  },
  {
    href: '/reports/pl-comparative',
    icon: TrendingUp,
    name: 'P&L — Comparative',
    description: 'Current vs prior period with dollar and percent variance.',
  },
  {
    href: '/reports/pl-monthly',
    icon: CalendarRange,
    name: 'P&L — By Month',
    description: 'Income and expenses broken out month by month.',
  },
  {
    href: '/reports/profit-loss-cash',
    icon: Wallet,
    name: 'P&L — Cash Basis',
    description: 'Income statement adjusted for AR/AP to a cash basis.',
  },
  {
    href: '/reports/pl-by-class',
    icon: BarChart3,
    name: 'P&L by Class',
    description: 'Income and expenses split out per class/division.',
  },
  {
    href: '/reports/balance-sheet',
    icon: Scale,
    name: 'Balance Sheet',
    description: 'Assets, liabilities, and equity as of a date — with optional prior-date comparison.',
  },
  {
    href: '/reports/balance-sheet-cash',
    icon: Scale,
    name: 'Balance Sheet — Cash Basis',
    description: 'Balance sheet with receivables and payables excluded.',
  },
  {
    href: '/reports/balance-sheet-classified',
    icon: Layers,
    name: 'Balance Sheet — Classified',
    description: 'Balance sheet grouped into current / long-term sections.',
  },
  {
    href: '/reports/trial-balance',
    icon: BookOpen,
    name: 'Trial Balance',
    description: 'All account debit and credit balances as of a date.',
  },
  {
    href: '/reports/general-ledger',
    icon: List,
    name: 'General Ledger',
    description: 'Every posted transaction entry across all accounts.',
  },
  {
    href: '/reports/transaction-detail',
    icon: ListChecks,
    name: 'Transaction Detail',
    description: 'Filterable journal-line listing with running totals.',
  },
  {
    href: '/reports/cash-flow',
    icon: TrendingUp,
    name: 'Cash Flow',
    description: 'Operating, investing, and financing cash movements.',
  },
];

const RECEIVABLES_PAYABLES_REPORTS: ReportCardProps[] = [
  {
    href: '/reports/ar-aging',
    icon: Clock,
    name: 'A/R Aging Summary',
    description: 'Outstanding customer balances bucketed by days past due.',
  },
  {
    href: '/reports/ar-aging-detail',
    icon: Clock,
    name: 'A/R Aging Detail',
    description: 'Each open invoice listed under its aging bucket.',
  },
  {
    href: '/reports/open-invoices',
    icon: FileText,
    name: 'Open Invoices',
    description: 'Every unpaid invoice with its current balance due.',
  },
  {
    href: '/reports/collections',
    icon: PhoneCall,
    name: 'Collections Report',
    description: 'Overdue invoices grouped by customer with contact details.',
  },
  {
    href: '/reports/ap-aging',
    icon: AlertCircle,
    name: 'A/P Aging Summary',
    description: 'Vendor bills owed, bucketed by days past due.',
  },
  {
    href: '/reports/ap-aging-detail',
    icon: AlertCircle,
    name: 'A/P Aging Detail',
    description: 'Each open bill listed under its aging bucket.',
  },
  {
    href: '/reports/statements',
    icon: FileText,
    name: 'Customer Statements',
    description: 'Per-customer invoice and payment history statements.',
  },
  {
    href: '/reports/1099',
    icon: Receipt,
    name: '1099 Summary',
    description: 'Annual vendor payments for 1099-NEC / 1099-MISC filing.',
  },
  {
    href: '/reports/1099-efile',
    icon: FileCode2,
    name: '1099 E-File',
    description: 'Generate the 1099-NEC e-file XML for IRS FIRE submission.',
  },
];

const SALES_PURCHASES_REPORTS: ReportCardProps[] = [
  {
    href: '/reports/sales-by-customer',
    icon: TrendingUp,
    name: 'Sales by Customer',
    description: 'Invoiced totals per customer over a date range.',
  },
  {
    href: '/reports/sales-by-item',
    icon: Package,
    name: 'Sales by Item',
    description: 'Quantity, revenue, COGS, and margin per item.',
  },
  {
    href: '/reports/sales-by-rep',
    icon: Users,
    name: 'Sales by Rep',
    description: 'Sales totals and earned commission per sales rep.',
  },
  {
    href: '/reports/purchases-by-vendor',
    icon: Truck,
    name: 'Purchases by Vendor',
    description: 'Billed totals per vendor over a date range.',
  },
  {
    href: '/reports/purchases-by-item',
    icon: ShoppingCart,
    name: 'Purchases by Item',
    description: 'Quantity and cost per item from vendor bills.',
  },
  {
    href: '/reports/inventory-sites',
    icon: MapPin,
    name: 'Inventory by Site',
    description: 'Quantity on hand, stock status, reorder, and serial/lot numbers by site.',
  },
];

const BANKING_REPORTS: ReportCardProps[] = [
  {
    href: '/reports/check-detail',
    icon: Banknote,
    name: 'Check Detail',
    description: 'Every check written, with split lines and paid bills.',
  },
  {
    href: '/reports/missing-checks',
    icon: SearchX,
    name: 'Missing Checks',
    description: 'Gaps in the check-number sequence per bank account.',
  },
  {
    href: '/reports/deposit-detail',
    icon: Landmark,
    name: 'Deposit Detail',
    description: 'Bank deposits with their deposited payments and lines.',
  },
  {
    href: '/reports/reconciliation',
    icon: Scale,
    name: 'Reconciliation Reports',
    description: 'Past reconciliations with cleared and uncleared detail.',
  },
];

const PLANNING_REPORTS: ReportCardProps[] = [
  {
    href: '/budgets',
    icon: Target,
    name: 'Budget vs Actual',
    description: 'Compare planned budgets against real income and expenses.',
  },
];

const OTHER_REPORTS: ReportCardProps[] = [
  {
    href: '/reports/builder',
    icon: Wrench,
    name: 'Report Builder',
    description: 'Build, run, and save custom reports with your own filters.',
  },
  {
    href: '/reports/payroll-summary',
    icon: Users,
    name: 'Payroll Reports',
    description: 'Payroll summary, paycheck detail, and liability balances.',
  },
  {
    href: '/reports/consolidated',
    icon: Building2,
    name: 'Consolidated Reports',
    description: 'Multi-company P&L and balance sheet roll-ups.',
  },
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ReportsPage() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader title="Reports" icon={BarChart2} />

      <SectionHeading>Financial</SectionHeading>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {FINANCIAL_REPORTS.map((r) => (
          <ReportCard key={r.href} {...r} />
        ))}
      </div>

      <SectionHeading>Receivables / Payables</SectionHeading>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {RECEIVABLES_PAYABLES_REPORTS.map((r) => (
          <ReportCard key={r.href} {...r} />
        ))}
      </div>

      <SectionHeading>Sales / Purchases</SectionHeading>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {SALES_PURCHASES_REPORTS.map((r) => (
          <ReportCard key={r.href} {...r} />
        ))}
      </div>

      <SectionHeading>Banking</SectionHeading>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {BANKING_REPORTS.map((r) => (
          <ReportCard key={r.href} {...r} />
        ))}
      </div>

      <SectionHeading>Planning</SectionHeading>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {PLANNING_REPORTS.map((r) => (
          <ReportCard key={r.href} {...r} />
        ))}
      </div>

      <SectionHeading>Other</SectionHeading>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {OTHER_REPORTS.map((r) => (
          <ReportCard key={r.href} {...r} />
        ))}
      </div>
    </main>
  );
}
