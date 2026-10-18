'use client';
/**
 * Payroll reports page: Summary by employee, Detail per paycheck, and
 * Liability Balances by item — for a date range, with CSV export per tab.
 * Data: GET /api/payroll/reports?from=&to=
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Users } from 'lucide-react';
import {
  Button,
  Card,
  Input,
  Label,
  PageHeader,
  Table,
  Th,
  Td,
  Tr,
  Badge,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { todayISO } from '@/lib/dates';
import { formatCurrency } from '@/lib/money';
import { fmtDate } from '../_components/shared';
import { csvMinimal } from '@/lib/csv';

// ---------------------------------------------------------------------------
// Types (mirror lib/services/payrollReports.ts)
// ---------------------------------------------------------------------------

interface SummaryRow {
  employeeId: string;
  employeeName: string;
  paycheckCount: number;
  gross: string;
  taxes: Record<string, string>;
  totalTaxes: string;
  deductions: Record<string, string>;
  totalDeductions: string;
  employerTaxes: Record<string, string>;
  totalEmployerTaxes: string;
  net: string;
}

interface SummaryResult {
  from: string;
  to: string;
  taxNames: string[];
  deductionNames: string[];
  employerTaxNames: string[];
  rows: SummaryRow[];
  totals: {
    gross: string;
    totalTaxes: string;
    totalDeductions: string;
    totalEmployerTaxes: string;
    net: string;
  };
}

interface DetailRow {
  paycheckId: string;
  employeeName: string;
  payDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  gross: string;
  totalTaxes: string;
  totalDeductions: string;
  totalEmployerTaxes: string;
  net: string;
}

interface DetailResult {
  from: string;
  to: string;
  rows: DetailRow[];
}

interface LiabilityItem {
  name: string;
  kind: 'tax' | 'deduction' | 'employer_contribution';
  accrued: string;
}

interface LiabilitiesResult {
  asOf: string;
  items: LiabilityItem[];
  totalAccrued: string;
  totalPaid: string;
  balance: string;
}

interface ReportsResponse {
  summary: SummaryResult;
  detail: DetailResult;
  liabilities: LiabilitiesResult;
}

type TabKey = 'summary' | 'detail' | 'liabilities';

const KIND_LABELS: Record<LiabilityItem['kind'], string> = {
  tax: 'Employee Withholding',
  deduction: 'Deduction',
  employer_contribution: 'Employer Accrual',
};

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

/** Formula-safe CSV cell (lib/csv.ts). */
function toCsvCell(value: string | number | null | undefined): string {
  return csvMinimal(value);
}

function toCsvRow(...cells: (string | number | null | undefined)[]): string {
  return cells.map(toCsvCell).join(',');
}

function downloadCsv(csv: string, filename: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function buildSummaryCsv(s: SummaryResult): string {
  const header = toCsvRow(
    'Employee', 'Paychecks', 'Gross',
    ...s.taxNames,
    'Total Taxes',
    ...s.deductionNames,
    'Total Deductions',
    ...s.employerTaxNames,
    'Total Employer Taxes',
    'Net Pay',
  );
  const rows = s.rows.map((r) =>
    toCsvRow(
      r.employeeName, r.paycheckCount, r.gross,
      ...s.taxNames.map((n) => r.taxes[n] ?? '0.00'),
      r.totalTaxes,
      ...s.deductionNames.map((n) => r.deductions[n] ?? '0.00'),
      r.totalDeductions,
      ...s.employerTaxNames.map((n) => r.employerTaxes[n] ?? '0.00'),
      r.totalEmployerTaxes,
      r.net,
    ),
  );
  const footer = toCsvRow(
    'TOTAL', '', s.totals.gross,
    ...s.taxNames.map(() => ''),
    s.totals.totalTaxes,
    ...s.deductionNames.map(() => ''),
    s.totals.totalDeductions,
    ...s.employerTaxNames.map(() => ''),
    s.totals.totalEmployerTaxes,
    s.totals.net,
  );
  return [header, ...rows, footer].join('\n');
}

function buildDetailCsv(d: DetailResult): string {
  const header = toCsvRow(
    'Employee', 'Pay Date', 'Period Start', 'Period End',
    'Gross', 'Taxes Withheld', 'Deductions', 'Employer Taxes', 'Net Pay',
  );
  const rows = d.rows.map((r) =>
    toCsvRow(
      r.employeeName, r.payDate, r.periodStart ?? '', r.periodEnd ?? '',
      r.gross, r.totalTaxes, r.totalDeductions, r.totalEmployerTaxes, r.net,
    ),
  );
  return [header, ...rows].join('\n');
}

function buildLiabilitiesCsv(l: LiabilitiesResult): string {
  const header = toCsvRow('Item', 'Type', 'Accrued');
  const rows = l.items.map((i) => toCsvRow(i.name, KIND_LABELS[i.kind], i.accrued));
  const footer = [
    toCsvRow('Total Accrued', '', l.totalAccrued),
    toCsvRow('Payments Against 2300', '', l.totalPaid),
    toCsvRow('Balance Owed', '', l.balance),
  ];
  return [header, ...rows, ...footer].join('\n');
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function PayrollSummaryPage() {
  const today = todayISO();
  const yearStart = `${today.slice(0, 4)}-01-01`;

  const [from, setFrom] = useState(yearStart);
  const [to, setTo] = useState(today);
  const [tab, setTab] = useState<TabKey>('summary');
  const [data, setData] = useState<ReportsResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (fromDate: string, toDate: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (fromDate) params.set('from', fromDate);
      if (toDate) params.set('to', toDate);
      const res = await api.get<ReportsResponse>(`/api/payroll/reports?${params}`);
      setData(res);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to load payroll reports.', 'danger');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(yearStart, today);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleDownload() {
    if (!data) return;
    if (tab === 'summary') {
      downloadCsv(buildSummaryCsv(data.summary), `payroll-summary_${data.summary.from}_${data.summary.to}.csv`);
    } else if (tab === 'detail') {
      downloadCsv(buildDetailCsv(data.detail), `payroll-detail_${data.detail.from}_${data.detail.to}.csv`);
    } else {
      downloadCsv(buildLiabilitiesCsv(data.liabilities), `payroll-liabilities_${data.liabilities.asOf}.csv`);
    }
    toast('CSV downloaded.', 'success');
  }

  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: 'summary', label: 'Summary by Employee' },
    { key: 'detail', label: 'Paycheck Detail' },
    { key: 'liabilities', label: 'Liability Balances' },
  ];

  const s = data?.summary;
  const d = data?.detail;
  const l = data?.liabilities;

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="Payroll Reports"
        icon={Users}
        action={
          <Button variant="secondary" size="sm" onClick={handleDownload} disabled={!data}>
            Download CSV
          </Button>
        }
      />

      {/* Filters */}
      <Card className="p-5 mb-6 flex flex-wrap items-end gap-4">
        <div className="flex-1 min-w-[160px]">
          <Label htmlFor="pr-from">From</Label>
          <Input id="pr-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="flex-1 min-w-[160px]">
          <Label htmlFor="pr-to">To</Label>
          <Input id="pr-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <Button onClick={() => load(from, to)} loading={loading}>
          Run Report
        </Button>
      </Card>

      {/* Tabs */}
      <div className="mb-4 flex gap-2">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
              tab === t.key
                ? 'bg-electric text-white shadow-sm'
                : 'bg-white text-navy/60 border border-slate-200 hover:bg-slate-50'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <Card className="p-0 overflow-x-auto">
        {loading && <div className="py-16 text-center text-navy/40">Loading…</div>}

        {!loading && !data && (
          <div className="py-16 text-center text-navy/40">Pick a date range and run the report.</div>
        )}

        {/* ---- Summary tab ---- */}
        {!loading && s && tab === 'summary' && (
          s.rows.length === 0 ? (
            <div className="py-16 text-center text-navy/40">
              No posted paychecks between {fmtDate(s.from)} and {fmtDate(s.to)}.
            </div>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Employee</Th>
                  <Th className="text-right">Checks</Th>
                  <Th className="text-right">Gross</Th>
                  {s.taxNames.map((n) => (
                    <Th key={`t-${n}`} className="text-right">{n}</Th>
                  ))}
                  {s.deductionNames.map((n) => (
                    <Th key={`d-${n}`} className="text-right">{n}</Th>
                  ))}
                  <Th className="text-right">Net Pay</Th>
                  {s.employerTaxNames.map((n) => (
                    <Th key={`e-${n}`} className="text-right text-navy/40">{n}</Th>
                  ))}
                  <Th className="text-right text-navy/40">Employer Total</Th>
                </tr>
              </thead>
              <tbody>
                {s.rows.map((r) => (
                  <Tr key={r.employeeId}>
                    <Td className="font-semibold text-navy">
                      {/* QuickZoom: this employee's paychecks in the ledger for the period */}
                      <Link
                        href={`/reports/std/transaction-detail-by-account?employeeId=${r.employeeId}&from=${from}&to=${to}&subtotalBy=account`}
                        className="hover:text-electric hover:underline"
                      >
                        {r.employeeName}
                      </Link>
                    </Td>
                    <Td className="text-right tabular-nums text-navy/60">{r.paycheckCount}</Td>
                    <Td className="text-right tabular-nums font-medium">{formatCurrency(r.gross)}</Td>
                    {s.taxNames.map((n) => (
                      <Td key={`t-${n}`} className="text-right tabular-nums text-navy/70">
                        {formatCurrency(r.taxes[n] ?? '0')}
                      </Td>
                    ))}
                    {s.deductionNames.map((n) => (
                      <Td key={`d-${n}`} className="text-right tabular-nums text-navy/70">
                        {formatCurrency(r.deductions[n] ?? '0')}
                      </Td>
                    ))}
                    <Td className="text-right tabular-nums font-semibold text-emerald">
                      {formatCurrency(r.net)}
                    </Td>
                    {s.employerTaxNames.map((n) => (
                      <Td key={`e-${n}`} className="text-right tabular-nums text-navy/50">
                        {formatCurrency(r.employerTaxes[n] ?? '0')}
                      </Td>
                    ))}
                    <Td className="text-right tabular-nums text-navy/50">
                      {formatCurrency(r.totalEmployerTaxes)}
                    </Td>
                  </Tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-navy/30 bg-slate-50">
                  <td className="py-3 px-4 font-bold text-navy" colSpan={2}>Total</td>
                  <td className="py-3 px-4 text-right tabular-nums font-bold">
                    {formatCurrency(s.totals.gross)}
                  </td>
                  <td
                    className="py-3 px-4 text-right tabular-nums font-bold text-navy/70"
                    colSpan={s.taxNames.length + s.deductionNames.length}
                  >
                    Taxes {formatCurrency(s.totals.totalTaxes)} | Deductions {formatCurrency(s.totals.totalDeductions)}
                  </td>
                  <td className="py-3 px-4 text-right tabular-nums font-bold text-emerald">
                    {formatCurrency(s.totals.net)}
                  </td>
                  <td
                    className="py-3 px-4 text-right tabular-nums font-bold text-navy/50"
                    colSpan={s.employerTaxNames.length + 1}
                  >
                    {formatCurrency(s.totals.totalEmployerTaxes)}
                  </td>
                </tr>
              </tfoot>
            </Table>
          )
        )}

        {/* ---- Detail tab ---- */}
        {!loading && d && tab === 'detail' && (
          d.rows.length === 0 ? (
            <div className="py-16 text-center text-navy/40">
              No posted paychecks between {fmtDate(d.from)} and {fmtDate(d.to)}.
            </div>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Employee</Th>
                  <Th>Pay Date</Th>
                  <Th>Period</Th>
                  <Th className="text-right">Gross</Th>
                  <Th className="text-right">Taxes</Th>
                  <Th className="text-right">Deductions</Th>
                  <Th className="text-right">Employer Taxes</Th>
                  <Th className="text-right">Net Pay</Th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <Tr key={r.paycheckId}>
                    <Td className="font-semibold text-navy">{r.employeeName}</Td>
                    <Td className="text-navy/70">{fmtDate(r.payDate)}</Td>
                    <Td className="text-navy/50 text-xs">
                      {r.periodStart && r.periodEnd
                        ? `${fmtDate(r.periodStart)} – ${fmtDate(r.periodEnd)}`
                        : '—'}
                    </Td>
                    <Td className="text-right tabular-nums font-medium">{formatCurrency(r.gross)}</Td>
                    <Td className="text-right tabular-nums text-navy/70">{formatCurrency(r.totalTaxes)}</Td>
                    <Td className="text-right tabular-nums text-navy/70">{formatCurrency(r.totalDeductions)}</Td>
                    <Td className="text-right tabular-nums text-navy/50">{formatCurrency(r.totalEmployerTaxes)}</Td>
                    <Td className="text-right tabular-nums font-semibold text-emerald">{formatCurrency(r.net)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )
        )}

        {/* ---- Liabilities tab ---- */}
        {!loading && l && tab === 'liabilities' && (
          l.items.length === 0 ? (
            <div className="py-16 text-center text-navy/40">
              No payroll liabilities accrued through {fmtDate(l.asOf)}.
            </div>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Payroll Item</Th>
                  <Th>Type</Th>
                  <Th className="text-right">Accrued (through {fmtDate(l.asOf)})</Th>
                </tr>
              </thead>
              <tbody>
                {l.items.map((i) => (
                  <Tr key={`${i.kind}-${i.name}`}>
                    <Td className="font-semibold text-navy">{i.name}</Td>
                    <Td>
                      <Badge
                        tone={
                          i.kind === 'tax' ? 'info'
                          : i.kind === 'deduction' ? 'neutral'
                          : 'warning'
                        }
                      >
                        {KIND_LABELS[i.kind]}
                      </Badge>
                    </Td>
                    <Td className="text-right tabular-nums font-medium">{formatCurrency(i.accrued)}</Td>
                  </Tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-navy/30 bg-slate-50">
                  <td className="py-2 px-4 font-bold text-navy" colSpan={2}>Total Accrued</td>
                  <td className="py-2 px-4 text-right tabular-nums font-bold">
                    {formatCurrency(l.totalAccrued)}
                  </td>
                </tr>
                <tr className="bg-slate-50">
                  <td className="py-2 px-4 text-navy/70" colSpan={2}>
                    Less: Payments Against 2300 Payroll Liabilities
                  </td>
                  <td className="py-2 px-4 text-right tabular-nums text-navy/70">
                    ({formatCurrency(l.totalPaid)})
                  </td>
                </tr>
                <tr className="bg-slate-50 border-t border-navy/20">
                  <td className="py-3 px-4 font-bold text-navy" colSpan={2}>Balance Owed</td>
                  <td
                    className={`py-3 px-4 text-right tabular-nums font-bold text-lg ${
                      Number(l.balance) < 0 ? 'text-red-600' : 'text-navy'
                    }`}
                  >
                    {formatCurrency(l.balance)}
                  </td>
                </tr>
              </tfoot>
            </Table>
          )
        )}
      </Card>
    </main>
  );
}
