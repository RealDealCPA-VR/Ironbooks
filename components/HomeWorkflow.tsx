/**
 * QuickBooks-style Home page workflow diagram: clickable icons for each everyday task, with
 * arrows showing the order money moves (Estimate -> Invoice -> Payment -> Deposit, …).
 *
 * Server-renderable (no client state). Accessibility: each section is a labelled region and
 * each flow an ordered list, so screen readers hear "Customers workflow, list, 5 items —
 * step 1: Estimates"; arrows are decorative (aria-hidden). Every step is a normal link, so
 * Tab / Shift+Tab walk the diagram in reading order with a visible focus ring. On narrow
 * screens flows stack vertically and the arrows point down.
 *
 * Data: lib/homeWorkflow.ts (routes are verified by lib/homeWorkflow.test.ts).
 */
import Link from 'next/link';
import type { ComponentType } from 'react';
import {
  BookOpen, Boxes, Briefcase, Building2, CalendarClock, ClipboardList, Clock, CreditCard,
  FileCheck, FileSpreadsheet, FileText, HandCoins, Landmark, ListChecks, NotebookPen, Package,
  PackageCheck, PenLine, PiggyBank, Receipt, RotateCcw, Rss, Scale, ShoppingCart, Truck, Users,
  UserSquare, ArrowLeftRight, Wallet,
} from 'lucide-react';
import {
  HOME_WORKFLOW,
  type AccountBalanceRow,
  type WorkflowIcon,
  type WorkflowSection,
  type WorkflowStep,
} from '@/lib/homeWorkflow';
import { formatCurrency } from '@/lib/money';
import { Help } from '@/components/Help';

const ICONS: Record<WorkflowIcon, ComponentType<{ className?: string }>> = {
  'purchase-order': ShoppingCart,
  'receive-inventory': PackageCheck,
  'enter-bills': Receipt,
  'pay-bills': HandCoins,
  estimates: ClipboardList,
  'sales-orders': FileCheck,
  invoices: FileText,
  'receive-payments': Wallet,
  deposits: PiggyBank,
  'sales-receipts': Receipt,
  statements: FileSpreadsheet,
  refunds: RotateCcw,
  time: Clock,
  'pay-employees': Briefcase,
  'pay-liabilities': Landmark,
  'payroll-forms': NotebookPen,
  'chart-of-accounts': BookOpen,
  items: Package,
  reminders: CalendarClock,
  'write-checks': PenLine,
  'check-register': ListChecks,
  reconcile: Scale,
  'bank-feeds': Rss,
  transfers: ArrowLeftRight,
  vendors: Truck,
  customers: Users,
  employees: UserSquare,
};

/** Section accent colours (brand palette). */
const ACCENT: Record<WorkflowSection['id'], string> = {
  vendors: 'border-gold',
  customers: 'border-electric',
  employees: 'border-emerald',
  company: 'border-navy',
  banking: 'border-electric',
};

function StepTile({ step, index, total }: { step: WorkflowStep; index?: number; total?: number }) {
  const Icon = ICONS[step.icon] ?? Boxes;
  return (
    <Link
      href={step.href}
      title={step.hint}
      className="group flex w-full sm:w-28 flex-col items-center rounded-xl px-2 py-3 text-center outline-none transition-colors hover:bg-electric/5 focus-visible:ring-2 focus-visible:ring-electric focus-visible:ring-offset-2"
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-electric/10 text-electric transition-transform group-hover:scale-105 group-focus-visible:scale-105">
        <Icon className="h-6 w-6" />
      </span>
      <span className="mt-2 text-sm font-semibold leading-tight text-navy group-hover:text-electric">
        {index !== undefined && total !== undefined && (
          <span className="sr-only">Step {index + 1} of {total}: </span>
        )}
        {step.label}
      </span>
      <span className="mt-0.5 text-[11px] leading-snug text-navy/50">{step.hint}</span>
    </Link>
  );
}

/** Decorative arrow between steps: points right on wide screens, down when stacked. */
function FlowArrow() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 32 16"
      className="h-4 w-8 shrink-0 rotate-90 text-navy/30 sm:rotate-0 sm:mt-7"
    >
      <path d="M1 8h26" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M21 2l7 6-7 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Flow({ steps, label }: { steps: WorkflowStep[]; label: string }) {
  return (
    <ol aria-label={label} className="flex flex-col items-center gap-1 sm:flex-row sm:flex-wrap sm:items-start sm:gap-x-1 sm:gap-y-3">
      {steps.map((step, i) => (
        <li key={step.href} className="flex flex-col items-center sm:flex-row sm:items-start">
          <StepTile step={step} index={i} total={steps.length} />
          {i < steps.length - 1 && <FlowArrow />}
        </li>
      ))}
    </ol>
  );
}

function Section({ section }: { section: WorkflowSection }) {
  const CenterIcon = ICONS[section.centerIcon] ?? Building2;
  const headingId = `home-${section.id}`;
  return (
    <section
      aria-labelledby={headingId}
      className={`rounded-2xl border-l-4 ${ACCENT[section.id]} bg-white p-5 shadow-xl`}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 id={headingId} className="text-sm font-bold uppercase tracking-wide text-navy/70">
          {section.title}
        </h2>
        <Link
          href={section.centerHref}
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-semibold text-electric outline-none hover:underline focus-visible:ring-2 focus-visible:ring-electric"
        >
          <CenterIcon className="h-3.5 w-3.5" aria-hidden="true" />
          {section.id === 'company' ? 'Company settings' : section.id === 'banking' ? 'Bank accounts' : `${section.title} list`}
        </Link>
      </div>
      {section.flows.map((flow, i) => (
        <Flow key={i} steps={flow} label={`${section.title} workflow`} />
      ))}
      {section.extras && section.extras.length > 0 && (
        <ul
          aria-label={`More ${section.title.toLowerCase()} tasks`}
          className={`grid grid-cols-2 gap-1 sm:flex sm:flex-wrap ${section.flows.length ? 'mt-3 border-t border-slate-100 pt-3' : ''}`}
        >
          {section.extras.map((step) => (
            <li key={step.href}>
              <StepTile step={step} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AccountBalancesPanel({ rows }: { rows: AccountBalanceRow[] }) {
  return (
    <section aria-labelledby="home-balances" className="rounded-2xl border-l-4 border-emerald bg-white p-5 shadow-xl">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="home-balances" className="text-sm font-bold uppercase tracking-wide text-navy/70">
          Account Balances
        </h2>
        <Link href="/registers" className="text-xs font-semibold text-electric hover:underline">
          Registers →
        </Link>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-navy/50">
          No bank or credit card accounts yet.{' '}
          <Link href="/accounts" className="font-semibold text-electric hover:underline">
            Add one in the Chart of Accounts
          </Link>{' '}
          to start tracking your money.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.map((r) => (
            <li key={r.id}>
              <Link
                href={`/registers/${r.id}`}
                className="flex items-center justify-between gap-3 rounded px-1 py-2 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-electric"
              >
                <span className="flex min-w-0 items-center gap-2 text-sm text-navy">
                  {r.kind === 'credit_card' ? (
                    <CreditCard className="h-4 w-4 shrink-0 text-navy/40" aria-hidden="true" />
                  ) : (
                    <Landmark className="h-4 w-4 shrink-0 text-navy/40" aria-hidden="true" />
                  )}
                  <span className="truncate">{r.name}</span>
                  {r.kind === 'credit_card' && <span className="text-xs text-navy/40">(owed)</span>}
                </span>
                <span
                  className={`text-sm font-semibold tabular-nums ${
                    Number(r.balance) < 0 ? 'text-red-600' : 'text-navy'
                  }`}
                >
                  {formatCurrency(r.balance)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {rows.some((r) => r.kind === 'undeposited' && Number(r.balance) !== 0) && (
        <p className="mt-3 flex items-center gap-1 text-xs text-navy/50">
          Payments waiting in <Help term="undeposited-funds">Undeposited Funds</Help> —{' '}
          <Link href="/deposits" className="font-semibold text-electric hover:underline">
            record a deposit
          </Link>
        </p>
      )}
    </section>
  );
}

export default function HomeWorkflow({ balances }: { balances: AccountBalanceRow[] }) {
  const byId = Object.fromEntries(HOME_WORKFLOW.map((s) => [s.id, s])) as Record<
    WorkflowSection['id'],
    WorkflowSection
  >;
  return (
    <nav aria-label="Home workflow" className="grid grid-cols-1 gap-6 xl:grid-cols-3">
      <div className="space-y-6 xl:col-span-2">
        <Section section={byId.vendors} />
        <Section section={byId.customers} />
        <Section section={byId.employees} />
      </div>
      <div className="space-y-6">
        <Section section={byId.company} />
        <Section section={byId.banking} />
        <AccountBalancesPanel rows={balances} />
      </div>
    </nav>
  );
}
