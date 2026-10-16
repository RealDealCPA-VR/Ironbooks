'use client';
/**
 * Reconciliation reports hub.
 *  - Previous Reconciliations: every session (completed / undone / in-progress)
 *    with a drill-down link to the per-session summary & detail report.
 *  - Reconciliation Discrepancy report: transactions cleared in a completed
 *    reconciliation whose journal entry has since been voided.
 * Both tables export to CSV like the other report pages.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
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
// Types
// ---------------------------------------------------------------------------

interface Reconciliation {
  id: string;
  bankAccountId: string;
  statementDate: string;
  statementBalance: string;
  reconciledBalance: string | null;
  status: string;
  createdAt: string;
  completedAt: string | null;
  bankName: string;
  accountNumber: string;
}

interface DiscrepancyRow {
  reconciliationId: string;
  statementDate: string;
  bankAccountId: string;
  bankName: string;
  accountNumber: string;
  journalEntryId: string;
  entryNumber: number;
  date: string;
  description: string;
  debit: string | null;
  credit: string | null;
  amount: string;
  voidedAt: string | null;
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

function downloadCsv(csv: string, filename: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ReconciliationReportsPage() {
  const [sessions, setSessions] = useState<Reconciliation[]>([]);
  const [discrepancies, setDiscrepancies] = useState<DiscrepancyRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get<Reconciliation[]>('/api/reconciliations'),
      api.get<DiscrepancyRow[]>('/api/reconciliations/discrepancies'),
    ])
      .then(([recons, disc]) => {
        setSessions(recons);
        setDiscrepancies(disc);
      })
      .catch((err) => {
        toast(err instanceof ApiError ? err.message : 'Failed to load reports.', 'danger');
      })
      .finally(() => setLoading(false));
  }, []);

  function handleSessionsCsv() {
    const header = toCsvRow(
      'Bank Account',
      'Account #',
      'Statement Date',
      'Statement Balance',
      'Reconciled Balance',
      'Status',
      'Completed',
    );
    const rows = sessions.map((r) =>
      toCsvRow(
        r.bankName,
        r.accountNumber,
        fmtDate(r.statementDate),
        r.statementBalance,
        r.reconciledBalance ?? '',
        statusLabel(r.status),
        fmtDate(r.completedAt),
      ),
    );
    downloadCsv([header, ...rows].join('\n'), 'Previous_Reconciliations.csv');
    toast('CSV downloaded.', 'success');
  }

  function handleDiscrepancyCsv() {
    const header = toCsvRow(
      'Bank Account',
      'Statement Date',
      'Entry #',
      'Txn Date',
      'Description',
      'Debit',
      'Credit',
      'Amount',
      'Voided At',
    );
    const rows = discrepancies.map((d) =>
      toCsvRow(
        d.bankName,
        fmtDate(d.statementDate),
        d.entryNumber,
        fmtDate(d.date),
        d.description,
        d.debit ?? '',
        d.credit ?? '',
        d.amount,
        fmtDate(d.voidedAt),
      ),
    );
    downloadCsv([header, ...rows].join('\n'), 'Reconciliation_Discrepancies.csv');
    toast('CSV downloaded.', 'success');
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader title="Reconciliation Reports" icon={CheckSquare} />

      {loading ? (
        <Card className="p-12">
          <div className="flex items-center justify-center gap-2 text-navy/50 text-sm">
            <Spinner className="text-electric" />
            Loading…
          </div>
        </Card>
      ) : (
        <div className="space-y-8">
          {/* Previous reconciliations */}
          <Card className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-navy">Previous Reconciliations</h2>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleSessionsCsv}
                disabled={sessions.length === 0}
              >
                Download CSV
              </Button>
            </div>
            {sessions.length === 0 ? (
              <p className="text-navy/50 text-sm py-6 text-center">
                No reconciliations yet. Run one from the Reconcile page.
              </p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Bank Account</Th>
                    <Th>Statement Date</Th>
                    <Th className="text-right">Statement Balance</Th>
                    <Th className="text-right">Reconciled Balance</Th>
                    <Th>Status</Th>
                    <Th>Completed</Th>
                    <Th></Th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((r) => (
                    <Tr key={r.id}>
                      <Td>
                        {r.bankName}
                        <span className="ml-1 text-navy/40 text-xs">
                          …{r.accountNumber.slice(-4)}
                        </span>
                      </Td>
                      <Td>{fmtDate(r.statementDate)}</Td>
                      <Td numeric>{formatCurrency(r.statementBalance)}</Td>
                      <Td numeric>
                        {r.reconciledBalance ? formatCurrency(r.reconciledBalance) : '—'}
                      </Td>
                      <Td>
                        <Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge>
                      </Td>
                      <Td>{fmtDate(r.completedAt)}</Td>
                      <Td>
                        <Link
                          href={`/reports/reconciliation/${r.id}`}
                          className="text-electric text-sm font-semibold hover:underline"
                        >
                          View Report
                        </Link>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          {/* Discrepancy report */}
          <Card className="p-6">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-lg font-bold text-navy">Reconciliation Discrepancies</h2>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleDiscrepancyCsv}
                disabled={discrepancies.length === 0}
              >
                Download CSV
              </Button>
            </div>
            <p className="text-sm text-navy/60 mb-4">
              Transactions that were cleared in a completed reconciliation but whose journal entry
              was voided afterwards. These create unexplained beginning-balance differences.
            </p>
            {discrepancies.length === 0 ? (
              <p className="text-emerald text-sm py-4 text-center bg-emerald/10 rounded-lg">
                No discrepancies found — reconciled balances are intact.
              </p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Bank Account</Th>
                    <Th>Statement Date</Th>
                    <Th>Entry #</Th>
                    <Th>Txn Date</Th>
                    <Th>Description</Th>
                    <Th className="text-right">Amount</Th>
                    <Th>Voided</Th>
                  </tr>
                </thead>
                <tbody>
                  {discrepancies.map((d, i) => (
                    <Tr key={`${d.reconciliationId}-${d.journalEntryId}-${i}`} className="bg-red-50/50">
                      <Td>{d.bankName}</Td>
                      <Td>{fmtDate(d.statementDate)}</Td>
                      <Td className="tabular-nums text-navy/60">#{d.entryNumber}</Td>
                      <Td>{fmtDate(d.date)}</Td>
                      <Td className="max-w-xs truncate">{d.description}</Td>
                      <Td numeric className="text-red-600">
                        {formatCurrency(d.amount)}
                      </Td>
                      <Td>{fmtDate(d.voidedAt)}</Td>
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
