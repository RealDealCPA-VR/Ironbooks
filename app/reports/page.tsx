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
  Bookmark,
  PieChart,
  Grid3x3,
  CalendarClock,
  Search,
} from 'lucide-react';
import { REPORT_CATALOG, REPORT_GROUPS } from '@/lib/reports/catalog';
import { canDo, useMe } from '@/lib/usePermissions';
import { Card, PageHeader } from '@/components/ui';
import { Help } from '@/components/Help';

// ---------------------------------------------------------------------------
// Report link card
// ---------------------------------------------------------------------------

interface ReportCardProps {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  name: string;
  description: string;
}

/**
 * Reports offered on both bases open on the company's Reports preference ("Default report
 * basis"); the report's own Accrual / Cash toggle switches it.
 */
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
    description: 'Income and expenses counted when they are paid (cash basis).',
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
    description: 'Balance sheet with unpaid invoices and bills left out of income and expenses.',
  },
  {
    href: '/reports/std/balance-sheet-prev-year',
    icon: Layers,
    name: 'Balance Sheet — Prev Year Comparison',
    description: 'This balance sheet next to the same date last year.',
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
    description: 'Every account: beginning balance, transactions and ending balance.',
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
    name: 'Statement of Cash Flows',
    description: 'Operating, investing, and financing cash movements.',
  },
  {
    href: '/reports/std/profit-loss-by-job',
    icon: BarChart3,
    name: 'P&L by Job',
    description: 'Income and expenses per customer or job.',
  },
];

const ACCOUNTANT_REPORTS: ReportCardProps[] = [
  {
    href: '/reports/std/adjusting-journal-entries',
    icon: BookOpen,
    name: 'Adjusting Journal Entries',
    description: 'Journal entries marked as adjusting entries, with all their lines.',
  },
  {
    href: '/reports/std/income-tax-preparation',
    icon: FileText,
    name: 'Income Tax Preparation',
    description: 'Which tax form line each account adds up to.',
  },
  {
    href: '/reports/std/income-tax-summary',
    icon: Receipt,
    name: 'Income Tax Summary',
    description: 'Totals by tax form line, in form order.',
  },
  {
    href: '/reports/std/income-tax-detail',
    icon: ListChecks,
    name: 'Income Tax Detail',
    description: 'The accounts behind each tax form line.',
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
    href: '/reports/std/unpaid-bills-detail',
    icon: AlertCircle,
    name: 'Unpaid Bills Detail',
    description: 'Open bills and credits by vendor, with days past due.',
  },
  {
    href: '/reports/std/sales-tax-liability',
    icon: Percent,
    name: 'Sales Tax Liability',
    description: 'Sales tax collected, paid and still owed, by tax agency.',
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
    name: 'Sales by Customer Summary',
    description: 'Sales per customer and job over a date range.',
  },
  {
    href: '/reports/sales-by-item',
    icon: Package,
    name: 'Sales by Item Summary',
    description: 'Quantity, sales, COGS, and gross margin per item.',
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
    name: 'Purchases by Vendor Summary',
    description: 'Items bought from each vendor over a date range.',
  },
  {
    href: '/reports/purchases-by-item',
    icon: ShoppingCart,
    name: 'Purchases by Item Summary',
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
    href: '/reports/memorized',
    icon: Bookmark,
    name: 'Memorized Reports',
    description: 'Your saved reports and report groups. Run several at once and export them together.',
  },
  {
    href: '/reports/graphs',
    icon: PieChart,
    name: 'Graphs',
    description: 'Income & expense, net worth, sales, A/R, A/P and budget vs actual charts.',
  },
  {
    href: '/reports/pivot',
    icon: Grid3x3,
    name: 'Advanced Reporting',
    description: 'Slice your ledger or item sales by any two things — account, class, customer, month and more.',
  },
  {
    href: '/reports/schedules',
    icon: CalendarClock,
    name: 'Scheduled Reports',
    description: 'Save memorized reports to a folder automatically every day, week or month.',
  },
  {
    href: '/find',
    icon: Search,
    name: 'Find Transactions',
    description: 'Search every transaction by type, name, amount, number, account, date or memo.',
  },
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

function AllStandardReports() {
  const { me } = useMe();
  const visible = REPORT_CATALOG.filter((r) => !r.hidden && canDo(me, r.area, 'view'));
  return (
    <>
      <SectionHeading>All reports</SectionHeading>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {REPORT_GROUPS.map((g) => {
          const list = visible.filter((r) => r.group === g);
          if (list.length === 0) return null;
          return (
            <Card key={g} className="p-5">
              <h3 className="text-sm font-bold text-navy mb-2">{g}</h3>
              <ul className="space-y-1.5">
                {list.map((r) => (
                  <li key={r.key}>
                    <Link href={`/reports/std/${r.key}`} className="text-sm font-medium text-electric hover:underline">
                      {r.title}
                    </Link>
                    <span className="block text-xs text-navy/50">{r.description}</span>
                  </li>
                ))}
              </ul>
            </Card>
          );
        })}
      </div>
    </>
  );
}

export default function ReportsPage() {
  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader title="Reports" icon={BarChart2} />

      {/* Start here: the three questions most owners ask, in plain language. */}
      <section aria-labelledby="reports-start" className="mb-8 rounded-2xl border border-slate-200/70 bg-white p-5 shadow-xl">
        <h2 id="reports-start" className="text-sm font-bold uppercase tracking-wide text-navy/70 mb-3">
          New to reports? Start here
        </h2>
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-3 text-sm">
          <li>
            <Link href="/reports/profit-loss" className="font-semibold text-electric hover:underline">
              Am I making money?
            </Link>
            <span className="block text-navy/50">Profit &amp; Loss: income minus expenses for a period.</span>
          </li>
          <li>
            <Link href="/reports/balance-sheet" className="font-semibold text-electric hover:underline">
              What do I own and owe?
            </Link>
            <span className="block text-navy/50">Balance Sheet: your accounts on a single date.</span>
          </li>
          <li>
            <Link href="/reports/ar-aging" className="font-semibold text-electric hover:underline">
              Who owes me money?
            </Link>
            <span className="block text-navy/50">A/R Aging: unpaid invoices by how late they are.</span>
          </li>
        </ul>
        <p className="mt-3 flex items-center gap-1 text-xs text-navy/50">
          Most reports can be viewed on an accrual or cash basis.
          <Help term="accrual-vs-cash" side="bottom" />
        </p>
      </section>

      <SectionHeading>Financial</SectionHeading>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {FINANCIAL_REPORTS.map((r) => (
          <ReportCard key={r.href} {...r} />
        ))}
      </div>

      <SectionHeading>Accountant &amp; Taxes</SectionHeading>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {ACCOUNTANT_REPORTS.map((r) => (
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

      <AllStandardReports />
    </main>
  );
}
