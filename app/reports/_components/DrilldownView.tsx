'use client';

/**
 * QuickZoom transaction list behind one report number (/reports/drilldown).
 *
 * Everything it needs is in the URL (report, row, column and the report's own options), so a
 * drill-down link can be bookmarked or shared, and the browser Back button returns to the report
 * — which restores its options from its URL and its scroll / collapsed rows from session state.
 * Each transaction opens in the QuickZoom transaction view (EntryDetailModal: lines, history and
 * the link to its source document); "Open <document>" goes straight to the document's page.
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, ExternalLink, ListTree } from 'lucide-react';
import { Badge, Button, Card, EmptyState, PageHeader, Spinner } from '@/components/ui';
import EntryDetailModal, { sourceRefLink } from '@/components/EntryDetailModal';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { CATALOG_BY_KEY, stdReportHref } from '@/lib/reports/catalog';
import { drilldownApiUrl, reportOptions, safeBackHref, type CellDrilldown } from '@/lib/reports/drilldown';

const mdy = (s: string) => `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(0, 4)}`;

export default function DrilldownView() {
  const router = useRouter();
  const search = useSearchParams();
  const report = search?.get('report') ?? '';
  const row = search?.get('row') ?? '';
  const col = search?.get('col') ?? '';
  const searchKey = search?.toString() ?? '';
  const options = useMemo(() => {
    const o: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(searchKey).entries()) o[k] = v;
    return reportOptions(o);
  }, [searchKey]);
  const entry = CATALOG_BY_KEY[report];
  const backHref = safeBackHref(search?.get('back')) ?? (entry ? stdReportHref(report, options) : '/reports');

  const [data, setData] = useState<CellDrilldown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [entryId, setEntryId] = useState<string | null>(null);

  useEffect(() => {
    if (!report || !row || !col) {
      setLoading(false);
      setError('Open this page by clicking an amount on a report.');
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    api
      .get<CellDrilldown>(`${drilldownApiUrl(report, options, row, col)}&limit=2000`)
      .then((d) => live && setData(d))
      .catch((err) => live && setError(err instanceof ApiError ? err.message : 'The transactions could not be loaded.'))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [report, row, col, options]);

  const goBack = () => {
    // Browser history first, so the report comes back exactly as it was (scroll, collapsed rows).
    if (typeof window !== 'undefined' && window.history.length > 1) router.back();
    else router.push(backHref);
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="What's behind this number"
        icon={ListTree}
        action={
          <Button variant="secondary" size="sm" onClick={goBack}>
            <ArrowLeft className="h-4 w-4" />
            Back to {entry?.title ?? 'the report'}
          </Button>
        }
      />

      {loading && (
        <div className="flex items-center justify-center gap-2 py-16 text-navy/50 text-sm" role="status">
          <Spinner className="text-electric" />
          Finding the transactions…
        </div>
      )}
      {!loading && error && (
        <Card className="p-0">
          <EmptyState
            icon={ListTree}
            title="Nothing to show"
            message={error}
            action={
              <Link href={backHref} className="text-electric hover:underline text-sm">
                Back to the report
              </Link>
            }
          />
        </Card>
      )}
      {!loading && !error && data && (
        <>
          <Card className="p-5 mb-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-wide text-navy/50">{entry?.title ?? data.report}</p>
                <h2 className="text-xl font-bold text-navy">{data.rowLabel}</h2>
                <p className="text-sm text-navy/60">{data.scope}</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-navy/50">{data.kind === 'formula' ? 'Calculated amount' : 'Amount on the report'}</p>
                <p className="text-2xl font-extrabold text-navy tabular-nums">
                  {data.cell === null ? '—' : data.kind === 'formula' && /%|pct/i.test(data.column) ? `${data.cell}%` : formatCurrency(data.cell)}
                </p>
                {data.kind === 'transactions' ? (
                  data.ties ? (
                    <Badge tone="success">Adds up to the report</Badge>
                  ) : (
                    <Badge tone="warning">Adds up to {formatCurrency(data.total)} — run the report again</Badge>
                  )
                ) : (
                  <Badge tone="info">Calculated</Badge>
                )}
              </div>
            </div>
            <p className="mt-3 text-sm text-navy">{data.explanation}</p>
            {data.kind === 'formula' && (
              <p className="mt-1 text-xs text-navy/60">
                The list below shows the transactions the calculation is based on ({formatCurrency(data.total)} in total).
              </p>
            )}
            {data.basis && (
              <p className="mt-1 text-xs text-navy/50">
                {data.basis === 'cash'
                  ? 'Cash basis: income and expenses count when they are paid, so a payment can stand in for the invoice or bill it paid.'
                  : 'Accrual basis: income and expenses count on the date of the invoice or bill.'}
              </p>
            )}
          </Card>

          <Card className="p-0 overflow-hidden">
            {data.transactions.length === 0 ? (
              <EmptyState icon={ListTree} title="No transactions" message="Nothing was recorded behind this amount for these report settings." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <caption className="sr-only">
                    Transactions behind {data.rowLabel}, {data.columnLabel}
                  </caption>
                  <thead>
                    <tr className="border-b-2 border-navy/20 text-xs font-bold uppercase tracking-wide text-navy/60">
                      <th scope="col" className="py-2 px-3 text-left">Date</th>
                      <th scope="col" className="py-2 px-3 text-left">Type</th>
                      <th scope="col" className="py-2 px-3 text-left">Num</th>
                      <th scope="col" className="py-2 px-3 text-left">Name</th>
                      <th scope="col" className="py-2 px-3 text-left">Details</th>
                      <th scope="col" className="py-2 px-3 text-left">Account</th>
                      <th scope="col" className="py-2 px-3 text-right">Amount</th>
                      <th scope="col" className="py-2 px-3 text-left">
                        <span className="sr-only">Open</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.transactions.map((t) => {
                      const doc = sourceRefLink(t.sourceRef);
                      return (
                        <tr
                          key={t.key}
                          className={`border-b border-slate-100 hover:bg-electric/5 ${t.entryId ? 'cursor-pointer' : ''}`}
                          onDoubleClick={t.entryId ? () => setEntryId(t.entryId) : undefined}
                        >
                          <td className="py-1.5 px-3 whitespace-nowrap">
                            {t.entryId ? (
                              <button
                                type="button"
                                onClick={() => setEntryId(t.entryId)}
                                className="text-left hover:text-electric hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-electric/60 rounded"
                                aria-label={`Open ${t.type || 'transaction'} ${t.num} from ${mdy(t.date)}`}
                              >
                                {mdy(t.date)}
                              </button>
                            ) : (
                              mdy(t.date)
                            )}
                          </td>
                          <td className="py-1.5 px-3">{t.type}</td>
                          <td className="py-1.5 px-3">{t.num}</td>
                          <td className="py-1.5 px-3">{t.name}</td>
                          <td className="py-1.5 px-3 text-navy/70">{t.memo}</td>
                          <td className="py-1.5 px-3 text-navy/70">{t.account}</td>
                          <td className={`py-1.5 px-3 text-right tabular-nums whitespace-nowrap ${t.amount.startsWith('-') ? 'text-red-600' : ''}`}>
                            {formatCurrency(t.amount)}
                          </td>
                          <td className="py-1.5 px-3 whitespace-nowrap">
                            {doc && (
                              <Link href={doc.href} className="inline-flex items-center gap-1 text-xs text-electric hover:underline">
                                <ExternalLink className="h-3 w-3" aria-hidden="true" />
                                Open {doc.label}
                              </Link>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="font-bold text-navy border-t-2 border-navy/30 bg-navy/5">
                      <td className="py-2 px-3" colSpan={6}>
                        Total of {data.count.toLocaleString('en-US')} transaction{data.count === 1 ? '' : 's'}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums">{formatCurrency(data.total)}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </Card>
          {data.truncated && (
            <p className="text-xs text-navy/50 mt-2">
              Only the first {data.transactions.length.toLocaleString('en-US')} transactions are listed; the total and count cover all of them. Narrow the report dates to see fewer.
            </p>
          )}
          <p className="text-xs text-navy/40 mt-2 print-hidden">
            Tip: click a date (or double-click a row) to open the transaction, with its lines, history and a link to the original document.
          </p>
        </>
      )}
      <EntryDetailModal entryId={entryId} onClose={() => setEntryId(null)} />
    </main>
  );
}
