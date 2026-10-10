import Link from 'next/link';
import { Scale } from 'lucide-react';
import { Badge, Button, Card, Input, Label, PageHeader } from '@/components/ui';
import { getPageContext } from '@/lib/context';
import { balanceSheet } from '@/lib/services/reports';
import { balanceSheetComparative } from '@/lib/services/reportsExtra';
import { formatCurrency, Money } from '@/lib/money';
import ReportToolbar, { type ExportTable } from '../_components/ReportToolbar';

export const dynamic = 'force-dynamic';

type Line = { accountId: string; code: string; name: string; amount: string };
type CompLine = { accountId: string; code: string; name: string; current: string; prior: string; change: string };

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

// ---------------------------------------------------------------------------
// Single-date sections
// ---------------------------------------------------------------------------

function Group({ title, lines, total, asOfQs }: { title: string; lines: Line[]; total: string; asOfQs: string }) {
  return (
    <>
      <tr className="bg-navy/5">
        <td className="py-2 px-3 font-bold text-navy" colSpan={2}>
          {title}
        </td>
      </tr>
      {lines.map((l) => {
        // The synthetic Retained Earnings / Net Income lines have no real account to drill into.
        const linkable = l.accountId !== 're' && l.accountId !== 're-prior';
        return (
          <tr key={l.accountId} className="border-b border-slate-100 hover:bg-electric/5">
            <td className="py-2 px-3 pl-8">
              {linkable ? (
                <Link
                  href={`/registers/${l.accountId}${asOfQs}`}
                  className="text-navy hover:text-electric hover:underline"
                  title={`Open ${l.name} register`}
                >
                  {l.name}
                </Link>
              ) : (
                <span className="text-navy">{l.name}</span>
              )}
            </td>
            <td className="py-2 px-3 text-right tabular-nums">
              {linkable ? (
                <Link
                  href={`/registers/${l.accountId}${asOfQs}`}
                  className="text-navy hover:text-electric hover:underline"
                  title={`Open ${l.name} register`}
                >
                  {formatCurrency(l.amount)}
                </Link>
              ) : (
                <span className="text-navy">{formatCurrency(l.amount)}</span>
              )}
            </td>
          </tr>
        );
      })}
      <tr className="border-t border-navy/20 font-semibold text-navy/80">
        <td className="py-2 px-3">Total {title}</td>
        <td className="py-2 px-3 text-right tabular-nums">{formatCurrency(total)}</td>
      </tr>
    </>
  );
}

// ---------------------------------------------------------------------------
// Comparative sections (current / prior / change)
// ---------------------------------------------------------------------------

function CompGroup({
  title,
  lines,
  totals,
  asOfQs,
}: {
  title: string;
  lines: CompLine[];
  totals: { current: string; prior: string; change: string };
  asOfQs: string;
}) {
  return (
    <>
      <tr className="bg-navy/5">
        <td className="py-2 px-3 font-bold text-navy" colSpan={4}>
          {title}
        </td>
      </tr>
      {lines.map((l) => {
        const linkable = l.accountId !== 're';
        const changeNum = Number(l.change);
        return (
          <tr key={l.accountId} className="border-b border-slate-100 hover:bg-electric/5">
            <td className="py-2 px-3 pl-8">
              {linkable ? (
                <Link
                  href={`/registers/${l.accountId}${asOfQs}`}
                  className="text-navy hover:text-electric hover:underline"
                  title={`Open ${l.name} register`}
                >
                  {l.name}
                </Link>
              ) : (
                <span className="text-navy">{l.name}</span>
              )}
            </td>
            <td className="py-2 px-3 text-right tabular-nums">{formatCurrency(l.current)}</td>
            <td className="py-2 px-3 text-right tabular-nums text-navy/60">{formatCurrency(l.prior)}</td>
            <td
              className={`py-2 px-3 text-right tabular-nums ${
                changeNum > 0 ? 'text-emerald' : changeNum < 0 ? 'text-red-600' : 'text-navy/50'
              }`}
            >
              {formatCurrency(l.change)}
            </td>
          </tr>
        );
      })}
      <tr className="border-t border-navy/20 font-semibold text-navy/80">
        <td className="py-2 px-3">Total {title}</td>
        <td className="py-2 px-3 text-right tabular-nums">{formatCurrency(totals.current)}</td>
        <td className="py-2 px-3 text-right tabular-nums">{formatCurrency(totals.prior)}</td>
        <td className="py-2 px-3 text-right tabular-nums">{formatCurrency(totals.change)}</td>
      </tr>
    </>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function BalanceSheetPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string; compareTo?: string }>;
}) {
  const ctx = await getPageContext('/reports/balance-sheet');
  const params = await searchParams;

  const asOf = parseParamDate(params.asOf) ?? new Date();
  const compareTo = parseParamDate(params.compareTo);
  const asOfStr = toInputDate(asOf);
  // Drill into the register up to the as-of date.
  const asOfQs = `?to=${asOfStr}`;

  const dateForm = (
    <Card className="mb-6 max-w-4xl">
      <form method="get" className="flex items-end gap-3 flex-wrap p-4">
        <div>
          <Label htmlFor="bs-asof">As of</Label>
          <Input id="bs-asof" type="date" name="asOf" defaultValue={asOfStr} />
        </div>
        <div>
          <Label htmlFor="bs-compare">Compare to (optional)</Label>
          <Input
            id="bs-compare"
            type="date"
            name="compareTo"
            defaultValue={compareTo ? toInputDate(compareTo) : ''}
          />
        </div>
        <Button type="submit" variant="secondary" size="sm" className="mb-0.5">
          Run Report
        </Button>
      </form>
    </Card>
  );

  // ---- Comparative mode: prior-date columns + change (QB Prev Year Comparison) ----
  if (compareTo) {
    const comp = await balanceSheetComparative(ctx, asOf, compareTo);
    const equityLines: CompLine[] = [
      ...comp.equity,
      {
        accountId: 're',
        code: '3900',
        name: 'Net Income / Retained Earnings',
        current: comp.retainedEarnings.current,
        prior: comp.retainedEarnings.prior,
        change: comp.retainedEarnings.change,
      },
    ];
    const compSection = (title: string, lines: CompLine[]) =>
      [
        [title.toUpperCase(), null, null, null],
        ...lines.map((l) => [l.name, l.current, l.prior, l.change]),
      ] as (string | null)[][];
    const compTable: ExportTable = {
      filename: 'balance-sheet-comparative',
      title: 'Balance Sheet - Comparative',
      subtitle: `${asOf.toLocaleDateString('en-US')} vs ${compareTo.toLocaleDateString('en-US')}`,
      columns: [
        { header: 'Account' },
        { header: asOf.toLocaleDateString('en-US'), numeric: true },
        { header: compareTo.toLocaleDateString('en-US'), numeric: true },
        { header: 'Change', numeric: true },
      ],
      rows: [
        ...compSection('Assets', comp.assets),
        ['Total Assets', comp.totals.assets.current, comp.totals.assets.prior, comp.totals.assets.change],
        ...compSection('Liabilities', comp.liabilities),
        ['Total Liabilities', comp.totals.liabilities.current, comp.totals.liabilities.prior, comp.totals.liabilities.change],
        ...compSection('Equity', equityLines),
      ],
      totals: [
        ['Total Equity', comp.totals.equity.current, comp.totals.equity.prior, comp.totals.equity.change],
      ],
    };
    return (
      <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
        <div className="max-w-4xl">
          <PageHeader
            title="Balance Sheet — Comparative"
            icon={Scale}
            action={
              <Badge tone={comp.balanced ? 'success' : 'danger'}>
                {comp.balanced ? 'Assets = Liabilities + Equity' : 'OUT OF BALANCE'}
              </Badge>
            }
          />
          <ReportToolbar
            table={compTable}
            basisNav={{
              value: 'accrual',
              accrualHref: `/reports/balance-sheet?asOf=${asOfStr}`,
              cashHref: `/reports/balance-sheet-cash?asOf=${asOfStr}`,
            }}
          />
        </div>
        {dateForm}
        <Card className="p-6 max-w-4xl">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b-2 border-navy/10 text-navy/70 text-sm">
                <th className="py-2 px-3 text-left font-semibold">Account</th>
                <th className="py-2 px-3 text-right font-semibold">{asOf.toLocaleDateString('en-US')}</th>
                <th className="py-2 px-3 text-right font-semibold">{compareTo.toLocaleDateString('en-US')}</th>
                <th className="py-2 px-3 text-right font-semibold">Change</th>
              </tr>
            </thead>
            <tbody>
              <CompGroup title="Assets" lines={comp.assets} totals={comp.totals.assets} asOfQs={asOfQs} />
              <tr><td className="py-2" colSpan={4} /></tr>
              <CompGroup title="Liabilities" lines={comp.liabilities} totals={comp.totals.liabilities} asOfQs={asOfQs} />
              <tr><td className="py-2" colSpan={4} /></tr>
              <CompGroup title="Equity" lines={equityLines} totals={comp.totals.equity} asOfQs={asOfQs} />
            </tbody>
          </table>
        </Card>
      </main>
    );
  }

  // ---- Standard single-date mode ----
  const bs = await balanceSheet(ctx, asOf);
  // QB presentation: unclosed prior-year earnings as "Retained Earnings", this fiscal year's
  // earnings as "Net Income" — both derived from the same posted rows as every other line.
  const equityLines = [
    ...bs.equity,
    ...(Money.isZero(bs.priorYearsEarnings)
      ? []
      : [{ accountId: 're-prior', code: '3900', name: 'Retained Earnings', amount: bs.priorYearsEarnings }]),
    { accountId: 're', code: '3999', name: 'Net Income', amount: bs.currentYearNetIncome },
  ];

  const exportTable: ExportTable = {
    filename: 'balance-sheet',
    title: 'Balance Sheet',
    subtitle: `As of ${asOf.toLocaleDateString('en-US')}`,
    columns: [{ header: 'Account' }, { header: 'Amount', numeric: true }],
    rows: [
      ['ASSETS', null],
      ...bs.assets.map((l) => [l.name, l.amount] as (string | null)[]),
      ['Total Assets', bs.totalAssets],
      ['', null],
      ['LIABILITIES', null],
      ...bs.liabilities.map((l) => [l.name, l.amount] as (string | null)[]),
      ['Total Liabilities', bs.totalLiabilities],
      ['', null],
      ['EQUITY', null],
      ...equityLines.map((l) => [l.name, l.amount] as (string | null)[]),
      ['Total Equity', bs.totalEquity],
    ],
    totals: [['Total Liabilities + Equity', Money.add(bs.totalLiabilities, bs.totalEquity).toFixed(2)]],
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <div className="max-w-4xl">
        <PageHeader
          title="Balance Sheet"
          icon={Scale}
          action={
            <div className="flex items-center gap-3">
              <span className="text-sm text-navy/50">
                as of {asOf.toLocaleDateString('en-US')}
              </span>
              <Badge tone={bs.balanced ? 'success' : 'danger'}>
                {bs.balanced ? 'Assets = Liabilities + Equity' : 'OUT OF BALANCE'}
              </Badge>
            </div>
          }
        />
        <ReportToolbar
          table={exportTable}
          basisNav={{
            value: 'accrual',
            accrualHref: `/reports/balance-sheet?asOf=${asOfStr}`,
            cashHref: `/reports/balance-sheet-cash?asOf=${asOfStr}`,
          }}
        />
      </div>
      {dateForm}
      <Card className="p-6 max-w-3xl">
        <table className="w-full border-collapse">
          <tbody>
            <Group title="Assets" lines={bs.assets} total={bs.totalAssets} asOfQs={asOfQs} />
            <tr><td className="py-2" colSpan={2} /></tr>
            <Group title="Liabilities" lines={bs.liabilities} total={bs.totalLiabilities} asOfQs={asOfQs} />
            <tr><td className="py-2" colSpan={2} /></tr>
            <Group title="Equity" lines={equityLines} total={bs.totalEquity} asOfQs={asOfQs} />
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-navy/30 text-base font-extrabold text-navy">
              <td className="py-3 px-3">Total Liabilities + Equity</td>
              <td className="py-3 px-3 text-right tabular-nums">
                {formatCurrency(Money.add(bs.totalLiabilities, bs.totalEquity))}
              </td>
            </tr>
          </tfoot>
        </table>
      </Card>
    </main>
  );
}
