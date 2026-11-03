'use client';

/**
 * Report Center (QB Reports menu / Report Center): every report Ironbooks has.
 *  - "Start here": the three questions most owners ask, in plain language.
 *  - Report cards by QB menu group (financial, accountant & taxes, receivables / payables, sales /
 *    purchases, inventory, payroll, banking, planning, and the report tools).
 *  - "All reports": every report of the standard catalog (lib/reports/catalog.ts), by group.
 * Reports the user may not run, or whose feature is turned off in Preferences, are left out
 * (cosmetic — the server refuses them anyway). lib/reports/reportCenter.test.ts checks that every
 * report page and every catalog report is listed here.
 */
import Link from 'next/link';
import { BarChart2 } from 'lucide-react';
import { REPORT_CATALOG, REPORT_GROUPS, listedReports, reportFeatureOff } from '@/lib/reports/catalog';
import { canDoActivity, useMe } from '@/lib/usePermissions';
import { usePreferences } from '@/lib/usePreferences';
import { featureHiddenPaths } from '@/lib/preferences';
import { Card, PageHeader } from '@/components/ui';
import { Help } from '@/components/Help';
import { REPORT_CENTER_SECTIONS, type ReportCardProps } from './_components/reportCenterSections';

// ---------------------------------------------------------------------------
// Report link card
// ---------------------------------------------------------------------------

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

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-bold uppercase tracking-widest text-navy/40 mb-3 mt-8 first:mt-0">
      {children}
    </h2>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function AllStandardReports({ hidden }: { hidden: (key: string) => boolean }) {
  const { me } = useMe();
  const visible = listedReports((activity) => canDoActivity(me, activity, 'view'), (r) => hidden(r.key));
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
  const prefs = usePreferences();
  // Preferences feature switches: inventory, payroll and sales tax reports drop out while off.
  const hiddenPaths = featureHiddenPaths(prefs.company);
  const offFeature = (key: string) => {
    const e = REPORT_CATALOG.find((r) => r.key === key);
    return !!e && reportFeatureOff(e, prefs.company);
  };
  const cardHidden = (href: string) => {
    if (hiddenPaths.has(href)) return true;
    const std = /^\/reports\/std\/([a-z0-9-]+)/.exec(href);
    return std ? offFeature(std[1]) : false;
  };
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

      {REPORT_CENTER_SECTIONS.map((s) => {
        const cards = s.cards.filter((c) => !cardHidden(c.href));
        if (cards.length === 0) return null;
        return (
          <section key={s.title} aria-label={s.title}>
            <SectionHeading>{s.title}</SectionHeading>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {cards.map((r) => (
                <ReportCard key={r.href} {...r} />
              ))}
            </div>
          </section>
        );
      })}

      <AllStandardReports hidden={offFeature} />
    </main>
  );
}
