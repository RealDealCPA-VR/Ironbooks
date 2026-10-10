import Link from 'next/link';
import {
  AlertTriangle,
  Banknote,
  BookOpen,
  CalendarClock,
  CheckCircle2,
  DollarSign,
  FilePlus2,
  FileText,
  HandCoins,
  LifeBuoy,
  PackageSearch,
  PenLine,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { getPageContext } from '@/lib/context';
import { getDashboardInsights, type DashboardInsights } from '@/lib/services/dashboard';
import { listAccounts } from '@/lib/services/accounts';
import { trialBalance } from '@/lib/services/reports';
import { buildAccountBalances } from '@/lib/homeWorkflow';
import HomeWorkflow from '@/components/HomeWorkflow';
import { Help } from '@/components/Help';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/utils';
import { PageHeader } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Single documented chart palette — brand colors from tailwind.config.ts plus the
 * kit's red scale for negative/at-risk values (the brand defines no red).
 */
const CHART = {
  positive: '#2ECC71', // brand emerald
  negative: '#ef4444', // red-500 — matches kit danger
  warning: '#C89B3C', // brand gold
  axis: '#0D1B2A', // brand navy
} as const;

export default async function DashboardPage() {
  const ctx = await getPageContext('/dashboard');
  // Single aggregated read model (also served as GET /api/dashboard). KPI cards keep
  // the fiscal-YTD scoping from lib/ytd.ts (settings.fiscalYearEnd; defaults Jan 1).
  const [d, accountRows, tb] = await Promise.all([
    getDashboardInsights(ctx),
    listAccounts(ctx),
    trialBalance(ctx),
  ]);
  // QB "Account Balances" panel: bank + credit card balances straight from the ledger.
  const balances = buildAccountBalances(accountRows, tb.rows);

  const kpiCards = [
    { icon: DollarSign, label: 'Revenue (YTD)', value: d.kpis.revenueYtd },
    { icon: TrendingUp, label: 'Net Profit (YTD)', value: d.kpis.netProfitYtd },
    { icon: Wallet, label: 'Cash on Hand', value: d.kpis.cash },
    { icon: FileText, label: 'Accounts Receivable', value: d.kpis.accountsReceivable, help: 'ar' as const },
    { icon: BookOpen, label: 'Accounts Payable', value: d.kpis.accountsPayable, help: 'ap' as const },
  ];

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader title="Home" action={<QuickActions />} />

      {/* QuickBooks-style workflow diagram: click any step to start that task. */}
      <HomeWorkflow balances={balances} />

      <h2 className="mt-10 mb-4 text-xl font-extrabold text-navy">Insights</h2>

      {/* KPI tiles */}
      <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-5 gap-6">
        {kpiCards.map((c) => {
          const Icon = c.icon;
          return (
            <div
              key={c.label}
              className="rounded-2xl p-6 bg-white border-b-4 border-electric shadow-xl flex flex-col items-start hover:scale-[1.025] transition-all duration-300"
            >
              <Icon className="h-7 w-7 text-electric mb-2" />
              <span className="text-2xl font-semibold text-navy tabular-nums">
                {formatCurrency(c.value)}
              </span>
              <span className="mt-1 text-sm text-navy/50 font-medium inline-flex items-center gap-1">
                {c.label}
                {'help' in c && c.help && <Help term={c.help} />}
              </span>
            </div>
          );
        })}
      </div>

      {/* Insight cards */}
      <div className="mt-8 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <PlTrendCard trend={d.plTrend} />
        <ArAgingCard aging={d.arAging} />
        <StatusCard d={d} />
        <OverdueInvoicesCard d={d} />
        <BillsDueCard d={d} />
      </div>

      <p className="mt-8 text-sm text-navy/40">
        Live figures from your company ledger. Post invoices, bills, and payments to see them update.
      </p>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Quick actions
// ---------------------------------------------------------------------------

function QuickActions() {
  const actions = [
    // ?new=1 opens each page's create form directly (same deep links as the command palette).
    { href: '/invoices?new=1', label: 'New Invoice', icon: FilePlus2 },
    { href: '/expenses?new=1', label: 'Write Check', icon: PenLine },
    { href: '/payments?new=1', label: 'Receive Payment', icon: HandCoins },
    { href: '/deposits?new=1', label: 'Make Deposit', icon: Banknote },
  ];
  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((a) => {
        const Icon = a.icon;
        return (
          <Link
            key={a.href}
            href={a.href}
            className="inline-flex items-center gap-2 rounded-lg bg-electric text-white text-sm font-semibold px-4 py-2 shadow hover:bg-electric/90 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-electric/50 focus-visible:ring-offset-1"
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {a.label}
          </Link>
        );
      })}
      <Link
        href="/help"
        className="inline-flex items-center gap-2 rounded-lg bg-white border border-slate-200 text-navy text-sm font-semibold px-4 py-2 hover:bg-slate-50 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-electric/50 focus-visible:ring-offset-1"
      >
        <LifeBuoy className="h-4 w-4" aria-hidden="true" />
        Help
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// P&L trend sparkline (inline SVG, no chart deps)
// ---------------------------------------------------------------------------

function PlTrendCard({ trend }: { trend: DashboardInsights['plTrend'] }) {
  const nets = trend.map((t) => Number(t.net));
  const max = Math.max(...nets, 0);
  const min = Math.min(...nets, 0);
  const span = max - min || 1;
  const W = 260;
  const H = 64;
  const PAD = 4;
  const x = (i: number) => PAD + (i * (W - PAD * 2)) / Math.max(trend.length - 1, 1);
  const y = (v: number) => PAD + (H - PAD * 2) * (1 - (v - min) / span);
  const points = nets.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const zeroY = y(0);
  const latest = trend[trend.length - 1];

  return (
    <div className="rounded-2xl p-6 bg-white shadow-xl border-b-4 border-emerald">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-bold text-navy/70 uppercase tracking-wide">
          P&amp;L Trend (6 months)
        </h2>
        <Link href="/reports/profit-loss" className="text-xs font-semibold text-electric hover:underline">
          Full report →
        </Link>
      </div>
      <div className="text-2xl font-semibold text-navy tabular-nums">
        {latest ? formatCurrency(latest.net) : '—'}
        <span className="ml-2 text-xs font-medium text-navy/40">net this month</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-3 w-full h-16" role="img" aria-label="Net income sparkline, last 6 months">
        <line x1={PAD} y1={zeroY} x2={W - PAD} y2={zeroY} stroke={CHART.axis} strokeOpacity="0.15" strokeDasharray="3 3" />
        <polyline points={points} fill="none" stroke={CHART.positive} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        {nets.map((v, i) => (
          <circle key={i} cx={x(i)} cy={y(v)} r="2.5" fill={v < 0 ? CHART.negative : CHART.positive} />
        ))}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-navy/40 font-medium">
        {trend.map((t) => (
          <span key={t.month}>{t.month.slice(5)}</span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A/R aging mini-bar
// ---------------------------------------------------------------------------

// Severity ramp: brand emerald -> brand gold -> kit red scale (red-400/500/800).
const AGING_SEGMENTS = [
  { key: 'current', label: 'Current', color: CHART.positive },
  { key: 'days1_30', label: '1–30', color: CHART.warning },
  { key: 'days31_60', label: '31–60', color: '#f87171' },
  { key: 'days61_90', label: '61–90', color: CHART.negative },
  { key: 'days91plus', label: '91+', color: '#991b1b' },
] as const;

function ArAgingCard({ aging }: { aging: DashboardInsights['arAging'] }) {
  const values = AGING_SEGMENTS.map((s) => Math.max(Number(aging[s.key]), 0));
  const total = values.reduce((a, b) => a + b, 0);

  return (
    <div className="rounded-2xl p-6 bg-white shadow-xl border-b-4 border-gold">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-bold text-navy/70 uppercase tracking-wide">A/R Aging</h2>
        <Link href="/reports/ar-aging" className="text-xs font-semibold text-electric hover:underline">
          Full report →
        </Link>
      </div>
      <div className="text-2xl font-semibold text-navy tabular-nums">{formatCurrency(aging.total)}</div>
      <div className="mt-3 flex h-3 w-full overflow-hidden rounded-full bg-slate-100" role="img" aria-label="A/R aging buckets">
        {total > 0 &&
          AGING_SEGMENTS.map((s, i) =>
            values[i] > 0 ? (
              <div
                key={s.key}
                style={{ width: `${(values[i] / total) * 100}%`, backgroundColor: s.color }}
                title={`${s.label}: ${formatCurrency(aging[s.key])}`}
              />
            ) : null,
          )}
      </div>
      <div className="mt-3 grid grid-cols-5 gap-1 text-center">
        {AGING_SEGMENTS.map((s, i) => (
          <div key={s.key}>
            <div className="flex items-center justify-center gap-1 text-[10px] font-semibold text-navy/50">
              <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
              {s.label}
            </div>
            <div className="text-[11px] tabular-nums text-navy/80">{formatCurrency(values[i])}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status card: AP due soon, low stock, last reconciliation
// ---------------------------------------------------------------------------

function StatusCard({ d }: { d: DashboardInsights }) {
  const rec = d.lastReconciliation;
  return (
    <div id="reminders" className="rounded-2xl p-6 bg-white shadow-xl border-b-4 border-navy space-y-4 scroll-mt-6">
      <h2 className="text-sm font-bold text-navy/70 uppercase tracking-wide">Reminders</h2>

      <Link href="/bills" className="flex items-center gap-3 group">
        <CalendarClock className="h-6 w-6 text-electric shrink-0" />
        <div>
          <div className="text-lg font-semibold text-navy tabular-nums group-hover:text-electric">
            {formatCurrency(d.apDueSoon.total)}
          </div>
          <div className="text-xs text-navy/50">
            A/P due within {d.apDueSoon.horizonDays} days ({d.apDueSoon.count} bill{d.apDueSoon.count === 1 ? '' : 's'}, incl. overdue)
          </div>
        </div>
      </Link>

      <Link href="/items" className="flex items-center gap-3 group">
        <PackageSearch className={`h-6 w-6 shrink-0 ${d.lowStockCount > 0 ? 'text-gold' : 'text-emerald'}`} />
        <div>
          <div className="text-lg font-semibold text-navy tabular-nums group-hover:text-electric">
            {d.lowStockCount}
          </div>
          <div className="text-xs text-navy/50">inventory item{d.lowStockCount === 1 ? '' : 's'} at or below reorder point</div>
        </div>
      </Link>

      <Link href="/reconcile" className="flex items-center gap-3 group">
        {rec?.status === 'completed' ? (
          <CheckCircle2 className="h-6 w-6 text-emerald shrink-0" />
        ) : (
          <AlertTriangle className="h-6 w-6 text-gold shrink-0" />
        )}
        <div>
          <div className="text-sm font-semibold text-navy group-hover:text-electric">
            {rec
              ? `${rec.accountName} — ${rec.status === 'completed' ? 'reconciled' : rec.status.replace('_', ' ')}`
              : 'No reconciliations yet'}
          </div>
          <div className="text-xs text-navy/50">
            {rec
              ? `Statement ${formatDate(rec.statementDate)}`
              : 'Reconcile your bank accounts monthly'}
          </div>
        </div>
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overdue invoices / bills due lists
// ---------------------------------------------------------------------------

function OverdueInvoicesCard({ d }: { d: DashboardInsights }) {
  return (
    <div className="rounded-2xl p-6 bg-white shadow-xl border-b-4 border-electric lg:col-span-2">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-bold text-navy/70 uppercase tracking-wide">
          Overdue Invoices{' '}
          <span className="text-navy/40 normal-case font-semibold">
            ({d.overdueInvoiceCount} · {formatCurrency(d.overdueInvoiceTotal)})
          </span>
        </h2>
        <Link href="/invoices" className="text-xs font-semibold text-electric hover:underline">
          All invoices →
        </Link>
      </div>
      {d.overdueInvoices.length === 0 ? (
        <p className="text-sm text-navy/40 py-4">Nothing overdue. Nice work.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {d.overdueInvoices.map((inv) => (
            <li key={inv.id}>
              <Link
                href={`/invoices?focus=${inv.id}`}
                className="flex items-center justify-between py-2 hover:bg-slate-50 rounded px-1"
              >
                <span className="text-sm text-navy">
                  <span className="font-semibold">#{inv.invoiceNumber}</span>{' '}
                  <span className="text-navy/60">{inv.customerName}</span>
                </span>
                <span className="text-sm tabular-nums">
                  <span className="text-red-600 font-semibold">{formatCurrency(inv.balanceDue)}</span>
                  <span className="ml-2 text-xs text-navy/40">{inv.daysOverdue}d late</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BillsDueCard({ d }: { d: DashboardInsights }) {
  return (
    <div className="rounded-2xl p-6 bg-white shadow-xl border-b-4 border-gold">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-bold text-navy/70 uppercase tracking-wide">
          Bills Due This Week{' '}
          <span className="text-navy/40 normal-case font-semibold">({d.billsDueThisWeekCount})</span>
        </h2>
        <Link href="/bills" className="text-xs font-semibold text-electric hover:underline">
          All bills →
        </Link>
      </div>
      {d.billsDueThisWeek.length === 0 ? (
        <p className="text-sm text-navy/40 py-4">No bills coming due in the next 7 days.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {d.billsDueThisWeek.map((b) => (
            <li key={b.id}>
              <Link
                href={`/bills?focus=${b.id}`}
                className="flex items-center justify-between py-2 hover:bg-slate-50 rounded px-1"
              >
                <span className="text-sm text-navy">
                  <span className="font-semibold">{b.billNumber || 'Bill'}</span>{' '}
                  <span className="text-navy/60">{b.vendorName}</span>
                </span>
                <span className="text-sm tabular-nums">
                  <span className="font-semibold text-navy">{formatCurrency(b.balanceDue)}</span>
                  <span className="ml-2 text-xs text-navy/40">{formatDate(b.dueDate)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 text-right text-sm font-semibold text-navy tabular-nums">
        Total: {formatCurrency(d.billsDueThisWeekTotal)}
      </div>
    </div>
  );
}
