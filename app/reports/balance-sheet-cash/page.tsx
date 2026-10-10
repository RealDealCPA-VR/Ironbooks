/**
 * Cash-Basis Balance Sheet page.
 *
 * Renders the cash-basis variant of the Balance Sheet. Accounts Receivable (1200) and
 * Accounts Payable (2000) are excluded because cash-basis accounting recognises no
 * receivables or payables — only exchanged cash counts. Equity is adjusted by
 * (AR removed − AP removed) to keep Assets = Liabilities + Equity.
 */
import { Scale } from 'lucide-react';
import { Badge, Button, Card, Input, Label, PageHeader } from '@/components/ui';
import { getPageContext } from '@/lib/context';
import { balanceSheetCashBasis, type BalanceSheetCashBasis } from '@/lib/services/balanceSheetCashBasis';
import { formatCurrency, Money } from '@/lib/money';
import ReportToolbar, { type ExportTable } from '../_components/ReportToolbar';

export const dynamic = 'force-dynamic';

function toInputDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseParamDate(v: string | undefined): Date | undefined {
  if (!v) return undefined;
  // Parse as local midnight so the rendered date matches what the user picked
  // regardless of the server's UTC offset.
  const d = new Date(`${v}T00:00:00`);
  return isNaN(d.getTime()) ? undefined : d;
}

type Line = { accountId: string; code: string; name: string; amount: string };

function Group({ title, lines, total }: { title: string; lines: Line[]; total: string }) {
  return (
    <>
      <tr className="bg-navy/5">
        <td className="py-2 px-3 font-bold text-navy" colSpan={2}>
          {title}
        </td>
      </tr>
      {lines.length === 0 ? (
        <tr className="border-b border-slate-100">
          <td className="py-2 px-3 pl-8 text-navy/40 italic" colSpan={2}>
            No accounts
          </td>
        </tr>
      ) : (
        lines.map((l) => (
          <tr key={l.accountId} className="border-b border-slate-100">
            <td className="py-2 px-3 pl-8 text-navy">{l.name}</td>
            <td className="py-2 px-3 text-right tabular-nums text-navy">
              {formatCurrency(l.amount)}
            </td>
          </tr>
        ))
      )}
      <tr className="border-t border-navy/20 font-semibold text-navy/80">
        <td className="py-2 px-3">Total {title}</td>
        <td className="py-2 px-3 text-right tabular-nums">{formatCurrency(total)}</td>
      </tr>
    </>
  );
}

function AdjustmentNote({ bs }: { bs: BalanceSheetCashBasis }) {
  const { adjustments } = bs;
  const hasAr = parseFloat(adjustments.arRemoved) !== 0;
  const hasAp = parseFloat(adjustments.apRemoved) !== 0;

  if (!hasAr && !hasAp) return null;

  return (
    <div className="mt-6 rounded-xl border border-gold/25 bg-gold/10 p-4 text-sm text-navy">
      <p className="font-semibold mb-2">Cash-Basis Adjustments Applied</p>
      <p className="mb-3 text-navy/70">
        Cash-basis accounting excludes receivables and payables. The following balances have been
        removed from this report and equity has been reduced by{' '}
        <span className="font-semibold">{formatCurrency(adjustments.equityAdjustment)}</span> (AR
        removed − AP removed) to keep the Balance Sheet equation intact.
      </p>
      {hasAr && (
        <div className="mb-3">
          <p className="font-medium mb-1">
            Accounts Receivable removed from Assets ({formatCurrency(adjustments.arRemoved)} total):
          </p>
          <ul className="ml-4 list-disc space-y-0.5">
            {adjustments.removedArLines.map((l) => (
              <li key={l.accountId} className="flex justify-between">
                <span>
                  {l.code} — {l.name}
                </span>
                <span className="tabular-nums ml-4">{formatCurrency(l.amount)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {hasAp && (
        <div>
          <p className="font-medium mb-1">
            Accounts Payable removed from Liabilities ({formatCurrency(adjustments.apRemoved)} total):
          </p>
          <ul className="ml-4 list-disc space-y-0.5">
            {adjustments.removedApLines.map((l) => (
              <li key={l.accountId} className="flex justify-between">
                <span>
                  {l.code} — {l.name}
                </span>
                <span className="tabular-nums ml-4">{formatCurrency(l.amount)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default async function BalanceSheetCashPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string }>;
}) {
  const ctx = await getPageContext('/reports/balance-sheet-cash');
  const params = await searchParams;
  const asOf = parseParamDate(params.asOf) ?? new Date();
  const asOfStr = toInputDate(asOf);
  const bs = await balanceSheetCashBasis(ctx, asOf);

  const equityLines: Line[] = [
    ...bs.equity,
    {
      accountId: 're',
      code: '3900',
      name: 'Net Income / Retained Earnings',
      amount: bs.retainedEarnings,
    },
  ];

  const totalLiabAndEquity = Money.add(bs.totals.totalLiabilities, bs.totals.totalEquity);

  const exportTable: ExportTable = {
    filename: 'balance-sheet-cash',
    title: 'Balance Sheet (Cash Basis)',
    subtitle: `As of ${asOf.toLocaleDateString('en-US')}`,
    columns: [{ header: 'Account' }, { header: 'Amount', numeric: true }],
    rows: [
      ['ASSETS', null],
      ...bs.assets.map((l) => [l.name, l.amount] as (string | null)[]),
      ['Total Assets', bs.totals.totalAssets],
      ['', null],
      ['LIABILITIES', null],
      ...bs.liabilities.map((l) => [l.name, l.amount] as (string | null)[]),
      ['Total Liabilities', bs.totals.totalLiabilities],
      ['', null],
      ['EQUITY', null],
      ...equityLines.map((l) => [l.name, l.amount] as (string | null)[]),
      ['Total Equity', bs.totals.totalEquity],
    ],
    totals: [['Total Liabilities + Equity', totalLiabAndEquity.toFixed(2)]],
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      {/* Header */}
      <PageHeader
        title="Balance Sheet — Cash Basis"
        icon={Scale}
        action={
          <Badge tone={bs.balanced ? 'success' : 'danger'}>
            {bs.balanced ? 'Assets = Liabilities + Equity' : 'OUT OF BALANCE'}
          </Badge>
        }
      />

      {/* Basis badge */}
      <div className="flex items-center gap-3 mb-6 -mt-2">
        <Badge tone="warning" className="bg-gold/10 text-navy border border-gold/25">
          Cash Basis
        </Badge>
        {bs.asOf && (
          <span className="text-sm text-navy/50">
            As of {new Date(bs.asOf).toLocaleDateString('en-US', { dateStyle: 'long' })}
          </span>
        )}
        <span className="text-xs text-navy/40">
          AR (1200) and AP (2000) excluded — equity adjusted by{' '}
          {formatCurrency(bs.adjustments.equityAdjustment)}
        </span>
      </div>

      <div className="max-w-3xl">
        <ReportToolbar
          table={exportTable}
          basisNav={{
            value: 'cash',
            accrualHref: `/reports/balance-sheet?asOf=${asOfStr}`,
            cashHref: `/reports/balance-sheet-cash?asOf=${asOfStr}`,
          }}
        />
      </div>

      {/* As-of date picker (plain GET form — server-rendered page) */}
      <Card className="mb-6 max-w-3xl print-hidden">
        <form method="get" className="flex items-end gap-3 flex-wrap p-4">
          <div>
            <Label htmlFor="bsc-asof">As of</Label>
            <Input id="bsc-asof" type="date" name="asOf" defaultValue={asOfStr} />
          </div>
          <Button type="submit" variant="secondary" size="sm" className="mb-0.5">
            Run Report
          </Button>
        </form>
      </Card>

      {/* Balance Sheet table */}
      <Card className="p-6 max-w-3xl">
        <table className="w-full border-collapse">
          <tbody>
            <Group
              title="Assets"
              lines={bs.assets}
              total={bs.totals.totalAssets}
            />
            <tr>
              <td className="py-2" colSpan={2} />
            </tr>
            <Group
              title="Liabilities"
              lines={bs.liabilities}
              total={bs.totals.totalLiabilities}
            />
            <tr>
              <td className="py-2" colSpan={2} />
            </tr>
            <Group
              title="Equity"
              lines={equityLines}
              total={bs.totals.totalEquity}
            />
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-navy/30 text-base font-extrabold text-navy">
              <td className="py-3 px-3">Total Liabilities + Equity</td>
              <td className="py-3 px-3 text-right tabular-nums">
                {formatCurrency(totalLiabAndEquity)}
              </td>
            </tr>
          </tfoot>
        </table>
      </Card>

      {/* Adjustment note */}
      <div className="max-w-3xl">
        <AdjustmentNote bs={bs} />
      </div>

      {/* Methodology note */}
      <div className="max-w-3xl mt-4 text-xs text-navy/40 leading-relaxed">
        <p>
          <span className="font-medium">Cash-basis method:</span> Accounts Receivable (1200) and
          Accounts Payable (2000) are removed because cash-basis accounting does not recognise
          uncollected revenue or unpaid expenses. Equity is reduced by AR&nbsp;removed&nbsp;&minus;
          AP&nbsp;removed so that Assets&nbsp;=&nbsp;Liabilities&nbsp;+&nbsp;Equity holds.
        </p>
      </div>
    </main>
  );
}
