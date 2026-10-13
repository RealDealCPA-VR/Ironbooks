'use client';

/**
 * Check Detail — every check written in the period (write-check expenses AND
 * bill payments by check), with split lines indented under each check.
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Banknote } from 'lucide-react';
import { Button, Card, PageHeader, Table, Th, Td, Tr, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import ReportToolbar, { type ExportTable } from '../_components/ReportToolbar';
import { RangeControls, fmtDate, todayStr, yearStartStr, type CsvCell } from '../_components/shared';

interface CheckDetailLine {
  description: string | null;
  detail: string;
  amount: string;
}

interface CheckDetailRow {
  source: 'expense' | 'bill_payment' | 'payment_check';
  id: string;
  date: string;
  checkNumber: string | null;
  payee: string | null;
  bankAccountId: string;
  bankAccountName: string;
  amount: string;
  voided: boolean;
  lines: CheckDetailLine[];
}

interface CheckDetailData {
  from?: string;
  to?: string;
  rows: CheckDetailRow[];
  total: string;
}

export default function CheckDetailPage() {
  const [from, setFrom] = useState(yearStartStr());
  const [to, setTo] = useState(todayStr());
  const [data, setData] = useState<CheckDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.get<CheckDetailData>(`/api/reports/check-detail?from=${from}&to=${to}`));
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to load check detail.';
      setError(msg);
      toast(msg, 'danger');
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const buildTable = (): ExportTable | null => {
    if (!data) return null;
    const rows: CsvCell[][] = [];
    for (const r of data.rows) {
      rows.push([
        fmtDate(r.date),
        r.checkNumber ?? '',
        r.payee ?? '',
        r.bankAccountName,
        r.source === 'expense' ? 'Check / Expense' : r.source === 'payment_check' ? (r.lines[0]?.detail ?? 'Check') : 'Bill Payment',
        r.voided ? 'VOID' : '',
        r.amount,
      ]);
      for (const l of r.lines) {
        rows.push(['', '', `  ${l.detail}`, l.description ?? '', '', '', l.amount]);
      }
    }
    return {
      filename: 'check-detail',
      title: 'Check Detail',
      subtitle: `${fmtDate(data.from)} to ${fmtDate(data.to)}`,
      landscape: true,
      columns: [
        { header: 'Date' },
        { header: 'Check #' },
        { header: 'Payee / Split' },
        { header: 'Memo' },
        { header: 'Type' },
        { header: 'Void' },
        { header: 'Amount', numeric: true },
      ],
      rows,
      totals: [['TOTAL (non-void)', '', '', '', '', '', data.total]],
    };
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader title="Check Detail" icon={Banknote} />

      <ReportToolbar table={buildTable()} disabled={loading} />

      <Card className="p-4 mb-4 print-hidden">
        <RangeControls from={from} to={to} onFrom={setFrom} onTo={setTo} onRun={load} />
      </Card>

      <Card className="p-0 overflow-hidden">
        {loading && (
          <div className="flex items-center justify-center py-16 text-navy/50 text-sm">Loading…</div>
        )}

        {!loading && error && (
          <div className="flex flex-col items-center justify-center py-16 gap-4">
            <p className="text-red-600 text-sm">{error}</p>
            <Button variant="secondary" size="sm" onClick={load}>
              Retry
            </Button>
          </div>
        )}

        {!loading && !error && data && (
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Check #</Th>
                <Th>Payee</Th>
                <Th>Bank Account</Th>
                <Th>Type</Th>
                <Th className="text-right">Amount</Th>
              </tr>
            </thead>
            <tbody>
              {data.rows.length === 0 ? (
                <tr>
                  <Td colSpan={6} className="py-12 text-center text-navy/40">
                    No checks written in this period.
                  </Td>
                </tr>
              ) : (
                data.rows.map((r) => (
                  <Fragment key={r.id}>
                    <Tr className={r.voided ? 'opacity-50' : ''}>
                      <Td>{fmtDate(r.date)}</Td>
                      <Td className="tabular-nums">{r.checkNumber ?? '—'}</Td>
                      <Td className="font-medium">
                        {r.payee ?? '—'}
                        {r.voided && <span className="ml-2 text-xs font-bold text-red-600">VOID</span>}
                      </Td>
                      <Td>
                        <Link
                          href={`/registers/${r.bankAccountId}?from=${from}&to=${to}`}
                          className="text-electric hover:underline"
                        >
                          {r.bankAccountName}
                        </Link>
                      </Td>
                      <Td>{r.source === 'expense' ? 'Check / Expense' : r.source === 'payment_check' ? (r.lines[0]?.detail ?? 'Check') : 'Bill Payment'}</Td>
                      <Td className="text-right tabular-nums font-semibold">{formatCurrency(r.amount)}</Td>
                    </Tr>
                    {r.lines.map((l, i) => (
                      <Tr key={`${r.id}-line-${i}`} className="text-sm text-navy/60 hover:bg-transparent">
                        <Td className="py-1.5" />
                        <Td className="py-1.5" />
                        <Td className="py-1.5 pl-8" colSpan={3}>
                          {l.detail}
                          {l.description ? ` — ${l.description}` : ''}
                        </Td>
                        <Td className="py-1.5 text-right tabular-nums">{formatCurrency(l.amount)}</Td>
                      </Tr>
                    ))}
                  </Fragment>
                ))
              )}
            </tbody>
            {data.rows.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-navy/20 bg-navy/5 font-bold text-navy">
                  <td className="py-3 px-4" colSpan={5}>
                    Total (excluding voided checks)
                  </td>
                  <td className="py-3 px-4 text-right tabular-nums">{formatCurrency(data.total)}</td>
                </tr>
              </tfoot>
            )}
          </Table>
        )}
      </Card>
    </main>
  );
}
