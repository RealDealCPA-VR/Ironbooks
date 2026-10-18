'use client';
/**
 * Previous Reconciliation report — one session's summary & detail:
 *  - Summary: beginning balance, cleared checks/payments and deposits/credits
 *    (counts + totals), cleared balance vs statement balance, difference.
 *  - Detail: every cleared transaction; rows whose journal entry has since been
 *    voided are flagged as discrepancies.
 *  - CSV export of the full report.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { CheckSquare } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  PageHeader,
  Spinner,
  Table,
  Td,
  Th,
  Tr,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { formatShortDate } from '@/lib/format';
import { csvMinimal } from '@/lib/csv';

// ---------------------------------------------------------------------------
// Types (mirror lib/services/reconcile.ts ReconciliationReport)
// ---------------------------------------------------------------------------

interface ReportLine {
  lineId: string;
  journalEntryId: string;
  entryNumber: number;
  date: string;
  description: string;
  memo: string | null;
  debit: string | null;
  credit: string | null;
  amount: string;
  isVoided: boolean;
}

interface ReconciliationReport {
  id: string;
  bankAccountId: string;
  bankName: string;
  accountNumber: string;
  glAccountName: string;
  glAccountCode: string;
  glType: string;
  status: string;
  statementDate: string;
  statementBalance: string;
  reconciledBalance: string | null;
  createdAt: string;
  completedAt: string | null;
  beginningBalance: string;
  clearedTotal: string;
  clearedBalance: string;
  difference: string;
  depositsCount: number;
  depositsTotal: string;
  paymentsCount: number;
  paymentsTotal: string;
  lines: ReportLine[];
  discrepancies: ReportLine[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Short US date; calendar days (statement / entry dates) without the UTC off-by-one. */
const fmtDate = formatShortDate;

function statusTone(status: string): 'info' | 'success' | 'warning' | 'neutral' {
  if (status === 'in_progress') return 'info';
  if (status === 'completed') return 'success';
  if (status === 'undone') return 'warning';
  return 'neutral';
}

function statusLabel(status: string): string {
  if (status === 'in_progress') return 'In Progress';
  if (status === 'completed') return 'Completed';
  if (status === 'undone') return 'Undone';
  return status;
}

/** Formula-safe CSV cell (lib/csv.ts). */
function toCsvCell(value: string | number | null | undefined): string {
  return csvMinimal(value);
}

function toCsvRow(...cells: (string | number | null | undefined)[]): string {
  return cells.map(toCsvCell).join(',');
}

function buildCsv(r: ReconciliationReport): string {
  const out: string[] = [];
  out.push(toCsvRow('Reconciliation Report', `${r.bankName} (${r.glAccountCode} ${r.glAccountName})`));
  out.push(toCsvRow('Statement Date', fmtDate(r.statementDate)));
  out.push(toCsvRow('Status', statusLabel(r.status)));
  out.push(toCsvRow('Beginning Balance', r.beginningBalance));
  out.push(toCsvRow('Deposits and Credits Cleared', r.depositsCount, r.depositsTotal));
  out.push(toCsvRow('Checks and Payments Cleared', r.paymentsCount, r.paymentsTotal));
  out.push(toCsvRow('Cleared Balance', r.clearedBalance));
  out.push(toCsvRow('Statement Ending Balance', r.statementBalance));
  out.push(toCsvRow('Difference', r.difference));
  out.push('');
  out.push(toCsvRow('Date', 'Entry #', 'Description', 'Memo', 'Debit', 'Credit', 'Amount', 'Voided After Reconcile'));
  for (const l of r.lines) {
    out.push(
      toCsvRow(
        fmtDate(l.date),
        l.entryNumber,
        l.description,
        l.memo ?? '',
        l.debit ?? '',
        l.credit ?? '',
        l.amount,
        l.isVoided ? 'YES' : '',
      ),
    );
  }
  return out.join('\n');
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

function SummaryRow({
  label,
  value,
  bold,
  danger,
}: {
  label: string;
  value: string;
  bold?: boolean;
  danger?: boolean;
}) {
  return (
    <div className="flex justify-between py-1.5 border-b border-slate-100 last:border-0">
      <span className={`text-sm ${bold ? 'font-bold text-navy' : 'text-navy/70'}`}>{label}</span>
      <span
        className={`text-sm tabular-nums ${bold ? 'font-bold' : ''} ${
          danger ? 'text-red-600' : 'text-navy'
        }`}
      >
        {value}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ReconciliationDetailReportPage() {
  const params = useParams<{ id: string }>();
  const [report, setReport] = useState<ReconciliationReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!params?.id) return;
    api
      .get<ReconciliationReport>(`/api/reconciliations/${params.id}/report`)
      .then(setReport)
      .catch((err) => {
        toast(err instanceof ApiError ? err.message : 'Failed to load report.', 'danger');
      })
      .finally(() => setLoading(false));
  }, [params?.id]);

  function handleDownload() {
    if (!report) return;
    downloadCsv(
      buildCsv(report),
      `Reconciliation_${report.bankName.replace(/\s+/g, '_')}_${fmtDate(report.statementDate).replace(/\//g, '-')}.csv`,
    );
    toast('CSV downloaded.', 'success');
  }

  const isBalanced = report ? Number(report.difference) === 0 : false;

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="Reconciliation Report"
        icon={CheckSquare}
        action={
          <Button variant="secondary" size="sm" onClick={handleDownload} disabled={!report}>
            Download CSV
          </Button>
        }
      />

      <Link
        href="/reports/reconciliation"
        className="inline-block mb-4 text-sm text-electric font-semibold hover:underline"
      >
        ← All reconciliation reports
      </Link>

      {loading ? (
        <Card className="p-12">
          <div className="flex items-center justify-center gap-2 text-navy/50 text-sm">
            <Spinner className="text-electric" />
            Loading…
          </div>
        </Card>
      ) : !report ? (
        <p className="text-navy/50">Report not found.</p>
      ) : (
        <div className="space-y-6">
          {/* Header / summary */}
          <Card className="p-6">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-lg font-bold text-navy">
                  {report.bankName}{' '}
                  <span className="text-navy/40 text-sm">…{report.accountNumber.slice(-4)}</span>
                </h2>
                <p className="text-sm text-navy/60">
                  {report.glAccountCode} {report.glAccountName} · Statement date{' '}
                  {fmtDate(report.statementDate)}
                  {report.completedAt ? ` · Completed ${fmtDate(report.completedAt)}` : ''}
                </p>
              </div>
              <Badge tone={statusTone(report.status)}>{statusLabel(report.status)}</Badge>
            </div>

            <div className="max-w-xl">
              <SummaryRow label="Beginning Balance" value={formatCurrency(report.beginningBalance)} />
              <SummaryRow
                label={`Deposits and Credits Cleared (${report.depositsCount})`}
                value={formatCurrency(report.depositsTotal)}
              />
              <SummaryRow
                label={`Checks and Payments Cleared (${report.paymentsCount})`}
                value={`-${formatCurrency(report.paymentsTotal)}`}
              />
              <SummaryRow label="Cleared Balance" value={formatCurrency(report.clearedBalance)} bold />
              <SummaryRow
                label="Statement Ending Balance"
                value={formatCurrency(report.statementBalance)}
              />
              <SummaryRow
                label="Difference"
                value={formatCurrency(report.difference)}
                bold
                danger={!isBalanced}
              />
            </div>
          </Card>

          {/* Discrepancies */}
          {report.discrepancies.length > 0 && (
            <Card className="p-6 border border-red-200">
              <h3 className="text-base font-bold text-red-700 mb-2">
                Discrepancies — voided after reconciliation
              </h3>
              <p className="text-sm text-navy/60 mb-4">
                These cleared transactions were voided after this reconciliation completed. The
                reconciled balance no longer matches the books by the amounts below.
              </p>
              <Table>
                <thead>
                  <tr>
                    <Th>Date</Th>
                    <Th>Entry #</Th>
                    <Th>Description</Th>
                    <Th className="text-right">Amount</Th>
                  </tr>
                </thead>
                <tbody>
                  {report.discrepancies.map((l) => (
                    <Tr key={l.lineId} className="bg-red-50/50">
                      <Td>{fmtDate(l.date)}</Td>
                      <Td className="tabular-nums text-navy/60">#{l.entryNumber}</Td>
                      <Td>{l.description}</Td>
                      <Td numeric className="text-red-600">
                        {formatCurrency(l.amount)}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}

          {/* Cleared transaction detail */}
          <Card className="p-6">
            <h3 className="text-base font-bold text-navy mb-4">
              Cleared Transactions ({report.lines.length})
            </h3>
            {report.lines.length === 0 ? (
              <p className="text-navy/50 text-sm py-6 text-center">
                No transactions were cleared in this session.
              </p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Date</Th>
                    <Th>Entry #</Th>
                    <Th>Description</Th>
                    <Th>Memo</Th>
                    <Th className="text-right">Debit</Th>
                    <Th className="text-right">Credit</Th>
                    <Th className="text-right">Amount</Th>
                    <Th></Th>
                  </tr>
                </thead>
                <tbody>
                  {report.lines.map((l) => (
                    <Tr key={l.lineId} className={l.isVoided ? 'bg-red-50/50' : ''}>
                      <Td className="whitespace-nowrap">{fmtDate(l.date)}</Td>
                      <Td className="tabular-nums text-navy/60">#{l.entryNumber}</Td>
                      <Td className="max-w-xs truncate">{l.description}</Td>
                      <Td className="text-navy/60">{l.memo ?? '—'}</Td>
                      <Td numeric>{l.debit ? formatCurrency(l.debit) : ''}</Td>
                      <Td numeric>{l.credit ? formatCurrency(l.credit) : ''}</Td>
                      <Td
                        numeric
                        className={Number(l.amount) < 0 ? 'text-red-500' : 'text-navy'}
                      >
                        {formatCurrency(l.amount)}
                      </Td>
                      <Td>{l.isVoided && <Badge tone="danger">Voided</Badge>}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      )}
    </main>
  );
}
