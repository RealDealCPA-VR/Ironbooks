import Link from 'next/link';
import {
  Briefcase,
  ArrowLeftRight,
  FileX,
  Rows3,
  Trash2,
  Scale,
  ListChecks,
  ClipboardCheck,
  Receipt,
  SlidersHorizontal,
  ShieldAlert,
  Ban,
  Percent,
} from 'lucide-react';
import { ArrowRightLeft, CalendarRange } from 'lucide-react'; // Accountant's Copy (I1), Period Copy (I7)
import { Badge, Card, PageHeader, Table, Td, Th, Tr } from '@/components/ui';
import { getPageContext } from '@/lib/context';
import { formatCurrency } from '@/lib/money';
import { accountantCenterSummary } from '@/lib/services/accountant/accountantCenter';

export const dynamic = 'force-dynamic';

const TOOLS = [
  { href: '/accountant/client-data-review', icon: ClipboardCheck, title: 'Client Data Review', text: 'Step through clean-up tasks: unapplied payments, undeposited funds, item setup, changed balances.' },
  { href: '/accountant/reclassify', icon: ArrowLeftRight, title: 'Reclassify Transactions', text: 'Move lines to the right account or class in bulk. Totals never change.' },
  { href: '/accountant/working-trial-balance', icon: Scale, title: 'Working Trial Balance', text: 'Beginning, activity, adjustments and ending balances with your workpaper notes.' },
  { href: '/accountant/batch-enter', icon: Rows3, title: 'Batch Enter Transactions', text: 'Type or paste many checks, deposits, bills, invoices or journal entries at once.' },
  { href: '/accountant/batch-void', icon: Trash2, title: 'Batch Delete/Void', text: 'Void many transactions in one go — linked transactions are protected.' },
  { href: '/accountant/write-off', icon: FileX, title: 'Write Off Invoices', text: 'Clear uncollectible invoice balances to a bad debt account.' },
  { href: '/accountant/list-changes', icon: ListChecks, title: 'Review List Changes', text: 'See what changed in accounts, items, customers, vendors and payroll items.' },
  { href: '/accountant/fix-sales-tax', icon: ShieldAlert, title: 'Fix Incorrectly Recorded Sales Tax', text: 'Find sales tax paid by check or journal entry and tie it to the right agency.' },
  { href: '/accountant/sales-tax-adjustment', icon: SlidersHorizontal, title: 'Adjust Sales Tax Due', text: 'Record a discount, rounding, penalty or interest against an agency.' },
  { href: '/accountant/accountants-copy', icon: ArrowRightLeft, title: "Accountant's Copy", text: 'Send the books to your accountant with a dividing date, then review and import their changes.' },
  { href: '/accountant/period-copy', icon: CalendarRange, title: 'Period Copy', text: 'A company file with only one period (opening balances, nothing after) for an auditor.' },
];

const REPORTS = [
  { href: '/reports/sales-tax', icon: Percent, title: 'Sales Tax Liability & Revenue Summary' },
  { href: '/reports/closing-date-exceptions', icon: ShieldAlert, title: 'Closing Date Exception Report' },
  { href: '/reports/voided-deleted', icon: Ban, title: 'Voided/Deleted Transactions' },
  { href: '/reports/trial-balance', icon: Scale, title: 'Trial Balance' },
  { href: '/audit-trail', icon: Receipt, title: 'Audit Trail' },
];

export default async function AccountantCenterPage() {
  const ctx = await getPageContext('/accountant');
  const s = await accountantCenterSummary(ctx);

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader title="Accountant Center" iconNode={<Briefcase className="text-electric h-8 w-8" />} />

      <div className="grid gap-4 md:grid-cols-4 mb-6">
        <Card className="p-4">
          <div className="text-xs uppercase tracking-wide text-navy/50">Closing date</div>
          <div className="text-xl font-bold text-navy">{s.closingDate ?? 'Not set'}</div>
          <Link className="text-sm text-electric hover:underline" href="/settings">Change in Settings</Link>
        </Card>
        <Card className="p-4">
          <div className="text-xs uppercase tracking-wide text-navy/50">Sales tax owed (books)</div>
          <div className="text-xl font-bold text-navy">{formatCurrency(s.salesTaxOwed)}</div>
          <Link className="text-sm text-electric hover:underline" href="/sales-tax">Pay sales tax</Link>
        </Card>
        <Card className="p-4">
          <div className="text-xs uppercase tracking-wide text-navy/50">List changes to review</div>
          <div className="text-xl font-bold text-navy">{s.unreviewedListChanges}</div>
          <Link className="text-sm text-electric hover:underline" href="/accountant/list-changes">Review changes</Link>
        </Card>
        <Card className="p-4">
          <div className="text-xs uppercase tracking-wide text-navy/50">Last data review</div>
          <div className="text-xl font-bold text-navy">{s.lastReview ? `Through ${s.lastReview.asOf}` : 'Never'}</div>
          <Link className="text-sm text-electric hover:underline" href="/accountant/client-data-review">Start a review</Link>
        </Card>
      </div>

      <h2 className="text-lg font-bold text-navy mb-3">Tools</h2>
      <div className="grid gap-4 md:grid-cols-3 mb-8">
        {TOOLS.map((t) => (
          <Link key={t.href} href={t.href} className="group">
            <Card className="p-4 h-full transition-shadow group-hover:shadow-2xl">
              <div className="flex items-center gap-2 font-semibold text-navy">
                <t.icon className="h-5 w-5 text-electric" />
                {t.title}
              </div>
              <p className="mt-1 text-sm text-navy/60">{t.text}</p>
            </Card>
          </Link>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-6">
          <h2 className="text-lg font-bold text-navy mb-3">Reconciliation status</h2>
          {s.reconciliationStatus.length === 0 ? (
            <p className="text-sm text-navy/50">No bank or credit card accounts are set up for reconciliation yet.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Account</Th>
                  <Th numeric>Balance</Th>
                  <Th>Last reconciled</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {s.reconciliationStatus.map((r) => (
                  <Tr key={r.bankAccountId}>
                    <Td>
                      <Link href={`/registers/${r.accountId}`} className="hover:text-electric hover:underline">{r.name}</Link>
                    </Td>
                    <Td numeric>{formatCurrency(r.balance)}</Td>
                    <Td>{r.lastReconciledDate ? r.lastReconciledDate.slice(0, 10) : 'Never'}</Td>
                    <Td>
                      {r.inProgress ? (
                        <Badge tone="info">In progress</Badge>
                      ) : r.daysSinceReconciled === null || r.daysSinceReconciled > 45 ? (
                        <Badge tone="warning">Needs reconciling</Badge>
                      ) : (
                        <Badge tone="success">Up to date</Badge>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
          <Link className="mt-3 inline-block text-sm text-electric hover:underline" href="/reconcile">Go to Reconcile</Link>
        </Card>

        <Card className="p-6">
          <h2 className="text-lg font-bold text-navy mb-3">Accountant reports</h2>
          <ul className="space-y-2 mb-4">
            {REPORTS.map((r) => (
              <li key={r.href}>
                <Link href={r.href} className="flex items-center gap-2 text-navy hover:text-electric hover:underline">
                  <r.icon className="h-4 w-4 text-electric" />
                  {r.title}
                </Link>
              </li>
            ))}
          </ul>
          <h3 className="font-semibold text-navy mb-2">Memorized reports</h3>
          {s.memorizedReports.length === 0 ? (
            <p className="text-sm text-navy/50">No memorized reports yet. Save one from any report with “Memorize”.</p>
          ) : (
            <ul className="space-y-1">
              {s.memorizedReports.map((m) => (
                <li key={m.id} className="text-sm">
                  <Link href={`/reports/${m.reportType}?memorized=${m.id}`} className="text-navy hover:text-electric hover:underline">
                    {m.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </main>
  );
}
