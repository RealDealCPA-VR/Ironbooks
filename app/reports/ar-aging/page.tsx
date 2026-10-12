'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Clock } from 'lucide-react';
import {
  Button,
  Card,
  Table,
  Th,
  Td,
  Tr,
  PageHeader,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import ReportToolbar, { type ExportTable } from '../_components/ReportToolbar';
import { AsOfControl, todayStr } from '../_components/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgingBucket {
  id: string;
  name: string;
  current: string;
  days1_30: string;
  days31_60: string;
  days61_90: string;
  days91plus: string;
  total: string;
}

interface AgingTotals {
  current: string;
  days1_30: string;
  days31_60: string;
  days61_90: string;
  days91plus: string;
  total: string;
}

interface AgingReport {
  asOf: string;
  rows: AgingBucket[];
  totals: AgingTotals;
}

// ---------------------------------------------------------------------------
// Export table (CSV / Excel / PDF / Print via the shared ReportToolbar)
// ---------------------------------------------------------------------------

function buildTable(report: AgingReport): ExportTable {
  const asOfDate = new Date(report.asOf).toLocaleDateString('en-US');
  return {
    filename: 'ar-aging',
    title: 'A/R Aging Summary',
    subtitle: `As of ${asOfDate}`,
    columns: [
      { header: 'Customer' },
      { header: 'Current', numeric: true },
      { header: '1-30 Days', numeric: true },
      { header: '31-60 Days', numeric: true },
      { header: '61-90 Days', numeric: true },
      { header: '91+ Days', numeric: true },
      { header: 'Total', numeric: true },
    ],
    rows: report.rows.map((r) => [
      r.name,
      r.current,
      r.days1_30,
      r.days31_60,
      r.days61_90,
      r.days91plus,
      r.total,
    ]),
    totals: [
      [
        'TOTAL',
        report.totals.current,
        report.totals.days1_30,
        report.totals.days31_60,
        report.totals.days61_90,
        report.totals.days91plus,
        report.totals.total,
      ],
    ],
  };
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function ArAgingPage() {
  const [asOf, setAsOf] = useState(todayStr());
  const [report, setReport] = useState<AgingReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<AgingReport>(
        `/api/reports/ar-aging?asOf=${encodeURIComponent(asOf)}`,
      );
      setReport(data);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to load AR aging report.';
      setError(msg);
      toast(msg, 'danger');
    } finally {
      setLoading(false);
    }
  }, [asOf]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const asOfLabel = report
    ? new Date(report.asOf).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : '';

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="A/R Aging"
        icon={Clock}
        action={
          asOfLabel ? <span className="text-sm text-navy/60">As of {asOfLabel}</span> : undefined
        }
      />

      <ReportToolbar table={report ? buildTable(report) : null} disabled={loading} />

      <Card className="p-4 mb-4 print-hidden">
        <AsOfControl asOf={asOf} onChange={setAsOf} onRun={load} />
      </Card>

      <Card className="p-0 overflow-hidden">
        {loading && (
          <div className="flex items-center justify-center py-16 text-navy/50 text-sm">
            Loading…
          </div>
        )}

        {!loading && error && (
          <div className="flex flex-col items-center justify-center py-16 gap-4">
            <p className="text-red-600 text-sm">{error}</p>
            <Button variant="secondary" size="sm" onClick={load}>
              Retry
            </Button>
          </div>
        )}

        {!loading && !error && report && (
          <Table>
            <thead>
              <tr>
                <Th>Customer</Th>
                <Th numeric>Current</Th>
                <Th numeric>1–30 Days</Th>
                <Th numeric>31–60 Days</Th>
                <Th numeric>61–90 Days</Th>
                <Th numeric>91+ Days</Th>
                <Th numeric>Total</Th>
              </tr>
            </thead>
            <tbody>
              {report.rows.length === 0 ? (
                <tr>
                  <Td colSpan={7} className="py-12 text-center text-navy/40">
                    No outstanding receivables.
                  </Td>
                </tr>
              ) : (
                report.rows.map((row) => (
                  <Tr key={row.id}>
                    <Td className="font-medium">
                      {/* QuickZoom: the open transactions behind this balance */}
                      <Link
                        href={`/reports/std/customer-balance-detail?customerId=${row.id}&to=${asOf}`}
                        className="hover:text-electric hover:underline"
                        title="See the transactions behind this balance"
                      >
                        {row.name}
                      </Link>
                    </Td>
                    <Td numeric>{formatCurrency(row.current)}</Td>
                    <Td numeric>{formatCurrency(row.days1_30)}</Td>
                    <Td numeric>{formatCurrency(row.days31_60)}</Td>
                    <Td numeric>{formatCurrency(row.days61_90)}</Td>
                    <Td numeric>{formatCurrency(row.days91plus)}</Td>
                    <Td numeric className="font-semibold">
                      {formatCurrency(row.total)}
                    </Td>
                  </Tr>
                ))
              )}
            </tbody>
            {report.rows.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-navy/20 bg-navy/5 font-bold text-navy">
                  <td className="py-3 px-4">Total</td>
                  <td className="py-3 px-4 text-right tabular-nums">
                    {formatCurrency(report.totals.current)}
                  </td>
                  <td className="py-3 px-4 text-right tabular-nums">
                    {formatCurrency(report.totals.days1_30)}
                  </td>
                  <td className="py-3 px-4 text-right tabular-nums">
                    {formatCurrency(report.totals.days31_60)}
                  </td>
                  <td className="py-3 px-4 text-right tabular-nums">
                    {formatCurrency(report.totals.days61_90)}
                  </td>
                  <td className="py-3 px-4 text-right tabular-nums">
                    {formatCurrency(report.totals.days91plus)}
                  </td>
                  <td className="py-3 px-4 text-right tabular-nums">
                    {formatCurrency(report.totals.total)}
                  </td>
                </tr>
              </tfoot>
            )}
          </Table>
        )}
      </Card>
    </main>
  );
}
