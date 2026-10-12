'use client';

/**
 * Cash Flow Statement page — indirect method.
 * Fetches GET /api/reports/cash-flow (optional ?from=&to= filters).
 * Shows Operating / Investing / Financing sections and net cash change.
 * "Download CSV" exports the visible report as a Blob download.
 */
import Link from 'next/link';
import { useState, useCallback, useEffect } from 'react';
import { TrendingUp } from 'lucide-react';
import { Button, Card, Input, Label, PageHeader, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import ReportToolbar, { type ExportTable } from '../_components/ReportToolbar';
import { fmtDate } from '../_components/shared';

interface CashFlowLine {
  accountId: string;
  code: string;
  name: string;
  amount: string;
}

interface CashFlowReport {
  from?: string;
  to?: string;
  operating: {
    netIncome: string;
    changeInAR: string;
    changeInAP: string;
    changeInInventory: string;
    otherChanges: CashFlowLine[];
    total: string;
  };
  investing: {
    lines: CashFlowLine[];
    total: string;
  };
  financing: {
    lines: CashFlowLine[];
    total: string;
  };
  netCashChange: string;
  cashAccountsChange: string;
}

// ---------------------------------------------------------------------------
// Export table (shared ReportToolbar: CSV / Excel / PDF / Print)
// ---------------------------------------------------------------------------

function buildTable(report: CashFlowReport): ExportTable {
  return {
    filename: 'cash-flow',
    title: 'Cash Flow Statement',
    subtitle: `${report.from ? fmtDate(report.from) : 'Beginning'} - ${report.to ? fmtDate(report.to) : 'Present'}`,
    columns: [
      { header: 'Section' },
      { header: 'Line Item' },
      { header: 'Amount', numeric: true },
    ],
    rows: [
      ['Operating', 'Net Income', report.operating.netIncome],
      ['Operating', 'Change in Accounts Receivable', report.operating.changeInAR],
      ['Operating', 'Change in Accounts Payable', report.operating.changeInAP],
      ['Operating', 'Change in Inventory', report.operating.changeInInventory],
      ...report.operating.otherChanges.map(
        (l) => ['Operating', `${l.code} ${l.name}`, l.amount] as (string | null)[],
      ),
      ['Operating', 'Total Operating', report.operating.total],
      ...report.investing.lines.map(
        (l) => ['Investing', `${l.code} ${l.name}`, l.amount] as (string | null)[],
      ),
      ['Investing', 'Total Investing', report.investing.total],
      ...report.financing.lines.map(
        (l) => ['Financing', `${l.code} ${l.name}`, l.amount] as (string | null)[],
      ),
      ['Financing', 'Total Financing', report.financing.total],
    ],
    totals: [['Summary', 'Net Cash Change', report.netCashChange]],
  };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function AmountCell({ value }: { value: string }) {
  const n = Number(value);
  return (
    <span className={`tabular-nums ${n < 0 ? 'text-red-600' : 'text-navy'}`}>
      {formatCurrency(value)}
    </span>
  );
}

function SectionRow({ label, value, indent, href }: { label: string; value: string; indent?: boolean; href?: string }) {
  // QuickZoom: the label and amount open the report / transactions behind the line.
  return (
    <tr className="border-b border-slate-100 hover:bg-electric/5">
      <td className={`py-2.5 px-4 text-navy${indent ? ' pl-10' : ' font-medium'}`}>
        {href ? (
          <Link href={href} className="hover:text-electric hover:underline">
            {label}
          </Link>
        ) : (
          label
        )}
      </td>
      <td className="py-2.5 px-4 text-right">
        {href ? (
          <Link href={href} className="hover:underline">
            <AmountCell value={value} />
          </Link>
        ) : (
          <AmountCell value={value} />
        )}
      </td>
    </tr>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <tr className="bg-navy/5">
      <td className="py-2 px-4 font-bold text-navy text-sm uppercase tracking-wide" colSpan={2}>
        {title}
      </td>
    </tr>
  );
}

function SectionTotal({ label, value }: { label: string; value: string }) {
  const n = Number(value);
  return (
    <tr className="border-t border-navy/20 font-semibold bg-slate-50">
      <td className="py-2.5 px-4 text-navy/80">{label}</td>
      <td className={`py-2.5 px-4 text-right tabular-nums font-bold ${n < 0 ? 'text-red-600' : 'text-emerald'}`}>
        {formatCurrency(value)}
      </td>
    </tr>
  );
}

function Spacer() {
  return (
    <tr>
      <td colSpan={2} className="py-1" />
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function CashFlowPage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const zoom = (key: string, extra: Record<string, string> = {}) => {
    const qs = new URLSearchParams(extra);
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    return `/reports/std/${key}?${qs.toString()}`;
  };
  const [report, setReport] = useState<CashFlowReport | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const url = `/api/reports/cash-flow${params.size ? `?${params}` : ''}`;
      const data = await api.get<CashFlowReport>(url);
      setReport(data);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to load cash flow report.', 'danger');
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  // Load on mount
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const netCash = report ? Number(report.netCashChange) : 0;

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader title="Cash Flow Statement" icon={TrendingUp} />

      <ReportToolbar table={report ? buildTable(report) : null} disabled={loading} />

      {/* Filters */}
      <Card className="p-5 mb-6 flex flex-wrap items-end gap-4 print-hidden">
        <div className="flex-1 min-w-[160px]">
          <Label htmlFor="cf-from">From</Label>
          <Input
            id="cf-from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="flex-1 min-w-[160px]">
          <Label htmlFor="cf-to">To</Label>
          <Input
            id="cf-to"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <Button onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Run Report'}
        </Button>
      </Card>

      {/* Report */}
      <Card className="p-0 overflow-hidden max-w-3xl">
        {loading && !report && (
          <div className="py-16 text-center text-navy/40">Loading…</div>
        )}
        {!loading && !report && (
          <div className="py-16 text-center text-navy/40">No data. Run the report above.</div>
        )}
        {report && (
          <>
            {/* Period label */}
            {(report.from || report.to) && (
              <div className="px-6 pt-4 pb-1 text-sm text-navy/50">
                Period: {report.from ? fmtDate(report.from) : 'Beginning'} –{' '}
                {report.to ? fmtDate(report.to) : 'Present'}
              </div>
            )}

            <table className="w-full border-collapse">
              <colgroup>
                <col className="w-3/4" />
                <col className="w-1/4" />
              </colgroup>
              <tbody>
                {/* Operating */}
                <SectionHeader title="Operating Activities" />
                <SectionRow label="Net Income" value={report.operating.netIncome} indent href={zoom('profit-loss')} />
                <SectionRow
                  label="Change in Accounts Receivable"
                  value={report.operating.changeInAR}
                  indent
                  href={zoom('transaction-detail-by-account', { section: 'ar' })}
                />
                <SectionRow
                  label="Change in Accounts Payable"
                  value={report.operating.changeInAP}
                  indent
                  href={zoom('transaction-detail-by-account', { section: 'ap' })}
                />
                <SectionRow
                  label="Change in Inventory"
                  value={report.operating.changeInInventory}
                  indent
                />
                {report.operating.otherChanges.map((l) => (
                  <SectionRow
                    key={l.accountId}
                    label={`Change in ${l.code} ${l.name}`}
                    value={l.amount}
                    indent
                    href={zoom('transaction-detail-by-account', { accountId: l.accountId })}
                  />
                ))}
                <SectionTotal label="Net Cash from Operating" value={report.operating.total} />
                <Spacer />

                {/* Investing */}
                <SectionHeader title="Investing Activities" />
                {report.investing.lines.length === 0 && (
                  <SectionRow label="No investing activity" value="0.00" indent />
                )}
                {report.investing.lines.map((l) => (
                  <SectionRow
                    key={l.accountId}
                    label={`${l.code} ${l.name}`}
                    value={l.amount}
                    indent
                    href={zoom('transaction-detail-by-account', { accountId: l.accountId })}
                  />
                ))}
                <SectionTotal label="Net Cash from Investing" value={report.investing.total} />
                <Spacer />

                {/* Financing */}
                <SectionHeader title="Financing Activities" />
                {report.financing.lines.length === 0 && (
                  <SectionRow label="No financing activity" value="0.00" indent />
                )}
                {report.financing.lines.map((l) => (
                  <SectionRow
                    key={l.accountId}
                    label={`${l.code} ${l.name}`}
                    value={l.amount}
                    indent
                    href={zoom('transaction-detail-by-account', { accountId: l.accountId })}
                  />
                ))}
                <SectionTotal label="Net Cash from Financing" value={report.financing.total} />
              </tbody>

              {/* Net total */}
              <tfoot>
                <tr className="border-t-2 border-navy/30 text-lg">
                  <td className="py-4 px-4 font-extrabold text-navy">Net Cash Change</td>
                  <td
                    className={`py-4 px-4 text-right tabular-nums font-extrabold ${
                      netCash >= 0 ? 'text-emerald' : 'text-red-600'
                    }`}
                  >
                    {formatCurrency(report.netCashChange)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </>
        )}
      </Card>
    </main>
  );
}
